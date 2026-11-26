import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/learning-card.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function createHarness() {
  const listeners = new Map()
  const addListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  }
  const removeListener = (type, fn) => listeners.get(type)?.delete(fn)
  const dispatch = (type, event) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
  }
  const timers = new Map()
  let nextTimer = 1
  const fakeSetTimeout = (fn) => {
    const id = nextTimer++
    timers.set(id, fn)
    return id
  }
  const fakeClearTimeout = (id) => { timers.delete(id) }
  const flushTimers = () => {
    const pending = [...timers.values()]
    timers.clear()
    for (const fn of pending) fn()
  }

  // Per-component-instance hook store keyed by tree path so nested components
  // (PendingLearning, PendingLearningPanel, ProposalCard, FileBox) keep independent
  // state, refs, and effect lifecycles.
  const instances = new Map()
  let currentInst = null
  let hookIdx = 0
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const pendingEffects = []

  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({}),
    useState(initial) {
      const inst = currentInst
      const i = hookIdx++
      if (!(i in inst.hooks)) inst.hooks[i] = typeof initial === 'function' ? initial() : initial
      return [inst.hooks[i], next => {
        inst.hooks[i] = typeof next === 'function' ? next(inst.hooks[i]) : next
      }]
    },
    useRef(initial) {
      const inst = currentInst
      const i = hookIdx++
      if (!(i in inst.hooks)) inst.hooks[i] = { current: initial }
      return inst.hooks[i]
    },
    useMemo(make, deps) {
      const inst = currentInst
      const i = hookIdx++
      const prev = inst.hooks[i]
      if (prev && sameDeps(prev.deps, deps)) return prev.value
      const value = make()
      inst.hooks[i] = { value, deps }
      return value
    },
    useId() {
      const inst = currentInst
      const i = hookIdx++
      if (!(i in inst.hooks)) inst.hooks[i] = `id-${inst.path}-${i}`
      return inst.hooks[i]
    },
    useEffect(fn, deps) {
      const inst = currentInst
      const i = hookIdx++
      const prev = inst.hooks[i]
      if (!prev || !sameDeps(prev.deps, deps)) {
        pendingEffects.push({ inst, i, fn, deps, prevCleanup: prev?.cleanup })
      }
    },
    useLayoutEffect(fn, deps) { react.useEffect(fn, deps) },
  }

  const fakeDoc = {
    addEventListener: addListener,
    removeEventListener: removeListener,
    documentElement: {},
  }
  const fakeWindow = {
    addEventListener: addListener,
    removeEventListener: removeListener,
    matchMedia: () => ({ matches: false }),
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    document: fakeDoc, window: fakeWindow,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    require: () => react,
  })

  function mount(node, path = 'root', seen = new Set()) {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, idx) => mount(child, `${path}[${idx}]`, seen))
    if (typeof node.type === 'function') {
      const key = node.props?.key !== undefined ? `${path}:${node.type.name}#${node.props.key}` : `${path}:${node.type.name}`
      seen.add(key)
      let inst = instances.get(key)
      if (!inst) {
        inst = { path: key, hooks: [] }
        instances.set(key, inst)
      }
      const prevInst = currentInst
      const prevIdx = hookIdx
      currentInst = inst
      hookIdx = 0
      const out = node.type(node.props ?? {})
      currentInst = prevInst
      hookIdx = prevIdx
      return mount(out, key, seen)
    }
    if (node.props?.ref && typeof node.props.ref === 'object') {
      const refObj = node.props.ref
      if (refObj.current === null) {
        refObj.current = { contains: target => target === refObj.current, querySelector: () => ({ focus() {} }) }
      }
    }
    const children = mount(node.props?.children, `${path}.c`, seen)
    return { ...node, props: { ...node.props, children } }
  }

  function render(element) {
    const seen = new Set()
    const tree = mount(element, 'root', seen)
    for (const [key, inst] of [...instances.entries()]) {
      if (seen.has(key)) continue
      for (const slot of inst.hooks) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      }
      instances.delete(key)
    }
    while (pendingEffects.length > 0) {
      const next = pendingEffects.shift()
      if (typeof next.prevCleanup === 'function') next.prevCleanup()
      const cleanup = next.fn()
      next.inst.hooks[next.i] = { deps: next.deps, cleanup }
    }
    return tree
  }

  return { exports: module.exports, render, dispatch, flushTimers, listeners }
}

