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

// The Create Bot form, bundled once and rendered with the minimal React stand-in of
// connectors-page.test.js: hooks are numbered by expansion order, effects never run.
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
const render = (roster) => {
  slots.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {} }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens on DS Bot models and can create at once', () => {
  render({ models: MODELS })
  assert.equal(button('DS Bot model').props['aria-pressed'], true)
  assert.equal(button('Local agent').props['aria-pressed'], false)
  assert.equal(button('Create').props.disabled, false)
})

test('a name another Bot has blocks Create on both sides', () => {
  render({ models: MODELS, bots: [{ id: 'a', name: 'Ada' }] })
  collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.onChange({ target: { value: 'Ada' } })
  assert.match(flatten(concrete).join(' '), /A Bot named Ada already exists/)
  assert.equal(button('Create').props.disabled, true)
  button('Local agent').props.onClick()
  assert.equal(button('Create').props.disabled, true)
})

test('on Local agent, Create waits for a CLI', () => {
  render({ models: MODELS })
  button('Local agent').props.onClick()
  assert.equal(button('Local agent').props['aria-pressed'], true)
  assert.match(flatten(concrete).join(' '), /Looking for agent CLIs/)
  assert.equal(button('Create').props.disabled, true)
  button('DS Bot model').props.onClick()
  assert.equal(button('Create').props.disabled, false)
})
