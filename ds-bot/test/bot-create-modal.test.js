import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Create Bot form opens in the Add group chat dialog's shell: a centred card
// with a fixed head and foot, the form itself scrolling between them.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
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
const rerender = () => { idx = 0; concrete = expand(module.exports.CreateBot(props)) }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...p, children } }),
  Fragment: 'fragment',
  useCallback: fn => fn,
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const button = text => collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
const render = (roster, overrides = {}) => {
  slots.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {}, ...overrides }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens as the centred dialog with its own footer', () => {
  render({ models: MODELS })
  assert.equal(collect(n => n.props?.className === 'bt-gm-layer').length, 1)
  assert.equal(collect(n => n.props?.className === 'bt-scrim bt-gm-scrim').length, 1)
  const card = collect(n => n.props?.className === 'bt-gm bt-bm')[0]
  assert.equal(card.props.role, 'dialog')
  assert.equal(card.props['aria-modal'], true)
  const title = collect(n => n.type === 'h2')[0]
  assert.equal(title.props.id, card.props['aria-labelledby'])
  assert.equal(flatten(title).join(''), 'Create Bot')
  assert.equal(collect(n => n.props?.className === 'bt-gm-body bt-bm-body').length, 1)
  assert.equal(collect(n => n.props?.className === 'bt-gm-foot').length, 1)
  assert.equal(button('Create Bot').props.className, 'bt-gm-create')
  assert.equal(button('Cancel'), undefined, 'a dialog has one footer button')
})

test('the close button and the scrim close the dialog', () => {
  let closed = 0
  render({ models: MODELS }, { onBack: () => { closed += 1 } })
  collect(n => n.props?.['aria-label'] === 'Close')[0].props.onClick()
  collect(n => n.props?.className === 'bt-scrim bt-gm-scrim')[0].props.onMouseDown()
  assert.equal(closed, 2)
})

test('closing while the Bot is being made does not open it', async () => {
  let settle
  const calls = { made: [], created: [], closed: 0 }
  const actions = { createBot: (payload) => { calls.made.push(payload); return new Promise(resolve => { settle = resolve }) } }
  render({ models: MODELS }, { actions, onBack: () => { calls.closed += 1 }, onCreated: bot => calls.created.push(bot) })
  button('Create Bot').props.onClick()
  collect(n => n.props?.['aria-label'] === 'Close')[0].props.onClick()
  settle({ id: 'b1', name: 'New Bot' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.made.length, 1)
  assert.equal(calls.closed, 1)
  assert.equal(calls.created.length, 0)
})
