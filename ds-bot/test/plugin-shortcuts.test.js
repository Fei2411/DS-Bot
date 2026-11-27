import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPluginShortcutCommands, registerPluginShortcuts } from '../src/client/plugin-shortcuts.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

const clientStore = {
  createSnapshotStore: (initial) => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      set: (next) => { value = next; for (const listener of listeners) listener() },
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
  },
  notifySubscribers: (listeners) => { for (const listener of listeners) listener() },
}

// Load the pinned DSH's real client shortcuts service the same way DSH's module loader does.
const registration = await (async () => {
  let value
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => { value = entry } } }
  try {
    await import('@deepseek-ai/dsh-client-shortcuts/client')
  } finally {
    globalThis.window = previous
  }
  return value
})()

const protocol = await import('@deepseek-ai/dsh-client-shortcuts/protocol')
const cordis = await import('@deepseek-ai/cordis')

const uiPrimitives = {
  modalSelector: '[aria-modal="true"]',
  observeComposition: () => ({ composing: () => false, dispose() {} }),
}

const ShortcutsService = registration.factory((name) => {
  if (name === '@deepseek-ai/dsh-client-store') return clientStore
  if (name === '@deepseek-ai/cordis') return cordis
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return uiPrimitives
  throw new Error(`Unexpected shortcuts dependency: ${name}`)
})

