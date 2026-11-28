import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as acorn from 'acorn'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const CLIENT_DIR = path.join(REPO_ROOT, 'ds-bot/src/client')
const APP_UI_DIR = path.join(REPO_ROOT, 'app/ui/src')

const require = createRequire(import.meta.url)
const realReact = require('react')
const realReactDom = require('react-dom')

// Actions intentionally absent on one host, with an explicit reason for each.
// Every entry is also checked for staleness: if a host later implements it, the
// allowlist entry must be removed so the contract stays accurate.
const DESKTOP_ACTION_ALLOWLIST = {
  openHarnessOnboarding: 'Plugin-only DSH SettingsShell onboarding dialog; desktop handles API keys via inline ModelKeyCard and Settings → Models (openModels).',
  renderUserText: 'Optional override checked by EarlierUser in cells.js; desktop passes renderUserText directly as a component prop.',
  seatAccount: 'Plugin-only DSH settings.launcher seat negotiation; desktop renders AccountLauncher with seat=false inside TeamSidebar.',
}

const PLUGIN_ACTION_ALLOWLIST = {
  createClassicSession: 'Desktop-only Classic Agent session creator used by CommandPalette in the standalone window.',
  hasPluginMic: 'Desktop-only composer capability check; plugin mode inspects ctx.get("remote.speech") via actions.speech.',
  openFile: 'Desktop-only right-panel preview opener; plugin mode receives openFile from DSH slot props.',
  openShortcuts: 'Desktop-only ShortcutsDialog opener; plugin mode registers into DSH’s own shortcut catalog.',
  renderUserText: 'Optional override checked by EarlierUser in cells.js; neither host puts it on actions.',
  revealFolder: 'Desktop-only right-panel file-tree reveal; plugin mode uses DSH’s sidebarRight.',
}

const DSH_SLOT_HOOK_REASONS = {
  useConnectionState: 'Injected by DSH’s SettingsShell slot runtime, not by the team face.',
  useConversation: 'Injected by DSH’s conversation slot runtime (DraftKeeper only mounts in plugin mode).',
  useConversationViews: 'Injected by DSH’s header navigation slot in plugin mode.',
  useDesktopUpdate: 'Injected by DSH’s SettingsShell slot runtime, not by the team face.',
  useDeveloperTools: 'Injected by DSH’s SettingsShell slot runtime, not by the team face.',
  useDocument: 'Injected by DSH’s SettingsShell slot runtime, not by the team face.',
  useInput: 'Injected by DSH’s composer slot runtime (DraftKeeper/PasteGuard/ComposerPlus plugin path).',
  useProjection: 'Injected by DSH’s session slot runtime (DraftKeeper/QueueDock plugin path).',
  useReleaseChange: 'Injected by DSH’s SettingsShell slot runtime, not by the team face.',
  useSession: 'Supplied per-session via team.sessionHook(sessionId) on desktop and by DSH slot injection in plugin mode.',
  useStore: 'Injected by DSH’s header navigation slot in plugin mode.',
  useTurnContext: 'Injected by DSH’s assistant-step keyedHooks in plugin mode (AssistantCell).',
  useTurnData: 'Injected by DSH’s chat node slot runtime in plugin mode (AssistantCell).',
  useTurnSteps: 'Injected by DSH’s assistant-step keyedHooks in plugin mode (AssistantCell).',
}

const DESKTOP_HOOK_ALLOWLIST = {
  ...DSH_SLOT_HOOK_REASONS,
  useFrame: 'Supplied by app/ui/src/app.js as useOwnFrame rather than createTeam().hooks.',
  useSidebarPref: 'Supplied by app/ui/src/app.js as useOwnSidebarPref rather than createTeam().hooks.',
  useSettingsShellHeld: 'Plugin-only DSH SettingsShell seat state; desktop renders SettingsDialog directly in Overlays.',
  useDisclosure: 'Local prop passed by ToolCallCard to built-in tool views, not a team store hook.',
}

