import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A small hook runtime: a component renders again whenever its state changes, so a test
// can press a key, resolve a save, or hand it new props, and read the tree that results.
let instance = null
const slot = () => instance.slots[instance.cursor++] ??= {}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) {
    const own = instance
    const entry = slot()
    if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial
    return [entry.value, (next) => {
      const value = typeof next === 'function' ? next(entry.value) : next
      if (Object.is(value, entry.value)) return
      entry.value = value
      own.update()
    }]
  },
  useRef(initial) {
    const entry = slot()
    entry.ref ??= { current: initial }
    return entry.ref
  },
  useEffect(run, deps) {
    const entry = slot()
    if (entry.deps && deps && deps.every((dep, index) => Object.is(dep, entry.deps[index]))) return
    entry.deps = deps
    instance.effects.push(() => { entry.cleanup?.(); entry.cleanup = run() })
  },
  useMemo: make => make(),
  useCallback: fn => fn,
}
react.useLayoutEffect = react.useEffect

function mount(Component, firstProps) {
  const self = {
    props: firstProps, slots: [], cursor: 0, effects: [], tree: null, busy: false, again: false,
    update() {
      if (self.busy) { self.again = true; return }
      self.busy = true
      do {
        self.again = false
        instance = self
        self.cursor = 0
        self.effects = []
        try { self.tree = Component(self.props) } finally { instance = null }
        for (const effect of self.effects) effect()
      } while (self.again)
      self.busy = false
    },
  }
  self.update()
  return {
    get tree() { return self.tree },
    rerender(props) { self.props = props; self.update() },
  }
}

const listeners = []
const sandbox = {
  window: {
    addEventListener: (name, fn, capture) => listeners.push({ name, fn, capture }),
    removeEventListener: (name, fn) => { const at = listeners.findIndex(entry => entry.name === name && entry.fn === fn); if (at >= 0) listeners.splice(at, 1) },
    matchMedia: () => ({ matches: false }),
  },
  document: { activeElement: null },
  setTimeout, clearTimeout,
}
const bundle = await build({
  stdin: {
    contents: "export * from './src/client/model-menu.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  ...sandbox,
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
})
const { ModelMenu, EffortBar } = module.exports

const nodes = (tree, match) => (!tree || typeof tree !== 'object' ? [] : [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))])
const settle = () => new Promise(done => setImmediate(done))
const keydown = key => ({ key, preventDefault() {}, stopPropagation() {} })
const listener = name => listeners.findLast(entry => entry.name === name)?.fn

const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
const thinking = { efforts, defaultEffort: 'high' }

test('a save still under way keeps the slider on the newest pick', async () => {
  const saves = []
  const picked = []
  const onPick = (effort) => { picked.push(effort); return new Promise(resolve => saves.push(resolve)) }
  const bar = mount(EffortBar, { reasoning: thinking, current: 'high', onPick })
  const slider = () => nodes(bar.tree, node => node.props.role === 'slider')[0]
  const shown = () => slider().props['aria-valuetext']

  slider().props.onKeyDown(keydown('ArrowLeft'))
  assert.equal(shown(), 'Low')
  // The Bot still holds High. Low is already on its way, so High has to follow it —
  // once Low settles, not beside it — or the older write would land last and win.
  slider().props.onKeyDown(keydown('ArrowRight'))
  assert.equal(shown(), 'High')
  assert.deepEqual(picked, ['low'])

  // The Bot reports the first save while High is still the pick: the knob stays.
  bar.rerender({ reasoning: thinking, current: 'low', onPick })
  assert.equal(shown(), 'High')
  saves[0](true)
  await settle()
  assert.deepEqual(picked, ['low', 'high'])
  assert.equal(shown(), 'High')
  bar.rerender({ reasoning: thinking, current: 'high', onPick })
  saves[1](true)
  await settle()
  assert.equal(shown(), 'High')
})

