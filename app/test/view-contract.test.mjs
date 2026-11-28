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
  useAccount: 'Injected by SignInHost (model-menu.js) from signInEntry().inject().hooks.account into DesktopDeepSeekSignInModal, not a team store hook.',
  useApiKey: 'Callback prop (not a React hook) passed by SignInHost (model-menu.js) into DesktopDeepSeekSignInModal.',
}

const PLUGIN_HOOK_ALLOWLIST = {
  ...DSH_SLOT_HOOK_REASONS,
  useSessions: 'Provided by DSH’s own sessions slot injection in plugin mode.',
  useSessionStatus: 'Provided by DSH’s own session-status slot injection in plugin mode.',
  useSessionRetainInfo: 'Provided by DSH’s own session-retain slot injection in plugin mode.',
  useConnection: 'Desktop-only connection state hook for ConnectionIslandPod in DynamicIsland; plugin mode uses DSH ConnectionIndicator in SettingsShell.',
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

function isNamedRef(node, targetName, aliases = null) {
  if (!node) return false
  if (node.type === 'ChainExpression') return isNamedRef(node.expression, targetName, aliases)
  if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
    return isNamedRef(node.left, targetName, aliases)
  }
  if (node.type === 'Identifier') {
    return node.name === targetName || Boolean(aliases?.has(node.name))
  }
  if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier' && node.property.name === targetName) {
    return true
  }
  return false
}

function unwrapPattern(node) {
  return node?.type === 'AssignmentPattern' ? node.left : node
}

function extractPatternKeys(pattern, onKey) {
  const unwrapped = unwrapPattern(pattern)
  if (!unwrapped || unwrapped.type !== 'ObjectPattern') return
  for (const prop of unwrapped.properties) {
    if (prop.type === 'Property' && !prop.computed && prop.key?.type === 'Identifier') {
      onKey(prop.key.name, prop)
    }
  }
}

function collectComponentParam(fnNode, recordAction, recordHook, rel) {
  const first = unwrapPattern(fnNode?.params?.[0])
  if (!first || first.type !== 'ObjectPattern') return
  extractPatternKeys(first, (name, prop) => {
    if (/^use[A-Z]/.test(name)) recordHook(name, rel, prop.loc.start.line)
    if (name === 'actions') {
      extractPatternKeys(prop.value, (actionName, nested) => {
        recordAction(actionName, rel, nested.loc.start.line)
      })
    }
    if (name === 'hooks') {
      extractPatternKeys(prop.value, (hookName, nested) => {
        if (/^use[A-Z]/.test(hookName)) recordHook(hookName, rel, nested.loc.start.line)
      })
    }
  })
}

