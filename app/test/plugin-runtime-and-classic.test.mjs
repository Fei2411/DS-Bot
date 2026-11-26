import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const stubs = {
  'cells.js': 'export const workPhrase = () => ""\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const FishLogo = ({ size }) => ({ type: 'fish-logo', props: { size, children: [] } })
    export const IconUserOutlineMedium = ({ size }) => ({ type: 'icon-user', props: { size, children: [] } })
    export const IconAgentPresetOutlineMedium = ({ size }) => ({ type: 'icon-preset', props: { size, children: [] } })
    export const IconArchiveOutlineMedium = ({ size }) => ({ type: 'icon-archive', props: { size, children: [] } })
    export const IconSettingsOutlineMedium = ({ size }) => ({ type: 'icon-settings', props: { size, children: [] } })
    export const MarkdownText = ({ text }) => ({ type: 'markdown', props: { text, children: [text] } })
    export const writeClipboard = async () => true
    export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
    export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
  `,
}

const entryCode = `
  export { bustImportUrl, createPluginRuntime } from './ui/src/plugin-runtime.js'
  export {
    createSlotRegistry,
    ShellOverlayHost,
    SlotErrorBoundary,
    SETTINGS_SECTION_SLOT,
    SETTINGS_GENERAL_ITEM_SLOT,
    SHELL_OVERLAY_SLOT,
    TOOL_VIEW_SLOT,
  } from './ui/src/slots.js'
  export { extractSchemaFields } from './ui/src/engine-settings.js'
  export { createRetryableLazy, registerEngineSettingsPlugin, useDshSettingsBridge } from './ui/src/engine-settings-bridge.js'
  export { ClassicSidebar, ClassicHeader, AgentEmptyHero } from './ui/src/classic-sidebar.js'
  export { foregroundApprovalsOf } from './ui/src/approval-dock.js'
  export { CLASSIC_BROWSER_OWNER, createTeam } from './ui/src/team.js'
  export { createLocale, LANGUAGE_STORAGE_KEY } from './ui/src/locale.js'
  export { matchProviderId, ProviderLogo } from '../ds-bot/src/client/provider-logos.js'
  export { AppearancePage } from '../ds-bot/src/client/appearance-page.js'
  export { Switch } from '../ds-bot/src/client/bot-settings.js'
  export { allThemes } from '../ds-bot/src/client/themes.js'
`

const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'chunk4-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /(src\/client\/(cells|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'c4-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'c4-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'c4-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

let current
const slot = (make) => {
  const bucket = current.fiber
  const index = bucket.index++
  return bucket.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
class TestComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
}
const react = {
  Component: TestComponent,
  Fragment: 'fragment',
  Suspense: ({ children }) => children,
  lazy: (loader) => {
    const LazyStub = props => ({ type: 'lazy-stub', props: { loader, ...props, children: [] } })
    LazyStub._loader = loader
    return LazyStub
  },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(make, deps) {
    const cell = slot(() => ({}))
    if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
      cell.value = make()
      cell.deps = deps
    }
    return cell.value
  },
  useCallback: (fn, deps) => react.useMemo(() => fn, deps),
  useId: () => slot(() => ({ id: 'test-id' })).id,
  useEffect: effect,
  useLayoutEffect: effect,
  useSyncExternalStore(subscribe, getSnapshot) {
    const value = getSnapshot()
    effect(() => subscribe(() => {}), [subscribe])
    return value
  },
}

const memoryStorage = () => {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
    clear: () => { map.clear() },
  }
}

function loadMod(callHandler = async () => ({}), extraGlobals = {}) {
  const storage = memoryStorage()
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    localStorage: storage,
    sessionStorage: memoryStorage(),
    window: {
      location: { origin: 'http://127.0.0.1:41901' },
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: storage,
    },
    document: {
      body: { dataset: {}, style: { setProperty: () => {}, removeProperty: () => {} } },
      documentElement: { dataset: {} },
    },
    __testCall: callHandler,
    require(name) {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      throw new Error(`Unexpected require: ${name}`)
    },
    module: { exports: {} },
    exports: {},
    ...extraGlobals,
  }
  sandbox.exports = sandbox.module.exports
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)
  return { mod: sandbox.module.exports, storage }
}

function renderTree(Component, props = {}) {
  const fibers = new Map()
  const expand = (node, path = '0') => {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`))
    if (typeof node.type === 'function') {
      if (node.type.prototype && typeof node.type.prototype.render === 'function') {
        const instance = new node.type(node.props)
        try {
          return expand(instance.render(), `${path}:cls`)
        } catch (error) {
          if (typeof node.type.getDerivedStateFromError === 'function') {
            instance.state = { ...instance.state, ...node.type.getDerivedStateFromError(error) }
            instance.componentDidCatch?.(error)
            return expand(instance.render(), `${path}:cls-err`)
          }
          throw error
        }
      }
      const fiber = fibers.get(path) ?? { index: 0, slots: [] }
      fibers.set(path, fiber)
      fiber.index = 0
      const prev = current
      current = { fiber, effects: [] }
      let rendered
      try { rendered = node.type(node.props) } finally { current = prev }
      return expand(rendered, `${path}:fn`)
    }
    const children = (node.props?.children ?? []).map((child, i) => expand(child, `${path}.${i}`))
    return { ...node, props: { ...node.props, children } }
  }
  return expand({ type: Component, props })
}

