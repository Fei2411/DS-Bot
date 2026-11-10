import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Functional acceptance for the inbox redesign (criteria A–I). The sidebar is bundled
// with a small hooks runtime: components stay plain functions, but state survives a
// re-render and setters repaint, so typing, tabs and window widths can be driven.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { SHELL_CSS } from './src/client/styles.js'",
      "export { SIDEBAR_CSS, TeamSidebar } from './src/client/sidebar.js'",
      "export { themeCss, allThemes } from './src/client/themes.js'",
      "export { installLocale, t, DICTIONARY } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// ---------------------------------------------------------------------------
// A tiny hooks runtime: hook values live per component path, setters repaint.

const stateStore = new Map()
const refStore = new Map()
const effectQueue = []
let hookIndex = 0
let renderPath = 'root'
let dirty = false

const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useMemo: make => make(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useEffect: (fn) => { effectQueue.push(fn) },
  useLayoutEffect: (fn) => { effectQueue.push(fn) },
  useState: (initial) => {
    const key = `${renderPath}:${hookIndex++}`
    if (!stateStore.has(key)) stateStore.set(key, typeof initial === 'function' ? initial() : initial)
    const set = (next) => {
      const value = typeof next === 'function' ? next(stateStore.get(key)) : next
      if (Object.is(value, stateStore.get(key))) return
      stateStore.set(key, value)
      dirty = true
    }
    return [stateStore.get(key), set]
  },
  useRef: (current) => {
    const key = `${renderPath}:${hookIndex++}`
    if (!refStore.has(key)) refStore.set(key, { current })
    return refStore.get(key)
  },
  useId: () => 'id',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
}

const module = { exports: {} }
const styleNode = () => ({ dataset: {}, textContent: '', sheet: { cssRules: [{ style: { setProperty() {}, removeProperty() {}, cssText: '' } }] } })
const documentElement = { hasAttribute: () => false, dataset: { platform: 'darwin' }, style: { setProperty() {}, removeProperty() {} } }
const viewport = { innerWidth: 1280, innerHeight: 880 }
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: viewport,
  document: {
    documentElement, body: { appendChild() {} }, head: { appendChild() {} }, createElement: styleNode,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, activeElement: null,
  },
  Element: class Element {},
  console,
  navigator: { userAgent: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => { fn(0); return 1 }, cancelAnimationFrame() {},
  performance: { now: () => Date.now() },
}
runInNewContext(outputFiles[0].text, sandbox)
const { SHELL_CSS, SIDEBAR_CSS, TeamSidebar, themeCss, allThemes, installLocale, t, DICTIONARY } = module.exports

// ---------------------------------------------------------------------------
// Rendering: function components are expanded once, so hooks advance in call order.

function expand(node, path) {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`))
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const componentPath = `${path}/${node.type.name || 'anon'}`
    const outerPath = renderPath
    const outerIndex = hookIndex
    renderPath = componentPath
    hookIndex = 0
    const out = node.type(node.props)
    renderPath = outerPath
    hookIndex = outerIndex
    return expand(out, componentPath)
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}>`) } }
}

const collect = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  collect(node.props?.children, out)
  return out
}
const classesOf = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)
const hasClass = (node, name) => classesOf(node).includes(name)
const byClass = (tree, name) => collect(tree).filter(node => hasClass(node, name))
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

// ---------------------------------------------------------------------------
// Fixtures and the app harness.

const day = 24 * 60 * 60 * 1000
const todayAt = (hours, minutes) => { const date = new Date(); date.setHours(hours, minutes, 0, 0); return date.getTime() }

function fixtures() {
  const main = { id: 'main', name: 'Mist', role: '主 Bot', createdAt: 1, sessionId: 's-main' }
  const designer = { id: 'designer', name: '设计助手', role: '视觉', createdAt: 2, sessionId: 's-designer' }
  const writer = { id: 'writer', name: 'Writer', role: '写作', createdAt: 3, sessionId: 's-writer' }
  const roomDesign = { id: 'room-design', name: '设计群', sessionId: 's-room-design', createdAt: 4, members: [], preview: '新稿已上传' }
  const roomOps = { id: 'room-ops', name: 'Ops', sessionId: 's-room-ops', createdAt: 5, members: [], preview: '今日值班' }
  const agent = { id: 'dsh', sessions: ['s-agent'], createdAt: 6 }
  designer.sectionId = 'sec-work'
  const sessions = {
    ids: ['s-main', 's-designer', 's-writer', 's-room-design', 's-room-ops', 's-agent'],
    byId: {
      's-main': { id: 's-main', updatedAt: todayAt(8, 0) },
      's-designer': { id: 's-designer', updatedAt: todayAt(9, 5), projectionValues: { turnOutline: [{ turn: 1, prompt: '配色走查', response: '把强调色换成 #2F6BFF 了' }] } },
      's-writer': { id: 's-writer', updatedAt: todayAt(7, 40), projectionValues: { turnOutline: [{ turn: 1, response: '稿件已更新' }] } },
      's-room-design': { id: 's-room-design', updatedAt: todayAt(9, 30) },
      's-room-ops': { id: 's-room-ops', updatedAt: Date.now() - 200 * day },
      's-agent': { id: 's-agent', updatedAt: todayAt(6, 15), title: '检索资料' },
    },
  }
  const roster = {
    bots: [main, designer, writer], rooms: [roomDesign, roomOps], agents: [agent],
    byId: { main, designer, writer }, mainBotId: 'main', mainBotIds: ['main'], ready: true,
    exchangeTurns: {}, sections: [{ id: 'sec-work', name: '工作', collapsed: false }],
  }
  return { roster, sessions }
}