test('the slider returns to the Bot\'s level when its save fails, and a pick that changes nothing sends nothing', async () => {
  const saves = []
  const picked = []
  const onPick = (effort) => { picked.push(effort); return new Promise(resolve => saves.push(resolve)) }
  const bar = mount(EffortBar, { reasoning: thinking, current: 'high', onPick })
  const slider = () => nodes(bar.tree, node => node.props.role === 'slider')[0]

  slider().props.onKeyDown(keydown('ArrowRight'))
  assert.deepEqual(picked, [])
  slider().props.onKeyDown(keydown('ArrowLeft'))
  assert.equal(slider().props['aria-valuetext'], 'Low')
  saves[0](false)
  await settle()
  assert.equal(slider().props['aria-valuetext'], 'High')
})

test('rapid effort picks collapse onto the latest level and save in order', async () => {
  const reasoning = {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
    defaultEffort: 'low',
  }
  const saves = []
  const picked = []
  let active = 0
  let maxActive = 0
  const onPick = (effort) => {
    picked.push(effort)
    active += 1
    maxActive = Math.max(maxActive, active)
    return new Promise((resolve) => { saves.push((ok) => { active -= 1; resolve(ok) }) })
  }
  const bar = mount(EffortBar, { reasoning, current: 'low', onPick })
  const slider = () => nodes(bar.tree, node => node.props.role === 'slider')[0]
  const shown = () => slider().props['aria-valuetext']

  // Low -> Medium -> High -> Medium -> High before the first save returns.
  // Medium is the write in flight; the rest collapse into one pending High.
  slider().props.onKeyDown(keydown('ArrowRight'))
  slider().props.onKeyDown(keydown('ArrowRight'))
  slider().props.onKeyDown(keydown('ArrowLeft'))
  slider().props.onKeyDown(keydown('ArrowRight'))
  assert.equal(shown(), 'High')
  assert.deepEqual(picked, ['medium'])
  assert.equal(active, 1)

  // The in-flight save's own roster update is not the level the user landed on.
  bar.rerender({ reasoning, current: 'medium', onPick })
  assert.equal(shown(), 'High')
  saves[0](true)
  await settle()
  assert.deepEqual(picked, ['medium', 'high'])
  assert.equal(maxActive, 1)
  assert.equal(shown(), 'High')

  // An older roster value, arriving while the coalesced save is out, stays off the knob.
  bar.rerender({ reasoning, current: 'low', onPick })
  assert.equal(shown(), 'High')
  saves[1](true)
  await settle()
  assert.equal(shown(), 'High')
  assert.equal(active, 0)

  // Once the queue is idle, a late intermediate update still loses to the last pick.
  bar.rerender({ reasoning, current: 'medium', onPick })
  assert.equal(shown(), 'High')
  bar.rerender({ reasoning, current: 'high', onPick })
  assert.equal(shown(), 'High')
})

