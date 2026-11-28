// Real DSH plugin-host contract and first-screen smoke tests.
//
// Mounts the real built `ds-bot/client.js` bundle and the real host entry `ds-bot/plugin.js`
// inside an actual `@deepseek-ai/cordis` Context where every DSH service is provided by an
// independent sibling plugin fiber (not `root.provide`), so Cordis's real `ReflectService`
// and `createTraceable` proxy strictly enforce `cannot get property "<prop>" without inject`
// for both top-level services and dotted sub-services (such as `uiSession.sessionStatus`,
// `connection.state`, `shortcuts.catalog`, `sidebarRight.openTab`, and `workspaces.list`).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import React, { act, createElement as h, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Context, Service } from '@deepseek-ai/cordis'
import * as pluginEntry from '../plugin.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_BUNDLE = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')

const tempDirs = []
after(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {}
  }
})

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      value = typeof next === 'function' ? next(value) : next
      for (const listener of Array.from(listeners)) listener()
    },
    listenerCount: () => listeners.size,
  }
}

// DSH's standard hook prop naming: `hooks.roster` -> `useRoster`.
function hookPropName(name) {
  return `use${name[0].toUpperCase()}${name.slice(1)}`
}

function makeSelectorHook(source) {
  return function useSource(selector = value => value) {
    const snapshot = useSyncExternalStore(
      listener => source?.subscribe?.(listener) ?? (() => {}),
      () => source?.getSnapshot?.(),
      () => source?.getSnapshot?.(),
    )
    return selector(snapshot)
  }
}

function makeKeyedSelectorHook(resolve) {
  return function useKeyed(key, selector = value => value) {
    const source = resolve(key)
    const snapshot = useSyncExternalStore(
      listener => source?.subscribe?.(listener) ?? (() => {}),
      () => source?.getSnapshot?.(),
      () => source?.getSnapshot?.(),
    )
    return selector(snapshot)
  }
}

// All DSH UI primitives imported by src/client/dsh-primitives.js.
function makePrimitives() {
  const Icon = props => h('svg', { 'data-icon': true, ...props })
  return {
    FishLogo: Icon,
    MarkdownText: ({ text, content, children }) => h('div', { 'data-markdown': true }, text ?? content ?? children ?? ''),
    writeClipboard: async () => true,
    IconAgentPresetOutlineMedium: Icon,
    IconArchiveOutlineMedium: Icon,
    IconPersonalizationOutlineMedium: Icon,
    IconSettingsOutlineMedium: Icon,
    IconUserOutlineMedium: Icon,
    IconDownloadOutlineRegular: Icon,
    IconLoadingOutlineRegular: Icon,
    RiskConfirmation: ({ open, title, children }) => (open ? h('div', { role: 'dialog', 'aria-label': title }, children) : null),
    Button: ({ children, ...props }) => h('button', { type: 'button', ...props }, children),
    ConnectionIndicator: ({ children }) => h('div', { 'data-primitive': 'connection-indicator' }, children),
    Modal: ({ open, title, children }) => (open === false ? null : h('div', { role: 'dialog', 'aria-label': title }, children)),
    Tooltip: ({ children }) => children ?? null,
    FileTypeIcon: Icon,
    JsonBlock: ({ value }) => h('pre', null, typeof value === 'string' ? value : JSON.stringify(value ?? null)),
    fileExtension: name => (typeof name === 'string' && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''),
    fileSizeText: bytes => `${Number(bytes) || 0} B`,
    projectUserText: text => ({ text: String(text ?? ''), chips: [] }),
  }
}

// Evaluate the real built client.js bundle through window.__ModuleLoader__.load in the
// current realm so real React hooks and JSDOM nodes share one realm.
function loadBuiltClientBundle(domWindow) {
  const registrations = []
  domWindow.__ModuleLoader__ = {
    load: registration => registrations.push(registration),
  }
  const run = new Function('window', CLIENT_BUNDLE)
  run(domWindow)
  assert.equal(registrations.length, 1, 'client.js must register exactly one module')
  assert.equal(registrations[0].id, 'ds-bot')
  const primitives = makePrimitives()
  return registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react-dom') return ReactDOM
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`Unexpected platform module requested by client.js: ${specifier}`)
  })
}

const HOST_SLOTS = [
  'sidebar.workspaces',
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'sidebar.footer.action',
  'sidebar.settings',
  'sidebar.toggle.badge',
  'settings.models.sign-in',
  'shell.overlay',
  'conversation.session.header',
  'conversation.chat.text-interaction',
  'conversation.chat.node',
  'conversation.chat.turnTail',
  'deliverables.file.actions',
  'conversation.user.text.node',
  'conversation.input.permission',
  'conversation.input.plan',
  'conversation.input.model',
  'conversation.composer.dock',
  'conversation.input.left',
  'conversation.input.right',
  'conversation.composer',
  'conversation.input.dock',
]

const SESSION_SCOPED_SLOTS = new Set([
  'conversation.session.header',
  'conversation.chat.text-interaction',
  'conversation.chat.node',
  'conversation.chat.turnTail',
  'deliverables.file.actions',
  'conversation.user.text.node',
  'conversation.input.permission',
  'conversation.input.plan',
  'conversation.input.model',
  'conversation.composer.dock',
  'conversation.input.left',
  'conversation.input.right',
  'conversation.composer',
  'conversation.input.dock',
])

function sampleRosterPayload() {
  return {
    ready: true,
    revision: 1,
    modelsKey: 'm1',
    liveKey: 'l1',
    mainBotId: 'bot-main',
    mainBotIds: ['bot-main'],
    bots: [
      { id: 'bot-main', name: 'DeepSeek', role: 'Main Bot', sessionId: 'bot-main', createdAt: 1000, model: 'deepseek-chat', color: '#4d6bfe' },
      { id: 'bot-helper', name: 'Helper', role: 'Assistant', sessionId: 'bot-helper', createdAt: 2000, model: 'deepseek-chat', color: '#10b981' },
    ],
    rooms: [
      { id: 'room-1', name: 'Team Room', sessionId: 'room-1', members: ['bot-main', 'bot-helper'], createdAt: 3000 },
    ],
    agents: [],
    models: [{ ref: 'deepseek/deepseek-chat', providerName: 'DeepSeek', label: 'DeepSeek Chat' }],
    providers: [{ id: 'deepseek', name: 'DeepSeek', configured: true }],
    prefs: { theme: 'deepseek', motion: 'normal', layout: 'bubbles', effects: 'on' },
    sections: [],
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    activity: {},
    work: { bots: {}, approvals: [] },
    computerLive: {},
    memoryNews: {},
    secrets: [],
    connectors: { mail: { accounts: [] }, connectors: [] },
    capabilityStatuses: {},
    browser: false,
  }
}

