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

test('SettingsDialog opens on Overview, lists 9 nav groups, and scrolls domain parts under anchors for every legacy deep link', async () => {
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
        page, id, roster: baseRoster, actions, useUpdate: sel => sel({ available: true }),
      }))
    }

    // No page (the desktop app's gear button) lands on Overview.
    const home = renderPage(undefined)
    assert.equal(textOf(findAll(home, n => n.type === 'h2')[0]), 'Overview')
    const nav = findAll(home, n => n.type === 'nav' && n.props?.className === 'bt-settings-nav')[0]
    const labels = findAll(nav, n => n.props?.className === 'bt-settings-label').map(textOf)
    assert.deepEqual(labels, ['Overview', 'General', 'Appearance', 'Models', 'Team', 'Connect', 'Tools', 'Usage', 'About DS Bot'])
    // Team shows its count; About shows an update when one is out.
    assert.equal(textOf(findAll(nav, n => n.props?.className === 'bt-settings-count')[0]), '2')
    assert.equal(textOf(findAll(nav, n => n.props?.className === 'bt-settings-chip')[0]), 'Update')
    assert.equal(findAll(home, n => n.type === 'section' && n.props?.className === 'bt-ov-tiles').length, 1)
    assert.equal(findAll(home, n => n.props?.className === 'bt-ov-team').length, 1)
    // The legacy `guide` landing resolves to Overview.
    assert.equal(textOf(findAll(renderPage('guide'), n => n.type === 'h2')[0]), 'Overview')

    // Models lists its parts in the order providers → local agents → Bot models → DeepSeek services.
    const models = renderPage('models')
    const anchorsOf = tree => findAll(tree, n => n.type === 'nav' && n.props?.className === 'bt-settings-anchors')[0]
    assert.deepEqual(findAll(anchorsOf(models), n => n.type === 'button').map(textOf), ['Providers', 'Local agents', 'Bot models', 'DeepSeek services'])
    assert.deepEqual(findAll(models, n => n.type === 'section' && n.props?.['data-part']).map(n => n.props['data-part']), ['models', 'local-agents', 'bot-models', 'deepseek-services'])

    const routes = [
      ['models', 'Models', 'Providers'],
      ['local-agents', 'Models', 'Local agents'],
      ['bot-models', 'Models', 'Bot models'],
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
    for (const [page, expectedGroup, expectedPart] of routes) {
      const tree = renderPage(page)
      const currentNav = findAll(tree, n => n.type === 'button' && n.props['aria-current'] === 'page')[0]
      assert.equal(textOf(findAll(currentNav, n => n.props?.className === 'bt-settings-label')[0]), expectedGroup, `page "${page}" should highlight nav group "${expectedGroup}"`)
      const anchors = anchorsOf(tree)
      assert.ok(anchors, `page "${page}" should render the anchor row`)
      const active = findAll(anchors, n => n.type === 'button' && n.props['aria-current'] === 'location')[0]
      assert.ok(textOf(active).startsWith(expectedPart), `page "${page}" should mark anchor "${expectedPart}", got "${textOf(active)}"`)
      assert.equal(findAll(tree, n => n.type === 'section' && n.props?.['data-part'] === page).length, 1, `page "${page}" should render its part`)
    }

    // A drilled-down Bot hides the anchors and leads back to Bots.
    const botDetail = renderPage('bots', 'chief')
    assert.equal(anchorsOf(botDetail), undefined)
    assert.ok(findAll(botDetail, n => n.type === 'button' && n.props['aria-label'] === 'Back to Bots').length === 1)
    // `bots/new` opens Team with the new-Bot form already open.
    const newBotButton = tree => findAll(tree, n => n.type === 'button' && n.props?.['data-tour'] === 'new-bot')
    assert.equal(newBotButton(renderPage('bots')).length, 1)
    assert.equal(newBotButton(renderPage('bots', 'new')).length, 0, 'the form replaces its button')
    harness.unmount()
  })
})