function collectSourceReferences(source, rel, actions, hooks) {
  const record = (map, name, r, line) => {
    let list = map.get(name)
    if (!list) { list = []; map.set(name, list) }
    list.push(`${r}:${line}`)
  }
  const recordAction = (name, r, line) => record(actions, name, r, line)
  const recordHook = (name, r, line) => record(hooks, name, r, line)
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })

  // Pass 1: collect simple identifier aliases (e.g. `const a = actions`, `const h = hooks`).
  const actionAliases = new Set()
  const hookAliases = new Set()
  walkAst(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      if (isNamedRef(node.init, 'actions', actionAliases)) actionAliases.add(node.id.name)
      if (isNamedRef(node.init, 'hooks', hookAliases)) hookAliases.add(node.id.name)
    }
  })

  // Pass 2: collect member accesses, computed literal/loop indexing, destructuring, and component props.
  walkAst(ast, (node) => {
    if (node.type === 'MemberExpression') {
      if (!node.computed && node.property?.type === 'Identifier') {
        if (isNamedRef(node.object, 'actions', actionAliases)) {
          recordAction(node.property.name, rel, node.loc.start.line)
        }
        if (isNamedRef(node.object, 'hooks', hookAliases) && /^use[A-Z]/.test(node.property.name)) {
          recordHook(node.property.name, rel, node.loc.start.line)
        }
        if (node.object?.type === 'Identifier' && node.object.name === 'props' && /^use[A-Z]/.test(node.property.name)) {
          recordHook(node.property.name, rel, node.loc.start.line)
        }
      } else if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
        if (isNamedRef(node.object, 'actions', actionAliases)) {
          recordAction(node.property.value, rel, node.loc.start.line)
        }
        if (isNamedRef(node.object, 'hooks', hookAliases) && /^use[A-Z]/.test(node.property.value)) {
          recordHook(node.property.value, rel, node.loc.start.line)
        }
      }
    }

    // Static `for (const name of ['openBrowser', ...]) { ... actions[name] ... }` loops.
    if (node.type === 'ForOfStatement' && node.right?.type === 'ArrayExpression') {
      const names = node.right.elements
        .filter(el => el?.type === 'Literal' && typeof el.value === 'string')
        .map(el => el.value)
      const loopVar = node.left?.type === 'VariableDeclaration'
        ? node.left.declarations?.[0]?.id?.name
        : (node.left?.type === 'Identifier' ? node.left.name : null)
      if (loopVar && names.length > 0) {
        walkAst(node.body, (inner) => {
          if (inner.type === 'MemberExpression' && inner.computed && inner.property?.type === 'Identifier' && inner.property.name === loopVar) {
            if (isNamedRef(inner.object, 'actions', actionAliases)) {
              for (const n of names) recordAction(n, rel, inner.loc.start.line)
            }
            if (isNamedRef(inner.object, 'hooks', hookAliases)) {
              for (const n of names) {
                if (/^use[A-Z]/.test(n)) recordHook(n, rel, inner.loc.start.line)
              }
            }
          }
        })
      }
    }

    // Object destructuring from `actions` / `hooks` (including `actions ?? {}` / `hooks || {}`).
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init) {
      if (isNamedRef(node.init, 'actions', actionAliases)) {
        extractPatternKeys(node.id, (name, prop) => recordAction(name, rel, prop.loc.start.line))
      }
      if (isNamedRef(node.init, 'hooks', hookAliases)) {
        extractPatternKeys(node.id, (name, prop) => {
          if (/^use[A-Z]/.test(name)) recordHook(name, rel, prop.loc.start.line)
        })
      }
    }

    // Component parameter destructuring: `function Comp({...})`, `export const Comp = ({...}) =>`,
    // `memo(function Comp({...}) {})`, `memo(({...}) => ...)`, `forwardRef(...)`.
    if (node.type === 'FunctionDeclaration' && node.id?.name && /^[A-Z]/.test(node.id.name)) {
      collectComponentParam(node, recordAction, recordHook, rel)
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && /^[A-Z]/.test(node.id.name)) {
      const init = node.init
      if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
        collectComponentParam(init, recordAction, recordHook, rel)
      }
    }
    if (node.type === 'CallExpression') {
      const calleeName = node.callee?.type === 'Identifier'
        ? node.callee.name
        : (node.callee?.type === 'MemberExpression' && !node.callee.computed ? node.callee.property?.name : null)
      if ((calleeName === 'memo' || calleeName === 'forwardRef') && node.arguments?.[0]) {
        const arg = node.arguments[0]
        if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
          collectComponentParam(arg, recordAction, recordHook, rel)
        }
      }
    }
  })
}

