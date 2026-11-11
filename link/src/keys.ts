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

/** Short code both screens show at pairing, so the user can see they hold the same key. */
export function identityFingerprint(publicKey: string): string {
  return Array.from(sha256(fromBase64Url(publicKey)).slice(0, 6), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
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

export function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}