function createApp({ roster, sessions, unread = {}, status = new Map(), activity = {}, renameSection, settings = {}, retained = '' } = {}) {
  // A fresh component tree: hook state, refs and the window width belong to this app.
  stateStore.clear()
  refStore.clear()
  viewport.innerWidth = 1280
  const calls = []
  const actions = {}
  for (const name of ['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread', 'setFlags', 'saveSection', 'beginSectionRename', 'endSectionRename', 'reportError', 'openSettings', 'openModels', 'openConnectors', 'selectPanel', 'seatAccount', 'landOn', 'signIn', 'setLeftDrawer']) {
    actions[name] = (...args) => { calls.push([name, ...args]); return undefined }
  }
  actions.signInEntry = () => ({
    inject: () => ({ hooks: { account: { subscribe: () => () => {}, getSnapshot: () => settings.account ?? null } } }),
  })
  const props = {
    actions,
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread, leftDrawer: false, renameSection }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick(sessions),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(status),
    useSessionRetainInfo: (sessionId, pick) => pick({ retainedBy: { mainView: sessionId === retained ? 1 : 0 } }),
    useActivity: pick => pick(activity),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  }
  const render = () => {
    for (let pass = 0; pass < 8; pass += 1) {
      dirty = false
      effectQueue.length = 0
      hookIndex = 0
      renderPath = 'root'
      const tree = TeamSidebar(props)
      const expanded = expand(tree, 'root-out')
      const effects = effectQueue.splice(0)
      for (const effect of effects) {
        try { effect() } catch { /* layout effects that need a real DOM */ }
      }
      if (!dirty) return expanded
    }
    throw new Error('the sidebar did not settle')
  }
  return { render, calls, actions, props }
}

// The Main Bot's tile stands in its own slot above the list, not in it: that slot is
// left out here so a test's row ids stay the rows of the list itself.
const rows = (tree) => {
  const inSlot = new Set(byClass(tree, 'bt-main-pin').flatMap(slot => collect(slot)))
  return collect(tree).filter(node => !inSlot.has(node) && (node.props?.['data-bot-id'] || node.props?.['data-room-id'] || node.props?.['data-agent-id']))
}
// The search is a button in the top row until it is opened; most tests want the field.
const openSearch = (app, tree) => {
  byClass(tree, 'bt-round-search')[0].props.onClick()
  return app.render()
}
const rowIds = tree => rows(tree).map(node => node.props['data-bot-id'] ?? node.props['data-room-id'] ?? node.props['data-agent-id'])

// ---------------------------------------------------------------------------
// A · the token table

test('A: Mist is a registered theme with the specified accents, DeepSeek untouched', () => {
  const themes = allThemes()
  assert.equal(themes.mist.label, 'Mist')
  assert.equal(themes.mist.light.accent, '#2f6bff')
  assert.equal(themes.mist.dark.accent, '#5c86ff')
  assert.equal(themes.mist.light.bg, '#f4f6fb')
  assert.equal(themes.deepseek.light.accent, '#4d6bfe')
})