function findAll(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const item of tree) findAll(item, predicate, out)
    return out
  }
  if (predicate(tree)) out.push(tree)
  for (const child of tree.props?.children ?? []) findAll(child, predicate, out)
  return out
}

test('Cordis-style plugin runtime handles provide/inject lifecycle, themes, slots, fault isolation, and retry', async () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })

  const events = []
  const Widget = () => ({ type: 'div', props: { children: ['ok'] } })

  // Plugin depending on a service waits until the service is provided.
  const disposeDependent = runtime.use({ id: 'ext.viewer', inject: ['data'] }, (ctx) => {
    events.push(`start:${ctx.get('data')}`)
    ctx.slot({ name: mod.TOOL_VIEW_SLOT, key: 'custom_tool' }, Widget)
    ctx.theme('ocean', {
      label: 'Ocean',
      light: { bg: '#f0f8ff', sidebar: '#e0f0ff', bubble: '#d0e8ff', card: '#ffffff', text: '#102030', user: '#102030', userText: '#ffffff', accent: '#0066cc' },
      dark: { bg: '#0b1622', sidebar: '#102030', bubble: '#1a2c40', card: '#142436', text: '#eef6ff', user: '#eef6ff', userText: '#0b1622', accent: '#4da3ff' },
    })
    ctx.effect(() => () => events.push('cleanup'))
  })

  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.viewer').status, 'waiting')
  assert.equal(slots.resolve(mod.TOOL_VIEW_SLOT, 'custom_tool'), undefined)
  assert.equal(mod.allThemes().ocean, undefined)

  // Providing the service activates the waiting plugin, registering slot & theme.
  const dropData = runtime.provide('data', 'v1')
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.viewer').status, 'active')
  assert.equal(slots.resolve(mod.TOOL_VIEW_SLOT, 'custom_tool'), Widget)
  assert.equal(mod.allThemes().ocean?.label, 'Ocean')
  assert.deepEqual(events, ['start:v1'])

  // Removing the service automatically disposes slot, theme, and effect cleanup!
  dropData()
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.viewer').status, 'waiting')
  assert.equal(slots.resolve(mod.TOOL_VIEW_SLOT, 'custom_tool'), undefined)
  assert.equal(mod.allThemes().ocean, undefined)
  assert.deepEqual(events, ['start:v1', 'cleanup'])
  disposeDependent()

  // Fault isolation: throwing plugin fails alone, rolls back partial registrations, and supports retry.
  let shouldThrow = true
  const FlakyView = () => ({ type: 'span', props: { children: ['recovered'] } })
  runtime.use({ id: 'ext.flaky' }, (ctx) => {
    ctx.slot({ name: mod.SHELL_OVERLAY_SLOT, id: 'flaky' }, FlakyView)
    if (shouldThrow) throw new Error('boom during init')
  })
  const HealthyView = () => ({ type: 'span', props: { children: ['healthy'] } })
  runtime.use({ id: 'ext.healthy' }, (ctx) => {
    ctx.slot({ name: mod.SHELL_OVERLAY_SLOT, id: 'healthy' }, HealthyView)
  })

  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.flaky').status, 'error')
  assert.match(runtime.getSnapshot().find(p => p.id === 'ext.flaky').error, /boom during init/)
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).some(e => e.id === 'flaky'), false, 'partial slot registration rolled back on throw')
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).some(e => e.id === 'healthy'), true, 'healthy sibling unaffected')

  shouldThrow = false
  assert.equal(runtime.retry('ext.flaky'), true)
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.flaky').status, 'active')
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).some(e => e.id === 'flaky'), true)

  // Async rejection is also isolated and rolled back cleanly.
  runtime.use({ id: 'ext.async-bad' }, async (ctx) => {
    ctx.slot({ name: mod.SHELL_OVERLAY_SLOT, id: 'async-bad' }, FlakyView)
    await Promise.resolve()
    throw new Error('async boom')
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.async-bad').status, 'error')
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).some(e => e.id === 'async-bad'), false)

  // Forced retry on an active service-providing plugin must NOT re-enter reconcile during deactivate(),
  // must run apply() exactly once per retry, and must leak zero slots or services on unload.
  let providerActivations = 0
  let providerCleanups = 0
  let depActivations = 0
  const ProviderSlotView = () => ({ type: 'span', props: { children: ['provider'] } })
  const disposeProvider = runtime.use({ id: 'ext.provider' }, (ctx) => {
    providerActivations += 1
    ctx.provide('shared.svc', `gen-${providerActivations}`)
    ctx.slot({ name: mod.SHELL_OVERLAY_SLOT, id: `provider-slot-${providerActivations}` }, ProviderSlotView)
    return () => {
      providerCleanups += 1
      // Re-entrant retry during disposal must be ignored (single-flight).
      runtime.retry('ext.provider', { force: true })
    }
  })
  const disposeDep = runtime.use({ id: 'ext.dep', inject: ['shared.svc'] }, () => {
    depActivations += 1
  })
  assert.equal(providerActivations, 1)
  assert.equal(depActivations, 1)

  assert.equal(runtime.retry('ext.provider', { force: true }), true)
  assert.equal(providerActivations, 2, 'forced retry on service-providing plugin must activate exactly once')
  assert.equal(providerCleanups, 1, 'prior generation disposed cleanly once')
  assert.equal(depActivations, 2, 'dependent re-activated cleanly with new service')
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).filter(e => e.pluginId === 'ext.provider').length, 1, 'zero leaked slots from prior generation')

  disposeDep()
  disposeProvider()
  assert.equal(slots.list(mod.SHELL_OVERLAY_SLOT).filter(e => e.pluginId === 'ext.provider').length, 0, 'all slots cleaned up on unload')
  assert.equal(runtime.has('shared.svc'), false, 'provided service cleaned up on unload')
})

