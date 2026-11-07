// Pairing: a short code lets one device join, and the long token it gets back is what the
// hub checks on every later request. Only the token's hash is stored, so the hub's file
// cannot be used to act as a device.
import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'

export const CODE_TTL_MS = 5 * 60 * 1000
export const CODE_DIGITS = 6

// A six-digit code is only safe while guesses are limited; the hub counts failures per
// address (see PAIR_WINDOW_MS/PAIR_TRIES in hub.js).
export function newCode() {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
}

export function newToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export function tokenMatches(token, hash) {
  if (typeof token !== 'string' || token === '' || typeof hash !== 'string') return false
  const left = Buffer.from(hashToken(token), 'hex')
  const right = Buffer.from(hash, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

// Codes live in memory: a hub restart invalidates the ones still outstanding, which is
// the behavior we want for a short-lived secret.
export function createCodeStore({ now = Date.now, ttlMs = CODE_TTL_MS, code = newCode } = {}) {
  const open = new Map()
  const purge = () => {
    const at = now()
    for (const [value, expiresAt] of open) if (expiresAt <= at) open.delete(value)
  }
  return {
    issue() {
      purge()
      let value = code()
      while (open.has(value)) value = code()
      const expiresAt = now() + ttlMs
      open.set(value, expiresAt)
      return { code: value, expiresAt: new Date(expiresAt).toISOString(), ttlMs }
    },
    // One code pairs one device: a redeemed code is gone even if the request later fails.
    redeem(value) {
      purge()
      if (typeof value !== 'string') return false
      const expiresAt = open.get(value)
      if (expiresAt === undefined) return false
      open.delete(value)
      return true
    },
    get open() {
      purge()
      return open.size
    },
  }
}