function collectReferences(files) {
  const actions = new Map()
  const hooks = new Map()
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = fs.readFileSync(file, 'utf8')
    collectSourceReferences(source, rel, actions, hooks)
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
    nodePaths: [path.join(REPO_ROOT, 'app/node_modules')],
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
    require: id => (
      id === 'react'
        ? {
            ...realReact,
            useRef: initial => ({ current: initial }),
            useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
          }
        : id === 'react-dom'
          ? realReactDom
          : {}
    ),
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
  return {
    team,
    calls,
    kv,
    emitFeed: (event, data) => emitFeed(event, data),
    publishDesktopAccountState: mod.exports.publishDesktopAccountState,
    subscribeDesktopAccountState: mod.exports.subscribeDesktopAccountState,
  }
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
    require: id => (
      id === 'react'
        ? {
            ...realReact,
            useRef: initial => ({ current: initial }),
            useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
          }
        : id === 'react-dom'
          ? realReactDom
          : {}
    ),
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

    // Multi-block unnumbered feed reply (same seq, distinct block ordinals, no item.turn) aggregates on one turn without spawning a phantom turn.
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'build status?', time: 3000 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'The build passed.', seq: 42, block: 0, time: 3100 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'All 12 checks passed.', seq: 42, block: 1, time: 3101 } })
    const outline3 = team.snapshots.sessions().byId['sess-a']?.projectionValues?.turnOutline
    assert.equal(outline3.length, 3)
    assert.equal(outline3[2].turn, 2)
    assert.equal(outline3[2].response, 'The build passed.\n\nAll 12 checks passed.')
    assert.equal(team.actions.closingReply('sess-a', 2), 'The build passed.\n\nAll 12 checks passed.')

    // Canonical transcript facts discard synthetic phantom turns and recognize `status: 'closed'` for textless turns.
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'phantom turn 3', seq: 98, time: 3200 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'phantom turn 4', seq: 99, time: 3250 } })
    assert.equal(team.snapshots.sessions().byId['sess-a']?.projectionValues?.turnOutline?.length, 5)
    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed' }],
        [1, { turn: 1, status: 'closed' }],
        [2, { turn: 2, status: 'closed' }],
        [3, { turn: 3, status: 'closed' }],
      ]),
      closingReplies: new Map([
        [0, 'reply round 1'],
        [1, 'reply round 2'],
        [2, 'The build passed.\n\nAll 12 checks passed.'],
        [3, ''],
      ]),
    })
    assert.equal(team.actions.closingReply('sess-a', 3), '')
    const syncedOutline = team.snapshots.sessions().byId['sess-a']?.projectionValues?.turnOutline
    assert.deepEqual(Array.from(syncedOutline, entry => entry.turn), [0, 1, 2, 3])
    assert.equal(syncedOutline[3].response, undefined)

    // Blocking #4: while a turn's canonical status is 'open', closingReply must return undefined
    // (never leak intermediate progress text) and only resolve once the turn closes.
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'bot', text: 'progress msg', turn: 4, seq: 110, time: 4000 } })
    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed' }],
        [1, { turn: 1, status: 'closed' }],
        [2, { turn: 2, status: 'closed' }],
        [3, { turn: 3, status: 'closed' }],
        [4, { turn: 4, status: 'open' }],
      ]),
      closingReplies: new Map([
        [0, 'reply round 1'],
        [1, 'reply round 2'],
        [2, 'The build passed.\n\nAll 12 checks passed.'],
        [3, ''],
      ]),
    })
    assert.equal(team.actions.closingReply('sess-a', 4), undefined, 'open turn must not leak intermediate progress text')
    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed' }],
        [1, { turn: 1, status: 'closed' }],
        [2, { turn: 2, status: 'closed' }],
        [3, { turn: 3, status: 'closed' }],
        [4, { turn: 4, status: 'closed' }],
      ]),
      closingReplies: new Map([
        [0, 'reply round 1'],
        [1, 'reply round 2'],
        [2, 'The build passed.\n\nAll 12 checks passed.'],
        [3, ''],
        [4, 'final reply'],
      ]),
    })
    assert.equal(team.actions.closingReply('sess-a', 4), 'final reply')
  } finally {
    stop()
  }
})