test('Settings search opens as a palette from the rail or ⌘K, finds settings, Bots and models, and Escape closes it before Settings', async () => {
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
    let currentId = null
    const actions = {
      openSettings: (page, id) => { opened.push([page, id ?? null]); currentPage = page; currentId = id ?? null },
      closeSettings: () => { closed += 1 },
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      folders: () => Promise.resolve({ team: '/work' }),
      setPrefs: () => Promise.resolve(),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, {
      page: currentPage, id: currentId, roster: baseRoster, actions, useUpdate: sel => sel({}),
    }))
    const fire = event => { for (const fn of [...listeners]) fn({ isComposing: false, preventDefault() {}, stopPropagation() {}, ...event }) }
    // ⌘K on a Mac, Ctrl+K elsewhere; the other one is left to the text fields.
    const mac = /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? '')
    const primary = mac ? { metaKey: true } : { ctrlKey: true }
    const other = mac ? { ctrlKey: true } : { metaKey: true }

    let tree = draw()
    const searchInput = () => findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-set-search-input')[0]
    const hits = () => findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit')
    const type = (value) => { searchInput().props.onChange({ target: { value } }); tree = draw() }
    assert.equal(searchInput(), undefined, 'the palette stays closed until asked for')

    // The rail's search button opens the palette.
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search')[0].props.onClick()
    tree = draw()
    assert.ok(searchInput())

    // Chinese keywords reach IM.
    type('微信')
    assert.equal(hits().length, 1)
    assert.match(textOf(hits()[0]), /IM/)

    // IME composition Enter & Escape (isComposing and legacy keyCode 229) must not navigate or close.
    searchInput().props.onKeyDown({ key: 'Enter', isComposing: true, preventDefault() {}, stopPropagation() {} })
    searchInput().props.onKeyDown({ key: 'Enter', isComposing: false, keyCode: 229, preventDefault() {}, stopPropagation() {} })
    searchInput().props.onKeyDown({ key: 'Escape', isComposing: true, preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(opened, [])
    tree = draw()
    assert.equal(searchInput().props.value, '微信')

    // Escape from outside the field closes the palette, not Settings; a second one closes Settings.
    fire({ key: 'Escape', keyCode: 27 })
    assert.equal(closed, 0)
    tree = draw()
    assert.equal(searchInput(), undefined)
    fire({ key: 'Escape', keyCode: 27 })
    assert.equal(closed, 1)

    // ⌘K (or Ctrl+K) opens it again from anywhere in Settings; plain K and the other
    // platform's modifier do nothing.
    fire({ key: 'k' })
    fire({ key: 'k', ...other })
    tree = draw()
    assert.equal(searchInput(), undefined)
    fire({ key: 'k', ...primary })
    tree = draw()
    assert.ok(searchInput())

    // Exact visible control labels match.
    for (const q of ['Show thinking', 'Bot animation', 'Bring up related memory', 'Background commands', 'Bubble width']) {
      type(q)
      assert.ok(hits().length >= 1, `search should match "${q}"`)
    }

    // Bots and group chats are found by name and open their own settings.
    type('writer')
    const botHit = hits().find(hit => textOf(hit).includes('Writer'))
    assert.ok(botHit)
    botHit.props.onClick()
    assert.deepEqual(opened.at(-1), ['bots', 'writer'])
    tree = draw()
    assert.equal(searchInput(), undefined, 'picking a hit closes the palette')

    // A model offers the batch switch, which opens Bot models with the model preset.
    fire({ key: 'k', ...primary })
    tree = draw()
    type('deepseek chat')
    const switchHit = hits().find(hit => textOf(hit).startsWith('Switch Bots to DeepSeek Chat'))
    assert.ok(switchHit)
    switchHit.props.onClick()
    assert.deepEqual(opened.at(-1), ['bot-models', 'deepseek/deepseek-chat'])
    tree = draw()
    const offer = findAll(tree, n => n.props?.className === 'bt-set-row bt-bm-offer')[0]
    assert.ok(offer, 'Bot models asks before switching')
    assert.match(textOf(offer), /Switch Chief, Writer to DeepSeek Chat\?/)

    // Searching "memory" opens General with Advanced expanded; a later Advanced hit re-expands it.
    fire({ key: 'k', ...primary })
    tree = draw()
    type('memory')
    hits()[0].props.onClick()
    assert.deepEqual(opened.at(-1), ['general', null])
    draw()
    tree = draw()
    let collapseBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-row bt-set-collapse')[0]
    assert.equal(collapseBtn.props['aria-expanded'], true, 'jumping to Memory via search must auto-expand Advanced')
    collapseBtn.props.onClick()
    tree = draw()
    collapseBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-row bt-set-collapse')[0]
    assert.equal(collapseBtn.props['aria-expanded'], false, 'manual click collapses Advanced')

    fire({ key: 'k', ...primary })
    tree = draw()
    type('Background commands')
    hits()[0].props.onClick()
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
      diagnostics: () => Promise.resolve({ entries: [], total: 0, markdown: '' }),
      repoStars: () => Promise.resolve(null),
      setPrefs: () => Promise.resolve(),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, {
      page: currentPage, id: null, roster: baseRoster, actions, useUpdate: sel => sel({}),
    }))

    // First open: full walkthrough starts automatically.
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
    assert.equal(currentPage, 'overview')
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
    assert.ok(stylesSrc.includes('.bt-set-card{flex-shrink:0;border:.5px solid var(--bt-glass-rim);border-radius:12px;background:var(--bt-card);box-shadow:var(--bt-card-shadow);display:flex;flex-direction:column;overflow:clip}'))
    assert.ok(stylesSrc.includes('button.bt-select{display:inline-flex;align-items:center;'))
    harness.unmount()
  })
})

