import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The sidebar and its style sheets import the browser's React; bundle them with a minimal
// stand-in, as the tool-cell tests do: components run as plain functions. Navigation
// fixtures retain refs across commits and run their layout effects after each render.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS } from './src/client/styles.js'\nexport { SIDEBAR_CSS, TeamSidebar, PluginsButton } from './src/client/sidebar.js'\nexport { dshCollapsed, installFrameWatch, sidebarTrackWidth, chatRoom } from './src/client/frame-watch.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let renderRefs
let refIndex = 0
let renderStates
let stateIndex = 0
let scheduleStateRender
let layoutEffects
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect: effect => layoutEffects?.push(effect),
  useState: (initial) => {
    if (!renderStates) return [initial, () => {}]
    const states = renderStates
    const schedule = scheduleStateRender
    const index = stateIndex++
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], (next) => {
      const value = typeof next === 'function' ? next(states[index]) : next
      if (!Object.is(states[index], value)) {
        states[index] = value
        schedule?.()
      }
    }]
  },
  useMemo: make => make(), useRef: current => renderRefs ? renderRefs[refIndex++] ??= { current } : { current }, useId: () => 'id',
}
const module = { exports: {} }
const viewport = { innerWidth: 1280 }
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: viewport,
}
runInNewContext(outputFiles[0].text, sandbox)
const { SHELL_CSS, SIDEBAR_CSS, TeamSidebar, PluginsButton, dshCollapsed, installFrameWatch, sidebarTrackWidth, chatRoom } = module.exports

function navigationSidebar(wide, { leftDrawer = false } = {}) {
  const calls = []
  const refs = []
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Team', members: [], createdAt: 2 }
  const agent = { id: 'agent', sessions: ['session'], createdAt: 3 }
  const roster = { bots: [bot], rooms: [room], agents: [agent], byId: { writer: bot }, ready: true }
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession'].map(name => [name, id => { calls.push([name, id]); return id }]))
  actions.toggleSidebar = () => { calls.push(['toggleSidebar']) }
  actions.setLeftDrawer = (on) => { calls.push(['setLeftDrawer', on]) }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (['BotRow', 'RoomRow', 'AgentRow'].includes(node.type?.name)) rows.push(node)
    walk(node.props?.children)
  }
  const render = (nextWide = wide) => {
    wide = nextWide
    renderRefs = refs
    refIndex = 0
    layoutEffects = []
    const tree = TeamSidebar({
      wide, actions,
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {}, leftDrawer }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    })
    renderRefs = undefined
    const effects = layoutEffects
    layoutEffects = undefined
    effects.forEach(effect => effect())
    rows.length = 0
    walk(tree)
  }
  render()
  return { calls, rows, actions, render }
}

for (const width of [390, 1023, 1024, 1280]) {
  for (const wide of [false, true]) {
    test(`sidebar navigation at ${width}px with ${wide ? 'expanded content' : 'our own column'} just navigates`, () => {
      viewport.innerWidth = width
      const initial = navigationSidebar(wide)
      assert.equal(initial.rows.length, 3)
      for (const [index, row] of initial.rows.entries()) {
        const names = row.type.name === 'AgentRow' ? ['openAgent', 'openAgentSession', 'newAgentSession'] : ['openSession']
        for (const name of names) {
          const { rows, calls } = navigationSidebar(wide)
          assert.equal(rows[index].props.actions[name]('selected'), 'selected')
          assert.deepEqual(calls, [[name, 'selected']])
        }
      }
    })
  }
}

test('a row picked from the floating drawer closes it', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(false, { leftDrawer: true })
  side.rows[0].props.actions.openSession('picked')
  assert.deepEqual(side.calls, [['openSession', 'picked'], ['setLeftDrawer', false]])
})

test('a row picked outside the drawer leaves it alone', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(false)
  side.rows[0].props.actions.openSession('picked')
  assert.deepEqual(side.calls, [['openSession', 'picked']])
})

// A Bot working in its own chat previews what it is doing, the way a group row does
// for members at work; an idle Bot keeps the last message preview.
test('a running Bot\'s sidebar row shows what it is doing', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map([['writer', { running: true }]])),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({ writer: 'working' }),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  assert.equal(rows.length, 1)
  // BotRow renders as a function component: run it, then flatten Shimmer and the
  // other function children to read the preview line's text.
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 1)
  // The row already says Writer, so the preview is the doing phrase alone.
  assert.match(textOf(previews[0]), /^.+…$/)
  assert.doesNotMatch(textOf(previews[0]), /^Writer ·/)
})

test('an idle Bot\'s sidebar row keeps the message preview', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({}),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 0)
})