const PLUGIN_HOOK_ALLOWLIST = {
  ...DSH_SLOT_HOOK_REASONS,
  useSessions: 'Provided by DSH’s own sessions slot injection in plugin mode.',
  useSessionStatus: 'Provided by DSH’s own session-status slot injection in plugin mode.',
  useSessionRetainInfo: 'Provided by DSH’s own session-retain slot injection in plugin mode.',
}

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJsFiles(full, out)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit)
    } else if (value && typeof value.type === 'string') {
      walkAst(value, visit)
    }
  }
}

function isNamedRef(node, targetName) {
  if (!node) return false
  if (node.type === 'ChainExpression') return isNamedRef(node.expression, targetName)
  if (node.type === 'Identifier' && node.name === targetName) return true
  if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier' && node.property.name === targetName) {
    return true
  }
  return false
}

function collectReferences(files) {
  const actions = new Map()
  const hooks = new Map()
  const record = (map, name, rel, line) => {
    let list = map.get(name)
    if (!list) { list = []; map.set(name, list) }
    list.push(`${rel}:${line}`)
  }
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = fs.readFileSync(file, 'utf8')
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    walkAst(ast, (node) => {
      if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
        if (isNamedRef(node.object, 'actions')) {
          record(actions, node.property.name, rel, node.loc.start.line)
        }
        if (isNamedRef(node.object, 'hooks') && /^use[A-Z]/.test(node.property.name)) {
          record(hooks, node.property.name, rel, node.loc.start.line)
        }
        if (node.object?.type === 'Identifier' && node.object.name === 'props' && /^use[A-Z]/.test(node.property.name)) {
          record(hooks, node.property.name, rel, node.loc.start.line)
        }
      }
      if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isNamedRef(node.init, 'actions')) {
        for (const prop of node.id.properties) {
          if (prop.type === 'Property' && !prop.computed && prop.key?.type === 'Identifier') {
            record(actions, prop.key.name, rel, prop.loc.start.line)
          }
        }
      }
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') {
        const param = node.declaration.params[0]
        if (param?.type === 'ObjectPattern') {
          for (const prop of param.properties) {
            if (prop.type === 'Property' && !prop.computed && prop.key?.type === 'Identifier' && /^use[A-Z]/.test(prop.key.name)) {
              record(hooks, prop.key.name, rel, prop.loc.start.line)
            }
          }
        }
      }
    })
  }
  return { actions, hooks }
}

const apiStubPlugin = {
  name: 'view-contract-stubs',
  setup(bundler) {
    bundler.onResolve({ filter: /src\/client\/api\.js$|^\.\/api\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('app/ui/src') && args.path === './api.js') {
        return { path: 'feed-stub', namespace: 'vc' }
      }
      return { path: 'api-stub', namespace: 'vc' }
    })
    bundler.onLoad({ filter: /^api-stub$/, namespace: 'vc' }, () => ({
      contents: 'export const call = (...args) => globalThis.__vcCall ? globalThis.__vcCall(...args) : Promise.resolve({ unchanged: true })',
      loader: 'js',
    }))
    bundler.onLoad({ filter: /^feed-stub$/, namespace: 'vc' }, () => ({
      contents: 'export const openFeed = (cb) => { if (globalThis.__vcSetFeed) globalThis.__vcSetFeed(cb); return () => {} }',
      loader: 'js',
    }))
  },
}

const fakeBrowserBridge = {
  acquire: async () => 'lease-1',
  release: async () => {},
  forget: async () => {},
  onOpenRequested: () => () => {},
  views: {
    create: async () => {},
    sync: async () => {},
    place: async () => {},
    navigate: async () => {},
    command: async () => {},
    focus: async () => {},
    read: async () => {},
    close: async () => {},
    hold: async () => {},
    subscribe: () => () => {},
  },
  importSources: async () => [],
  importPick: async () => null,
  importLive: async () => null,
  importApply: async () => null,
  importCancel: async () => null,
}

class FakeObserver {
  observe() {}
  disconnect() {}
}

let desktopBundleText = null

