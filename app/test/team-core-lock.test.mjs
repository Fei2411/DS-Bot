// Behavior-locking tests covering both plugin (ds-bot/src/client/index.js) and
// desktop (app/ui/src/team.js) faces before and across the team-core refactor.
// Payloads mirror real host `state` (ds-bot/src/host/channel.js) and `feed`
// (ds-bot/src/host/feed.js) shapes.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const CLIENT_DIR = path.join(REPO_ROOT, 'ds-bot/src/client')
const APP_UI_DIR = path.join(REPO_ROOT, 'app/ui/src')

const require = createRequire(import.meta.url)
const realReact = require('react')
const realReactDom = require('react-dom')
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

function makeRealHostState(overrides = {}) {
  return {
    revision: 1,
    workspaceId: 'ws-main',
    mainBotId: 'bot-a',
    mainBotIds: ['bot-a'],
    bots: [
      { id: 'bot-a', name: 'Alpha', sessionId: 'bot-a-p2', parts: ['bot-a', 'bot-a-p2'], color: '#4d6bfe', createdAt: 1000 },
      { id: 'bot-b', name: 'Beta', sessionId: 'bot-b', parts: ['bot-b'], color: '#10b981', createdAt: 2000, createdBy: 'bot-a' },
    ],
    rooms: [
      { id: 'room-1', name: 'Ops', sessionId: 'room-1-p2', ownParts: ['room-1', 'room-1-p2'], parts: ['room-1'], members: ['bot-a', 'bot-b'], createdAt: 3000 },
    ],
    privateArchives: [],
    exchangeTurns: {},
    questions: {},
    views: {},
    closedCards: {},
    btwCards: {},
    sideChats: {},
    agents: [
      { id: 'agent-1', name: 'Classic', sessions: ['cs-1', 'cs-2'] },
    ],
    sections: [{ id: 'sec-1', name: 'Work', collapsed: false }],
    secrets: [],
    secretStore: { mode: 'plain', locked: false },
    capabilities: [],
    secretRequests: {},
    connectorRequests: {},
    mailRequests: {},
    colors: ['#4d6bfe'],
    models: [{ ref: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }],
    defaultModel: 'deepseek/deepseek-chat',
    profileDefaultModel: 'deepseek/deepseek-chat',
    permissions: null,
    modelsKey: 'mk-1',
    prefs: { theme: 'deepseek', motion: 'normal', layout: 'bubbles', effects: 'on' },
    approvalReviews: [],
    browser: false,
    memory: true,
    readOnly: null,
    im: { connections: [], platforms: [] },
    computer: { enabled: false },
    liveKey: 'run-1:1',
    activity: {},
    work: { bots: {}, agents: {}, rooms: {}, activeRooms: [], approvals: [], waiting: {}, paused: [], turns: {}, steered: {}, canBackground: {} },
    memoryNews: { 'bot-a': { at: 100, summary: 'initial' } },
    memoryReviews: {},
    learning: {},
    learningSettled: {},
    connectors: [],
    capabilityStatuses: {},
    phone: null,
    api: null,
    imStatus: {},
    imVia: {},
    apiVia: {},
    computerLive: {},
    browserHolds: {},
    inbox: null,
    plugins: null,
    speech: false,
    userQuestions: [],
    sessionQueues: {},
    botTails: {},
    telemetryPrompt: false,
    releaseNotes: null,
    ...overrides,
  }
}

const apiStubPlugin = {
  name: 'lock-stubs',
  setup(bundler) {
    bundler.onResolve({ filter: /src\/client\/api\.js$|^\.\/api\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('app/ui/src') && args.path === './api.js') {
        return { path: 'feed-stub', namespace: 'lock' }
      }
      return { path: 'api-stub', namespace: 'lock' }
    })
    bundler.onLoad({ filter: /^api-stub$/, namespace: 'lock' }, () => ({
      contents: 'export const call = (...args) => globalThis.__lockCall ? globalThis.__lockCall(...args) : Promise.resolve({ unchanged: true })',
      loader: 'js',
    }))
    bundler.onLoad({ filter: /^feed-stub$/, namespace: 'lock' }, () => ({
      contents: 'export const openFeed = (cb) => { globalThis.__lockFeed = cb; return () => { globalThis.__lockFeedClosed = true } }',
      loader: 'js',
    }))
  },
}