// The rail shows avatars only, and a group's name can be 60 characters long: a row whose
// name is not on screen in full shows it on hover.
test('a sidebar row shows its name on hover when the name is hidden or cut', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Launch plan for the spring release', members: ['writer'], createdAt: 2 }
  const roster = { bots: [bot], rooms: [room], agents: [], byId: { writer: bot }, roomsById: { room }, ready: true, exchangeTurns: {} }
  const rowsOf = (pref) => {
    const rows = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!node || typeof node !== 'object') return
      if (['BotRow', 'RoomRow'].includes(node.type?.name)) rows.push(node)
      walk(node.props?.children)
    }
    walk(TeamSidebar({
      useSidebarPref: pick => pick(pref),
      actions: Object.fromEntries(['openSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
      useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: () => null,
      useActivity: pick => pick({}), useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
    }))
    return Object.fromEntries(rows.map(row => [row.type.name, row.type(row.props)]))
  }
  const rail = rowsOf('rail')
  assert.equal(rail.BotRow.props.title, 'Writer')
  assert.equal(rail.RoomRow.props.title, 'Launch plan for the spring release')
  const wide = rowsOf('open')
  assert.equal(wide.RoomRow.props.title, undefined)
  // jsdom lays nothing out, so the name's widths are set by hand.
  const { document } = new JSDOM('<button title="stale"><span class="bt-row-title">Launch plan for the spring release</span></button>').window
  const button = document.querySelector('button')
  const name = button.firstChild
  Object.defineProperty(name, 'clientWidth', { value: 120 })
  Object.defineProperty(name, 'scrollWidth', { value: 120, configurable: true })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.hasAttribute('title'), false)
  Object.defineProperty(name, 'scrollWidth', { value: 260 })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.title, 'Launch plan for the spring release')
  assert.equal(wide.BotRow.props.onMouseEnter, wide.RoomRow.props.onMouseEnter)
})

test('preparing sidebar navigation leaves actions elsewhere unchanged', () => {
  viewport.innerWidth = 390
  const { actions, calls } = navigationSidebar(true)
  assert.deepEqual(calls, [])
  actions.openSession('from-another-surface')
  assert.deepEqual(calls, [['openSession', 'from-another-surface']])
})

function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  for (let at = 0; ;) {
    const open = text.indexOf('{', at)
    if (open === -1) return rules
    let end = open + 1
    for (let depth = 1; depth > 0; end += 1) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0
    const selector = text.slice(at, open).trim()
    if (!selector.startsWith('@')) rules.push({ selector, body: text.slice(open + 1, end - 1).replace(/\s+/g, '') })
    at = end
  }
}
const SHELL_PARTS = /_logoRow|_brand|_toggle|_newSession|_footArea|_collapsed|_topStrip|bt-side-collapse|bt-title-toggle/
const rules = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)].filter(rule => SHELL_PARTS.test(rule.selector))
const hiding = rules.filter(rule => /display:none/.test(rule.body))
const showing = rules.filter(rule => /display:inline-flex/.test(rule.body))

// The shell sidebar's own markup (dsh-client-ui-sidebar SidebarRoot), reduced to what the
// team view reshapes: the switch is in the logo row, except in a macOS desktop window,
// where it sits in the strip by the window buttons. `mac` is DSH Desktop with the system
// title bar; `mac-frameless` is the packaged app, whose window has no system title bar and
// so carries the title-bar attribute as well.
function shell({ platform, collapsed }) {
  const darwin = platform === 'mac' || platform === 'mac-frameless'
  const titlebar = platform === 'windows' || platform === 'mac-frameless'
  const toggle = '<button class="x_iconButton x_toggle" aria-label="Toggle sidebar"></button>'
  const html = `<!doctype html><html${titlebar ? ' data-windows-titlebar' : ''}${darwin ? ' data-platform="darwin"' : ''}><body>
    <div${collapsed ? ' data-sidebar-collapsed="true"' : ''}>
      <div class="x_root${collapsed ? ' x_collapsed' : ''}">
        ${darwin ? `<div class="x_topStrip">${toggle}</div>` : ''}
        <div class="x_logoRow">${collapsed ? '' : '<button class="x_brand x_wide"></button>'}${darwin ? '' : toggle}</div>
      <button class="bt-title-toggle"></button>
        <div class="x_newSession"></div>
        <div class="team">${collapsed ? '' : '<div class="bt-side-top"><button class="bt-round bt-side-collapse"></button></div>'}</div>
        <div class="x_footArea"><span class="bt-foot-account"></span></div>
      </div>
    </div></body></html>`
  const { document } = new JSDOM(html).window
  const hidden = (node) => {
    for (let at = node; at && at.nodeType === 1; at = at.parentElement) {
      if (hiding.some(rule => at.matches(rule.selector)) && !showing.some(rule => at.matches(rule.selector))) return true
    }
    return false
  }
  const switches = [...document.querySelectorAll('.x_toggle, .bt-side-collapse, .bt-title-toggle')].filter(node => !hidden(node))
  return { document, hidden, switches }
}

// The switch is always ours. Under a Windows title bar it is the title-band
// button and the shell's own is hidden (left to the shell, it would expand the
// shell's sidebar before we pull it back, a flash); elsewhere it is the column's
// top-row button, or the floating one while the column is hidden.
for (const collapsed of [false, true]) {
  test(`${collapsed ? 'a collapsed' : 'an open'} shell sidebar under a Windows title bar shows only our switch`, () => {
    const { switches } = shell({ platform: 'windows', collapsed })
    assert.deepEqual(switches.map(node => node.className), ['bt-title-toggle'])
  })
}

// #1430: the shell's own switch drew a tooltip shadow across the rail's edge. It lives in the
// logo row, or in the top strip in a macOS desktop window, and none of the team view's
// switches may share the screen with it.
const PLATFORMS = ['web', 'windows', 'mac', 'mac-frameless']
for (const platform of PLATFORMS) {
  for (const collapsed of [false, true]) {
    test(`the shell's own sidebar switch is hidden: ${platform}, ${collapsed ? 'collapsed' : 'open'}`, () => {
      const { document, hidden } = shell({ platform, collapsed })
      const own = [...document.querySelectorAll('.x_toggle')]
      assert.equal(own.length, 1)
      assert.equal(hidden(own[0]), true)
    })
  }
}

