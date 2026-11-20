// Shared inbound media helpers for IM platform adapters: strict magic-byte
// detection matching DSH's accepted image types (png/jpeg/gif/webp only),
// size-capped downloads with stream cancellation, HTTP(S) URL checks, and
// crash-safe per-chat ordering queues.

export const IMAGE_LIMIT = 20 * 1024 * 1024
export const FILE_LIMIT = 50 * 1024 * 1024
export const MEDIA_TIMEOUT_MS = 20_000

export function mediaSignal(signal, timeoutMs = MEDIA_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
}

export function isHttpUrl(raw) {
  try {
    const { protocol } = new URL(String(raw ?? ''))
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function fileExtension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim())
  return match ? match[1].toLowerCase() : ''
}

// Strict magic-byte check returning only the four image types accepted by DSH
// AttachmentStore (`image/png`, `image/jpeg`, `image/gif`, `image/webp`).
// Unknown, empty, or unsupported formats (e.g. BMP/HEIC/SVG) return undefined
// so callers never poison DSH's atomic prompt admission.
export function detectImageMediaType(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  const at = (offset, ...seq) => buf.length >= offset + seq.length && seq.every((b, i) => buf[offset + i] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return undefined
}

export async function discardBody(response) {
  await response?.body?.cancel?.().catch(() => {})
}

export async function readCappedBytes(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await discardBody(response)
    return { overLimit: true }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer())
    return buf.length > limit ? { overLimit: true } : { bytes: buf }
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      total += chunk.length
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return { overLimit: true }
      }
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock?.()
  }
  return { bytes: Buffer.concat(chunks, total) }
}

// Serializes async handlers per chat key without creating an orphan `.finally()`
// rejection chain when a task throws.
export function createChatQueue() {
  const queues = new Map()
  return (key, run) => {
    const prev = queues.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(run)
    queues.set(key, next)
    const cleanup = () => { if (queues.get(key) === next) queues.delete(key) }
    next.then(cleanup, cleanup)
    return next
  }
}
