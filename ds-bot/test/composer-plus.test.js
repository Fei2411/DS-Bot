import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The composer's "+" bundled with a React stand-in that counts hook calls. React needs a
// component to call the same hooks on every render: one render that calls a hook the
// previous render did not is an error, and the composer's slot drops the "+" for good.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/composer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
let hooks = 0
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => { hooks += 1; return [initial, () => {}] },
  useRef: current => { hooks += 1; return { current } },
  useEffect: () => { hooks += 1 },
  useLayoutEffect: () => { hooks += 1 },
  useMemo: make => { hooks += 1; return make() },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { body: {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { ComposerPlus } = module.exports

// Renders the "+" for a chat whose Bot is in the roster as `roster` says, and counts its hook calls.
function render(roster) {
  hooks = 0
  const tree = ComposerPlus({
    sessionId: 'chief', useRoster: select => select(roster),
    useInput: select => select({ phase: 'plain', draft: '', attachmentIds: [], queue: [] }),
    actions: { canReferenceChat: () => false },
  })
  return { tree, hooks }
}

// A group whose own Session moved to a fresh part (`room.sessionId`), with the Main
// Bot as its admin so the goal entry is offered.
const movedRoom = { id: 'g', sessionId: 'g-part2', name: 'Ops', members: ['a'], admin: 'a' }
const movedRoster = { byId: { a: { id: 'a', name: 'Chief' } }, roomsById: { g: movedRoom, 'g-part2': movedRoom } }
const hooksFor = (roster, actions) => ComposerPlus({
  sessionId: 'g-part2', useRoster: select => select(roster),
  useInput: select => select({ phase: 'plain', draft: '', attachmentIds: [], queue: [] }),
  actions,
})

test('the + Set a goal entry stores the room id when the Session moved', () => {
  const calls = []
  const original = react.useState
  // Seed the menu open; the test's real useState never re-renders.
  react.useState = initial => [initial === null ? { files: false } : initial, () => {}]
  try {
    const tree = hooksFor(movedRoster, { canReferenceChat: () => false, composeGoal: id => calls.push(id) })
    const items = []
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node.type === 'function') { walk(node.type(node.props)); return }
      if (node.props?.role === 'menuitem') items.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    const entry = items.find(item => JSON.stringify(item).includes('Set a goal'))
    assert.ok(entry)
    entry.props.onClick()
    assert.deepEqual(calls, ['g'])
  } finally { react.useState = original }
})

test('the "+" calls the same hooks whether or not its roster knows the Bot yet', () => {
  const roster = { ready: false }
  const unknown = render(roster)
  roster.byId = { chief: { id: 'chief' } }
  const known = render(roster)
  roster.byId = {}
  const forgotten = render(roster)
  assert.equal(unknown.tree, null)
  assert.equal(known.tree.type, 'fragment')
  assert.equal(forgotten.tree, null)
  assert.equal(known.hooks, unknown.hooks)
  assert.equal(forgotten.hooks, unknown.hooks)
})

test('rapid double Cmd/Ctrl+Enter on empty draft still intercepts second keydown while steerQueued is in flight', async () => {
  const listeners = new Map()
  const win = {
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener() {},
  }
  const effects = []
  const refs = []
  const localReact = {
    ...react,
    useRef: initial => {
      const ref = { current: initial }
      refs.push(ref)
      return ref
    },
    useEffect: fn => { effects.push(fn) },
  }
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod, exports: mod.exports, window: win, document: { body: {} }, setTimeout, clearTimeout,
    require: name => (name === 'react' ? localReact : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  const card = { style: { getPropertyValue: () => '', setProperty: () => {}, removeProperty: () => {} } }
  const btnEl = { closest: sel => (sel === '[data-composer-card]' ? card : null) }
  let resolveSteer
  let steerCalls = 0
  mod.exports.ComposerPlus({
    sessionId: 'chief',
    useRoster: select => select({ byId: { chief: { id: 'chief' } }, prefs: { enterToSend: true } }),
    useInput: select => select({ phase: 'plain', draft: '', attachmentIds: [], queue: [{ id: 'u1', source: { kind: 'user' } }, { id: 'b1', source: { kind: 'bot' } }] }),
    actions: {
      canReferenceChat: () => false,
      steerQueued: () => {
        steerCalls += 1
        return new Promise((resolve) => { resolveSteer = resolve })
      },
    },
  })
  // Attach the button ref before running captured effects so DOM scoping matches.
  for (const ref of refs) {
    if (ref.current === null) { ref.current = btnEl; break }
  }
  for (const effect of effects) effect()
  const keyHandlers = listeners.get('keydown') ?? []
  assert.ok(keyHandlers.length > 0, 'ComposerPlus must register keydown capture listener')

  const makeKeyEvent = () => ({
    key: 'Enter',
    metaKey: true,
    defaultPrevented: false,
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented += 1; this.defaultPrevented = true },
    stopPropagation() { this.stopped += 1 },
    target: {
      ownerDocument: { querySelector: () => null },
      closest(sel) {
        if (sel === '[data-composer-card]') return card
        if (sel === '[contenteditable=true]') return this
        return null
      },
    },
  })
  const ev1 = makeKeyEvent()
  const ev2 = makeKeyEvent()
  for (const fn of keyHandlers) fn(ev1)
  for (const fn of keyHandlers) fn(ev2)

  assert.equal(ev1.prevented, 1)
  assert.equal(ev1.stopped, 1)
  assert.equal(ev2.prevented, 1, 'second rapid Cmd+Enter while steerQueued is in flight MUST still be intercepted')
  assert.equal(ev2.stopped, 1)
  assert.equal(steerCalls, 1, 'second rapid Cmd+Enter must NOT fire a duplicate steerQueued request')
  resolveSteer?.()
})
