import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// #1077: the custom-provider Add form says which required fields it still needs instead
// of only greying out Add. Rendered with the minimal React stand-in of
// connectors-page.test.js: hooks are numbered by expansion order, so state survives a
// re-render and the inputs can be driven the way a user would.
const { outputFiles } = await build({
  stdin: { contents: "export { CustomForm } from './src/client/providers-page.js'", resolveDir: PLUGIN },
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
  return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}
const rerender = () => { idx = 0; concrete = expand(module.exports.CustomForm(props)) }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...(p ?? {}), children } }),
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

const walk = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(item => walk(item, out)); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  walk(node.props?.children, out)
  return out
}
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const children = node?.props?.children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return textOf(children)
}
const hintText = () => {
  const hint = walk(concrete).find(node => node.props?.className === 'bt-set-hint bt-provider-missing')
  return hint === undefined ? null : textOf(hint)
}
const addButton = () => walk(concrete).find(node => node.type === 'button' && textOf(node) === 'Add')
const field = label => walk(concrete).find(node => node.type === 'input' && node.props?.['aria-label'] === label)
const type = (label, value) => field(label).props.onChange({ target: { value } })

const mount = () => {
  slots.length = 0
  props = { view: { protocols: ['openai-completions'] }, apply: () => {}, actions: {}, onDone() {} }
  rerender()
}

test('the Add form names every required field it still needs', () => {
  mount()
  assert.equal(hintText(), 'Still needed: Provider ID, Endpoint, At least one model')
  assert.equal(addButton().props.disabled, true)
})

test('each filled field leaves the hint one step shorter', () => {
  mount()
  type('Provider ID', 'my-gw')
  assert.equal(hintText(), 'Still needed: Endpoint, At least one model')
  type('Endpoint', 'http://127.0.0.1:9/v1')
  assert.equal(hintText(), 'Still needed: At least one model')
  // A model typed by id counts, not only one picked from the fetched list.
  type('Model ids', 'm1')
  assert.equal(hintText(), null)
  assert.equal(addButton().props.disabled, false)
})

test('blank and padded values still count as missing', () => {
  mount()
  type('Provider ID', '   ')
  type('Endpoint', ' ')
  assert.equal(hintText(), 'Still needed: Provider ID, Endpoint, At least one model')
  assert.equal(addButton().props.disabled, true)
})
