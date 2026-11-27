import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const stubs = {
  'cells.js': 'export const workPhrase = () => ""\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const writeClipboard = async () => true
  `,
}

const entryCode = `
  export {
    extractSchemaFields,
    formatFieldLabel,
    resolveFieldLabel,
    resolveLocalizedMetaText,
    safePluginIconUri,
    isCoreDsBotEntry,
    isBannedNamespace,
    isExcludedBundle,
    AccountSettingsPage,
    PluginsSettingsPage,
    AgentPresetsSettingsPage,
    ArchivedSessionsPage,
    SessionLogGeneralItem,
  } from './ui/src/engine-settings.js'
  export {
    SETTINGS_SECTION_ICON_SLOT,
    registerEngineSettingsPlugin,
    useDshSettingsBridge,
  } from './ui/src/engine-settings-bridge.js'
  export { createPluginRuntime } from './ui/src/plugin-runtime.js'
  export { createSlotRegistry, SETTINGS_SECTION_SLOT } from './ui/src/slots.js'
  export { installLocale, t } from '../ds-bot/src/client/i18n.js'
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
    name: 'engine-settings-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /(src\/client\/(cells|api)|ui\/src\/primitives)\.js$|^\.\/primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name, namespace: 'es-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'es-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'es-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
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
  useId: () => slot(() => ({ id: 'es-test-id' })).id,
  useEffect: effect,
  useLayoutEffect: effect,
  useSyncExternalStore(subscribe, getSnapshot) {
    const value = getSnapshot()
    effect(() => subscribe(() => {}), [subscribe])
    return value
  },
}

function loadMod(callHandler = async () => ({})) {
  const listeners = new Map()
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      location: { origin: 'http://127.0.0.1:41901' },
      addEventListener: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(fn)
      },
      removeEventListener: (name, fn) => { listeners.get(name)?.delete(fn) },
    },
    document: { body: { dataset: {} }, documentElement: { dataset: {} } },
    __testCall: callHandler,
    require(name) {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      throw new Error(`Unexpected require: ${name}`)
    },
    module: { exports: {} },
    exports: {},
  }
  sandbox.exports = sandbox.module.exports
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)
  return { mod: sandbox.module.exports, listeners, sandbox }
}