function installDomGlobals(t, { statePayload = sampleRosterPayload(), dsBotApp } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>DSH</title></head><body><div data-frame><div id="root"></div></div></body></html>',
    { url: 'http://localhost:3000/' },
  )
  const win = dom.window
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  win.requestAnimationFrame = () => 0
  win.cancelAnimationFrame = () => {}

  const apiCalls = []
  const fetchMock = async (url, init) => {
    let body = {}
    try { body = JSON.parse(init?.body ?? '{}') } catch {}
    const endpoint = typeof url === 'string' && url.includes('api/bot') ? (body.endpoint ?? '') : ''
    if (endpoint) apiCalls.push({ endpoint, payload: body.payload })
    let value = {}
    if (endpoint === 'state') value = statePayload
    else if (endpoint === 'update-check') value = { available: false, phase: 'idle' }
    else if (endpoint === 'changes-check') value = false
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, value }),
      text: async () => JSON.stringify({ ok: true, value }),
    }
  }

  const keys = [
    'window', 'document', 'localStorage', 'sessionStorage', 'navigator',
    'MutationObserver', 'ResizeObserver', 'HTMLElement', 'SVGElement', 'Element', 'Node',
    'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMParser', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', 'dsBotApp',
  ]
  const saved = new Map()
  for (const key of keys) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const values = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    navigator: win.navigator,
    MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver,
    HTMLElement: win.HTMLElement,
    SVGElement: win.SVGElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    DOMParser: win.DOMParser,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    fetch: fetchMock,
    IS_REACT_ACT_ENVIRONMENT: true,
    dsBotApp,
  }
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  let domDisposed = false
  const dispose = () => {
    if (domDisposed) return
    domDisposed = true
    for (const [key, desc] of saved) {
      if (desc === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, desc)
    }
    dom.window.close()
  }

  return { dom, window: win, document: win.document, apiCalls, dispose }
}