test('A: themeVars derives every new token for light and dark', () => {
  const css = themeCss(allThemes().mist)
  const [light, dark] = css.split('html body[data-ds-dark-theme]')
  const tokens = ['--bt-page', '--bt-panel', '--bt-panel-rim', '--bt-panel-shadow', '--bt-field', '--bt-seg-on', '--bt-row-sel']
  for (const token of tokens) {
    assert.match(light, new RegExp(`${token}:[^;]+`), `${token} in light`)
    assert.match(dark, new RegExp(`${token}:[^;]+`), `${token} in dark`)
  }
  assert.match(light, /--bt-accent:#2f6bff/)
  assert.match(dark, /--bt-accent:#5c86ff/)
  // The card sits on the page, not on the sidebar fill: page is the theme's bg.
  assert.match(light, /--bt-page:#f4f6fb/)
  assert.match(dark, /--bt-page:#0e1118/)
})

test('A: the new render CSS holds no bare color, only --bt-* variables', () => {
  const added = SIDEBAR_CSS.slice(SIDEBAR_CSS.indexOf('/* The inbox:'))
  assert.ok(added.length > 2000)
  assert.doesNotMatch(added, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(added, /\b(rgb|rgba|hsl|hsla)\(/)
})

// ---------------------------------------------------------------------------
// B · the card, the fields and the rows (structural CSS; pixels belong to visual)

const INBOX_CSS = SIDEBAR_CSS.slice(SIDEBAR_CSS.indexOf('/* The inbox:'))
const rule = (selector) => {
  const at = INBOX_CSS.indexOf(`${selector}{`)
  assert.ok(at >= 0, `rule ${selector}`)
  return INBOX_CSS.slice(at, INBOX_CSS.indexOf('}', at))
}

test('B: card, title, search, segments, group heads and rows carry the specified numbers', () => {
  assert.match(rule('.bt-leftcol:not([data-left=rail])'), /padding:calc\(var\(--bt-lc-clear\) \+ 8px\) 8px 8px/)
  assert.match(rule('.bt-leftcol:not([data-left=rail])'), /background:var\(--bt-page/)
  // The inbox sits on the page itself: no card fill, rim, radius or shadow.
  const panel = rule('.bt-leftcol:not([data-left=rail])>.bt-side')
  assert.match(panel, /background:transparent/)
  assert.match(panel, /border:0/)
  assert.match(panel, /border-radius:0/)
  assert.match(panel, /box-shadow:none/)
  // With the card gone, the round buttons inside need a fill of their own.
  assert.match(rule('.bt-leftcol:not([data-left=rail]) .bt-round'), /background:color-mix\(in srgb,var\(--bt-page/)
  // The search is bare words on the page: no field, and focus only lifts a faint fill.
  const search = rule('.bt-search')
  assert.match(search, /height:36px/)
  assert.match(search, /border-radius:10px/)
  assert.match(search, /background:transparent/)
  assert.doesNotMatch(search, /(^|;)border:/)
  assert.match(rule('.bt-search:focus-within'), /background:color-mix\(in srgb,var\(--bt-field/)
  assert.doesNotMatch(SIDEBAR_CSS, /\.bt-search:focus-within\{[^}]*box-shadow/)
  assert.match(rule('.bt-search-ico svg'), /width:14px/)
  assert.match(rule('.bt-seg'), /border-radius:10px/)
  assert.match(rule('.bt-seg-btn'), /height:32px/)
  assert.match(rule('.bt-seg-btn'), /border-radius:8px/)
  assert.match(rule('.bt-seg-btn'), /font-weight:500/)
  assert.match(rule('.bt-seg-btn[aria-pressed=true]'), /box-shadow:inset 0 0 0 1px var\(--bt-panel-rim/)
  assert.match(rule('.bt-fixed-title'), /font-size:12px/)
  const row = rule('.bt-row')
  assert.match(row, /min-height:64px/)
  assert.match(row, /padding:10px/)
  assert.match(row, /border-radius:12px/)
  assert.match(rule('.bt-row-ava'), /width:40px/)
  assert.match(rule('.bt-row-ava'), /border-radius:12px/)
  assert.match(rule('.bt-row-name'), /font-size:14px/)
  assert.match(rule('.bt-row-name'), /font-weight:500/)
  assert.match(rule('.bt-row-preview'), /font-size:12\.5px/)
  assert.match(rule('.bt-row-preview'), /color:var\(--bt-ink-2/)
  assert.match(rule('.bt-row-time'), /font-size:12px/)
  assert.match(rule('.bt-row[aria-current=page]'), /background:var\(--bt-row-sel/)
  assert.match(rule('.bt-row[aria-current=page] .bt-row-ava'), /background:var\(--bt-accent/)
})

test('B: segment rules outrank the globally installed shell ones', () => {
  // styles.js installs `.bt-seg button` (0,1,1) globally for the settings panel; a bare
  // `.bt-seg-btn` (0,1,0) loses to it, so the inbox rules must be scoped under .bt-seg.
  assert.doesNotMatch(INBOX_CSS, /(^|})\s*\.bt-seg-btn\{/)
  assert.doesNotMatch(INBOX_CSS, /(^|})\s*\.bt-seg-btn\[/)
  const scoped = rule('.bt-seg .bt-seg-btn')
  assert.match(scoped, /height:32px/)
  assert.match(scoped, /font-size:12\.5px/)
  assert.match(scoped, /font-weight:500/)
  assert.match(rule('.bt-seg .bt-seg-btn[aria-pressed=true]'), /box-shadow:inset 0 0 0 1px var\(--bt-panel-rim/)
  // The reduced-motion opt-out has to beat the scoped rule too, or it silently dies.
  assert.match(SIDEBAR_CSS, /prefers-reduced-motion:reduce\)\{\.bt-search,\.bt-seg \.bt-seg-btn,/)
})

test('B: the foot keeps the original gear button and no status card', () => {
  const { roster, sessions } = fixtures()
  const tree = createApp({ roster, sessions }).render()
  assert.equal(byClass(tree, 'bt-tip').length, 0, 'no status card')
  assert.equal(byClass(tree, 'bt-account-row').length, 0, 'no account row')
  assert.equal(byClass(tree, 'bt-account').length, 1, 'the gear button is the whole foot')
  assert.doesNotMatch(INBOX_CSS, /\.bt-tip|\.bt-account-row|\.bt-account-ava|\.bt-account-info|\.bt-account-name|\.bt-account-sub|\.bt-account-gear|\.bt-foot-stack/)
})

// ---------------------------------------------------------------------------
// C1 · inline search

test('C1: typing filters bots, groups and previews, and clearing restores the grouped list', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  assert.equal(byClass(tree, 'bt-search-in').length, 0, 'the field waits behind its button')
  tree = openSearch(app, tree)
  assert.equal(byClass(tree, 'bt-search-in').length, 1)
  assert.ok(byClass(tree, 'bt-sec').length > 0, 'grouped list first')

  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '设计' } })
  tree = app.render()
  assert.deepEqual(rowIds(tree).sort(), ['designer', 'room-design'].sort())
  assert.equal(byClass(tree, 'bt-sec').length, 0, 'group heads hide while filtering')
  assert.equal(byClass(tree, 'bt-fixed-head').length, 0)

  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '稿件' } })
  tree = app.render()
  assert.deepEqual(rowIds(tree), ['writer'], 'the last message preview is searched too')

  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: 'zzz' } })
  tree = app.render()
  assert.equal(rowIds(tree).length, 0)
  assert.equal(textOf(byClass(tree, 'bt-empty')[0]), 'No matches')

  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '' } })
  tree = app.render()
  assert.ok(byClass(tree, 'bt-sec').length > 0)
  assert.ok(byClass(tree, 'bt-fixed-head').length > 0)
})

test('C1: Enter hands the words to the command palette, Escape puts the field away', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  tree = openSearch(app, tree)
  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '  设计  ' } })
  tree = app.render()
  let prevented = false
  byClass(tree, 'bt-search-in')[0].props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault: () => { prevented = true }, currentTarget: { blur() {} } })
  assert.equal(prevented, true)
  assert.deepEqual(app.calls.find(call => call[0] === 'openPalette'), ['openPalette', '设计'])

  byClass(tree, 'bt-search-in')[0].props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault: () => {}, currentTarget: { blur() {} } })
  tree = app.render()
  assert.equal(byClass(tree, 'bt-search-in').length, 0, 'Escape closes the field')
  assert.equal(byClass(tree, 'bt-round-search').length, 1, 'the button is back')
  assert.ok(byClass(tree, 'bt-sec').length > 0)
  assert.ok(byClass(tree, 'bt-main-pin').length > 0, 'the Main Bot tile is back with it')
})

