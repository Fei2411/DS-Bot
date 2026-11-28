// Shared retryable React.lazy helper so chunk load failures are never permanently cached
// inside React's lazy payload. Reused by engine-settings-bridge, right-panel terminal,
// settings-entry-lazy, and settings-pages-lazy.
import { createElement as h, lazy } from 'react'
import { requestWindowReload } from '../../../ds-bot/src/client/reload-action.js'
import { bustImportUrl } from './import-url.js'

/**
 * Flush any debounced composer drafts into browser storage synchronously before
 * performing a full window reload to clear Chromium's poisoned module map.
 * When unsent in-memory attachments exist, prompts for explicit confirmation first.
 */
export function reloadWindowSafely(options) {
  return requestWindowReload(options)
}

function findChunkUrl(error, chunkPattern) {
  if (!chunkPattern) return null
  const msg = String(error?.message ?? error ?? '')
  const urlMatches = msg.match(/(?:https?|dsh-app|file):\/\/[^\s'")]+/gi) ?? []
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
 *
 * - For 0-arg thunks (`() => import('./chunk.js')`), automatically imports the busted URL.
 * - For parameterized custom loaders (`(ctx) => ...`), always invokes `importFn` with
 *   `{ attempt, bustedUrl, importBusted }` so sibling chunk imports and style installation
 *   are never bypassed on retry.
 */
export function createChunkLoader(importFn, chunkPattern) {
  let lastFailedUrl = null
  return (attempt = 0) => {
    const chunkUrl = attempt > 0 && chunkPattern
      ? (lastFailedUrl || findChunkUrl(null, chunkPattern))
      : null
    const bustedUrl = chunkUrl ? bustImportUrl(chunkUrl, attempt) : null
    const importBusted = (url = bustedUrl) => (url ? import(/* @vite-ignore */ url) : null)
    const run = () => {
      if (bustedUrl && importFn.length === 0) return importBusted(bustedUrl)
      return importFn({ attempt, bustedUrl, importBusted })
    }
    return Promise.resolve().then(run).catch((err) => {
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
  let hadRendered = false
  const ensure = () => {
    if (Inner === null) {
      hadRendered = true
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
    if (Inner === null && hadRendered) return
    attempt += 1
    Inner = null
    hadRendered = true
  }
  RetryableLazy.attempt = () => attempt
  return RetryableLazy
}