test('the top strip stays as the window\'s drag area while its switch is hidden', () => {
  for (const platform of ['mac', 'mac-frameless']) {
    for (const collapsed of [false, true]) {
      const { document, hidden } = shell({ platform, collapsed })
      const strip = document.querySelector('.x_topStrip')
      assert.ok(strip !== null, platform)
      assert.equal(hidden(strip), false, `${platform} ${collapsed ? 'collapsed' : 'open'}`)
      assert.equal(hidden(strip.querySelector('.x_toggle')), true)
    }
  }
})

test('the team view\'s own switches keep the places they had on every platform', () => {
  for (const platform of PLATFORMS) {
    const titlebar = platform === 'windows' || platform === 'mac-frameless'
    for (const collapsed of [false, true]) {
      const { document, hidden } = shell({ platform, collapsed })
      const title = document.querySelector('.bt-title-toggle')
      assert.equal(hidden(title), false, `${platform} title-band switch`)
      const side = document.querySelector('.bt-side-collapse')
      // The column's top row exists while it is open; under a title bar the band's switch replaces it.
      if (side !== null) assert.equal(hidden(side), titlebar, `${platform} column switch`)
    }
  }
})

test('off a Windows title bar the column\'s top row and the floating switch are never hidden by style', () => {
  for (const platform of ['web', 'mac']) {
    const { document, hidden } = shell({ platform, collapsed: false })
    assert.equal(hidden(document.querySelector('.bt-side-collapse')), false, platform)
    assert.equal(hidden(document.querySelector('.bt-title-toggle')), false, platform)
  }
})

test('what the team view replaces in the shell sidebar stays out of sight', () => {
  for (const platform of ['web', 'windows', 'mac']) {
    for (const collapsed of [false, true]) {
      const { document, hidden } = shell({ platform, collapsed })
      assert.equal(hidden(document.querySelector('.x_newSession')), true)
      const brand = document.querySelector('.x_brand')
      if (brand) assert.equal(hidden(brand), true)
    }
  }
})

function collapsedGridRules() {
  const { document } = new JSDOM('<style></style>').window
  document.querySelector('style').textContent = `${SHELL_CSS}\n${SIDEBAR_CSS}`
  const frames = []
  const visit = (rules, media = []) => {
    for (const rule of rules) {
      if (rule.selectorText?.includes('[data-sidebar-collapsed][data-rightbar-collapsed]') && rule.style.getPropertyValue('grid-template-columns'))
        frames.push({ selector: rule.selectorText, grid: rule.style.getPropertyValue('grid-template-columns'), media, rule })
      if (rule.cssRules?.length)
        visit(rule.cssRules, rule.media ? [...media, rule.media.mediaText] : media)
    }
  }
  visit(document.styleSheets[0].cssRules)
  return frames
}

test('the wide shell\'s collapsed sidebar keeps no track while its right column is closed', () => {
  const frames = collapsedGridRules().filter(rule => !rule.selector.includes('.bt-head'))
  assert.equal(frames.length, 1)
  assert.match(frames[0].grid, /^0px\s+minmax\(0,\s*1fr\)\s+0px$/)
})

// A narrow host may place the conversation in its first track instead of its second.
test('the collapsed shell grid override leaves layouts below 1024px to the host', () => {
  const frames = collapsedGridRules().filter(rule => !rule.selector.includes('.bt-head'))
  assert.equal(frames.length, 1)
  assert.ok(frames[0].media.some(query => /^\(min-width:\s*1024px\)$/.test(query)),
    'the zero-width first track must not override a narrow host layout')
})

test('a narrow Bot conversation keeps an explicit track and leaves expanded host panels alone', () => {
  const frames = collapsedGridRules().filter(frame => frame.media.includes('(max-width:1023px)'))
  assert.equal(frames.length, 1)
  const { rule } = frames[0]
  assert.match(frames[0].grid, /^0px\s+minmax\(0,\s*1fr\)\s+0px$/)
  assert.equal(rule.style.getPropertyPriority('grid-template-columns'), 'important')
  const { document } = new JSDOM('<div class="x_frame" data-sidebar-collapsed data-rightbar-collapsed><div class="x_centerCol"><div class="bt-head"></div></div></div>').window
  const frame = document.querySelector('.x_frame')
  assert.ok(frame.matches(rule.selectorText))
  for (const attribute of ['data-sidebar-collapsed', 'data-rightbar-collapsed']) {
    frame.removeAttribute(attribute)
    assert.equal(frame.matches(rule.selectorText), false)
    frame.setAttribute(attribute, '')
  }
  const columnRule = [...rule.parentRule.cssRules].find(candidate => candidate.selectorText?.endsWith(`>[class*="_centerCol"]`))
  assert.ok(columnRule, 'the narrow center column rule must exist')
  assert.ok(document.querySelector('.x_centerCol').matches(columnRule.selectorText))
  assert.equal(columnRule.style.getPropertyValue('grid-column'), '2')
  assert.equal(columnRule.style.getPropertyValue('width'), 'auto')
  for (const property of ['grid-column', 'width'])
    assert.equal(columnRule.style.getPropertyPriority(property), 'important')
  document.querySelector('.bt-head').remove()
  assert.equal(frame.matches(rule.selectorText), false)
})