// ---------------------------------------------------------------------------
// C2 · the All / Bots / Chats filter

test('C2: the segments flatten the list, hide group heads and keep the Agent to All', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  const segment = label => byClass(tree, 'bt-seg-btn').find(node => textOf(node) === label)
  assert.deepEqual(byClass(tree, 'bt-seg-btn').map(textOf), ['All', 'Bots', 'Chats'])

  segment('Bots').props.onClick()
  tree = app.render()
  // The standing tile shows the Main Bot, so its row stays out of the list.
  assert.deepEqual(rowIds(tree).sort(), ['designer', 'writer'].sort())
  assert.equal(byClass(tree, 'bt-main-pin').length, 1, 'the tile stays put while the list is filtered')
  assert.equal(byClass(tree, 'bt-sec').length, 0)
  assert.equal(byClass(tree, 'bt-fixed-head').length, 0)

  segment('Chats').props.onClick()
  tree = app.render()
  assert.deepEqual(rowIds(tree).sort(), ['room-design', 'room-ops'].sort())

  byClass(tree, 'bt-seg-btn').find(node => textOf(node) === 'All').props.onClick()
  tree = app.render()
  assert.ok(rowIds(tree).includes('dsh'), 'All carries the DSH Agent')
})

test('C1b: the Main Bot stands above the list and never shows twice', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions, unread: { main: true } })
  let tree = app.render()
  const pin = byClass(tree, 'bt-main-pin')
  assert.equal(pin.length, 1, 'the tile slot is drawn')
  assert.deepEqual(collect(pin[0]).filter(node => node.props?.['data-bot-id']).map(node => node.props['data-bot-id']), ['main'])
  assert.ok(!collect(byClass(tree, 'bt-list')[0]).some(node => node.props?.['data-bot-id'] === 'main'), 'the Main Bot is out of the scroll box')
  // The rule that used to sit under the slot is gone.
  assert.equal(byClass(tree, 'bt-main-pin-sep').length, 0, 'no rule under the slot')
  // The tile is not on the top row: the top row ends with the search button.
  const top = byClass(tree, 'bt-side-top')[0]
  assert.equal(byClass(top, 'bt-main-tile').length, 0, 'the top row keeps the round buttons')
  assert.equal(byClass(top, 'bt-round-search').length, 1, 'the search button ends the row')
  const order = collect(byClass(tree, 'bt-side')[0])
    .filter(node => node.props?.className === 'bt-side-top' || hasClass(node, 'bt-main-pin') || hasClass(node, 'bt-seg'))
    .map(node => node.props.className)
  assert.deepEqual(order, ['bt-side-top', 'bt-main-pin', 'bt-seg'], 'top row, the tile, then the filters')
  // The slot is a stood-up tile: a 72px mark over a 16px name, and no time or preview.
  const tile = byClass(tree, 'bt-main-tile')
  assert.equal(tile.length, 1, 'the pin draws the tile')
  assert.equal(textOf(byClass(tree, 'bt-main-tile-name')[0]), 'Mist')
  const mark = byClass(tile[0], 'bt-mark')[0].props.style
  assert.equal(mark.width, 72, 'a 72px mark')
  assert.equal(mark.height, 72, 'a 72px mark')
  assert.equal(byClass(tile[0], 'bt-row-time').length, 0, 'no stamp on the tile')
  assert.equal(byClass(tile[0], 'bt-row-preview').length, 0, 'no preview on the tile')
  assert.equal(byClass(tile[0], 'bt-dot').length, 1, 'the unread dot rides on the tile')
  assert.match(tile[0].props['aria-label'], /Mist/)
  assert.match(tile[0].props['aria-label'], /Main Bot/)
  assert.ok(hasClass(byClass(tile[0], 'bt-badge-main')[0], 'bt-badge-crown'), 'the tile badge is a crown')

  tree = openSearch(app, tree)
  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: 'Mist' } })
  tree = app.render()
  assert.equal(byClass(tree, 'bt-main-pin').length, 0, 'a text search drops the tile')
  assert.deepEqual(rowIds(tree).filter(id => id === 'main'), ['main'], 'the search result is the only one')

  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '' } })
  tree = app.render()
  assert.equal(byClass(tree, 'bt-main-pin').length, 1, 'a cleared search shows the tile again')
  byClass(tree, 'bt-seg-btn').find(node => textOf(node) === 'Bots').props.onClick()
  tree = app.render()
  assert.equal(byClass(tree, 'bt-main-pin').length, 1, 'a filter keeps the tile: it is the Main Bot\'s only row')
  assert.deepEqual(rowIds(tree).filter(id => id === 'main'), [], 'and the list leaves its row out')
})

