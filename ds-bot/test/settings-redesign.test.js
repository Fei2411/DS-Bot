import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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

function makeStatefulReact() {
  const states = new Map()
  const effects = new Map()
  const prevDeps = new Map()
  const activeCleanups = new Map()
  let activePath = ''
  let hookIdx = 0

  const nextSlot = () => {
    const key = `${activePath}#${hookIdx++}`
    return key
  }

  const depsChanged = (prev, next) => {
    if (prev === undefined || next === undefined) return true
    if (prev.length !== next.length) return true
    for (let i = 0; i < prev.length; i += 1) if (!Object.is(prev[i], next[i])) return true
    return false
  }

  const React = {
    Fragment: Symbol('Fragment'),
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch) }
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    useState(init) {
      const key = nextSlot()
      if (!states.has(key)) states.set(key, typeof init === 'function' ? init() : init)
      const set = (next) => {
        const prev = states.get(key)
        states.set(key, typeof next === 'function' ? next(prev) : next)
      }
      return [states.get(key), set]
    },
    useRef(init) {
      const key = nextSlot()
      if (!states.has(key)) states.set(key, { current: init })
      return states.get(key)
    },
    useMemo(fn) {
      const key = nextSlot()
      const val = fn()
      states.set(key, val)
      return val
    },
    useCallback(fn) { return fn },
    useId() { return 'bt-id' },
    createContext(v) { return { Provider: ({ children }) => children, _v: v } },
    useContext(c) { return c?._v },
    useEffect(fn, deps) {
      const key = nextSlot()
      effects.set(key, { fn, deps })
    },
    useLayoutEffect(fn, deps) {
      const key = nextSlot()
      effects.set(key, { fn, deps })
    },
  }

  const expand = (node, path = 'root') => {
    if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${idx}]`))
    if (!node || typeof node !== 'object') return node
    if (node.type === React.Fragment) return expand(node.children, `${path}.F`)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Fn'
      const compPath = `${path}/${name}:${node.props?.key ?? ''}`
      if (node.type.prototype && typeof node.type.prototype.render === 'function') {
        const inst = new node.type({ ...node.props, children: node.children })
        return expand(inst.render(), compPath)
      }
      activePath = compPath
      hookIdx = 0
      const out = node.type({ ...node.props, children: node.children })
      return expand(out, compPath)
    }
    return { ...node, children: expand(node.children ?? [], `${path}.${node.type}`) }
  }

  const runEffects = () => {
    for (const [key, { fn, deps }] of effects.entries()) {
      if (!depsChanged(prevDeps.get(key), deps)) continue
      activeCleanups.get(key)?.()
      prevDeps.set(key, deps)
      const cleanup = fn()
      if (typeof cleanup === 'function') activeCleanups.set(key, cleanup)
      else activeCleanups.delete(key)
    }
    effects.clear()
  }

  return {
    React,
    render(el) {
      effects.clear()
      const tree = expand(el)
      runEffects()
      return tree
    },
    unmount() {
      for (const c of activeCleanups.values()) c()
      activeCleanups.clear()
      prevDeps.clear()
      states.clear()
      effects.clear()
    },
  }
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) findAll(c, pred, out)
  return out
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

const iconStub = () => null
const primitivesStub = {
  IconAgentPresetOutlineMedium: iconStub,
  IconArchiveOutlineMedium: iconStub,
  IconPersonalizationOutlineMedium: iconStub,
  IconSettingsOutlineMedium: iconStub,
  IconUserOutlineMedium: iconStub,
  MarkdownText: () => null,
  FishLogo: () => null,
  writeClipboard: async () => true,
  UserMessageContent: () => null,
}

const baseRoster = {
  bots: [{ id: 'chief', name: 'Chief' }, { id: 'writer', name: 'Writer' }],
  rooms: [{ id: 'r1', name: 'Design', members: ['chief', 'writer'], admin: 'chief' }],
  byId: { chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' } },
  roomsById: { r1: { id: 'r1', name: 'Design', members: ['chief', 'writer'], admin: 'chief' } },
  mainBotIds: ['chief'],
  models: [{ ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek' }],
  prefs: { theme: 'deepseek' },
  connectors: { connectors: [], mail: { accounts: [] } },
  im: { connections: [], platforms: [] },
  imStatus: {},
  phone: { on: false, status: 'off', server: '', phones: [], pairing: null },
  computer: { enabled: false },
  secrets: [],
  secretStore: { mode: 'plaintext' },
}

const withGlobals = async (fn) => {
  const origWin = globalThis.window
  const origDoc = globalThis.document
  const origRaf = globalThis.requestAnimationFrame
  const origCancelRaf = globalThis.cancelAnimationFrame
  const listeners = new Set()
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'keydown') listeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'keydown') listeners.delete(listener) },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280,
    innerHeight: 800,
  }
  globalThis.document = {
    body: { dataset: {}, hasAttribute: () => false },
    documentElement: { addEventListener() {}, removeEventListener() {} },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  try {
    return await fn(listeners)
  } finally {
    globalThis.window = origWin
    globalThis.document = origDoc
    globalThis.requestAnimationFrame = origRaf
    globalThis.cancelAnimationFrame = origCancelRaf
  }
}

test('SettingsDialog consolidates nav into 9 groups and preserves all legacy sub-page deep links', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports

    const actions = {
      openSettings() {},
      closeSettings() {},
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      deepseekServices: () => Promise.resolve(null),
      folders: () => Promise.resolve({ team: '/work' }),
      schedules: () => Promise.resolve({ available: true, tasks: [] }),
      diagnostics: () => Promise.resolve({ entries: [], total: 0, markdown: '' }),
      repoStars: () => Promise.resolve(null),
      setPrefs: () => Promise.resolve(),
    }

    const renderPage = (page, id = null) => {
      harness.unmount()
      return harness.render(harness.React.createElement(SettingsDialog, {
        page, id, roster: baseRoster, actions, useUpdate: sel => sel({}),
      }))
    }

    const generalTree = renderPage('general')
    const navButtons = findAll(findAll(generalTree, n => n.type === 'nav')[0], n => n.type === 'button')
    assert.deepEqual(navButtons.map(textOf), ['General', 'Appearance', 'Models', 'Team', 'Connect', 'Tools', 'Usage', 'About DS Bot'])

    const routes = [
      ['models', 'Models', 'Providers'],
      ['bot-models', 'Models', 'Bot models'],
      ['local-agents', 'Models', 'Local agents'],
      ['deepseek-services', 'Models', 'DeepSeek services'],
      ['bots', 'Team', 'Bots'],
      ['groups', 'Team', 'Group chats'],
      ['schedules', 'Team', 'Scheduled tasks'],
      ['connectors', 'Connect', 'Connectors'],
      ['im', 'Connect', 'IM'],
      ['phone', 'Connect', 'Phone'],
      ['mcp', 'Connect', 'MCP access'],
      ['computer', 'Tools', 'Computer use'],
      ['browser', 'Tools', 'Browser'],
      ['capabilities', 'Tools', 'Capabilities'],
      ['secrets', 'Tools', 'Secrets'],
      ['about', 'About DS Bot', 'About DS Bot'],
      ['feedback', 'About DS Bot', 'Feedback'],
    ]

    for (const [page, expectedGroup, expectedTab] of routes) {
      const tree = renderPage(page)
      const currentNav = findAll(tree, n => n.type === 'button' && n.props['aria-current'] === 'page')[0]
      assert.equal(textOf(currentNav), expectedGroup, `page "${page}" should highlight nav group "${expectedGroup}"`)
      const subnav = findAll(tree, n => n.props?.className === 'bt-settings-subnav')[0]
      assert.ok(subnav, `page "${page}" should render sub-tab bar`)
      const activeTab = findAll(subnav, n => n.type === 'button' && n.props['aria-pressed'] === true)[0]
      assert.ok(textOf(activeTab).startsWith(expectedTab), `page "${page}" should activate sub-tab "${expectedTab}", got "${textOf(activeTab)}"`)
    }

    // Drilled-down Bot detail hides sub-tabs and shows Back button.
    const botDetail = renderPage('bots', 'chief')
    assert.equal(findAll(botDetail, n => n.props?.className === 'bt-settings-subnav').length, 0)
    assert.ok(findAll(botDetail, n => n.type === 'button' && n.props['aria-label'] === 'Back to Bots').length === 1)
    harness.unmount()
  })
})

test('Settings search filters bilingual keywords, clears on Escape without closing, and auto-expands Advanced', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'")
  await withGlobals(async (listeners) => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports

    let closed = 0
    const opened = []
    let currentPage = 'general'
    const actions = {
      openSettings: (page, id) => { opened.push([page, id ?? null]); currentPage = page },
      closeSettings: () => { closed += 1 },
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      folders: () => Promise.resolve({ team: '/work' }),
      setPrefs: () => Promise.resolve(),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, {
      page: currentPage, id: null, roster: baseRoster, actions, useUpdate: sel => sel({}),
    }))

    let tree = draw()
    const searchInput = () => findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-set-search-input')[0]

    // Search in Chinese for WeChat → matches IM.
    searchInput().props.onChange({ target: { value: '微信' } })
    tree = draw()
    const hits = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit')
    assert.equal(hits.length, 1)
    assert.match(textOf(hits[0]), /IM/)

    // IME composition Enter & Escape (isComposing and legacy keyCode 229) must not navigate or clear search.
    searchInput().props.onKeyDown({ key: 'Enter', isComposing: true, preventDefault() {}, stopPropagation() {} })
    searchInput().props.onKeyDown({ key: 'Enter', isComposing: false, keyCode: 229, preventDefault() {}, stopPropagation() {} })
    searchInput().props.onKeyDown({ key: 'Escape', isComposing: true, preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(opened, [])
    tree = draw()
    assert.equal(searchInput().props.value, '微信')

    // Window Escape (e.g. focus outside search input) clears search without closing Settings.
    for (const fn of [...listeners]) fn({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault() {}, stopPropagation() {} })
    assert.equal(closed, 0)
    tree = draw()
    assert.equal(searchInput().props.value, '')

    // Second Escape when search is empty closes Settings.
    for (const fn of [...listeners]) fn({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault() {}, stopPropagation() {} })
    assert.equal(closed, 1)

    // Exact visible control labels match in search.
    for (const q of ['Show thinking', 'Bot animation', 'Bring up related memory', 'Background commands']) {
      searchInput().props.onChange({ target: { value: q } })
      tree = draw()
      assert.ok(findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit').length >= 1, `search should match "${q}"`)
    }

    // Searching "memory" opens General with Advanced expanded; manually collapsing and
    // searching another Advanced item re-expands Advanced.
    searchInput().props.onChange({ target: { value: 'memory' } })
    tree = draw()
    const memHit = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit')[0]
    assert.ok(memHit)
    memHit.props.onClick()
    assert.deepEqual(opened, [['general', null]])
    draw()
    tree = draw()
    let collapseBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-row bt-set-collapse')[0]
    assert.equal(collapseBtn.props['aria-expanded'], true, 'jumping to Memory via search must auto-expand Advanced')
    collapseBtn.props.onClick()
    tree = draw()
    collapseBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-row bt-set-collapse')[0]
    assert.equal(collapseBtn.props['aria-expanded'], false, 'manual click collapses Advanced')

    searchInput().props.onChange({ target: { value: 'Background commands' } })
    tree = draw()
    const bgHit = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit')[0]
    assert.ok(bgHit)
    bgHit.props.onClick()
    draw()
    tree = draw()
    collapseBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-row bt-set-collapse')[0]
    assert.equal(collapseBtn.props['aria-expanded'], true, 'second Advanced search hit must re-expand Advanced')
    harness.unmount()
  })
})

test('SettingsTour auto-runs once on first open, catches Escape before Settings, and replays from About and per-section header', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'; export { TOUR_SEEN_KEY, placeCard, stepsForTour } from './src/client/settings-tour.js'")
  await withGlobals(async (listeners) => {
    const store = new Map()
    globalThis.window.localStorage = {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, val) => { store.set(key, String(val)) },
    }
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog, TOUR_SEEN_KEY, placeCard, stepsForTour } = mod.exports

    let closed = 0
    const opened = []
    let currentPage = 'general'
    const actions = {
      openSettings: (page, id) => { opened.push([page, id ?? null]); currentPage = page },
      closeSettings: () => { closed += 1 },
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      deepseekServices: () => Promise.resolve(null),
      folders: () => Promise.resolve({ team: '/work' }),
      schedules: () => Promise.resolve({ available: true, tasks: [] }),
      repoStars: () => Promise.resolve(null),
      setPrefs: () => Promise.resolve(),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, {
      page: currentPage, id: null, roster: baseRoster, actions, useUpdate: sel => sel({}),
    }))

    // First open: full walkthrough starts automatically on General.
    let tree = draw()
    let tourLayer = findAll(tree, n => n.props?.className === 'bt-tour-layer')[0]
    assert.ok(tourLayer, 'full walkthrough should auto-start on first open')
    assert.equal(tourLayer.props['data-tour-mode'], 'full')
    assert.equal(tourLayer.props['data-tour-step'], 'search')

    // Next advances step and navigates to Models.
    const nextBtn = () => findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-send bt-soft-sm')[0]
    nextBtn().props.onClick()
    tree = draw()
    assert.equal(currentPage, 'models')
    tree = draw()
    tourLayer = findAll(tree, n => n.props?.className === 'bt-tour-layer')[0]
    assert.equal(tourLayer.props['data-tour-step'], 'provider-list')

    // Pressing Escape dismisses the walkthrough (priority 1) WITHOUT closing Settings and marks seen.
    for (const fn of [...listeners]) fn({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault() {}, stopPropagation() {} })
    assert.equal(closed, 0, 'Escape while tour is active must not close Settings')
    assert.equal(store.get(TOUR_SEEN_KEY), '1', 'dismissing full tour persists seen flag')
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer').length, 0)

    // Re-mounting Settings on General does NOT auto-start a second time.
    harness.unmount()
    currentPage = 'general'
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer').length, 0)

    // Per-section header Guide button launches that section's focused walkthrough.
    const headerGuide = findAll(tree, n => n.type === 'button' && typeof n.props?.className === 'string' && n.props.className.includes('bt-tour-trigger'))[0]
    assert.ok(headerGuide, 'General page should have header Guide button')
    headerGuide.props.onClick()
    tree = draw()
    tourLayer = findAll(tree, n => n.props?.className === 'bt-tour-layer')[0]
    assert.ok(tourLayer)
    assert.equal(tourLayer.props['data-tour-mode'], 'general')
    assert.equal(tourLayer.props['data-tour-step'], 'default-model')

    // About page exposes Settings guide replay row that starts the full walkthrough again.
    harness.unmount()
    currentPage = 'about'
    tree = draw()
    const aboutStart = findAll(tree, n => n.type === 'button' && textOf(n).includes('Start'))[0]
    assert.ok(aboutStart, 'About page should have Start button for Settings guide')
    aboutStart.props.onClick()
    tree = draw()
    assert.equal(currentPage, 'general')
    tree = draw()
    tourLayer = findAll(tree, n => n.props?.className === 'bt-tour-layer')[0]
    assert.ok(tourLayer)
    assert.equal(tourLayer.props['data-tour-mode'], 'full')

    // Smart card placement keeps popover inside dialog bounds on desktop and mobile.
    const railPos = placeCard({ left: 10, top: 16, width: 192, height: 32, dialogW: 1100, dialogH: 780 }, 304, 140)
    assert.ok(railPos.left > 202, 'left-rail target places card to the right')
    const belowPos = placeCard({ left: 240, top: 80, width: 500, height: 100, dialogW: 1100, dialogH: 780 }, 304, 140)
    assert.ok(belowPos.top >= 190, 'upper content target places card below')
    const abovePos = placeCard({ left: 240, top: 600, width: 500, height: 120, dialogW: 1100, dialogH: 780 }, 304, 140)
    assert.ok(abovePos.top <= 450, 'bottom content target places card above')
    const mobilePos = placeCard({ left: 16, top: 120, width: 340, height: 80, dialogW: 390, dialogH: 844 }, 304, 140)
    assert.equal(mobilePos.bottom, 12, 'mobile target near top docks card at bottom')

    // Every data-tour target referenced by settings-tour.js exists in client source.
    const clientDir = join(repoRoot, 'ds-bot/src/client')
    const allClientSource = readdirSync(clientDir).filter(f => f.endsWith('.js') && f !== 'settings-tour.js').map(f => readFileSync(join(clientDir, f), 'utf8')).join('\n')
    const modes = ['full', 'general', 'appearance', 'models', 'bot-models', 'local-agents', 'deepseek-services', 'bots', 'groups', 'schedules', 'connectors', 'im', 'phone', 'mcp', 'computer', 'browser', 'capabilities', 'secrets', 'usage']
    for (const mode of modes) {
      for (const step of stepsForTour(mode, { hasProviders: true, hasAdvancedModels: true })) {
        const present = allClientSource.includes(`'${step.target}'`) || allClientSource.includes(`"${step.target}"`)
        assert.ok(present, `tour target "${step.target}" (${mode}) must exist in client source`)
      }
    }

    // Wrapped card rows (e.g. .bt-secret-item > .bt-set-row) must not get unscoped :first-child/:last-child corners.
    const stylesSrc = readFileSync(join(clientDir, 'styles.js'), 'utf8')
    assert.ok(!stylesSrc.includes('\n.bt-set-row:first-child{'), 'unscoped .bt-set-row:first-child causes notched hover corners on wrapped rows')
    assert.ok(!stylesSrc.includes('\n.bt-set-row:last-child{'), 'unscoped .bt-set-row:last-child causes notched hover corners on wrapped rows')
    assert.ok(stylesSrc.includes('.bt-set-card{border:.5px solid var(--bt-glass-rim);border-radius:12px;background:var(--bt-card);box-shadow:var(--bt-card-shadow);display:flex;flex-direction:column;overflow:hidden}'))
    assert.ok(stylesSrc.includes('button.bt-select{display:inline-flex;align-items:center;'))
    harness.unmount()
  })
})

test('PhonePage offers one-click Turn on & pair and collapses custom relay server editor by default', async () => {
  const code = await loadBundle("export { PhonePage } from './src/client/phone-page.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : harness.React
    ))
    const { PhonePage } = mod.exports

    const Section = ({ title, children }) => harness.React.createElement('section', null, harness.React.createElement('h3', null, title), children)
    const Row = ({ label, hint, children }) => harness.React.createElement('div', null, harness.React.createElement('span', null, label), hint ? harness.React.createElement('span', null, hint) : null, children)

    const calls = []
    const actions = {
      phoneSet: patch => { calls.push(['set', patch]); return Promise.resolve() },
      phonePair: () => { calls.push(['pair']); return Promise.resolve() },
      phonePairCancel: () => Promise.resolve(),
      phoneRemove: () => Promise.resolve(),
    }

    let phone = { on: false, status: 'off', server: '', phones: [], pairing: null }
    const draw = () => harness.render(harness.React.createElement(PhonePage, {
      roster: { phone }, actions, Section, Row,
    }))

    let tree = draw()
    // Server input is collapsed by default.
    assert.equal(findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Server').length, 0)
    // Click Edit to reveal Server input.
    const editBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Edit')[0]
    assert.ok(editBtn)
    editBtn.props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Server').length, 1)

    // Click Turn on & pair while phone access is off.
    const pairBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Turn on & pair')[0]
    assert.ok(pairBtn)
    assert.equal(pairBtn.props.disabled, false)
    pairBtn.props.onClick()
    assert.deepEqual(calls, [['set', { on: true }]])

    // Once phone comes online, pairing starts automatically.
    phone = { ...phone, on: true, status: 'online' }
    tree = draw()
    assert.deepEqual(calls, [['set', { on: true }], ['pair']])
    // Relay online with 0 connected phones reads Ready, not Phone online.
    assert.match(textOf(tree), /Ready/)
    assert.doesNotMatch(textOf(tree), /Phone online/)

    // Failed phoneSet clears wantPair and keeps server editor open.
    harness.unmount()
    const failingActions = {
      phoneSet: () => Promise.reject(new Error('host locked')),
      phonePair: () => Promise.resolve(),
      phonePairCancel: () => Promise.resolve(),
      phoneRemove: () => Promise.resolve(),
    }
    phone = { on: false, status: 'off', server: '', phones: [], pairing: null }
    const drawFail = () => harness.render(harness.React.createElement(PhonePage, {
      roster: { phone }, actions: failingActions, Section, Row,
    }))
    let failTree = drawFail()
    findAll(failTree, n => n.type === 'button' && textOf(n) === 'Edit')[0].props.onClick()
    failTree = drawFail()
    findAll(failTree, n => n.type === 'input' && n.props?.['aria-label'] === 'Server')[0].props.onChange({ target: { value: 'wss://bad.example' } })
    failTree = drawFail()
    findAll(failTree, n => n.type === 'button' && textOf(n) === 'Save')[0].props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    failTree = drawFail()
    assert.equal(findAll(failTree, n => n.type === 'input' && n.props?.['aria-label'] === 'Server').length, 1, 'failed save must keep server editor open')

    findAll(failTree, n => n.type === 'button' && textOf(n) === 'Turn on & pair')[0].props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    failTree = drawFail()
    assert.ok(findAll(failTree, n => n.type === 'button' && textOf(n) === 'Turn on & pair').length === 1, 'failed phoneSet must clear wantPair')

    // Browser pairing retains relay trust warning.
    harness.unmount()
    phone = {
      on: true,
      status: 'online',
      server: 'wss://relay.example/v1/link',
      phones: [{ id: 'p1', name: 'Pixel', connected: true, pairedAt: Date.now() }],
      pairing: { uri: 'dsbot://pair?t=1', browserUri: '#pair=1', expiresAt: Date.now() + 60_000 },
    }
    const pairTree = draw()
    assert.match(textOf(pairTree), /Phone online/)
    assert.match(textOf(pairTree), /Only use a Server you trust/)
    harness.unmount()
  })
})

test('BrowserPage collapses Allow an action form behind Allow action toggle and uses Segmented duration', async () => {
  const code = await loadBundle("export { BrowserPage } from './src/client/browser-settings.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : harness.React
    ))
    const { BrowserPage } = mod.exports

    const Section = ({ title, action, children }) => harness.React.createElement('section', null, harness.React.createElement('h3', null, title), action, children)
    const Row = ({ label, hint, children }) => harness.React.createElement('div', null, harness.React.createElement('span', null, label), hint ? harness.React.createElement('span', null, hint) : null, children)

    const draw = () => harness.render(harness.React.createElement(BrowserPage, {
      roster: baseRoster, actions: { updateBot: () => Promise.resolve() }, run: p => p, Section, Row,
    }))

    let tree = draw()
    assert.equal(findAll(tree, n => n.type === 'form').length, 0, 'form should be collapsed initially')
    const toggleBtn = findAll(tree, n => n.type === 'button' && textOf(n).includes('Allow action'))[0]
    assert.ok(toggleBtn)
    toggleBtn.props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'form').length, 1)
    assert.ok(findAll(tree, n => n.props?.className?.includes('bt-seg')).length >= 1, 'Duration should use Segmented')
    harness.unmount()
  })
})