test('SettingsTour replays from step 0 without unmounting, ends when search opens, and avoids snap-back', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'; export { SettingsTour, TOUR_SEEN_KEY } from './src/client/settings-tour.js'")
  await withGlobals(async () => {
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
    const { SettingsDialog, SettingsTour, TOUR_SEEN_KEY } = mod.exports

    let currentPage = 'general'
    const opened = []
    const actions = {
      openSettings: (page, id) => { opened.push([page, id ?? null]); currentPage = page },
      closeSettings() {},
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      deepseekServices: () => Promise.resolve(null),
      folders: () => Promise.resolve({ team: '/work' }),
      schedules: () => Promise.resolve({ available: true, tasks: [] }),
      diagnostics: () => Promise.resolve({ entries: [], total: 0, markdown: '' }),
      repoStars: () => Promise.resolve(null),
      setPrefs: () => Promise.resolve(),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, {
      page: currentPage, id: null, roster: baseRoster, actions, useUpdate: sel => sel({}),
    }))

    // First-run full tour starts on step 0 (search).
    let tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'search')

    // The search step's target opens the search palette; the walkthrough ends there (and is
    // marked seen) so the field takes the keyboard.
    const searchButton = findAll(tree, n => n.type === 'button' && n.props?.['data-tour'] === 'search')[0]
    assert.ok(searchButton, '[data-tour="search"] must be the rail search button')
    searchButton.props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer').length, 0, 'opening search ends the walkthrough')
    assert.equal(store.get(TOUR_SEEN_KEY), '1', 'opening search during the full walkthrough marks it seen')
    const searchInput = () => findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-set-search-input')[0]
    searchInput().props.onChange({ target: { value: '微信' } })
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-set-search-hit').length, 1)

    // Picking a hit goes to IM and stays there.
    searchInput().props.onKeyDown({ key: 'Enter', isComposing: false, preventDefault() {}, stopPropagation() {} })
    tree = draw()
    tree = draw()
    assert.equal(currentPage, 'im', 'picking IM search hit must not snap back')

    // Replay the same section guide without unmounting: advance, skip, then start again → must start at step 0.
    currentPage = 'general'
    tree = draw()
    const guideBtn = () => findAll(tree, n => n.type === 'button' && typeof n.props?.className === 'string' && n.props.className.includes('bt-tour-trigger'))[0]
    guideBtn().props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'default-model')
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-send bt-soft-sm')[0].props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'locations')
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-tour-skip')[0].props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer').length, 0)
    guideBtn().props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'default-model', 'replaying dismissed section guide must start at step 0')

    // Replay full guide from About without unmounting: advance to Models, skip, start again → must start at step 0 (search).
    currentPage = 'about'
    tree = draw()
    const startFull = () => findAll(tree, n => n.type === 'button' && textOf(n).includes('Start'))[0]
    startFull().props.onClick()
    tree = draw()
    tree = draw()
    assert.equal(currentPage, 'overview')
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'search')
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-send bt-soft-sm')[0].props.onClick()
    tree = draw()
    tree = draw()
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'provider-list')
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-tour-skip')[0].props.onClick()
    tree = draw()
    currentPage = 'about'
    tree = draw()
    startFull().props.onClick()
    tree = draw()
    tree = draw()
    assert.equal(currentPage, 'overview')
    assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'search', 'replaying dismissed full guide must start at step 0')
    harness.unmount()

    // Standalone SettingsTour: changing currentPage externally must not snap back; schedules tour falls back to open-plugins when new-task is absent.
    const navCalls = []
    let standalonePage = 'overview'
    const openPluginsEl = {
      getBoundingClientRect: () => ({ left: 400, top: 260, right: 520, bottom: 292, width: 120, height: 32 }),
      closest: () => null,
      scrollIntoView() {},
    }
    const dialogEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1100, bottom: 780, width: 1100, height: 780 }),
      querySelector: sel => (sel === '[data-tour="open-plugins"]' ? openPluginsEl : null),
      addEventListener() {},
      removeEventListener() {},
    }
    const drawStandalone = (tour) => harness.render(harness.React.createElement(SettingsTour, {
      tour,
      currentPage: standalonePage,
      dialogRef: { current: dialogEl },
      hasProviders: true,
      hasAdvancedModels: false,
      onNavigate: p => { navCalls.push(p); standalonePage = p },
      onDismiss() {},
    }))
    drawStandalone({ mode: 'full', nonce: 1 })
    assert.deepEqual(navCalls, [])
    standalonePage = 'im'
    drawStandalone({ mode: 'full', nonce: 1 })
    assert.deepEqual(navCalls, [], 'external page change while staying on step 0 must not snap back')

    standalonePage = 'schedules'
    drawStandalone({ mode: 'schedules', nonce: 2 })
    const fallbackTree = drawStandalone({ mode: 'schedules', nonce: 2 })
    const schedLayer = findAll(fallbackTree, n => n.props?.className === 'bt-tour-layer')[0]
    assert.equal(schedLayer.props['data-tour-step'], 'open-plugins')
    assert.equal(schedLayer.props['aria-label'], 'Turn on Automation tasks in DSH')
    assert.equal(findAll(fallbackTree, n => n.props?.className === 'bt-tour-spot').length, 1)
    harness.unmount()
  })
})