test('desktop account bridge syncs bidirectionally with Settings Account and fetches details on sign-in', async () => {
  let accountStateCalls = []
  const { team, publishDesktopAccountState, subscribeDesktopAccountState } = await createDesktopHarness({
    callHandler: async (endpoint, body) => {
      if (endpoint === 'state') return { revision: 1, modelsKey: 'm1', bots: [], rooms: [] }
      if (endpoint === 'engine-account-state') {
        accountStateCalls.push(body)
        if (body?.details === true) {
          return { available: true, view: { status: 'credential-stored', attempt: null, profile: { name: 'Tester' }, balance: { total: '10' } } }
        }
        return { available: true, view: { status: 'signed-out', attempt: null } }
      }
      if (endpoint === 'engine-account-signout') {
        return { available: true, view: { status: 'signed-out', attempt: null } }
      }
      return {}
    },
  })
  const stop = team.start()
  const received = []
  const offExternal = typeof subscribeDesktopAccountState === 'function'
    ? subscribeDesktopAccountState(reply => received.push(reply))
    : () => {}
  try {
    await new Promise(resolve => setImmediate(resolve))
    const ops = team.actions.signInEntry().inject()
    const accountHook = ops.hooks.account
    assert.equal(accountHook.getSnapshot().view?.status, 'signed-out')

    // Settings → sidebar: sign-in updates sidebar bridge and triggers details: true if profile/balance missing.
    publishDesktopAccountState({ available: true, view: { status: 'credential-stored', attempt: null } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(accountHook.getSnapshot().view?.status, 'credential-stored')
    assert.equal(accountStateCalls.some(body => body?.details === true), true, 'signing in triggers details: true fetch')

    // Sidebar → Settings: signOut broadcasts signed-out state back to external subscribers (AccountSettingsPage).
    received.length = 0
    await ops.signOut()
    assert.equal(accountHook.getSnapshot().view?.status, 'signed-out')
    assert.equal(received.some(entry => entry?.view?.status === 'signed-out'), true, 'sidebar signOut broadcasts to Settings subscribers')
  } finally {
    offExternal()
    stop()
  }
})

test('desktop team wires watchBotCompletions, selectPanel union, File[] draftFiles, openAppUpdates, mixed-queue steerQueued, navSeq, and DeepSeek sign-in', async () => {
  let dshOpened = false
  let ownAppOpened = false
  const { team, calls, emitFeed } = await createDesktopHarness({
    dshUpdates: {
      status: async () => ({ phase: 'available', version: '0.2.5' }),
      open: async () => { dshOpened = true },
      subscribe: () => () => {},
    },
    ownAppUpdates: {
      state: async () => ({}),
      check: async () => {},
      install: async () => {},
      open: async () => { ownAppOpened = true },
      download: async () => {},
      setAutoUpdate: async () => {},
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
            'sess-a': [
              { id: 'q-bot', source: { kind: 'ds-bot', role: 'reply' }, content: [{ type: 'text', text: 'relay' }] },
              { id: 'q-user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
            ],
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

    // Blocking #3: inflated background synthetic turns -> open chat -> canonical noteTurnFacts prunes
    // phantom turn -> switch away -> next real background completion MUST still light up the unread dot.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'bg step 1', seq: 10, time: 3000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'bg step 2', seq: 11, time: 3050 } })
    assert.equal(team.snapshots.status().get('sess-b')?.completionUnread, true)
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], true)

    // Open bot-b (seen advances on inflated outline [0, 1]), then reconcile to canonical turn [0].
    team.actions.openSession('bot-b')
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], undefined)
    team.actions.noteTurnFacts('sess-b', {
      turns: new Map([[0, { turn: 0, status: 'closed' }]]),
      closingReplies: new Map([[0, 'bg step 2']]),
    })

    // Switch back to bot-a, then bot-b finishes real turn 1 in the background.
    team.actions.openSession('bot-a')
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'real turn 1', turn: 1, seq: 20, time: 4000 } })
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], true, 'unread dot must light up on real turn 1 after phantom cleanup')

    // Blocking #5: selectPanel union routes workspace tabs, explicit settings pages, and unknown -> overview.
    team.actions.selectPanel('files')
    assert.equal(team.snapshots.ui().rightPanel?.tab, 'files')
    team.actions.selectPanel('schedules')
    assert.equal(team.snapshots.ui().settings?.page, 'schedules')
    team.actions.selectPanel('plugins')
    assert.equal(team.snapshots.ui().settings?.page, 'plugins')
    team.actions.selectPanel('connectors')
    assert.equal(team.snapshots.ui().settings?.page, 'connectors')
    team.actions.selectPanel('unknown-panel-xyz')
    assert.equal(team.snapshots.ui().settings?.page, 'overview')

    // Blocking #1: restoreDraftFiles accepts real File[] as passed by composer.js:581 and derives image/file kind.
    const txtFile = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const pngFile = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    const ids = team.actions.restoreDraftFiles('sess-a', [txtFile, pngFile])
    assert.equal(ids.length, 2)
    const resolved = team.actions.draftFiles(ids)
    assert.equal(resolved.length, 2)
    assert.equal(resolved[0].kind, 'file')
    assert.equal(resolved[0].file, txtFile)
    assert.equal(resolved[1].kind, 'image')
    assert.equal(resolved[1].file, pngFile)
    team.actions.releaseDraftFiles(ids)
    assert.equal(team.actions.draftFiles(ids).length, 0)

    // openAppUpdates opens DSH updates only when verified version matches.
    await team.actions.openAppUpdates('0.2.5')
    assert.equal(dshOpened, true)
    assert.equal(ownAppOpened, false)

    // Blocking #2: steerQueued filters real `{ kind }` source objects and only sends user rows.
    await team.actions.steerQueued('sess-a')
    const steerCall = calls.find(entry => entry.endpoint === 'bot-steer-queue')
    assert.ok(steerCall)
    assert.deepEqual(Array.from(steerCall.body?.ids ?? []), ['q-user'])

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