test('the narrow Bot grid yields when either shell track opens', () => {
  const frames = collapsedGridRules().filter(rule => rule.selector.includes('.bt-head'))
  assert.equal(frames.length, 1)
  assert.ok(frames[0].media.some(query => /max-width:\s*1023px/.test(query)))
  const { document } = new JSDOM('<div class="x_frame" data-sidebar-collapsed data-rightbar-collapsed><div class="x_centerCol"><div class="bt-head"></div></div></div>').window
  const frame = document.querySelector('.x_frame')
  assert.equal(frame.matches(frames[0].selector), true)
  for (const attr of ['data-sidebar-collapsed', 'data-rightbar-collapsed']) {
    frame.removeAttribute(attr)
    assert.equal(frame.matches(frames[0].selector), false)
    frame.setAttribute(attr, '')
  }
  document.querySelector('.bt-head').remove()
  assert.equal(frame.matches(frames[0].selector), false)
})

test('rail control enlargement leaves short screens compact', () => {
  const { document } = new JSDOM('<style></style>').window
  document.querySelector('style').textContent = SHELL_CSS
  const queries = []
  const visit = (rules, media = []) => {
    for (const rule of rules) {
      if (rule.selectorText?.includes('.bt-rail-top .bt-round') && rule.style?.width === '56px') queries.push(media)
      if (rule.cssRules) visit(rule.cssRules, rule.media ? [...media, rule.media.mediaText] : media)
    }
  }
  visit(document.querySelector('style').sheet.cssRules)
  assert.equal(queries.length, 1)
  assert.ok(queries[0].some(query => /max-width:\s*600px/.test(query) && /min-height:\s*501px/.test(query)))
})

test('the column\'s top row hides it, on the rail too, and its edge is a drag grip', () => {
  viewport.innerWidth = 1280
  const calls = []
  const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
  const props = pref => ({
    wide: false,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSidebarPref: pick => pick(pref),
    actions: { toggleLeftHidden: () => calls.push('toggle'), toggleSidebar: () => {} },
  })
  const find = (node, match) => {
    if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    return match(node) ? node : find(node.props?.children, match)
  }
  const collapse = node => node.type === 'button' && node.props['aria-label'] === 'Collapse sidebar'
  for (const pref of ['open', 'rail']) {
    const tree = TeamSidebar(props(pref))
    const button = find(tree, collapse)
    assert.ok(button?.props.className.split(' ').includes('bt-side-collapse'), pref)
    button.props.onClick()
    const column = find(tree, node => node.type?.name === 'LeftColumn')
    assert.equal(column.props.mode, pref)
    assert.equal(typeof column.props.onGrip, 'function')
  }
  assert.deepEqual(calls, ['toggle', 'toggle'])
  // Hidden, there is no column at all; the floating switch brings it back.
  const hidden = TeamSidebar(props('hidden'))
  assert.equal(find(hidden, node => node.type?.name === 'LeftColumn'), undefined)
  const toggle = find(hidden, node => node.type?.name === 'TitleToggle')
  assert.equal(toggle.props.hidden, true)
  // Reduced motion disables both the column slide and the conversation margin transition.
  assert.match(SHELL_CSS, /@media\s*\(prefers-reduced-motion:reduce\)\{\.bt-leftcol\[data-entering\]\{animation:none\}\.bt-leftcol\[data-leaving\],\[class\*="_centerCol"\]\{transition:none\}\}/)
})

