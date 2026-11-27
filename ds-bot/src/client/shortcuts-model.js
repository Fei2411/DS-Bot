import { isImeComposing } from './enter-key.js'
import { sectionCollapsed } from './sources.js'
import { currentPart } from './text.js'

const STORAGE_KEY = 'ds-bot.shortcuts.v1'

export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '')
}

export const SHORTCUT_GROUPS = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'panels', label: 'Panels' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'application', label: 'Application' },
  { id: 'chats', label: 'Quick switch (1–9)' },
]

// Platform-neutral binding shape:
// - `mod`: Cmd on macOS, Ctrl on Windows/Linux.
// - `ctrl`: explicit Control key (on macOS distinct from Cmd, e.g. Ctrl+`).
// - `alt`, `shift`: Option/Alt and Shift.
// - `code`: physical KeyboardEvent.code (e.g. 'KeyK', 'Digit1', 'Backslash').
const b = (code, { mod = false, ctrl = false, alt = false, shift = false } = {}) => ({
  code,
  mod: Boolean(mod),
  ctrl: Boolean(ctrl),
  alt: Boolean(alt),
  shift: Boolean(shift),
})

export const SHORTCUT_DEFS = [
  // Navigation
  { id: 'palette', group: 'navigation', label: 'Search', defaultBinding: b('KeyK', { mod: true }), allowInModal: ['palette'] },
  { id: 'switch-surface', group: 'navigation', label: 'Switch Bot / Classic Agent mode', defaultBinding: b('KeyM', { mod: true, shift: true }), requiresSurface: true },
  { id: 'inbox', group: 'navigation', label: 'Open Inbox', defaultBinding: b('KeyI', { mod: true }), requiresInbox: true, allowInModal: ['inbox'] },
  { id: 'prev-chat', group: 'navigation', label: 'Previous conversation', defaultBinding: b('BracketLeft', { mod: true }) },
  { id: 'next-chat', group: 'navigation', label: 'Next conversation', defaultBinding: b('BracketRight', { mod: true }) },

  // Panels
  { id: 'sidebar', group: 'panels', label: 'Toggle sidebar', defaultBinding: b('Backslash', { mod: true }) },
  { id: 'right-panel', group: 'panels', label: 'Toggle right panel', defaultBinding: b('Backslash', { mod: true, shift: true }) },
  { id: 'browser', group: 'panels', label: 'Toggle Bot browser', classicLabel: 'Toggle browser', defaultBinding: b('KeyB', { mod: true }), requiresBrowser: true },
  { id: 'terminal', group: 'panels', label: 'Open terminal', defaultBinding: b('Backquote', { ctrl: true }), allowInTerminal: true },
  { id: 'details', group: 'panels', label: 'Toggle details', defaultBinding: b('KeyD', { mod: true, shift: true }), requiresDetails: true },
  { id: 'memory', group: 'panels', label: 'Open memory', defaultBinding: b('KeyE', { mod: true, shift: true }), requiresMemory: true, allowInModal: ['memory'] },

  // Conversation
  { id: 'new-chat', group: 'conversation', label: 'New chat', defaultBinding: b('KeyN', { mod: true }), allowInModal: ['settings'] },
  { id: 'focus-composer', group: 'conversation', label: 'Focus message input', defaultBinding: b('KeyL', { mod: true }) },
  { id: 'group-search', group: 'conversation', label: 'Search in group', defaultBinding: b('KeyF', { mod: true, shift: true }), requiresGroupSearch: true, allowInModal: ['groupSearch'] },
  { id: 'stop-turn', group: 'conversation', label: 'Stop generating', defaultBinding: b('Period', { mod: true }) },

  // Application
  { id: 'settings', group: 'application', label: 'Settings', defaultBinding: b('Comma', { mod: true }), allowInModal: ['settings', 'shortcuts', 'palette'] },
  { id: 'shortcuts', group: 'application', label: 'Keyboard shortcuts', defaultBinding: b('Slash', { mod: true }), allowInModal: ['shortcuts', 'settings', 'palette'] },

  // Quick switch 1..9 (#1694)
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `switch-bot-${index + 1}`,
    group: 'chats',
    label: 'Switch to conversation {n}',
    labelVars: { n: index + 1 },
    slot: index,
    defaultBinding: b(`Digit${index + 1}`, { mod: true }),
  })),
]