// The details panel's form: refs get stand-ins, since no DOM backs them.
function inline({ model = 'official/flash', effort, actions = {}, withEfforts } = {}) {
  listeners.length = 0
  const calls = { updates: [], refreshed: 0, focused: 0 }
  const roster = {
    ready: true,
    defaultModel: 'official/flash',
    models: [
      { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash', reasoning: thinking },
      { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro', reasoning: thinking },
      { ref: 'plain/chat', provider: 'plain', providerName: 'Plain', name: 'Chat', reasoning: { efforts: [] } },
    ],
  }
  const bot = { id: 'writer', name: 'Writer', model, effort }
  const element = ModelMenu({
    bot, roster, wide: true, inline: true, withEfforts,
    run: promise => Promise.resolve(promise).then(() => true),
    actions: {
      updateBot: (id, patch) => { calls.updates.push([id, patch]); return Promise.resolve() },
      refreshModels: () => { calls.refreshed += 1 },
      openSettings: () => {},
      ...actions,
    },
  })
  const menu = mount(element.type, element.props)
  const attach = () => {
    for (const node of nodes(menu.tree, entry => entry.props.ref)) {
      if (node.props.className === 'bt-model-inline') node.props.ref.current = { contains: target => target === 'inside' }
      if (node.props.className === 'bt-model-trigger') node.props.ref.current = { focus: () => { calls.focused += 1 } }
    }
  }
  attach()
  const view = () => {
    const [trigger, list, slider] = menu.tree.children
    return { trigger, list, slider, root: menu.tree }
  }
  return { menu, calls, view, attach }
}

test('the slider sits under the model trigger and under the list once it opens', () => {
  const { view, calls, attach } = inline()
  let { root, trigger, list, slider } = view()
  assert.equal(root.props.className, 'bt-model-inline')
  assert.equal(trigger.props.className, 'bt-model-trigger')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(list.props.open, false)
  assert.equal(slider.props.open, true)
  assert.equal(nodes(slider, node => node.type === EffortBar).length, 1)
  // Trigger first, list next, slider last: the order they stack in.
  assert.deepEqual(root.children.map(child => child.type === 'button' ? 'trigger' : child === list ? 'list' : 'slider'), ['trigger', 'list', 'slider'])

  trigger.props.onClick()
  attach()
  ;({ root, trigger, list, slider } = view())
  assert.equal(trigger.props['aria-expanded'], true)
  assert.equal(list.props.open, true)
  assert.equal(nodes(list, node => node.props.role === 'menu').length, 1)
  assert.equal(slider.props.open, true)
  assert.equal(nodes(slider, node => node.type === EffortBar).length, 1)
  assert.deepEqual(root.children.map(child => child.type === 'button' ? 'trigger' : child === list ? 'list' : 'slider'), ['trigger', 'list', 'slider'])
  assert.equal(calls.refreshed, 1)
})

test('a model without thinking levels shows no slider, and neither does a pick that takes none', () => {
  const plain = inline({ model: 'plain/chat' }).view()
  assert.equal(plain.slider.props.open, false)
  assert.equal(nodes(plain.slider, node => node.type === EffortBar).length, 0)
  const without = inline({ withEfforts: false }).view()
  assert.equal(without.slider.props.open, false)
  assert.equal(nodes(without.slider, node => node.type === EffortBar).length, 0)
})

test('dragging or keying the slider saves the level at once, and Default clears it', async () => {
  const { view, calls } = inline({ effort: 'low' })
  const bar = () => nodes(view().slider, node => node.type === EffortBar)[0]
  assert.equal(bar().props.current, 'low')
  const saved = bar().props.onPick('high')
  assert.equal(await saved, true)
  await bar().props.onPick(undefined)
  assert.equal(JSON.stringify(calls.updates), JSON.stringify([['writer', { effort: 'high' }], ['writer', { effort: null }]]))
})

test('picking a model closes the list, saves it, and returns focus to the trigger', () => {
  const { view, calls, attach } = inline()
  view().trigger.props.onClick()
  attach()
  const rows = nodes(view().list, node => node.props.onPick)[0]
  rows.props.onPick('official/pro')
  attach()
  assert.equal(view().list.props.open, false)
  assert.equal(view().trigger.props['aria-expanded'], false)
  assert.equal(calls.focused, 1)
  assert.equal(JSON.stringify(calls.updates), JSON.stringify([['writer', { model: 'official/pro' }]]))
  // The slider stays where it was.
  assert.equal(view().slider.props.open, true)
})

test('Escape and a click outside close the list; a click inside leaves it open', () => {
  const { view, calls, attach } = inline()
  view().trigger.props.onClick()
  attach()
  listener('mousedown')({ target: 'inside' })
  assert.equal(view().list.props.open, true)
  listener('mousedown')({ target: 'outside' })
  assert.equal(view().list.props.open, false)
  assert.equal(listener('keydown'), undefined)

  view().trigger.props.onClick()
  attach()
  let stopped = false
  listener('keydown')({ key: 'Escape', stopPropagation: () => { stopped = true }, preventDefault() {} })
  assert.equal(view().list.props.open, false)
  assert.equal(stopped, true)
  assert.equal(calls.focused, 1)
  // Closing took its listeners with it.
  assert.equal(listener('mousedown'), undefined)
})

test('a menu that is not inline stays a popup with no slider under its trigger', () => {
  const element = ModelMenu({
    bot: { id: 'writer', name: 'Writer', model: 'official/flash' },
    roster: { models: [{ ref: 'official/flash', provider: 'official', name: 'DeepSeek Flash', reasoning: thinking }] },
    actions: {}, run: () => {},
  })
  const popup = mount(element.type, element.props)
  assert.equal(nodes(popup.tree, node => node.props.className === 'bt-model-inline').length, 0)
  assert.equal(nodes(popup.tree, node => node.type === EffortBar).length, 0)
  assert.equal(nodes(popup.tree, node => node.props.className === 'bt-model-trigger').length, 1)
})