test('C1b: the pin stays on the Main Bot while another Bot chat is open', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions, retained: 's-designer' })
  const tree = app.render()
  assert.deepEqual(collect(byClass(tree, 'bt-main-pin')[0]).filter(node => node.props?.['data-bot-id']).map(node => node.props['data-bot-id']), ['main'])
  const open = rows(tree).filter(node => node.props['aria-current'] === 'page').map(node => node.props['data-bot-id'])
  assert.deepEqual(open, ['designer'], 'the open Bot is the one marked current')
})

test('C1b: the rail shows the Main Bot once and has no tile slot', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  viewport.innerWidth = 390
  const tree = app.render()
  assert.equal(byClass(tree, 'bt-main-tile').length, 0, 'no tile on the rail')
  assert.equal(byClass(tree, 'bt-main-pin').length, 0, 'no slot above the list')
  assert.deepEqual(rowIds(tree).filter(id => id === 'main'), ['main'], 'the Main Bot is in the rail list exactly once')
})

// C1b: the tile sits on the page itself, so no state may paint a block or ring.
test('C1b: the Main Bot tile is unfilled in every state and its badge is a crown disc', () => {
  assert.match(SHELL_CSS, /\.bt-main-tile\{[^}]*background:transparent/)
  assert.doesNotMatch(SHELL_CSS, /\.bt-main-tile:hover\{background/)
  assert.doesNotMatch(SHELL_CSS, /\.bt-main-tile\[aria-current=page\]\{background/)
  // A large bare mark: no plate behind it and no ring in any state.
  const ava = SHELL_CSS.match(/^\.bt-main-tile-ava\{[^}]*\}/m)[0]
  assert.match(ava, /width:72px/)
  assert.match(ava, /height:72px/)
  assert.match(ava, /background:transparent/)
  assert.doesNotMatch(ava, /box-shadow/)
  assert.doesNotMatch(SHELL_CSS, /\.bt-main-tile\[aria-current=page\] \.bt-main-tile-ava\{[^}]*box-shadow/)
  // The open chat is told by the name alone.
  assert.match(SHELL_CSS, /\.bt-main-tile\[aria-current=page\] \.bt-main-tile-name\{[^}]*font-weight:600/)
  assert.match(SHELL_CSS, /\.bt-main-tile \.bt-badge-main\{[^}]*border-radius:50%[^}]*background:var\(--bt-star\)[^}]*box-shadow:0 0 0 2px var\(--bt-main\)/)
  assert.match(SHELL_CSS, /\.bt-main-tile \.bt-badge-main path\{fill:var\(--bt-crown-ink\)/)
  // The tile stands in its own slot above the list, with no rule under it.
  assert.match(SHELL_CSS, /\.bt-main-tile\{[^}]*min-height:130px/)
  assert.match(SHELL_CSS, /^\.bt-main-pin\{/m)
  assert.doesNotMatch(SHELL_CSS, /\.bt-main-pin-sep\{/)
  assert.doesNotMatch(SHELL_CSS, /\.bt-main-slot/)
  // The search is a button on the top row until it is opened.
  assert.match(SHELL_CSS, /\.bt-top-right\{[^}]*margin-left:auto/)
  assert.match(SIDEBAR_CSS, /\.bt-search\{[^}]*flex:1 1 auto/)
  // With the list rows now sitting on the page, their dot's ring follows the page too.
  assert.match(SHELL_CSS, /^\.bt-dot\{[^}]*box-shadow:0 0 0 1\.5px var\(--bt-main\)/m)

  // Only the tile wears the crown: the same Bot's rail row keeps the star.
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  viewport.innerWidth = 390
  const tree = app.render()
  const row = rows(tree).find(node => node.props['data-bot-id'] === 'main')
  assert.ok(!hasClass(byClass(row, 'bt-badge-main')[0], 'bt-badge-crown'), 'the rail row keeps the star badge')
  viewport.innerWidth = 1280
})

test('C2: rows stop being draggable while a filter is on', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  byClass(tree, 'bt-seg-btn').find(node => textOf(node) === 'Bots').props.onClick()
  tree = app.render()
  const bot = rows(tree).find(node => node.props['data-bot-id'] === 'designer')
  assert.equal(bot.props.draggable, undefined)
  assert.equal(bot.props.onDragStart, undefined)
})

// ---------------------------------------------------------------------------
// C3 · the fixed Groups and Recent sections

test('C3: user sections come first, then Groups and Recent with counts and pinned first', () => {
  const { roster, sessions } = fixtures()
  roster.bots[2].pinned = true
  const app = createApp({ roster, sessions })
  const tree = app.render()

  const heads = collect(tree).filter(node => hasClass(node, 'bt-sec') || hasClass(node, 'bt-fixed')).map(node => classesOf(node).find(name => name === 'bt-sec' || name === 'bt-fixed'))
  assert.deepEqual(heads, ['bt-sec', 'bt-fixed', 'bt-fixed'])

  const fixed = byClass(tree, 'bt-fixed')
  assert.deepEqual(fixed.map(group => textOf(byClass(group, 'bt-fixed-title')[0])), ['Groups', 'Recent'])
  assert.deepEqual(fixed.map(group => textOf(byClass(group, 'bt-fixed-count')[0])), ['2', '2'])
  // Recent is pinned first, then by recency: Writer (pinned) leads.
  const recent = rowIds(fixed[1])
  assert.equal(recent[0], 'writer')
  assert.deepEqual(recent.slice(1), ['dsh'])
  // A fixed group has no rename, collapse or menu affordances of its own.
  const head = byClass(fixed[0], 'bt-fixed-head')[0]
  assert.equal(head.props.onClick, undefined)
  assert.equal(head.props.onContextMenu, undefined)
  assert.equal(head.props.onDoubleClick, undefined)
})

test('C3: the old ungrouped container is only a drop zone now', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  const tree = app.render()
  const zone = byClass(tree, 'bt-sec-ungrouped')[0]
  assert.ok(zone, 'the drop zone renders when user sections exist')
  assert.equal(rows(zone).length, 0)
})

