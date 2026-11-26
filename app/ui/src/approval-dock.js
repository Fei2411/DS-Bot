import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { isImeComposing } from '../../../ds-bot/src/client/enter-key.js'
import { hostText, language, t } from '../../../ds-bot/src/client/i18n.js'
import { toTraditional } from '../../../ds-bot/src/client/locales/zh-tw.js'
import { hasEscapeLayer } from '../../../ds-bot/src/client/overlay-hooks.js'
import { isMacPlatform } from '../../../ds-bot/src/client/shortcuts-model.js'

const EMPTY_APPROVALS = []

const BROWSER_SCOPE_KEYS = {
  post: 'Always allow posting on {site}',
  upload: 'Always allow uploading files on {site}',
  download: 'Always allow downloading files on {site}',
  delete: 'Always allow deleting on {site}',
}

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
 * Resolves the localized approval reason from `entry.displayReason` if present,
 * falling back cleanly to `entry.reason`.
 */
export function resolveApprovalReason(entry, lang = language()) {
  const map = entry?.displayReason
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const raw = String(lang ?? 'en').toLowerCase()
    const base = raw.split('-')[0]
    if (typeof map[lang] === 'string' && map[lang].trim() !== '') return map[lang]
    if (typeof map[raw] === 'string' && map[raw].trim() !== '') return map[raw]
    if ((raw === 'zh-tw' || raw === 'zh-hk' || raw === 'zh-hant') && typeof map.zh === 'string' && map.zh.trim() !== '') {
      return toTraditional(map.zh)
    }
    if (typeof map[base] === 'string' && map[base].trim() !== '') return map[base]
    if (typeof map.en === 'string' && map.en.trim() !== '') return map.en
  }
  return typeof entry?.reason === 'string' && entry.reason.trim() !== '' ? entry.reason : ''
}

/**
 * Human-readable scope summary explaining what "Always allow" will persist.
 */
export function alwaysAllowScopeLabel(alwaysAllow) {
  if (!alwaysAllow || typeof alwaysAllow !== 'object') return ''
  if (alwaysAllow.kind === 'browser' && typeof alwaysAllow.site === 'string' && BROWSER_SCOPE_KEYS[alwaysAllow.action]) {
    return t(BROWSER_SCOPE_KEYS[alwaysAllow.action], { site: alwaysAllow.site })
  }
  if (alwaysAllow.kind === 'extra-dir' && Array.isArray(alwaysAllow.dirs) && alwaysAllow.dirs.length > 0) {
    const first = alwaysAllow.dirs[0]
    return alwaysAllow.dirs.length === 1
      ? t('Always allow file edits in {dir}', { dir: first })
      : t('Always allow file edits in {dir} (+{count})', { dir: first, count: alwaysAllow.dirs.length - 1 })
  }
  return ''
}

/**
 * Matches an approval dock keyboard shortcut (`Enter` = allow once, `Shift+Enter` = always allow
 * when eligible, `Escape` = reject), returning `'allow' | 'always' | 'reject' | null`.
 * Never fires while typing in the composer/inputs, during IME composition, while another dialog
 * or menu is open, or when Enter is pressed on another focused button/link.
 */
export function matchApprovalShortcut(event, { canAlways = false, doc = typeof document !== 'undefined' ? document : null, escapeLayerOpen = hasEscapeLayer() } = {}) {
  if (!event || event.defaultPrevented || event.repeat) return null
  if (isImeComposing(event) || event.keyCode === 229) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (escapeLayerOpen || hasOpenModalInDom(doc)) return null
  const active = doc?.activeElement ?? null
  if (isEditableElement(event.target) || isEditableElement(active)) return null

  if (event.key === 'Escape' && !event.shiftKey) return 'reject'
  if (event.key === 'Enter') {
    if (isInteractiveElement(event.target) || isInteractiveElement(active)) return null
    if (event.shiftKey) return canAlways ? 'always' : null
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
      && entry.sessionId === sessionId
      && !entry.botId
      && !entry.taskId
      && !entry.roomId
      && entry.answerable !== false)
  }
  return EMPTY_APPROVALS
}

function ApprovalCard({ entry, actions, readOnly, activeShortcuts = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
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

  useEffect(() => {
    if (!activeShortcuts || readOnly || typeof window === 'undefined') return undefined
    const onKeyDown = (event) => {
      if (busyRef.current) return
      const choice = matchApprovalShortcut(event, { canAlways })
      if (!choice) return
      event.preventDefault()
      event.stopPropagation()
      void decide(choice)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeShortcuts, readOnly, canAlways, decide])

  const code = typeof entry.detail?.code === 'string' && entry.detail.code.trim() !== '' ? entry.detail.code : ''
  const detailText = typeof entry.detail?.text === 'string' && entry.detail.text.trim() !== '' ? entry.detail.text : ''
  const rawReason = resolveApprovalReason(entry)
  const cleanReason = rawReason.startsWith('Allow this operation with danger-full-access permissions:')
    ? rawReason.slice('Allow this operation with danger-full-access permissions:'.length).trim()
    : rawReason
  const reason = cleanReason && cleanReason !== detailText ? cleanReason : ''
  const scopeText = canAlways ? alwaysAllowScopeLabel(entry.alwaysAllow) : ''
  const reviewNote = entry.review
    ? (entry.review.status === 'reviewing' ? t('Reviewing this action…') : (entry.review.reason || ''))
    : ''
  const mac = isMacPlatform()
  const alwaysCap = mac ? '⇧↵' : 'Shift+↵'

  return h('div', { className: 'dsb-approval', role: 'region', 'aria-label': t('Waiting for approval') },
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
        className: 'bt-q-btn dsb-approval-btn',
        disabled: busy || readOnly,
        onClick: () => { void decide('reject') },
      },
      h('span', null, t('Reject')),
      activeShortcuts && !readOnly ? h('kbd', { className: 'dsb-approval-kbd', 'aria-hidden': true }, 'Esc') : null),
      h('button', {
        type: 'button',
        className: canAlways ? 'bt-q-btn dsb-approval-btn' : 'bt-q-submit dsb-approval-btn',
        disabled: busy || readOnly,
        onClick: () => { void decide('allow') },
      },
      h('span', null, t('Allow once')),
      activeShortcuts && !readOnly ? h('kbd', { className: 'dsb-approval-kbd', 'aria-hidden': true }, '↵') : null),
      canAlways ? h('button', {
        type: 'button',
        className: 'bt-q-submit dsb-approval-btn',
        disabled: busy || readOnly,
        onClick: () => { void decide('always') },
      },
      h('span', null, t('Always allow')),
      activeShortcuts && !readOnly ? h('kbd', { className: 'dsb-approval-kbd', 'aria-hidden': true }, alwaysCap) : null) : null))
}

/**
 * Foreground DM tool approval dock rendered above the composer.
 */
export function ApprovalDock({ botId, sessionId, useWork, actions, readOnly = false }) {
  const approvals = useWork?.(work => work?.approvals) ?? EMPTY_APPROVALS
  const pending = foregroundApprovalsOf(approvals, botId, sessionId)
  if (pending.length === 0) return null
  return h('div', { className: 'dsb-approval-dock', 'data-approval-dock': '' },
    pending.map((entry, index) => h(ApprovalCard, {
      key: entry.id,
      entry,
      actions,
      readOnly,
      activeShortcuts: index === 0,
    })))
}
