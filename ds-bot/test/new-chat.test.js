import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The right-hand new-chat pane: it picks one Bot (with an optional message) or hands
// over to the centred Create Bot dialog. Group chats have their own dialog too.
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
const listeners = new Map()
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: 'fish', MarkdownText: () => null, writeClipboard: () => {} }
    throw new Error(`no platform module ${name}`)
  },
  window: {
    innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }),
    addEventListener: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    removeEventListener: (name, fn) => { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)) },
  },
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
const recipient = node => all(node, child => child.props?.['aria-label'] === 'Recipient')[0]
const options = node => all(node, child => child.props?.role === 'option')
const enter = () => ({
  key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, prevented: false,
  preventDefault() { this.prevented = true },
})
const tick = () => new Promise(resolve => setImmediate(resolve))

const pane = ({ mode = 'new', sectionId = null, prefs = {} } = {}) => {
  const calls = { send: [], sessions: [], closed: 0, opened: [], newBots: [] }
  const bots = [
    { id: 'chief', name: 'Chief', role: 'main' },
    { id: 'worker', name: 'Worker', role: 'helper' },
  ]
  const roster = { ready: true, prefs, bots, byId: { chief: bots[0], worker: bots[1] }, roomsById: {}, agents: [] }
  const actions = {
    closeOverlay() { calls.closed += 1 },
    createRoom: async () => ({ id: 'room1' }),
    send: async (id, value) => { calls.send.push([id, value]) },
    openSession: (id) => { calls.sessions.push(id) },
    setFlags: async () => {},
    openNewChat: (next, section) => { calls.opened.push([next, section ?? null]) },
    openNewBot: (payload) => { calls.newBots.push(payload) },
  }
  const view = mount({ mode, sectionId, roster, actions })
  return { view, calls, tree: () => view.render() }
}

test('typing filters the Bot list and Enter opens the first match', async () => {
  const { calls, tree } = pane()
  const view = { tree }
  recipient(view.tree()).props.onChange({ target: { value: 'chi' } })
  const listed = options(view.tree()).filter(node => node.props['data-flip'] === 'chief')
  assert.equal(listed.length, 1)
  assert.match(text(listed[0]), /Chief/)
  const event = enter()
  recipient(view.tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(calls.sessions, ['chief'])
  assert.equal(calls.closed, 1)
})

test('a message typed before picking is sent with the opened Bot', async () => {
  const { calls, tree } = pane()
  textarea(tree()).props.onChange({ target: { value: 'hello there' } })
  const row = options(tree()).find(node => text(node).includes('Chief'))
  assert.ok(row)
  row.props.onClick()
  await tick()
  assert.deepEqual(calls.send, [['chief', 'hello there']])
  assert.deepEqual(calls.sessions, ['chief'])
})

test('the Create group chat entry opens the centred dialog', () => {
  const { calls, tree } = pane()
  const row = options(tree()).find(node => text(node).includes('Create group chat'))
  assert.ok(row)
  row.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls.opened)), [['group', null]], 'no section travels with it')
})

// The pane's message field follows the composer preference: while Enter sends, a plain
// Enter is taken by the send (no newline); off, it stays the field's own newline.
test('the message field follows the Enter-to-send preference', () => {
  const sending = pane({ prefs: { enterToSend: true } })
  const on = enter()
  textarea(sending.tree()).props.onKeyDown(on)
  assert.equal(on.prevented, true)
  for (const extra of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }]) {
    const event = { ...enter(), ...extra }
    textarea(sending.tree()).props.onKeyDown(event)
    assert.equal(event.prevented, false)
  }
  const typing = pane({ prefs: { enterToSend: false } })
  const off = enter()
  textarea(typing.tree()).props.onKeyDown(off)
  assert.equal(off.prevented, false)
})

test('the Create new Bot entry opens the centred dialog', () => {
  const { calls, tree } = pane()
  const row = options(tree()).find(node => text(node).includes('Create new Bot'))
  assert.ok(row)
  row.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls.newBots)), [{ name: '', sectionId: null, brief: '' }])
})

test('the typed name and the drafted message travel into the dialog', () => {
  const { calls, tree } = pane({ sectionId: 'sec-1' })
  recipient(tree()).props.onChange({ target: { value: 'Writer' } })
  textarea(tree()).props.onChange({ target: { value: 'Sum up the launch' } })
  const row = options(tree()).find(node => text(node).includes('Create new Bot “Writer”'))
  assert.ok(row)
  row.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls.newBots)), [{ name: 'Writer', sectionId: 'sec-1', brief: 'Sum up the launch' }])
})

test('Escape closes the pane', () => {
  const { calls, tree } = pane()
  assert.ok(recipient(tree()))
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape' })
  assert.equal(calls.closed, 1)
})
