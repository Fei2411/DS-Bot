import { createElement as h, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon } from '../../../ds-bot/src/client/icons.js'
import { ESCAPE_PRIORITY, useEscape, useModalFocusTrap } from '../../../ds-bot/src/client/overlay-hooks.js'
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  bindingsEqual,
  effectiveBinding,
  formatBindingCaps,
  isCommandAvailable,
  isMacPlatform,
  matchShortcutEvent,
  shortcutsStore,
} from '../../../ds-bot/src/client/shortcuts-model.js'
import { useShortcutOverrides } from '../../../ds-bot/src/client/shortcuts-page.js'

export { isMacPlatform }

let liveShortcutContext = null

/**
 * Registers the desktop window's live shortcut context provider (modal, settingsOpen,
 * capabilities) so focused embedded views like xterm mirror the window dispatcher exactly.
 */
export function setLiveShortcutContext(provider) {
  liveShortcutContext = typeof provider === 'function' ? provider : null
  return () => {
    if (liveShortcutContext === provider) liveShortcutContext = null
  }
}

export function getLiveShortcutContext() {
  return liveShortcutContext ? liveShortcutContext() : {}
}

/**
 * Resolves the topmost active modal kind following actual z-index stacking
 * (75 shortcuts > 70 palette/groupSearch > 66 releaseNotes > 61 memory > 60 settings > dialogs > inbox).
 */
export function resolveActiveModal(uiSnap, doc = typeof document === 'undefined' ? null : document) {
  if (!uiSnap) return null
  if (uiSnap.shortcuts) return 'shortcuts'
  if (uiSnap.palette) return 'palette'
  if (uiSnap.groupSearch) return 'groupSearch'
  if (uiSnap.releaseNotes) return 'dialog'
  if (uiSnap.memory) return 'memory'
  if (uiSnap.settings) return 'settings'
  if (uiSnap.newChat || uiSnap.exchange || uiSnap.voice || uiSnap.signIn) return 'dialog'
  if (uiSnap.inbox) return 'inbox'
  if (doc && typeof doc.querySelector === 'function' && doc.querySelector('[aria-modal="true"]')) return 'dialog'
  return null
}

/**
 * Matches desktop-wide keyboard shortcuts using the active user bindings.
 * Respects IME composition, already-handled events, recording mode, terminal pass-through,
 * modal boundaries, and Settings' own Cmd/Ctrl+K search.
 */
export function matchGlobalShortcut(event, options = {}) {
  return matchShortcutEvent(event, options)
}

function labelForDef(def, classic = false) {
  const key = classic && def.classicLabel ? def.classicLabel : def.label
  return def.labelVars ? t(key, def.labelVars) : t(key)
}

/**
 * Keyboard shortcuts cheatsheet modal, portaled into `document.body` and dismissed via Esc or backdrop.
 * Reads live custom bindings from `shortcutsStore` and links straight to Settings → Shortcuts.
 */
