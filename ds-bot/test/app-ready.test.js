import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The sidebar imports the browser's React; bundle it with a minimal stand-in, as the
// sidebar tests do: components run as plain functions, and each mounted one keeps its
// refs and runs an effect after a render when the effect's dependencies changed.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { BotReturn, TeamSidebar } from './src/client/sidebar.js'\nexport { clientErrors } from './src/client/diagnostics.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let hooks
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useRef: initial => hooks.ref(initial), useEffect: (run, deps) => hooks.effect(run, deps), useLayoutEffect() {},
  useMemo: make => make(), useState: initial => [initial, () => {}], useId: () => 'id',
  // The bundled Deep View widgets make a React context when their module loads.
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}

function mount(component) {
  const slots = []
  return (props) => {
    let at = 0
    const effects = []
    hooks = {
      ref: initial => (slots[at++] ??= { current: initial }),
      effect: (run, deps) => {
        const i = at++
        if (slots[i] !== undefined && deps.every((value, index) => value === slots[i][index])) return
        slots[i] = deps
        effects.push(run)
      },
    }
    const tree = component(props)
    hooks = undefined
    for (const run of effects) run()
    return tree
  }
}

// One page load: a fresh copy of the client modules, under the app bridge it was given.
function page(dsBotApp, documentStub = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} }, ...documentStub },
    setTimeout: () => 0, clearTimeout() {},
    ...(dsBotApp === undefined ? {} : { dsBotApp }),
    ...globals,
  })
  return module.exports
}

const BEFORE_STATE = { ready: false, mainBotId: null, bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, agentOf: {} }
const main = { id: 'main', name: 'DeepSeek', createdAt: 1 }
const TEAM = { ...BEFORE_STATE, ready: true, revision: 1, mainBotId: 'main', mainBotIds: ['main'], bots: [main], byId: { main } }

const sidebarProps = roster => ({
  wide: true, actions: { landOn() {} },
  useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
  useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
})
const returnProps = (mode, roster) => ({ wide: true, actions: {}, useSurface: pick => pick({ mode }), useRoster: pick => pick(roster) })

// The team column's content sits inside the frame's column, under a Fragment.
const drawsSide = node => node !== null && typeof node === 'object'
  && (node.props?.className === 'bt-side' || (node.props?.children ?? []).flat().some(drawsSide))

function readyCalls() {
  const calls = []
  return { calls, app: { ready: (...args) => { calls.push(args) } } }
}

test('the desktop app hears once that the team sidebar drew the first state', async () => {
  const { calls, app } = readyCalls()
  const { TeamSidebar } = page(app)
  const sidebar = mount(TeamSidebar)
  sidebar(sidebarProps(BEFORE_STATE))
  await setImmediate()
  assert.deepEqual(calls, [], 'the sidebar is not ready before the first state')
  sidebar(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]])
  sidebar(sidebarProps({ ...TEAM, revision: 2 }))
  mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]], 'later states and a second mount report nothing more')
})

// The Main Bot in the start window's whale: the report says where its avatar is drawn, so the
// desktop app's whale can land on it.
const whaleTeam = { ...TEAM, byId: { main: { ...main, color: 'deepseek', avatar: { shape: 'whale' } } } }
const avatarPage = app => page(app, {
  querySelector: selector => (selector === '.bt-side [data-bot-id="main"] .bt-mark' ? { checkVisibility: () => true, getBoundingClientRect: () => ({ left: 98, top: 70, width: 60, height: 60 }) } : null),
  documentElement: { clientWidth: 1280, clientHeight: 800, setAttribute() {}, removeAttribute() {} },
})

test('the report says where the Main Bot\'s whale is drawn', async () => {
  const { calls, app } = readyCalls()
  mount(avatarPage(app).TeamSidebar)(sidebarProps(whaleTeam))
  await setImmediate()
  // The place was made in the page's own realm: compared by value.
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{ x: 98, y: 70, width: 60, height: 60, viewportWidth: 1280, viewportHeight: 800 }]])
})

test('the place is where the team column comes to rest, not where its slide-in has it', async () => {
  // Measured as the column first draws: its slide has it 270 px off to the left (and, to catch
  // either axis, 10 px up).
  const column = { offsetLeft: 0, offsetTop: 0, getBoundingClientRect: () => ({ left: -270, top: -10 }) }
  const mark = { checkVisibility: () => true, closest: selector => (selector === '.bt-leftcol' ? column : null), getBoundingClientRect: () => ({ left: -172, top: 60, width: 60, height: 60 }) }
  const { calls, app } = readyCalls()
  mount(page(app, {
    querySelector: selector => (selector === '.bt-side [data-bot-id="main"] .bt-mark' ? mark : null),
    documentElement: { clientWidth: 1280, clientHeight: 800, setAttribute() {}, removeAttribute() {} },
  }).TeamSidebar)(sidebarProps(whaleTeam))
  await setImmediate()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{ x: 98, y: 70, width: 60, height: 60, viewportWidth: 1280, viewportHeight: 800 }]])
})

test('a Main Bot in another look or a photo reports no place', async () => {
  for (const avatar of [{ shape: 'star' }, { shape: 'whale', image: 'data:image/png;base64,AA' }]) {
    const { calls, app } = readyCalls()
    mount(avatarPage(app).TeamSidebar)(sidebarProps({ ...whaleTeam, byId: { main: { ...main, color: 'deepseek', avatar } } }))
    await setImmediate()
    assert.deepEqual(calls, [[]], JSON.stringify(avatar))
  }
})