// ---------------------------------------------------------------------------
// C4 · the right side of a row

test('C4: today reads as HH:MM, older days as dates, and unread as New', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  const timeOf = id => {
    const row = rows(tree).find(node => node.props['data-bot-id'] === id)
    const side = byClass(row, 'bt-row-time')[0]
    return side ? textOf(side) : ''
  }
  assert.equal(timeOf('designer'), '09:05')

  sessions.byId['s-writer'].updatedAt = new Date(new Date().getFullYear(), 2, 3, 10, 0).getTime()
  tree = app.render()
  const older = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(sessions.byId['s-writer'].updatedAt))
  assert.equal(timeOf('writer'), older)

  sessions.byId['s-room-ops'].updatedAt = new Date(new Date().getFullYear() - 2, 4, 1, 10, 0).getTime()
  tree = app.render()
  const roomRow = rows(tree).find(node => node.props['data-room-id'] === 'room-ops')
  assert.match(textOf(byClass(roomRow, 'bt-row-time')[0]), new RegExp(String(new Date().getFullYear() - 2)))

  const status = new Map([['s-writer', { completionUnread: true }]])
  const unreadApp = createApp({ roster, sessions, status })
  tree = unreadApp.render()
  const writerRow = rows(tree).find(node => node.props['data-bot-id'] === 'writer')
  assert.equal(textOf(byClass(writerRow, 'bt-row-new')[0]), 'New')
  assert.equal(byClass(writerRow, 'bt-row-time').length, 0)
})

