import { deviceIdFor, randomToken } from './keys.ts'

/** What each side tells the other inside the encrypted handshake. */
export interface HandshakeHello {
  name?: string
  pairingCode?: string
}

export interface PairedDevice {
  deviceId: string
  identityKey: string
  name: string
  pairedAt: number
}

/** What the computer's pairing QR code carries to the phone. */
export interface PairingOffer {
  server: string
  hostDeviceId: string
  hostKey: string
  code: string
  name: string
}

const MAX_NAME = 64
const MAX_CODE = 128
const PAIRING_SCHEME = 'dsbot:'

export function encodeHandshakeHello(hello: HandshakeHello): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(checkHello(hello)))
}

export function decodeHandshakeHello(data: Uint8Array): HandshakeHello {
  if (data.byteLength === 0) return {}
  return checkHello(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)))
}

function checkHello(value: unknown): HandshakeHello {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The handshake hello is invalid.')
  const { name, pairingCode } = value as Record<string, unknown>
  const hello: HandshakeHello = {}
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > MAX_NAME) throw new Error('The device name is invalid.')
    hello.name = name
  }
  if (pairingCode !== undefined) {
    if (typeof pairingCode !== 'string' || pairingCode.length === 0 || pairingCode.length > MAX_CODE) {
      throw new Error('The pairing code is invalid.')
    }
    hello.pairingCode = pairingCode
  }
  return hello
}

export function pairingUri(offer: PairingOffer): string {
  const query = new URLSearchParams({
    v: '1',
    server: offer.server,
    host: offer.hostDeviceId,
    key: offer.hostKey,
    code: offer.code,
    name: offer.name,
  })
  return `${PAIRING_SCHEME}//pair?${query}`
}

export function parsePairingUri(uri: string): PairingOffer {
  const url = new URL(uri)
  if (url.protocol !== PAIRING_SCHEME || url.host !== 'pair' || url.searchParams.get('v') !== '1') {
    throw new Error('This is not a DS Bot pairing code.')
  }
  const field = (name: string): string => {
    const value = url.searchParams.get(name)
    if (value === null || value.length === 0) throw new Error(`The pairing code has no ${name}.`)
    return value
  }
  const server = field('server')
  if (!/^wss?:$/.test(new URL(server).protocol)) throw new Error('The pairing code names an invalid Server.')
  const offer: PairingOffer = {
    server,
    hostDeviceId: field('host'),
    hostKey: field('key'),
    code: field('code'),
    name: (url.searchParams.get('name') ?? '').slice(0, MAX_NAME),
  }
  if (deviceIdFor(offer.hostKey) !== offer.hostDeviceId) throw new Error('The pairing code does not match its computer.')
  return offer
}

interface OpenPairing {
  code: string
  expiresAt: number
  misses: number
}

/**
 * The phones a computer trusts, and the one pairing code it may have open.
 * A code works once, ends after a time limit, and closes after a few wrong tries.
 */
export class DeviceRegistry {
  private readonly devices = new Map<string, PairedDevice>()
  private pairing?: OpenPairing
  private readonly onChange?: (devices: PairedDevice[]) => void
  private readonly now: () => number

  constructor(devices: PairedDevice[] = [], onChange?: (devices: PairedDevice[]) => void, now: () => number = Date.now) {
    for (const device of devices) this.devices.set(device.deviceId, { ...device })
    this.onChange = onChange
    this.now = now
  }

  list(): PairedDevice[] { return [...this.devices.values()].map(device => ({ ...device })) }

  openPairing(ttlMs = 5 * 60_000): { code: string; expiresAt: number } {
    this.pairing = { code: randomToken(18), expiresAt: this.now() + ttlMs, misses: 0 }
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
  }

  closePairing(): void { this.pairing = undefined }

  pairingOpen(): boolean {
    if (this.pairing !== undefined && this.now() >= this.pairing.expiresAt) this.pairing = undefined
    return this.pairing !== undefined
  }

  /** Whether a device may start a handshake: it is paired, or a pairing code is open. */
  admits(deviceId: string, identityKey: string): boolean {
    return this.matches(deviceId, identityKey) || this.pairingOpen()
  }

  /** The check after the handshake: a paired device, or a new one that holds the open code. */
  authorize(deviceId: string, identityKey: string, hello: HandshakeHello): boolean {
    if (this.matches(deviceId, identityKey)) return true
    if (hello.pairingCode === undefined || !this.pairingOpen()) return false
    const pairing = this.pairing!
    if (!sameText(hello.pairingCode, pairing.code)) {
      pairing.misses += 1
      if (pairing.misses >= 5) this.pairing = undefined
      return false
    }
    this.pairing = undefined
    this.devices.set(deviceId, { deviceId, identityKey, name: hello.name ?? '', pairedAt: this.now() })
    this.onChange?.(this.list())
    return true
  }

  revoke(deviceId: string): boolean {
    const removed = this.devices.delete(deviceId)
    if (removed) this.onChange?.(this.list())
    return removed
  }

  private matches(deviceId: string, identityKey: string): boolean {
    const device = this.devices.get(deviceId)
    return device !== undefined && sameText(device.identityKey, identityKey)
  }
}

function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let diff = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return diff === 0
}