test('openAppUpdates is a no-op when DSH appUpdates bridge is unavailable', async () => {
  let ownAppOpened = false
  const { team } = await createDesktopHarness({
    ownAppUpdates: {
      state: async () => ({}),
      check: async () => {},
      install: async () => {},
      open: async () => { ownAppOpened = true },
      download: async () => {},
      setAutoUpdate: async () => {},
      subscribe: () => () => {},
    },
    callHandler: async () => ({ revision: 1, modelsKey: 'm1', bots: [], rooms: [] }),
  })
  await team.actions.openAppUpdates('0.2.5')
  assert.equal(ownAppOpened, false)
})

test('AST collector detects computed indexing, memo/arrow components, hooks destructuring, fallback destructuring, nested params, and aliases', () => {
  const sample = `
    export const A = memo(function A({ useAlpha, actions: { nestedAct } }) {
      const { useBeta } = hooks ?? {}
      const { fallbackAct } = actions ?? {}
      const a = actions
      a.aliasAct()
      actions['literalAct']()
      for (const name of ['loopActOne', 'loopActTwo']) {
        if (actions[name]) actions[name]()
      }
      return null
    })
    export const B = ({ useGamma, hooks: { useDelta } }) => null
  `
  const actions = new Map()
  const hooks = new Map()
  collectSourceReferences(sample, 'sample.js', actions, hooks)
  assert.deepEqual([...actions.keys()].sort(), ['aliasAct', 'fallbackAct', 'literalAct', 'loopActOne', 'loopActTwo', 'nestedAct'])
  assert.deepEqual([...hooks.keys()].sort(), ['useAlpha', 'useBeta', 'useDelta', 'useGamma'])
})

test('resumed feed replay and fillGap canonical facts do not duplicate synthetic turns or corrupt unread boundary', async () => {
  const { team, emitFeed } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [
            { id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' },
            { id: 'bot-b', sessionId: 'sess-b', name: 'Beta' },
          ],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')

    // Bot B replies in background (unnumbered feed item at seq 10), then user opens and reads Bot B.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'first reply', seq: 10, time: 1000 } })
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], true)
    team.actions.openSession('bot-b')
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], undefined)

    // Transcript fillGap / historyReloaded publishes canonical facts covering through seq 30 (turns 0 and 1).
    team.actions.noteTurnFacts('sess-b', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 1, time: 900 }, end: { seq: 12, time: 1000 } }],
        [1, { turn: 1, status: 'closed', start: { seq: 20, time: 1900 }, end: { seq: 30, time: 2000 } }],
      ]),
      closingReplies: new Map([
        [0, 'first reply'],
        [1, 'backfilled reply'],
      ]),
    })
    team.actions.openSession('bot-a')

    // Resumed SSE reconnect replays seq 10 (already seen) and seq 25 (already covered by canonical facts).
    emitFeed('hello', { revision: 1, feedSeq: 30, resumed: true })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'first reply', seq: 10, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'backfilled reply', seq: 25, time: 2000 } })

    const outlineAfterReplay = team.snapshots.sessions().byId['sess-b']?.projectionValues?.turnOutline
    assert.deepEqual(Array.from(outlineAfterReplay, entry => entry.turn), [0, 1])
    assert.equal(outlineAfterReplay[0].response, 'first reply')
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], undefined, 'replayed/covered feed items must not create phantom turns or false unread dot')

    // A genuinely new background turn (turn 2, seq 40) still lights up the unread dot cleanly.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'new reply', turn: 2, seq: 40, block: 0, time: 3000 } })
    assert.equal(team.hooks.useBotCompletions(v => v)['sess-b'], true)
  } finally {
    stop()
  }
})

