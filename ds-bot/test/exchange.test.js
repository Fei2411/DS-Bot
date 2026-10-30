import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/exchange.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const messages = count => Array.from({ length: count }, (_, i) => ({ id: String(i), from: 'a', time: i + 1, text: `Message ${i + 1}` }))

function rig(initial) {
  const slots = []
  const timers = new Map()
  let at = 0
  let dirty = true
  let tree
  let next = initial
  let timer = 0
  let height = 200
  let top = 0
  let layouts = []
  let effects = []
  // Like a browser, clamp a scroll write to the content's actual range. Layout
  // effects run after the rendered message rows have changed that range.
  const scroller = {
    clientHeight: 200,
    get scrollHeight() { return height },
    get scrollTop() { return top },
    set scrollTop(value) { top = Math.max(0, Math.min(value, height - this.clientHeight)) },
  }
  const effect = (queue, run, deps) => {
    const i = at++
    const previous = slots[i]
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
      queue.push(() => {
        previous?.cleanup?.()
        slots[i] = { deps, cleanup: run() }
      })
    }
  }
  const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useRef: (current) => { const i = at++; return slots[i] ??= { current } },
    useState: (initialValue) => {
      const i = at++
      if (!(i in slots)) slots[i] = initialValue
      return [slots[i], (value) => { if (slots[i] !== value) { slots[i] = value; dirty = true } }]
    },
    useEffect: (run, deps) => effect(effects, run, deps),
    useLayoutEffect: (run, deps) => effect(layouts, run, deps),
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    document: { hidden: false, querySelector: () => null },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (run) => { timers.set(++timer, run); return timer },
    clearTimeout: id => timers.delete(id),
  })
  const props = { pair: ['a', 'b'], roster: { byId: {} }, actions: { exchange: () => next, closeOverlay() {} } }
  const render = () => {
    while (dirty) {
      dirty = false
      at = 0
      layouts = []
      effects = []
      tree = module.exports.ExchangeDialog(props)
      height = 200 + find(tree, node => node.props.className === 'bt-group-msg').length * 80
      const log = find(tree, node => node.props.role === 'log')[0]
      if (log.props.ref) log.props.ref.current = scroller
      layouts.forEach(run => run())
      effects.forEach(run => run())
    }
  }
  const settle = async () => { await setImmediate(); render() }
  render()
  return {
    scroller, settle,
    scroll: (value) => {
      scroller.scrollTop = value
      find(tree, node => node.props.role === 'log')[0].props.onScroll?.({ currentTarget: scroller })
    },
    poll: async (value) => {
      next = value
      const [id, run] = timers.entries().next().value
      timers.delete(id)
      await run()
      render()
    },
    changePair: (pair, value) => { props.pair = pair; next = value; dirty = true; render() },
  }
}

test('opening an exchange shows its latest message after the transcript loads', async () => {
  let resolve
  const r = rig(new Promise(done => { resolve = done }))
  assert.equal(r.scroller.scrollTop, 0)
  resolve(messages(20))
  await r.settle()
  assert.ok(r.scroller.scrollHeight > r.scroller.clientHeight)
  assert.equal(r.scroller.scrollTop, r.scroller.scrollHeight - r.scroller.clientHeight)
})

test('new exchange messages follow the end, but do not take the reader away from earlier messages', async () => {
  const r = rig(messages(20))
  await r.settle()
  await r.poll(messages(21))
  assert.equal(r.scroller.scrollTop, r.scroller.scrollHeight - r.scroller.clientHeight)
  r.scroll(200)
  await r.poll(messages(22))
  assert.equal(r.scroller.scrollTop, 200)
  r.scroll(r.scroller.scrollHeight)
  await r.poll(messages(23))
  assert.equal(r.scroller.scrollTop, r.scroller.scrollHeight - r.scroller.clientHeight)
})

test('another pair starts at its latest message even after reading an earlier exchange', async () => {
  const r = rig(messages(20))
  await r.settle()
  r.scroll(100)
  r.changePair(['a', 'c'], messages(10))
  await r.settle()
  assert.equal(r.scroller.scrollTop, r.scroller.scrollHeight - r.scroller.clientHeight)
})

test('an empty exchange follows its first message when it arrives', async () => {
  const r = rig([])
  await r.settle()
  await r.poll(messages(1))
  assert.equal(r.scroller.scrollTop, r.scroller.scrollHeight - r.scroller.clientHeight)
})
