import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SHORTCUT_DEFS,
  bindingKey,
  createShortcutStore,
  effectiveBinding,
  eventToBinding,
  findConflict,
  formatBindingAria,
  formatBindingCaps,
  isReservedZoomKeyEvent,
  matchShortcutEvent,
  setShortcutRecording,
  validateBinding,
  visibleClassicSessions,
  visibleSidebarTargets,
} from '../src/client/shortcuts-model.js'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

test('default shortcut definitions have no platform conflicts', () => {
  for (const mac of [true, false]) {
    const seen = new Map()
    for (const def of SHORTCUT_DEFS) {
      const key = bindingKey(def.defaultBinding, mac)
      assert.ok(key, `${def.id} has a valid default key`)
      assert.equal(seen.has(key), false, `duplicate default ${key} for ${def.id} and ${seen.get(key)} (mac=${mac})`)
      seen.set(key, def.id)
    }
  }
})

test('matchShortcutEvent recognizes core v0.4.0 commands on macOS and Windows/Linux', () => {
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyM' }, { mac: true, overrides: {} }), 'switch-surface')
  assert.equal(matchShortcutEvent({ ctrlKey: true, shiftKey: true, code: 'KeyM' }, { mac: false, overrides: {} }), 'switch-surface')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyI' }, { mac: true, overrides: {} }), 'inbox')
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'KeyI' }, { mac: false, overrides: {} }), 'inbox')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyB' }, { mac: true, overrides: {} }), 'browser')
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'KeyB' }, { mac: false, overrides: {} }), 'browser')

  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'Backslash' }, { mac: true, overrides: {} }), 'right-panel')
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'Backquote' }, { mac: true, overrides: {} }), 'terminal')
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'Backquote' }, { mac: false, overrides: {} }), 'terminal')
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyD' }, { mac: true, overrides: {} }), 'details')
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyE' }, { mac: true, overrides: {} }), 'memory')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyL' }, { mac: true, overrides: {} }), 'focus-composer')
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyF' }, { mac: true, overrides: {} }), 'group-search')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'Period' }, { mac: true, overrides: {} }), 'stop-turn')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'BracketLeft' }, { mac: true, overrides: {} }), 'prev-chat')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'BracketRight' }, { mac: true, overrides: {} }), 'next-chat')

  for (let n = 1; n <= 9; n += 1) {
    assert.equal(matchShortcutEvent({ metaKey: true, code: `Digit${n}` }, { mac: true, overrides: {} }), `switch-bot-${n}`)
    assert.equal(matchShortcutEvent({ ctrlKey: true, code: `Digit${n}` }, { mac: false, overrides: {} }), `switch-bot-${n}`)
    assert.equal(matchShortcutEvent({ code: `Digit${n}`, key: String(n) }, { mac: true, overrides: {} }), null)
  }
})