export const SHORTCUT_BY_ID = Object.fromEntries(SHORTCUT_DEFS.map(def => [def.id, def]))

// Modifier-only keys cannot form a standalone shortcut.
const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock',
])

// Reserved OS / standard text-editing / physical window-zoom combos that must never be stolen globally.
// On Windows/Linux, main-row `-`/`=`/`+` zoom keys are character-based (zoom-keys.mjs) so non-US
// physical Minus/Equal keys like German Ctrl+ß stay assignable; macOS reserves Cmd+-/= in its menu.
const RESERVED_MOD_CODES = new Set([
  'KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyQ', 'KeyW', 'KeyH',
  'Digit0', 'Numpad0', 'NumpadAdd', 'NumpadSubtract',
])
// Additional macOS native Cocoa menu accelerators (Minimize / Reload / Zoom Out / Zoom In).
const RESERVED_MAC_MOD_CODES = new Set(['KeyM', 'KeyR', 'Minus', 'Equal'])

const FUNCTION_CODE = /^F(?:[1-9]|1[0-2])$/

const CODE_LABELS = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

const KEY_TO_CODE = {
  '`': 'Backquote',
  '~': 'Backquote',
  '-': 'Minus',
  '_': 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  ' ': 'Space',
}

/**
 * Resolves a physical `code` from a KeyboardEvent or synthetic event object.
 */
export function codeOfEvent(event) {
  if (!event) return ''
  if (typeof event.code === 'string' && event.code !== '') return event.code
  const key = String(event.key ?? '')
  if (key.length === 1) {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
    if (/^[0-9]$/.test(key)) return `Digit${key}`
    if (KEY_TO_CODE[key]) return KEY_TO_CODE[key]
  }
  if (FUNCTION_CODE.test(key)) return key
  if (key in CODE_LABELS) return key
  return ''
}

/**
 * Resolves platform-specific effective modifiers `{ meta, ctrl, alt, shift }` for a binding.
 */
export function resolveModifiers(binding, mac = isMacPlatform()) {
  if (!binding) return null
  const meta = mac ? Boolean(binding.mod) : false
  const ctrl = mac ? Boolean(binding.ctrl) : Boolean(binding.mod || binding.ctrl)
  return {
    meta,
    ctrl,
    alt: Boolean(binding.alt),
    shift: Boolean(binding.shift),
  }
}

export function normalizeBinding(raw) {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || raw.code === '') return undefined
  if (MODIFIER_CODES.has(raw.code)) return undefined
  return {
    code: raw.code,
    mod: Boolean(raw.mod),
    ctrl: Boolean(raw.ctrl),
    alt: Boolean(raw.alt),
    shift: Boolean(raw.shift),
  }
}

/**
 * Canonical platform-aware string key for equality and conflict checks.
 */
export function bindingKey(binding, mac = isMacPlatform()) {
  if (!binding || !binding.code) return ''
  const mods = resolveModifiers(binding, mac)
  return [
    mods.ctrl ? 'C' : '',
    mods.alt ? 'A' : '',
    mods.shift ? 'S' : '',
    mods.meta ? 'M' : '',
    binding.code,
  ].filter(Boolean).join('+')
}

export function bindingsEqual(a, b, mac = isMacPlatform()) {
  if (a === b) return true
  if (!a || !b) return false
  return bindingKey(a, mac) === bindingKey(b, mac)
}