async function loadDesktopBundle() {
  if (desktopBundleText !== null) return desktopBundleText
  const { outputFiles } = await build({
    entryPoints: [path.join(APP_UI_DIR, 'team.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom'],
    plugins: [apiStubPlugin, {
      name: 'cells-stub',
      setup(bundler) {
        bundler.onResolve({ filter: /src\/client\/cells\.js$/ }, () => ({ path: 'cells-stub', namespace: 'vc' }))
        bundler.onLoad({ filter: /^cells-stub$/, namespace: 'vc' }, () => ({
          contents: 'export const workPhrase = () => ""',
          loader: 'js',
        }))
      },
    }],
  })
  desktopBundleText = outputFiles[0].text
  return desktopBundleText
}

async function createDesktopHarness({ callHandler, storageData = {}, dshUpdates = null, ownAppUpdates = null } = {}) {
  const code = await loadDesktopBundle()
  const mod = { exports: {} }
  const kv = new Map(Object.entries(storageData))
  const storage = {
    getItem: key => (kv.has(key) ? kv.get(key) : null),
    setItem: (key, value) => { kv.set(key, String(value)) },
    removeItem: key => { kv.delete(key) },
  }
  let emitFeed = () => {}
  const calls = []
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: id => (id === 'react' ? realReact : id === 'react-dom' ? realReactDom : {}),
    __vcCall: async (endpoint, body, signal) => {
      calls.push({ endpoint, body })
      if (typeof callHandler === 'function') return callHandler(endpoint, body, signal)
      return { unchanged: true }
    },
    __vcSetFeed: (cb) => { emitFeed = cb },
    localStorage: storage,
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      location: { origin: 'http://127.0.0.1:4123' },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: { hidden: false, body: { hasAttribute: () => false }, addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    dsBotApp: {
      browser: fakeBrowserBridge,
      updates: ownAppUpdates ?? {
        state: async () => ({}),
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
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    Map,
    Set,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    Date,
    Error,
    Intl,
  }
  sandbox.globalThis = sandbox
  runInNewContext(code, sandbox)
  const team = mod.exports.createTeam()
  return { team, calls, kv, emitFeed: (event, data) => emitFeed(event, data) }
}

async function instantiateDesktopFace() {
  const { team } = await createDesktopHarness()
  return {
    actions: new Set(Object.keys(team.actions).filter(key => team.actions[key] !== undefined)),
    hooks: new Set(Object.keys(team.hooks).filter(key => team.hooks[key] !== undefined)),
  }
}

async function instantiatePluginFace() {
  const { outputFiles } = await build({
    entryPoints: [path.join(CLIENT_DIR, 'index.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
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
  const mod = { exports: {} }
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  let capturedFace = null
  const fakeSource = value => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const fakeCtx = {
    effect: (fn) => { try { fn() } catch { /* ignore non-face DOM effects */ } return () => {} },
    inject: () => ({ dispose: () => {} }),
    on: () => () => {},
    get: () => undefined,
    sessions: {
      list: fakeSource({ ids: [], byId: {} }),
      binding: () => undefined,
      refresh: async () => {},
      refreshProjections: async () => {},
    },
    uiWorkspace: { openSession: () => {} },
    uiConversation: {
      userText: { register: () => () => {} },
      binding: () => ({ target: () => fakeSource(undefined), openTurn: fakeSource(undefined) }),
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
    addEventListener: () => {},
    removeEventListener: () => {},
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    dshDesktop: {
      protocolVersion: 1,
      browser: fakeBrowserBridge,
      updates: { status: async () => ({}), open: async () => {}, subscribe: () => () => {} },
    },
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
    require: id => (id === 'react' ? realReact : id === 'react-dom' ? realReactDom : {}),
    localStorage: storage,
    window: fakeWin,
    document: fakeDoc,
    navigator: { platform: 'MacIntel', userAgent: '' },
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    getComputedStyle: fakeWin.getComputedStyle,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    Map,
    Set,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    Date,
    Error,
    Intl,
  }
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)
  mod.exports.apply(fakeCtx)
  assert.ok(capturedFace, 'plugin apply(ctx) must register shell.overlay "bot" with a face injector')
  return {
    actions: new Set(Object.keys(capturedFace.actions).filter(key => capturedFace.actions[key] !== undefined)),
    hooks: new Set(Object.keys(capturedFace.hooks).map(key => `use${key[0].toUpperCase()}${key.slice(1)}`)),
  }
}

function assertContract({ host, kind, used, provided, allowlist }) {
  const missing = []
  for (const [name, locations] of [...used.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (provided.has(name)) continue
    const reason = allowlist[name]
    if (typeof reason === 'string' && reason.trim() !== '') continue
    missing.push(`  - ${name} (${locations.slice(0, 3).join(', ')})`)
  }
  assert.equal(
    missing.length,
    0,
    `${host} is missing ${kind} referenced by views:\n${missing.join('\n')}\nImplement them on ${host} or add an explicit allowlist entry with a reason.`,
  )

  const stale = []
  for (const [name, reason] of Object.entries(allowlist)) {
    assert.equal(typeof reason === 'string' && reason.trim().length > 0, true, `${host} allowlist entry "${name}" must include a reason`)
    if (provided.has(name)) stale.push(`  - ${name} (now provided by ${host})`)
    else if (!used.has(name)) stale.push(`  - ${name} (no longer referenced by any view)`)
  }
  assert.equal(
    stale.length,
    0,
    `${host} ${kind} allowlist has stale entries:\n${stale.join('\n')}`,
  )
}

test('view contract: desktop and plugin faces supply every action and hook used by shared views', async () => {
  const clientFiles = walkJsFiles(CLIENT_DIR).filter((file) => {
    const normalized = file.replace(/\\/g, '/')
    return !normalized.endsWith('/index.js') && !normalized.includes('/locales/')
  })
  const appFiles = walkJsFiles(APP_UI_DIR)

  const clientRefs = collectReferences(clientFiles)
  const appRefs = collectReferences(appFiles)

  const desktopUsedActions = new Map(clientRefs.actions)
  for (const [name, locs] of appRefs.actions) {
    desktopUsedActions.set(name, [...(desktopUsedActions.get(name) ?? []), ...locs])
  }
  const desktopUsedHooks = new Map(clientRefs.hooks)
  for (const [name, locs] of appRefs.hooks) {
    desktopUsedHooks.set(name, [...(desktopUsedHooks.get(name) ?? []), ...locs])
  }

  const [desktopFace, pluginFace] = await Promise.all([
    instantiateDesktopFace(),
    instantiatePluginFace(),
  ])

  assertContract({
    host: 'desktop (createTeam)',
    kind: 'actions',
    used: desktopUsedActions,
    provided: desktopFace.actions,
    allowlist: DESKTOP_ACTION_ALLOWLIST,
  })
  assertContract({
    host: 'desktop (createTeam)',
    kind: 'hooks',
    used: desktopUsedHooks,
    provided: desktopFace.hooks,
    allowlist: DESKTOP_HOOK_ALLOWLIST,
  })
  assertContract({
    host: 'plugin (ds-bot/src/client/index.js)',
    kind: 'actions',
    used: clientRefs.actions,
    provided: pluginFace.actions,
    allowlist: PLUGIN_ACTION_ALLOWLIST,
  })
  assertContract({
    host: 'plugin (ds-bot/src/client/index.js)',
    kind: 'hooks',
    used: clientRefs.hooks,
    provided: pluginFace.hooks,
    allowlist: PLUGIN_HOOK_ALLOWLIST,
  })
})

test('desktop team keeps monotonic turnOutline across two voice rounds and serves closingReply', async () => {
  const stateReply = {
    revision: 1,
    modelsKey: 'm1',
    bots: [{ id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' }],
    rooms: [],
    prefs: { theme: 'deepseek', motion: 'normal' },
  }
  const { team, calls, emitFeed } = await createDesktopHarness({
    storageData: { 'ds-bot:prefs': JSON.stringify({ theme: 'ember' }) },
    callHandler: async (endpoint) => {
      if (endpoint === 'state') return stateReply
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out' } }
      return {}
    },
  })
  // Cold-start reads STORAGE.prefs before the first state pull resolves.
  assert.equal(team.snapshots.roster().prefs?.theme, 'ember')

  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    const stateCall = calls.find(entry => entry.endpoint === 'state')
    assert.equal(stateCall?.body?.avatars, 'ref')

    team.actions.openSession('bot-a')

    // Round 1
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'hello round 1', turn: 0, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'reply round 1', turn: 0, seq: 2, time: 1100 } })
    const outline1 = team.snapshots.sessions().byId['sess-a']?.projectionValues?.turnOutline
    assert.equal(outline1.length, 1)
    assert.equal(outline1[0].turn, 0)
    assert.equal(team.actions.closingReply('sess-a', 0), 'reply round 1')

    // Round 2: outline MUST grow (not overwrite with turn: -1) so voice mode sees a new reply.
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'hello round 2', turn: 1, time: 2000 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'reply round 2', turn: 1, seq: 4, time: 2100 } })
    const outline2 = team.snapshots.sessions().byId['sess-a']?.projectionValues?.turnOutline
    assert.equal(outline2.length, 2)
    assert.equal(outline2[1].turn, 1)
    assert.equal(team.actions.closingReply('sess-a', 1), 'reply round 2')
  } finally {
    stop()
  }
})

test('desktop team wires watchBotCompletions, selectPanel, draft files, openAppUpdates, navSeq, and DeepSeek sign-in', async () => {
  let dshOpened = false
  const { team, calls, emitFeed } = await createDesktopHarness({
    dshUpdates: {
      status: async () => ({ phase: 'available', version: '0.2.5' }),
      open: async () => { dshOpened = true },
      subscribe: () => () => {},
    },
    callHandler: async (endpoint, body) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [
            { id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' },
            { id: 'bot-b', sessionId: 'sess-b', name: 'Beta' },
          ],
          rooms: [],
          sessionQueues: {
            'sess-a': [{ id: 'q-1', source: 'user', content: [{ type: 'text', text: 'hi' }] }],
          },
        }
      }
      if (endpoint === 'engine-account-state') {
        return { available: true, view: { status: 'signed-out', attempt: null } }
      }
      if (endpoint === 'recover-session') return { ok: true }
      if (endpoint === 'bot-steer-queue') return { ok: true }
      return { ok: true, body }
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))

    // Open bot-a so bot-b is in the background.
    const seq0 = team.actions.navSeq()
    team.actions.openSession('bot-a')
    assert.equal(team.actions.navSeq(), seq0 + 1)

    // Background completion on bot-b marks completionUnread before turnOutline updates.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'done in bg', turn: 0, time: 3000 } })
    assert.equal(team.snapshots.status().get('sess-b')?.completionUnread, true)

    // selectPanel('schedules') routes to Settings -> schedules.
    team.actions.selectPanel('schedules')
    assert.equal(team.snapshots.ui().settings?.page, 'schedules')

    // draftFiles roundtrip.
    const fakeFile = { name: 'note.txt', size: 12 }
    const ids = team.actions.restoreDraftFiles('sess-a', [{ kind: 'file', file: fakeFile }])
    assert.equal(ids.length, 1)
    const resolved = team.actions.draftFiles(ids)
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].kind, 'file')
    assert.equal(resolved[0].file, fakeFile)
    team.actions.releaseDraftFiles(ids)
    assert.equal(team.actions.draftFiles(ids).length, 0)

    // openAppUpdates opens only when verified version matches.
    await team.actions.openAppUpdates('0.2.5')
    assert.equal(dshOpened, true)

    // steerQueued delegates to bot-steer-queue for Bot DM.
    await team.actions.steerQueued('sess-a')
    assert.equal(calls.some(entry => entry.endpoint === 'bot-steer-queue'), true)

    // watchAgentTerminals subscribes and returns a cleanup disposer without throwing.
    const stopTerminals = team.actions.watchAgentTerminals('sess-a')
    assert.equal(typeof stopTerminals, 'function')
    stopTerminals()

    // DeepSeek account bridge exposes signInEntry, signIn/closeSignIn, and accountT.
    assert.equal(team.actions.canSignIn(), true)
    assert.ok(team.actions.signInEntry()?.component)
    assert.equal(typeof team.actions.accountT()('signOut'), 'string')
    team.actions.signIn()
    assert.equal(team.snapshots.ui().signIn, 1)
    team.actions.closeSignIn()
    assert.equal(team.snapshots.ui().signIn, null)
  } finally {
    stop()
  }
})
