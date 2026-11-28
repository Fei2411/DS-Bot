// Pure cache-busting helper for retrying failed dynamic module imports.
// Kept in a leaf module so retryable-lazy and plugin-runtime stay acyclic.

export function bustImportUrl(url, attempt = 0) {
  const raw = String(url ?? '')
  if (!raw || attempt <= 0) return raw
  const hashIdx = raw.indexOf('#')
  const hash = hashIdx >= 0 ? raw.slice(hashIdx) : ''
  const withoutHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  const queryIdx = withoutHash.indexOf('?')
  if (queryIdx < 0) return `${withoutHash}?retry=${attempt}${hash}`
  const base = withoutHash.slice(0, queryIdx)
  const params = new URLSearchParams(withoutHash.slice(queryIdx + 1))
  params.set('retry', String(attempt))
  return `${base}?${params.toString()}${hash}`
}