test('extractSchemaFields decodes Schemastery toJSON graphs including enums, nested objects, and redacted secrets', () => {
  const { mod } = loadMod()
  const schema = {
    uid: 17,
    refs: {
      2: { type: 'number', meta: { default: 30, min: 1, max: 200, description: 'Max turns' } },
      5: { type: 'boolean', meta: { default: true } },
      6: { type: 'const', meta: {}, value: 'auto' },
      7: { type: 'const', meta: {}, value: 'strict' },
      9: { type: 'union', meta: { default: 'auto' }, list: [6, 7] },
      11: { type: 'string', meta: { role: 'secret' } },
      12: { type: 'string', meta: { hidden: true } },
      15: { type: 'number', meta: { min: 1, max: 600, default: 30 } },
      16: { type: 'object', meta: {}, dict: { timeout: 15 } },
      17: {
        type: 'object',
        meta: {},
        dict: { maxTurns: 2, enabled: 5, mode: 9, apiKey: 11, internalFlag: 12, nested: 16 },
      },
    },
  }
  const fields = mod.extractSchemaFields(
    schema,
    { maxTurns: 40, enabled: false, mode: 'strict', nested: { timeout: 45 } },
    [{ path: ['apiKey'], set: true }],
  )
  assert.deepEqual(Array.from(fields, f => [Array.from(f.path).join('.'), f.kind]), [
    ['maxTurns', 'number'],
    ['enabled', 'boolean'],
    ['mode', 'select'],
    ['apiKey', 'secret'],
    ['nested.timeout', 'number'],
  ])
  assert.equal(fields.find(f => f.path[0] === 'maxTurns').value, 40)
  assert.equal(fields.find(f => f.path[0] === 'enabled').value, false)
  assert.equal(fields.find(f => f.path[0] === 'mode').options.length, 2)
  assert.equal(fields.find(f => f.path[0] === 'apiKey').isSet, true)
  assert.equal(fields.find(f => f.path.join('.') === 'nested.timeout').value, 45)
})

