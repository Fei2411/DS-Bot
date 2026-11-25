import { createElement as h, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { isImeComposing } from '../../../ds-bot/src/client/enter-key.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon } from '../../../ds-bot/src/client/icons.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'

export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '')
}

/**
 * Matches desktop-wide keyboard shortcuts.
 * Respects IME composition, already-handled events, and Settings' own Cmd/Ctrl+K search.
 * @returns {'palette' | 'settings' | 'new-chat' | 'sidebar' | 'shortcuts' | null}
 */
export function matchGlobalShortcut(event, { mac = isMacPlatform(), settingsOpen = false } = {}) {
  if (!event || event.defaultPrevented || isImeComposing(event)) return null
  const primary = mac ? (event.metaKey && !event.ctrlKey) : (event.ctrlKey && !event.metaKey)
  if (!primary || event.altKey || event.shiftKey) return null
  // On Windows/Linux, let Ctrl+<key> combinations pass through to a focused xterm terminal PTY.
  const inTerminal = Boolean(
    event.target?.closest?.('.xterm')
    || (!event.target?.closest && typeof document !== 'undefined' && document.activeElement?.closest?.('.xterm')),
  )
  if (!mac && inTerminal) return null
  const key = String(event.key ?? '').toLowerCase()
  const code = String(event.code ?? '')
  if (key === 'k' || code === 'KeyK') return settingsOpen ? null : 'palette'
  if (key === ',' || code === 'Comma') return 'settings'
  if (key === 'n' || code === 'KeyN') return 'new-chat'
  if (key === '\\' || code === 'Backslash') return 'sidebar'
  if (key === '/' || code === 'Slash') return 'shortcuts'
  return null
}

/**
 * Keyboard shortcuts cheatsheet modal, portaled into `document.body` and dismissed via Esc or backdrop.
 */
export function ShortcutsDialog({ open, enterToSend = true, onClose }) {
  const closeBtn = useRef(null)
  const returnFocus = useRef(null)
  useEscape(onClose, open)
  useEffect(() => {
    if (open) {
      returnFocus.current = typeof document !== 'undefined' ? document.activeElement : null
      closeBtn.current?.focus?.()
      return undefined
    }
    const prev = returnFocus.current
    returnFocus.current = null
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (prev && prev.isConnected !== false && typeof prev.focus === 'function'
      && (!active || active === document.body || active === document.documentElement)) {
      prev.focus()
    }
    return undefined
  }, [open])
  if (!open) return null
  const mod = isMacPlatform() ? '⌘' : 'Ctrl'
  const rows = [
    { keys: [mod, 'K'], label: t('Search') },
    { keys: [mod, 'N'], label: t('New chat') },
    { keys: [mod, ','], label: t('Settings') },
    { keys: [mod, '\\'], label: t('Toggle sidebar') },
    { keys: [mod, '/'], label: t('Keyboard shortcuts') },
    { keys: ['@'], label: t('Mention a Bot') },
    { keys: ['/'], label: t('Commands') },
    { keys: enterToSend ? ['Enter'] : [mod, 'Enter'], label: t('Send message') },
    { keys: enterToSend ? ['Shift', 'Enter'] : ['Enter'], label: t('New line') },
    { keys: ['Esc'], label: t('Close dialog or menu') },
  ]
  const dialog = h('div', {
    className: 'dsb-shortcuts-layer',
    onClick: (event) => { if (event.target === event.currentTarget) onClose?.() },
  },
  h('div', { className: 'dsb-shortcuts', role: 'dialog', 'aria-modal': true, 'aria-label': t('Keyboard shortcuts') },
    h('div', { className: 'dsb-shortcuts-head' },
      h('h2', { className: 'dsb-shortcuts-title' }, t('Keyboard shortcuts')),
      h('button', {
        ref: closeBtn,
        type: 'button',
        className: 'bt-icon-btn dsb-shortcuts-close',
        'aria-label': t('Close'),
        title: t('Close'),
        onClick: onClose,
      }, h(CloseIcon))),
    h('div', { className: 'dsb-shortcuts-list' },
      rows.map(row => h('div', { key: row.keys.join('+'), className: 'dsb-shortcuts-row' },
        h('span', { className: 'dsb-shortcuts-label' }, row.label),
        h('span', { className: 'dsb-shortcuts-keys' },
          row.keys.map((cap, index) => h('kbd', { key: index, className: 'dsb-kbd' }, cap))))))))
  const target = typeof document !== 'undefined' && document?.body ? document.body : null
  return target ? createPortal(dialog, target) : dialog
}