export function codeLabel(code) {
  if (!code) return ''
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`
  return CODE_LABELS[code] ?? code
}

/**
 * Formats a binding into individual keycap labels for visual rendering.
 */
export function formatBindingCaps(binding, mac = isMacPlatform()) {
  if (!binding || !binding.code) return []
  const mods = resolveModifiers(binding, mac)
  const caps = []
  if (mac) {
    if (mods.ctrl) caps.push('⌃')
    if (mods.alt) caps.push('⌥')
    if (mods.shift) caps.push('⇧')
    if (mods.meta) caps.push('⌘')
  } else {
    if (mods.ctrl) caps.push('Ctrl')
    if (mods.alt) caps.push('Alt')
    if (mods.shift) caps.push('Shift')
    if (mods.meta) caps.push('Meta')
  }
  caps.push(codeLabel(binding.code))
  return caps
}

/**
 * Formats a binding for the `aria-keyshortcuts` attribute.
 */
export function formatBindingAria(binding, mac = isMacPlatform()) {
  if (!binding || !binding.code) return undefined
  const mods = resolveModifiers(binding, mac)
  const parts = []
  if (mods.ctrl) parts.push('Control')
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  if (mods.meta) parts.push('Meta')
  parts.push(codeLabel(binding.code))
  return parts.join('+')
}

export function isCommandAvailable(def, {
  hasSurface = true,
  hasBrowser = true,
  hasInbox = true,
  hasDetails = true,
  hasMemory = true,
  hasGroupSearch = true,
} = {}) {
  if (!def) return false
  if (def.requiresSurface && !hasSurface) return false
  if (def.requiresBrowser && !hasBrowser) return false
  if (def.requiresInbox && !hasInbox) return false
  if (def.requiresDetails && !hasDetails) return false
  if (def.requiresMemory && !hasMemory) return false
  if (def.requiresGroupSearch && !hasGroupSearch) return false
  return true
}

export function isAltGraph(event) {
  if (!event) return false
  return Boolean(event.getModifierState?.('AltGraph')) || event.key === 'AltGraph'
}

/**
 * Returns true if a Windows/Linux key event matches Electron's character-based
 * page-zoom handler (`app/src/zoom-keys.mjs`), avoiding false positives on non-US
 * physical `Minus`/`Equal` keys such as German `Ctrl+ß`.
 */
export function isReservedZoomKeyEvent(event, mac = isMacPlatform()) {
  if (mac || !event) return false
  const ctrlKey = Boolean(event.ctrlKey ?? event.control)
  const altKey = Boolean(event.altKey ?? event.alt)
  const metaKey = Boolean(event.metaKey ?? event.meta)
  const shiftKey = Boolean(event.shiftKey ?? event.shift)
  if (!ctrlKey || altKey || metaKey) return false
  if (event.key === '=' || event.key === '+') return true
  if (event.key === '-' && !shiftKey) return true
  if (event.key === '0' && (!shiftKey || event.code === 'Digit0')) return true
  return false
}

/**
 * Converts a DOM KeyboardEvent (or Electron input event) into a normalized binding.
 * Returns null if the event is modifier-only, uses AltGr/AltGraph, uses unsupported Meta
 * on Windows/Linux, or cannot produce a valid code.
 */
export function eventToBinding(event, mac = isMacPlatform()) {
  if (!event || isImeComposing(event) || isAltGraph(event)) return null
  const code = codeOfEvent(event)
  if (!code || MODIFIER_CODES.has(code)) return null
  const metaKey = Boolean(event.metaKey ?? event.meta)
  const ctrlKey = Boolean(event.ctrlKey ?? event.control)
  const altKey = Boolean(event.altKey ?? event.alt)
  const shiftKey = Boolean(event.shiftKey ?? event.shift)
  // On Windows/Linux, reject Super/Win key combos instead of silently dropping Meta.
  if (!mac && metaKey) return null
  return {
    code,
    mod: mac ? metaKey : ctrlKey,
    ctrl: mac ? ctrlKey : false,
    alt: altKey,
    shift: shiftKey,
  }
}

/**
 * Validates whether a recorded binding is safe to assign.
 * @returns {{ ok: true } | { ok: false, reason: 'modifier-only' | 'need-modifier' | 'reserved' }}
 */
export function validateBinding(binding, mac = isMacPlatform()) {
  if (!binding || !binding.code || MODIFIER_CODES.has(binding.code)) {
    return { ok: false, reason: 'modifier-only' }
  }
  const mods = resolveModifiers(binding, mac)
  const hasPrimary = mods.meta || mods.ctrl
  const hasAnyMod = hasPrimary || mods.alt || mods.shift
  if (binding.code === 'Escape' && !hasAnyMod) {
    return { ok: false, reason: 'reserved' }
  }
  // Enter / NumpadEnter submits composers, task notes, dialogs, and buttons across the app.
  if (binding.code === 'Enter' || binding.code === 'NumpadEnter') {
    return { ok: false, reason: 'reserved' }
  }
  // On Windows/Linux, Ctrl+Alt on non-function keys collides with AltGr character entry
  // across international keyboard layouts and cannot be distinguished reliably in Electron.
  if (!mac && mods.ctrl && mods.alt && !FUNCTION_CODE.test(binding.code)) {
    return { ok: false, reason: 'reserved' }
  }
  // Bare letters/digits/punctuation (or Shift+letter) would hijack typing.
  const onlyShift = mods.shift && !hasPrimary && !mods.alt
  if ((!hasAnyMod || onlyShift) && !FUNCTION_CODE.test(binding.code)) {
    return { ok: false, reason: 'need-modifier' }
  }
  // Protect core OS, text-editing, window-zoom, and macOS Cocoa menu shortcuts.
  // On macOS, Cmd+Ctrl+<key> (with Control held) is distinct from Cmd+<key> and stays allowed.
  if (hasPrimary && !mods.alt && !mods.shift) {
    if (RESERVED_MOD_CODES.has(binding.code) && (!mac || (mods.meta && !mods.ctrl))) {
      return { ok: false, reason: 'reserved' }
    }
    if (mac && mods.meta && !mods.ctrl && RESERVED_MAC_MOD_CODES.has(binding.code)) {
      return { ok: false, reason: 'reserved' }
    }
  }
  return { ok: true }
}

/**
 * Effective binding for one command given an overrides map (`{ [id]: binding | null }`).
 */
export function effectiveBinding(id, overrides = {}) {
  const def = SHORTCUT_BY_ID[id]
  if (!def) return null
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] ?? null
  }
  return def.defaultBinding ?? null
}

/**
 * Returns the conflicting command definition if another command already holds this binding.
 */
export function findConflict(targetId, binding, overrides = {}, mac = isMacPlatform()) {
  const key = bindingKey(binding, mac)
  if (!key) return null
  for (const def of SHORTCUT_DEFS) {
    if (def.id === targetId) continue
    const current = effectiveBinding(def.id, overrides)
    if (current && bindingKey(current, mac) === key) return def
  }
  return null
}

function platformBucket(mac = isMacPlatform()) {
  return mac ? 'mac' : 'other'
}

export function loadShortcutOverrides(storage = typeof localStorage === 'undefined' ? null : localStorage, mac = isMacPlatform()) {
  if (!storage) return {}
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const bucket = parsed[platformBucket(mac)]
    if (!bucket || typeof bucket !== 'object') return {}
    const clean = {}
    for (const [id, value] of Object.entries(bucket)) {
      if (!SHORTCUT_BY_ID[id]) continue
      if (value === null) clean[id] = null
      else {
        const normalized = normalizeBinding(value)
        if (normalized && validateBinding(normalized, mac).ok) clean[id] = normalized
      }
    }
    return clean
  } catch {
    return {}
  }
}

export function saveShortcutOverrides(overrides, storage = typeof localStorage === 'undefined' ? null : localStorage, mac = isMacPlatform()) {
  if (!storage) return
  try {
    let parsed = {}
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const existing = JSON.parse(raw)
      if (existing && typeof existing === 'object') parsed = existing
    }
    const clean = {}
    for (const [id, value] of Object.entries(overrides ?? {})) {
      if (!SHORTCUT_BY_ID[id]) continue
      if (value === null) clean[id] = null
      else {
        const normalized = normalizeBinding(value)
        if (normalized && validateBinding(normalized, mac).ok) clean[id] = normalized
      }
    }
    parsed[platformBucket(mac)] = clean
    storage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  } catch {
    // Storage quota or private browsing; keep in-memory state working.
  }
}

// Recording lock: while the user is capturing a new binding in Settings, pause global dispatch.
let recordingCount = 0
export function setShortcutRecording(active) {
  recordingCount = Math.max(0, recordingCount + (active ? 1 : -1))
}
export function isShortcutRecording() {
  return recordingCount > 0
}

/**
 * Reactive store for user shortcut overrides, compatible with `useSyncExternalStore`.
 */
export function createShortcutStore({ storage, mac = isMacPlatform() } = {}) {
  const resolveStorage = () => (storage !== undefined ? storage : (typeof localStorage === 'undefined' ? null : localStorage))
  let overrides = loadShortcutOverrides(resolveStorage(), mac)
  const listeners = new Set()
  const notify = () => { for (const fn of listeners) fn() }

  const commit = (next) => {
    overrides = next
    saveShortcutOverrides(overrides, resolveStorage(), mac)
    notify()
  }

  return {
    getSnapshot: () => overrides,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    bindingOf: (id) => effectiveBinding(id, overrides),
    isCustomized: (id) => Object.prototype.hasOwnProperty.call(overrides, id),
    hasCustomizations: () => Object.keys(overrides).length > 0,
    setBinding(id, binding, { replaceConflict = false } = {}) {
      if (!SHORTCUT_BY_ID[id]) return { ok: false, reason: 'unknown' }
      const next = { ...overrides }
      if (binding === null) {
        if (SHORTCUT_BY_ID[id].defaultBinding === null) delete next[id]
        else next[id] = null
        commit(next)
        return { ok: true }
      }
      const normalized = normalizeBinding(binding)
      const check = validateBinding(normalized, mac)
      if (!check.ok) return check
      const conflict = findConflict(id, normalized, next, mac)
      if (conflict) {
        if (!replaceConflict) return { ok: false, reason: 'conflict', conflict }
        next[conflict.id] = null
      }
      if (bindingsEqual(normalized, SHORTCUT_BY_ID[id].defaultBinding, mac)) {
        delete next[id]
      } else {
        next[id] = normalized
      }
      commit(next)
      return { ok: true }
    },
    resetBinding(id, { replaceConflict = false } = {}) {
      const def = SHORTCUT_BY_ID[id]
      if (!def || !Object.prototype.hasOwnProperty.call(overrides, id)) return { ok: true }
      const next = { ...overrides }
      const conflict = def.defaultBinding ? findConflict(id, def.defaultBinding, next, mac) : null
      if (conflict) {
        if (!replaceConflict) return { ok: false, reason: 'conflict', conflict, binding: def.defaultBinding }
        next[conflict.id] = null
      }
      delete next[id]
      commit(next)
      return { ok: true }
    },
    resetAll() {
      if (Object.keys(overrides).length === 0) return
      commit({})
    },
    /**
     * Active bindings serialized for Electron main-process forwarding from Bot WebContentsViews.
     */
    activeBindings(capabilities = {}) {
      const list = []
      for (const def of SHORTCUT_DEFS) {
        if (!isCommandAvailable(def, capabilities)) continue
        const binding = effectiveBinding(def.id, overrides)
        if (!binding) continue
        list.push({ id: def.id, ...binding })
      }
      return list
    },
  }
}

export const shortcutsStore = createShortcutStore()

/**
 * Matches a keyboard event against all effective desktop shortcuts.
 * Respects IME composition, repeated holds, already-handled events, active recording,
 * terminal pass-through on Windows/Linux, modal boundaries, capability availability,
 * and Settings' own Cmd/Ctrl+K search.
 */
export function matchShortcutEvent(event, {
  mac = isMacPlatform(),
  settingsOpen = false,
  modal = null,
  overrides = shortcutsStore.getSnapshot(),
  capabilities = {},
  ignoreRecording = false,
  inTerminal: forceInTerminal,
} = {}) {
  if (!event || event.defaultPrevented || event.repeat || isImeComposing(event) || isAltGraph(event)) return null
  if (isReservedZoomKeyEvent(event, mac)) return null
  if (!ignoreRecording && isShortcutRecording()) return null
  const code = codeOfEvent(event)
  if (!code || MODIFIER_CODES.has(code)) return null

  const metaKey = Boolean(event.metaKey ?? event.meta)
  const ctrlKey = Boolean(event.ctrlKey ?? event.control)
  const altKey = Boolean(event.altKey ?? event.alt)
  const shiftKey = Boolean(event.shiftKey ?? event.shift)
  if (!mac && ctrlKey && altKey && !metaKey && !FUNCTION_CODE.test(code)) return null

  // While Settings is open, always reserve Cmd/Ctrl+K for SettingsPalette search
  // regardless of which command is bound to that chord.
  const isSettingsSearchChord = code === 'KeyK' && !altKey && !shiftKey
    && (mac ? (metaKey && !ctrlKey) : (ctrlKey && !metaKey))
  if (settingsOpen && isSettingsSearchChord) return null

  const inTerminal = forceInTerminal !== undefined ? Boolean(forceInTerminal) : Boolean(
    event.target?.closest?.('.xterm')
    || (!event.target?.closest && typeof document !== 'undefined' && document.activeElement?.closest?.('.xterm')),
  )

  const activeModal = modal ?? (settingsOpen ? 'settings' : null)

  for (const def of SHORTCUT_DEFS) {
    if (!isCommandAvailable(def, capabilities)) continue
    const binding = effectiveBinding(def.id, overrides)
    if (!binding || binding.code !== code) continue
    const expected = resolveModifiers(binding, mac)
    if (expected.meta !== metaKey || expected.ctrl !== ctrlKey || expected.alt !== altKey || expected.shift !== shiftKey) {
      continue
    }
    // On Windows/Linux, let plain Ctrl+<key> (without Shift/Alt) pass through to a focused xterm PTY,
    // except commands explicitly marked `allowInTerminal` (e.g. Ctrl+` terminal toggle).
    if (!mac && inTerminal && !def.allowInTerminal && ctrlKey && !altKey && !shiftKey) {
      return null
    }
    // Respect foreground modal dialogs so shortcuts behind a modal do not silently switch state.
    if (activeModal && !(def.allowInModal && def.allowInModal.includes(activeModal))) {
      return null
    }
    return def.id
  }
  return null
}