test('Engine settings plugin registers all sections + session-log item, and AppearancePage disables Window material when a background is set', () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })
  mod.registerEngineSettingsPlugin(runtime)

  const sectionIds = Array.from(slots.list(mod.SETTINGS_SECTION_SLOT), entry => entry.id)
  assert.deepEqual(sectionIds, ['account', 'plugins', 'agent-presets', 'archived-sessions'])
  assert.deepEqual(Array.from(slots.list(mod.SETTINGS_GENERAL_ITEM_SLOT), entry => entry.id), ['language', 'session-log-deepseek'])

  // Bot mode hides Archived sessions from the Settings bridge; Classic Agent mode exposes it.
  const Probe = ({ surfaceMode }) => {
    const bridge = mod.useDshSettingsBridge(slots, { surfaceMode })
    return { type: 'probe', props: { ids: bridge.sections.map(s => s.id), items: bridge.items.map(i => i.id), children: [] } }
  }
  const botBridge = renderTree(Probe, { surfaceMode: 'bot' })
  assert.deepEqual(Array.from(botBridge.props.ids), ['account', 'plugins', 'agent-presets'])
  assert.deepEqual(Array.from(botBridge.props.items), ['language', 'session-log-deepseek'])
  const agentBridge = renderTree(Probe, { surfaceMode: 'agent' })
  assert.deepEqual(Array.from(agentBridge.props.ids), ['account', 'plugins', 'agent-presets', 'archived-sessions'])

  const Section = ({ children }) => ({ type: 'section', props: { children } })
  const Row = ({ label, children }) => ({ type: 'row', props: { label, children } })
  const Choice = () => ({ type: 'choice', props: { children: [] } })

  // Without custom background: Window material switch is enabled and on by default.
  const saved = []
  const actions = { setPrefs: patch => { saved.push(patch); return Promise.resolve() } }
  const treeDefault = renderTree(mod.AppearancePage, {
    roster: { prefs: {} },
    actions,
    run: p => p,
    Section,
    Row,
    Choice,
    Switch: mod.Switch,
    ownWindow: true,
  })
  const materialSwitches = findAll(treeDefault, node => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === 'Window material')
  assert.equal(materialSwitches.length, 1)
  assert.equal(materialSwitches[0].props['aria-checked'], true)
  assert.equal(materialSwitches[0].props.disabled, false)
  materialSwitches[0].props.onClick()
  assert.deepEqual(structuredClone(saved[0]), { appearance: { material: false } })

  // With custom background: Window material switch turns off and disables cleanly.
  const treeWithBg = renderTree(mod.AppearancePage, {
    roster: { prefs: { appearance: { background: { kind: 'color', color: '#dfe6f5' }, material: true } } },
    actions,
    run: p => p,
    Section,
    Row,
    Choice,
    Switch: mod.Switch,
    ownWindow: true,
  })
  const disabledSwitches = findAll(treeWithBg, node => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === 'Window material')
  assert.equal(disabledSwitches.length, 1)
  assert.equal(disabledSwitches[0].props['aria-checked'], false)
  assert.equal(disabledSwitches[0].props.disabled, true)
})

test('Classic Agent mode preserves Bot and Classic positions across switches, supports single-flight create/rename/archive, and filters Classic approvals', async () => {
  const apiCalls = []
  const agentSessions = ['cs-1']
  let rev = 1
  const { mod } = loadMod(async (endpoint, payload) => {
    apiCalls.push([endpoint, payload])
    if (endpoint === 'state') {
      return {
        revision: rev,
        modelsKey: 'm1',
        bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1' }, { id: 'b2', name: 'Analyst', sessionId: 'b2' }],
        rooms: [],
        agents: [{ id: 'a1', name: 'DSH Agent', sessions: [...agentSessions], createdAt: 100 }],
        mainBotId: 'b1',
        prefs: {},
      }
    }
    if (endpoint === 'engine-classic-sessions') {
      return {
        sessions: agentSessions.map((id, i) => ({
          id,
          title: id === 'cs-1' ? 'First Classic' : '',
          updatedAt: 1000 + i * 100,
          running: false,
          blank: id !== 'cs-1',
        })),
      }
    }
    if (endpoint === 'agent-session') {
      const nextId = `cs-${agentSessions.length + 1}`
      agentSessions.push(nextId)
      rev += 1
      return { sessionId: nextId }
    }
    if (endpoint === 'agent-rename') {
      return true
    }
    if (endpoint === 'agent-archive') {
      const idx = agentSessions.indexOf(payload.sessionId)
      if (idx >= 0) agentSessions.splice(idx, 1)
      rev += 1
      return true
    }
    return {}
  })

  const team = mod.createTeam()
  // Hydrate initial roster via openSession after triggering pull through refreshClassicSessions.
  await team.actions.refreshClassicSessions()
  team.actions.openSession('b2')
  assert.equal(team.actions.surfaceMode(), 'bot')

  // Switch Bot -> Classic: remembers b2 and lands on cs-1.
  await team.actions.setSurface('agent')
  assert.equal(team.actions.surfaceMode(), 'agent')
  assert.equal(team.actions.isAgentSession('cs-1'), true)

  // Single-flight newAgentSession: two concurrent clicks create only one session.
  const [sA, sB] = await Promise.all([
    team.actions.newAgentSession('a1'),
    team.actions.newAgentSession('a1'),
  ])
  assert.equal(sA, 'cs-2')
  assert.equal(sB, 'cs-2')
  assert.equal(apiCalls.filter(([ep]) => ep === 'agent-session').length, 1)

  // Rename updates immediately.
  await team.actions.renameAgentSession('a1', 'cs-2', 'Refactor notes')

  // Switch Classic -> Bot: returns straight back to remembered b2!
  await team.actions.setSurface('bot')
  assert.equal(team.actions.surfaceMode(), 'bot')

  // Switch Bot -> Classic again: returns straight back to remembered cs-2!
  await team.actions.setSurface('agent')
  assert.equal(team.actions.surfaceMode(), 'agent')

  // Archive active cs-2 falls back to cs-1.
  await team.actions.archiveAgentSession('a1', 'cs-2')
  assert.deepEqual(agentSessions, ['cs-1'])

  // Classic Agent approvals match by sessionId when botId is undefined, excluding Bot/Room/Task approvals.
  const approvals = [
    { id: 'ap-classic', sessionId: 'cs-1', tool: 'bash' },
    { id: 'ap-bot', sessionId: 'b1', botId: 'b1', tool: 'bash' },
    { id: 'ap-room', sessionId: 'r1', roomId: 'r1', tool: 'bash' },
    { id: 'ap-task', sessionId: 'cs-1', taskId: 't1', tool: 'bash' },
  ]
  assert.deepEqual(Array.from(mod.foregroundApprovalsOf(approvals, undefined, 'cs-1'), a => a.id), ['ap-classic'])
  assert.deepEqual(Array.from(mod.foregroundApprovalsOf(approvals, 'b1', 'b1'), a => a.id), ['ap-bot'])
})