test('matchShortcutEvent enforces repeat, capability, modal, terminal, IME, and recording guards', () => {
  // Repeated key holds must not re-fire toggles or create-chat bursts.
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyN', repeat: true }, { mac: true, overrides: {} }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyB', repeat: true }, { mac: true, overrides: {} }), null)

  // Unavailable capabilities must not hijack keys.
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyI' }, { mac: true, overrides: {}, capabilities: { hasInbox: false } }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyB' }, { mac: true, overrides: {}, capabilities: { hasBrowser: false } }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyM' }, { mac: true, overrides: {}, capabilities: { hasSurface: false } }), null)

  // Foreground modal blocks background switches.
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'Digit1' }, { mac: true, modal: 'settings', overrides: {} }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, shiftKey: true, code: 'KeyM' }, { mac: true, modal: 'dialog', overrides: {} }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyB' }, { mac: true, modal: 'palette', overrides: {} }), null)
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'Comma' }, { mac: true, modal: 'settings', overrides: {} }), 'settings')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyI' }, { mac: true, modal: 'inbox', overrides: {} }), 'inbox')
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyK' }, { mac: true, settingsOpen: true, overrides: {} }), null)
  // Even if another settings-allowed command is rebound to Mod+K, Settings search keeps Mod+K while open.
  assert.equal(matchShortcutEvent(
    { metaKey: true, code: 'KeyK' },
    { mac: true, settingsOpen: true, overrides: { settings: { code: 'KeyK', mod: true, ctrl: false, alt: false, shift: false }, palette: null } },
  ), null)

  // AltGr (AltGraph) character input on Windows/Linux must never be recorded or matched as Ctrl+Alt+<key>.
  const altGrEvent = { ctrlKey: true, altKey: true, code: 'KeyQ', key: '@', getModifierState: m => m === 'AltGraph' }
  assert.equal(eventToBinding(altGrEvent, false), null)
  assert.equal(matchShortcutEvent(altGrEvent, {
    mac: false,
    overrides: { browser: { code: 'KeyQ', mod: true, ctrl: false, alt: true, shift: false } },
  }), null)
  // macOS Option+E produces key='Dead' (non-composing) and stays consistent between recorder and matcher.
  const macOptE = { altKey: true, code: 'KeyE', key: 'Dead' }
  const macOptEBinding = eventToBinding(macOptE, true)
  assert.deepEqual(macOptEBinding, { code: 'KeyE', mod: false, ctrl: false, alt: true, shift: false })
  assert.equal(matchShortcutEvent(macOptE, { mac: true, overrides: { browser: macOptEBinding } }), 'browser')

  // Non-Mac xterm passes plain Ctrl+<key> through to PTY, except explicit allowInTerminal (Ctrl+`).
  const xtermTarget = { closest: selector => (selector === '.xterm' ? {} : null) }
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'KeyL', target: xtermTarget }, { mac: false, overrides: {} }), null)
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'KeyB', target: xtermTarget }, { mac: false, overrides: {} }), null)
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'Backquote', target: xtermTarget }, { mac: false, overrides: {} }), 'terminal')
  assert.equal(matchShortcutEvent({ ctrlKey: true, shiftKey: true, code: 'KeyM', target: xtermTarget }, { mac: false, overrides: {} }), 'switch-surface')

  // Recording mode suppresses all global matching.
  setShortcutRecording(true)
  try {
    assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyK' }, { mac: true, overrides: {} }), null)
  } finally {
    setShortcutRecording(false)
  }
  assert.equal(matchShortcutEvent({ metaKey: true, code: 'KeyK' }, { mac: true, overrides: {} }), 'palette')
})