test('SettingsTour scrolls off-screen targets into view before clipping, tracks async mounts, and guards Arrow keys', async () => {
  const code = await loadBundle("export { SettingsTour, measureSpotlight } from './src/client/settings-tour.js'")
  await withGlobals(async (listeners) => {
    const observers = []
    const prevMO = globalThis.MutationObserver
    const prevRaf = globalThis.requestAnimationFrame
    globalThis.MutationObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this) }
      observe() {}
      disconnect() {}
    }
    globalThis.requestAnimationFrame = fn => { fn(); return 1 }
    globalThis.window.innerWidth = 390
    try {
      const harness = makeStatefulReact()
      const mod = { exports: {} }
      new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
        id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
      ))
      const { SettingsTour, measureSpotlight } = mod.exports

      // Simulate a scrolled-off-screen target inside .bt-settings-scroll (below bottom edge 780).
      let targetTop = 920
      let scrolledCalls = 0
      let mounted = false
      const scrollBox = { getBoundingClientRect: () => ({ left: 212, top: 80, right: 1100, bottom: 780, width: 888, height: 700 }) }
      const targetEl = {
        getBoundingClientRect: () => ({ left: 240, top: targetTop, right: 1060, bottom: targetTop + 90, width: 820, height: 90 }),
        closest: sel => (sel === '.bt-settings-scroll' ? scrollBox : null),
        scrollIntoView: () => { scrolledCalls += 1; targetTop = 520 },
      }
      const dialogEl = {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1100, bottom: 780, width: 1100, height: 780 }),
        querySelector: sel => (mounted && sel === '[data-tour="default-model"]' ? targetEl : null),
        addEventListener() {},
        removeEventListener() {},
      }
      const dialogRef = { current: dialogEl }
      const renderTour = () => harness.render(harness.React.createElement(SettingsTour, {
        tour: { mode: 'general', nonce: 1 },
        currentPage: 'general',
        dialogRef,
        hasProviders: true,
        hasAdvancedModels: false,
        onNavigate() {},
        onDismiss() {},
      }))

      // First render while target is not yet mounted (async page) → mobile fallback stays bounded left & right.
      let tree = renderTour()
      const fallbackCard = findAll(tree, n => n.props?.className === 'bt-tour-card')[0]
      assert.deepEqual(fallbackCard.props.style, { left: 12, right: 12, bottom: 12 })

      // Target mounts off-screen → MutationObserver triggers sync → scrollIntoView runs BEFORE clipping → spotlight locks on.
      mounted = true
      assert.ok(observers.length >= 1)
      observers[observers.length - 1].cb([{ target: dialogEl }])
      tree = renderTour()
      assert.equal(scrolledCalls, 1, 'off-screen target must be scrolled into view before clipping')
      const spotNode = findAll(tree, n => n.props?.className === 'bt-tour-spot')[0]
      assert.ok(spotNode, 'spotlight must appear after off-screen target scrolls into view')
      assert.equal(spotNode.props.style.top, 514)

      // Clip check: a tall target extending above scrollBox.top (80) clips at clipTop + 2 (82).
      targetTop = 40
      const clipped = measureSpotlight(dialogEl, 'default-model')
      assert.equal(clipped.top, 82)

      // ArrowRight with Ctrl/Meta or inside an INPUT must NOT advance step; plain ArrowRight DOES advance.
      for (const fn of [...listeners]) fn({ key: 'ArrowRight', ctrlKey: true, preventDefault() {} })
      for (const fn of [...listeners]) fn({ key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault() {} })
      tree = renderTour()
      assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'default-model')

      for (const fn of [...listeners]) fn({ key: 'ArrowRight', preventDefault() {} })
      tree = renderTour()
      assert.equal(findAll(tree, n => n.props?.className === 'bt-tour-layer')[0].props['data-tour-step'], 'locations')
      harness.unmount()
    } finally {
      globalThis.MutationObserver = prevMO
      globalThis.requestAnimationFrame = prevRaf
    }
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
    assert.equal(findAll(tree, n => n.type === 'a' && textOf(n) === 'Download').length, 1)
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
    const download = findAll(pairTree, n => n.type === 'a' && textOf(n) === 'Download')
    assert.equal(download.length, 1)
    assert.equal(download[0].props.href, 'https://github.com/Fei2411/DS-Bot/releases/latest')
    assert.equal(findAll(pairTree, n => n.props?.['aria-label'] === 'Pairing QR code').length, 1)
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
    const toggleBtn = () => findAll(tree, n => n.type === 'button' && textOf(n).includes('Allow action'))[0]
    assert.ok(toggleBtn())
    toggleBtn().props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'form').length, 1)
    assert.ok(findAll(tree, n => n.props?.className?.includes('bt-seg')).length >= 1, 'Duration should use Segmented')

    // Editing bot, site, actions, and duration then clicking Cancel must discard the draft on reopen.
    findAll(tree, n => n.type === 'select')[0].props.onChange({ target: { value: 'writer' } })
    findAll(tree, n => n.type === 'input' && n.props?.className?.includes('bt-browser-site'))[0].props.onChange({ target: { value: 'example.com' } })
    const checkboxes = findAll(tree, n => n.type === 'input' && n.props?.type === 'checkbox')
    checkboxes[1].props.onChange({ target: { checked: true } })
    const permBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Permanent')[0]
    permBtn.props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'select')[0].props.value, 'writer')
    assert.equal(findAll(tree, n => n.type === 'input' && n.props?.className?.includes('bt-browser-site'))[0].props.value, 'example.com')
    assert.equal(findAll(tree, n => n.type === 'button' && textOf(n) === 'Permanent')[0].props['aria-pressed'], true)

    findAll(tree, n => n.type === 'button' && textOf(n) === 'Cancel')[0].props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'form').length, 0)

    toggleBtn().props.onClick()
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'select')[0].props.value, 'chief')
    assert.equal(findAll(tree, n => n.type === 'input' && n.props?.className?.includes('bt-browser-site'))[0].props.value, '')
    const resetBoxes = findAll(tree, n => n.type === 'input' && n.props?.type === 'checkbox')
    assert.deepEqual(resetBoxes.map(b => b.props.checked), [true, false, false, false])
    assert.equal(findAll(tree, n => n.type === 'button' && textOf(n) === '1 hour')[0].props['aria-pressed'], true)
    assert.equal(findAll(tree, n => n.type === 'button' && textOf(n) === 'Permanent')[0].props['aria-pressed'], false)
    harness.unmount()
  })
})

