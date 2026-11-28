// React-free window-reload recovery plumbing shared by desktop and plugin views.
// Text drafts persist synchronously in browser storage (`flushDrafts`), while staged
// attachments (files, images, and long pastes folded into files) live only in memory.
// Reload directly when no attachments exist; otherwise ask explicit confirmation first.
import { flushDrafts, hasKeptDraftFiles } from './draft-keep.js'
import { t } from './i18n.js'

const hostListeners = new Set()

export function registerReloadConfirmHost(listener) {
  if (typeof listener !== 'function') return () => {}
  hostListeners.add(listener)
  return () => { hostListeners.delete(listener) }
}

function performReload(reloadFn) {
  try {
    flushDrafts()
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
  if (typeof reloadFn === 'function') reloadFn()
  else globalThis.location?.reload?.()
}

/**
 * Flush persisted text drafts and reload the window. When any chat holds unsent
 * in-memory attachments, open the confirmation dialog first so attachments are
 * never silently discarded.
 * @param {{ reload?: () => void, onBlocked?: (reason: string) => void }} [options]
 * @returns {'reloaded' | 'confirming' | 'cancelled' | 'blocked'}
 */
export function requestWindowReload({ reload, onBlocked } = {}) {
  if (!hasKeptDraftFiles()) {
    performReload(reload)
    return 'reloaded'
  }
  const activeHost = Array.from(hostListeners).at(-1)
  if (activeHost) {
    activeHost({
      confirm: () => performReload(reload),
    })
    return 'confirming'
  }
  const warning = t('Unsent attachments will be removed.')
  if (typeof globalThis.confirm === 'function') {
    if (globalThis.confirm(warning)) {
      performReload(reload)
      return 'reloaded'
    }
    return 'cancelled'
  }
  onBlocked?.(warning)
  return 'blocked'
}