function createHarness(Component, props = {}) {
  const fibers = new Map()
  const render = (nextProps = props) => {
    const effects = []
    const expand = (node, path = '0') => {
      if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`))
      if (typeof node.type === 'function') {
        if (node.type.prototype && typeof node.type.prototype.render === 'function') {
          const instance = new node.type(node.props)
          return expand(instance.render(), `${path}:cls`)
        }
        const fiber = fibers.get(path) ?? { index: 0, slots: [] }
        fibers.set(path, fiber)
        fiber.index = 0
        const prev = current
        current = { fiber, effects }
        let rendered
        try { rendered = node.type(node.props) } finally { current = prev }
        return expand(rendered, `${path}:fn`)
      }
      const children = (node.props?.children ?? []).map((child, i) => expand(child, `${path}.${i}`))
      return { ...node, props: { ...node.props, children } }
    }
    const tree = expand({ type: Component, props: nextProps })
    for (const run of effects) run()
    return tree
  }
  return { render }
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

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.props?.children ?? []).map(textOf).join('')
}

function fakeLocale(initial = 'zh') {
  let active = initial
  const dicts = new Map()
  const listeners = new Set()
  const catalog = [{ id: 'zh', label: '中文', fallback: 'en' }, { id: 'en', label: 'English' }]
  const publish = () => { for (const fn of listeners) fn() }
  return {
    setActive: (next) => { active = next; publish() },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    addLanguage: (def) => { catalog.push(def); return () => {} },
    register: (ns, localeOrMap, dict) => {
      const pairs = typeof localeOrMap === 'string' ? [[localeOrMap, dict]] : Object.entries(localeOrMap ?? {})
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      const map = dicts.get(ns)
      for (const [loc, d] of pairs) map.set(loc.toLowerCase(), d)
      return () => {}
    },
    bind: ns => (key, params) => {
      const text = (active !== 'en' ? dicts.get(ns)?.get(active.toLowerCase())?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active, locales: catalog }),
  }
}

test('formatFieldLabel renders Sentence case and preserves uppercase technical acronyms', () => {
  const { mod } = loadMod()
  assert.equal(mod.formatFieldLabel(['maxRetryCount']), 'Max retry count')
  assert.equal(mod.formatFieldLabel(['api_key_header']), 'API key header')
  assert.equal(mod.formatFieldLabel(['baseURL']), 'Base URL')
  assert.equal(mod.formatFieldLabel(['httpProxyURL']), 'HTTP proxy URL')
  assert.equal(mod.formatFieldLabel(['mcpServerID']), 'MCP server ID')
  assert.equal(mod.formatFieldLabel(['cli_ssh_tls_ws_yaml_ui_json']), 'CLI SSH TLS WS YAML UI JSON')
  assert.equal(mod.formatFieldLabel(['nested_group', 'customApiEndpoint']), 'Nested group · Custom API endpoint')
})

test('resolveFieldLabel and extractSchemaFields localize known engine schema labels across locales', () => {
  const { mod } = loadMod()
  assert.equal(mod.resolveFieldLabel(['maxParallelToolCalls'], 'agent-loop'), 'Max parallel tool calls')
  assert.equal(mod.resolveFieldLabel(['apiKey'], 'web-search-deepseek'), 'API key')
  assert.equal(mod.resolveFieldLabel(['apiKeyEnv'], 'web-search-deepseek'), 'API key env var')
  assert.equal(mod.resolveFieldLabel(['baseURL'], 'web-search-deepseek'), 'Base URL')
  assert.equal(mod.resolveFieldLabel(['apiVersion'], 'web-search-deepseek'), 'API version')
  assert.equal(mod.resolveFieldLabel(['maxUses'], 'web-search-deepseek'), 'Max searches per request')
  assert.equal(mod.resolveFieldLabel(['count'], 'web-deepseek-api'), 'Results per search')
  assert.equal(mod.resolveFieldLabel(['sendOriginalQuestion'], 'web-deepseek-api'), 'Send original question')
  assert.equal(mod.resolveFieldLabel(['searchProvider'], 'web'), 'Search provider')
  assert.equal(mod.resolveFieldLabel(['fetchProvider'], 'web'), 'Fetch provider')
  assert.equal(mod.resolveFieldLabel(['cwd'], 'bash-sandbox'), 'Working directory')
  assert.equal(mod.resolveFieldLabel(['timeoutMs'], 'bash-sandbox'), 'Timeout (ms)')
  assert.equal(mod.resolveFieldLabel(['maxTimeoutMs'], 'bash-sandbox'), 'Max timeout (ms)')
  assert.equal(mod.resolveFieldLabel(['maxOutputBytes'], 'bash-sandbox'), 'Max output bytes')
  assert.equal(mod.resolveFieldLabel(['maxSpillBytes'], 'bash-sandbox'), 'Max spill bytes')
  assert.equal(mod.resolveFieldLabel(['graceMs'], 'bash-sandbox'), 'Shutdown grace (ms)')

  const schema = {
    type: 'object',
    dict: {
      cwd: { type: 'string', meta: {} },
      timeoutMs: { type: 'number', meta: { default: 60000 } },
      customMcpURL: { type: 'string', meta: {} },
    },
  }

  const locale = fakeLocale('zh')
  const off = mod.installLocale(locale)
  try {
    const fields = mod.extractSchemaFields(schema, { cwd: '/tmp', timeoutMs: 60000 }, [], 'bash-sandbox')
    assert.deepEqual(Array.from(fields, f => f.label), [
      mod.t('Working directory'),
      mod.t('Timeout (ms)'),
      'Custom MCP URL',
    ])
    assert.notEqual(fields[0].label, 'Working directory')
    assert.notEqual(fields[1].label, 'Timeout (ms)')
  } finally {
    off()
  }
})

test('PluginsSettingsPage renders 3 clean sections, hides internal/banned subagent bundles, validates icons, and supports drill-down config', async () => {
  const calls = []
  const svgIcon = 'data:image/svg+xml;base64,PHN2Zy8+'
  const { mod } = loadMod(async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'engine-plugins-list') {
      return {
        available: true,
        bundles: [
          { name: '@deepseek-ai/dsh-base', official: true, installed: true, enabled: true, removable: false },
          { name: '@deepseek-ai/dsh-web-app', official: true, installed: true, enabled: true, removable: false },
          { name: '@deepseek-ai/dsh-acp-app', official: true, installed: true, enabled: false, removable: false },
          { name: '@deepseek-ai/dsh-subagent-codex', official: true, installed: true, enabled: false, removable: false },
          { name: '@deepseek-ai/dsh-subagent-claude-code', official: true, installed: true, enabled: false, removable: false },
          { name: '@deepseek-ai/dsh-experimental-agent-team-profile', official: true, installed: true, enabled: false, removable: false },
          { name: '@deepseek-ai/dsh-experimental-ralph-bundle', official: true, installed: true, enabled: false, removable: false },
          {
            name: 'ds-bot',
            version: '0.3.10',
            installed: true,
            enabled: true,
            removable: true,
            description: 'DS Bot: raw English package.json description',
            meta: { name: 'ds-bot', description: 'DS Bot: raw English package.json description' },
          },
          {
            name: 'community-weather',
            version: '1.2.0',
            official: false,
            installed: true,
            enabled: true,
            removable: true,
            meta: { title: { en: 'Weather', zh: '天气' }, description: { en: 'Forecasts', zh: '天气预报' }, icon: svgIcon },
          },
          {
            name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
            version: '0.2.2',
            official: true,
            installed: true,
            enabled: false,
            removable: false,
            meta: { title: { en: 'Voice input', zh: '语音输入' }, description: { en: 'Transcribe locally', zh: '本地转写' }, icon: svgIcon },
          },
          {
            name: '@deepseek-ai/dsh-experimental-auto-review',
            version: '0.2.2',
            official: true,
            installed: true,
            enabled: true,
            removable: false,
            meta: { title: { en: 'Auto review', zh: '自动授权审查' }, description: { en: 'Review tool calls', zh: '审查工具调用' } },
          },
          {
            name: '@deepseek-ai/dsh-cua-bundle',
            version: '0.2.2',
            official: true,
            installed: true,
            enabled: false,
            removable: false,
            meta: {
              title: { en: 'Computer use', zh: 'Computer Use' },
              description: {
                en: 'Currently supports macOS; Windows support is in development. Switch to PTC mode.',
                zh: '目前仅支持 macOS，Windows 支持正在开发中。请切换到 PTC 模式来使用。',
              },
            },
          },
          {
            name: '@deepseek-ai/dsh-experimental-inspector-profile',
            version: '0.2.2',
            official: true,
            installed: true,
            enabled: false,
            removable: false,
            meta: { title: { en: 'Developer tools', zh: '开发者工具' }, description: { en: 'Troubleshoot sessions', zh: '排查会话' }, icon: 'javascript:alert(1)' },
          },
        ],
        plugins: [
          { id: 'raw-cordis-1', moduleName: '@deepseek-ai/dsh-internal-foo', name: 'Raw cordis plugin', enabled: true },
          { id: 'bot', moduleName: 'ds-bot', name: 'ds-bot', enabled: true },
        ],
      }
    }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'web-search-deepseek', autoGenerate: true, revision: 1, value: { maxUses: 5 }, secrets: [], schema: { type: 'object', dict: { maxUses: { type: 'number', meta: { default: 5 } } } } },
          { ns: 'web-deepseek-api', autoGenerate: true, revision: 1, value: { count: 10 }, secrets: [], schema: { type: 'object', dict: { count: { type: 'number', meta: { default: 10 } } } } },
          { ns: 'web', autoGenerate: true, revision: 1, value: { searchProvider: 'auto' }, secrets: [], schema: { type: 'object', dict: { searchProvider: { type: 'string', meta: { default: 'auto' } } } } },
          { ns: 'bash-sandbox', autoGenerate: true, revision: 1, value: { timeoutMs: 60000 }, secrets: [], schema: { type: 'object', dict: { timeoutMs: { type: 'number', meta: { default: 60000 } } } } },
          { ns: 'agent-loop', autoGenerate: true, revision: 1, value: { maxParallelToolCalls: 10 }, secrets: [], schema: { type: 'object', dict: { maxParallelToolCalls: { type: 'number', meta: { default: 10 } } } } },
          { ns: 'subagent', autoGenerate: true, revision: 1, value: { maxDepth: 1 }, secrets: [], schema: { type: 'object', dict: { maxDepth: { type: 'number', meta: { default: 1 } } } } },
          { ns: 'subagent-model-selection-settings', autoGenerate: true, revision: 1, value: { enabled: false }, secrets: [], schema: { type: 'object', dict: { enabled: { type: 'boolean', meta: { default: false } } } } },
        ],
      }
    }
    return { ok: true }
  })

  // Validate helpers directly.
  assert.equal(mod.isCoreDsBotEntry({ name: 'ds-bot' }), true)
  assert.equal(mod.isCoreDsBotEntry({ name: '@deepseek-ai/ds-bot' }), true)
  assert.equal(mod.isCoreDsBotEntry({ pkg: 'ds-bot' }), true)
  assert.equal(mod.isCoreDsBotEntry({ id: 'web-search-auto', moduleName: 'ds-bot/web-search' }), false)
  assert.equal(mod.isBannedNamespace('subagent'), true)
  assert.equal(mod.isBannedNamespace('subagent-model-selection-settings'), true)
  assert.equal(mod.isBannedNamespace('web-search-deepseek'), false)
  assert.equal(mod.isExcludedBundle('@deepseek-ai/dsh-base'), true)
  assert.equal(mod.isExcludedBundle('@deepseek-ai/dsh-subagent-codex'), true)
  assert.equal(mod.isExcludedBundle('@deepseek-ai/dsh-experimental-agent-team-profile'), true)
  assert.equal(mod.isExcludedBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'), false)
  assert.equal(mod.safePluginIconUri(svgIcon), svgIcon)
  assert.equal(mod.safePluginIconUri('javascript:alert(1)'), null)
  assert.equal(mod.resolveLocalizedMetaText({ en: 'Voice input', zh: '语音输入' }, 'zh'), '语音输入')
  assert.equal(mod.resolveLocalizedMetaText({ en: 'Voice input', zh: '语音输入' }, 'zh-TW'), '語音輸入')

  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  const loaded = harness.render()
  const allText = textOf(loaded)

  // Internal/banned bundles and raw cordis plugins are completely excluded.
  for (const forbidden of ['dsh-base', 'dsh-web-app', 'dsh-acp-app', 'subagent-codex', 'subagent-claude-code', 'agent-team', 'ralph', 'Raw cordis plugin', 'Subagents']) {
    assert.equal(allText.includes(forbidden), false, `must not expose ${forbidden}`)
  }

  // Install input is hidden behind + Add plugin button until clicked.
  assert.equal(findAll(loaded, n => n.type === 'form' && n.props?.className === 'dsb-engine-install').length, 0)
  const addBtn = findAll(loaded, n => n.type === 'button' && textOf(n).includes('Add plugin'))[0]
  assert.ok(addBtn, 'Add plugin toggle exists')

  // Core ds-bot is locked with Core pill, renders DS Bot whale mark on accent tile, and shows localized DS Bot copy.
  const dsBotRow = findAll(loaded, n => n.props?.['data-plugin-bundle'] === 'ds-bot')[0]
  assert.ok(dsBotRow, 'ds-bot row rendered')
  assert.equal(findAll(dsBotRow, n => n.type === 'button').length, 0)
  assert.equal(findAll(dsBotRow, n => n.props?.['data-core-plugin'] !== undefined).length, 1)
  const coreTile = findAll(dsBotRow, n => n.props?.['data-core'] !== undefined)[0]
  assert.ok(coreTile, 'core ds-bot uses accented icon tile')
  const whaleMark = findAll(coreTile, n => n.props?.['data-shape'] === 'whale')[0]
  assert.ok(whaleMark, 'core ds-bot renders signature whale BotMark')
  assert.equal(whaleMark.props.style?.width, 20)
  assert.equal(textOf(findAll(dsBotRow, n => n.props?.className === 'dsb-plug-name')[0]), 'DS Bot')
  assert.equal(textOf(findAll(dsBotRow, n => n.props?.className === 'dsb-plug-desc')[0]), 'Multi-Bot team chat, scheduled tasks, and group collaboration.')
  assert.equal(textOf(dsBotRow).includes('raw English package.json description'), false)

  // Experimental badge appears ONLY when an experimental plugin is in Installed plugins, never in Experimental plugins.
  const installedExpRow = findAll(loaded, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-experimental-auto-review')[0]
  assert.ok(installedExpRow)
  assert.equal(findAll(installedExpRow, n => n.props?.className === 'dsb-preset-badge' && textOf(n) === 'Experimental').length, 1)
  const optionalExpRow = findAll(loaded, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-experimental-voice-input-bundle')[0]
  assert.ok(optionalExpRow)
  assert.equal(findAll(optionalExpRow, n => n.props?.className === 'dsb-preset-badge' && textOf(n) === 'Experimental').length, 0)

  // Verify ZH locale also renders localized DS Bot description (not shadowed by raw English meta.description).
  const zhLocale = fakeLocale('zh')
  const offZh = mod.installLocale(zhLocale)
  try {
    const zhLoaded = harness.render()
    const zhDsBotRow = findAll(zhLoaded, n => n.props?.['data-plugin-bundle'] === 'ds-bot')[0]
    assert.equal(textOf(findAll(zhDsBotRow, n => n.props?.className === 'dsb-plug-name')[0]), 'DS Bot')
    assert.equal(textOf(findAll(zhDsBotRow, n => n.props?.className === 'dsb-plug-desc')[0]), mod.t('Multi-Bot team chat, scheduled tasks, and group collaboration.'))
    assert.notEqual(textOf(findAll(zhDsBotRow, n => n.props?.className === 'dsb-plug-desc')[0]), 'Multi-Bot team chat, scheduled tasks, and group collaboration.')
  } finally {
    offZh()
  }

  // Community plugin shows validated SVG <img> icon and two-step danger remove confirmation.
  const weatherRow = findAll(loaded, n => n.props?.['data-plugin-bundle'] === 'community-weather')[0]
  assert.ok(weatherRow)
  const weatherImgs = findAll(weatherRow, n => n.type === 'img')
  assert.equal(weatherImgs.length, 1)
  assert.equal(weatherImgs[0].props.src, svgIcon)
  const removeBtn = findAll(weatherRow, n => n.type === 'button' && textOf(n) === 'Remove')[0]
  assert.ok(String(removeBtn.props.className).includes('bt-danger'))
  removeBtn.props.onClick()
  assert.equal(calls.some(([ep]) => ep === 'engine-plugins-remove'), false)
  const armedTree = harness.render()
  const confirmBtn = findAll(armedTree, n => n.type === 'button' && textOf(n) === 'Confirm remove')[0]
  const cancelBtn = findAll(armedTree, n => n.type === 'button' && textOf(n) === 'Cancel')[0]
  assert.ok(confirmBtn && cancelBtn)
  cancelBtn.props.onClick()
  const disarmedTree = harness.render()
  assert.equal(findAll(disarmedTree, n => n.type === 'button' && textOf(n) === 'Confirm remove').length, 0)

  // Re-arm and confirm removes community-weather.
  findAll(disarmedTree, n => n.type === 'button' && textOf(n) === 'Remove')[0].props.onClick()
  const reArmedTree = harness.render()
  findAll(reArmedTree, n => n.type === 'button' && textOf(n) === 'Confirm remove')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(
    structuredClone(calls.filter(([ep]) => ep === 'engine-plugins-remove')),
    [['engine-plugins-remove', { name: 'community-weather' }]],
  )

  // Built-in plugin settings lists ONLY Web search, Shell, Agent loop (zero subagent!).
  const builtinBtns = findAll(loaded, n => n.type === 'button' && n.props?.['data-builtin-config'])
  assert.deepEqual(Array.from(builtinBtns, b => b.props['data-builtin-config']), ['web-search', 'shell', 'agent-loop'])

  // Experimental plugins shows primary Voice input first, hides More bundle (Developer tools) behind More button.
  assert.equal(findAll(loaded, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-experimental-voice-input-bundle').length, 1)
  assert.equal(findAll(loaded, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-experimental-inspector-profile').length, 0)
  const moreBtn = findAll(loaded, n => n.type === 'button' && n.props?.className === 'dsb-plug-more-btn')[0]
  assert.ok(moreBtn, 'More toggle button renders')
  moreBtn.props.onClick()
  const expandedTree = harness.render()
  const inspectorRow = findAll(expandedTree, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-experimental-inspector-profile')[0]
  assert.ok(inspectorRow, 'More bundle revealed after clicking More')
  assert.equal(findAll(inspectorRow, n => n.type === 'img').length, 0, 'unsafe javascript: icon URI falls back to SVG icon')

  // Computer use bundle uses clean override with no process/PTC jargon.
  const cuaRow = findAll(expandedTree, n => n.props?.['data-plugin-bundle'] === '@deepseek-ai/dsh-cua-bundle')[0]
  assert.ok(cuaRow, 'Computer use bundle rendered under More')
  assert.equal(textOf(findAll(cuaRow, n => n.props?.className === 'dsb-plug-name')[0]), 'Computer use')
  assert.equal(textOf(cuaRow).includes('in development'), false)
  assert.equal(textOf(cuaRow).includes('PTC'), false)
  assert.equal(findAll(cuaRow, n => n.props?.className === 'dsb-preset-badge').length, 0, 'no redundant Experimental badge under Experimental plugins')

  // Clicking Web search drills into sticky-bar config editor without duplicate section heading; Back to plugins returns to list.
  builtinBtns[0].props.onClick()
  const detailTree = harness.render()
  assert.equal(detailTree.props['data-plugin-detail'], 'web-search')
  assert.ok(textOf(detailTree).includes('Max searches per request'))
  const stickyBar = findAll(detailTree, n => n.props?.className === 'dsb-plug-detail-sticky')[0]
  assert.ok(stickyBar, 'sticky detail header bar rendered')
  const backBtn = findAll(stickyBar, n => n.type === 'button' && n.props?.className === 'dsb-plug-back')[0]
  assert.ok(backBtn, 'Back to plugins button sits inside sticky bar')
  const sectionHeadings = findAll(detailTree, n => n.type === 'h3' && n.props?.className !== 'dsb-plug-detail-title').map(textOf)
  assert.deepEqual(sectionHeadings, ['Search', 'Web fetch'], 'Web search detail uses Search and Web fetch sections')
  backBtn.props.onClick()
  const backTree = harness.render()
  assert.equal(backTree.props['data-plugin-detail'], undefined)

  // Reopening PluginsSettingsPage renders cached data immediately (zero blank Loading… flash) while revalidating.
  const reopenHarness = createHarness(mod.PluginsSettingsPage, { readOnly: false })
  const immediate = reopenHarness.render()
  assert.equal(findAll(immediate, n => n.props?.className === 'dsb-engine-loading').length, 0, 'cached Plugins reopens without Loading… flash')
  assert.equal(findAll(immediate, n => n.props?.['data-plugin-bundle'] === 'ds-bot').length, 1)
})

test('PluginsSettingsPage opens built-in detail directly when given subTarget="web-search"', async () => {
  const { mod } = loadMod(async (endpoint) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'web-search-deepseek', autoGenerate: true, revision: 1, value: { maxUses: 5 }, secrets: [], schema: { type: 'object', dict: { maxUses: { type: 'number', meta: { default: 5 } } } } },
        ],
      }
    }
    return {}
  })
  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false, subTarget: 'web-search' })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  const tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.equal(tree.props['data-plugin-detail'], 'web-search')
  assert.ok(textOf(tree).includes('Max searches per request'))
})

test('AgentPresetsSettingsPage omits verbose intro, supports whole-card 0ms optimistic switching, and rolls back on failure', async () => {
  let resolveMutate
  let failNext = false
  const calls = []
  const { mod } = loadMod(async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'engine-presets-list') {
      return {
        available: true,
        writable: true,
        revision: 3,
        presets: [
          { id: 'standard', isDefault: true },
          { id: 'ptc', isDefault: false },
        ],
      }
    }
    if (endpoint === 'engine-presets-default') {
      return await new Promise((resolve, reject) => {
        resolveMutate = () => {
          if (failNext) reject(new Error('disk write failed'))
          else resolve({
            available: true,
            writable: true,
            revision: 4,
            presets: [
              { id: 'standard', isDefault: payload.id === 'standard' },
              { id: 'ptc', isDefault: payload.id === 'ptc' },
            ],
          })
        }
      })
    }
    if (endpoint === 'engine-presets-read') return { id: payload.id, content: 'mode: ptc\n' }
    return {}
  })

  const harness = createHarness(mod.AgentPresetsSettingsPage, { readOnly: false })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  const loaded = harness.render()

  // No verbose intro paragraph, no redundant Built-in/Custom badges or raw preset.id pills on cards.
  assert.equal(findAll(loaded, n => n.props?.className === 'dsb-presets-intro').length, 0)
  assert.equal(findAll(loaded, n => n.props?.className === 'dsb-preset-id').length, 0, 'raw preset.id hidden on cards')
  assert.equal(findAll(loaded, n => n.props?.className === 'dsb-preset-badge').length, 0, 'no redundant Built-in/Custom badges on healthy cards')

  const ptcCard = findAll(loaded, n => n.props?.['data-preset-id'] === 'ptc')[0]
  assert.ok(ptcCard)
  assert.equal(ptcCard.props['data-selectable'], '')
  assert.equal(ptcCard.props['data-active'], undefined)

  // Clicking View configuration stops propagation, opens YAML modal WITH doc.id, and does NOT trigger selectDefault.
  let stopped = false
  const viewBtn = findAll(ptcCard, n => n.type === 'button' && String(n.props?.className).includes('dsb-preset-view'))[0]
  viewBtn.props.onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(calls.some(([ep]) => ep === 'engine-presets-default'), false)
  await new Promise(resolve => setTimeout(resolve, 15))
  const modalTree = harness.render()
  const modalId = findAll(modalTree, n => n.props?.className === 'dsb-preset-id')[0]
  assert.ok(modalId && textOf(modalId) === 'ptc', 'preset id stays visible inside View configuration modal')
  const closeModalBtn = findAll(modalTree, n => n.type === 'button' && n.props?.['aria-label'] === 'Close')[0]
  closeModalBtn.props.onClick()
  harness.render()

  // Clicking the card flips data-active in 0ms synchronously BEFORE RPC settles.
  ptcCard.props.onClick()
  const optimistic = harness.render()
  const ptcOpt = findAll(optimistic, n => n.props?.['data-preset-id'] === 'ptc')[0]
  const stdOpt = findAll(optimistic, n => n.props?.['data-preset-id'] === 'standard')[0]
  assert.equal(ptcOpt.props['data-active'], '', 'PTC becomes active synchronously in 0ms')
  assert.equal(stdOpt.props['data-active'], undefined, 'Standard loses active synchronously in 0ms')

  // Failure rolls back cleanly to previous active preset + shows error alert.
  failNext = true
  resolveMutate()
  await new Promise(resolve => setTimeout(resolve, 15))
  const rolledBack = harness.render()
  assert.equal(findAll(rolledBack, n => n.props?.['data-preset-id'] === 'standard')[0].props['data-active'], '')
  assert.equal(findAll(rolledBack, n => n.props?.['data-preset-id'] === 'ptc')[0].props['data-active'], undefined)
  assert.equal(findAll(rolledBack, n => n.props?.role === 'alert').length, 1)

  // Clicking footer "Set as new task default" button also switches in 0ms and persists cleanly.
  failNext = false
  const ptcCard2 = findAll(rolledBack, n => n.props?.['data-preset-id'] === 'ptc')[0]
  const footBtn = findAll(ptcCard2, n => n.type === 'button' && String(n.props?.className).includes('dsb-preset-state-btn'))[0]
  assert.ok(footBtn)
  footBtn.props.onClick({ stopPropagation: () => {} })
  const optimistic2 = harness.render()
  assert.equal(findAll(optimistic2, n => n.props?.['data-preset-id'] === 'ptc')[0].props['data-active'], '')
  resolveMutate()
  await new Promise(resolve => setTimeout(resolve, 15))
  const settled = harness.render()
  assert.equal(findAll(settled, n => n.props?.['data-preset-id'] === 'ptc')[0].props['data-active'], '')

  // Reopening AgentPresetsSettingsPage renders cached presets immediately without Loading… flash.
  const reopenHarness = createHarness(mod.AgentPresetsSettingsPage, { readOnly: false })
  const immediate = reopenHarness.render()
  assert.equal(findAll(immediate, n => n.props?.className === 'dsb-engine-loading').length, 0, 'cached Presets reopens without Loading… flash')
  assert.equal(findAll(immediate, n => n.props?.['data-preset-id'] === 'ptc')[0].props['data-active'], '')
})

test('registerEngineSettingsPlugin removes engine-config and forwards subTarget to Plugins', () => {
  const { mod } = loadMod()
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })
  mod.registerEngineSettingsPlugin(runtime)

  const sectionIds = Array.from(slots.list(mod.SETTINGS_SECTION_SLOT), entry => entry.id)
  assert.deepEqual(sectionIds, ['account', 'plugins', 'agent-presets', 'archived-sessions'])
  assert.equal(slots.list(mod.SETTINGS_SECTION_ICON_SLOT).some(entry => entry.id === 'engine-config'), false)

  const Probe = () => {
    const bridge = mod.useDshSettingsBridge(slots, { surfaceMode: 'bot' })
    return bridge.renderSlot(mod.SETTINGS_SECTION_SLOT, { subTarget: 'web-search' }, { only: 'plugins' })
  }
  const rendered = createHarness(Probe).render()
  const lazyNodes = findAll(rendered, n => n.type === 'lazy-stub')
  assert.equal(lazyNodes.length, 1)
  assert.equal(lazyNodes[0].props.subTarget, 'web-search')
})

test('AccountSettingsPage opens view.attempt.authorizeUrl on sign-in and supports cancel and sign-out', async () => {
  const openedUrls = []
  let view = {
    status: 'signed-out',
    links: { usageUrl: '', topUpUrl: '' },
    attempt: null,
  }
  const calls = []
  const { mod, sandbox } = loadMod(async (ep, body) => {
    calls.push([ep, body])
    if (ep === 'engine-account-state') return { available: true, view }
    if (ep === 'engine-account-signin') {
      view = {
        status: 'signing-in',
        links: { usageUrl: '', topUpUrl: '' },
        attempt: { id: 'att-1', phase: 'waiting-browser', authorizeUrl: 'https://auth.deepseek.com/oauth/start?state=abc' },
      }
      return { available: true, view }
    }
    if (ep === 'engine-account-cancel') {
      view = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }
      return { available: true, view }
    }
    if (ep === 'engine-account-signout') {
      view = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }
      return { available: true, view }
    }
    return {}
  })
  sandbox.window.open = (url, target, features) => { openedUrls.push([url, target, features]) }
  sandbox.window.location = { origin: 'http://127.0.0.1:4173' }

  const harness = createHarness(mod.AccountSettingsPage, { readOnly: false })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  const initial = harness.render()
  const signInBtn = findAll(initial, n => n.type === 'button' && /Sign in/i.test(textOf(n)))[0]
  assert.ok(signInBtn, 'Sign in button renders when signed out')

  await signInBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(openedUrls, [['https://auth.deepseek.com/oauth/start?state=abc', '_blank', 'noopener,noreferrer']])

  const waiting = harness.render()
  const cancelBtn = findAll(waiting, n => n.type === 'button' && /Cancel/i.test(textOf(n)))[0]
  assert.ok(cancelBtn, 'Cancel button renders while attempt is active')
  await cancelBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15))
  harness.render()
  assert.equal(calls.some(([ep, b]) => ep === 'engine-account-cancel' && b?.attemptId === 'att-1'), true)

  // Signed-in state exposes Sign out (matches DSH view.status === 'credential-stored' contract).
  view = { status: 'credential-stored', attempt: null }
  const signedHarness = createHarness(mod.AccountSettingsPage, { readOnly: false })
  signedHarness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  const signedTree = signedHarness.render()
  const signOutBtn = findAll(signedTree, n => n.type === 'button' && /Sign out/i.test(textOf(n)))[0]
  assert.ok(signOutBtn)
  await signOutBtn.props.onClick()
  assert.equal(calls.some(([ep]) => ep === 'engine-account-signout'), true)
})

test('Agent loop and Shell settings use explicit Save/Discard/Reset with validation instead of committing on blur', async () => {
  const calls = []
  let maxTurns = 30
  let maxTurnsUserSet = true
  let rev = 2
  const { mod } = loadMod(async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [{
          ns: 'agent-loop',
          autoGenerate: true,
          revision: rev,
          value: { maxParallelToolCalls: maxTurns },
          base: { maxParallelToolCalls: 10 },
          user: maxTurnsUserSet ? { maxParallelToolCalls: maxTurns } : {},
          secrets: [],
          schema: {
            type: 'object',
            dict: { maxParallelToolCalls: { type: 'number', meta: { default: 10, min: 1, max: 100 } } },
          },
        }],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      rev += 1
      for (const op of payload.ops) {
        if (op.op === 'set' && op.path[0] === 'maxParallelToolCalls') {
          maxTurns = op.value
          maxTurnsUserSet = true
        } else if (op.op === 'unset' && op.path[0] === 'maxParallelToolCalls') {
          maxTurns = 10
          maxTurnsUserSet = false
        }
      }
      return {
        ns: 'agent-loop',
        autoGenerate: true,
        revision: rev,
        value: { maxParallelToolCalls: maxTurns },
        base: { maxParallelToolCalls: 10 },
        user: maxTurnsUserSet ? { maxParallelToolCalls: maxTurns } : {},
        secrets: [],
        schema: {
          type: 'object',
          dict: { maxParallelToolCalls: { type: 'number', meta: { default: 10, min: 1, max: 100 } } },
        },
      }
    }
    return {}
  })

  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false, subTarget: 'agent-loop' })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 15))
  let tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })

  const input = () => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Max parallel tool calls')[0]
  const saveBtn = () => findAll(tree, n => n.type === 'button' && textOf(n) === 'Save')[0]
  const discardBtn = () => findAll(tree, n => n.type === 'button' && textOf(n) === 'Discard')[0]
  const resetBtn = () => findAll(tree, n => n.type === 'button' && textOf(n) === 'Reset')[0]

  assert.equal(saveBtn().props.disabled, true, 'Save disabled when clean')
  assert.equal(discardBtn().props.disabled, true, 'Discard disabled when clean')

  // Editing value stages draft without committing immediately.
  input().props.onChange({ target: { value: '45' } })
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.equal(calls.some(([ep]) => ep === 'engine-settings-mutate'), false, 'editing must not commit on change/blur')
  assert.equal(saveBtn().props.disabled, false)
  assert.equal(discardBtn().props.disabled, false)

  // Invalid number shows alert and disables Save while keeping Discard enabled.
  input().props.onChange({ target: { value: '500' } })
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.equal(saveBtn().props.disabled, true)
  assert.equal(discardBtn().props.disabled, false)
  assert.ok(findAll(tree, n => n.props?.role === 'alert' && /at most 100/.test(textOf(n))).length >= 1)

  // Discard restores original value cleanly.
  discardBtn().props.onClick()
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.equal(input().props.value, '30')
  assert.equal(saveBtn().props.disabled, true)

  // Edit valid value and click Save -> commits batch.
  input().props.onChange({ target: { value: '42' } })
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  saveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15))
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.deepEqual(
    structuredClone(calls.filter(([ep]) => ep === 'engine-settings-mutate')),
    [['engine-settings-mutate', { ns: 'agent-loop', ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 42 }], expectedRevision: 2 }]],
  )
  assert.ok(textOf(tree).includes('Saved'))

  // Reset stages unset op and commits on Save.
  assert.ok(resetBtn(), 'Reset button visible for user-overridden field')
  resetBtn().props.onClick()
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.equal(input().props.value, '10')
  saveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15))
  tree = harness.render({ readOnly: false, subTarget: 'agent-loop' })
  assert.deepEqual(
    structuredClone(calls.filter(([ep]) => ep === 'engine-settings-mutate').at(-1)),
    ['engine-settings-mutate', { ns: 'agent-loop', ops: [{ op: 'unset', path: ['maxParallelToolCalls'] }], expectedRevision: 3 }],
  )
})

test('WebSearchDetailForm loads registered providers and saves provider config before web selection', async () => {
  const mutated = []
  const { mod } = loadMod(async (endpoint, payload) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-web-providers') {
      return {
        available: true,
        search: [
          { id: 'deepseek-search-api', title: 'DeepSeek Search API', kind: 'search', available: true },
          { id: 'deepseek-official', title: 'DeepSeek Messages', kind: 'search', available: true },
        ],
        fetch: [
          { id: 'http', title: 'Direct HTTP', kind: 'fetch', available: true },
          { id: 'deepseek-fetch-api', title: 'DeepSeek Fetch API', kind: 'fetch', available: true },
        ],
      }
    }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'web', autoGenerate: true, revision: 1, value: { searchProvider: '', fetchProvider: '' }, base: {}, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'web-deepseek-api', autoGenerate: true, revision: 2, value: { count: 10, searchBilling: 'auto', fetchBilling: 'auto' }, base: { count: 10 }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'web-search-deepseek', autoGenerate: true, revision: 3, value: { maxUses: 5, baseURL: '' }, base: { maxUses: 5 }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
        ],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      mutated.push(payload)
      return { ns: payload.ns, revision: payload.expectedRevision + 1, value: {}, base: {}, user: {}, secrets: [], schema: { type: 'object', dict: {} } }
    }
    return {}
  })

  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false, subTarget: 'web-search' })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  harness.render({ readOnly: false, subTarget: 'web-search' })
  await new Promise(resolve => setTimeout(resolve, 20))
  let tree = harness.render({ readOnly: false, subTarget: 'web-search' })

  // Open Search provider SelectMenu and choose DeepSeek Search API.
  const searchTrigger = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Search provider')[0]
  assert.ok(searchTrigger)
  if (searchTrigger.props.ref) {
    searchTrigger.props.ref.current = {
      getBoundingClientRect: () => ({ left: 400, right: 620, top: 180, bottom: 212, width: 220, height: 32 }),
      focus() {},
    }
  }
  searchTrigger.props.onClick({ detail: 1 })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  const opt = findAll(tree, n => n.props?.role === 'option' && textOf(n) === 'DeepSeek Search API')[0]
  assert.ok(opt, 'registered DeepSeek Search API appears in provider picker')
  opt.props.onClick()
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })

  // Legacy-only field disappears when deepseek-search-api is selected, while Results per search remains.
  assert.equal(textOf(tree).includes('Max searches per request'), false)
  const countInput = findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Results per search')[0]
  assert.ok(countInput)
  countInput.props.onChange({ target: { value: '20' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })

  // Save commits provider config (`web-deepseek-api`) BEFORE `web` provider selection!
  const saveBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Save')[0]
  saveBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(Array.from(mutated, m => m.ns), ['web-deepseek-api', 'web'])
  assert.deepEqual(structuredClone(mutated[0].ops), [{ op: 'set', path: ['count'], value: 20 }])
  assert.deepEqual(structuredClone(mutated[1].ops), [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }])
})

test('Classic mode shows Subagents settings with model allowlist while Bot mode keeps subagents banned', async () => {
  const mutated = []
  const { mod } = loadMod(async (endpoint, payload) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-model-catalog') {
      return {
        available: true,
        partial: false,
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] }],
      }
    }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'subagent', autoGenerate: true, revision: 1, value: { maxDepth: 1, maxActiveSubagents: 4 }, base: { maxDepth: 1, maxActiveSubagents: 4 }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'subagent-model-selection-settings', autoGenerate: true, revision: 1, value: { enabled: false, allowedModels: [] }, base: { enabled: false, allowedModels: [] }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
        ],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      mutated.push(payload)
      return { ns: payload.ns, revision: payload.expectedRevision + 1, value: {}, base: {}, user: {}, secrets: [], schema: { type: 'object', dict: {} } }
    }
    return {}
  })

  assert.equal(mod.isBannedNamespace('subagent', 'bot'), true)
  assert.equal(mod.isBannedNamespace('subagent', 'agent'), false)
  assert.equal(mod.isBannedNamespace('subagent-model-selection-settings', 'bot'), true)
  assert.equal(mod.isBannedNamespace('subagent-model-selection-settings', 'agent'), false)

  // Bot mode: Subagents hidden even if subTarget='subagent'.
  const botHarness = createHarness(mod.PluginsSettingsPage, { readOnly: false, surfaceMode: 'bot', subTarget: 'subagent' })
  botHarness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  const botTree = botHarness.render({ readOnly: false, surfaceMode: 'bot', subTarget: 'subagent' })
  assert.equal(botTree.props['data-plugin-detail'], undefined)
  assert.equal(findAll(botTree, n => n.props?.['data-builtin-config'] === 'subagent').length, 0)

  // Classic mode: Subagents card appears and opens limits + model allowlist.
  const classicHarness = createHarness(mod.PluginsSettingsPage, { readOnly: false, surfaceMode: 'agent' })
  classicHarness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  let tree = classicHarness.render({ readOnly: false, surfaceMode: 'agent' })
  const subBtn = findAll(tree, n => n.type === 'button' && n.props?.['data-builtin-config'] === 'subagent')[0]
  assert.ok(subBtn, 'Subagents config button renders in Classic mode')
  subBtn.props.onClick()
  tree = classicHarness.render({ readOnly: false, surfaceMode: 'agent' })
  assert.equal(tree.props['data-plugin-detail'], 'subagent')

  // Enable model selection -> loads catalog, warns until a model is picked, then saves both namespaces.
  const toggle = findAll(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Allow agents to choose models for subagents')[0]
  assert.ok(toggle)
  toggle.props.onClick()
  tree = classicHarness.render({ readOnly: false, surfaceMode: 'agent' })
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = classicHarness.render({ readOnly: false, surfaceMode: 'agent' })
  assert.ok(textOf(tree).includes('Select at least one model'))
  assert.equal(findAll(tree, n => n.type === 'button' && textOf(n) === 'Save')[0].props.disabled, true)

  const checkbox = findAll(tree, n => n.type === 'input' && n.props?.type === 'checkbox')[0]
  assert.ok(checkbox, 'catalog model checkbox rendered')
  checkbox.props.onChange()
  const depthInput = findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Max depth')[0]
  depthInput.props.onChange({ target: { value: '2' } })
  tree = classicHarness.render({ readOnly: false, surfaceMode: 'agent' })

  const saveBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Save')[0]
  assert.equal(saveBtn.props.disabled, false)
  saveBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(Array.from(mutated, m => m.ns), ['subagent', 'subagent-model-selection-settings'])
  assert.deepEqual(structuredClone(mutated[0].ops), [{ op: 'set', path: ['maxDepth'], value: 2 }])
  assert.deepEqual(structuredClone(mutated[1].ops), [
    { op: 'set', path: ['enabled'], value: true },
    { op: 'set', path: ['allowedModels'], value: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
  ])
})

test('PluginsSettingsPage surfaces failed UI plugins with Retry button and SessionLogGeneralItem reports save and error state', async () => {
  const { mod } = loadMod(async (endpoint, payload) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [{ ns: 'session-log-deepseek', revision: 1, value: { enabled: false }, secrets: [], schema: { type: 'object', dict: {} } }],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      if (payload.ops[0]?.value === true) {
        return { ns: 'session-log-deepseek', revision: 2, value: { enabled: true }, secrets: [], schema: { type: 'object', dict: {} } }
      }
      throw new Error('Disk full')
    }
    return {}
  })

  // Failed UI plugin shows up in Settings -> Plugins with live Retry button.
  const slots = mod.createSlotRegistry()
  const runtime = mod.createPluginRuntime({ slots })
  let shouldFail = true
  runtime.use({ id: 'ext.ui-broken', name: 'Broken panel' }, () => {
    if (shouldFail) throw new Error('init crashed')
  })
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.ui-broken').status, 'error')

  const plugHarness = createHarness(mod.PluginsSettingsPage, { readOnly: false, runtime })
  plugHarness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  let plugTree = plugHarness.render({ readOnly: false, runtime })
  const brokenRow = findAll(plugTree, n => n.props?.['data-ui-plugin'] === 'ext.ui-broken')[0]
  assert.ok(brokenRow, 'failed UI plugin row appears in Settings -> Plugins')
  assert.ok(textOf(brokenRow).includes('init crashed'))
  const retryBtn = findAll(brokenRow, n => n.type === 'button' && textOf(n) === 'Retry')[0]
  assert.ok(retryBtn)
  shouldFail = false
  retryBtn.props.onClick()
  plugTree = plugHarness.render({ readOnly: false, runtime })
  assert.equal(runtime.getSnapshot().find(p => p.id === 'ext.ui-broken').status, 'active')
  assert.equal(findAll(plugTree, n => n.props?.['data-ui-plugin'] === 'ext.ui-broken').length, 0)

  // SessionLogGeneralItem displays Saved on success and alert error on failure.
  const logHarness = createHarness(mod.SessionLogGeneralItem, { readOnly: false })
  logHarness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  let logTree = logHarness.render({ readOnly: false })
  const sw = () => findAll(logTree, n => n.type === 'button' && n.props?.role === 'switch')[0]
  assert.equal(sw().props['aria-checked'], false)
  sw().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  logTree = logHarness.render({ readOnly: false })
  assert.equal(sw().props['aria-checked'], true)
  assert.ok(textOf(logTree).includes('Saved'))

  // Toggle back -> fails with 'Disk full' -> renders visible alert.
  sw().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  logTree = logHarness.render({ readOnly: false })
  assert.ok(findAll(logTree, n => n.props?.role === 'alert' && textOf(n).includes('Disk full')).length === 1)
})

test('Engine settings staged forms preserve unsaved drafts across revalidation, secret saves, partial multi-namespace failures, and hidden provider switches', async () => {
  let failWebNs = true
  let apiRev = 2
  let legacyRev = 3
  let webRev = 1
  const mutated = []
  const { mod } = loadMod(async (endpoint, payload) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-web-providers') {
      return {
        available: true,
        search: [
          { id: 'deepseek-search-api', title: 'DeepSeek Search API', kind: 'search', available: true },
          { id: 'deepseek-official', title: 'DeepSeek Messages', kind: 'search', available: true },
        ],
        fetch: [{ id: 'http', title: 'Direct HTTP', kind: 'fetch', available: true }],
      }
    }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'web', autoGenerate: true, revision: webRev, value: { searchProvider: '', fetchProvider: '' }, base: {}, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'web-deepseek-api', autoGenerate: true, revision: apiRev, value: { count: 10, searchBilling: 'auto', fetchBilling: 'auto' }, base: { count: 10 }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          {
            ns: 'web-search-deepseek',
            autoGenerate: true,
            revision: legacyRev,
            value: { maxUses: 5, baseURL: '' },
            base: { maxUses: 5 },
            user: {},
            secrets: [{ path: ['apiKey'], set: false }],
            schema: { type: 'object', dict: { apiKey: { type: 'string', meta: { role: 'secret' } } } },
          },
        ],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      mutated.push(payload)
      if (payload.ns === 'web-search-deepseek') {
        legacyRev += 1
        return {
          ns: 'web-search-deepseek',
          autoGenerate: true,
          revision: legacyRev,
          value: { maxUses: 5, baseURL: '' },
          base: { maxUses: 5 },
          user: {},
          secrets: [{ path: ['apiKey'], set: true }],
          schema: { type: 'object', dict: { apiKey: { type: 'string', meta: { role: 'secret' } } } },
        }
      }
      if (payload.ns === 'web-deepseek-api') {
        apiRev += 1
        return {
          ns: 'web-deepseek-api',
          autoGenerate: true,
          revision: apiRev,
          value: { count: 25, searchBilling: 'auto', fetchBilling: 'auto' },
          base: { count: 10 },
          user: { count: 25 },
          secrets: [],
          schema: { type: 'object', dict: {} },
        }
      }
      if (payload.ns === 'web' && failWebNs) {
        throw new Error('web write failed')
      }
      webRev += 1
      return { ns: 'web', autoGenerate: true, revision: webRev, value: { searchProvider: 'deepseek-search-api', fetchProvider: '' }, base: {}, user: { searchProvider: 'deepseek-search-api' }, secrets: [], schema: { type: 'object', dict: {} } }
    }
    return {}
  })

  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false, subTarget: 'web-search' })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  harness.render({ readOnly: false, subTarget: 'web-search' })
  await new Promise(resolve => setTimeout(resolve, 20))
  let tree = harness.render({ readOnly: false, subTarget: 'web-search' })

  // 1. Edit Base URL, then save secret API key -> revision bumps, unsaved Base URL draft MUST survive!
  const baseUrlInput = () => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Base URL')[0]
  baseUrlInput().props.onChange({ target: { value: 'https://custom.example' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  const secretInput = findAll(tree, n => n.type === 'input' && n.props?.type === 'password')[0]
  secretInput.props.onChange({ target: { value: 'sk-secret-123' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  // First Save button belongs to SchemaSecretField inline control.
  const secretSaveBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Save')[0]
  secretSaveBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.equal(baseUrlInput().props.value, 'https://custom.example', 'secret save must NOT wipe unsaved Base URL draft')

  // 2. Enter invalid Results per search ('999'), then switch Search provider to DeepSeek Messages -> hidden invalid count must NOT block Save!
  const countInput = () => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Results per search')[0]
  countInput().props.onChange({ target: { value: '999' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  const formSaveBtn = () => findAll(tree, n => n.type === 'button' && textOf(n) === 'Save').at(-1)
  assert.equal(formSaveBtn().props.disabled, true, 'visible invalid count disables Save')

  const pickSearchProvider = (label) => {
    const trigger = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Search provider')[0]
    if (trigger.props.ref) {
      trigger.props.ref.current = { getBoundingClientRect: () => ({ left: 400, right: 620, top: 180, bottom: 212, width: 220, height: 32 }), focus() {} }
    }
    trigger.props.onClick({ detail: 1 })
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
    const opt = findAll(tree, n => n.props?.role === 'option' && textOf(n) === label)[0]
    assert.ok(opt, `option ${label} exists`)
    opt.props.onClick()
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  }
  pickSearchProvider('DeepSeek Messages search')
  assert.equal(formSaveBtn().props.disabled, false, 'switching away from provider hides its error and unblocks Save')

  // 3. Switch to DeepSeek Search API with valid count=25; save -> web-deepseek-api succeeds, web fails -> web draft MUST stay unsaved!
  pickSearchProvider('DeepSeek Search API')
  countInput().props.onChange({ target: { value: '25' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  formSaveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.ok(textOf(tree).includes('web write failed'))
  // Search provider selection (in failed 'web' ns) MUST still be preserved and Save still enabled to retry!
  const searchTriggerAfterFail = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Search provider')[0]
  assert.ok(textOf(searchTriggerAfterFail).includes('DeepSeek Search API'), 'failed namespace draft must survive partial multi-namespace save')
  assert.equal(formSaveBtn().props.disabled, false, 'Save stays enabled to retry failed namespace')

  // Retry Save now succeeds for 'web' only (web-deepseek-api already saved and cleared!).
  failWebNs = false
  mutated.length = 0
  formSaveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.deepEqual(Array.from(mutated, m => m.ns), ['web'], 'retry commits only the previously failed namespace')
  assert.equal(formSaveBtn().props.disabled, true)
})

test('WebSearchDetailForm preserves unsaved hidden provider edits across full and partial saves', async () => {
  let failWebNs = false
  let apiState = { count: 10, searchBilling: 'auto', fetchBilling: 'auto' }
  let webState = { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' }
  let apiRev = 1
  let webRev = 1
  const mutated = []

  const { mod } = loadMod(async (endpoint, payload) => {
    if (endpoint === 'engine-plugins-list') return { available: true, bundles: [], plugins: [] }
    if (endpoint === 'engine-web-providers') {
      return {
        available: true,
        search: [
          { id: 'deepseek-search-api', title: 'DeepSeek Search API', kind: 'search', available: true },
          { id: 'deepseek-official', title: 'DeepSeek Messages', kind: 'search', available: true },
        ],
        fetch: [
          { id: 'http', title: 'Direct HTTP', kind: 'fetch', available: true },
          { id: 'deepseek-fetch-api', title: 'DeepSeek Fetch API', kind: 'fetch', available: true },
        ],
      }
    }
    if (endpoint === 'engine-settings-list') {
      return {
        available: true,
        writable: true,
        namespaces: [
          { ns: 'web', autoGenerate: true, revision: webRev, value: { ...webState }, base: {}, user: { ...webState }, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'web-deepseek-api', autoGenerate: true, revision: apiRev, value: { ...apiState }, base: { count: 10, searchBilling: 'auto', fetchBilling: 'auto' }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
          { ns: 'web-search-deepseek', autoGenerate: true, revision: 1, value: { maxUses: 5, baseURL: '' }, base: { maxUses: 5 }, user: {}, secrets: [], schema: { type: 'object', dict: {} } },
        ],
      }
    }
    if (endpoint === 'engine-settings-mutate') {
      mutated.push(payload)
      if (payload.ns === 'web-deepseek-api') {
        apiRev += 1
        for (const op of payload.ops) {
          if (op.op === 'set') apiState[op.path[0]] = op.value
        }
        return { ns: 'web-deepseek-api', autoGenerate: true, revision: apiRev, value: { ...apiState }, base: { count: 10, searchBilling: 'auto', fetchBilling: 'auto' }, user: { ...apiState }, secrets: [], schema: { type: 'object', dict: {} } }
      }
      if (payload.ns === 'web') {
        if (failWebNs) throw new Error('web save rejected')
        webRev += 1
        for (const op of payload.ops) {
          if (op.op === 'set') webState[op.path[0]] = op.value
        }
        return { ns: 'web', autoGenerate: true, revision: webRev, value: { ...webState }, base: {}, user: { ...webState }, secrets: [], schema: { type: 'object', dict: {} } }
      }
    }
    return {}
  })

  const harness = createHarness(mod.PluginsSettingsPage, { readOnly: false, subTarget: 'web-search' })
  harness.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  harness.render({ readOnly: false, subTarget: 'web-search' })
  await new Promise(resolve => setTimeout(resolve, 20))
  let tree = harness.render({ readOnly: false, subTarget: 'web-search' })

  const pickMenu = (ariaLabel, optionText) => {
    const trigger = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === ariaLabel)[0]
    assert.ok(trigger, `trigger ${ariaLabel} exists`)
    if (trigger.props.ref) {
      trigger.props.ref.current = { getBoundingClientRect: () => ({ left: 400, right: 620, top: 180, bottom: 212, width: 220, height: 32 }), focus() {} }
    }
    trigger.props.onClick({ detail: 1 })
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
    const opt = findAll(tree, n => n.props?.role === 'option' && textOf(n) === optionText)[0]
    assert.ok(opt, `option ${optionText} exists`)
    opt.props.onClick()
    tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  }

  // 1. Edit Results per search (count=18) under DeepSeek Search API, then switch Search provider to DeepSeek Messages
  //    AND edit Fetch billing (same `web-deepseek-api` namespace!).
  const countInput = () => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Results per search')[0]
  countInput().props.onChange({ target: { value: '18' } })
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  pickMenu('Search provider', 'DeepSeek Messages search')
  pickMenu('Fetch billing', 'API key')

  // 2. Partial save: `web-deepseek-api` saves ONLY `fetchBilling`, `web` fails.
  //    Hidden `web-deepseek-api:count` draft MUST NOT be wiped even though its namespace partially succeeded!
  failWebNs = true
  const formSaveBtn = () => findAll(tree, n => n.type === 'button' && textOf(n) === 'Save').at(-1)
  formSaveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.deepEqual(
    structuredClone(mutated.find(m => m.ns === 'web-deepseek-api').ops),
    [{ op: 'set', path: ['fetchBilling'], value: 'api-key' }],
    'hidden count must not be submitted',
  )

  // 3. Retry Save (full success `ok === true`) while DeepSeek Messages is active.
  //    Hidden `count=18` draft MUST STILL survive full save!
  failWebNs = false
  mutated.length = 0
  formSaveBtn().props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = harness.render({ readOnly: false, subTarget: 'web-search' })
  assert.deepEqual(Array.from(mutated, m => m.ns), ['web'])
  assert.equal(formSaveBtn().props.disabled, true, 'Save disabled after visible changes saved')

  // 4. Switch back to DeepSeek Search API -> hidden draft `18` is still intact and ready to save!
  pickMenu('Search provider', 'DeepSeek Search API')
  assert.equal(countInput().props.value, '18', 'hidden Results per search draft survives both partial and full saves')
  assert.equal(formSaveBtn().props.disabled, false)
})