test('Overview fixes a missing API key in place, marks the Bots it stops, and sums the last 7 days', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports
    const bots = [
      { id: 'chief', name: 'Chief', model: 'deepseek/deepseek-chat' },
      { id: 'writer', name: 'Writer', model: 'anthropic/claude-sonnet' },
    ]
    const roster = {
      ...baseRoster,
      bots,
      byId: Object.fromEntries(bots.map(bot => [bot.id, bot])),
      models: [
        { ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', providerName: 'DeepSeek' },
        { ref: 'anthropic/claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic', providerName: 'Anthropic', needsKey: true },
      ],
    }
    const keys = []
    const now = '2026-11-21 10'
    const actions = {
      openSettings() {},
      closeSettings() {},
      setPrefs: () => Promise.resolve(),
      providers: () => Promise.resolve({
        available: true, revision: 1, addable: [],
        providers: [
          { id: 'deepseek', name: 'DeepSeek', key: { configured: true, writable: true }, models: [{ ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' }] },
          { id: 'anthropic', name: 'Anthropic', key: { configured: false, writable: true }, models: [{ ref: 'anthropic/claude-sonnet', name: 'Claude Sonnet' }] },
        ],
      }),
      setProviderKey: (provider, value) => { keys.push([provider, value]); return Promise.resolve({ providers: [] }) },
      // Hourly rows: [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls].
      usage: () => Promise.resolve({ now, scanning: false, rows: [[now, 'chief', 'deepseek/deepseek-chat', 'chat', 1000, 0, 0, 500, 1], ['2026-11-19 09', 'chief', 'deepseek/deepseek-chat', 'chat', 2000, 0, 0, 0, 1]] }),
      schedules: () => Promise.resolve({ available: true, tasks: [{ id: 't1', status: 'active', kind: 'daily', time: '09:00', scheduledAt: '2099-01-01T09:00:00Z' }] }),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, { page: 'overview', id: null, roster, actions, useUpdate: sel => sel({}) }))
    draw()
    await new Promise(resolve => setTimeout(resolve, 0))
    draw()
    await new Promise(resolve => setTimeout(resolve, 0))
    let tree = draw()

    const alerts = findAll(tree, n => n.props?.className === 'bt-ov-alert')
    assert.equal(alerts.length, 1, 'only the provider a Bot uses and lacks a key asks for one')
    assert.match(textOf(alerts[0]), /Anthropic needs an API key/)
    assert.match(textOf(alerts[0]), /Used by Writer/)
    const field = findAll(alerts[0], n => n.type === 'input' && n.props?.className === 'bt-secret-input')[0]
    field.props.onChange({ target: { value: 'sk-test' } })
    tree = draw()
    const save = findAll(findAll(tree, n => n.props?.className === 'bt-ov-alert')[0], n => n.type === 'button' && textOf(n) === 'Save')[0]
    save.props.onClick()
    assert.deepEqual(keys, [['anthropic', 'sk-test']])

    // The Bot on the keyless model wears a warning dot; the other does not.
    const faces = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-ov-bot')
    const dotted = faces.filter(face => findAll(face, n => n.props?.className === 'bt-ov-face-dot').length > 0).map(face => textOf(findAll(face, n => n.props?.className === 'bt-ov-bot-name')[0]))
    assert.deepEqual(dotted, ['Writer'])

    // Models counts what can run now; usage sums seven days; one scheduled task is active.
    const tiles = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-ov-tile')
    const value = at => textOf(findAll(tiles[at], n => n.props?.className === 'bt-ov-value')[0])
    assert.equal(value(0), '1models')
    assert.equal(value(3), '3.5Ktokens')
    assert.equal(value(4), '1active')

    // Bot models' offer lists only the Bots that would move, and none shows when none would.
    const offerOf = ref => {
      harness.unmount()
      const page = harness.render(harness.React.createElement(SettingsDialog, { page: 'bot-models', id: ref, roster, actions, useUpdate: sel => sel({}) }))
      return findAll(page, n => n.props?.className === 'bt-set-row bt-bm-offer')[0]
    }
    assert.match(textOf(offerOf('deepseek/deepseek-chat')), /^Switch Writer to DeepSeek Chat\?/)
    const allOn = { ...roster, bots: bots.map(bot => ({ ...bot, model: 'deepseek/deepseek-chat' })) }
    harness.unmount()
    const none = harness.render(harness.React.createElement(SettingsDialog, { page: 'bot-models', id: 'deepseek/deepseek-chat', roster: { ...allOn, byId: Object.fromEntries(allOn.bots.map(bot => [bot.id, bot])) }, actions, useUpdate: sel => sel({}) }))
    assert.equal(findAll(none, n => n.props?.className === 'bt-set-row bt-bm-offer').length, 0)
    harness.unmount()
  })
})