test('DM with historical turnOutline keeps NewMessagePills baseline aligned across loadEarlier and first live reply', async () => {
  const { team } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [{ id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' }],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  // Exact selector used by ds-bot/src/client/header.js NewMessagePills.
  const pillReplies = (list, sid) => {
    const row = list.byId?.[sid]
    if (typeof row?.replyCount === 'number') return row.replyCount
    const outline = list.projectionsBySession?.[sid]?.values?.turnOutline ?? row?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.reduce((count, entry) => count + (entry.response ? 1 : 0), 0) : 0
  }
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')

    // Opening snapshot backfills 3 historical responded turns into turnOutline.
    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 1, time: 100 }, end: { seq: 2, time: 110 } }],
        [1, { turn: 1, status: 'closed', start: { seq: 3, time: 200 }, end: { seq: 4, time: 210 } }],
        [2, { turn: 2, status: 'closed', start: { seq: 5, time: 300 }, end: { seq: 6, time: 310 } }],
      ]),
      closingReplies: new Map([
        [0, 'old reply 0'],
        [1, 'old reply 1'],
        [2, 'old reply 2'],
      ]),
    })

    // User scrolls up: NewMessagePills captures the baseline.
    const base = pillReplies(team.snapshots.sessions(), 'sess-a')

    // Loading earlier history adds more historical turns to turnOutline without showing a false pill.
    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 1, time: 100 }, end: { seq: 2, time: 110 } }],
        [1, { turn: 1, status: 'closed', start: { seq: 3, time: 200 }, end: { seq: 4, time: 210 } }],
        [2, { turn: 2, status: 'closed', start: { seq: 5, time: 300 }, end: { seq: 6, time: 310 } }],
        [3, { turn: 3, status: 'closed', start: { seq: 7, time: 400 }, end: { seq: 8, time: 410 } }],
      ]),
      closingReplies: new Map([
        [0, 'old reply 0'],
        [1, 'old reply 1'],
        [2, 'old reply 2'],
        [3, 'old reply 3'],
      ]),
    })
    assert.equal(pillReplies(team.snapshots.sessions(), 'sess-a') - base, 0, 'loading historical turns must not trigger a false new-message pill')

    // First live tail reply arrives -> fresh MUST equal 1 (never negative).
    team.actions.noteReplyArrival('sess-a', 1)
    assert.equal(pillReplies(team.snapshots.sessions(), 'sess-a') - base, 1, 'first live reply after opening history must yield fresh === 1')

    // Second live tail reply arrives -> fresh MUST equal 2.
    team.actions.noteReplyArrival('sess-a', 1)
    assert.equal(pillReplies(team.snapshots.sessions(), 'sess-a') - base, 2, 'second live reply must yield fresh === 2')
  } finally {
    stop()
  }
})