class FakeObserver {
  observe() {}
  disconnect() {}
}

let desktopBundle = null
let pluginBundle = null

async function getDesktopBundle() {
  if (desktopBundle) return desktopBundle
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { createTeam, CLASSIC_BROWSER_OWNER } from './app/ui/src/team.js'
        export {
          pendingFailedByChat, heldFailedUrls, inFlightUrls,
          hasPendingFailedAttachments, trackFailedUrls, trackInFlightUrls,
          pruneFailedSends, clearFailedSends,
        } from './app/ui/src/failed-send-bar.js'
        export { keepDraft, takeDraft, forgetKeptFiles } from './ds-bot/src/client/draft-keep.js'
      `,
      resolveDir: REPO_ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    nodePaths: [path.join(REPO_ROOT, 'app/node_modules')],
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom'],
    plugins: [apiStubPlugin, {
      name: 'cells-stub',
      setup(bundler) {
        bundler.onResolve({ filter: /src\/client\/cells\.js$/ }, () => ({ path: 'cells-stub', namespace: 'lock' }))
        bundler.onLoad({ filter: /^cells-stub$/, namespace: 'lock' }, () => ({
          contents: 'export const workPhrase = () => "working"',
          loader: 'js',
        }))
      },
    }],
  })
  desktopBundle = outputFiles[0].text
  return desktopBundle
}

async function getPluginBundle() {
  if (pluginBundle) return pluginBundle
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { apply } from './ds-bot/src/client/index.js'
        export { keepDraft, takeDraft, forgetKeptFiles } from './ds-bot/src/client/draft-keep.js'
      `,
      resolveDir: REPO_ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    nodePaths: [path.join(REPO_ROOT, 'app/node_modules')],
    write: false,
    logLevel: 'silent',
    external: [
      'react',
      'react-dom',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
    ],
    plugins: [apiStubPlugin],
  })
  pluginBundle = outputFiles[0].text
  return pluginBundle
}

async function bootDesktop({ callHandler, storageData = {}, dshUpdates = null, ownAppUpdates = null } = {}) {
  const code = await getDesktopBundle()
  const mod = { exports: {} }
  const kv = new Map(Object.entries(storageData))
  const storage = {
    getItem: k => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)) },
    removeItem: k => { kv.delete(k) },
  }
  const winListeners = new Map()
  const calls = []
  const revokedUrls = []
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: id => (
      id === 'react'
        ? {
            ...realReact,
            useRef: initial => ({ current: initial }),
            useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
          }
        : id === 'react-dom' ? realReactDom : {}
    ),
    __lockCall: async (endpoint, body, signal) => {
      calls.push({ endpoint, body })
      if (callHandler) return callHandler(endpoint, body, signal)
      return { unchanged: true }
    },
    __lockFeed: null,
    __lockFeedClosed: false,
    localStorage: storage,
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      location: { origin: 'http://127.0.0.1:4123' },
      addEventListener: (type, fn) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set())
        winListeners.get(type).add(fn)
      },
      removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn) },
    },
    document: { hidden: false, body: { hasAttribute: () => false }, addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    dsBotApp: {
      updates: ownAppUpdates ?? {
        state: async () => ({ phase: 'idle' }),
        check: async () => {},
        install: async () => {},
        open: async () => {},
        download: async () => {},
        setAutoUpdate: async () => {},
        subscribe: () => () => {},
      },
    },
    ...(dshUpdates ? { dshDesktop: { protocolVersion: 1, updates: dshUpdates } } : {}),
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    URL: Object.assign(function FakeURL(...args) { return new URL(...args) }, {
      revokeObjectURL: url => revokedUrls.push(url),
    }),
    AbortController,
    File,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Map, Set, WeakMap, Promise, Object, Array, Number, String, Boolean, JSON, Math, Date, Error, Intl,
  }
  sandbox.globalThis = sandbox
  runInNewContext(code, sandbox)
  const team = mod.exports.createTeam()
  return {
    team,
    exports: mod.exports,
    calls,
    kv,
    revokedUrls,
    emitFeed: (ev, data) => sandbox.__lockFeed?.(ev, data),
    fireWindowEvent: (type, ev) => {
      for (const fn of winListeners.get(type) ?? []) fn(ev)
    },
  }
}