test('validateBinding and eventToBinding reject unsafe combos while allowing macOS Ctrl+Cmd combos', () => {
  assert.deepEqual(validateBinding({ code: 'KeyA', mod: false, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'need-modifier' })
  assert.deepEqual(validateBinding({ code: 'KeyA', mod: false, ctrl: false, alt: false, shift: true }, true), { ok: false, reason: 'need-modifier' })
  assert.deepEqual(validateBinding({ code: 'KeyC', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'KeyQ', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Escape', mod: false, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  // Enter / NumpadEnter are reserved across all modifier combinations so custom shortcuts never collide with composer or form/task-note submit handlers.
  assert.deepEqual(validateBinding({ code: 'Enter', mod: false, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Enter', mod: false, ctrl: false, alt: false, shift: true }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Enter', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Enter', mod: false, ctrl: true, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Enter', mod: true, ctrl: false, alt: false, shift: true }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Enter', mod: false, ctrl: false, alt: true, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'NumpadEnter', mod: true, ctrl: false, alt: false, shift: false }, false), { ok: false, reason: 'reserved' })
  // Windows/Linux reserves Ctrl+Alt on non-function keys (AltGr character entry) while allowing F-keys and macOS Cmd/Ctrl+Alt.
  assert.deepEqual(validateBinding({ code: 'KeyQ', mod: true, ctrl: false, alt: true, shift: false }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Period', mod: true, ctrl: false, alt: true, shift: false }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Digit7', mod: true, ctrl: false, alt: true, shift: true }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'F8', mod: true, ctrl: false, alt: true, shift: false }, false), { ok: true })
  assert.deepEqual(validateBinding({ code: 'KeyQ', mod: true, ctrl: false, alt: true, shift: false }, true), { ok: true })
  // Physical zoom keys (Mod+0/NumpadAdd/NumpadSubtract) and macOS Cocoa menu Cmd+-/=/M/R are reserved.
  assert.deepEqual(validateBinding({ code: 'Digit0', mod: true, ctrl: false, alt: false, shift: false }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'NumpadAdd', mod: true, ctrl: false, alt: false, shift: false }, false), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Minus', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'Equal', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'KeyM', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  assert.deepEqual(validateBinding({ code: 'KeyR', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: false, reason: 'reserved' })
  // On Windows/Linux, physical Minus is allowed in validateBinding (German Ctrl+ß), while character-based zoom keys ('-', '=', '+') are caught by isReservedZoomKeyEvent.
  assert.deepEqual(validateBinding({ code: 'Minus', mod: true, ctrl: false, alt: false, shift: false }, false), { ok: true })
  assert.equal(isReservedZoomKeyEvent({ ctrlKey: true, code: 'Minus', key: 'ß' }, false), false)
  assert.equal(isReservedZoomKeyEvent({ ctrlKey: true, code: 'Slash', key: '-' }, false), true)
  assert.equal(isReservedZoomKeyEvent({ ctrlKey: true, code: 'Minus', key: '-' }, false), true)
  assert.equal(isReservedZoomKeyEvent({ ctrlKey: true, code: 'Equal', key: '=' }, false), true)
  assert.equal(isReservedZoomKeyEvent({ ctrlKey: true, shiftKey: true, code: 'Equal', key: '+' }, false), true)
  // Stored Ctrl+Minus (recorded on German Ctrl+ß) matches 'ß' but yields to '-' zoom after switching to US layout.
  const minusOverride = { settings: { code: 'Minus', mod: true, ctrl: false, alt: false, shift: false } }
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'Minus', key: 'ß' }, { mac: false, overrides: minusOverride }), 'settings')
  assert.equal(matchShortcutEvent({ ctrlKey: true, code: 'Minus', key: '-' }, { mac: false, overrides: minusOverride }), null)
  // Mod+Shift+M (switch-surface) stays allowed since Shift distinguishes it from macOS Cmd+M.
  assert.deepEqual(validateBinding({ code: 'KeyM', mod: true, ctrl: false, alt: false, shift: true }, true), { ok: true })
  // On macOS, Ctrl+Cmd+C is distinct from Cmd+C and stays assignable.
  assert.deepEqual(validateBinding({ code: 'KeyC', mod: true, ctrl: true, alt: false, shift: false }, true), { ok: true })
  assert.deepEqual(validateBinding({ code: 'F8', mod: false, ctrl: false, alt: false, shift: false }, true), { ok: true })
  assert.deepEqual(validateBinding({ code: 'KeyJ', mod: true, ctrl: false, alt: false, shift: false }, true), { ok: true })

  // Windows/Linux rejects Super/Meta key instead of silently dropping Meta.
  assert.equal(eventToBinding({ ctrlKey: true, metaKey: true, code: 'KeyK' }, false), null)
})

test('loadShortcutOverrides drops stale invalid overrides while keeping valid overrides and explicit unbinds', () => {
  const storage = memoryStorage()
  storage.setItem('ds-bot.shortcuts.v1', JSON.stringify({
    other: {
      browser: { code: 'Enter', mod: true, ctrl: false, alt: false, shift: true },
      inbox: { code: 'Period', mod: true, ctrl: false, alt: true, shift: false },
      memory: { code: 'F8', mod: true, ctrl: false, alt: true, shift: false },
      details: null,
    },
  }))
  const winStore = createShortcutStore({ storage, mac: false })
  assert.equal(winStore.bindingOf('browser')?.code, 'KeyB')
  assert.equal(winStore.bindingOf('inbox')?.code, 'KeyI')
  assert.equal(winStore.bindingOf('memory')?.code, 'F8')
  assert.equal(winStore.bindingOf('details'), null)
})

test('createShortcutStore persists per platform, checks conflicts on set and reset, and filters activeBindings', () => {
  const storage = memoryStorage()
  const macStore = createShortcutStore({ storage, mac: true })
  let notifications = 0
  const unsub = macStore.subscribe(() => { notifications += 1 })

  // Rebind inbox to Cmd+B (browser's default) with replaceConflict -> browser becomes null.
  const browserDefault = { code: 'KeyB', mod: true, ctrl: false, alt: false, shift: false }
  const firstConflict = macStore.setBinding('inbox', browserDefault)
  assert.equal(firstConflict.ok, false)
  assert.equal(firstConflict.reason, 'conflict')
  assert.equal(firstConflict.conflict.id, 'browser')
  assert.deepEqual(macStore.setBinding('inbox', browserDefault, { replaceConflict: true }), { ok: true })
  assert.equal(macStore.bindingOf('browser'), null)
  assert.deepEqual(macStore.bindingOf('inbox'), browserDefault)
  assert.equal(notifications, 1)

  // Resetting browser back to Cmd+B MUST report conflict with inbox instead of creating duplicate bindings.
  const resetConflict = macStore.resetBinding('browser')
  assert.equal(resetConflict.ok, false)
  assert.equal(resetConflict.reason, 'conflict')
  assert.equal(resetConflict.conflict.id, 'inbox')
  assert.deepEqual(macStore.resetBinding('browser', { replaceConflict: true }), { ok: true })
  assert.equal(macStore.bindingOf('browser')?.code, 'KeyB')
  assert.equal(macStore.bindingOf('inbox'), null)

  // activeBindings respects capability availability.
  const withoutInboxOrBrowser = macStore.activeBindings({ hasInbox: false, hasBrowser: false })
  assert.equal(withoutInboxOrBrowser.some(entry => entry.id === 'inbox'), false)
  assert.equal(withoutInboxOrBrowser.some(entry => entry.id === 'browser'), false)

  // Custom binding formatting and platform isolation.
  const custom = eventToBinding({ metaKey: true, code: 'KeyJ' }, true)
  assert.deepEqual(macStore.setBinding('browser', custom), { ok: true })
  assert.deepEqual(formatBindingCaps(macStore.bindingOf('browser'), true), ['⌘', 'J'])
  assert.equal(formatBindingAria(macStore.bindingOf('browser'), true), 'Meta+J')
  assert.equal(findConflict('inbox', custom, macStore.getSnapshot(), true)?.id, 'browser')

  const macReloaded = createShortcutStore({ storage, mac: true })
  assert.deepEqual(macReloaded.bindingOf('browser'), custom)
  const winStore = createShortcutStore({ storage, mac: false })
  assert.equal(effectiveBinding('browser', winStore.getSnapshot())?.code, 'KeyB')

  macStore.resetAll()
  assert.equal(macStore.hasCustomizations(), false)
  assert.equal(macStore.bindingOf('inbox')?.code, 'KeyI')
  unsub()
})

test('visibleSidebarTargets mirrors sidebar.js order (Main -> ungrouped -> expanded sections) and visibleClassicSessions matches ClassicSidebar', () => {
  const roster = {
    mainBotId: 'bot-main',
    mainBotIds: ['bot-main'],
    byId: {
      'bot-main': { id: 'bot-main', name: 'Main', createdAt: 10 },
      'bot-sec-a': { id: 'bot-sec-a', name: 'SecA', sectionId: 'sec-open', createdAt: 20 },
      'bot-sec-b': { id: 'bot-sec-b', name: 'SecB', sectionId: 'sec-open', pinned: true, createdAt: 15 },
      'bot-collapsed': { id: 'bot-collapsed', name: 'Collapsed', sectionId: 'sec-closed', createdAt: 99 },
      'bot-hidden': { id: 'bot-hidden', name: 'Hidden', hidden: true, createdAt: 99 },
      'bot-ungrouped': { id: 'bot-ungrouped', name: 'Ungrouped', createdAt: 30 },
    },
    bots: [],
    rooms: [
      { id: 'room-1', name: 'Design', createdAt: 50 },
    ],
    agents: [
      { id: 'agent-1', sessions: ['s1'], createdAt: 120 },
    ],
    sections: [
      { id: 'sec-open', name: 'Work', collapsed: false },
      { id: 'sec-closed', name: 'Later', collapsed: true },
    ],
  }
  roster.bots = Object.values(roster.byId)

  const targets = visibleSidebarTargets(roster, {
    'bot-sec-a': { updatedAt: 100 },
    'bot-sec-b': { updatedAt: 50 },
    'room-1': { updatedAt: 200 },
    'bot-ungrouped': { updatedAt: 150 },
    s1: { updatedAt: 120 },
  })

  // Exact sidebar.js order: Main Bot -> ungrouped (pinned then newest) -> expanded sections (pinned then newest).
  assert.deepEqual(targets.map(item => item.id), [
    'bot-main',
    'room-1', // ungrouped, 200
    'bot-ungrouped', // ungrouped, 150
    'agent-1', // ungrouped agent, 120
    'bot-sec-b', // pinned inside expanded section
    'bot-sec-a', // unpinned inside expanded section
  ])

  // ClassicSidebar shows primary agent only and breaks equal updatedAt ties by reverse array order.
  const classic = visibleClassicSessions({
    agents: [
      { id: 'a1', sessions: ['s1', 's2', 's3'] },
      { id: 'a2', sessions: ['s-other'] },
    ],
  }, {
    s1: { updatedAt: 10 },
    s2: { updatedAt: 30 },
    s3: { updatedAt: 30 },
    's-other': { updatedAt: 999 },
  })
  assert.deepEqual(classic.map(item => item.id), ['s3', 's2', 's1'])
})
