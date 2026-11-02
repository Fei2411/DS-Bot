import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The pane's message field shares the composer preference: while Enter sends, a plain
// Enter submits; off, it is the field's own newline and only the send button submits.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/new-chat.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: 'fish', MarkdownText: () => null, writeClipboard: () => {} }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} } },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
})
const { NewChat } = module.exports
const mount = (props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = NewChat(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
  }
  return instance
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props.children, check)]
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return String(node ?? '')
  return text(node.props?.children)
}
const textarea = node => all(node, child => child.type === 'textarea')[0]
const options = node => all(node, child => child.props?.role === 'option')
const enter = (extra = {}) => ({
  key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, prevented: false,
  preventDefault() { this.prevented = true }, ...extra,
})
const tick = () => new Promise(resolve => setImmediate(resolve))

// A group pane picks its admin, then the member the typed message goes to. Every
// step awaits: each click runs through the pane's async busy guard before the next
// render reads the new state.
const pane = async ({ ready = true, prefs = {} } = {}) => {
  const calls = { send: [], rooms: [], sessions: [] }
  const bots = [
    { id: 'chief', name: 'Chief', role: 'main' },
    { id: 'worker', name: 'Worker', role: 'helper' },
  ]
  const roster = { ready, prefs, bots, byId: { chief: bots[0], worker: bots[1] }, roomsById: {}, agents: [] }
  const actions = {
    closeOverlay() { calls.closed = (calls.closed ?? 0) + 1 },
    createRoom: async (ids) => { calls.rooms.push(ids); return { id: 'room1' } },
    send: async (id, value) => { calls.send.push([id, value]) },
    openSession: (id) => { calls.sessions.push(id) },
    setFlags: async () => {},
  }
  const view = mount({ mode: 'group', roster, actions })
  const pick = async (name) => {
    const row = options(view.render()).find(child => text(child).includes(name))
    assert.ok(row, `no option for ${name}`)
    row.props.onClick()
    await tick()
  }
  await pick('Chief')
  await pick('Worker')
  textarea(view.render()).props.onChange({ target: { value: 'hello team' } })
  return { view, calls, tree: () => view.render() }
}

test('with Enter sending on, a plain Enter sends the message to the group', async () => {
  const { calls, tree } = await pane({ prefs: { enterToSend: true } })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rooms)), [['chief', 'worker']])
  assert.deepEqual(JSON.parse(JSON.stringify(calls.send)), [['room1', 'hello team']])
})

test('with Enter sending saved off, a plain Enter is the field\'s own newline', async () => {
  const { calls, tree } = await pane({ prefs: { enterToSend: false } })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, false)
  assert.deepEqual(calls.send, [])
  assert.deepEqual(calls.rooms, [])
})

test('a roster still loading keeps a saved off and a first-time default', async () => {
  // The pre-pull roster stays ready:false but already carries the window's saved prefs.
  const saved = await pane({ ready: false, prefs: { enterToSend: false } })
  const off = enter()
  textarea(saved.tree()).props.onKeyDown(off)
  await tick()
  assert.equal(off.prevented, false)
  assert.deepEqual(JSON.parse(JSON.stringify(saved.calls.send)), [])
  // A window with nothing saved keeps the default: Enter sends, it is not stuck off.
  const fresh = await pane({ ready: false, prefs: {} })
  const on = enter()
  textarea(fresh.tree()).props.onKeyDown(on)
  await tick()
  assert.equal(on.prevented, true)
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.calls.send)), [['room1', 'hello team']])
})

test('Shift+Enter and IME confirmation keep their default behavior', async () => {
  for (const extra of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }]) {
    const { calls, tree } = await pane({ prefs: { enterToSend: true } })
    const event = enter(extra)
    textarea(tree()).props.onKeyDown(event)
    await tick()
    assert.equal(event.prevented, false)
    assert.deepEqual(calls.send, [])
  }
})