function collect(node, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach(child => collect(child, found)); return found }
  found.push(node)
  collect(node.props?.children, found)
  return found
}

const textOf = node => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const skill = { id: 'skill', botId: 'b', name: 'Review', content: 'Run tests', at: 100 }
const agents = { id: 'agents', botId: 'b', kind: 'agents', folder: '/project', edits: [{ op: 'add', text: 'Run lint' }] }

const makeProps = (proposals, sessionId = 'current', actions = { learningAnswer: () => { throw new Error('Opening must not answer') } }, settled = []) => ({
  sessionId,
  useRoster: select => select({
    byId: { current: { id: 'b', sessionId: 'current' }, old: { id: 'b', sessionId: 'current' }, other: { id: 'b2', sessionId: 'other' } },
    learning: { b: proposals, b2: [skill] },
    learningSettled: { b: settled },
  }),
  actions,
})

test('the fixed entry opens, closes on Escape / outside pointerdown / session switch, and cleans up listeners', () => {
  const harness = createHarness()
  const { PendingLearning } = harness.exports
  const props = makeProps([skill, agents])
  const renderOnce = (p = props) => harness.render({ type: PendingLearning, props: p })

  let tree = renderOnce()
  const toggle = collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.match(textOf(toggle), /· 2/)

  // Open the panel.
  toggle.props.onClick()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 2)
  assert.equal(harness.listeners.get('pointerdown')?.size, 1)

  // Clicking outside closes the panel and removes the pointerdown listener.
  harness.dispatch('pointerdown', { target: { outside: true } })
  tree = renderOnce()
  harness.flushTimers()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 0)
  assert.equal(harness.listeners.get('pointerdown')?.size ?? 0, 0)

  // Reopen, then press Escape to close.
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 2)
  harness.dispatch('keydown', { key: 'Escape', defaultPrevented: false, preventDefault() {} })
  tree = renderOnce()
  harness.flushTimers()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 0)

  // Reopen, then switch sessionId: the effect resets open=false and linger unmounts the popover.
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 2)
  tree = renderOnce(makeProps([skill, agents], 'other'))
  tree = renderOnce(makeProps([skill, agents], 'other'))
  harness.flushTimers()
  tree = renderOnce(makeProps([skill, agents], 'other'))
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 0)
})

test('failed answer error in PendingLearningPanel persists across close/reopen and clears once settled', async () => {
  const harness = createHarness()
  const { PendingLearning } = harness.exports
  const actions = { learningAnswer: () => Promise.reject(new Error('AGENTS.md changed since this was proposed')) }
  const renderOnce = (proposals = [agents], settled = []) =>
    harness.render({ type: PendingLearning, props: makeProps(proposals, 'current', actions, settled) })

  let tree = renderOnce()
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce()
  const approve = collect(tree).find(n => n.type === 'button' && n.props?.className?.includes('bt-learning-approve'))
  approve.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = renderOnce()
  assert.match(textOf(collect(tree).find(n => n.props?.role === 'alert')), /AGENTS\.md changed/)

  // Close (unmount panel) and reopen: the remembered error must still appear.
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce()
  harness.flushTimers()
  tree = renderOnce()
  assert.equal(collect(tree).filter(n => n.type === 'section').length, 0)

  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce()
  assert.match(textOf(collect(tree).find(n => n.props?.role === 'alert')), /AGENTS\.md changed/)

  // Once the host settles the proposal, the error entry clears.
  tree = renderOnce([agents], [{ id: 'agents', outcome: 'approved' }])
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce([agents], [{ id: 'agents', outcome: 'approved' }])
  harness.flushTimers()
  tree = renderOnce([agents], [{ id: 'agents', outcome: 'approved' }])
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = renderOnce([agents], [{ id: 'agents', outcome: 'approved' }])
  assert.equal(collect(tree).find(n => n.props?.role === 'alert'), undefined)
})

