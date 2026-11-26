import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function loadBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: join(repoRoot, 'ds-bot') },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

const bundleCode = await loadBundle("export { PluginsPage } from './src/client/plugins-page.js'")

function mountPluginsPage({ view = SAMPLE_VIEW, roster = DEFAULT_ROSTER, actions: extraActions = {}, initialFilter = null } = {}) {
  const states = new Map()
  const effects = new Map()
  const memos = new Map()
  let path = ''
  let idx = 0

  const slot = () => `${path}#${idx++}`
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity),
      }
    },
    useState(init) {
      const k = slot()
      if (!states.has(k)) states.set(k, typeof init === 'function' ? init() : init)
      return [states.get(k), next => states.set(k, typeof next === 'function' ? next(states.get(k)) : next)]
    },
    useEffect(fn, deps) {
      const k = slot()
      const prev = effects.get(k)
      if (!prev || !sameDeps(prev.deps, deps)) {
        prev?.cleanup?.()
        const cleanup = fn()
        effects.set(k, { deps, cleanup: typeof cleanup === 'function' ? cleanup : null })
      }
    },
    useCallback(fn, deps) {
      const k = slot()
      const prev = memos.get(k)
      if (prev && sameDeps(prev.deps, deps)) return prev.value
      memos.set(k, { deps, value: fn })
      return fn
    },
    useMemo(fn, deps) {
      const k = slot()
      const prev = memos.get(k)
      if (prev && sameDeps(prev.deps, deps)) return prev.value
      const value = fn()
      memos.set(k, { deps, value })
      return value
    },
    useRef(init) {
      const k = slot()
      if (!states.has(k)) states.set(k, { current: init })
      return states.get(k)
    },
    useLayoutEffect(fn, deps) { return React.useEffect(fn, deps) },
  }

  function render(node, prefix = 'r') {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${prefix}.${i}`))
    if (typeof node.type === 'function') {
      const prevPath = path
      const prevIdx = idx
      path = prefix
      idx = 0
      const out = node.type({ ...node.props, children: node.children })
      path = prevPath
      idx = prevIdx
      return render(out, `${prefix}>`)
    }
    return { ...node, children: (node.children ?? []).map((child, i) => render(child, `${prefix}.${child?.props?.key ?? i}`)).filter(c => c !== null) }
  }

  const copied = []
  const primitives = {
    writeClipboard: async (text) => { copied.push(text); return true },
  }
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', bundleCode)(mod, mod.exports, (id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    return React
  })
  const { PluginsPage } = mod.exports

  const calls = []
  const actions = {
    pluginsList: () => Promise.resolve(view),
    pluginsCatalogRefresh: () => Promise.resolve(view),
    pluginsSlotSet: (s, id) => {
      calls.push(['slot', s, id])
      return Promise.resolve({
        ...view,
        slots: { browser: { ...view.slots.browser, active: id } },
        plugins: view.plugins.map(p => (p.slot === s ? { ...p, active: p.id === id, enabled: p.id === id } : p)),
      })
    },
    pluginsInstall: body => { calls.push(['install', body]); return Promise.resolve({ view }) },
    pluginsToggle: (id, enabled) => { calls.push(['toggle', id, enabled]); return Promise.resolve(view) },
    pluginsBotToggle: (id, botId, enabled) => { calls.push(['bot', id, botId, enabled]); return Promise.resolve(view) },
    pluginsUpdate: id => { calls.push(['update', id]); return Promise.resolve({ view }) },
    pluginsRemove: id => { calls.push(['remove', id]); return Promise.resolve(view) },
    pluginsCustomSave: body => { calls.push(['custom', body]); return Promise.resolve({ view }) },
    pluginsSourceSave: body => { calls.push(['source', body]); return Promise.resolve(view) },
    pluginsSourceRemove: id => { calls.push(['source-remove', id]); return Promise.resolve(view) },
    pluginsRetry: () => { calls.push(['retry']); return Promise.resolve(view) },
    notice: msg => { calls.push(['notice', msg]) },
    ...extraActions,
  }
  const Section = ({ title, children }) => React.createElement('section', null, React.createElement('h3', null, title), ...(children ?? []))
  const Row = ({ label, hint, children }) => React.createElement('div', null, React.createElement('span', null, label), hint ? React.createElement('span', null, hint) : null, ...(children ?? []))

  const draw = () => render(React.createElement(PluginsPage, { roster, actions, Section, Row, initialFilter }))
  return { draw, calls, copied }
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) findAll(c, pred, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const flush = () => new Promise(r => setTimeout(r, 0))
const DEFAULT_ROSTER = { bots: [{ id: 'chief', name: 'Chief' }, { id: 'writer', name: 'Writer' }] }

const SAMPLE_VIEW = {
  managerAvailable: true,
  officialRegistryUrl: 'https://raw.githubusercontent.com/Fei-Craft/ds-bot-plugins/main/registry.json',
  catalog: { fetchedAt: 1700000000000, offline: false, errors: [] },
  sources: [{ id: 'src-1', name: 'Team Registry', url: 'https://team.example.com/registry.json' }],
  slots: {
    browser: { active: 'builtin:readonly', desired: 'builtin:readonly', status: 'ready', error: null, restartReason: null },
  },
  plugins: [
    {
      id: 'builtin:readonly', name: 'Read-only Browser', description: 'Read open page',
      category: 'browser', slot: 'browser', kind: 'builtin', installed: true, enabled: true, active: true,
      status: 'ready', builtin: true, removable: false, supportsPerBot: false, toolPrefixes: ['read_browser'],
    },
    {
      id: 'builtin:refs', name: 'Playwright (Refs)', description: 'Click by ref',
      category: 'browser', slot: 'browser', kind: 'builtin', installed: true, enabled: false, active: false,
      status: 'inactive', builtin: true, removable: false, supportsPerBot: false, toolPrefixes: ['browser_open'],
    },
    {
      id: 'dsh:dsh-ego-browser', name: 'Ego Lite Browser', description: 'Ego browser plugin',
      category: 'browser', slot: 'browser', kind: 'dsh', installed: false, enabled: false, active: false,
      status: 'unavailable', builtin: false, verified: true, removable: false, supportsPerBot: false,
      packageName: 'dsh-ego-browser', installSpec: 'dsh-ego-browser', toolPrefixes: ['ego_'],
      homepage: 'https://example.com/ego', repository: 'https://github.com/example/ego',
    },
    {
      id: 'mcp:notes', name: 'Notes MCP', description: 'Team notes',
      category: 'tools', slot: null, kind: 'mcp', installed: true, enabled: true, active: true,
      status: 'ready', builtin: false, custom: true, removable: true, supportsPerBot: true,
      offFor: [], toolPrefixes: ['mcp__dsbp-notes__'],
      homepage: 'javascript:alert(1)',
    },
  ],
}

test('PluginsPage renders borderless tiles with switch knobs, switches browser slot, opens detail subview, toggles per-Bot, and sanitizes links', async () => {
  const { draw, calls } = mountPluginsPage()
  draw()
  await flush()
  let tree = draw()

  assert.match(textOf(tree), /Browser control/)
  assert.match(textOf(tree), /browser:\/\/readonly/)
  assert.match(textOf(tree), /Ego Lite Browser/)
  assert.match(textOf(tree), /Notes MCP/)

  // Browser Control Stage & tiles render official marks; inactive tiles start without data-active.
  const stage = findAll(tree, n => n.type === 'div' && n.props?.className === 'bt-plg-stage')[0]
  assert.ok(stage)
  const refsTileBefore = findAll(tree, n => n.type === 'div' && n.props?.className === 'bt-plg-tile' && textOf(n).includes('Playwright (Refs)'))[0]
  assert.ok(refsTileBefore)
  assert.equal(refsTileBefore.props['data-active'], undefined)

  // General plugin switch renders real `.bt-switch-knob`.
  const generalSwitch = findAll(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props['aria-label'] === 'Notes MCP')[0]
  assert.ok(generalSwitch)
  assert.ok(findAll(generalSwitch, n => n.type === 'span' && n.props?.className === 'bt-switch-knob').length === 1)

  // Click "Use" on Playwright (Refs) → stage switches to Playwright emerald and plays activation sweep.
  const useBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Use')[0]
  useBtn.props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['slot', 'browser', 'builtin:refs'])

  // First draw updates props/effect (`setFresh(true)`); next draw reflects `data-fresh`.
  tree = draw()
  tree = draw()
  const stageAfter = findAll(tree, n => n.type === 'div' && n.props?.className === 'bt-plg-stage')[0]
  assert.ok(stageAfter)
  assert.match(textOf(stageAfter), /browser:\/\/playwright\/refs/)
  assert.equal(stageAfter.props['data-fresh'], '')
  const refsTileAfter = findAll(tree, n => n.type === 'div' && n.props?.className === 'bt-plg-tile' && textOf(n).includes('Playwright (Refs)'))[0]
  assert.equal(refsTileAfter.props['data-active'], '')
  assert.equal(refsTileAfter.props['data-fresh'], '')

  // Switching away within the 1100ms sweep window immediately clears `data-fresh` on the deactivated tile.
  const backUseBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Use')[0]
  backUseBtn.props.onClick()
  await flush()
  tree = draw()
  tree = draw()
  const refsTileDeactivated = findAll(tree, n => n.type === 'div' && n.props?.className === 'bt-plg-tile' && textOf(n).includes('Playwright (Refs)'))[0]
  assert.equal(refsTileDeactivated.props['data-active'], undefined)
  assert.equal(refsTileDeactivated.props['data-fresh'], undefined)

  // Open Notes MCP detail subview → unsafe `javascript:` homepage is NOT rendered; per-Bot switches include `.bt-switch-knob`.
  const notesBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-plg-main' && textOf(n).includes('Notes MCP'))[0]
  assert.ok(notesBtn)
  notesBtn.props.onClick()
  tree = draw()
  assert.equal(findAll(tree, n => n.type === 'a').length, 0)
  const writerSwitch = findAll(tree, n => n.type === 'button' && n.props?.role === 'switch' && String(n.props['aria-label']).includes('Writer'))[0]
  assert.ok(writerSwitch)
  assert.ok(findAll(writerSwitch, n => n.type === 'span' && n.props?.className === 'bt-switch-knob').length === 1)
  writerSwitch.props.onClick()
  await flush()
  assert.deepEqual(calls[2], ['bot', 'mcp:notes', 'writer', false])

  // Two-step remove confirmation executes removal.
  tree = draw()
  findAll(tree, n => n.type === 'button' && textOf(n) === 'Remove')[0].props.onClick()
  tree = draw()
  findAll(tree, n => n.type === 'button' && textOf(n) === 'Confirm remove')[0].props.onClick()
  await flush()
  assert.deepEqual(calls[3], ['remove', 'mcp:notes'])

  // Back on main catalog, open Ego Lite Browser detail subview → safe `https:` links rendered with `noopener noreferrer`.
  tree = draw()
  const egoBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-plg-main' && textOf(n).includes('Ego Lite Browser'))[0]
  egoBtn.props.onClick()
  tree = draw()
  const links = findAll(tree, n => n.type === 'a')
  assert.equal(links.length, 2)
  assert.equal(links[0].props.href, 'https://example.com/ego')
  assert.equal(links[0].props.rel, 'noopener noreferrer')
  assert.equal(links[1].props.href, 'https://github.com/example/ego')
})

test('PluginsPage handles pendingBuilds approval flow and retries with approvedBuilds', async () => {
  let attempt = 0
  const { draw, calls } = mountPluginsPage({
    actions: {
      pluginsInstall(body) {
        calls.push(['install', body])
        attempt += 1
        if (attempt === 1) {
          return Promise.reject(Object.assign(new Error('Build scripts blocked'), {
            code: 'bot/refused',
            details: { pendingBuilds: ['esbuild', 'better-sqlite3'] },
          }))
        }
        return Promise.resolve({ view: SAMPLE_VIEW })
      },
    },
  })
  draw()
  await flush()
  let tree = draw()
  findAll(tree, n => n.type === 'button' && textOf(n) === 'Install')[0].props.onClick()
  await flush()
  tree = draw()

  assert.match(textOf(tree), /esbuild, better-sqlite3/)
  const approveBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Approve & install')[0]
  assert.ok(approveBtn)
  approveBtn.props.onClick()
  await flush()
  assert.deepEqual(calls[1], ['install', {
    id: 'dsh:dsh-ego-browser',
    spec: 'dsh-ego-browser',
    approvedBuilds: ['esbuild', 'better-sqlite3'],
  }])
})

test('PluginsPage preserves AddCustomSection form on error and handles !managerAvailable DSH copy + save', async () => {
  const noMgrView = {
    ...SAMPLE_VIEW,
    managerAvailable: false,
    plugins: [
      ...SAMPLE_VIEW.plugins.slice(0, 2),
      {
        ...SAMPLE_VIEW.plugins[2],
        installSpec: 'dsh-ego-browser',
      },
      {
        id: 'dsh:evil', name: 'Unsafe Spec Plugin', description: 'Bad spec',
        category: 'tools', slot: null, kind: 'dsh', installed: false, enabled: false, active: false,
        status: 'unavailable', builtin: false, removable: false, supportsPerBot: false,
        packageName: 'evil', installSpec: 'pkg & calc.exe', toolPrefixes: [],
      },
    ],
  }
  let failSave = true
  const { draw, calls, copied } = mountPluginsPage({
    view: noMgrView,
    actions: {
      pluginsCustomSave(body) {
        calls.push(['custom', body])
        if (failSave) return Promise.reject(new Error('Invalid plugin spec'))
        return Promise.resolve({ view: noMgrView })
      },
    },
  })
  draw()
  await flush()
  let tree = draw()

  // Main view with !managerAvailable copies safe specs and hides Copy for unsafe cmd/shell metacharacter specs.
  const copyBtns = findAll(tree, n => n.type === 'button' && textOf(n).includes('Copy install command'))
  assert.equal(copyBtns.length, 1)
  copyBtns[0].props.onClick()
  await flush()
  assert.equal(copied[0], 'dsh plugin add dsh-ego-browser')

  // Add plugin subview: failed save shows error and preserves input value instead of clearing.
  findAll(tree, n => n.type === 'button' && textOf(n) === 'Add plugin')[0].props.onClick()
  tree = draw()
  const pkgInput = findAll(tree, n => n.type === 'input' && n.props['aria-label'] === 'Package or repository')[0]
  pkgInput.props.onChange({ target: { value: 'my-dsh-plugin' } })
  tree = draw()
  const form = findAll(tree, n => n.type === 'form' && n.props.className === 'bt-plg-form')[0]
  await form.props.onSubmit({ preventDefault() {} })
  await flush()
  tree = draw()
  assert.match(textOf(tree), /Invalid plugin spec/)
  const keptInput = findAll(tree, n => n.type === 'input' && n.props['aria-label'] === 'Package or repository')[0]
  assert.equal(keptInput.props.value, 'my-dsh-plugin')

  // Succeeding when !managerAvailable saves custom DSH entry even when optional Name/Slot/Prefixes are empty.
  failSave = false
  const form2 = findAll(tree, n => n.type === 'form' && n.props.className === 'bt-plg-form')[0]
  await form2.props.onSubmit({ preventDefault() {} })
  await flush()
  assert.equal(calls.filter(c => c[0] === 'custom').length, 2)
  assert.equal(calls.filter(c => c[0] === 'install').length, 0)
  tree = draw()
  assert.equal(findAll(tree, n => n.type === 'input' && n.props['aria-label'] === 'Package or repository')[0].props.value, '')
})

test('PluginsPage enforces readOnly mode, displays restart/unavailable/catalog-error banners, and filters by initialFilter', async () => {
  const bannerView = {
    ...SAMPLE_VIEW,
    catalog: { fetchedAt: 1, offline: false, errors: [{ sourceId: 'team', message: 'HTTP 502' }] },
    slots: {
      browser: { active: 'builtin:readonly', desired: 'dsh:gone', status: 'unavailable', error: 'Plugin removed', restartReason: null },
    },
    plugins: SAMPLE_VIEW.plugins.map(p => (p.id === 'mcp:notes' ? { ...p, status: 'restart-required' } : p)),
  }
  const { draw } = mountPluginsPage({
    view: bannerView,
    roster: { ...DEFAULT_ROSTER, readOnly: 'Open in another dsh window.', plugins: { pendingRestart: true } },
    initialFilter: 'browser',
  })
  draw()
  await flush()
  const tree = draw()
  const text = textOf(tree)

  assert.match(text, /Open in another dsh window/)
  assert.match(text, /Plugin removed/)
  assert.match(text, /Restart DS Bot to finish applying plugin changes/)
  assert.match(text, /team: HTTP 502/)
  assert.doesNotMatch(text, /Notes MCP/)
  const useBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Use')[0]
  assert.equal(useBtn.props.disabled, true)
})

test('PluginsPage clears busyId when exec falls back to load(false) without wedging controls', async () => {
  const { draw } = mountPluginsPage({
    actions: {
      pluginsSlotSet: () => Promise.resolve({}),
    },
  })
  draw()
  await flush()
  let tree = draw()
  const useBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Use')[0]
  useBtn.props.onClick()
  await flush()
  await flush()
  tree = draw()
  const useBtnAfter = findAll(tree, n => n.type === 'button' && textOf(n) === 'Use')[0]
  assert.equal(useBtnAfter.props.disabled, false)
})

test('PluginsPage keeps Use button on active read-only fallback when another browser is desired and reloads on live roster change', async () => {
  const fallbackView = {
    ...SAMPLE_VIEW,
    slots: {
      browser: { active: 'builtin:readonly', desired: 'dsh:dsh-ego-browser', status: 'restart-required', error: null, restartReason: 'no-hmr' },
    },
    plugins: SAMPLE_VIEW.plugins.map(p => (p.id === 'builtin:readonly' ? { ...p, active: true, desired: false } : p)),
  }
  let listCalls = 0
  const currentRoster = { ...DEFAULT_ROSTER, plugins: { slots: { browser: { active: 'builtin:readonly' } } } }
  const { draw } = mountPluginsPage({
    view: fallbackView,
    roster: currentRoster,
    actions: {
      pluginsList: () => { listCalls += 1; return Promise.resolve(fallbackView) },
    },
  })
  draw()
  await flush()
  const tree = draw()
  const readonlyTile = findAll(tree, n => n.props?.className === 'bt-plg-tile' && textOf(n).includes('Read-only Browser'))[0]
  assert.ok(findAll(readonlyTile, n => n.type === 'button' && textOf(n) === 'Use').length === 1)
  assert.equal(listCalls, 1)

  currentRoster.plugins = { slots: { browser: { active: 'builtin:refs' } } }
  draw()
  await flush()
  assert.equal(listCalls, 2)
})

test('PluginsPage allows disabling failed MCP plugins via desired state and disables Add form while view is pending', async () => {
  const failedMcpView = {
    ...SAMPLE_VIEW,
    plugins: SAMPLE_VIEW.plugins.map(p => (p.id === 'mcp:notes'
      ? { ...p, enabled: false, active: false, desired: true, status: 'error', error: 'spawn ENOENT' }
      : p)),
  }
  const { draw, calls } = mountPluginsPage({ view: failedMcpView })
  draw()
  await flush()
  const tree = draw()
  const sw = findAll(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props['aria-label'] === 'Notes MCP')[0]
  assert.equal(sw.props['aria-checked'], true)
  sw.props.onClick()
  await flush()
  assert.deepEqual(calls[0], ['toggle', 'mcp:notes', false])

  let resolveList
  const pending = mountPluginsPage({
    actions: { pluginsList: () => new Promise(r => { resolveList = r }) },
  })
  let pendingTree = pending.draw()
  findAll(pendingTree, n => n.type === 'button' && textOf(n) === 'Add plugin')[0].props.onClick()
  pendingTree = pending.draw()
  const submitBtn = findAll(pendingTree, n => n.type === 'button' && n.props?.type === 'submit')[0]
  assert.equal(submitBtn.props.disabled, true)
  resolveList(SAMPLE_VIEW)
})

test('PluginsPage hides uninstalled engine bundles and internal DSH profile/subagent bundles from Discover while keeping real catalog plugins', async () => {
  const leakedEngineItems = [
    {
      id: 'dsh:@deepseek-ai/dsh-acp-app', name: 'ACP Profile', description: 'ACP runtime',
      category: 'other', slot: null, kind: 'dsh', installed: false, enabled: false, active: false,
      status: 'inactive', builtin: false, sourceId: 'installed', packageName: '@deepseek-ai/dsh-acp-app',
    },
    {
      id: 'dsh:@deepseek-ai/dsh-experimental-agent-team-profile', name: 'Agent Team', description: 'Banned subagent bundle',
      category: 'other', slot: null, kind: 'dsh', installed: true, enabled: false, active: false,
      status: 'inactive', builtin: false, sourceId: 'installed', packageName: '@deepseek-ai/dsh-experimental-agent-team-profile',
    },
    {
      id: 'dsh:@deepseek-ai/dsh-subagent-core', name: 'Subagent Core', description: 'Subagent engine',
      category: 'other', slot: null, kind: 'dsh', installed: true, enabled: false, active: false,
      status: 'inactive', builtin: false, sourceId: 'installed', packageName: '@deepseek-ai/dsh-subagent-core',
    },
    {
      id: 'dsh:@deepseek-ai/dsh-devtools-bundle', name: 'Developer Tools', description: 'Uninstalled optional engine bundle',
      category: 'other', slot: null, kind: 'dsh', installed: false, enabled: false, active: false,
      status: 'inactive', builtin: false, sourceId: 'installed', packageName: '@deepseek-ai/dsh-devtools-bundle',
    },
    {
      id: 'dsh:@deepseek-ai/dsh-headless', name: 'Headless Profile', description: 'Headless runtime',
      category: 'other', slot: null, kind: 'dsh', installed: false, enabled: false, active: false,
      status: 'inactive', builtin: false, sourceId: 'installed', packageName: '@deepseek-ai/dsh-headless',
    },
    {
      id: 'dsh:dsbot-engine', name: 'DS Bot Engine', description: 'Internal desktop engine bundle',
      category: 'other', slot: null, kind: 'dsh', installed: true, enabled: true, active: true,
      status: 'ready', builtin: false, sourceId: 'installed', packageName: 'dsbot-engine',
    },
  ]

  // When only browser plugins + leaked engine bundles are present, Discover is empty and shows the clean invite card.
  const emptyGeneralView = {
    ...SAMPLE_VIEW,
    plugins: [...SAMPLE_VIEW.plugins.slice(0, 3), ...leakedEngineItems],
  }
  const emptyMount = mountPluginsPage({ view: emptyGeneralView })
  emptyMount.draw()
  await flush()
  const emptyTree = emptyMount.draw()
  const emptyText = textOf(emptyTree)
  assert.doesNotMatch(emptyText, /ACP Profile|Agent Team|Subagent Core|Developer Tools|Headless Profile|DS Bot Engine/)
  assert.match(emptyText, /Extend Bots with more capabilities/)
  // Category bar must not include an empty "Other" tab from hidden engine bundles.
  const catLabels = findAll(emptyTree, n => n.props?.className === 'bt-plg-cats')[0]
  assert.doesNotMatch(textOf(catLabels), /Other/)

  // Real catalog plugins from official/custom registries still appear in Discover.
  const catalogView = {
    ...emptyGeneralView,
    plugins: [
      ...emptyGeneralView.plugins,
      {
        id: 'dsh:dsbot-notes', name: 'DS Bot Notes', description: 'Official Bot plugin',
        category: 'productivity', slot: null, kind: 'dsh', installed: false, enabled: false, active: false,
        status: 'unavailable', builtin: false, sourceId: 'official', packageName: 'dsbot-notes',
      },
    ],
  }
  const catalogMount = mountPluginsPage({ view: catalogView })
  catalogMount.draw()
  await flush()
  const catalogText = textOf(catalogMount.draw())
  assert.match(catalogText, /Discover/)
  assert.match(catalogText, /DS Bot Notes/)
  assert.doesNotMatch(catalogText, /ACP Profile|Agent Team|Subagent Core|Developer Tools|Headless Profile|DS Bot Engine/)
})

test('PluginsPage shows consent-required with an Approve action, the reason banner, and no misleading enable toggle', async () => {
  const consentView = {
    ...SAMPLE_VIEW,
    plugins: SAMPLE_VIEW.plugins.map(p => (p.id === 'mcp:notes'
      ? {
        ...p,
        enabled: false,
        active: false,
        desired: true,
        status: 'consent-required',
        consentRequired: true,
        error: 'This plugin changed since it was approved (capabilities, execution tier, executable entry, content, or placement). It needs explicit approval before it can run again.',
      }
      : p)),
  }
  const consentCalls = []
  const { draw } = mountPluginsPage({
    view: consentView,
    actions: {
      pluginsConsent: id => { consentCalls.push(id); return Promise.resolve({ view: consentView }) },
    },
  })
  draw()
  await flush()
  let tree = draw()

  // The tile carries the approval-needed badge and an Approve button instead of a switch:
  // a toggle would promise control the consent gate has deliberately withdrawn.
  const tile = findAll(tree, n => n.props?.className === 'bt-plg-tile' && textOf(n).includes('Notes MCP'))[0]
  assert.ok(tile)
  assert.ok(findAll(tile, n => n.type === 'span' && n.props?.className === 'bt-tag' && textOf(n) === 'Approval needed').length === 1)
  assert.equal(findAll(tile, n => n.type === 'button' && n.props?.role === 'switch').length, 0, 'no enable switch while approval is required')
  const approveBtn = findAll(tile, n => n.type === 'button' && textOf(n) === 'Approve')[0]
  assert.ok(approveBtn)
  approveBtn.props.onClick()
  await flush()
  assert.deepEqual(consentCalls, ['mcp:notes'])

  // The detail view explains WHAT changed and offers one clear approval path (banner CTA, no duplicate hero error/button).
  tree = draw()
  findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-plg-main' && textOf(n).includes('Notes MCP'))[0].props.onClick()
  tree = draw()
  assert.match(textOf(tree), /capabilities, execution tier, executable entry, content, or placement/)
  assert.equal(findAll(tree, n => n.props?.className === 'bt-plg-detail-err').length, 0, 'consent banner replaces duplicate hero error')
  const detailApproves = findAll(tree, n => n.type === 'button' && textOf(n) === 'Approve')
  assert.equal(detailApproves.length, 1, 'single Approve CTA in detail view')
  detailApproves[0].props.onClick()
  await flush()
  assert.deepEqual(consentCalls, ['mcp:notes', 'mcp:notes'])
})

test('PluginsPage shows killed plugins as stopped without enable controls and unverifiable plugins as unverifiable', async () => {
  const killedView = {
    ...SAMPLE_VIEW,
    plugins: SAMPLE_VIEW.plugins.map((p) => {
      if (p.id === 'mcp:notes') {
        return {
          ...p,
          enabled: false,
          active: false,
          status: 'killed',
          killed: true,
          error: 'Plugin disabled by the kill list: compromised upstream',
        }
      }
      if (p.id === 'dsh:dsh-ego-browser') {
        return {
          ...p,
          installed: true,
          status: 'unverifiable',
          error: 'Plugin files cannot be verified (symlink escape). It cannot run until its directory is safe to read.',
        }
      }
      return p
    }),
  }
  const { draw, calls } = mountPluginsPage({ view: killedView })
  draw()
  await flush()
  const tree = draw()

  // Killed: badge instead of any enable control — the kill list has decided, not the user.
  const killedTile = findAll(tree, n => n.props?.className === 'bt-plg-tile' && textOf(n).includes('Notes MCP'))[0]
  assert.ok(killedTile)
  assert.ok(findAll(killedTile, n => n.type === 'span' && n.props?.className === 'bt-tag' && textOf(n) === 'Stopped').length === 1)
  assert.equal(findAll(killedTile, n => n.type === 'button' && n.props?.role === 'switch').length, 0)
  assert.equal(findAll(killedTile, n => n.type === 'button' && textOf(n) === 'Approve').length, 0, 'a killed plugin offers no approval path')

  // Unverifiable: explicit badge and no Use action — unverifiable bytes cannot activate.
  const badTile = findAll(tree, n => n.props?.className === 'bt-plg-tile' && textOf(n).includes('Ego Lite Browser'))[0]
  assert.ok(badTile)
  assert.ok(findAll(badTile, n => n.type === 'span' && n.props?.className === 'bt-tag' && textOf(n) === 'Unverifiable').length === 1)
  assert.equal(findAll(badTile, n => n.type === 'button' && textOf(n) === 'Use').length, 0)
  // Neither state offers any action button at all (besides the details opener).
  assert.equal(findAll(killedTile, n => n.type === 'button' && n.props?.className === 'bt-plg-btn').length, 0)
  assert.equal(findAll(badTile, n => n.type === 'button' && n.props?.className === 'bt-plg-btn').length, 0)
  assert.equal(calls.length, 0)
})

test('PluginsPage shows the execution tier row and the floating-version note in details', async () => {
  const floatingView = {
    ...SAMPLE_VIEW,
    plugins: SAMPLE_VIEW.plugins.map(p => (p.id === 'mcp:notes'
      ? { ...p, execution: 'trusted-worker', unpinnedSpec: true, version: null }
      : p)),
  }
  const { draw } = mountPluginsPage({ view: floatingView })
  draw()
  await flush()
  let tree = draw()
  findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-plg-main' && textOf(n).includes('Notes MCP'))[0].props.onClick()
  tree = draw()
  assert.match(textOf(tree), /Execution tier/)
  assert.match(textOf(tree), /trusted-worker/)
  assert.match(textOf(tree), /approval does not pin exact bytes/)
})
