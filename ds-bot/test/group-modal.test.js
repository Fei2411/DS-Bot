import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The centred Add group chat dialog: the first Bot picked leads the group, two Bots
// make one, and the room carries the admin and a greeting.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/group-modal.js', import.meta.url))],
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
const window = {
  innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }),
  addEventListener: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
  removeEventListener: (name, fn) => { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)) },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`no platform module ${name}`)
  },
  window,
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} }, head: { appendChild() {} }, createElement: () => ({ dataset: {}, style: {}, sheet: null }) },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  localStorage: { getItem: () => null, setItem() {} },
})
const { GroupModal } = module.exports
const mount = (props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = GroupModal(next)
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
const classesOf = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)
const byClass = (node, name) => all(node, child => classesOf(child).includes(name))
const bots = [
  { id: 'rigel', name: 'Rigel' },
  { id: 'pixel', name: 'Pixel' },
  { id: 'lin', name: 'Lin' },
]
const tick = () => new Promise(resolve => setImmediate(resolve))
const setup = () => {
  const calls = { rooms: [], sessions: [], closed: 0 }
  const roster = { bots, byId: { rigel: bots[0], pixel: bots[1], lin: bots[2] } }
  const actions = {
    createRoom: async (ids, options) => { calls.rooms.push([[...ids], options]); return { id: 'room1' } },
    openSession: id => calls.sessions.push(id),
    closeGroupChat: () => { calls.closed += 1 },
  }
  const view = mount({ roster, actions })
  const render = () => view.render()
  const row = name => byClass(render(), 'bt-gm-bot').find(node => text(node).includes(name))
  const pick = async (name) => { row(name).props.onClick(); await tick() }
  const create = async () => { byClass(render(), 'bt-gm-create')[0].props.onClick(); await tick(); await tick() }
  return { calls, render, row, pick, create }
}

test('an empty form disables Create group chat and says why', () => {
  const { render } = setup()
  assert.equal(byClass(render(), 'bt-gm-create')[0].props.disabled, true)
  assert.match(text(byClass(render(), 'bt-gm-reason')[0]), /at least 2 Bots/)
  assert.equal(text(byClass(render(), 'bt-gm-count')[0]), '0 selected')
  assert.equal(byClass(render(), 'bt-gm-select').length, 0, 'the dialog has no session field')
})

test('the first Bot picked leads, the next takes over, and a re-picked Bot joins below', async () => {
  const { row, pick, create, calls } = setup()
  await pick('Rigel')
  assert.match(text(row('Rigel')), /Admin/)
  assert.doesNotMatch(text(row('Pixel')), /Admin/)
  await pick('Pixel')
  assert.match(text(row('Rigel')), /Admin/, 'Rigel stays the lead while picked')
  assert.doesNotMatch(text(row('Pixel')), /Admin/)
  await pick('Rigel')
  assert.match(text(row('Pixel')), /Admin/, 'unpicking the lead hands it to the next Bot')
  assert.doesNotMatch(text(row('Rigel')), /Admin/)
  await pick('Rigel')
  await create()
  assert.deepEqual(calls.rooms[0][0], ['pixel', 'rigel'], 'the re-picked Bot joins as a member')
  assert.equal(calls.rooms[0][1].admin, 'pixel')
})

test('Create group chat sends the members, admin and greeting, then opens the room', async () => {
  const { pick, create, calls } = setup()
  await pick('Rigel')
  await pick('Pixel')
  await create()
  // Options objects are built inside the vm realm, so compare their plain shape.
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rooms)), [[['rigel', 'pixel'], { admin: 'rigel', greet: true }]])
  assert.deepEqual(calls.sessions, ['room1'])
  assert.equal(calls.closed, 1)
})

test('a typed name travels with the room, and no section is sent', async () => {
  const { render, pick, create, calls } = setup()
  byClass(render(), 'bt-gm-input')[0].props.onChange({ target: { value: 'Website launch' } })
  await pick('Rigel')
  await pick('Pixel')
  await create()
  const options = calls.rooms[0][1]
  assert.equal('sectionId' in options, false)
  assert.equal(options.name, 'Website launch')
})

test('one Bot picked keeps Create group chat disabled and asks for one more member', async () => {
  const { render, pick } = setup()
  await pick('Rigel')
  assert.equal(byClass(render(), 'bt-gm-create')[0].props.disabled, true)
  assert.match(text(byClass(render(), 'bt-gm-reason')[0]), /1 more member/)
  assert.equal(text(byClass(render(), 'bt-gm-count')[0]), '1 selected')
})

test('Escape closes the dialog, and it is a labelled modal with the name field focused', () => {
  const { calls, render } = setup()
  const dialog = all(render(), node => node.props?.role === 'dialog')[0]
  assert.ok(dialog)
  assert.equal(dialog.props['aria-modal'], true)
  assert.equal(dialog.props['aria-labelledby'], 'bt-gm-title')
  assert.equal(byClass(render(), 'bt-gm-input')[0].props.autoFocus, true)
  assert.equal(text(all(render(), node => node.type === 'h2')[0]), 'Add group chat')
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape' })
  assert.equal(calls.closed, 1)
})

test('closing while the room is being made does not pull the reader into it', async () => {
  const calls = { sessions: [], closed: 0 }
  let release
  const roster = { bots, byId: { rigel: bots[0], pixel: bots[1], lin: bots[2] } }
  const actions = {
    createRoom: () => new Promise((resolve) => { release = () => resolve({ id: 'room1' }) }),
    openSession: id => calls.sessions.push(id),
    closeGroupChat: () => { calls.closed += 1 },
  }
  const view = mount({ roster, actions })
  const render = () => view.render()
  const pick = async (name) => { byClass(render(), 'bt-gm-bot').find(node => text(node).includes(name)).props.onClick(); await tick() }
  await pick('Rigel')
  await pick('Pixel')
  byClass(render(), 'bt-gm-create')[0].props.onClick()
  await tick()
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape' })
  assert.equal(calls.closed, 1)
  release()
  await tick()
  await tick()
  assert.deepEqual(calls.sessions, [], 'a closed dialog leaves the current view alone')
})