test('remounted PendingLearning keeps and settles failedAnswers even without local failed state', async () => {
  const harness = createHarness()
  const { PendingLearning } = harness.exports
  const actions = { learningAnswer: () => Promise.reject(new Error('Skill already exists')) }

  // Mount PendingLearning under key "mount-1", trigger failure, then unmount completely
  // (simulating HeaderPill switching to another session and coming back with a fresh key).
  let tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions), key: 'mount-1' } })
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions), key: 'mount-1' } })
  collect(tree).find(n => n.type === 'button' && n.props?.className?.includes('bt-learning-approve')).props.onClick()
  await new Promise(resolve => setImmediate(resolve))

  // Unmount completely, then remount fresh under "mount-2": failure from module map still shows.
  harness.render(null)
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions), key: 'mount-2' } })
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions), key: 'mount-2' } })
  assert.match(textOf(collect(tree).find(n => n.props?.role === 'alert')), /Skill already exists/)

  // Now settle the proposal on the remounted instance (which never had local failed state),
  // close & reopen: the error must be cleared from failedAnswers.
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions, [{ id: 'skill', outcome: 'approved' }]), key: 'mount-2' } })
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions, [{ id: 'skill', outcome: 'approved' }]), key: 'mount-2' } })
  harness.flushTimers()
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions, [{ id: 'skill', outcome: 'approved' }]), key: 'mount-2' } })
  collect(tree).find(n => n.type === 'button' && n.props?.className === 'bt-learning-pending-toggle').props.onClick()
  tree = harness.render({ type: PendingLearning, props: { ...makeProps([skill], 'current', actions, [{ id: 'skill', outcome: 'approved' }]), key: 'mount-2' } })
  assert.equal(collect(tree).find(n => n.props?.role === 'alert'), undefined)
})

test('handling proposals removes each entry, old parts hide current proposals, and empty leaves no space', () => {
  const harness = createHarness()
  const { PendingLearning } = harness.exports
  assert.equal(harness.render({ type: PendingLearning, props: makeProps([skill], 'old') }), null)
  assert.equal(harness.render({ type: PendingLearning, props: makeProps([]) }), null)
})

test('pending panels fit the header column instead of the viewport at every breakpoint', () => {
  const { LEARNING_CSS } = createHarness().exports
  const rule = name => LEARNING_CSS.match(new RegExp(`\\.${name}\\{([^}]+)\\}`))[1]
  assert.match(rule('bt-learning-pending'), /position:static/)
  assert.match(rule('bt-learning-pending'), /min-width:0/)
  assert.match(rule('bt-learning-pending-toggle'), /max-width:100%/)
  assert.match(rule('bt-learning-dot'), /flex:none/)
  const panel = rule('bt-learning-pending-panel')
  assert.match(panel, /position:absolute/)
  assert.match(panel, /left:16px;right:16px/)
  assert.match(panel, /width:auto;max-width:560px;margin:0 auto/)
  assert.doesNotMatch(panel, /vw/)
  assert.doesNotMatch(LEARNING_CSS, /\.bt-learning-pending-panel[^{}]*\{[^}]*position:fixed/)
  assert.match(LEARNING_CSS, /\.bt-learning-pending-panel \.bt-q-head\{flex-wrap:wrap\}/)
  assert.match(LEARNING_CSS, /\.bt-learning-pending-panel \.bt-q-text\{flex-basis:140px\}/)
})