const DSH_BUILTIN_COMMANDS = [
  {
    id: 'sidebar.left.toggle',
    defaults: {
      'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
      'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'sidebar.right.toggle',
    defaults: {
      'desktop:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyB', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyB', modifiers: ['primary', 'shift'] },
    },
  },
  {
    id: 'settings.open',
    defaults: {
      'desktop:macos': { code: 'Comma', modifiers: ['primary'] },
      'desktop:windows': { code: 'Comma', modifiers: ['primary'] },
      'desktop:linux': { code: 'Comma', modifiers: ['primary'] },
      'web:macos': { code: 'Comma', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'Comma', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'shortcuts.open',
    defaults: {
      'desktop:macos': { code: 'Slash', modifiers: ['primary'] },
      'desktop:windows': { code: 'Slash', modifiers: ['primary'] },
      'desktop:linux': { code: 'Slash', modifiers: ['primary'] },
      'web:macos': { code: 'Slash', modifiers: ['primary'] },
      'web:windows': { code: 'Slash', modifiers: ['primary'] },
      'web:linux': { code: 'Slash', modifiers: ['primary'] },
    },
  },
  {
    id: 'browser.new',
    defaults: {
      'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
      'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'workspace.files',
    defaults: {
      'desktop:macos': { code: 'KeyP', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyP', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyP', modifiers: ['primary'] },
      'web:macos': { code: 'KeyP', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyP', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'workspace.openLocal',
    defaults: {
      'desktop:macos': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyO', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyO', modifiers: ['primary', 'shift'] },
    },
  },
  {
    id: 'terminal.new',
    defaults: {
      'desktop:macos': { code: 'Backquote', modifiers: ['control'] },
      'desktop:windows': { code: 'Backquote', modifiers: ['control'] },
      'desktop:linux': { code: 'Backquote', modifiers: ['control'] },
      'web:macos': { code: 'Backquote', modifiers: ['control'] },
      'web:windows': { code: 'Backquote', modifiers: ['control'] },
    },
  },
  {
    id: 'session.new',
    defaults: {
      'desktop:macos': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyN', modifiers: ['primary'] },
      'web:macos': { code: 'KeyN', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyN', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'session.search',
    defaults: {
      'desktop:macos': { code: 'KeyK', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyK', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyK', modifiers: ['primary'] },
      'web:macos': { code: 'KeyK', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyK', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'workspace.add',
    defaults: {
      'desktop:macos': { code: 'KeyO', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyO', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyO', modifiers: ['primary'] },
      'web:macos': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyO', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'session.rename',
    defaults: {
      'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyG', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyG', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'session.fork',
    defaults: {
      'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyF', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyF', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyF', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyF', modifiers: ['primary', 'shift'] },
    },
  },
  {
    id: 'session.archive',
    defaults: {
      'desktop:macos': { code: 'KeyA', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyA', modifiers: ['primary', 'shift'] },
      'desktop:linux': { code: 'KeyA', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyA', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyA', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'pane.split',
    defaults: {
      'desktop:macos': { code: 'Backslash', modifiers: ['primary'] },
      'desktop:windows': { code: 'Backslash', modifiers: ['primary'] },
      'desktop:linux': { code: 'Backslash', modifiers: ['primary'] },
      'web:macos': { code: 'Backslash', modifiers: ['primary'] },
      'web:windows': { code: 'Backslash', modifiers: ['primary'] },
    },
  },
  {
    id: 'pane.fullscreen.toggle',
    defaults: {
      'desktop:macos': { code: 'Enter', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'Enter', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'Enter', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'Enter', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'Enter', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'page.close',
    defaults: {
      'desktop:macos': { code: 'KeyW', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyW', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyW', modifiers: ['primary'] },
      'web:macos': { code: 'KeyW', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyW', modifiers: ['primary', 'alt'] },
    },
  },
  {
    id: 'page.refresh',
    defaults: {
      'desktop:macos': { code: 'KeyR', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyR', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyR', modifiers: ['primary'] },
      'web:windows': { code: 'KeyR', modifiers: ['primary', 'alt'] },
    },
  },
]

function mountRealShortcutsService(runtime, platform) {
  const prevWindow = globalThis.window
  const prevDocument = globalThis.document
  const prevNavigator = globalThis.navigator
  const prevMutationObserver = globalThis.MutationObserver
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const storage = new Map()
  const winListeners = new Map()
  const docListeners = new Map()
  const addTo = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  const removeFrom = (map, type, fn) => { map.get(type)?.delete(fn) }

  const desktopBridge = runtime === 'desktop' ? {
    platform,
    keyboard: {
      subscribe: () => () => {},
      closeWindow: () => Promise.resolve(),
    },
    shortcuts: {
      get: () => Promise.resolve({
        revision: 'rev-1',
        sequence: 1,
        document: { schemaVersion: 1, profiles: {} },
        status: 'ready',
        error: null,
        usingDefaults: true,
      }),
      subscribe: () => () => {},
      edit: () => Promise.resolve({ status: 'saved', snapshot: { revision: 'rev-2', sequence: 2, document: { schemaVersion: 1, profiles: {} }, status: 'ready', error: null, usingDefaults: true } }),
      recording: () => Promise.resolve(),
    },
  } : undefined

  const doc = {
    documentElement: { dataset: runtime === 'desktop' ? { platform } : {} },
    body: {},
    addEventListener: (type, fn) => addTo(docListeners, type, fn),
    removeEventListener: (type, fn) => removeFrom(docListeners, type, fn),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  globalThis.document = doc
  globalThis.window = {
    document: doc,
    addEventListener: (type, fn) => addTo(winListeners, type, fn),
    removeEventListener: (type, fn) => removeFrom(winListeners, type, fn),
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    ...(desktopBridge ? { dshDesktop: desktopBridge } : {}),
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: platform === 'macos' ? 'MacIntel' : platform === 'windows' ? 'Win32' : 'Linux x86_64',
      userAgent: platform === 'macos' ? 'Macintosh' : platform === 'windows' ? 'Windows' : 'Linux',
    },
  })

  const ctx = new cordis.Context()
  ctx.provide('locale')
  ctx.set('locale', { subscribe: () => () => {} })
  const service = new ShortcutsService(ctx)
  // Mark preferences ready so the registry populates its live dispatch table.
  service.registry.configure({
    revision: 'rev-ready',
    sequence: 1,
    document: { schemaVersion: 1, profiles: {} },
    status: 'ready',
    error: null,
    usingDefaults: true,
  })

  return {
    service,
    cleanup() {
      ctx.scope?.dispose?.()
      globalThis.window = prevWindow
      globalThis.document = prevDocument
      globalThis.MutationObserver = prevMutationObserver
      if (prevDesc) Object.defineProperty(globalThis, 'navigator', prevDesc)
      else globalThis.navigator = prevNavigator
    },
  }
}

function makeDeps() {
  const calls = []
  let mode = 'bot'
  let inbox = false
  let currentView = 'bot-main'
  const rosterData = {
    mainBotId: 'bot-main',
    browser: true,
    bots: [
      { id: 'bot-main', sessionId: 'sess-main', name: 'Main' },
      { id: 'bot-two', sessionId: 'sess-two', name: 'Helper' },
    ],
    rooms: [{ id: 'room-1', sessionId: 'sess-room', name: 'Dev' }],
    byId: {
      'bot-main': { id: 'bot-main', sessionId: 'sess-main', name: 'Main' },
      'bot-two': { id: 'bot-two', sessionId: 'sess-two', name: 'Helper' },
    },
    roomsById: {
      'room-1': { id: 'room-1', sessionId: 'sess-room', name: 'Dev' },
    },
    sections: [],
  }
  return {
    calls,
    setMode(next) { mode = next },
    setView(next) { currentView = next },
    deps: {
      roster: { getSnapshot: () => rosterData },
      ui: { getSnapshot: () => ({ inbox }) },
      surface: { getSnapshot: () => ({ mode }) },
      mainView: () => currentView,
      sessionsById: () => ({}),
      actions: {
        setSurface: (next) => { mode = next; calls.push(['setSurface', next]) },
        openInbox: () => { inbox = true; calls.push(['openInbox']) },
        closeInbox: () => { inbox = false; calls.push(['closeInbox']) },
        openBrowser: (id) => { calls.push(['openBrowser', id]) },
        toggleBrowser: (id) => { calls.push(['toggleBrowser', id]) },
        openGroupSearch: (id) => { calls.push(['openGroupSearch', id]) },
        openPalette: () => { calls.push(['openPalette']) },
        openSession: (id) => { calls.push(['openSession', id]) },
        openAgent: (id) => { calls.push(['openAgent', id]) },
      },
    },
  }
}

test('pinned DSH ShortcutRegistry accepts all 13 ds-bot plugin commands alongside built-in DSH commands across all 6 profiles', () => {
  const profiles = [
    ['desktop', 'macos'],
    ['desktop', 'windows'],
    ['desktop', 'linux'],
    ['web', 'macos'],
    ['web', 'windows'],
    ['web', 'linux'],
  ]
  for (const [runtime, platform] of profiles) {
    const { service, cleanup } = mountRealShortcutsService(runtime, platform)
    try {
      for (const builtin of DSH_BUILTIN_COMMANDS) {
        service.register({
          ...builtin,
          label: () => builtin.id,
          aliases: [],
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => ({ status: 'pass' }),
        })
      }

      const { deps } = makeDeps()
      const dispose = registerPluginShortcuts(service, deps)
      const dsBotRows = service.catalog.getSnapshot().filter(row => row.id.startsWith('ds-bot.'))
      assert.equal(dsBotRows.length, 13, `expected all 13 ds-bot commands on ${runtime}:${platform}`)

      for (const row of dsBotRows) {
        assert.equal(row.issue, null, `${row.id} must have no binding issue on ${runtime}:${platform}`)
        assert.deepEqual(row.conflicts, [], `${row.id} must have no conflicts on ${runtime}:${platform}`)
        if (runtime === 'web' && platform === 'linux') {
          assert.equal(row.binding, null, `${row.id} stays unbound by default on web:linux`)
        } else {
          assert.ok(row.binding !== null, `${row.id} should have an active default on ${runtime}:${platform}`)
        }
      }

      // Verify IPC catalog validation accepts the full combined catalog.
      const defs = service.registry.definitions()
      assert.equal(protocol.parseShortcutDefinitions(defs).length, DSH_BUILTIN_COMMANDS.length + 13)

      dispose()
      assert.equal(service.catalog.getSnapshot().filter(row => row.id.startsWith('ds-bot.')).length, 0)
    } finally {
      cleanup()
    }
  }
})

test('real DSH ShortcutRegistry dispatches ds-bot commands without modals and blocks safely under modals on Linux and Web', () => {
  for (const [runtime, platform] of [['desktop', 'linux'], ['web', 'macos'], ['desktop', 'macos']]) {
    const { service, cleanup } = mountRealShortcutsService(runtime, platform)
    try {
      const { deps, calls, setView } = makeDeps()
      const dispose = registerPluginShortcuts(service, deps)

      // Every command declares a concrete modals array so real Linux/Web dispatch never reads undefined.includes.
      for (const cmd of buildPluginShortcutCommands(deps)) {
        assert.ok(Array.isArray(cmd.modals), `${cmd.id} must declare modals[]`)
      }

      const primary = platform === 'macos' ? { meta: true, control: false } : { meta: false, control: true }
      const gesture = (code, extra = {}) => ({
        code,
        control: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false,
        composing: false,
        defaultPrevented: false,
        ...primary,
        ...extra,
      })

      // Switch surface: Mod+Shift+M works on both desktop and web (mac/win).
      const hitSurface = service.registry.dispatch(
        gesture('KeyM', { shift: true }),
        { region: 'page', modal: null, target: null },
        () => {},
      )
      assert.equal(hitSurface.status, 'handled', `${runtime}:${platform} switch-surface should dispatch`)
      assert.deepEqual(calls.at(-1), ['setSurface', 'agent'])

      // Switch back to bot mode and test modal blocking (exercises command.modals.includes on Linux & Web!).
      service.registry.dispatch(gesture('KeyM', { shift: true }), { region: 'page', modal: null, target: null }, () => {})
      assert.deepEqual(calls.at(-1), ['setSurface', 'bot'])

      const blockedModal = service.registry.dispatch(
        gesture('KeyM', { shift: true }),
        { region: 'page', modal: 'settings', target: null },
        () => {},
      )
      assert.equal(blockedModal.status, 'blocked')
      assert.equal(blockedModal.reason, 'modal')

      // Open browser: desktop Mod+Shift+B, web Mod+Alt+Shift+B.
      const hitBrowser = service.registry.dispatch(
        gesture('KeyB', runtime === 'web' ? { alt: true, shift: true } : { shift: true }),
        { region: 'page', modal: null, target: null },
        () => {},
      )
      assert.equal(hitBrowser.status, 'handled', `${runtime}:${platform} open-browser should dispatch`)
      assert.deepEqual(calls.at(-1), ['toggleBrowser', 'bot-main'])

      // Group search: desktop Mod+Shift+F, web Mod+Alt+F.
      setView('room-1')
      const hitGroupSearch = service.registry.dispatch(
        gesture('KeyF', runtime === 'web' ? { alt: true } : { shift: true }),
        { region: 'page', modal: null, target: null },
        () => {},
      )
      assert.equal(hitGroupSearch.status, 'handled', `${runtime}:${platform} group-search should dispatch`)
      assert.deepEqual(calls.at(-1), ['openGroupSearch', 'room-1'])

      // Conversation 2 switch: desktop Mod+2, web Mod+Alt+2.
      const hitSwitch2 = service.registry.dispatch(
        gesture('Digit2', runtime === 'web' ? { alt: true } : {}),
        { region: 'page', modal: null, target: null },
        () => {},
      )
      assert.equal(hitSwitch2.status, 'handled', `${runtime}:${platform} switch-bot-2 should dispatch`)
      assert.deepEqual(calls.at(-1), ['openSession', 'bot-two'])

      // Menu invoke with an open modal also checks command.modals.includes without throwing.
      assert.doesNotThrow(() => service.registry.invoke('ds-bot.switch-surface', { region: 'page', modal: 'shortcuts', target: null }))

      dispose()
    } finally {
      cleanup()
    }
  }
})

test('numbered conversations follow the pending sidebar fold, including on rollback', async () => {
  const { deps, calls } = makeDeps()
  const data = deps.roster.getSnapshot()
  const roster = createSource({
    ...data,
    bots: [data.bots[0], { ...data.bots[1], sectionId: 'first' }],
    rooms: [{ ...data.rooms[0], sectionId: 'second' }],
    sections: [{ id: 'first' }, { id: 'second' }],
  })
  const ui = createSource({})
  const write = Promise.withResolvers()
  const { saveSection } = teamActions({ call: () => write.promise, roster, ui })
  const shortcut = buildPluginShortcutCommands({ ...deps, roster, ui }).find(cmd => cmd.id === 'ds-bot.switch-bot-2')
  const switchConversation = () => shortcut.resolve({ modal: null }).run()
  switchConversation()
  assert.deepEqual(calls.at(-1), ['openSession', 'bot-two'])
  const save = saveSection({ id: 'first', collapsed: true })
  switchConversation()
  assert.deepEqual(calls.at(-1), ['openSession', 'room-1'])
  write.reject(new Error('cannot save'))
  await assert.rejects(save, /cannot save/)
  switchConversation()
  assert.deepEqual(calls.at(-1), ['openSession', 'bot-two'])
})

test('registerPluginShortcuts reports registration errors visibly instead of swallowing them', () => {
  const { deps } = makeDeps()
  const broken = {
    register(command) {
      if (command.id === 'ds-bot.open-browser') throw new Error('boom: conflict')
      return () => {}
    },
  }
  // Without onError, throws loudly.
  assert.throws(() => registerPluginShortcuts(broken, deps), /boom: conflict/)

  // With onError, reports the failure and still registers the remaining commands.
  const seen = []
  const registered = []
  const reporting = {
    register(command) {
      if (command.id === 'ds-bot.open-browser') throw new Error('boom: conflict')
      registered.push(command.id)
      return () => {}
    },
  }
  registerPluginShortcuts(reporting, { ...deps, onError: (id, err) => seen.push([id, err.message]) })
  assert.deepEqual(seen, [['ds-bot.open-browser', 'boom: conflict']])
  assert.equal(registered.length, 12)
})