test('a part keeps the request it opened with while the user moves to another part of its domain', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports
    let route = ['schedules', 'chief']
    const actions = {
      openSettings: (page, id) => { route = [page, id ?? null] },
      closeSettings() {},
      setPrefs: () => Promise.resolve(),
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      schedules: () => Promise.resolve({ available: true, tasks: [] }),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, { page: route[0], id: route[1], roster: baseRoster, actions, useUpdate: sel => sel({}) }))
    const newTaskButton = tree => findAll(findAll(tree, n => n.type === 'section' && n.props?.['data-part'] === 'schedules')[0], n => n.type === 'button' && n.props?.['data-tour'] === 'new-task')
    draw()
    await new Promise(resolve => setTimeout(resolve, 0))
    let tree = draw()
    assert.equal(newTaskButton(tree).length, 0, 'a new-task link opens the form')
    // The Bots anchor routes to `bots` with no id; the half-filled form stays open.
    route = ['bots', null]
    tree = draw()
    assert.equal(newTaskButton(tree).length, 0, 'moving to another part keeps the form')
    // Another domain starts clean: back on Team without a request, the form is closed.
    route = ['models', null]
    draw()
    route = ['bots', null]
    tree = draw()
    await new Promise(resolve => setTimeout(resolve, 0))
    tree = draw()
    assert.equal(newTaskButton(tree).length, 1)
    harness.unmount()
  })
})