export function ShortcutsDialog({
  open,
  enterToSend = true,
  classic = false,
  hasSurface = true,
  hasBrowser = true,
  hasInbox = false,
  hasDetails = !classic,
  hasMemory = !classic,
  hasGroupSearch = !classic,
  onCustomize,
  onClose,
  store = shortcutsStore,
}) {
  const dialogRef = useRef(null)
  const closeBtn = useRef(null)
  const overrides = useShortcutOverrides(store)
  useEscape(onClose, open, { priority: ESCAPE_PRIORITY.SHORTCUTS })
  useModalFocusTrap(dialogRef, open, { initialFocusRef: closeBtn })

  const mac = isMacPlatform()
  const mod = mac ? '⌘' : 'Ctrl'
  const shift = mac ? '⇧' : 'Shift'

  const sections = useMemo(() => {
    const out = []
    const capabilities = { hasSurface, hasBrowser, hasInbox, hasDetails, hasMemory, hasGroupSearch }
    const regularGroups = SHORTCUT_GROUPS.filter(group => group.id !== 'chats')
    for (const group of regularGroups) {
      const rows = []
      for (const def of SHORTCUT_DEFS) {
        if (def.group !== group.id) continue
        if (!isCommandAvailable(def, capabilities)) continue
        const binding = effectiveBinding(def.id, overrides)
        if (!binding) continue
        rows.push({
          id: def.id,
          label: labelForDef(def, classic),
          keys: formatBindingCaps(binding, mac),
        })
      }
      if (group.id === 'navigation') {
        const chatDefs = SHORTCUT_DEFS.filter(def => def.group === 'chats')
        const allDefault = chatDefs.every(def => bindingsEqual(effectiveBinding(def.id, overrides), def.defaultBinding, mac))
        if (allDefault) {
          rows.push({
            id: 'switch-bot-range',
            label: t('Switch to conversation 1–9'),
            keys: [mod, '1–9'],
          })
        } else {
          for (const def of chatDefs) {
            const binding = effectiveBinding(def.id, overrides)
            if (!binding) continue
            rows.push({
              id: def.id,
              label: labelForDef(def, classic),
              keys: formatBindingCaps(binding, mac),
            })
          }
        }
      }
      if (rows.length > 0) out.push({ id: group.id, title: t(group.label), rows })
    }
    out.push({
      id: 'fixed',
      title: t('Fixed'),
      rows: [
        ...(classic ? [] : [{ id: 'fixed:mention', keys: ['@'], label: t('Mention a Bot') }]),
        { id: 'fixed:commands', keys: ['/'], label: t('Commands') },
        { id: 'fixed:send', keys: enterToSend ? ['Enter'] : [mod, 'Enter'], label: t('Send message') },
        { id: 'fixed:newline', keys: enterToSend ? [shift, 'Enter'] : ['Enter'], label: t('New line') },
        { id: 'fixed:stop-esc', keys: ['Esc', 'Esc'], label: t('Stop generating') },
        { id: 'fixed:approval-allow', keys: ['Enter'], label: t('Allow approval (card focused)') },
        { id: 'fixed:approval-reject', keys: ['Esc'], label: t('Reject approval (card focused)') },
        { id: 'fixed:esc', keys: ['Esc'], label: t('Close dialog or menu') },
      ],
    })
    return out
  }, [overrides, mac, mod, shift, enterToSend, classic, hasSurface, hasBrowser, hasInbox, hasDetails, hasMemory, hasGroupSearch])

  if (!open) return null

  const dialog = h('div', {
    className: 'dsb-shortcuts-layer',
    onClick: (event) => { if (event.target === event.currentTarget) onClose?.() },
  },
  h('div', { ref: dialogRef, tabIndex: -1, className: 'dsb-shortcuts', role: 'dialog', 'aria-modal': true, 'aria-label': t('Keyboard shortcuts') },
    h('div', { className: 'dsb-shortcuts-head' },
      h('h2', { className: 'dsb-shortcuts-title' }, t('Keyboard shortcuts')),
      h('div', { className: 'dsb-shortcuts-head-actions' },
        typeof onCustomize === 'function'
          ? h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm dsb-shortcuts-customize',
            onClick: () => { onClose?.(); onCustomize() },
          }, t('Customize'))
          : null,
        h('button', {
          ref: closeBtn,
          type: 'button',
          className: 'bt-icon-btn dsb-shortcuts-close',
          'aria-label': t('Close'),
          title: t('Close'),
          onClick: onClose,
        }, h(CloseIcon)))),
    h('div', { className: 'dsb-shortcuts-list' },
      sections.map(section => h('div', { key: section.id, className: 'dsb-shortcuts-group' },
        h('div', { className: 'dsb-shortcuts-group-title' }, section.title),
        section.rows.map(row => h('div', { key: row.id, className: 'dsb-shortcuts-row' },
          h('span', { className: 'dsb-shortcuts-label' }, row.label),
          h('span', { className: 'dsb-shortcuts-keys' },
            row.keys.map((cap, index) => h('kbd', { key: index, className: 'dsb-kbd' }, cap))))))))))
  const target = typeof document !== 'undefined' && document?.body ? document.body : null
  return target ? createPortal(dialog, target) : dialog
}
