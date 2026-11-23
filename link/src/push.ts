import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { fromBase64Url, toBase64Url } from './keys.ts'

export const PUSH_ENVELOPE_VERSION = 1
export const MAX_PUSH_ENDPOINT_LENGTH = 1024
export const MAX_PUSH_TOKEN_LENGTH = 512
export const MAX_SEALED_PUSH_CHARS = 4096

const PUSH_SEAL_VERSION = 1
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
])

export interface PushNoticeEntry {
  seq: number
  kind: string
  botId: string
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
  if (parsed.protocol === 'https:') return true
  if (options.allowLoopbackHttp === true && parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  }
  return false
}

export function isValidPushToken(token: unknown): token is string {
  return typeof token === 'string'
    && token.length > 0
    && token.length <= MAX_PUSH_TOKEN_LENGTH
    && !/\s/u.test(token)
}

/**
 * Encrypts a notice payload to a paired phone's X25519 public key using an ephemeral
 * key exchange + HKDF-SHA256 + ChaCha20-Poly1305. Neither the Relay Server nor any
 * push distributor (UnifiedPush / FCM) can read the Bot name or message text.
 */
export function sealPushEnvelope(
  recipientPublicKey: string,
  hostDeviceId: string,
  payload: PushNoticePayload,
  ephemeralPrivateKey?: Uint8Array,
): PushEnvelope {
  const recipientPub = fromBase64Url(recipientPublicKey)
  if (recipientPub.byteLength !== X25519_KEY_BYTES) throw new Error('Invalid recipient public key.')
  if (typeof hostDeviceId !== 'string' || hostDeviceId.length === 0 || hostDeviceId.length > 128) {
    throw new Error('Invalid host device id.')
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  if (plaintext.byteLength > MAX_PUSH_PLAINTEXT_BYTES) throw new Error('Push payload exceeds size limit.')

  const ephPriv = ephemeralPrivateKey ?? x25519.utils.randomPrivateKey()
  if (ephPriv.byteLength !== X25519_KEY_BYTES) throw new Error('Invalid ephemeral private key.')
  const ephPub = x25519.getPublicKey(ephPriv)
  const shared = x25519.getSharedSecret(ephPriv, recipientPub)
  const { key, nonce, aad } = deriveSealKeys(shared, ephPub, recipientPub, hostDeviceId)
  const ciphertext = chacha20poly1305(key, nonce, aad).encrypt(plaintext)
  const sealed = new Uint8Array(SEAL_HEADER_BYTES + ciphertext.byteLength)
  sealed[0] = PUSH_SEAL_VERSION
  sealed.set(ephPub, 1)
  sealed.set(ciphertext, SEAL_HEADER_BYTES)
  const encoded = toBase64Url(sealed)
  if (encoded.length > MAX_SEALED_PUSH_CHARS) throw new Error('Sealed push envelope exceeds size limit.')
  return { v: PUSH_ENVELOPE_VERSION, h: hostDeviceId, p: encoded }
}

/** Decrypts a sealed push envelope using the phone's X25519 key pair. */
export function openPushEnvelope(
  recipientPrivateKey: string,
  recipientPublicKey: string,
  envelope: PushEnvelope,
): { hostDeviceId: string; payload: PushNoticePayload } {
  if (envelope.v !== PUSH_ENVELOPE_VERSION || typeof envelope.h !== 'string' || envelope.h.length === 0 || typeof envelope.p !== 'string') {
    throw new Error('Invalid push envelope.')
  }
  const recipientPriv = fromBase64Url(recipientPrivateKey)
  const recipientPub = fromBase64Url(recipientPublicKey)
  if (recipientPriv.byteLength !== X25519_KEY_BYTES || recipientPub.byteLength !== X25519_KEY_BYTES) {
    throw new Error('Invalid recipient identity keys.')
  }
  const sealed = fromBase64Url(envelope.p)
  if (sealed.byteLength < SEAL_HEADER_BYTES + AEAD_TAG_BYTES + 2 || sealed[0] !== PUSH_SEAL_VERSION) {
    throw new Error('Invalid sealed push bytes.')
  }
  const ephPub = sealed.subarray(1, SEAL_HEADER_BYTES)
  const ciphertext = sealed.subarray(SEAL_HEADER_BYTES)
  const shared = x25519.getSharedSecret(recipientPriv, ephPub)
  const { key, nonce, aad } = deriveSealKeys(shared, ephPub, recipientPub, envelope.h)
  const plaintext = chacha20poly1305(key, nonce, aad).decrypt(ciphertext)
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as Partial<PushNoticePayload>
  if (!isPushNoticeEntry(parsed?.notice)) throw new Error('Invalid push notice payload.')
  return {
    hostDeviceId: envelope.h,
    payload: {
      ...(typeof parsed.hostName === 'string' ? { hostName: parsed.hostName } : {}),
      ...(typeof parsed.boot === 'string' ? { boot: parsed.boot } : {}),
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
  return typeof entry.seq === 'number'
    && typeof entry.kind === 'string' && entry.kind.length > 0
    && typeof entry.botId === 'string' && entry.botId.length > 0
    && typeof entry.name === 'string'
    && typeof entry.text === 'string'
    && typeof entry.time === 'number'
    && (entry.roomId === undefined || typeof entry.roomId === 'string')
    && (entry.title === undefined || typeof entry.title === 'string')
    && (entry.sessionId === undefined || typeof entry.sessionId === 'string')
}

function deriveSealKeys(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array, hostDeviceId: string) {
  const salt = concatBytes(ephPub, recipientPub)
  const hostBytes = new TextEncoder().encode(hostDeviceId)
  const info = concatBytes(new TextEncoder().encode('ds-bot-push-v1:'), hostBytes)
  const material = hkdf(sha256, shared, salt, info, 44)
  return {
    key: material.subarray(0, 32),
    nonce: material.subarray(32, 44),
    aad: concatBytes(ephPub, hostBytes),
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength)
  out.set(left, 0)
  out.set(right, left.byteLength)
  return out
}