/**
 * Computes the sidebar's visible navigation targets in exact `sidebar.js` render order:
 * 1. Primary Main Bot tile (when present and visible)
 * 2. Ungrouped entries (pinned first, then most recently updated)
 * 3. Expanded sections in order (pinned first, then most recently updated)
 * Hidden Bots/rooms are skipped unless currently active.
 */
export function visibleSidebarTargets(roster, sessionsById = {}, activeId = null, sectionFolds) {
  if (!roster) return []
  const stamps = {}
  for (const [id, entry] of Object.entries(sessionsById ?? {})) {
    stamps[id] = entry?.updatedAt ?? 0
  }
  const stampOf = (item, kind) => {
    if (kind === 'agent') {
      const list = Array.isArray(item.sessions) ? item.sessions : []
      return Math.max(0, ...list.map(id => stamps[id] ?? 0)) || item.createdAt || 0
    }
    const part = currentPart(item)
    return stamps[part] ?? item.createdAt ?? 0
  }
  const isVisible = (item, kind) => {
    if (kind === 'agent') return true
    if (!item.hidden) return true
    if (kind === 'bot' && (roster.mainBotId === item.id || (roster.mainBotIds ?? []).includes(item.id))) return true
    return activeId === item.id || activeId === currentPart(item)
  }

  const ordered = [
    ...(roster.bots ?? []).filter(bot => bot.id !== roster.mainBotId).map(bot => ({ kind: 'bot', id: bot.id, item: bot, at: stampOf(bot, 'bot') })),
    ...(roster.rooms ?? []).map(room => ({ kind: 'room', id: room.id, item: room, at: stampOf(room, 'room') })),
    ...(roster.agents ?? []).map(agent => ({ kind: 'agent', id: agent.id, item: agent, at: stampOf(agent, 'agent') })),
  ]
    .filter(entry => isVisible(entry.item, entry.kind))
    .sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)

  const sections = roster.sections ?? []
  const sectionSet = new Set(sections.map(sec => sec.id))
  const targets = []

  const main = roster.mainBotId ? roster.byId?.[roster.mainBotId] : null
  if (main && isVisible(main, 'bot')) {
    targets.push({ kind: 'bot', id: main.id, name: main.name })
  }
  for (const entry of ordered) {
    if (!entry.item.sectionId || !sectionSet.has(entry.item.sectionId)) {
      targets.push({ kind: entry.kind, id: entry.id, name: entry.item.name ?? 'DSH Agent' })
    }
  }
  for (const section of sections) {
    if (sectionCollapsed(section, sectionFolds)) continue
    for (const entry of ordered) {
      if (entry.item.sectionId === section.id) {
        targets.push({ kind: entry.kind, id: entry.id, name: entry.item.name ?? 'DSH Agent' })
      }
    }
  }
  return targets
}

/**
 * Computes visible Classic Agent sessions in exact `ClassicSidebar` display order:
 * primary agent only, sorted by updatedAt descending then array order descending.
 */
export function visibleClassicSessions(roster, sessionsById = {}) {
  const agent = (roster?.agents ?? [])[0]
  if (!agent) return []
  return (agent.sessions ?? [])
    .map((sid, order) => ({
      id: sid,
      agentId: agent.id,
      order,
      updatedAt: sessionsById?.[sid]?.updatedAt ?? 0,
    }))
    .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.order - a.order))
}
