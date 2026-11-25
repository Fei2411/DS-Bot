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
    EngineConfigPage,
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
  assert.deepEqual(sectionHeadings, ['Web search API', 'Web'], 'suppresses duplicate Web search section heading')
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
    signedIn: false,
    account: null,
    attempt: null,
  }
  const calls = []
  const { mod, sandbox } = loadMod(async (ep, body) => {
    calls.push([ep, body])
    if (ep === 'engine-account-state') return { available: true, view }
    if (ep === 'engine-account-signin') {
      view = {
        signedIn: false,
        account: null,
        attempt: { id: 'att-1', phase: 'waiting-browser', authorizeUrl: 'https://auth.deepseek.com/oauth/start?state=abc' },
      }
      return { available: true, view }
    }
    if (ep === 'engine-account-cancel') {
      view = { signedIn: false, account: null, attempt: null }
      return { available: true, view }
    }
    if (ep === 'engine-account-signout') {
      view = { signedIn: false, account: null, attempt: null }
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