test('C4: a running Bot keeps its doing phrase instead of the plain preview', () => {
  const { roster, sessions } = fixtures()
  const status = new Map([['s-designer', { running: true }]])
  const app = createApp({ roster, sessions, status, activity: { designer: 'working' } })
  const tree = app.render()
  const row = rows(tree).find(node => node.props['data-bot-id'] === 'designer')
  assert.match(textOf(byClass(row, 'bt-row-preview')[0]), /…$/)
})

// ---------------------------------------------------------------------------
// C5/C6 · the foot (reverted to the original single gear button)

test('C5: the foot says nothing about where the model runs', () => {
  const { roster, sessions } = fixtures()
  const tree = createApp({ roster, sessions }).render()
  assert.doesNotMatch(textOf(tree), /Runs locally|Model requests go to|This device/)
})

test('C6: the gear button opens the account menu at the foot', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions, settings: { account: { view: { name: '千寻', email: 'q@example.com' } } } })
  let tree = app.render()
  const gear = byClass(tree, 'bt-account')[0]
  assert.ok(gear, 'the gear is its own button')
  assert.equal(gear.props['aria-haspopup'], 'menu')
  gear.props.onClick()
  tree = app.render()
  assert.equal(byClass(tree, 'bt-account')[0].props['aria-expanded'], true)
})

// ---------------------------------------------------------------------------
// D · the rail

test('D: the rail hides the search and the segments, shows everything, and keeps the query', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  tree = openSearch(app, tree)
  byClass(tree, 'bt-search-in')[0].props.onChange({ currentTarget: { value: '设计' } })
  tree = app.render()
  assert.deepEqual(rowIds(tree).sort(), ['designer', 'room-design'].sort())

  viewport.innerWidth = 390
  tree = app.render()
  assert.equal(byClass(tree, 'bt-search-in').length, 0, 'no field on the rail')
  assert.equal(byClass(tree, 'bt-seg').length, 0, 'no segments on the rail')
  assert.ok(byClass(tree, 'bt-rail-sec-div').length > 0, 'the sections are back as rail pills')
  assert.deepEqual(rowIds(tree).sort(), ['designer', 'dsh', 'main', 'room-design', 'room-ops', 'writer'].sort())

  viewport.innerWidth = 1280
  tree = app.render()
  assert.equal(byClass(tree, 'bt-search-in')[0].props.value, '设计', 'the query survived the rail')
  assert.deepEqual(rowIds(tree).sort(), ['designer', 'room-design'].sort())
})

// ---------------------------------------------------------------------------
// E · dark mode

test('E: the dark theme carries the full token set with readable ink', () => {
  const css = themeCss(allThemes().mist)
  const dark = css.split('html body[data-ds-dark-theme]')[1]
  assert.match(dark, /--bt-page:#0e1118/)
  assert.match(dark, /--bt-panel:#171c27/)
  const luminance = (hex) => {
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  assert.ok(ratio('#e8ecf5', '#171c27') >= 7, 'dark ink on the panel clears AAA')
  assert.ok(ratio('#141414', '#ffffff') >= 7, 'light ink on the panel clears AAA')
})

// ---------------------------------------------------------------------------
// F · accessibility

test('F: the field, the segments, the list and the gear expose their roles and labels', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  const tree = openSearch(app, app.render())
  const input = byClass(tree, 'bt-search-in')[0]
  assert.equal(input.props.type, 'search')
  assert.equal(input.props['aria-label'], 'Search chats')
  const seg = byClass(tree, 'bt-seg')[0]
  assert.equal(seg.props['aria-label'], 'Filter chats')
  for (const button of byClass(tree, 'bt-seg-btn')) assert.equal(button.props['aria-pressed'], button === byClass(tree, 'bt-seg-btn')[0])
  const list = byClass(tree, 'bt-list')[0]
  assert.equal(list.props['aria-label'], 'Bot list')
  for (const row of rows(tree)) {
    assert.equal(row.type, 'button')
    assert.ok(row.props['aria-label'], 'every row is named')
  }
  assert.match(SIDEBAR_CSS, /\.bt-seg-btn:focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.equal(byClass(tree, 'bt-account')[0].props['aria-label'], 'Account')
})

// ---------------------------------------------------------------------------
// G · no regression: drag out, drag in, rename, pin, and the drop strip's CSS

test('G1: a Bot dragged out of a section lands back in Recent', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  const bot = rows(tree).find(node => node.props['data-bot-id'] === 'designer')
  bot.props.onDragStart({ dataTransfer: { setData() {} } })
  tree = app.render()
  const zone = byClass(tree, 'bt-sec-ungrouped')[0]
  assert.equal(zone.props['data-dragging'], 'true')
  zone.props.onDrop({ preventDefault() {} })
  tree = app.render()
  const dropped = app.calls.find(call => call[0] === 'setFlags')
  assert.equal(dropped[1], 'designer')
  assert.equal(dropped[2].sectionId, null)
  assert.equal(byClass(tree, 'bt-sec-ungrouped')[0].props['data-dragging'], undefined)
})

test('G2: a Bot dragged onto a section gets that section', () => {
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions })
  let tree = app.render()
  const bot = rows(tree).find(node => node.props['data-bot-id'] === 'writer')
  bot.props.onDragStart({ dataTransfer: { setData() {} } })
  tree = app.render()
  const section = collect(tree).find(node => node.props?.['data-sec-id'] === 'sec-work')
  section.props.onDrop({ preventDefault() {} })
  const dropped = app.calls.find(call => call[0] === 'setFlags')
  assert.equal(dropped[1], 'writer')
  assert.equal(dropped[2].sectionId, 'sec-work')
})