test('the column draws its first mount in place and slides in only after being hidden', () => {
  viewport.innerWidth = 1280
  const find = node => {
    if (Array.isArray(node)) return node.map(find).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    return node.type?.name === 'LeftColumn' ? node : find(node.props?.children)
  }
  for (const initial of ['open', 'rail', 'hidden']) {
    const refs = []
    const render = pref => {
      renderRefs = refs
      refIndex = 0
      layoutEffects = []
      try {
        const tree = TeamSidebar({
          wide: false,
          useRoster: pick => pick({ bots: [], rooms: [], agents: [], byId: {}, ready: true }),
          useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
          useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
          useSidebarPref: pick => pick(pref), actions: { toggleSidebar() {} },
        })
        const effects = layoutEffects
        layoutEffects = undefined
        effects.forEach(effect => effect())
        return find(tree)
      } finally {
        renderRefs = undefined
        layoutEffects = undefined
      }
    }
    if (initial === 'hidden') assert.equal(render(initial), undefined)
    else {
      assert.equal(render(initial).props.entering, false)
      assert.equal(render(initial).props.entering, false, 'ordinary rerenders do not start an entrance')
      assert.equal(render('hidden'), undefined)
    }
    assert.equal(render('open').props.entering, true)
    assert.equal(render('rail').props.entering, true)
  }
  assert.match(SHELL_CSS, /\.bt-leftcol\[data-entering\]\{animation:bt-leftcol-in /)
  assert.doesNotMatch(SHELL_CSS, /\.bt-leftcol\{animation:bt-leftcol-in /)
  assert.match(SHELL_CSS, /\.bt-leftcol\[data-leaving\]\{transform:translateX\(-100%\);transition:transform /)
})

test('the logo row takes no room in an open sidebar under a Windows title bar', () => {
  const { document } = shell({ platform: 'windows', collapsed: false })
  const row = document.querySelector('.x_logoRow')
  const flat = rules.filter(rule => row.matches(rule.selector) && /height:0!important/.test(rule.body))
  assert.equal(flat.length, 1)
  assert.equal(shell({ platform: 'windows', collapsed: true }).document.querySelector('.x_logoRow').matches(flat[0].selector), false)
})

// The shell hides the footer of a collapsed sidebar under a Windows title bar, whose width
// is zero; a forced display put the account button off the screen.
test('the team view lays out the shell footer but never decides whether it shows', () => {
  const { document } = shell({ platform: 'windows', collapsed: true })
  const foot = document.querySelector('.x_footArea')
  const deciding = rules.filter(rule => foot.matches(rule.selector) && /(^|;)display:/.test(rule.body))
  assert.deepEqual(deciding.map(rule => rule.selector), [])
})

// 公开#164: the footer's grid gives other plugins' entries rows of their own; it holds
// wherever the shell shows the footer, and stays out of the one place it hides it.
test('the shell footer is a grid wherever the shell shows it', () => {
  for (const platform of ['web', 'windows', 'mac']) {
    for (const collapsed of [false, true]) {
      const foot = shell({ platform, collapsed }).document.querySelector('.x_footArea')
      const grid = rules.some(rule => foot.matches(rule.selector) && /(^|;)display:grid/.test(rule.body))
      assert.equal(grid, !(platform === 'windows' && collapsed), `${platform} ${collapsed ? 'collapsed' : 'open'}`)
    }
  }
})

// #452: the footer lost its Connect plugins button; the account menu and the
// entries other plugins add keep the places they had.
test('the Bot footer lays out the account, another plugin\'s entry and the settings trigger', () => {
  const html = `<!doctype html><html><body><div class="x_root"><div class="x_footArea">
    <div class="x_footerActions">
      <div><span class="bt-foot-account"></span></div>
      <div><span class="x_other-plugin"></span></div>
    </div>
    <div class="x_settingsArea"><button class="x_trigger"><span class="x_label">Settings</span></button></div>
  </div></div></body></html>`
  const { document } = new JSDOM(html).window
  // The last rule that places a node is the one that counts, as in the cascade.
  const columnOf = node => {
    const placed = rules.filter(rule => node.matches(rule.selector) && /grid-column:/.test(rule.body))
    assert.ok(placed.length > 0, `no grid placement for ${node.className}`)
    return placed[placed.length - 1].body.match(/grid-column:([^;]+)/)[1]
  }
  // The account menu keeps the left of the row.
  assert.equal(columnOf(document.querySelector('.bt-foot-account')), '1')
  // Another plugin's entry takes a row of its own, above the Bot row.
  assert.equal(columnOf(document.querySelector('.x_other-plugin')), '1/-1')
  // The settings trigger keeps the right of the row.
  assert.equal(columnOf(document.querySelector('.x_settingsArea')), '3')
})

// 公开#502: the rail's icons keep the open column's rhythm — its row gap puts
// the same ~20px between avatar edges that the open list's padding and gap do,
// and the stacks and sections breathe on the same 6–8px steps.
test('the rail spaces its icons on the open column\'s rhythm', () => {
  const all = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)]
  const bodyOf = selector => all.filter(rule => rule.selector === selector).map(rule => rule.body).pop() ?? ''
  assert.match(bodyOf('.bt-rail .bt-list'), /(^|;)gap:8px/)
  assert.match(bodyOf('.bt-rail-top'), /(^|;)gap:8px/)
  assert.match(bodyOf('.bt-leftcol-foot-rail'), /(^|;)gap:8px/)
  assert.match(bodyOf('.bt-rail'), /(^|;)gap:6px/)
})

// The Plugins shortcut calls DSH's plugin page; a host without that navigation
// face has no page to open, so the button stays out of the foot entirely.
test('the Plugins shortcut stays out where the host has no plugin navigation', () => {
  assert.equal(PluginsButton({ actions: {} }), null)
  assert.equal(PluginsButton({ actions: { hasPlugins: () => false, openPlugins: () => { throw new Error('must not open') } } }), null)
})

test('the Plugins shortcut opens the plugin manager and names itself', () => {
  const calls = []
  const button = PluginsButton({ actions: { hasPlugins: () => true, openPlugins: () => calls.push('open') } })
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-label'], 'Plugins')
  assert.equal(button.props.title, 'Plugins')
  button.props.onClick()
  assert.deepEqual(calls, ['open'])
})

// The foot of the team column is the sidebar's own `.bt-leftcol-foot`, not the
// shell's footArea: only the account menu and the Agent-mode return button go
// through the shell's action slot.
test('the shell footer action slot holds the account and the return button only', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const ids = [...source.matchAll(/shadow\('sidebar\.footer\.action',\s*\{[^}]*?id:\s*['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual(ids.sort(), ['bot-account', 'bot-return'])
})

// The edge drag writes the column and the chat's margins straight into the page, so these
// run it on a jsdom page with real timers. The sandbox gets the page and the timers only
// while a drag runs; the release then re-renders the sidebar at the state it stored.
async function edgeDrag({ start, reduced = false }, run) {
  const dom = new JSDOM('<!doctype html><body><div class="x_centerCol"></div><div class="bt-leftcol"><div class="bt-leftcol-grip"></div></div></body>')
  const { document } = dom.window
  const column = document.querySelector('.bt-leftcol')
  const grip = column.querySelector('.bt-leftcol-grip')
  const center = document.querySelector('.x_centerCol')
  const frame = { viewport: 1280, sidebarWidth: start.width, collapsedWidth: 0, collapsed: false }
  const stored = { pref: start.pref }
  const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
  const actions = {
    setPanelYield() {}, setLeftDrawer() {}, toggleSidebar() {}, toggleLeftHidden() {},
    setSidebarWidth: (width) => { frame.sidebarWidth = width },
    setSidebarPref: (pref) => { stored.pref = pref },
  }
  const render = () => TeamSidebar({
    wide: false, actions,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useFrame: pick => pick(frame), useSidebarPref: pick => pick(stored.pref),
  })
  const leftColumn = () => {
    const find = (node) => {
      if (Array.isArray(node)) return node.map(find).find(Boolean)
      if (!node || typeof node !== 'object') return undefined
      return node.type?.name === 'LeftColumn' ? node : find(node.props?.children)
    }
    return find(render()).props
  }
  const globals = { document, performance, setTimeout, clearTimeout, requestAnimationFrame: next => setTimeout(next, 0), cancelAnimationFrame: clearTimeout, CSS: { escape: value => value } }
  Object.assign(sandbox, globals)
  viewport.innerWidth = 1280
  if (reduced) viewport.matchMedia = () => ({ matches: true })
  const pointer = (type, clientX) => grip.dispatchEvent(new dom.window.MouseEvent(type, { clientX }))
  try {
    return await run({
      column, center, leftColumn,
      press: () => leftColumn().onGrip({ button: 0, pointerId: 1, currentTarget: grip, preventDefault() {} }),
      move: clientX => pointer('pointermove', clientX),
      release: clientX => pointer('pointerup', clientX),
      settle: ms => new Promise(resolve => setTimeout(resolve, ms)),
    })
  } finally {
    document.head.replaceChildren() // Detach cached style owners with this fixture.
    for (const name of Object.keys(globals)) delete sandbox[name]
    delete viewport.matchMedia
  }
}

// After the drag ends the column's own width must be the one the sidebar renders for the
// state it stored, or the edge sits at the CSS fallback (57px on the rail).
test('a drag that ends on the rail leaves the column at the rail width', async () => {
  await edgeDrag({ start: { pref: 'open', width: 350 } }, async ({ column, leftColumn, press, move, release, settle }) => {
    press()
    for (const x of [300, 250, 200, 150, 100]) move(x)
    release(100)
    await settle(800)
    assert.equal(leftColumn().mode, 'rail')
    assert.equal(leftColumn().width, 88)
    assert.equal(column.style.width, '88px')
    assert.equal(column.hasAttribute('data-folding'), false)
  })
})

test('a reduced-motion drag that unfolds the rail lands at the dragged width', async () => {
  await edgeDrag({ start: { pref: 'rail', width: 280 }, reduced: true }, async ({ column, leftColumn, press, move, release }) => {
    press()
    for (const x of [120, 160, 200, 260, 330]) move(x)
    release(330)
    assert.equal(leftColumn().mode, 'open')
    assert.equal(leftColumn().width, 330)
    assert.equal(column.style.width, '330px')
    assert.equal(column.hasAttribute('data-folding'), false)
  })
})

// The spring rides the snap switch only: after it settles the same drag follows the cursor
// frame by frame, and the chat's margin takes no transition of its own.
test('after a snap the spring stops and the drag follows the cursor', async () => {
  await edgeDrag({ start: { pref: 'rail', width: 280 } }, async ({ column, center, leftColumn, press, move, release, settle }) => {
    press()
    move(200)
    assert.equal(column.dataset.folding, '')
    await settle(800)
    assert.equal(column.hasAttribute('data-folding'), false)
    assert.equal(center.style.getPropertyValue('transition'), 'none')
    for (const x of [280, 300, 330]) {
      move(x)
      assert.equal(column.style.width, `${x}px`)
    }
    release(330)
    await settle(800)
    assert.equal(leftColumn().width, 330)
    assert.equal(column.style.width, '330px')
  })
})

test('TeamSidebar subscribes to specific ui slices rather than the whole ui object', () => {
  const selectors = []
  const base = { unread: {}, leftDrawer: false, details: null, view: 'details', panelYield: false, bootFailed: false }
  TeamSidebar({
    wide: true,
    useRoster: pick => pick({ bots: [], rooms: [], agents: [], byId: {}, ready: true }),
    useUi: (pick) => { selectors.push(pick); return pick(base) },
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }),
    useUpdate: () => ({}),
    actions: { toggleSidebar() {} },
  })
  assert.ok(selectors.length > 0)
  for (const pick of selectors) {
    const before = pick(base)
    const after = pick({ ...base, palette: { query: 'test', token: 1 }, settings: { page: 'general' }, menu: { kind: 'bot', id: 'b1' }, toast: { text: 'err' } })
    assert.equal(Object.is(before, after), true)
  }
})


// A Bot team that never started leaves nothing to use on the Bot surface; the hint
// that says so carries the way back to the classic view, wide or on the rail (#1314).
for (const wide of [true, false]) {
  test(`a Bot team that could not start offers the classic view (${wide ? 'open column' : 'rail'})`, () => {
    viewport.innerWidth = 1280
    const calls = []
    const tree = TeamSidebar({
      wide,
      useRoster: pick => pick({ bots: [], rooms: [], agents: [], byId: {}, ready: false }),
      useUi: pick => pick({ unread: {}, leftDrawer: false, bootFailed: true }),
      useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }),
      useUpdate: () => ({}),
      actions: { toggleSidebar() {}, setSurface: mode => calls.push(mode) },
    })
    const find = (node, match) => {
      if (Array.isArray(node)) { for (const child of node) { const hit = find(child, match); if (hit) return hit } return undefined }
      if (!node || typeof node !== 'object') return undefined
      if (match(node)) return node
      return find(node.props?.children, match)
    }
    const hint = find(tree, node => node.type?.name === 'BootFailed')
    assert.ok(hint, 'the could-not-start hint renders')
    const button = find(hint.type(hint.props), node => node.type === 'button')
    assert.equal(button.props.children.join(''), 'Switch to classic Agent mode')
    button.props.onClick()
    assert.deepEqual(calls, ['agent'])
  })
}