async function bootPlugin({ callHandler, storageData = {}, dshUpdates = null, ownAppUpdates = null } = {}) {
  const code = await getPluginBundle()
  const mod = { exports: {} }
  const kv = new Map(Object.entries(storageData))
  const storage = {
    getItem: k => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)) },
    removeItem: k => { kv.delete(k) },
  }
  const winListeners = new Map()
  const calls = []
  const openedSessions = []
  let capturedFace = null
  const effectsCleanups = []

  const makeObservable = (initial) => {
    let val = initial
    const subs = new Set()
    return {
      getSnapshot: () => val,
      subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
      set: (next) => { val = typeof next === 'function' ? next(val) : next; for (const fn of [...subs]) fn() },
    }
  }
  const sessionsList = makeObservable({
    ids: ['bot-a-p2', 'bot-b', 'room-1-p2', 'cs-1', 'cs-2'],
    byId: {
      'bot-a-p2': { id: 'bot-a-p2', retainedBy: { mainView: 1 }, updatedAt: 1000 },
      'bot-b': { id: 'bot-b', retainedBy: {}, updatedAt: 2000 },
      'room-1-p2': { id: 'room-1-p2', retainedBy: {}, updatedAt: 3000 },
      'cs-1': { id: 'cs-1', retainedBy: {}, updatedAt: 100 },
      'cs-2': { id: 'cs-2', retainedBy: {}, updatedAt: 200 },
    },
  })
  const fakeCtx = {
    effect: (fn) => {
      try {
        const stop = fn()
        if (typeof stop === 'function') effectsCleanups.push(stop)
      } catch { /* ignore non-face DOM effects */ }
      return () => {}
    },
    inject: () => ({ dispose: () => {} }),
    on: () => () => {},
    get: () => undefined,
    sessions: {
      list: sessionsList,
      binding: () => undefined,
      refresh: async () => {},
      refreshProjections: async () => {},
    },
    uiWorkspace: {
      openSession: (id) => {
        openedSessions.push(id)
        sessionsList.set((list) => {
          const nextById = {}
          for (const [k, row] of Object.entries(list.byId)) {
            nextById[k] = { ...row, retainedBy: { mainView: k === id ? 1 : 0 } }
          }
          if (!nextById[id]) nextById[id] = { id, retainedBy: { mainView: 1 }, updatedAt: Date.now() }
          return { ids: list.ids.includes(id) ? list.ids : [...list.ids, id], byId: nextById }
        })
      },
    },
    uiConversation: {
      userText: { register: () => () => {} },
      binding: () => ({ target: () => makeObservable(undefined), openTurn: makeObservable(undefined) }),
      imageUrl: () => '',
    },
    uiSession: {},
    slots: {
      entries: () => [],
      subscribe: () => () => {},
      inject: (_name, fn) => fn(),
      register: (opts) => {
        if (opts.name === 'shell.overlay' && opts.id === 'bot' && typeof opts.inject === 'function') {
          capturedFace = opts.inject()
        }
        return () => {}
      },
    },
    theme: { overrideTokens: () => () => {} },
    layout: { selectPanel: () => {}, toggleSidebar: () => {} },
  }
  const fakeWin = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn) },
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ...(dshUpdates ? { dshDesktop: { protocolVersion: 1, updates: dshUpdates } } : {}),
  }
  const fakeDoc = {
    hidden: false,
    title: '',
    styleSheets: [],
    defaultView: fakeWin,
    head: { append: () => {}, appendChild: () => {}, querySelector: () => null },
    body: {
      dataset: {},
      style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => '' },
      hasAttribute: () => false,
    },
    documentElement: {
      dataset: {},
      style: { setProperty: () => {}, removeProperty: () => {} },
      hasAttribute: () => false,
    },
    createElement: () => ({ textContent: '', remove: () => {}, setAttribute: () => {}, dataset: {}, style: {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: id => (
      id === 'react'
        ? {
            ...realReact,
            useRef: initial => ({ current: initial }),
            useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
          }
        : id === 'react-dom' ? realReactDom : {}
    ),
    __lockCall: async (endpoint, body, signal) => {
      calls.push({ endpoint, body })
      if (callHandler) return callHandler(endpoint, body, signal)
      return { unchanged: true }
    },
    localStorage: storage,
    window: fakeWin,
    document: fakeDoc,
    navigator: { platform: 'MacIntel', userAgent: '' },
    ...(ownAppUpdates ? { dsBotApp: { updates: ownAppUpdates } } : {}),
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    getComputedStyle: fakeWin.getComputedStyle,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL, Map, Set, WeakMap, Promise, Object, Array, Number, String, Boolean, JSON, Math, Date, Error, Intl,
  }
  sandbox.globalThis = sandbox
  runInNewContext(code, sandbox)
  mod.exports.apply(fakeCtx)
  assert.ok(capturedFace, 'plugin must expose captured face')
  return {
    face: capturedFace,
    exports: mod.exports,
    calls,
    kv,
    openedSessions,
    sessionsList,
    storage,
    dispose: () => { for (const stop of effectsCleanups.splice(0).reverse()) { try { stop() } catch {} } },
    fireWindowEvent: (type, ev) => {
      for (const fn of winListeners.get(type) ?? []) fn(ev)
    },
  }
}

test('behavior lock: both plugin and desktop faces hydrate roster, memoryNews, unread/visits/reactions, sidebar prefs, and update actions consistently', async () => {
  let stateRev = 1
  let stateLiveKey = 'run-1:1'
  let newsAt = 100
  let readOnly = null
  let updatePhase = 'idle'
  let dshPhase = 'idle'
  const callHandler = async (endpoint) => {
    if (endpoint === 'state') {
      return makeRealHostState({
        revision: stateRev,
        liveKey: stateLiveKey,
        memoryNews: { 'bot-a': { at: newsAt, summary: `rev-${newsAt}` } },
        readOnly,
      })
    }
    if (endpoint === 'update-check') return { available: true, version: '0.4.3', phase: updatePhase, dsh: { phase: dshPhase } }
    if (endpoint === 'update-install') { updatePhase = 'installing'; return { available: true, phase: 'installing' } }
    if (endpoint === 'dsh-update-install') { dshPhase = 'installing'; return { phase: 'installing' } }
    if (endpoint === 'recover-session') return { ok: true }
    if (endpoint === 'learning-answer') return { ok: true }
    return { ok: true }
  }

  let dshOpenedDesktop = 0
  let dshOpenedPlugin = 0
  let ownCheckedDesktop = 0
  let ownCheckedPlugin = 0

  const d = await bootDesktop({
    callHandler,
    storageData: { 'ds-bot:prefs': JSON.stringify({ theme: 'ember', enterToSend: false }) },
    dshUpdates: {
      status: async () => ({ phase: 'available', version: '0.2.5' }),
      open: async () => { dshOpenedDesktop += 1 },
      subscribe: () => () => {},
    },
    ownAppUpdates: {
      state: async () => ({ phase: 'ready' }),
      check: async () => { ownCheckedDesktop += 1 },
      install: async () => {},
      open: async () => {},
      download: async () => {},
      setAutoUpdate: async () => {},
      subscribe: () => () => {},
    },
  })
  const p = await bootPlugin({
    callHandler,
    storageData: { 'ds-bot:prefs': JSON.stringify({ theme: 'ember', enterToSend: false }) },
    dshUpdates: {
      status: async () => ({ phase: 'available', version: '0.2.5' }),
      open: async () => { dshOpenedPlugin += 1 },
      subscribe: () => () => {},
    },
    ownAppUpdates: {
      state: async () => ({ phase: 'ready' }),
      check: async () => { ownCheckedPlugin += 1 },
      install: async () => {},
      open: async () => {},
      download: async () => {},
      setAutoUpdate: async () => {},
      subscribe: () => () => {},
    },
  })

  // Cold-start cached prefs before first pull finishes.
  assert.equal(d.team.snapshots.roster().prefs.theme, 'ember')
  assert.equal(d.team.snapshots.roster().prefs.enterToSend, false)
  // Plugin already ran first poll synchronously inside apply(), wait a tick for both.
  const stopDesktop = d.team.start()
  try {
    await tick()
    await tick()

    // Roster indexed identically on both hosts (including multi-part bot and room indexing).
    const dRoster = d.team.snapshots.roster()
    const pRoster = p.face.hooks.roster.getSnapshot()
    assert.equal(dRoster.ready, true)
    assert.equal(pRoster.ready, true)
    assert.equal(dRoster.byId['bot-a']?.id, 'bot-a')
    assert.equal(dRoster.byId['bot-a-p2']?.id, 'bot-a')
    assert.equal(pRoster.byId['bot-a']?.id, 'bot-a')
    assert.equal(pRoster.byId['bot-a-p2']?.id, 'bot-a')
    assert.equal(dRoster.roomsById['room-1']?.id, 'room-1')
    assert.equal(dRoster.roomsById['room-1-p2']?.id, 'room-1')
    assert.equal(pRoster.roomsById['room-1']?.id, 'room-1')
    assert.equal(pRoster.roomsById['room-1-p2']?.id, 'room-1')
    assert.equal(dRoster.agentOf['cs-1'], 'agent-1')
    assert.equal(pRoster.agentOf['cs-1'], 'agent-1')

    // Initial memoryNews has seen: 0 (no news on window open).
    assert.equal(d.team.hooks.useMemoryNews(v => v)['bot-a']?.seen, 0)
    assert.equal(p.face.hooks.memoryNews.getSnapshot()['bot-a']?.seen, 0)

    // Subsequent memoryNews change sets seen > 0 on desktop (triggered via revision/live pull).
    newsAt = 200
    stateLiveKey = 'run-1:2'
    readOnly = 'Other process'
    d.emitFeed('live', {})
    await tick()
    assert.ok(d.team.hooks.useMemoryNews(v => v)['bot-a']?.seen > 0)
    assert.equal(d.team.snapshots.roster().readOnly, 'Other process')

    // Unread marks, visits, and reactions match across both hosts.
    d.team.actions.markUnread('bot-b')
    p.face.actions.markUnread('bot-b')
    assert.equal(d.team.snapshots.ui().unread['bot-b'], true)
    assert.equal(p.face.hooks.ui.getSnapshot().unread['bot-b'], true)
    d.team.actions.clearUnread('bot-b')
    p.face.actions.clearUnread('bot-b')
    assert.equal(d.team.snapshots.ui().unread['bot-b'], undefined)
    assert.equal(p.face.hooks.ui.getSnapshot().unread['bot-b'], undefined)

    d.team.actions.beginVisit('bot-a-p2')
    p.face.actions.beginVisit('bot-a-p2')
    assert.ok(Number.isFinite(d.team.snapshots.ui().visits['bot-a-p2']?.entered))
    assert.ok(Number.isFinite(p.face.hooks.ui.getSnapshot().visits['bot-a-p2']?.entered))
    d.team.actions.endVisit('bot-a-p2')
    p.face.actions.endVisit('bot-a-p2')
    assert.equal(d.team.snapshots.ui().visits['bot-a-p2'], undefined)
    assert.equal(p.face.hooks.ui.getSnapshot().visits['bot-a-p2'], undefined)

    d.team.actions.toggleReaction('bot-a', 0, '👍')
    p.face.actions.toggleReaction('bot-a', 0, '👍')
    assert.deepEqual(plain(d.team.snapshots.ui().reactions), plain(p.face.hooks.ui.getSnapshot().reactions))

    // Sidebar pref + width + toggleLeftHidden.
    d.team.actions.setSidebarPref('rail')
    p.face.actions.setSidebarPref('rail')
    assert.equal(d.team.hooks.useLayout(v => v.pref), 'rail')
    assert.equal(p.face.hooks.sidebarPref.getSnapshot(), 'rail')
    d.team.actions.toggleLeftHidden()
    p.face.actions.toggleLeftHidden()
    assert.equal(d.team.hooks.useLayout(v => v.pref), 'hidden')
    assert.equal(p.face.hooks.sidebarPref.getSnapshot(), 'hidden')
    d.team.actions.toggleLeftHidden()
    p.face.actions.toggleLeftHidden()
    assert.equal(d.team.hooks.useLayout(v => v.pref), 'rail')
    assert.equal(p.face.hooks.sidebarPref.getSnapshot(), 'rail')

    d.team.actions.setSidebarWidth(320)
    p.face.actions.setSidebarWidth(320)
    assert.equal(d.team.hooks.useLayout(v => v.width), 320)
    assert.equal(p.face.hooks.frame.getSnapshot().sidebarWidth, 320)

    // Update actions match across both hosts.
    await d.team.actions.checkUpdate()
    await p.face.actions.checkUpdate()
    assert.equal(d.team.hooks.useUpdate(v => v.version), '0.4.3')
    assert.equal(p.face.hooks.update.getSnapshot().version, '0.4.3')
    await d.team.actions.installUpdate()
    await p.face.actions.installUpdate()
    assert.equal(d.team.hooks.useUpdate(v => v.phase), 'installing')
    assert.equal(p.face.hooks.update.getSnapshot().phase, 'installing')
    await d.team.actions.installDshUpdate()
    await p.face.actions.installDshUpdate()
    assert.equal(d.team.hooks.useUpdate(v => v.dsh?.phase), 'installing')
    assert.equal(p.face.hooks.update.getSnapshot().dsh?.phase, 'installing')
    await d.team.actions.openAppUpdates('0.2.5')
    await p.face.actions.openAppUpdates('0.2.5')
    assert.equal(dshOpenedDesktop, 1)
    assert.equal(dshOpenedPlugin, 1)
    await d.team.actions.checkOwnApp()
    await p.face.actions.checkOwnApp()
    assert.equal(ownCheckedDesktop, 1)
    assert.equal(ownCheckedPlugin, 1)

    // Shared dialogs / panels / paste / learning / agent rename actions match.
    d.team.actions.beginAgentRename('cs-1')
    p.face.actions.beginAgentRename('cs-1')
    assert.equal(d.team.snapshots.ui().renameAgent, 'cs-1')
    assert.equal(p.face.hooks.ui.getSnapshot().renameAgent, 'cs-1')
    d.team.actions.endAgentRename()
    p.face.actions.endAgentRename()
    assert.equal(d.team.snapshots.ui().renameAgent, null)
    assert.equal(p.face.hooks.ui.getSnapshot().renameAgent, null)

    const dPasteId = d.team.actions.addPaste('bot-a-p2', 'long text', 'p.txt')
    const pPasteId = p.face.actions.addPaste('bot-a-p2', 'long text', 'p.txt')
    assert.equal(d.team.snapshots.ui().paste['bot-a-p2'].length, 1)
    assert.equal(p.face.hooks.ui.getSnapshot().paste['bot-a-p2'].length, 1)
    d.team.actions.linkPastes('bot-a-p2', [{ blockId: dPasteId, attachmentId: 'att-1' }])
    p.face.actions.linkPastes('bot-a-p2', [{ blockId: pPasteId, attachmentId: 'att-1' }])
    assert.equal(d.team.snapshots.ui().paste['bot-a-p2'][0].attachmentId, 'att-1')
    assert.equal(p.face.hooks.ui.getSnapshot().paste['bot-a-p2'][0].attachmentId, 'att-1')
    d.team.actions.removePaste('bot-a-p2', [dPasteId])
    p.face.actions.removePaste('bot-a-p2', [pPasteId])
    assert.equal(d.team.snapshots.ui().paste['bot-a-p2'].length, 0)
    assert.equal(p.face.hooks.ui.getSnapshot().paste['bot-a-p2'].length, 0)

    await d.team.actions.learningAnswer('learn-1', true)
    await p.face.actions.learningAnswer('learn-1', true)
    assert.equal(d.calls.some(c => c.endpoint === 'learning-answer' && c.body?.id === 'learn-1'), true)
    assert.equal(p.calls.some(c => c.endpoint === 'learning-answer' && c.body?.id === 'learn-1'), true)
  } finally {
    stopDesktop()
    p.dispose()
  }
})

test('behavior lock: out-of-order pull responses never overwrite newer revision and deleting a bot prunes drafts and failed sends', async () => {
  const firstPull = Promise.withResolvers()
  const secondPull = Promise.withResolvers()
  let stateCalls = 0
  const d = await bootDesktop({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        stateCalls += 1
        if (stateCalls === 1) return firstPull.promise
        if (stateCalls === 2) return secondPull.promise
        return makeRealHostState({
          revision: 3,
          liveKey: 'run-1:3',
          bots: [{ id: 'bot-a', name: 'Alpha', sessionId: 'bot-a-p2', parts: ['bot-a', 'bot-a-p2'] }],
        })
      }
      return {}
    },
  })

  const stop = d.team.start()
  try {
    // Second pull starts after first and finishes BEFORE first.
    d.emitFeed('revision', {})
    secondPull.resolve(makeRealHostState({ revision: 2, liveKey: 'run-1:2' }))
    await tick()
    await tick()
    assert.equal(d.team.snapshots.roster().revision, 2)

    // Late resolution of first pull (order 1 < applied 2) must be discarded.
    firstPull.resolve(makeRealHostState({ revision: 1, liveKey: 'run-1:1' }))
    await tick()
    await tick()
    assert.equal(d.team.snapshots.roster().revision, 2, 'older overlapping pull must not overwrite newer roster')

    // Keep draft and failed-send entry for bot-b, then delete bot-b in rev 3.
    d.exports.keepDraft({ chatId: 'bot-b', part: 'bot-b', text: 'unsent draft', files: [] })
    const failedItems = [{ previewUrl: 'blob:failed-b' }]
    d.exports.trackFailedUrls(failedItems, true)
    d.exports.pendingFailedByChat.set('bot-b', [{ id: 'f1', text: 'oops', items: failedItems }])
    assert.equal(d.exports.hasPendingFailedAttachments(), true)

    d.emitFeed('revision', {})
    await tick()
    await tick()
    assert.equal(d.team.snapshots.roster().revision, 3)
    assert.equal(d.team.snapshots.roster().byId['bot-b'], undefined)
    assert.equal(d.exports.takeDraft({ chatId: 'bot-b', part: 'bot-b-next', text: '', attached: 0 }).text, '')
    assert.equal(d.exports.pendingFailedByChat.has('bot-b'), false)
    assert.equal(d.exports.hasPendingFailedAttachments(), false)
    assert.deepEqual(d.revokedUrls, ['blob:failed-b'])
  } finally {
    d.exports.clearFailedSends()
    d.exports.forgetKeptFiles()
    stop()
  }
})