test('Scheduled tasks "Show all" clears a Bot filter, while an anchor round trip keeps it', async () => {
  const code = await loadBundle("export { SettingsDialog } from './src/client/settings.js'")
  await withGlobals(async () => {
    const harness = makeStatefulReact()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports
    let route = ['schedules', 'bot:chief']
    const actions = {
      openSettings: (page, id) => { route = [page, id ?? null] },
      closeSettings() {},
      setPrefs: () => Promise.resolve(),
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      schedules: () => Promise.resolve({ available: true, tasks: [] }),
    }
    const draw = () => harness.render(harness.React.createElement(SettingsDialog, { page: route[0], id: route[1], roster: baseRoster, actions, useUpdate: sel => sel({}) }))
    const part = tree => findAll(tree, n => n.type === 'section' && n.props?.['data-part'] === 'schedules')[0]
    const showAll = tree => findAll(part(tree), n => n.type === 'button' && textOf(n) === 'Show all')
    draw()
    await new Promise(resolve => setTimeout(resolve, 0))
    let tree = draw()
    assert.equal(showAll(tree).length, 1, "a Bot's link filters to that Bot")

    // Anchor to Bots and back: still filtered.
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-anchor' && textOf(n) === 'Bots')[0].props.onClick()
    tree = draw()
    findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-anchor' && textOf(n) === 'Scheduled tasks')[0].props.onClick()
    tree = draw()
    assert.equal(showAll(tree).length, 1, 'an anchor round trip keeps the filter')

    // "Show all" routes to the part without an owner: every Bot's tasks.
    showAll(tree)[0].props.onClick()
    tree = draw()
    tree = draw()
    assert.equal(showAll(tree).length, 0, '"Show all" lifts the filter')

    // A new task after "Show all" targets a real Bot, not the filter string.
    findAll(part(tree), n => n.type === 'button' && n.props?.['data-tour'] === 'new-task')[0].props.onClick()
    tree = draw()
    const target = findAll(part(tree), n => n.type === 'select' && n.props?.className === 'bt-select bt-task-bot')[0]
    assert.equal(target.props.value, 'chief')
    harness.unmount()
  })
})

test('search names a model by provider when two share a name, and offers no switch when no Bot would move', async () => {
  const code = await loadBundle("export { searchHits } from './src/client/settings-palette.js'")
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => makeStatefulReact().React)
  const { searchHits } = mod.exports
  const models = [
    { ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', providerName: 'DeepSeek' },
    { ref: 'router/deepseek-chat', name: 'DeepSeek Chat', providerName: 'Router' },
  ]
  const bots = [{ id: 'a', name: 'A', model: 'deepseek/deepseek-chat' }]
  const titles = searchHits('deepseek chat', { roster: { bots, rooms: [], models } }).filter(hit => hit.kind === 'action').map(hit => hit.title)
  // A is already on DeepSeek's model, so only the Router one would move it.
  assert.deepEqual(titles, ['Switch Bots to DeepSeek Chat · Router…'])
  const local = [{ id: 'l', name: 'L', model: 'local-codex-cli/default' }]
  assert.equal(searchHits('deepseek chat', { roster: { bots: local, rooms: [], models } }).filter(hit => hit.kind === 'action').length, 0)
})