async function withDom(html, run) {
  const dom = new JSDOM(html)
  const { document, MutationObserver } = dom.window
  const globals = {
    document, MutationObserver, performance, setTimeout, clearTimeout,
    requestAnimationFrame: next => setTimeout(next, 0), cancelAnimationFrame: clearTimeout,
    CSS: { escape: value => value },
  }
  Object.assign(sandbox, globals)
  Object.assign(viewport, { addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window) })
  try { return await run(dom.window) }
  finally {
    document.head.replaceChildren() // Detach cached style owners with this fixture.
    for (const name of Object.keys(globals)) delete sandbox[name]
    delete viewport.addEventListener
    delete viewport.removeEventListener
  }
}

test('chat margins own auto width until both overrides are released', async () => {
  await withDom('<!doctype html><body><div class="x_centerCol"></div></body>', ({ document }) => {
    chatRoom.setLeft(88)
    const style = document.querySelector('style[data-dsh-bot="chat-room"]').sheet.cssRules[0].style // Legacy style-owner attribute.
    assert.equal(style.getPropertyValue('width'), 'auto')
    chatRoom.setRight(320)
    chatRoom.setLeft(null)
    assert.equal(style.getPropertyValue('width'), 'auto')
    chatRoom.setRight(null)
    assert.equal(style.getPropertyValue('width'), '')
    chatRoom.setLeft(0)
    assert.equal(style.getPropertyValue('width'), 'auto')
    chatRoom.setLeft(null)
    assert.equal(style.getPropertyValue('width'), '')
  })
})

