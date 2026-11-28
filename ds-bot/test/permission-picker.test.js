import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/permission-picker.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// A minimal stateful React: hook cells live across renders and a setState re-renders,
// so the picker's menu and async pick flow run as on the page. Effects run when their
// deps change, as React runs them after paint.
const cells = []
const prevDeps = []
let hook = 0
let dirty = false
let pendingEffects = []
const changed = (deps, prev) => deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((dep, i) => !Object.is(dep, prev[i]))
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(Boolean) } }),
  useState(initial) {
    const i = hook++
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
    return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; dirty = true }]
  },
  useRef(initial) { const i = hook++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
  useEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useLayoutEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useMemo: make => make(),
  useId: () => 'id',
  Fragment: Symbol('Fragment'),
}
const reactDom = {
  createPortal: (node) => node,
}
const fakeWindow = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
const fakeDocument = {
  body: {},
  addEventListener() {},
  removeEventListener() {},
}
const fakeTrigger = {
  focus() {},
  contains: () => false,
  getBoundingClientRect: () => ({ left: 800, right: 1088, top: 200, bottom: 234, width: 288, height: 34 }),
}
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.props?.children ?? []) walk(child, visit)
}
const findAll = (tree, match) => {
  const out = []
  walk(tree, node => { if (match(node)) out.push(node) })
  return out
}
const render = (component, props) => {
  let tree
  do {
    dirty = false
    hook = 0
    pendingEffects = []
    tree = component(props)
    // Attach the trigger ref before layout effects run so `useAnchoredMenu` can measure it.
    walk(tree, node => {
      if (node.type === 'button' && node.props?.['aria-haspopup'] === 'menu' && node.props.ref) {
        node.props.ref.current = fakeTrigger
      }
    })
    for (const { i, fn, deps } of pendingEffects) {
      if (changed(deps, prevDeps[i])) { prevDeps[i] = deps; fn() }
    }
  } while (dirty)
  return tree
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: fakeWindow, document: fakeDocument, setTimeout, clearTimeout,
  require: name => (name === 'react' ? react : name === 'react-dom' ? reactDom : {}),
})
const { PermissionPicker, orderedPermissionOptions } = module.exports

const OPTIONS = [
  { value: 'read-only', description: 'read-only' },
  { value: 'workspace-write', description: 'workspace-write' },
  { value: 'danger-full-access', description: 'danger-full-access' },
  { value: 'review', description: 'review' },
]
const settle = () => new Promise(resolve => setImmediate(resolve))

// Mounts the picker on `props`; `requests` gets a deferred per `onPick` call, and
// `maxFlying` records the most requests open at once.
const mountPicker = (initial, repick = false) => {
  cells.length = 0
  prevDeps.length = 0
  const requests = []
  let flying = 0
  const seen = { maxFlying: 0 }
  let props = { ...initial, repick }
  props.onPick = value => {
    flying += 1
    seen.maxFlying = Math.max(seen.maxFlying, flying)
    return new Promise((resolve, reject) => requests.push({
      value,
      resolve: (done) => { flying -= 1; resolve(done) },
      reject: (error) => { flying -= 1; reject(error) },
    }))
  }
  let tree
  const rerender = (patch) => { props = { ...props, ...patch }; tree = render(PermissionPicker, props); return tree }
  const trigger = () => findAll(tree, node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')[0]
  const items = () => findAll(tree, node => node.type === 'button' && node.props?.role === 'menuitemradio')
  const openMenu = () => {
    if (trigger().props['aria-expanded']) return
    trigger().props.onClick()
    rerender()
  }
  const picker = {
    requests, seen, rerender, trigger, items, openMenu,
    press(value) {
      openMenu()
      const option = items().find(button => button.props['data-value'] === value)
      assert.ok(option, `option ${value} should render in the menu`)
      option.props.onClick()
      rerender()
    },
    pressed() {
      openMenu()
      return items().find(button => button.props['aria-checked'])?.props['data-value']
    },
    // Lets settled request continuations and their state updates land.
    async flush() { await settle(); rerender() },
  }
  rerender()
  return picker
}

test('danger presets sit after non-danger presets with a separator in the menu', () => {
  const { safe, danger } = orderedPermissionOptions(OPTIONS)
  assert.deepEqual(Array.from(safe, option => option.value), ['read-only', 'workspace-write', 'review'])
  assert.deepEqual(Array.from(danger, option => option.value), ['danger-full-access'])
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'workspace-write' })
  picker.openMenu()
  assert.deepEqual(picker.items().map(button => button.props['data-value']), ['read-only', 'workspace-write', 'review', 'danger-full-access'])
  const seps = findAll(picker.rerender(), node => node.props?.role === 'separator')
  assert.equal(seps.length, 1)
  assert.equal(picker.trigger().props['data-danger'], undefined)
})

