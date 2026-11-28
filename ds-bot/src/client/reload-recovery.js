// Shared window-reload recovery action & confirmation dialog.
// Text drafts persist synchronously in browser storage (`flushDrafts`), while staged
// attachments (files, images, and long pastes folded into files) live only in memory.
// Reload directly when no attachments exist; otherwise ask explicit confirmation first.
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flushDrafts, hasKeptDraftFiles } from './draft-keep.js'
import { t } from './i18n.js'
import { useLinger } from './motion.js'
import { useEscape } from './overlay-hooks.js'

const hostListeners = new Set()

const WarningIcon = () => h('svg', {
  width: 16,
  height: 16,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
},
h('path', { d: 'M10 3.2 17.4 16a1.1 1.1 0 0 1-.95 1.65H3.55A1.1 1.1 0 0 1 2.6 16L10 3.2Z' }),
h('path', { d: 'M10 8v4' }),
h('circle', { cx: 10, cy: 14.5, r: 0.7, fill: 'currentColor', stroke: 'none' }))

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
 * @param {{ reload?: () => void }} [options]
 * @returns {boolean} true if reload ran immediately, false if awaiting confirmation
 */
export function requestWindowReload({ reload } = {}) {
  if (!hasKeptDraftFiles()) {
    performReload(reload)
    return true
  }
  const activeHost = Array.from(hostListeners).at(-1)
  if (activeHost) {
    activeHost({
      confirm: () => performReload(reload),
    })
    return false
  }
  if (typeof globalThis.confirm === 'function' && globalThis.confirm(t('Unsent attachments will be removed.'))) {
    performReload(reload)
    return true
  }
  return false
}

/**
 * Top-level confirmation dialog host for `requestWindowReload()`.
 * Reuses DS Bot's standard confirmation dialog styling (`.dsb-risk-layer` / `.dsb-risk-dialog`).
 */
export function ReloadConfirmHost() {
  const [pending, setPending] = useState(null)
  const [shown, leaving] = useLinger(pending, 160)
  const titleId = useId()
  const descId = useId()
  const cancelRef = useRef(null)
  const previousFocus = useRef(null)

  useEffect(() => {
    const listener = (req) => { setPending(req) }
    hostListeners.add(listener)
    return () => { hostListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!pending) return undefined
    previousFocus.current = typeof document !== 'undefined' ? document.activeElement : null
    cancelRef.current?.focus?.()
    return () => {
      const prev = previousFocus.current
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus()
    }
  }, [pending])

  const close = () => { setPending(null) }
  useEscape(close, Boolean(pending), { priority: 40 })

  if (!shown) return null

  const confirm = () => {
    const action = shown.confirm
    setPending(null)
    action?.()
  }

  const dialog = h('div', {
    className: 'dsb-risk-layer',
    role: 'presentation',
    'data-leaving': leaving ? '' : undefined,
    onMouseDown: (event) => { if (event.target === event.currentTarget && !leaving) close() },
  },
  h('div', {
    className: 'dsb-risk-dialog',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': descId,
    'data-danger': '',
  },
  h('div', { className: 'dsb-risk-head' },
    h('span', { className: 'dsb-risk-ico', 'aria-hidden': true }, h(WarningIcon)),
    h('h3', { id: titleId, className: 'dsb-risk-title' }, t('Reload window?'))),
  h('p', { id: descId, className: 'dsb-risk-body' }, t('Unsent attachments will be removed.')),
  h('div', { className: 'dsb-risk-foot' },
    h('button', {
      ref: cancelRef,
      type: 'button',
      className: 'bt-q-btn',
      disabled: leaving,
      onClick: close,
    }, t('Cancel')),
    h('button', {
      type: 'button',
      className: 'bt-q-submit dsb-risk-danger-btn',
      disabled: leaving,
      onClick: confirm,
    }, t('Reload window')))))

  return typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog
}