test('an overlay sidebar strip does not reserve a grid track', async () => {
  await withDom('<!doctype html><body><div class="x_sidebarCol"></div></body>', async ({ document, getComputedStyle }) => {
    const column = document.querySelector('.x_sidebarCol')
    column.getBoundingClientRect = () => ({ width: 52, right: 52 })
    sandbox.getComputedStyle = getComputedStyle
    try {
      for (const position of ['absolute', 'fixed']) {
        column.style.position = position
        assert.equal(sidebarTrackWidth(), 0)
      }
      column.style.position = 'relative'
      assert.equal(sidebarTrackWidth(), 52)
    } finally { delete sandbox.getComputedStyle }
  })
})

// 公开#1618: DSH Desktop wraps _sidebarCol in <aside class="dshDesktopSidebarSurface">
// inside <div class="dshDesktopFrame" data-sidebar-collapsed>, whereas DSH Web puts
// _sidebarCol directly under the frame. Both structures must report collapsed accurately.
test('dshCollapsed detects collapsed ancestors in both DSH Web and DSH Desktop layouts', async () => {
  await withDom('<!doctype html><body><div class="unrelated" data-sidebar-collapsed></div></body>', () => {
    assert.equal(dshCollapsed(), null)
  })
  for (const [name, makeHtml] of [
    ['web direct parent', collapsed => `<!doctype html><body><div class="x_frame"${collapsed ? ' data-sidebar-collapsed="true"' : ''}><div class="x_sidebarCol"></div></div></body>`],
    ['desktop nested aside', collapsed => `<!doctype html><body><div class="dshDesktopFrame"${collapsed ? ' data-sidebar-collapsed' : ''}><aside class="dshDesktopSidebarSurface"><div class="dshDesktopUpstreamSidebar dshDesktop_sidebarCol"></div></aside></div></body>`],
  ]) {
    await withDom(makeHtml(true), () => {
      assert.equal(dshCollapsed(), true, `${name} collapsed`)
    })
    await withDom(`${makeHtml(false).replace('</body>', '<div class="other" data-sidebar-collapsed></div></body>')}`, () => {
      assert.equal(dshCollapsed(), false, `${name} expanded`)
    })
  }
})

test('installFrameWatch tracks data-sidebar-collapsed on DSH Desktop ancestor frame', async () => {
  await withDom('<!doctype html><body><div class="dshDesktopFrame"><aside class="dshDesktopSidebarSurface"><div class="dshDesktopUpstreamSidebar dshDesktop_sidebarCol"></div></aside></div></body>', async ({ document }) => {
    viewport.innerWidth = 1280
    const frame = createSource({ viewport: 1280, sidebarWidth: 280, collapsedWidth: 0, collapsed: false })
    const stop = installFrameWatch(frame)
    try {
      assert.equal(frame.getSnapshot().collapsed, false)
      document.querySelector('.dshDesktopFrame').setAttribute('data-sidebar-collapsed', '')
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(frame.getSnapshot().collapsed, true)
      document.querySelector('.dshDesktopFrame').removeAttribute('data-sidebar-collapsed')
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(frame.getSnapshot().collapsed, false)
    } finally { stop() }
  })
})

