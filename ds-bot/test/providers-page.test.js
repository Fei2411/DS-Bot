import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Models page's provider row, with a stateful little React so the refresh draft,
// its checkboxes and Save/Cancel run as they do on the page.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/providers-page.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
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
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
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
const render = (component, props) => {
  let tree
  do {
    dirty = false
    hook = 0
    pendingEffects = []
    tree = component(props)
    for (const { i, fn, deps } of pendingEffects) {
      if (changed(deps, prevDeps[i])) { prevDeps[i] = deps; fn() }
    }
  } while (dirty)
  return tree
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
})
const { ProviderRow } = module.exports
const settle = () => new Promise(resolve => setImmediate(resolve))

// ModelDraft is a plain function without hooks; expand it so its buttons are visible
// without running the whole React hook tree a second time.
const expandDraft = (node) => {
  if (Array.isArray(node)) return node.flatMap(expandDraft)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function' && node.type.name === 'ModelDraft') return expandDraft(node.type(node.props))
  return { ...node, props: { ...node.props, children: expandDraft(node.props?.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}
const buttons = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) buttons(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'button') out.push(node)
  buttons(node.props?.children, out)
  return out
}
const ui = tree => expandDraft(tree)
const button = (tree, label) => buttons(tree).find(node => textOf(node) === label)
const provider = () => ({
  id: 'relay', name: 'Relay', refreshable: true, removable: true,
  key: { configured: true, writable: true },
  models: [{ id: 'a', ref: 'relay/a', name: 'A' }, { id: 'manual', ref: 'relay/manual', name: 'Manual' }],
  declaredModels: [{ id: 'a', ref: 'relay/a', name: 'A' }, { id: 'manual', ref: 'relay/manual', name: 'Manual' }],
})
const actions = () => ({
  providerModels: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  saveProviderModels: async () => ({ providers: [] }),
  refreshModels() {},
  removeProvider: async () => ({ providers: [] }),
  setProviderKey: async () => ({ providers: [] }),
})
const row = (props = {}) => {
  const calls = { save: [], refresh: 0, error: undefined }
  const acts = actions()
  acts.saveProviderModels = async (body) => { calls.save.push(body); return { providers: [] } }
  acts.refreshModels = () => { calls.refresh += 1 }
  const tree = render(ProviderRow, {
    provider: provider(), apply: promise => Promise.resolve(promise).then(() => true, (error) => { calls.error = error; return false }),
    actions: acts, roster: { bots: [{ id: 'b1', name: 'Writer', model: 'relay/manual', appliedModel: 'relay/manual' }] },
    revision: 4, open: true, onToggle() {}, ...props,
  })
  return { tree, calls, acts, rerender: (patch) => render(ProviderRow, {
    provider: provider(), apply: promise => Promise.resolve(promise).then(() => true, (error) => { calls.error = error; return false }),
    actions: acts, roster: { bots: [{ id: 'b1', name: 'Writer', model: 'relay/manual', appliedModel: 'relay/manual' }] },
    revision: 4, open: true, onToggle() {}, ...props, ...patch,
  }) }
}

test('refresh shows a draft: endpoint models selected, unreturned ones kept only if picked, used removals called out', async () => {
  const view = row()
  button(ui(view.tree), 'Refresh models').props.onClick()
  await settle(); await settle()
  view.tree = view.rerender()
  assert.ok(button(ui(view.tree), 'a'))
  assert.ok(button(ui(view.tree), 'b'))
  assert.ok(button(ui(view.tree), 'manual'))
  assert.match(textOf(ui(view.tree)), /1 added · 0 removed/)
  assert.equal(button(ui(view.tree), 'manual').props['aria-pressed'], true)
})

test('removing a model a Bot uses needs a second Save', async () => {
  const view = row()
  button(ui(view.tree), 'Refresh models').props.onClick()
  await settle(); await settle()
  view.tree = view.rerender()
  button(ui(view.tree), 'manual').props.onClick()
  view.tree = view.rerender()
  assert.match(textOf(ui(view.tree)), /1 added · 1 removed/)
  button(ui(view.tree), 'Save').props.onClick()
  view.tree = view.rerender()
  assert.deepEqual(view.calls.save, [])
  assert.ok(button(ui(view.tree), 'Save anyway'))
  assert.match(textOf(ui(view.tree)), /Used by Writer/)
  button(ui(view.tree), 'Save anyway').props.onClick()
  await settle(); await settle()
  assert.equal(view.calls.save.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.save[0].models)), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
})

test('cancel leaves the saved list alone and sends no save', async () => {
  const view = row()
  button(ui(view.tree), 'Refresh models').props.onClick()
  await settle(); await settle()
  view.tree = view.rerender()
  button(ui(view.tree), 'Cancel').props.onClick()
  view.tree = view.rerender()
  assert.equal(button(ui(view.tree), 'Cancel'), undefined)
  assert.deepEqual(view.calls.save, [])
})

test('picking an unreturned id keeps it in the saved list', async () => {
  const view = row()
  button(ui(view.tree), 'Refresh models').props.onClick()
  await settle(); await settle()
  view.tree = view.rerender()
  assert.equal(button(ui(view.tree), 'manual').props['aria-pressed'], true)
  assert.match(textOf(ui(view.tree)), /1 added · 0 removed/)
  button(ui(view.tree), 'Save').props.onClick()
  await settle(); await settle()
  assert.equal(view.calls.save.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.save[0])), {
    provider: 'relay', revision: 4,
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'manual' }],
  })
  assert.equal(view.calls.refresh, 1)
})

test('a discovery failure keeps the saved models and shows the error', async () => {
  const view = row()
  view.acts.providerModels = async () => { throw new Error('the endpoint answered 401') }
  button(ui(view.tree), 'Refresh models').props.onClick()
  await settle(); await settle()
  view.tree = view.rerender()
  assert.match(textOf(ui(view.tree)), /the endpoint answered 401/)
  assert.equal(button(ui(view.tree), 'Cancel'), undefined)
})