test('same-seq repeated text blocks all arrive on first delivery and are skipped cleanly on resumed replay', async () => {
  const { team, emitFeed } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [
            { id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' },
            { id: 'bot-b', sessionId: 'sess-b', name: 'Beta' },
          ],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')

    // First delivery: assistant message at seq 42 emits three blocks with identical text at blocks 0 and 2.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Ready', seq: 42, block: 0, turn: 0, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Set', seq: 42, block: 1, turn: 0, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Ready', seq: 42, block: 2, turn: 0, time: 1000 } })

    const rowAfterFirst = team.snapshots.sessions().byId['sess-b']
    assert.equal(rowAfterFirst?.projectionValues?.turnOutline?.[0]?.response, 'Ready\n\nSet\n\nReady', 'identical text blocks within the same seq must all survive first delivery')
    assert.equal(team.actions.closingReply('sess-b', 0), 'Ready\n\nSet\n\nReady')
    assert.equal(rowAfterFirst?.replyCount, 1, 'multi-block message increments replyCount once')

    // Resumed reconnect replays all three frames (plus an older seq): every frame must be skipped.
    emitFeed('hello', { revision: 1, feedSeq: 50, resumed: true })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'stale', seq: 40, block: 0, turn: 0, time: 900 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Ready', seq: 42, block: 0, turn: 0, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Set', seq: 42, block: 1, turn: 0, time: 1000 } })
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Ready', seq: 42, block: 2, turn: 0, time: 1000 } })

    const rowAfterReplay = team.snapshots.sessions().byId['sess-b']
    assert.equal(rowAfterReplay?.projectionValues?.turnOutline?.length, 1)
    assert.equal(rowAfterReplay?.projectionValues?.turnOutline?.[0]?.response, 'Ready\n\nSet\n\nReady', 'resumed replay must not duplicate blocks')
    assert.equal(team.actions.closingReply('sess-b', 0), 'Ready\n\nSet\n\nReady')
    assert.equal(rowAfterReplay?.replyCount, 1, 'resumed replay must not double-count replyCount')

    // Subsequent newer seq still delivers cleanly.
    emitFeed('message', { sessionId: 'sess-b', item: { kind: 'bot', text: 'Go', seq: 43, block: 0, turn: 1, time: 2000 } })
    const rowAfterNext = team.snapshots.sessions().byId['sess-b']
    assert.equal(rowAfterNext?.projectionValues?.turnOutline?.length, 2)
    assert.equal(rowAfterNext?.projectionValues?.turnOutline?.[1]?.response, 'Go')
    assert.equal(rowAfterNext?.replyCount, 2)
  } finally {
    stop()
  }
})

test('sent-confirm queue clears when history arrives before feed confirm and does not hang', async () => {
  const { team, emitFeed } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [{ id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' }],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')
    const pendingOf = () => team.sessionHook('sess-a')(s => s.pendingSubmissions)

    // Case 1a: turnFacts covers the seq (turns only, no userMessages) BEFORE feed confirm arrives.
    team.actions.noteSent('sess-a', { requestId: 'req-1', text: 'hello first', time: 1000 })
    assert.equal(pendingOf().length, 1)

    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 10, time: 1000 }, end: { seq: 12, time: 1050 } }],
      ]),
      closingReplies: new Map([[0, 'hi']]),
    })
    assert.equal(pendingOf().length, 1, 'turns-only facts without userMessages keeps pending until user confirm arrives')

    // Feed user confirm arrives with seq 10 <= maxCoveredSeqOf (coveredByFacts === true): MUST still clear pending!
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'hello first', seq: 10, block: 0, time: 1000 } })
    assert.equal(pendingOf().length, 0, 'coveredByFacts feed confirm must still clear pending queue')

    // Case 1b: history facts with userMessages arrive FIRST -> clears immediately even before feed confirm,
    // and delayed feed confirm must NOT pop a second queued message.
    team.actions.noteSent('sess-a', { requestId: 'req-2', text: 'second msg', time: 2000 })
    assert.equal(pendingOf().length, 1)

    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 10, time: 1000 }, end: { seq: 12, time: 1050 } }],
        [1, { turn: 1, status: 'open', start: { seq: 20, time: 2000 } }],
      ]),
      closingReplies: new Map([[0, 'hi']]),
      userMessages: [
        { seq: 10, text: 'hello first', time: 1000 },
        { seq: 20, text: 'second msg', time: 2000 },
      ],
    })
    assert.equal(pendingOf().length, 0, 'history userMessages clears matching pending submission without waiting on feed')

    // Queue a third message, then deliver delayed feed confirm for seq 20 -> third pending MUST remain intact.
    team.actions.noteSent('sess-a', { requestId: 'req-3', text: 'third msg', time: 3000 })
    assert.equal(pendingOf().length, 1)
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'second msg', seq: 20, block: 0, time: 2000 } })
    assert.equal(pendingOf().length, 1, 'delayed feed confirm already satisfied by history must not pop next pending')
    assert.equal(pendingOf()[0].requestId, 'req-3')
  } finally {
    stop()
  }
})

