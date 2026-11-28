// Shared retryable React.lazy helper so chunk load failures are never permanently cached
// inside React's lazy payload. Reused by engine-settings-bridge, right-panel terminal,
// settings-entry-lazy, and settings-pages-lazy.
import { createElement as h, lazy } from 'react'
import { bustImportUrl } from './plugin-runtime.js'

function findChunkUrl(error, chunkPattern) {
  if (!chunkPattern) return null
  const msg = String(error?.message ?? error ?? '')
  const urlMatches = msg.match(/https?:\/\/[^\s'")]+/gi) ?? []
  for (const candidate of urlMatches) {
    if (chunkPattern.test(candidate)) return candidate
  }
  try {
    const entries = globalThis.performance?.getEntriesByType?.('resource') ?? []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = String(entries[i]?.name ?? '')
      if (chunkPattern.test(name)) return name
    }
  } catch {
    // Ignore restricted performance API environments.
  }
  return null
}

/**
 * Wraps a dynamic `import()` function so retries on attempt > 0 bust the module cache URL
 * when the failed chunk URL is discoverable from the error or performance resource timeline.
 */
export function createChunkLoader(importFn, chunkPattern) {
  let lastFailedUrl = null
  return (attempt = 0) => {
    if (attempt > 0 && chunkPattern) {
      const chunkUrl = lastFailedUrl || findChunkUrl(null, chunkPattern)
      if (chunkUrl) {
        const busted = bustImportUrl(chunkUrl, attempt)
        return import(/* @vite-ignore */ busted).catch((err) => {
          lastFailedUrl = findChunkUrl(err, chunkPattern) || chunkUrl
          throw err
        })
      }
    }
    return Promise.resolve().then(() => importFn(attempt)).catch((err) => {
      lastFailedUrl = findChunkUrl(err, chunkPattern) || lastFailedUrl
      throw err
    })
  }
}

/**
 * Wraps `React.lazy` so a failed module load is not stuck on React's cached rejected
 * payload: calling `Component.reset()` bumps the attempt counter and creates a fresh
 * lazy wrapper that invokes `loadModule(attempt)` again on the next render.
 */
export function createRetryableLazy(loadModule, pickExport) {
  let attempt = 0
  let Inner = null
  const ensure = () => {
    if (Inner === null) {
      const currentAttempt = attempt
      Inner = lazy(() => Promise.resolve(loadModule(currentAttempt)).then((mod) => {
        const picked = typeof pickExport === 'function' ? pickExport(mod) : mod?.default
        if (!picked) throw new Error('Lazy module did not provide the expected view')
        return { default: picked }
      }))
    }
    return Inner
  }
  function RetryableLazy(props) {
    const Target = ensure()
    return h(Target, props)
  }
  RetryableLazy.reset = () => {
    attempt += 1
    Inner = null
  }
  RetryableLazy.attempt = () => attempt
  return RetryableLazy
}
