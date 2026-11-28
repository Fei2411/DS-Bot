// React-free window-reload recovery plumbing shared by desktop and plugin views.
// Text drafts persist synchronously in browser storage (`flushDrafts`), while staged
// attachments (files, images, and long pastes folded into files) live only in memory.
// Reload directly when no unsent attachments exist; otherwise ask explicit confirmation first.
import { flushDrafts, hasKeptDraftFiles } from './draft-keep.js'
import { t } from './i18n.js'

const hostListeners = new Set()
const reloadGuards = new Set()

export function registerReloadConfirmHost(listener) {
  if (typeof listener !== 'function') return () => {}
  hostListeners.add(listener)
  return () => { hostListeners.delete(listener) }
}

/**
 * Register a synchronous guard returning `true` when the host holds unsent
 * in-memory state (such as failed-send attachments outside `draft-keep.js`)
 * that must require explicit confirmation before reloading the window.
 * @param {() => boolean} check
 * @returns {() => void}
 */
export function registerReloadGuard(check) {
  if (typeof check !== 'function') return () => {}
  reloadGuards.add(check)
  return () => { reloadGuards.delete(check) }
}

/**
 * Whether any chat in this window holds unsent in-memory attachments — either
 * staged in the composer (`hasKeptDraftFiles`) or reported by a registered guard.
 * @returns {boolean}
 */
export function hasUnsentReloadRisk() {
  if (hasKeptDraftFiles()) return true
  for (const check of Array.from(reloadGuards)) {
    try {
      if (check()) return true
    } catch {
      // Fail closed: an unreadable guard means unsent state is unknown, so require confirmation.
      return true
    }
  }
  return false
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
  if (!hasUnsentReloadRisk()) {
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