test('SlotErrorBoundary isolates a throwing shell.overlay plugin with Retry', () => {
  const { mod } = loadMod()
  const Broken = () => { throw new Error('overlay exploded') }
  const tree = renderTree(mod.SlotErrorBoundary, {
    slotName: 'shell.overlay:broken',
    resetKey: 'broken',
    children: [{ type: Broken, props: {} }],
  })
  const alerts = findAll(tree, node => node.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  const retryBtns = findAll(tree, node => node.type === 'button' && node.props?.children?.includes('Retry'))
  assert.equal(retryBtns.length, 1)
})

test('createLocale persists user language overrides, updates active translations live, and notifies listeners', () => {
  const { mod } = loadMod()
  const store = new Map()
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  const locale = mod.createLocale('en-US', { storage })
  locale.register('ds-bot', 'zh', { Language: '语言' })
  locale.register('ds-bot', 'ja', { Language: '言語' })
  const translate = locale.bind('ds-bot')
  assert.equal(locale.getLocale().active, 'en')
  assert.equal(locale.getLocale().preference, 'auto')
  assert.equal(translate('Language'), 'Language')

  const seen = []
  const off = locale.subscribe(next => seen.push(`${next.preference}:${next.active}`))
  locale.setLocale('zh')
  assert.equal(store.get(mod.LANGUAGE_STORAGE_KEY), 'zh')
  assert.equal(translate('Language'), '语言')

  // Restoring from storage keeps user preference across reloads.
  const reloaded = mod.createLocale('en-US', { storage })
  assert.equal(reloaded.getLocale().active, 'zh')
  assert.equal(reloaded.getLocale().preference, 'zh')

  locale.setLocale('auto')
  assert.equal(store.has(mod.LANGUAGE_STORAGE_KEY), false)
  assert.equal(translate('Language'), 'Language')
  off()
  assert.deepEqual(seen, ['zh:zh', 'auto:en'])
})

test('matchProviderId auto-matches major model providers from provider name or model family', () => {
  const { mod } = loadMod()
  assert.equal(mod.matchProviderId({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }), 'deepseek')
  assert.equal(mod.matchProviderId({ provider: 'custom-proxy', model: 'claude-sonnet-4-5' }), 'anthropic')
  assert.equal(mod.matchProviderId({ provider: 'custom', name: 'GPT-5' }), 'openai')
  assert.equal(mod.matchProviderId({ providerName: 'Google AI', model: 'gemini-2.5-pro' }), 'google')
  assert.equal(mod.matchProviderId({ provider: 'xai', model: 'grok-3' }), 'xai')
  assert.equal(mod.matchProviderId({ provider: 'dashscope', model: 'qwen3-coder' }), 'qwen')
  assert.equal(mod.matchProviderId({ provider: 'moonshot', model: 'kimi-k2' }), 'kimi')
  assert.equal(mod.matchProviderId({ provider: 'bigmodel', model: 'glm-4.7' }), 'zhipu')
  assert.equal(mod.matchProviderId({ provider: 'minimax', model: 'MiniMax-M1' }), 'minimax')
  assert.equal(mod.matchProviderId({ provider: 'mistral', model: 'codestral' }), 'mistral')
  assert.equal(mod.matchProviderId({ provider: 'ollama', model: 'llama-3.3' }), 'ollama')
  assert.equal(mod.matchProviderId({ provider: 'my-local-lab', model: 'tiny-custom-7b' }), null)

  // DeepSeek provider logo uses official whale geometry centered in a square viewBox.
  const dsSvg = mod.ProviderLogo({ provider: 'deepseek', size: 18 })
  assert.equal(dsSvg.type, 'svg')
  assert.equal(dsSvg.props.width, 18)
  assert.equal(dsSvg.props.height, 18)
  assert.equal(dsSvg.props.viewBox, '-0.5 -3.56 24.16 24.16')
})

test('ClassicSidebar exposes full-width + New session + hover Rename/Archive; ClassicHeader stays quiet on blank sessions and offers menu on named ones', () => {
  const { mod } = loadMod()
  const openedMenus = []
  const renamed = []
  const archived = []
  const created = []
  const actions = {
    openAgentSession: () => {},
    newAgentSession: id => { created.push(id); return Promise.resolve('s-new') },
    beginAgentRename: id => renamed.push(id),
    archiveAgentSession: (aid, sid) => { archived.push([aid, sid]); return Promise.resolve() },
    openMenu: menu => openedMenus.push(menu),
    toggleSidebar: () => {},
  }
  const agent = { id: 'a1', name: 'DSH Agent', sessions: ['s-blank', 's-named', 's-untitled', 's-turns'] }
  const roster = { agents: [agent], agentsById: { a1: agent }, readOnly: false }
  const sessions = {
    ids: ['s-blank', 's-named', 's-untitled', 's-turns'],
    byId: {
      's-blank': { id: 's-blank', title: 'workspace-folder', blank: true, updatedAt: 400, retainedBy: { mainView: 1 } },
      's-named': { id: 's-named', title: 'Audit logs', blank: false, updatedAt: 300, retainedBy: { mainView: 0 } },
      's-untitled': { id: 's-untitled', title: '', blank: false, updatedAt: 200, retainedBy: { mainView: 0 } },
      's-turns': { id: 's-turns', title: '', blank: true, projectionValues: { turnOutline: [{ id: 't1' }] }, updatedAt: 100, retainedBy: { mainView: 0 } },
    },
  }
  const useRoster = sel => sel(roster)
  const useSessions = sel => sel(sessions)
  const useSessionStatus = sel => sel(new Map())
  const useUi = sel => sel({ renameAgent: null })

  const sidebar = renderTree(mod.ClassicSidebar, { useRoster, useSessions, useSessionStatus, useUi, actions, wide: true })
  const newBtn = findAll(sidebar, n => n.type === 'button' && n.props?.className === 'dsb-classic-new')
  assert.equal(newBtn.length, 1, 'wide ClassicSidebar renders full-width + New session button')
  newBtn[0].props.onClick()
  assert.deepEqual(created, ['a1'])

  const rows = findAll(sidebar, n => n.props?.role === 'listitem')
  assert.equal(rows.length, 4)
  // Blank session displays "New session" rather than raw workspace folder title.
  const blankTitle = findAll(rows[0], n => n.props?.className === 'dsb-classic-title')[0]
  assert.deepEqual(blankTitle.props.children, ['New session'])
  // Every session row exposes Rename + Archive icon buttons.
  const rowActs = findAll(rows[1], n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-classic-act'))
  assert.equal(rowActs.length, 2)
  rowActs[0].props.onClick({ stopPropagation() {} })
  rowActs[1].props.onClick({ stopPropagation() {} })
  assert.deepEqual(renamed, ['s-named'])
  assert.deepEqual(archived, [['a1', 's-named']])

  // Blank session ClassicHeader renders a quiet borderless DSH header bar with ZERO action buttons or floating pill.
  const blankHeader = renderTree(mod.ClassicHeader, { sessionId: 's-blank', agent, useSessions, useSessionStatus, useUi, actions })
  assert.equal(blankHeader.type, 'header')
  assert.equal(blankHeader.props['data-blank'], '')
  assert.equal(findAll(blankHeader, n => String(n.props?.className ?? '').includes('bt-pill')).length, 0, 'ClassicHeader must not render DS Bot floating pill')
  assert.equal(findAll(blankHeader, n => n.type === 'button').length, 0, 'blank ClassicHeader shows no noisy action buttons')

  // Named session ClassicHeader renders a flat DSH header bar with a subtle More button opening the agent-session menu.
  const namedHeader = renderTree(mod.ClassicHeader, { sessionId: 's-named', agent, useSessions, useSessionStatus, useUi, actions })
  assert.equal(namedHeader.type, 'header')
  assert.equal(namedHeader.props.className, 'dsb-classic-bar')
  assert.equal(findAll(namedHeader, n => String(n.props?.className ?? '').includes('bt-pill')).length, 0)
  const moreBtns = findAll(namedHeader, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-classic-bar-more'))
  assert.equal(moreBtns.length, 1)
  moreBtns[0].props.onClick({ stopPropagation() {}, clientX: 200, clientY: 40 })
  assert.equal(openedMenus.length, 1)
  assert.equal(openedMenus[0].kind, 'agent-session')
  assert.equal(openedMenus[0].id, 's-named')

  // Untitled populated sessions (and sessions with turn outline) also expose the More menu.
  const untitledHeader = renderTree(mod.ClassicHeader, { sessionId: 's-untitled', agent, useSessions, useSessionStatus, useUi, actions })
  assert.equal(findAll(untitledHeader, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-classic-bar-more')).length, 1)
  const turnsHeader = renderTree(mod.ClassicHeader, { sessionId: 's-turns', agent, useSessions, useSessionStatus, useUi, actions })
  assert.equal(findAll(turnsHeader, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-classic-bar-more')).length, 1)
})

test('createPluginRuntime service stack handles out-of-order disposal without resurrecting disposed providers', () => {
  const { mod } = loadMod()
  const runtime = mod.createPluginRuntime()
  const releaseA = runtime.provide('svc', 'A')
  const releaseB = runtime.provide('svc', 'B')
  const releaseC = runtime.provide('svc', 'C')
  assert.equal(runtime.get('svc'), 'C')
  releaseB()
  assert.equal(runtime.get('svc'), 'C')
  releaseC()
  assert.equal(runtime.get('svc'), 'A', 'disposing C after B must restore A, never disposed B')
  releaseA()
  assert.equal(runtime.get('svc'), undefined)
})

test('Plugin runtime loads page-scoped plugins lazily and busts failed module imports on Retry', async () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })

  // bustImportUrl appends/updates the retry query parameter without breaking existing params or hash.
  assert.equal(mod.bustImportUrl('http://127.0.0.1:41901/plugins/demo.js', 1), 'http://127.0.0.1:41901/plugins/demo.js?retry=1')
  assert.equal(mod.bustImportUrl('http://127.0.0.1:41901/plugins/demo.js?v=2#top', 3), 'http://127.0.0.1:41901/plugins/demo.js?v=2&retry=3#top')

  // Per-page UI plugin stays idle and does not invoke load() until its page opens.
  const attempts = []
  let failOnce = true
  const Panel = () => ({ type: 'div', props: { children: ['loaded'] } })
  runtime.use({
    id: 'ext.settings-only',
    pages: ['settings'],
    load: async ({ attempt, bust }) => {
      attempts.push([attempt, bust('/plugins/demo.js')])
      if (failOnce) {
        failOnce = false
        throw new Error('transient import error')
      }
      return {
        apply(ctx) {
          ctx.slot({ name: mod.SETTINGS_SECTION_SLOT, id: 'custom-sec' }, Panel)
        },
      }
    },
  })
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.settings-only').status, 'idle')
  assert.deepEqual(attempts, [], 'unopened page plugin must not load')

  // Entering another page ('chat') still keeps 'settings' plugin unloaded.
  const leaveChat = runtime.enterPage('chat')
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.settings-only').status, 'idle')
  assert.deepEqual(attempts, [])
  leaveChat()

  // Entering 'settings' triggers load (attempt 0) -> fails in isolation -> retry() invokes attempt 1 and succeeds.
  const leaveSettings = runtime.enterPage('settings')
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.settings-only').status, 'error')
  assert.deepEqual(attempts, [[0, '/plugins/demo.js']])

  assert.equal(runtime.retry('ext.settings-only'), true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.settings-only').status, 'active')
  assert.deepEqual(attempts, [[0, '/plugins/demo.js'], [1, '/plugins/demo.js?retry=1']], 'retry re-runs loader with incremented attempt and busted URL')
  assert.equal(slots.list(mod.SETTINGS_SECTION_SLOT).some(e => e.id === 'custom-sec'), true)
  leaveSettings()
})

test('createRetryableLazy and SlotErrorBoundary Retry reset cached lazy wrapper and re-activate plugin', async () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })

  const seenAttempts = []
  const LazyComp = mod.createRetryableLazy(async (attempt) => {
    seenAttempts.push(attempt)
    return { Page: () => ({ type: 'div', props: { children: [`ok-${attempt}`] } }) }
  }, m => m.Page)

  assert.equal(LazyComp.attempt(), 0)
  const firstNode = renderTree(LazyComp, {})
  await firstNode.props.loader()
  assert.deepEqual(seenAttempts, [0])

  // SlotErrorBoundary Retry invokes onRetry (resetting lazy wrapper) and runtime.retry(pluginId, { force: true }).
  let retriedPlugin = 0
  runtime.use({ id: 'ext.widget' }, () => { retriedPlugin += 1 })
  assert.equal(retriedPlugin, 1)

  const Broken = () => { throw new Error('render boom') }
  const tree = renderTree(mod.SlotErrorBoundary, {
    slotName: 'settings.section:demo',
    resetKey: 'demo',
    pluginId: 'ext.widget',
    runtime,
    onRetry: () => { LazyComp.reset() },
    children: [{ type: Broken, props: {} }],
  })
  const retryBtn = findAll(tree, node => node.type === 'button' && node.props?.children?.includes('Retry'))[0]
  assert.ok(retryBtn)
  retryBtn.props.onClick()
  assert.equal(LazyComp.attempt(), 1, 'onRetry resets RetryableLazy attempt counter')
  assert.equal(retriedPlugin, 2, 'SlotErrorBoundary Retry re-activates plugin on runtime')
  const secondNode = renderTree(LazyComp, {})
  await secondNode.props.loader()
  assert.deepEqual(seenAttempts, [0, 1])
})

test('Classic mode browser pane opens, toggles, creates, and closes tabs under CLASSIC_BROWSER_OWNER', async () => {
  const fakeBridge = {
    onState: () => () => {},
    onNewTab: () => () => {},
    show: async () => {},
    hide: async () => {},
    close: async () => {},
    load: async () => {},
    back: async () => {},
    forward: async () => {},
    reload: async () => {},
    list: async () => [],
    tabs: async () => [],
  }
  const { mod } = loadMod(async (endpoint) => {
    if (endpoint === 'state') {
      return {
        revision: 1,
        modelsKey: 'm1',
        browser: true,
        bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1' }],
        rooms: [],
        agents: [{ id: 'a1', name: 'DSH Agent', sessions: ['cs-1'], createdAt: 100 }],
        mainBotId: 'b1',
        prefs: {},
      }
    }
    if (endpoint === 'engine-classic-sessions') {
      return { sessions: [{ id: 'cs-1', title: 'Classic', updatedAt: 1000, running: false, blank: false }] }
    }
    return {}
  }, { dsBotApp: { browser: fakeBridge } })

  const team = mod.createTeam()
  await team.actions.refreshClassicSessions()
  await team.actions.setSurface('agent')
  assert.equal(mod.CLASSIC_BROWSER_OWNER, 'classic')

  // Open browser in Classic mode -> binds BotPanel to classic session with browser view.
  team.actions.openBrowser('classic')
  let snap = null
  let tabsSnap = null
  const Probe = () => {
    snap = team.hooks.useUi(s => s)
    tabsSnap = team.hooks.useBrowserTabs(s => s)
    return null
  }
  renderTree(Probe, {})
  assert.equal(snap.details, 'cs-1')
  assert.equal(snap.view, 'browser')
  assert.equal(tabsSnap.classic.ids.length, 1)

  // New tab and close tabs cleanly closes panel when no workspace tabs remain.
  team.actions.browserNewTab('classic')
  renderTree(Probe, {})
  assert.equal(tabsSnap.classic.ids.length, 2)

  for (const tabId of [...tabsSnap.classic.ids]) {
    await team.actions.browserCloseTab('classic', tabId)
  }
  renderTree(Probe, {})
  assert.equal(snap.details, null, 'closing last Classic browser tab closes panel')
  assert.equal(snap.view, 'details')

  // Toggle browser opens and closes cleanly in Classic mode.
  team.actions.toggleBrowser('classic')
  renderTree(Probe, {})
  assert.equal(snap.view, 'browser')

  // Switching Classic sessions keeps an open Classic browser pane alive and rebinds its details id.
  team.actions.openAgentSession('cs-2')
  renderTree(Probe, {})
  assert.equal(snap.details, 'cs-2', 'Classic browser survives switching agent sessions')
  assert.equal(snap.view, 'browser')

  // Opening a workspace tab alongside Classic browser and closing the last workspace tab falls back to browser view.
  team.actions.openFiles()
  renderTree(Probe, {})
  assert.equal(snap.view, 'workspace')
  team.actions.closeWorkspaceTab('files')
  renderTree(Probe, {})
  assert.equal(snap.details, 'cs-2', 'closing last workspace tab keeps Classic browser open')
  assert.equal(snap.view, 'browser')
  assert.equal(snap.rightPanel, null)

  team.actions.toggleBrowser('classic')
  renderTree(Probe, {})
  assert.equal(snap.details, null)
})

test('ShellOverlayHost Retry calls runtime.retry() and resets plugin overlay components registered via runtime.use()', () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })

  let applyCount = 0
  let onRetryCalls = 0
  let resetCalls = 0
  let shouldCrash = true

  runtime.use({ id: 'ext.crash-overlay' }, (ctx) => {
    applyCount += 1
    const OverlayView = () => {
      if (shouldCrash) throw new Error('overlay render boom')
      return { type: 'div', props: { className: 'recovered-overlay', children: [`gen-${applyCount}`] } }
    }
    OverlayView.reset = () => { resetCalls += 1 }
    ctx.slot({
      name: mod.SHELL_OVERLAY_SLOT,
      id: 'crash-overlay',
      onRetry: () => { onRetryCalls += 1 },
    }, OverlayView)
  })

  assert.equal(applyCount, 1)
  const failedTree = renderTree(mod.ShellOverlayHost, { registry: slots, views: {} })
  const retryBtn = findAll(failedTree, node => node.type === 'button' && node.props?.children?.includes('Retry'))[0]
  assert.ok(retryBtn, 'ShellOverlayHost renders SlotErrorBoundary Retry button')

  shouldCrash = false
  retryBtn.props.onClick()
  assert.equal(applyCount, 2, 'ShellOverlayHost Retry must invoke runtime.retry() using top-level entry.pluginId/runtime')
  assert.equal(resetCalls, 1, 'ShellOverlayHost Retry calls component.reset()')
  assert.equal(onRetryCalls, 1, 'ShellOverlayHost Retry calls entry.onRetry()')

  const recoveredTree = renderTree(mod.ShellOverlayHost, { registry: slots, views: {} })
  assert.equal(findAll(recoveredTree, node => node.props?.className === 'recovered-overlay').length, 1)
})