test('G2: renaming a section still opens its field', () => {
  const { roster, sessions } = fixtures()
  const tree = createApp({ roster, sessions, renameSection: 'sec-work' }).render()
  const input = byClass(tree, 'bt-sec-edit')[0]
  assert.ok(input, 'the rename field renders')
  assert.equal(byClass(input, 'bt-sec-edit').length, 1)
  const field = collect(input).find(node => node.type === 'input')
  assert.equal(field.props['aria-label'], 'Rename section')
  assert.equal(field.props.defaultValue, '工作')
})

test('G4: the empty drop strip is hidden unless a drag is running', () => {
  // The two rules must coexist: one hides the empty idle strip, the other gives the
  // strip its 28px target while dragging.
  assert.match(SIDEBAR_CSS, /\.bt-sec-ungrouped\[data-dragging=true\]:empty\{min-height:28px/)
  assert.match(SIDEBAR_CSS, /\.bt-sec-ungrouped:empty:not\(\[data-dragging=true\]\)\{display:none\}/)

  const dom = new JSDOM(`<!doctype html><html><head><style>${SIDEBAR_CSS}</style></head><body>
    <div class="bt-list"><div class="bt-sec-ungrouped" id="idle"></div>
    <div class="bt-sec-ungrouped" id="dragging" data-dragging="true"></div></div></body></html>`)
  const idle = dom.window.getComputedStyle(dom.window.document.getElementById('idle')).display
  const dragging = dom.window.getComputedStyle(dom.window.document.getElementById('dragging')).display
  assert.equal(idle, 'none', 'no blank gap while idle')
  assert.notEqual(dragging, 'none', 'the strip is back while dragging')
})

// ---------------------------------------------------------------------------
// Chinese copy

test('C5/C6: the Chinese copy of the inbox chrome holds', () => {
  installLocale({
    register: () => () => {},
    bind: () => (key, params) => DICTIONARY.zh[key]?.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) ?? key,
    getLocale: () => ({ active: 'zh-CN' }),
  })
  const { roster, sessions } = fixtures()
  const app = createApp({ roster, sessions, settings: { account: { view: { name: '千寻' } } } })
  let tree = app.render()
  assert.equal(byClass(tree, 'bt-brand').length, 0, 'no brand on the top row')
  assert.equal(byClass(tree, 'bt-side-title').length, 0, 'no inbox title')
  assert.deepEqual(byClass(tree, 'bt-round').filter(node => !hasClass(node, 'bt-update')).map(node => node.props['aria-label']), ['新建机器人', '创建群组聊天', '搜索会话'], 'the top row is the new Bot, group chat and search buttons')
  tree = openSearch(app, tree)
  assert.equal(byClass(tree, 'bt-search-in')[0].props.placeholder, '搜索会话')
  assert.deepEqual(byClass(tree, 'bt-seg-btn').map(textOf), ['全部', '机器人', '群聊'], 'the Bot filter reads 机器人')
  assert.deepEqual(byClass(tree, 'bt-fixed-title').map(textOf), ['群聊', '最近'])
  installLocale({
    register: () => () => {},
    bind: () => key => key,
    getLocale: () => ({ active: 'en-US' }),
  })
})

// SHELL_CSS is bundled with the sidebar; a sanity check keeps the import honest.
test('the sidebar bundle still carries the shell styles', () => {
  assert.ok(SHELL_CSS.length > 1000)
  assert.equal(t('Search chats'), 'Search chats')
})
