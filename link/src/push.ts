import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { deviceIdFor, fromBase64Url, toBase64Url } from './keys.ts'

export const PUSH_ENVELOPE_VERSION = 1
export const MAX_PUSH_ENDPOINT_LENGTH = 1024
export const MAX_SEALED_PUSH_CHARS = 4096

const PUSH_SEAL_VERSION = 2
const X25519_KEY_BYTES = 32
const SEAL_HEADER_BYTES = 1 + X25519_KEY_BYTES
const AEAD_TAG_BYTES = 16
const MAX_PUSH_PLAINTEXT_BYTES = 2400

const URGENT_NOTICE_KINDS = new Set([
  'approval',
  'question',
  'view',
  'secret',
  'connector',
  'handoff',
  'learning',
  'mail',
  'computer',
  'goal',
  'blocked',
  'paused',
  'alert',
])

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.localdomain',
]

export interface PushNoticeEntry {
  seq: number
  kind: string
  botId?: string
  name: string
  roomId?: string
  title?: string
  sessionId?: string
  text: string
  time: number
}

export interface PushNoticePayload {
  hostName?: string
  boot?: string
  notice: PushNoticeEntry
}

/** Opaque wire envelope carried by UnifiedPush or FCM. Contains no plaintext content. */
export interface PushEnvelope {
  v: typeof PUSH_ENVELOPE_VERSION
  h: string
  p: string
}

export function isUrgentNoticeKind(kind: unknown): boolean {
  return typeof kind === 'string' && URGENT_NOTICE_KINDS.has(kind)
}

function parseIpv4(raw: string): [number, number, number, number] | null {
  const parts = raw.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }
  return [octets[0], octets[1], octets[2], octets[3]]
}

function isPublicIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets
  if (a === 0) return false // 0.0.0.0/8
  if (a === 10) return false // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64.0.0/10 CGNAT
  if (a === 127) return false // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return false // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast (224/4) & reserved (240/4)
  return true
}

function parseIpv6(raw: string): number[] | null {
  let text = raw.trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zoneIdx = text.indexOf('%')
  if (zoneIdx >= 0) text = text.slice(0, zoneIdx)
  if (!text.includes(':')) return null

  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1 or 64:ff9b::10.0.0.1).
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (v4 === null) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] === '' ? [] : halves[0].split(':')
  const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right]
  if (groups.length !== 8) return null

  const out: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

function isPublicIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  // ::/96 — covers :: (unspecified), ::1 (loopback), and deprecated IPv4-compatible ::a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return false
  }
  // ::ffff:0:0/96 (IPv4-mapped) or ::ffff:0:0:0/96 (IPv4-translated)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && ((g4 === 0 && g5 === 0xffff) || (g4 === 0xffff && g5 === 0))) {
    return isPublicIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff])
  }
  // 64:ff9b:1::/48 (RFC 8215 local-use NAT64 — not globally reachable)
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 1) {
    return false
  }
  // 64:ff9b::/96 (RFC 6052 well-known NAT64 prefix — embeds IPv4 in g6..g7)
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff])
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false // 100::/64 discard
  if (g0 === 0x2001 && g1 === 0x0000) return false // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0) return false // 2001:2::/48 benchmarking
  if (g0 === 0x2001 && ((g1 & 0xfff0) === 0x0010 || (g1 & 0xfff0) === 0x0020)) return false // 2001:10::/28, 2001:20::/28 ORCHID
  if (g0 === 0x2001 && g1 === 0x0db8) return false // 2001:db8::/32 documentation
  if (g0 === 0x2002) return false // 2002::/16 6to4 (embeds IPv4)
  if ((g0 & 0xfe00) === 0xfc00) return false // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return false // ff00::/8 multicast
  return true
}

/**
 * Returns true only when `ip` is a syntactically valid, globally routable IPv4 or IPv6 address.
 * Blocks loopback, RFC1918, ULA, link-local, CGNAT, multicast, and IPv4-mapped private IPv6.
 */
export function isPublicIpAddress(ip: string): boolean {
  const v4 = parseIpv4(ip.trim())
  if (v4 !== null) return isPublicIpv4(v4)
  const v6 = parseIpv6(ip)
  if (v6 !== null) return isPublicIpv6(v6)
  return false
}

