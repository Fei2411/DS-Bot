import { hostText, t } from './i18n.js'
import { markNoted, noteClientError } from './diagnostics.js'

const ROUTE = 'api/bot'
// Refusals carry a message meant for the user, who sees it where they acted.
const REFUSALS = new Set(['bot/refused', 'bot/invalid', 'bot/read-only', 'bot/not-found', 'bot/browser-off'])

// A host that stops answering must not hold a view forever: a hung request kept the
// roster poll from scheduling its next read, and a menu action then showed nothing.
export const REQUEST_TIMEOUT_MS = 15000

export const call = async (endpoint, payload, signal) => {
  const control = new AbortController()
  const forward = () => control.abort()
  if (signal?.aborted) control.abort()
  else signal?.addEventListener('abort', forward, { once: true })
  let expired = false
  const timer = setTimeout(() => { expired = true; control.abort() }, REQUEST_TIMEOUT_MS)
  // `noteClientError` marks it noted, so the menu or form that shows it adds no second line.
  const expiredError = (cause) => {
    const error = Object.assign(new Error(t('DSH did not answer in time.')), { code: 'REQUEST_TIMEOUT', cause })
    noteClientError(endpoint, error)
    return error
  }
  try {
    let response
    try {
      // Document-relative so the Web UI keeps working under a mounted base path.
      response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload: payload ?? null }),
        signal: control.signal,
      })
    } catch (error) {
      if (expired) throw expiredError(error)
      if (error?.name === 'AbortError') throw error
      noteClientError(endpoint, Object.assign(new Error(`network error: ${error?.message ?? error}`), { code: 'NETWORK' }))
      // The browser's own text ("Failed to fetch", "Load failed") does not say what failed.
      throw markNoted(Object.assign(new Error(t('Could not reach DSH. Check that it is still running.')), { code: 'NETWORK', cause: error }))
    }
    if (!response.ok) {
      const error = Object.assign(new Error(hostText(`HTTP ${response.status}`)), { code: `HTTP_${response.status}` })
      noteClientError(endpoint, error)
      throw error
    }
    let result
    try {
      result = await response.json()
    } catch (error) {
      if (expired) throw expiredError(error)
      throw error
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'bot/error'
      const message = hostText(result.error?.message ?? 'Request failed')
      const error = Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
      if (!REFUSALS.has(code)) {
        noteClientError(endpoint, Object.assign(new Error(result.error?.message ?? 'Request failed'), { code }))
        markNoted(error)
      }
      throw error
    }
    return result.value
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}