test('behavior lock: landOn and recoverOpening honor navSeq and follow part rollovers on both hosts', async () => {
  let botAPart = 'bot-a-p2'
  const callHandler = async (endpoint) => {
    if (endpoint === 'state') {
      return makeRealHostState({
        revision: botAPart === 'bot-a-p3' ? 2 : 1,
        bots: [
          { id: 'bot-a', name: 'Alpha', sessionId: botAPart, parts: ['bot-a', 'bot-a-p2', ...(botAPart === 'bot-a-p3' ? ['bot-a-p3'] : [])] },
          { id: 'bot-b', name: 'Beta', sessionId: 'bot-b', parts: ['bot-b'] },
        ],
      })
    }
    if (endpoint === 'recover-session') {
      botAPart = 'bot-a-p3'
      return { ok: true }
    }
    return {}
  }

  const d = await bootDesktop({ callHandler })
  const stop = d.team.start()
  try {
    await tick()
    await tick()
    assert.equal(d.team.snapshots.shown(), 'bot-a-p2')
    const staleSeq = d.team.actions.navSeq()
    d.team.actions.openSession('bot-b')
    assert.equal(d.team.snapshots.shown(), 'bot-b')
    assert.equal(d.team.actions.navSeq(), staleSeq + 1)

    // Stale expectedSeq is ignored by landOn.
    await d.team.actions.landOn('bot-a', null, staleSeq)
    assert.equal(d.team.snapshots.shown(), 'bot-b')

    // recoverOpening calls recover-session and opens the fresh part.
    await d.team.actions.recoverOpening('bot-a')
    assert.equal(d.team.snapshots.shown(), 'bot-a-p3')
  } finally {
    stop()
  }
})