export function isValidPushEndpoint(endpoint: unknown, options: { allowLoopbackHttp?: boolean } = {}): endpoint is string {
  if (typeof endpoint !== 'string') return false
  const trimmed = endpoint.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PUSH_ENDPOINT_LENGTH || trimmed !== endpoint) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return false
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.endsWith('.') ? rawHost.replace(/\.+$/u, '') : rawHost
  if (host === '') return false

  if (options.allowLoopbackHttp === true && parsed.protocol === 'http:') {
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  }
  if (parsed.protocol !== 'https:') return false

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return false

  const v4 = parseIpv4(host)
  if (v4 !== null) return isPublicIpv4(v4)
  if (host.startsWith('[') || host.includes(':')) {
    const v6 = parseIpv6(host)
    return v6 !== null && isPublicIpv6(v6)
  }
  // Reject bare single-label intranet hostnames without a public DNS suffix.
  if (!host.includes('.')) return false
  return true
}

/**
 * Encrypts and authenticates a notice payload from a paired host to a phone's X25519
 * public key using combined ephemeral + static ECDH (`es || ss`) + HKDF-SHA256 +
 * ChaCha20-Poly1305. Neither the Relay Server nor any push distributor can read the
 * content or forge a valid envelope without the host's static private key.
 */
export function sealPushEnvelope(
  hostPrivateKey: string,
  hostPublicKey: string,
  recipientPublicKey: string,
  payload: PushNoticePayload,
  ephemeralPrivateKey?: Uint8Array,
): PushEnvelope {
  const hostPriv = fromBase64Url(hostPrivateKey)
  const hostPub = fromBase64Url(hostPublicKey)
  const recipientPub = fromBase64Url(recipientPublicKey)
  if (hostPriv.byteLength !== X25519_KEY_BYTES || hostPub.byteLength !== X25519_KEY_BYTES) {
    throw new Error('Invalid host identity keys.')
  }
  if (recipientPub.byteLength !== X25519_KEY_BYTES) throw new Error('Invalid recipient public key.')
  const derivedHostPub = x25519.getPublicKey(hostPriv)
  if (!constantTimeEqual(derivedHostPub, hostPub)) throw new Error('Host key pair mismatch.')

  const hostDeviceId = deviceIdFor(hostPublicKey)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  if (plaintext.byteLength > MAX_PUSH_PLAINTEXT_BYTES) throw new Error('Push payload exceeds size limit.')

  const ephPriv = ephemeralPrivateKey ?? x25519.utils.randomPrivateKey()
  if (ephPriv.byteLength !== X25519_KEY_BYTES) throw new Error('Invalid ephemeral private key.')
  const ephPub = x25519.getPublicKey(ephPriv)

  const es = x25519.getSharedSecret(ephPriv, recipientPub)
  const ss = x25519.getSharedSecret(hostPriv, recipientPub)
  const header = new Uint8Array(SEAL_HEADER_BYTES)
  header[0] = PUSH_SEAL_VERSION
  header.set(ephPub, 1)

  const { key, nonce, aad } = deriveSealKeys(es, ss, header, ephPub, hostPub, recipientPub, hostDeviceId)
  const ciphertext = chacha20poly1305(key, nonce, aad).encrypt(plaintext)
  const sealed = new Uint8Array(SEAL_HEADER_BYTES + ciphertext.byteLength)
  sealed.set(header, 0)
  sealed.set(ciphertext, SEAL_HEADER_BYTES)
  const encoded = toBase64Url(sealed)
  if (encoded.length > MAX_SEALED_PUSH_CHARS) throw new Error('Sealed push envelope exceeds size limit.')
  return { v: PUSH_ENVELOPE_VERSION, h: hostDeviceId, p: encoded }
}

/**
 * Decrypts and authenticates a sealed push envelope using the phone's X25519 key pair
 * and the paired host's static X25519 public key.
 */
