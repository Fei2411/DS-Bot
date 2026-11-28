// Byte-budgeted refcounted LRU cache for decoded attachment image previews,
// plus blob URL creation/revocation helpers for full-size lightbox images.
const MIB = 1024 * 1024
const IMAGE_CACHE_MIN_BYTES = 32 * MIB
const IMAGE_CACHE_DEFAULT_BYTES = 64 * MIB
const IMAGE_CACHE_MAX_BYTES = 128 * MIB

/**
 * Derives the preview image cache byte budget from device memory (`navigator.deviceMemory`),
 * scaling between 32 MiB and 128 MiB with a 64 MiB fallback when unavailable.
 */
export function computeImageCacheBudgetBytes(deviceMemory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined) {
  if (!Number.isFinite(deviceMemory) || deviceMemory <= 0) return IMAGE_CACHE_DEFAULT_BYTES
  const scaled = Math.round(deviceMemory * 16) * MIB
  return Math.max(IMAGE_CACHE_MIN_BYTES, Math.min(IMAGE_CACHE_MAX_BYTES, scaled))
}

export function decodeBase64ToBytes(base64) {
  if (typeof base64 !== 'string' || base64 === '') return new Uint8Array(0)
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  if (typeof globalThis.Buffer === 'function') {
    const buf = globalThis.Buffer.from(base64, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  return new Uint8Array(0)
}

export function buildImageUrl(mime, base64, { blob: preferBlob = false, createObjectURL } = {}) {
  const createUrl = preferBlob
    ? (createObjectURL ?? (typeof URL?.createObjectURL === 'function' ? value => URL.createObjectURL(value) : null))
    : null
  if (preferBlob && typeof Blob === 'function' && createUrl) {
    try {
      const bytes = decodeBase64ToBytes(base64)
      const blob = new Blob([bytes], { type: mime })
      return { url: createUrl(blob), bytes: Math.max(1, bytes.byteLength), isBlob: true }
    } catch { /* fall through to data URL when Blob/createObjectURL is unavailable across realms */ }
  }
  const url = `data:${mime};base64,${base64}`
  return { url, bytes: Math.max(1, url.length), isBlob: false }
}

export function revokeBlobUrl(url, revokeObjectURL) {
  if (typeof url !== 'string' || !url.startsWith('blob:')) return
  const revoke = revokeObjectURL ?? (typeof URL?.revokeObjectURL === 'function' ? value => URL.revokeObjectURL(value) : null)
  if (typeof revoke !== 'function') return
  try { revoke(url) } catch { /* already revoked */ }
}

/**
 * Byte-budgeted refcounted LRU cache for decoded preview images.
 * Evicted blob URLs are revoked immediately when unreferenced, or deferred until their
 * last mounted consumer releases them; evicted keys transparently reload on next access.
 */
export function createImageCache({ maxBytes = computeImageCacheBudgetBytes(), revokeObjectURL } = {}) {
  const entries = new Map()
  const byUrl = new Map()
  const deferred = new Map()
  let totalBytes = 0

  const revokeEntry = (entry) => {
    if (entry.isBlob) revokeBlobUrl(entry.url, revokeObjectURL)
  }

  const retire = (entry) => {
    entry.evicted = true
    if (byUrl.get(entry.url) === entry) byUrl.delete(entry.url)
    if (entry.refs <= 0) {
      revokeEntry(entry)
    } else {
      deferred.set(entry.url, entry)
    }
  }

  const evictIfNeeded = (protectKey) => {
    while (totalBytes > maxBytes && entries.size > 1) {
      let victimKey
      for (const key of entries.keys()) {
        if (key !== protectKey) { victimKey = key; break }
      }
      if (victimKey === undefined) break
      const victim = entries.get(victimKey)
      entries.delete(victimKey)
      totalBytes -= victim.bytes
      retire(victim)
    }
  }

  const acquireEntry = (entry) => {
    entry.refs += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.evicted && entry.refs === 0) {
        deferred.delete(entry.url)
        revokeEntry(entry)
      }
    }
  }

  return {
    get maxBytes() { return maxBytes },
    get totalBytes() { return totalBytes },
    get size() { return entries.size },
    has(key) { return entries.has(key) },
    peek(key) { return entries.get(key)?.url ?? null },
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      entries.set(key, entry)
      return entry.url
    },
    set(key, { url, bytes, isBlob = false }) {
      const cost = Math.max(1, Number.isFinite(bytes) ? bytes : 1)
      const existing = entries.get(key)
      if (existing && existing.url === url) {
        entries.delete(key)
        totalBytes += cost - existing.bytes
        existing.bytes = cost
        existing.isBlob = isBlob
        existing.evicted = false
        deferred.delete(url)
        entries.set(key, existing)
        byUrl.set(url, existing)
        evictIfNeeded(key)
        return existing.url
      }
      if (existing) {
        entries.delete(key)
        totalBytes -= existing.bytes
        retire(existing)
      }
      const revived = deferred.get(url)
      let entry
      if (revived) {
        deferred.delete(url)
        revived.bytes = cost
        revived.isBlob = isBlob
        revived.evicted = false
        entry = revived
      } else {
        entry = { url, bytes: cost, isBlob, refs: 0, evicted: false }
      }
      entries.set(key, entry)
      byUrl.set(url, entry)
      totalBytes += cost
      evictIfNeeded(key)
      return entry.url
    },
    acquire(key, url) {
      const entry = entries.get(key)
      if (entry && entry.url === url) {
        entries.delete(key)
        entries.set(key, entry)
        return acquireEntry(entry)
      }
      const byValue = byUrl.get(url) ?? deferred.get(url)
      return byValue ? acquireEntry(byValue) : () => {}
    },
    acquireUrl(url) {
      if (typeof url !== 'string' || url === '') return () => {}
      const entry = byUrl.get(url) ?? deferred.get(url)
      return entry ? acquireEntry(entry) : () => {}
    },
    clear() {
      for (const entry of entries.values()) retire(entry)
      entries.clear()
      totalBytes = 0
    },
  }
}

export const previewImageCache = createImageCache()

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']
export function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${SIZE_UNITS[unit]}`
}