// Build a strict Cordis host whose services are all provided from sibling plugin fibers,
// matching real DSH Desktop/Web service isolation and inject enforcement.
async function createStrictClientHost(t, {
  splitDotted = true,
  provideDottedSessionStatus = splitDotted,
  provideDottedSidebarMounted = splitDotted,
  activeLocale = 'en',
} = {}) {
  const root = new Context()
  const calls = {
    openedSessions: [],
    openedTabs: [],
    openedResources: [],
    reconnected: 0,
    trackedAnalytics: [],
    shortcutsRegistered: [],
    triggersRegistered: [],
    commandsRegistered: [],
    themeOverrides: [],
    fiberErrors: [],
  }

  // Capture failed child fibers (`FiberState.FAILED === 3`) and Cordis logger errors so
  // errors inside child `ctx.inject(...)` scopes can never be silently swallowed.
  root.on('internal/status', (fiber) => {
    if (fiber?.state === 3 || fiber?._error) {
      calls.fiberErrors.push({
        source: 'status',
        name: fiber.name,
        message: fiber._error instanceof Error ? fiber._error.message : String(fiber._error ?? 'failed'),
      })
    }
  })
  root.logger.exporter({
    export: (message) => {
      if (message?.type === 'error') {
        calls.fiberErrors.push({
          source: 'logger',
          name: message.name,
          message: message.args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '),
        })
      }
    },
  })

  const sessionList = observable({
    ids: ['bot-main', 'bot-helper', 'room-1'],
    byId: {
      'bot-main': { id: 'bot-main', title: 'DeepSeek', retainedBy: { mainView: 1 }, updatedAt: 1000, running: false },
      'bot-helper': { id: 'bot-helper', title: 'Helper', retainedBy: {}, updatedAt: 2000, running: false },
      'room-1': { id: 'room-1', title: 'Team Room', retainedBy: {}, updatedAt: 3000, running: false },
    },
  })
  const sessionStatusStore = observable(new Map([
    ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ]))
  const connectionStateStore = observable('connected')
  const shortcutsCatalogStore = observable([
    { id: 'settings.open', label: 'Open settings', binding: { code: 'Comma', modifiers: ['primary'] }, keys: ['⌘', ','] },
  ])
  const sidebarRightMountedStore = observable(true)
  const workspacesListStore = observable({ items: [{ workspaceId: 'ws-1', sessionIds: ['bot-main', 'bot-helper'] }] })

  const chatSnapshots = new Map()
  const makeSessionBinding = (sessionId) => {
    const turnData = observable([])
    const chatTarget = observable({
      timeline: { turns: new Map() },
      nodes: {
        turnDataSource: () => turnData,
        source: () => observable(null),
      },
    })
    const openTurn = observable(undefined)
    chatSnapshots.set(sessionId, { chatTarget, openTurn })
    return {
      sessionId,
      ctx: root,
      session: {
        id: sessionId,
        getSnapshot: () => ({ id: sessionId, running: false, queue: [] }),
        subscribe: () => () => {},
        updateQueue: async () => ({ ok: true }),
      },
    }
  }
  const bindings = new Map([
    ['bot-main', makeSessionBinding('bot-main')],
    ['bot-helper', makeSessionBinding('bot-helper')],
    ['room-1', makeSessionBinding('room-1')],
  ])

  // Real Cordis Service subclasses provided from independent sibling plugin fibers.
  class MockSessionsService extends Service {
    constructor(ctx) {
      super(ctx, 'sessions')
      this.list = sessionList
    }
    binding(id) { return bindings.get(id) }
    refresh() { return Promise.resolve() }
    refreshProjections() { return Promise.resolve() }
    retainInfo() { return observable({ mainView: 1 }) }
  }

  class MockUiWorkspaceService extends Service {
    constructor(ctx) { super(ctx, 'uiWorkspace') }
    openSession(id) { calls.openedSessions.push(id) }
  }

  class MockUiConversationService extends Service {
    constructor(ctx) {
      super(ctx, 'uiConversation')
      this.userText = { register: () => () => {} }
    }
    binding(b) {
      const entry = chatSnapshots.get(b.sessionId)
      return {
        target: () => entry.chatTarget,
        openTurn: entry.openTurn,
      }
    }
    imageUrl(_sessionId, attachment) { return `blob:mock/${attachment?.id ?? 'img'}` }
  }

  class MockUiSessionService extends Service {
    constructor(ctx) {
      super(ctx, 'uiSession')
      if (!splitDotted) {
        this.sessionStatus = sessionStatusStore
      }
    }
  }

  class MockSlotsService extends Service {
    constructor(ctx) {
      super(ctx, 'slots')
      this._state = {
        declared: new Map(HOST_SLOTS.map(name => [name, { kind: 'list', scope: SESSION_SCOPED_SLOTS.has(name) ? 'session' : 'root' }])),
        entries: new Map(),
        waits: new Set(),
        listeners: new Set(),
        version: 0,
      }
    }
    _bump(slotName) {
      const state = this._state
      state.version += 1
      queueMicrotask(() => {
        for (const entry of Array.from(state.listeners)) {
          if (entry.slotName === undefined || slotName === undefined || entry.slotName === slotName) {
            entry.listener()
          }
        }
      })
    }
    _activateWait(wait) {
      const state = this._state
      if (wait.stopped || wait.active || !state.declared.has(wait.name)) return
      wait.active = true
      const offs = []
      try {
        const res = wait.setup()
        if (typeof res === 'function') offs.push(res)
        else if (res && typeof res[Symbol.iterator] === 'function') {
          for (const off of res) offs.push(off)
        }
      } catch (error) {
        wait.active = false
        for (const off of offs.reverse()) off?.()
        throw error
      }
      wait.off = () => {
        wait.active = false
        for (const off of offs.reverse()) off?.()
      }
    }
    spec(name) { return this._state.declared.get(name) }
    entries(name) { return [...(this._state.entries.get(name) ?? [])] }
    allEntries() {
      const out = []
      for (const list of this._state.entries.values()) out.push(...list)
      return out
    }
    getVersion() { return this._state.version }
    subscribe(nameOrListener, maybeListener) {
      const entry = typeof nameOrListener === 'function'
        ? { slotName: undefined, listener: nameOrListener }
        : { slotName: nameOrListener, listener: maybeListener }
      this._state.listeners.add(entry)
      return () => { this._state.listeners.delete(entry) }
    }
    register(options, component) {
      const state = this._state
      const { name, children = {} } = options
      if (!state.declared.has(name)) throw new Error(`undeclared slot: ${name}`)
      const record = { options, component }
      const list = state.entries.get(name) ?? []
      list.push(record)
      state.entries.set(name, list)
      const declaredChildren = []
      for (const [child, spec] of Object.entries(children)) {
        if (state.declared.has(child)) throw new Error(`duplicate slot declaration: ${child}`)
        state.declared.set(child, spec)
        declaredChildren.push(child)
      }
      for (const wait of Array.from(state.waits)) this._activateWait(wait)
      this._bump(name)
      return () => {
        const arr = state.entries.get(name)
        if (arr) {
          const idx = arr.indexOf(record)
          if (idx >= 0) arr.splice(idx, 1)
        }
        for (const child of declaredChildren) state.declared.delete(child)
        this._bump(name)
      }
    }
    inject(name, setup) {
      const wait = { name, setup, active: false, stopped: false, off: null }
      this._state.waits.add(wait)
      this._activateWait(wait)
      return () => {
        wait.stopped = true
        wait.off?.()
        this._state.waits.delete(wait)
      }
    }
  }

  class MockThemeService extends Service {
    constructor(ctx) { super(ctx, 'theme') }
    overrideTokens(id, tokens) {
      calls.themeOverrides.push({ id, count: Object.keys(tokens ?? {}).length })
      return () => {}
    }
  }

  class MockLayoutService extends Service {
    constructor(ctx) { super(ctx, 'layout') }
    selectPanel() {}
    toggleSidebar() {}
  }

  class MockLocaleService extends Service {
    constructor(ctx) {
      super(ctx, 'locale')
      this._source = observable({ active: activeLocale, locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }] })
      this._dicts = new Map()
    }
    getSnapshot() { return this._source.getSnapshot() }
    subscribe(listener) { return this._source.subscribe(listener) }
    getLocale() { return this._source.getSnapshot() }
    setLocale(next) { this._source.set(prev => ({ ...prev, active: next })) }
    register(ns, langId, dict) {
      const key = String(langId).toLowerCase()
      let map = this._dicts.get(ns)
      if (!map) {
        map = new Map()
        this._dicts.set(ns, map)
      }
      map.set(key, dict)
      return () => {
        if (map.get(key) === dict) map.delete(key)
      }
    }
    bind(ns) {
      return (key, params) => {
        const active = String(this._source.getSnapshot().active ?? 'en').toLowerCase()
        const map = this._dicts.get(ns)
        const raw = map?.get(active)?.[key] ?? (ns === 'ds-bot' ? key : `${ns}:${key}`)
        if (!params || typeof raw !== 'string') return raw
        return raw.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`))
      }
    }
    resolveText(text) { return typeof text === 'string' ? text : String(text ?? '') }
  }

  class MockConnectionService extends Service {
    constructor(ctx) {
      super(ctx, 'connection')
      if (!splitDotted) {
        this.state = connectionStateStore
        this.reconnect = () => { calls.reconnected += 1 }
      }
    }
  }

  class MockShortcutsService extends Service {
    constructor(ctx) {
      super(ctx, 'shortcuts')
      if (!splitDotted) this.catalog = shortcutsCatalogStore
    }
    register(command) {
      calls.shortcutsRegistered.push(command.id)
      return () => {}
    }
  }

  class MockSidebarRightService extends Service {
    constructor(ctx) {
      super(ctx, 'sidebarRight')
      if (!splitDotted) {
        this.mounted = sidebarRightMountedStore
        this.openTab = (kind, options) => { calls.openedTabs.push({ kind, options }) }
        this.isExpanded = () => false
        this.toggleExpanded = () => {}
      }
    }
    openResource(uri) { calls.openedResources.push(uri) }
  }

  class MockSidebarRightTabsService extends Service {
    constructor(ctx) {
      super(ctx, 'sidebarRightTabs')
      this._tabs = new Map([['terminal', { id: 'terminal' }], ['files', { id: 'files' }], ['browser', { id: 'browser' }]])
    }
    get(id) { return this._tabs.get(id) }
    subscribe() { return () => {} }
  }

  class MockWorkspacesService extends Service {
    constructor(ctx) {
      super(ctx, 'workspaces')
      if (!splitDotted) this.list = workspacesListStore
    }
  }

  class MockInputTriggersService extends Service {
    constructor(ctx) { super(ctx, 'inputTriggers') }
    registerSource(source) { calls.triggersRegistered.push(source.id ?? 'source'); return () => {} }
    sessionOf() { return { launcher: observable(null), toggleSource() {} } }
  }

  class MockCommandUiService extends Service {
    constructor(ctx) { super(ctx, 'commandUi') }
    register(entry) { calls.commandsRegistered.push(entry.id ?? entry.name ?? 'cmd'); return () => {} }
    decorate() { return () => {} }
  }

  class MockModulesService extends Service {
    constructor(ctx) {
      super(ctx, 'modules')
      this.entries = { releaseChange: observable(null), dismissRelease() {} }
    }
  }

  class MockConfigFormsService extends Service {
    constructor(ctx) {
      super(ctx, 'configForms')
      const formStore = observable({ status: 'ready', writable: true, value: {} })
      this._form = { ...formStore, set: async () => true }
      this._describe = observable({ status: 'ready', error: null, view: { writable: true, hasDocument: false, namespaces: [] } })
      this.developerTools = { enabled: observable(false), setEnabled: async () => {} }
    }
    get() { return this._form }
    describe() { return this._describe }
  }

  class MockSettingsSchemaService extends Service {
    constructor(ctx) { super(ctx, 'settingsSchema') }
    rehydrate(wire) { return wire }
    nodeAtPath() { return undefined }
  }

  class MockRemoteService extends Service {
    constructor(ctx) {
      super(ctx, 'remote')
      this.$host = { isLoopback: true }
    }
    $on() { return () => {} }
  }

  class MockConversationService extends Service {
    constructor(ctx) { super(ctx, 'conversation') }
    resolveDraftAttachments() { return [] }
    createDrafts() { return [] }
    releaseDraftAttachment() {}
  }

  class MockChatFileMentionsService extends Service {
    constructor(ctx) { super(ctx, 'chatFileMentions') }
    forClosing() { return () => null }
  }

  class MockProductAnalyticsService extends Service {
    constructor(ctx) { super(ctx, 'productAnalytics') }
    track(event, props) { calls.trackedAnalytics.push({ event, props }) }
  }

  // Register every service in its own sibling plugin fiber.
  const providers = [
    MockSessionsService,
    MockUiWorkspaceService,
    MockUiConversationService,
    MockUiSessionService,
    MockSlotsService,
    MockThemeService,
    MockLayoutService,
    MockLocaleService,
    MockConnectionService,
    MockShortcutsService,
    MockSidebarRightService,
    MockSidebarRightTabsService,
    MockWorkspacesService,
    MockInputTriggersService,
    MockCommandUiService,
    MockModulesService,
    MockConfigFormsService,
    MockSettingsSchemaService,
    MockRemoteService,
    MockConversationService,
    MockChatFileMentionsService,
    MockProductAnalyticsService,
  ]
  for (const Provider of providers) {
    await root.plugin(Provider)
  }

  // Dotted remote sub-services (always dotted in real DSH).
  await root.plugin({
    name: 'host:remote-subservices',
    apply(c) {
      c.provide('remote.settings', { openSettingsDocument: async () => ({ ok: true }) })
      c.provide('remote.permissionPresets', { catalog: async () => ({ ok: true, value: { defaultPreset: 'workspace-write', defaultOptions: [] } }) })
    },
  })

  // Dotted sub-services matching DSH 0.2.3-alpha.2+ / #2383 / #2384.
  let sessionStatusFiber = null
  const mountSessionStatus = async (store = sessionStatusStore) => {
    if (sessionStatusFiber) {
      await sessionStatusFiber.dispose()
      sessionStatusFiber = null
    }
    sessionStatusFiber = await root.plugin({
      name: 'host:uiSession.sessionStatus',
      apply(c) { c.provide('uiSession.sessionStatus', store) },
    })
    return sessionStatusFiber
  }
  const unmountSessionStatus = async () => {
    if (!sessionStatusFiber) return
    const f = sessionStatusFiber
    sessionStatusFiber = null
    await f.dispose()
  }
  if (provideDottedSessionStatus) {
    await mountSessionStatus(sessionStatusStore)
  }

  let sidebarMountedFiber = null
  const mountSidebarRightMounted = async (store = sidebarRightMountedStore) => {
    if (sidebarMountedFiber) {
      await sidebarMountedFiber.dispose()
      sidebarMountedFiber = null
    }
    sidebarMountedFiber = await root.plugin({
      name: 'host:sidebarRight.mounted',
      apply(c) { c.provide('sidebarRight.mounted', store) },
    })
    return sidebarMountedFiber
  }
  const unmountSidebarRightMounted = async () => {
    if (!sidebarMountedFiber) return
    const f = sidebarMountedFiber
    sidebarMountedFiber = null
    await f.dispose()
  }
  if (provideDottedSidebarMounted) {
    await mountSidebarRightMounted(sidebarRightMountedStore)
  }

  if (splitDotted) {
    await root.plugin({
      name: 'host:dotted-subservices',
      apply(c) {
        c.provide('connection.state', connectionStateStore)
        c.provide('connection.reconnect', () => { calls.reconnected += 1 })
        c.provide('shortcuts.catalog', shortcutsCatalogStore)
        c.provide('sidebarRight.openTab', (kind, options) => { calls.openedTabs.push({ kind, options }) })
        c.provide('sidebarRight.isExpanded', () => false)
        c.provide('sidebarRight.toggleExpanded', () => {})
        c.provide('workspaces.list', workspacesListStore)
      },
    })
  }

  t.after(async () => { await root.fiber.dispose() })

  return {
    root,
    calls,
    slots: root.get('slots'),
    sessionList,
    sessionStatusStore,
    sidebarRightMountedStore,
    connectionStateStore,
    shortcutsCatalogStore,
    mountSessionStatus,
    unmountSessionStatus,
    mountSidebarRightMounted,
    unmountSidebarRightMounted,
  }
}

// Mount a React component inside JSDOM using real React 19 createRoot + act and unmount cleanly.
// Captures both direct container markup and portals rendered into `document.body`.
function renderInDom(document, Component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const renderErrors = []
  const root = createRoot(container, {
    onCaughtError: err => renderErrors.push(err),
    onUncaughtError: err => renderErrors.push(err),
  })
  let html = ''
  try {
    act(() => {
      root.render(h(Component, props))
    })
    html = document.body.innerHTML
  } finally {
    act(() => { root.unmount() })
    container.remove()
  }
  if (renderErrors.length > 0) throw renderErrors[0]
  return html
}

function buildSlotProps(host, entry, { sessionId = 'bot-main', extra = {} } = {}) {
  const injected = typeof entry.options.inject === 'function'
    ? (SESSION_SCOPED_SLOTS.has(entry.options.name) ? entry.options.inject(sessionId) : entry.options.inject())
    : {}
  const retainInfoSources = new Map()
  const retainInfoOf = (key) => {
    if (!retainInfoSources.has(key)) {
      retainInfoSources.set(key, observable({ mainView: key === 'bot-main' ? 1 : 0 }))
    }
    return retainInfoSources.get(key)
  }
  const accessSource = observable({ allowed: true })
  const props = {
    wide: true,
    sessionId,
    renderSlot: () => null,
    t: key => key,
    useSessions: makeSelectorHook(host.sessionList),
    useSession: makeSelectorHook(observable({ id: sessionId, running: false, queue: [] })),
    useSessionStatus: makeSelectorHook(host.sessionStatusStore),
    useSessionRetainInfo: makeKeyedSelectorHook(retainInfoOf),
    useSessionAccess: makeKeyedSelectorHook(() => accessSource),
    ...injected,
    ...extra,
  }
  for (const [name, source] of Object.entries(injected?.hooks ?? {})) {
    props[hookPropName(name)] = makeSelectorHook(source)
  }
  for (const [name, resolver] of Object.entries(injected?.keyedHooks ?? {})) {
    props[hookPropName(name)] = makeKeyedSelectorHook(resolver)
  }
  return { injected, props }
}

test('strict Cordis host faithfully reproduces #2383 / #2384 when reading undeclared dotted services', async (t) => {
  const host = await createStrictClientHost(t, { splitDotted: true })

  // Exact failure mode of ds-bot 0.4.0 (#2383 / #2384): reading `ctx.get('uiSession')?.sessionStatus`
  // inside a plugin that did not inject `uiSession.sessionStatus`.
  await assert.rejects(
    async () => {
      await host.root.plugin({
        name: 'repro-2383',
        inject: ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout'],
        apply(ctx) {
          ctx.effect(() => {
            void ctx.get('uiSession')?.sessionStatus
          }, 'repro: sessionStatus')
        },
      })
    },
    /cannot get property "uiSession\.sessionStatus" without inject/,
  )

  // Verify the same strict error fires for latent dotted sub-services too.
  for (const [serviceName, propName] of [
    ['connection', 'state'],
    ['shortcuts', 'catalog'],
    ['sidebarRight', 'openTab'],
    ['workspaces', 'list'],
  ]) {
    await assert.rejects(
      async () => {
        await host.root.plugin({
          name: `repro-${serviceName}-${propName}`,
          inject: [],
          apply(ctx) {
            void ctx.get(serviceName)?.[propName]
          },
        })
      },
      new RegExp(`cannot get property "${serviceName}\\.${propName}" without inject`),
    )
  }

  // Self-verify that a throwing child `ctx.inject(...)` fiber is captured in `calls.fiberErrors`
  // rather than silently swallowed.
  const beforeCount = host.calls.fiberErrors.length
  const parentFiber = await host.root.plugin({
    name: 'repro-child-inject-failure',
    inject: [],
    apply(ctx) {
      ctx.inject(['shortcuts'], () => {
        throw new Error('child-inject-boom')
      })
    },
  })
  await delay(20)
  assert.ok(
    host.calls.fiberErrors.slice(beforeCount).some(entry => /child-inject-boom/.test(entry.message)),
    'failing child ctx.inject fiber must be captured in host.calls.fiberErrors',
  )
  await parentFiber.dispose()
})

test('regression guard: removing uiSession from built client.js inject must fail mount', async (t) => {
  const domEnv = installDomGlobals(t)
  const built = loadBuiltClientBundle(domEnv.window)
  assert.ok(built.inject.includes('uiSession'), 'built client.js must declare uiSession in inject')

  try {
    for (const splitDotted of [false, true]) {
      const host = await createStrictClientHost(t, { splitDotted })
      const withoutUiSession = {
        name: 'ds-bot-missing-uiSession',
        inject: built.inject.filter(name => name !== 'uiSession'),
        apply: built.apply,
      }
      await assert.rejects(
        async () => { await host.root.plugin(withoutUiSession) },
        /cannot get property "uiSession" without inject/,
        `stripping uiSession from inject must fail when splitDotted=${splitDotted}`,
      )
      await host.root.fiber.dispose()
    }
  } finally {
    domEnv.dispose()
  }
})

test('built client.js mounts cleanly on strict split-service DSH host (#2383/#2384), exercises all slots and renders key UI', async (t) => {
  const domEnv = installDomGlobals(t)
  const { window, document } = domEnv
  const host = await createStrictClientHost(t, { splitDotted: true })
  try {
    const built = loadBuiltClientBundle(window)

    const fiber = await host.root.plugin({
      name: 'ds-bot',
      inject: built.inject,
      apply: built.apply,
    })
    // Allow initial roster pull + child inject fibers to settle.
    await delay(40)
    assert.deepEqual(host.calls.fiberErrors, [], 'no child fiber errors should occur on mount')

  // Core shell, settings, overlay, sidebar, and conversation slots must all be mounted.
  const requiredSlots = [
    'sidebar.workspaces',
    'sidebar.brand.mark',
    'sidebar.brand.name',
    'sidebar.footer.action',
    'sidebar.settings',
    'settings.trigger',
    'settings.launcher',
    'shell.overlay',
    'conversation.session.header',
    'conversation.chat.node',
    'conversation.chat.turnTail',
    'conversation.composer',
    'conversation.input.left',
    'conversation.input.right',
    'conversation.input.dock',
  ]
  for (const slotName of requiredSlots) {
    assert.ok(host.slots.entries(slotName).length > 0, `expected ds-bot entry in slot "${slotName}"`)
  }

  // Exercise EVERY registered slot's inject() callback and every returned observable hook.
  const allEntries = host.slots.allEntries()
  assert.ok(allEntries.length >= 25, `expected full set of registered slot entries, got ${allEntries.length}`)
  for (const entry of allEntries) {
    const { injected } = buildSlotProps(host, entry, { sessionId: 'bot-main' })
    for (const source of Object.values(injected?.hooks ?? {})) {
      if (typeof source?.getSnapshot === 'function') source.getSnapshot()
      if (typeof source?.subscribe === 'function') {
        const off = source.subscribe(() => {})
        off?.()
      }
    }
  }

  // Exercise lazy service-reading actions from sidebar & settings shell under strict dotted services.
  const sidebarEntry = host.slots.entries('sidebar.workspaces')[0]
  const sidebarInject = sidebarEntry.options.inject()
  const { actions, hooks } = sidebarInject
  assert.equal(hooks.ui.getSnapshot().toast, null, 'no surface setup error toast should be recorded on boot')
  assert.equal(hooks.roster.getSnapshot().ready, true, 'roster should hydrate from initial state pull')

  assert.equal(actions.canOpenTerminal(), true)
  assert.equal(actions.canOpenFiles(), true)
  actions.newTerminal()
  actions.openFiles()
  assert.deepEqual(host.calls.openedTabs.map(c => c.kind), ['terminal', 'files'])
  assert.equal(typeof actions.accountT(), 'function')
  assert.equal(actions.signInEntry(), null)
  assert.equal(actions.voiceSetup('deepseek'), null)
  assert.deepEqual(actions.draftFiles([]), [])
  assert.deepEqual(actions.restoreDraftFiles('bot-main', []), [])
  actions.releaseDraftFiles([])
  assert.equal(actions.closingReply('bot-main', 1), undefined)
  assert.ok(actions.turnFacts('bot-main'))
  const offTurns = actions.watchTurns('bot-main', () => {})
  offTurns()

  const settingsEntry = host.slots.entries('sidebar.settings')[0]
  const settingsInject = settingsEntry.options.inject()
  assert.equal(settingsInject.hooks.connectionState.getSnapshot(), 'connected')
  assert.equal(settingsInject.hooks.settingsShortcut.getSnapshot()?.id, 'settings.open')
  settingsInject.reconnect()
  assert.equal(host.calls.reconnected, 1)
  assert.equal(settingsInject.preferences.browser.getSnapshot(), true)
  const permCatalog = await settingsInject.preferences.permissionCatalog()
  assert.equal(permCatalog.ok, true)
  const offPerm = settingsInject.preferences.subscribePermission(() => {})
  offPerm()

  // Live dotted `uiSession.sessionStatus` updates must reach `botCompletions`.
  host.sessionStatusStore.set(new Map([
    ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ]))
  assert.equal(hooks.botCompletions.getSnapshot()['bot-helper'], true, 'dotted uiSession.sessionStatus updates must propagate to botCompletions')

  // Render key first-screen & modal/settings UI surfaces with real React 19 in JSDOM.
  const findEntry = (slot, match = () => true) => {
    const found = host.slots.entries(slot).find(match)
    assert.ok(found, `missing entry in slot "${slot}"`)
    return found
  }

  // 1. Sidebar & shell header/footer
  const sidebarHtml = renderInDom(document, sidebarEntry.component, buildSlotProps(host, sidebarEntry).props)
  assert.match(sidebarHtml, /DeepSeek/, 'TeamSidebar should render the Main Bot')
  for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name', 'settings.trigger', 'settings.launcher']) {
    const entry = findEntry(slot)
    renderInDom(document, entry.component, buildSlotProps(host, entry).props)
  }
  for (const id of ['bot-account', 'bot-return']) {
    const entry = findEntry('sidebar.footer.action', e => e.options.id === id)
    renderInDom(document, entry.component, buildSlotProps(host, entry).props)
  }

  // 2. Chat view (header, chat nodes, turn tails, composer controls, docks)
  const headerEntry = findEntry('conversation.session.header')
  const headerHtml = renderInDom(document, headerEntry.component, buildSlotProps(host, headerEntry).props)
  assert.match(headerHtml, /DeepSeek/, 'HeaderPill should render active Bot name')

  const turnDataHook = makeKeyedSelectorHook(() => observable(null))
  for (const key of ['assistant-step', 'turn-trigger', 'tool-call', 'turn-process', 'turn-error', 'compaction', 'context']) {
    const entry = findEntry('conversation.chat.node', e => e.options.key === key)
    const { props } = buildSlotProps(host, entry, {
      extra: {
        useTurnData: turnDataHook,
        node: {
          key: `${key}:1`,
          kind: key,
          turn: 1,
          seq: 1,
          data: {
            turn: 1,
            seq: 1,
            status: 'settled',
            blocks: [{ kind: 'text', text: 'Hello from smoke test' }],
            text: 'Hello from smoke test',
            root: { turn: 1, callId: 'c1', kind: 'tool-result', name: 'bash', args: {}, children: [] },
            calls: [],
            error: { message: 'Temporary error' },
          },
        },
        turn: 1,
      },
    })
    const cellHtml = renderInDom(document, entry.component, props)
    if (key === 'assistant-step') assert.match(cellHtml, /Hello from smoke test/, 'AssistantCell should render assistant text')
  }
  for (const id of ['bot-turn-separators', 'bot-btw', 'bot-learning']) {
    const entry = findEntry('conversation.chat.turnTail', e => e.options.id === id)
    renderInDom(document, entry.component, buildSlotProps(host, entry, {
      extra: { turn: { turn: 1, end: { time: 1000, seq: 1 } } },
    }).props)
  }
  const inputHook = makeSelectorHook(observable({ phase: 'plain', occurrences: [], draft: '', text: '', empty: true, attachmentIds: [], queue: [] }))
  const inputActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: () => true,
    setDraft: () => {},
    submit: () => {},
    addFiles: () => {},
    intakeFiles: () => {},
  }
  for (const id of ['bot-plus', 'bot-draft', 'bot-paste']) {
    const entry = findEntry('conversation.input.left', e => e.options.id === id)
    renderInDom(document, entry.component, buildSlotProps(host, entry, {
      extra: { useInput: inputHook, inputActions },
    }).props)
  }
  const voiceEntry = findEntry('conversation.input.right', e => e.options.id === 'bot-voice')
  renderInDom(document, voiceEntry.component, buildSlotProps(host, voiceEntry, {
    extra: { useInput: inputHook, inputActions },
  }).props)

  const questionEntry = findEntry('conversation.composer')
  assert.equal(questionEntry.options.select({ pendingInteraction: { kind: 'question', key: 'q1' } })?.key, 'q1')
  assert.equal(questionEntry.options.select({ pendingInteraction: { kind: 'approval', key: 'a1' } }), null)

  const queueEntry = findEntry('conversation.input.dock', e => e.options.id === 'queue')
  renderInDom(document, queueEntry.component, buildSlotProps(host, queueEntry, {
    extra: {
      useProjection: makeKeyedSelectorHook(() => observable(undefined)),
      renderFactorySlot: () => null,
    },
  }).props)

  // 3. Settings shell (closed, then opened to General page)
  renderInDom(document, settingsEntry.component, buildSlotProps(host, settingsEntry).props)
  actions.openSettings('general')
  const openSettingsHtml = renderInDom(document, settingsEntry.component, buildSlotProps(host, settingsEntry).props)
  assert.ok(openSettingsHtml.length > 0, 'SettingsShell should render when settings dialog is open')
  actions.closeSettings()

    // 4. Overlays & Modals
    const overlayEntry = findEntry('shell.overlay', e => e.options.id === 'bot')
    renderInDom(document, overlayEntry.component, buildSlotProps(host, overlayEntry).props)
    actions.notice('Smoke toast')
    const toastEntry = findEntry('shell.overlay', e => e.options.id === 'bot-toast')
    const toastHtml = renderInDom(document, toastEntry.component, buildSlotProps(host, toastEntry).props)
    assert.match(toastHtml, /Smoke toast/, 'ErrorToast should render active toast message')
    for (const id of ['bot-computer', 'bot-signin']) {
      const entry = findEntry('shell.overlay', e => e.options.id === id)
      renderInDom(document, entry.component, buildSlotProps(host, entry).props)
    }

    assert.deepEqual(host.calls.fiberErrors, [], 'no child fiber errors should occur during slot execution or rendering')
    await fiber.dispose()
    assert.deepEqual(host.calls.fiberErrors, [], 'no child fiber errors should occur during dispose')
  } finally {
    await host.root.fiber.dispose()
    domEnv.dispose()
  }
})

test('built client.js also activates cleanly on DSH 0.2.2-rc.5 host without dotted uiSession.sessionStatus and handles late arrival, reload, and dispose', async (t) => {
  // 1. Pinned 0.2.2-rc.5 host: uiSession exposes plain `.sessionStatus`, no dotted service exists.
  {
    const domEnv = installDomGlobals(t)
    const host = await createStrictClientHost(t, { splitDotted: false })
    try {
      const built = loadBuiltClientBundle(domEnv.window)

      const fiber = await host.root.plugin({
        name: 'ds-bot',
        inject: built.inject,
        apply: built.apply,
      })
      await delay(40)
      assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors on 0.2.2-rc.5 host mount')

      const sidebarEntry = host.slots.entries('sidebar.workspaces')[0]
      assert.ok(sidebarEntry, 'ds-bot must activate on DSH 0.2.2-rc.5 where uiSession.sessionStatus is not a separate service')
      const { hooks } = sidebarEntry.options.inject()
      assert.equal(hooks.ui.getSnapshot().toast, null)

      host.sessionStatusStore.set(new Map([
        ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
        ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: true }],
      ]))
      assert.equal(hooks.botCompletions.getSnapshot()['bot-helper'], true, 'plain uiSession.sessionStatus updates must propagate')

      const html = renderInDom(domEnv.document, sidebarEntry.component, buildSlotProps(host, sidebarEntry).props)
      assert.match(html, /DeepSeek/)
      await fiber.dispose()
      assert.equal(host.sessionStatusStore.listenerCount(), 0, 'plain sessionStatus listeners must drop to zero on dispose')
      assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors on 0.2.2-rc.5 host dispose')
    } finally {
      await host.root.fiber.dispose()
      domEnv.dispose()
    }
  }

  // 2. Late-arriving dotted `uiSession.sessionStatus` + unload/remount with a new observable +
  //    reactive dotted `sidebarRight.mounted` late arrival/reload + listener cleanup on dispose.
  {
    const domEnv = installDomGlobals(t)
    const host = await createStrictClientHost(t, {
      splitDotted: true,
      provideDottedSessionStatus: false,
      provideDottedSidebarMounted: false,
    })
    try {
      const built = loadBuiltClientBundle(domEnv.window)

      const fiber = await host.root.plugin({
        name: 'ds-bot',
        inject: built.inject,
        apply: built.apply,
      })
      await delay(40)
      assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors before late dotted services arrive')

      const sidebarEntry = host.slots.entries('sidebar.workspaces')[0]
      assert.ok(sidebarEntry, 'ds-bot must still activate before late uiSession.sessionStatus arrives')
      const { hooks } = sidebarEntry.options.inject()

      // Provide first dotted sessionStatus store late and verify propagation.
      await host.mountSessionStatus(host.sessionStatusStore)
      await delay(20)
      assert.ok(host.sessionStatusStore.listenerCount() > 0, 'first dotted sessionStatus should be subscribed')
      host.sessionStatusStore.set(new Map([
        ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
        ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: true }],
      ]))
      assert.equal(hooks.botCompletions.getSnapshot()['bot-helper'], true, 'late-arriving dotted uiSession.sessionStatus must bind reactively')

      // Unload the first dotted sessionStatus and remount a brand new observable.
      await host.unmountSessionStatus()
      await delay(20)
      assert.equal(host.sessionStatusStore.listenerCount(), 0, 'old dotted sessionStatus listeners must drop to zero on unload')

      const replacementStatus = observable(new Map([
        ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
        ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: false }],
      ]))
      await host.mountSessionStatus(replacementStatus)
      await delay(20)
      assert.ok(replacementStatus.listenerCount() > 0, 'replacement dotted sessionStatus should be subscribed')
      replacementStatus.set(new Map([
        ['bot-main', { running: false, pendingInteraction: undefined, completionUnread: false }],
        ['bot-helper', { running: false, pendingInteraction: undefined, completionUnread: true }],
      ]))
      assert.equal(hooks.botCompletions.getSnapshot()['bot-helper'], true, 'remounted dotted uiSession.sessionStatus must propagate updates')

      // Late arrival and reload of dotted `sidebarRight.mounted`.
      await host.mountSidebarRightMounted(host.sidebarRightMountedStore)
      await delay(20)
      assert.equal(host.sidebarRightMountedStore.listenerCount(), 1, 'late-arriving dotted sidebarRight.mounted must subscribe reactively')
      const replacementMounted = observable(true)
      await host.mountSidebarRightMounted(replacementMounted)
      await delay(20)
      assert.equal(host.sidebarRightMountedStore.listenerCount(), 0, 'old sidebarRight.mounted listener must clean up on reload')
      assert.equal(replacementMounted.listenerCount(), 1, 'reloaded sidebarRight.mounted must subscribe')

      await fiber.dispose()
      assert.equal(host.sessionStatusStore.listenerCount(), 0, 'original sessionStatus must have zero listeners after plugin dispose')
      assert.equal(replacementStatus.listenerCount(), 0, 'replacement sessionStatus must have zero listeners after plugin dispose')
      assert.equal(replacementMounted.listenerCount(), 0, 'replacement sidebarRight.mounted must have zero listeners after plugin dispose')
      assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors across late arrival, reload, and dispose')
    } finally {
      await host.root.fiber.dispose()
      domEnv.dispose()
    }
  }
})

test('createSessionStatusSource is a no-op after dispose', async () => {
  const { createSessionStatusSource } = await import('../src/client/host-service.js')
  const plainStatus = observable(new Map([['s1', { running: true }]]))
  const ctx = {
    uiSession: { sessionStatus: plainStatus },
    reflect: { props: {} },
  }
  const bridge = createSessionStatusSource(ctx)
  let fired = 0
  const unsub = bridge.source.subscribe(() => { fired += 1 })
  assert.equal(plainStatus.listenerCount(), 1)
  assert.equal(bridge.source.getSnapshot().get('s1')?.running, true)

  bridge.dispose()
  assert.equal(plainStatus.listenerCount(), 0, 'dispose must detach active source listener')
  assert.equal(bridge.source.getSnapshot().size, 0, 'getSnapshot after dispose must return empty map')

  // Subscribing or emitting after dispose must remain a strict no-op.
  const lateUnsub = bridge.source.subscribe(() => { fired += 1 })
  plainStatus.set(new Map([['s1', { running: false }]]))
  assert.equal(fired, 0, 'no listeners may fire after dispose')
  assert.equal(plainStatus.listenerCount(), 0)
  lateUnsub()
  unsub()
})

test('cold start applies active locale synchronously before first state pull and desktop computer labels', async (t) => {
  const computerCalls = []
  const domEnv = installDomGlobals(t, {
    dsBotApp: {
      computer: payload => computerCalls.push(payload),
    },
  })
  const host = await createStrictClientHost(t, { splitDotted: true, activeLocale: 'zh' })
  try {
    const built = loadBuiltClientBundle(domEnv.window)
    const fiber = await host.root.plugin({
      name: 'ds-bot',
      inject: built.inject,
      apply: built.apply,
    })
    await delay(40)

    const firstState = domEnv.apiCalls.find(entry => entry.endpoint === 'state')
    assert.ok(firstState, 'cold start must issue an initial state pull')
    assert.equal(firstState.payload?.locale, 'zh', 'first state pull must use active locale zh synchronously on cold start')

    assert.ok(computerCalls.length > 0, 'ds-bot: computer indicator must push initial labels on cold start')
    assert.equal(computerCalls[0].labels?.stop, '停止', 'initial desktop computer labels must use Chinese on cold start')
    assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors during zh cold start')

    await fiber.dispose()
    assert.deepEqual(host.calls.fiberErrors, [], 'no fiber errors after zh cold start dispose')
  } finally {
    await host.root.fiber.dispose()
    domEnv.dispose()
  }
})

test('plugin main host entry (plugin.js) mounts under strict sibling-fiber Cordis inject enforcement', async (t) => {
  const home = makeTempDir('ds-bot-plugin-host-smoke-')
  const root = new Context()
  t.after(async () => { await root.fiber.dispose() })

  const fake = fakeContext()
  const routes = {}
  const origRegister = fake.connection.fetch.register
  fake.connection.fetch.register = (options) => {
    routes[options.path] = options
    return origRegister(options)
  }

  // Provide every service declared by plugin.js from its own sibling plugin fiber,
  // NEVER via root.provide, so Cordis strictly enforces `without inject`.
  const hostServices = {
    tools: fake.tools,
    systemPrompt: fake.systemPrompt,
    connection: fake.connection,
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'w1', path: home }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async id => ({ agent: { session: { id, seq: 1 }, followup() {} } }),
      selectModel: async () => {},
      prompt: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  }
  for (const [name, impl] of Object.entries(hostServices)) {
    await root.plugin({
      name: `host:${name}`,
      apply(c) { c.provide(name, impl) },
    })
  }

  const fiber = await root.plugin(pluginEntry, { home, github: false, diagnosticsFile: false })
  await delay(30)
  assert.ok(routes['/api/bot'], 'plugin.js should register /api/bot under strict Cordis inject enforcement')
  await fiber.dispose()

  // Regression guard: stripping a declared required service from plugin.js inject must fail.
  const withoutTools = {
    name: 'ds-bot-host-missing-tools',
    inject: pluginEntry.inject.filter(name => name !== 'tools'),
    apply: pluginEntry.apply,
  }
  await assert.rejects(
    async () => { await root.plugin(withoutTools, { home, github: false, diagnosticsFile: false }) },
    /cannot get property "tools" without inject/,
  )
})
