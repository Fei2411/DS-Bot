import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// The Runs on card, bundled once and rendered with a small React stand-in: hooks are
// numbered by expansion order and a state setter re-expands the tree, so a click on
// "Change" opens the card the way the real component does.
const { outputFiles } = await build({
  stdin: { contents: "export { RunModeCard } from './src/client/agent-cards.js'", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const rerender = () => { idx = 0; concrete = expand(module.exports.RunModeCard(props)) }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...p, children: children.flat(Infinity) } }),
  Fragment: 'fragment',
  useCallback: fn => fn,
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(),
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useRef: (current) => { const i = idx++; if (!(i in slots)) slots[i] = { current }; return slots[i] },
  useId: () => `id${idx++}`,
  useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const walk = (node, found = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
const Card = ({ title, children }) => ({ type: 'section', props: { title, children } })
const roster = (defaultModel) => ({
  models: [{ provider: 'ds', providerName: 'DS', ref: 'ds/flash', name: 'Flash' }, { provider: 'ds', providerName: 'DS', ref: 'ds/pro', name: 'Pro' }],
  defaultModel,
  prefs: {},
  rooms: [],
})
const render = (bot, defaultModel) => {
  props = { bot, roster: roster(defaultModel), actions: { updateBot: async () => true }, run: fn => fn, Card }
  slots.length = 0
  rerender()
  return walk(concrete)
}

// Opening the card on a DS Bot model Bot starts on the Local agent side, so a model
// change is made from the "DS Bot model" segment. State setters re-render the tree.
const openModelSide = (bot, defaultModel) => {
  let tree = render(bot, defaultModel)
  tree.find(node => node.props?.className === 'bt-soft bt-soft-sm' && node.props?.['aria-expanded'] === false).props.onClick()
  tree = walk(concrete)
  const segment = tree.find(node => node.props?.onClick && [node.props?.children].flat(Infinity).includes('DS Bot model'))
  assert.ok(segment, 'the DS Bot model segment is on screen')
  segment.props.onClick()
  return walk(concrete)
}

test('a DS Bot model Bot that picks another model shows the confirmation', () => {
  const tree = openModelSide({ id: 'b', name: 'Writer', model: 'ds/flash', appliedModel: 'ds/flash' }, 'ds/pro')
  assert.ok(tree.find(node => node.props?.className === 'bt-runmode-confirm'), 'the confirmation block is rendered')
  assert.ok(tree.some(node => node.props?.className === 'bt-send' && [node.props?.children].flat(Infinity).includes('Change and start a new part')))
})

test('the same model on a DS Bot model Bot shows no confirmation', () => {
  const tree = openModelSide({ id: 'b', name: 'Writer', model: 'ds/flash', appliedModel: 'ds/flash' }, 'ds/flash')
  assert.equal(tree.some(node => node.props?.className === 'bt-runmode-confirm'), false)
})
