import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { alwaysAllowScopeLabel, cleanApprovalReason, resolveApprovalReason } from '../../../ds-bot/src/client/approval-helpers.js'
import { isImeComposing } from '../../../ds-bot/src/client/enter-key.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { hasEscapeLayer } from '../../../ds-bot/src/client/overlay-hooks.js'

export { alwaysAllowScopeLabel, cleanApprovalReason, resolveApprovalReason }

const EMPTY_APPROVALS = []

function isEditableElement(node) {
  if (!node || typeof node !== 'object') return false
  if (node.isContentEditable === true) return true
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (typeof node.closest === 'function') {
    return Boolean(node.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
  }
  return false
}

function isInteractiveElement(node) {
  if (!node || typeof node !== 'object') return false
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'BUTTON' || tag === 'SUMMARY') return true
  if (tag === 'A' && typeof node.getAttribute === 'function' && node.getAttribute('href') !== null) return true
  if (typeof node.closest === 'function') {
    return Boolean(node.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="option"]'))
  }
  return false
}

function hasOpenModalInDom(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return false
  return Boolean(doc.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
}

/**
 * Matches a card-focused approval shortcut (`Enter` = allow once, `Escape` = reject),
 * returning `'allow' | 'reject' | null`. Mirrors DSH's `ApprovalCard.tsx`:
 * - Only fires while the approval card itself contains `document.activeElement`
 * - Never binds `Shift+Enter` or any lasting "Always allow" grant to a keyboard shortcut
 * - Ignores modifier chords, IME composition, editable elements, open overlays/menus,
 *   and (for `Enter`) interactive buttons/links inside the card
 */
export function matchApprovalShortcut(event, {
  cardEl = null,
  doc = typeof document !== 'undefined' ? document : null,
  escapeLayerOpen = hasEscapeLayer(),
  composing = false,
  compositionEnded = false,
} = {}) {
  if (!event || event.defaultPrevented || event.repeat) return null
  if (composing || compositionEnded || isImeComposing(event) || event.keyCode === 229) return null
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null
  if (escapeLayerOpen || hasOpenModalInDom(doc)) return null
  const container = cardEl ?? event.currentTarget ?? null
  const active = doc?.activeElement ?? null
  if (!container || typeof container.contains !== 'function' || !active || !container.contains(active)) return null
  if (isEditableElement(event.target) || isEditableElement(active)) return null

  if (event.key === 'Escape') return 'reject'
  if (event.key === 'Enter') {
    if (isInteractiveElement(event.target) || isInteractiveElement(active)) return null
    return 'allow'
  }
  return null
}

/**
 * Selects pending foreground DM or Classic Agent tool approvals (excludes group &
 * background-task approvals, which `HeaderPill` already owns via `ApprovalIslandPod` / `TaskIslandPod`).
 */
export function foregroundApprovalsOf(approvals, botId, sessionId = null) {
  if (!Array.isArray(approvals) || approvals.length === 0) return EMPTY_APPROVALS
  if (botId) {
    return approvals.filter(entry => entry
      && entry.botId === botId
      && !entry.taskId
      && !entry.roomId
      && entry.answerable !== false)
  }
  if (sessionId) {
    return approvals.filter(entry => entry
      && (entry.sessionId === sessionId || entry.ownerSessionId === sessionId)
      && !entry.botId
      && !entry.taskId
      && !entry.roomId
      && entry.answerable !== false)
  }
  return EMPTY_APPROVALS
}

function ApprovalCard({ entry, actions, readOnly }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cardRef = useRef(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const composingRef = useRef(false)
  const compositionEndedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const canAlways = Boolean(entry.alwaysAllow) && !readOnly
  const decide = useCallback(async (choice) => {
    if (busyRef.current || readOnly || typeof actions?.answerApproval !== 'function') return
    if (choice === 'always' && !canAlways) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await actions.answerApproval(entry.id, choice)
    } catch (failure) {
      busyRef.current = false
      if (mountedRef.current) {
        setError(hostText(failure?.message ?? String(failure)))
        setBusy(false)
      }
    }
  }, [actions, entry.id, readOnly, canAlways])

  const onCompositionStartCapture = useCallback(() => {
    composingRef.current = true
    compositionEndedRef.current = false
  }, [])

  const onCompositionEndCapture = useCallback(() => {
    composingRef.current = false
    compositionEndedRef.current = true
  }, [])

  const onKeyUpCapture = useCallback(() => {
    compositionEndedRef.current = false
  }, [])

  const onKeyDown = useCallback((event) => {
    if (busyRef.current || readOnly) return
    const choice = matchApprovalShortcut(event, {
      cardEl: cardRef.current ?? event.currentTarget,
      composing: composingRef.current,
      compositionEnded: compositionEndedRef.current,
    })
    if (!choice) return
    event.preventDefault()
    event.stopPropagation()
    void decide(choice)
  }, [readOnly, decide])

  const code = typeof entry.detail?.code === 'string' && entry.detail.code.trim() !== '' ? entry.detail.code : ''
  const detailText = typeof entry.detail?.text === 'string' && entry.detail.text.trim() !== '' ? entry.detail.text : ''
  const reason = cleanApprovalReason(entry, detailText)
  const scopeText = canAlways ? alwaysAllowScopeLabel(entry.alwaysAllow) : ''
  const reviewNote = entry.review
    ? (entry.review.status === 'reviewing' ? t('Reviewing this action…') : (entry.review.reason || ''))
    : ''

  return h('div', {
    ref: cardRef,
    className: 'dsb-approval',
    role: 'region',
    'aria-label': t('Waiting for approval'),
    tabIndex: readOnly ? undefined : 0,
    onKeyDown,
    onKeyUpCapture,
    onCompositionStartCapture,
    onCompositionEndCapture,
  },
  h('div', { className: 'dsb-approval-head' },
    h('span', { className: 'dsb-approval-dot', 'aria-hidden': true }),
    h('span', { className: 'dsb-approval-title' }, t('Waiting for approval')),
    entry.tool ? h('span', { className: 'dsb-approval-tool', title: entry.tool }, entry.tool) : null),
  code ? h('pre', { className: 'dsb-approval-code' }, h('code', null, code)) : null,
  detailText ? h('p', { className: 'dsb-approval-text' }, detailText) : null,
  reason ? h('p', { className: 'dsb-approval-reason' }, reason) : null,
  reviewNote ? h('p', { className: 'dsb-approval-review', role: 'status' }, reviewNote) : null,
  scopeText ? h('p', { className: 'dsb-approval-scope' }, scopeText) : null,
  error ? h('p', { className: 'dsb-approval-error', role: 'alert' }, error) : null,
  h('div', { className: 'dsb-approval-foot' },
    h('button', {
      type: 'button',
      className: 'bt-q-btn',
      disabled: busy || readOnly,
      onClick: () => { void decide('reject') },
    },
    h('span', null, t('Reject')),
    !readOnly ? h('kbd', { className: 'dsb-approval-kbd', 'aria-hidden': true }, 'Esc') : null),
    h('button', {
      type: 'button',
      className: 'bt-q-submit',
      disabled: busy || readOnly,
      onClick: () => { void decide('allow') },
    },
    h('span', null, t('Allow once')),
    !readOnly ? h('kbd', { className: 'dsb-approval-kbd', 'aria-hidden': true }, '↵') : null),
    canAlways ? h('button', {
      type: 'button',
      className: 'bt-q-btn',
      disabled: busy || readOnly,
      onClick: () => { void decide('always') },
    },
    h('span', null, t('Always allow'))) : null))
}

/**
 * Foreground DM tool approval dock rendered above the composer.
 */
export function ApprovalDock({ botId, sessionId, useWork, actions, readOnly = false }) {
  const approvals = useWork?.(work => work?.approvals) ?? EMPTY_APPROVALS
  const pending = foregroundApprovalsOf(approvals, botId, sessionId)
  if (pending.length === 0) return null
  return h('div', { className: 'dsb-approval-dock', 'data-approval-dock': '' },
    pending.map(entry => h(ApprovalCard, {
      key: entry.id,
      entry,
      actions,
      readOnly,
    })))
}
