import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/ciphers/webcrypto'

export interface KeyPair {
  publicKey: string
  privateKey: string
}

export function generateKeyPair(privateKeyBytes?: Uint8Array): KeyPair {
  const privateKey = privateKeyBytes ?? x25519.utils.randomPrivateKey()
  if (privateKey.byteLength !== 32) throw new Error('X25519 private keys must be 32 bytes')
  return {
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(x25519.getPublicKey(privateKey)),
  }
}

/** A device's id is derived from its identity key, so the Server can check one against the other. */
export function deviceIdFor(publicKey: string): string {
  const key = fromBase64Url(publicKey)
  if (key.byteLength !== 32) throw new Error('X25519 public keys must be 32 bytes')
  return `d-${toBase64Url(sha256(key).slice(0, 16))}`
}

export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes))
}

const BASE64_CHUNK = 8192

export function toBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
  }
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + BASE64_CHUNK))
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const BASE64URL_CHARS = /^[A-Za-z0-9_-]*$/

export function fromBase64Url(value: string): Uint8Array {
  const stripped = value.endsWith('=')
    ? (value.length % 4 === 0 ? value.replace(/={1,2}$/, '') : null)
    : value
  if (stripped === null || stripped.length % 4 === 1 || !BASE64URL_CHARS.test(stripped)) {
    throw new Error('Invalid base64url string.')
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(stripped, 'base64url')
    return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
      ? new Uint8Array(buf.buffer)
      : Uint8Array.from(buf)
  }
  const normalized = stripped.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}