export function openPushEnvelope(
  recipientPrivateKey: string,
  recipientPublicKey: string,
  expectedHostPublicKey: string,
  envelope: PushEnvelope,
): { hostDeviceId: string; payload: PushNoticePayload } {
  if (envelope.v !== PUSH_ENVELOPE_VERSION
    || typeof envelope.h !== 'string' || envelope.h.length === 0 || envelope.h.length > 128
    || typeof envelope.p !== 'string' || envelope.p.length === 0 || envelope.p.length > MAX_SEALED_PUSH_CHARS) {
    throw new Error('Invalid push envelope.')
  }
  const recipientPriv = fromBase64Url(recipientPrivateKey)
  const recipientPub = fromBase64Url(recipientPublicKey)
  const hostPub = fromBase64Url(expectedHostPublicKey)
  if (recipientPriv.byteLength !== X25519_KEY_BYTES || recipientPub.byteLength !== X25519_KEY_BYTES) {
    throw new Error('Invalid recipient identity keys.')
  }
  if (hostPub.byteLength !== X25519_KEY_BYTES) {
    throw new Error('Invalid host public key.')
  }
  if (deviceIdFor(expectedHostPublicKey) !== envelope.h) {
    throw new Error('Host identity mismatch.')
  }
  const sealed = fromBase64Url(envelope.p)
  if (sealed.byteLength < SEAL_HEADER_BYTES + AEAD_TAG_BYTES + 2 || sealed[0] !== PUSH_SEAL_VERSION) {
    throw new Error('Invalid sealed push bytes.')
  }
  const header = sealed.subarray(0, SEAL_HEADER_BYTES)
  const ephPub = sealed.subarray(1, SEAL_HEADER_BYTES)
  const ciphertext = sealed.subarray(SEAL_HEADER_BYTES)
  const es = x25519.getSharedSecret(recipientPriv, ephPub)
  const ss = x25519.getSharedSecret(recipientPriv, hostPub)
  const { key, nonce, aad } = deriveSealKeys(es, ss, header, ephPub, hostPub, recipientPub, envelope.h)
  const plaintext = chacha20poly1305(key, nonce, aad).decrypt(ciphertext)
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as Partial<PushNoticePayload>
  if (!isPushNoticeEntry(parsed?.notice)) throw new Error('Invalid push notice payload.')
  return {
    hostDeviceId: envelope.h,
    payload: {
      ...(typeof parsed.hostName === 'string' ? { hostName: parsed.hostName } : {}),
      ...(typeof parsed.boot === 'string' && parsed.boot.length > 0 && parsed.boot.length <= 128 ? { boot: parsed.boot } : {}),
      notice: parsed.notice,
    },
  }
}

export function parsePushEnvelope(input: unknown): PushEnvelope | null {
  let raw = input
  if (raw instanceof Uint8Array) {
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { return null }
  } else if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const version = typeof candidate.v === 'string' ? Number(candidate.v) : candidate.v
  if (version !== PUSH_ENVELOPE_VERSION) return null
  if (typeof candidate.h !== 'string' || candidate.h.length === 0 || candidate.h.length > 128) return null
  if (typeof candidate.p !== 'string' || candidate.p.length === 0 || candidate.p.length > MAX_SEALED_PUSH_CHARS) return null
  return { v: PUSH_ENVELOPE_VERSION, h: candidate.h, p: candidate.p }
}

function isPushNoticeEntry(value: unknown): value is PushNoticeEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const hasBotId = typeof entry.botId === 'string' && entry.botId.length > 0 && entry.botId.length <= 256
  const hasRoomId = typeof entry.roomId === 'string' && entry.roomId.length > 0 && entry.roomId.length <= 256
  return typeof entry.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0
    && typeof entry.kind === 'string' && entry.kind.length > 0 && entry.kind.length <= 64
    && (hasBotId || hasRoomId)
    && (entry.botId === undefined || hasBotId)
    && (entry.roomId === undefined || hasRoomId)
    && typeof entry.name === 'string' && entry.name.length <= 256
    && typeof entry.text === 'string' && entry.text.length <= 2000
    && typeof entry.time === 'number' && Number.isFinite(entry.time) && entry.time >= 0
    && (entry.title === undefined || (typeof entry.title === 'string' && entry.title.length <= 256))
    && (entry.sessionId === undefined || (typeof entry.sessionId === 'string' && entry.sessionId.length <= 256))
}

function deriveSealKeys(
  es: Uint8Array,
  ss: Uint8Array,
  header: Uint8Array,
  ephPub: Uint8Array,
  hostPub: Uint8Array,
  recipientPub: Uint8Array,
  hostDeviceId: string,
) {
  const ikm = concatBytes(es, ss)
  const salt = concatBytes(ephPub, recipientPub)
  const hostBytes = new TextEncoder().encode(hostDeviceId)
  const info = concatBytes(concatBytes(new TextEncoder().encode('ds-bot-push-v2:'), hostPub), hostBytes)
  const material = hkdf(sha256, ikm, salt, info, 44)
  return {
    key: material.subarray(0, 32),
    nonce: material.subarray(32, 44),
    aad: concatBytes(concatBytes(header, hostPub), hostBytes),
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength)
  out.set(left, 0)
  out.set(right, left.byteLength)
  return out
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}