test('trigger marks danger only when a danger preset is active', () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'danger-full-access' })
  assert.equal(picker.trigger().props['data-danger'], true)
})

// #266: one save in flight; the latest pick wins, a failed request cannot clear it.
test('a newer pick survives an older request failing', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  assert.equal(picker.requests.length, 1)
  assert.equal(picker.pressed(), 'danger-full-access')
  picker.requests[0].resolve(false)
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  assert.equal(picker.requests[1].value, 'danger-full-access')
  assert.equal(picker.pressed(), 'danger-full-access')
  picker.requests[1].resolve(true)
  picker.rerender({ saved: 'danger-full-access' })
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  assert.equal(picker.pressed(), 'danger-full-access')
  assert.equal(picker.seen.maxFlying, 1)
})

test('a newer pick that fails falls back to what the server saved', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  picker.requests[0].resolve(true)
  picker.rerender({ saved: 'workspace-write' })
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  picker.requests[1].resolve(false)
  await picker.flush()
  assert.equal(picker.pressed(), 'workspace-write')
  assert.equal(picker.seen.maxFlying, 1)
})

test('a single failed pick falls back to the saved value', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  assert.equal(picker.pressed(), 'workspace-write')
  picker.requests[0].resolve(false)
  await picker.flush()
  assert.equal(picker.pressed(), 'read-only')
  // A rejected request fails the same way.
  picker.press('workspace-write')
  assert.equal(picker.requests.length, 2)
  picker.requests[1].reject(new Error('offline'))
  await picker.flush()
  assert.equal(picker.pressed(), 'read-only')
})

test('the last remembered pick wins; it is sent once even when it repeats the sent one', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  picker.press('workspace-write')
  assert.equal(picker.requests.length, 1)
  picker.requests[0].resolve(true)
  picker.rerender({ saved: 'workspace-write' })
  await picker.flush()
  assert.equal(picker.requests.length, 1, 'the pick that repeats the sent one is not sent again')
  assert.equal(picker.pressed(), 'workspace-write')
})

test('review uses the same single choice and save queue as ordinary permissions', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'danger-full-access' })
  picker.press('review')
  assert.equal(picker.pressed(), 'review')
  assert.equal(picker.requests[0].value, 'review')
  picker.press('read-only')
  assert.equal(picker.pressed(), 'read-only')
  picker.requests[0].resolve(true)
  await picker.flush()
  assert.equal(picker.requests[1].value, 'read-only')
  picker.requests[1].resolve(true)
  picker.rerender({ saved: 'read-only' })
  await picker.flush()
  picker.openMenu()
  assert.equal(picker.items().filter(button => button.props['aria-checked']).length, 1)
})

test('repick still lets the shown preset be picked again', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' }, true)
  picker.press('read-only')
  assert.equal(picker.requests.length, 1)
  assert.equal(picker.requests[0].value, 'read-only')
  picker.requests[0].resolve(true)
  await picker.flush()
})