test('sent-confirm clears once on feed confirm and keeps a later queued pending intact when history arrives', async () => {
  const { team, emitFeed } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [{ id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' }],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')
    const pendingOf = () => team.sessionHook('sess-a')(s => s.pendingSubmissions)

    // Message 1 sent and confirmed via live feed BEFORE history arrives.
    team.actions.noteSent('sess-a', { requestId: 'req-1', text: 'msg one', time: 1000 })
    assert.equal(pendingOf().length, 1)
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'msg one', seq: 10, block: 0, time: 1000 } })
    assert.equal(pendingOf().length, 0, 'live feed confirm clears first pending submission')

    // Message 2 is now pending while history (including msg one + older earlier-page message) arrives.
    team.actions.noteSent('sess-a', { requestId: 'req-2', text: 'msg two', time: 2000 })
    assert.equal(pendingOf().length, 1)

    team.actions.noteTurnFacts('sess-a', {
      turns: new Map([
        [0, { turn: 0, status: 'closed', start: { seq: 1, time: 100 }, end: { seq: 5, time: 150 } }],
        [1, { turn: 1, status: 'open', start: { seq: 10, time: 1000 } }],
      ]),
      closingReplies: new Map([[0, 'earlier reply']]),
      userMessages: [
        { seq: 1, text: 'older history', time: 100 },
        { seq: 10, text: 'msg one', time: 1000 },
      ],
    })
    assert.equal(pendingOf().length, 1, 'history containing already-confirmed and older messages must leave second pending intact')
    assert.equal(pendingOf()[0].requestId, 'req-2')
    assert.equal(pendingOf()[0].text, 'msg two')
  } finally {
    stop()
  }
})

test('duplicate or replayed feed confirm pops only once and never removes a subsequent pending message', async () => {
  const { team, emitFeed } = await createDesktopHarness({
    callHandler: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [{ id: 'bot-a', sessionId: 'sess-a', name: 'Alpha' }],
          rooms: [],
        }
      }
      if (endpoint === 'engine-account-state') return { available: true, view: { status: 'signed-out', attempt: null } }
      return {}
    },
  })
  const stop = team.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    team.actions.openSession('bot-a')
    const pendingOf = () => team.sessionHook('sess-a')(s => s.pendingSubmissions)

    // Two messages queued (with metadata): confirm for #1 arrives twice (initial + resumed replay).
    team.actions.noteSent('sess-a', { requestId: 'req-1', text: 'alpha', time: 1000 })
    team.actions.noteSent('sess-a', { requestId: 'req-2', text: 'beta', time: 2000 })
    assert.equal(pendingOf().length, 2)

    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'alpha', seq: 10, block: 0, time: 1000 } })
    assert.equal(pendingOf().length, 1)
    assert.equal(pendingOf()[0].requestId, 'req-2')

    // Reconnect replay delivers seq 10 a second time: MUST NOT pop req-2!
    emitFeed('hello', { revision: 1, feedSeq: 20, resumed: true })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'alpha', seq: 10, block: 0, time: 1000 } })
    assert.equal(pendingOf().length, 1, 'duplicate/replayed confirm must not pop the second pending message')
    assert.equal(pendingOf()[0].requestId, 'req-2')

    // Confirm for #2 arrives and clears the queue cleanly.
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'beta', seq: 12, block: 0, time: 2000 } })
    assert.equal(pendingOf().length, 0)

    // Also verify bare 1-arg noteSent(sessionId) without metadata is protected against duplicate replays.
    team.actions.noteSent('sess-a')
    team.actions.noteSent('sess-a')
    assert.equal(pendingOf().length, 2)
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'bare 1', seq: 20, block: 0, time: 3000 } })
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'bare 1', seq: 20, block: 0, time: 3000 } })
    assert.equal(pendingOf().length, 1, 'duplicate confirm must pop bare noteSent queue only once')

    // Cancelling a failed send removes only that entry.
    const cancelFailed = team.actions.noteSent('sess-a', { requestId: 'req-fail', text: 'oops', time: 4000 })
    assert.equal(pendingOf().length, 2)
    cancelFailed()
    assert.equal(pendingOf().length, 1)
    emitFeed('message', { sessionId: 'sess-a', item: { kind: 'user', text: 'bare 2', seq: 22, block: 0, time: 4100 } })
    assert.equal(pendingOf().length, 0)
  } finally {
    stop()
  }
})
