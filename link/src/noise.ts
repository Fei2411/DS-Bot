import {
  NqHandshake,
  chachaPoly,
  noiseIk,
  sha256H,
  type TransportState,
} from '@lukeburns/clatterjs'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { fromBase64Url } from './keys.ts'

export const NOISE_IK_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256' as const

export interface NoiseIkSessionOptions {
  role: 'initiator' | 'responder'
  localPrivateKey: string
  localPublicKey: string
  remotePublicKey: string
  prologue: Uint8Array
  random?: (length: number) => Uint8Array
}

/**
 * Noise IK with one fixed suite. The remote static key must match the paired
 * key before any transport message can be read or written.
 */
export class NoiseIkSession {
  private readonly handshake: NqHandshake
  private readonly expectedRemoteStatic: Uint8Array
  private transport?: TransportState
  private destroyed = false

  constructor(options: NoiseIkSessionOptions) {
    const localPrivate = requireKey(options.localPrivateKey, 'local private key')
    const localPublic = requireKey(options.localPublicKey, 'local public key')
    this.expectedRemoteStatic = requireKey(options.remotePublicKey, 'remote public key')
    const initiator = options.role === 'initiator'
    this.handshake = new NqHandshake(noiseIk(), {
      prologue: Uint8Array.from(options.prologue),
      initiator,
      s: { secretKey: localPrivate, publicKey: localPublic },
      ...(initiator ? { rs: Uint8Array.from(this.expectedRemoteStatic) } : {}),
      cipher: chachaPoly,
      hash: sha256H,
      rng: options.random ?? randomBytes,
    })
    if (this.handshake.getName() !== NOISE_IK_PROTOCOL) {
      throw new NoiseSessionError('NOISE_SUITE_MISMATCH', 'The Noise provider selected an unexpected cipher suite.')
    }
  }

  get complete(): boolean { return this.transport !== undefined }

  writeHandshake(payload: Uint8Array = new Uint8Array()): Uint8Array {
    this.assertHandshake(false)
    const output = new Uint8Array(payload.byteLength + this.handshake.getNextMessageOverhead())
    const length = this.handshake.writeMessage(payload, output)
    this.finishIfReady()
    return output.slice(0, length)
  }

  readHandshake(message: Uint8Array): Uint8Array {
    this.assertHandshake(true)
    const output = new Uint8Array(message.byteLength)
    const length = this.handshake.readMessage(message, output)
    this.verifyRemoteStatic()
    this.finishIfReady()
    return output.slice(0, length)
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.requireTransport().sendVec(plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.requireTransport().receiveVec(ciphertext)
  }

  destroy(): void {
    this.destroyed = true
    this.expectedRemoteStatic.fill(0)
    this.transport = undefined
  }

  private requireTransport(): TransportState {
    this.assertLive()
    if (this.transport === undefined) throw new NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.')
    return this.transport
  }

  private finishIfReady(): void {
    if (!this.handshake.isFinished()) return
    this.verifyRemoteStatic()
    this.transport = this.handshake.finalize()
  }

  private verifyRemoteStatic(): void {
    const actual = this.handshake.getRemoteStatic()
    if (actual === undefined || !constantTimeEqual(actual, this.expectedRemoteStatic)) {
      this.destroy()
      throw new NoiseSessionError('PEER_IDENTITY_MISMATCH', 'The peer key does not match the paired key.')
    }
  }

  private assertHandshake(reading: boolean): void {
    this.assertLive()
    if (this.complete) throw new NoiseSessionError('NOISE_ALREADY_READY', 'The Noise handshake is already complete.')
    if (this.handshake.isWriteTurn() === reading) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message arrived out of order.')
    }
  }

  private assertLive(): void {
    if (this.destroyed) throw new NoiseSessionError('NOISE_DESTROYED', 'The Noise session is closed.')
  }
}

export class NoiseSessionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Binds the handshake to one connection between two known devices. */
export function createNoisePrologue(connectionId: string, hostDeviceId: string, clientDeviceId: string): Uint8Array {
  for (const [name, value] of Object.entries({ connectionId, hostDeviceId, clientDeviceId })) {
    if (value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is not safe for a Noise prologue`)
  }
  return new TextEncoder().encode(
    `DS-BOT-LINK\0v=1\0connection=${connectionId}\0host=${hostDeviceId}\0client=${clientDeviceId}`,
  )
}

function requireKey(value: string, label: string): Uint8Array {
  const key = fromBase64Url(value)
  if (key.byteLength !== 32) throw new NoiseSessionError('INVALID_KEY', `${label} must be a 32-byte X25519 key.`)
  return Uint8Array.from(key)
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let different = 0
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!
  return different === 0
}