test('in Agent mode the return button reports what the team sidebar would', async () => {
  const { calls, app } = readyCalls()
  const { BotReturn, TeamSidebar } = page(app)
  const button = mount(BotReturn)
  assert.equal(button(returnProps('bot', TEAM)), null)
  button(returnProps('agent', BEFORE_STATE))
  await setImmediate()
  assert.deepEqual(calls, [])
  button(returnProps('agent', TEAM))
  mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]])
})

test('the return button says where it goes, and a click goes back to the Bot surface', () => {
  const { app } = readyCalls()
  const { BotReturn } = page(app)
  const text = node => (typeof node === 'string' ? node : [node?.props?.children].flat().filter(Boolean).map(text).join(''))
  const modes = []
  const wide = mount(BotReturn)({ ...returnProps('agent', TEAM), actions: { setSurface: mode => modes.push(mode) } })
  assert.equal(wide.props['aria-label'], 'Back to DS Bot')
  assert.equal(text(wide), 'Back to DS Bot')
  wide.props.onClick()
  assert.deepEqual(modes, ['bot'])
  // The narrow footer keeps the whale alone; the name stays in the label and tooltip.
  const narrow = mount(BotReturn)({ ...returnProps('agent', TEAM), wide: false })
  assert.equal(narrow.props['aria-label'], 'Back to DS Bot')
  assert.equal(narrow.props.title, 'Back to DS Bot')
  assert.equal(text(narrow), '')
})

test('without the app bridge or its ready() the sidebar draws as before', async () => {
  for (const app of [undefined, {}]) {
    const { TeamSidebar, clientErrors } = page(app)
    const tree = mount(TeamSidebar)(sidebarProps(TEAM))
    await setImmediate()
    assert.ok(drawsSide(tree))
    assert.equal(clientErrors().length, 0)
  }
})

test('a ready() that throws is noted and the sidebar stays', async () => {
  const { TeamSidebar, clientErrors } = page({ ready: () => { throw new Error('bridge gone') } })
  const tree = mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.ok(drawsSide(tree))
  assert.deepEqual(Array.from(clientErrors(), entry => entry.text), ['app ready: bridge gone'])
})

// The desktop app's start window hands its whale over at the top of its jump: the sidebar draws a
// copy of the avatar there, holds it while the windows cross-fade, then glides it onto the avatar.
test('a whale handed over glides from where it was handed onto the Main Bot\'s avatar', async () => {
  const made = []
  const element = () => {
    const el = { style: { setProperty() {} }, children: [], attributes: {}, animations: [], removed: false }
    el.append = child => { el.children.push(child) }
    el.setAttribute = (name, value) => { el.attributes[name] = value }
    el.removeAttribute = (name) => { delete el.attributes[name] }
    el.remove = () => { el.removed = true }
    el.animate = (frames, timing) => { const run = { frames, timing, finished: Promise.resolve() }; el.animations.push(run); return run }
    made.push(el)
    return el
  }
  // The hand-off can come while the column still slides in: the copy goes where it comes to rest.
  const column = { offsetLeft: 0, offsetTop: 0, getBoundingClientRect: () => ({ left: -40, top: 0 }) }
  const mark = { ...element(), checkVisibility: () => true, closest: selector => (selector === '.bt-leftcol' ? column : null), getBoundingClientRect: () => ({ left: 58, top: 70, width: 60, height: 60 }), cloneNode: () => element() }
  const body = element()
  let handoff
  const calls = []
  const app = { ready: (...args) => { calls.push(['ready', ...args]) }, onHandoff: (run) => { calls.push(['onHandoff']); handoff = run } }
  const { TeamSidebar } = page(app, {
    querySelector: selector => (selector === '.bt-side [data-bot-id="main"] .bt-mark' ? mark : null),
    documentElement: { clientWidth: 1280, clientHeight: 800, setAttribute() {}, removeAttribute() {} },
    createElement: element, body,
  }, { getComputedStyle: () => ({ getPropertyValue: () => '#4D6BFE' }) })
  mount(TeamSidebar)(sidebarProps(whaleTeam))
  await setImmediate()
  // Listening before the report goes, so a quick hand-off is not missed.
  assert.deepEqual(calls.map(call => call[0]), ['onHandoff', 'ready'])
  handoff({ x: 584, y: 307, size: 112, hold: 260 })
  const [outer] = body.children
  assert.equal(outer.style.position, 'fixed')
  assert.equal(mark.style.opacity, '0')
  const [across] = outer.animations
  assert.equal(across.frames[0].transform, 'translateX(486px)')
  assert.equal(across.timing.delay, 260)
  const [glide] = outer.children[0].animations
  assert.equal(glide.frames[0].transform, `translateY(237px) scale(${String(112 / 60)})`)
  assert.equal(glide.frames[1].transform, 'none')
  await setImmediate()
  // Landed: the copy goes, the avatar is back and gives its small bounce.
  assert.equal(outer.removed, true)
  assert.equal(mark.style.opacity, '')
  assert.equal(mark.animations.length, 1)
})