test('installFrameWatch rescans the columns only when one it watches was replaced', async () => {
  await withDom('<!doctype html><body><div class="frame"><div class="x_sidebarCol"></div><div class="x_centerCol"><div class="other"></div></div></div></body>', async ({ document }) => {
    sandbox.Element = document.defaultView.Element
    const observed = new Set()
    sandbox.ResizeObserver = class { observe(node) { observed.add(node) } unobserve(node) { observed.delete(node) } disconnect() { observed.clear() } }
    const scans = []
    const all = document.querySelectorAll.bind(document)
    document.querySelectorAll = (selector) => { if (selector.includes('_sidebarCol')) scans.push(selector); return all(selector) }
    const frame = createSource({ viewport: 1280, sidebarWidth: 280, collapsedWidth: 0, collapsed: false })
    const stop = installFrameWatch(frame)
    const settle = () => new Promise(resolve => setTimeout(resolve, 30))
    try {
      assert.deepEqual([...observed], [document.querySelector('.x_sidebarCol'), document.querySelector('.x_centerCol')])
      assert.equal(scans.length, 1)
      document.querySelector('.other').append(document.createElement('span'))
      await settle()
      assert.equal(scans.length, 1, 'a mutation that leaves the columns in place does not rescan')
      const old = document.querySelector('.x_sidebarCol')
      const next = document.createElement('div')
      next.className = 'x_sidebarCol'
      old.replaceWith(next)
      await settle()
      assert.equal(scans.length, 2)
      assert.equal(observed.has(old), false)
      assert.equal(observed.has(next), true)
      assert.equal(observed.size, 2)
      const pane = document.createElement('div')
      pane.className = 'x_centerCol'
      document.querySelector('.frame').append(pane)
      await settle()
      assert.equal(scans.length, 3, 'a column added next to the watched ones is picked up')
      assert.equal(observed.has(pane), true)
      assert.equal(observed.size, 3)
    } finally {
      stop()
      delete sandbox.ResizeObserver
      delete sandbox.Element
    }
  })
})

test('TeamSidebar collapses DSH Desktop sidebar once without entering a 300ms toggle loop', async () => {
  await withDom('<!doctype html><body><div class="dshDesktopFrame"><aside class="dshDesktopSidebarSurface"><div class="dshDesktopUpstreamSidebar dshDesktop_sidebarCol"></div></aside><div class="dshDesktop_centerCol"></div></div></body>', async ({ document }) => {
    viewport.innerWidth = 1280
    const frameEl = document.querySelector('.dshDesktopFrame')
    const refs = []
    const states = []
    const cleanups = []
    let toggles = 0
    let scheduled = false
    const frame = createSource({ viewport: 1280, sidebarWidth: 280, collapsedWidth: 0, collapsed: false })
    const stopWatch = installFrameWatch(frame)
    const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
    const actions = {
      toggleSidebar() {
        toggles += 1
        if (frameEl.hasAttribute('data-sidebar-collapsed')) frameEl.removeAttribute('data-sidebar-collapsed')
        else frameEl.setAttribute('data-sidebar-collapsed', '')
      },
    }
    let disposed = false
    const render = () => {
      if (disposed) return
      renderRefs = refs
      refIndex = 0
      renderStates = states
      stateIndex = 0
      layoutEffects = []
      scheduleStateRender = () => {
        if (scheduled || disposed) return
        scheduled = true
        queueMicrotask(() => { scheduled = false; render() })
      }
      const snap = frame.getSnapshot()
      TeamSidebar({
        wide: !snap.collapsed, actions,
        useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
        useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
        useFrame: pick => pick(snap),
      })
      renderRefs = undefined
      renderStates = undefined
      scheduleStateRender = undefined
      const effects = layoutEffects
      layoutEffects = undefined
      for (const effect of effects) {
        const off = effect()
        if (typeof off === 'function') cleanups.push(off)
      }
    }
    const offFrame = frame.subscribe(() => queueMicrotask(render))
    try {
      render()
      await new Promise(resolve => setTimeout(resolve, 750))
      assert.equal(toggles, 1)
      assert.equal(frameEl.hasAttribute('data-sidebar-collapsed'), true)
      assert.equal(document.documentElement.hasAttribute('data-bt-collapsing'), false)
    } finally {
      disposed = true
      offFrame()
      stopWatch()
      for (const off of cleanups) off()
      document.documentElement.removeAttribute('data-bt-collapsing')
    }
  })
})

test('TeamSidebar leaves an already-collapsed DSH Desktop sidebar alone', async () => {
  await withDom('<!doctype html><body><div class="dshDesktopFrame" data-sidebar-collapsed><aside class="dshDesktopSidebarSurface"><div class="dshDesktopUpstreamSidebar dshDesktop_sidebarCol"></div></aside></div></body>', async ({ document }) => {
    viewport.innerWidth = 1280
    const refs = []
    const states = []
    let toggles = 0
    renderRefs = refs
    refIndex = 0
    renderStates = states
    stateIndex = 0
    layoutEffects = []
    try {
      TeamSidebar({
        wide: false,
        actions: { toggleSidebar() { toggles += 1 } },
        useRoster: pick => pick({ bots: [], rooms: [], agents: [], byId: {}, ready: true }),
        useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
        useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
      })
      const effects = layoutEffects
      layoutEffects = undefined
      for (const effect of effects) effect()
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.equal(toggles, 0)
      assert.equal(document.documentElement.hasAttribute('data-bt-collapsing'), false)
    } finally {
      renderRefs = undefined
      renderStates = undefined
      layoutEffects = undefined
      document.documentElement.removeAttribute('data-bt-collapsing')
    }
  })
})
