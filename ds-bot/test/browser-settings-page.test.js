import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Browser settings page with a small React so its sections and rows render.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const cells = []
let hook = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState(initial) {
    const i = hook++
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
    return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
  },
  useEffect() {},
  Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
})
const { BrowserPage } = module.exports
const h = react.createElement
const Section = ({ title, children }) => h('section', null, h('h3', null, title), ...(children ?? []))
const Row = ({ label, hint, children }) => h('div', null, h('span', null, label), hint ? h('span', null, hint) : null, ...(children ?? []))
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}

test('the Browser page says default browsing is read-only and names browserPlugin', () => {
  hook = 0
  cells.length = 0
  const text = textOf(expand(BrowserPage({ roster: { bots: [] }, actions: {}, run: () => {}, Section, Row })))
  assert.match(text, /A Bot can read the page you have open/)
  assert.match(text, /cannot click, type, scroll or open pages/)
  assert.match(text, /How to enable interactive browsing/)
  assert.match(text, /browserPlugin/)
  assert.match(text, /refs, script or task/)
  assert.match(text, /restart DS Bot/)
  assert.match(text, /With an interactive plugin, Bots browse, click and fill in forms/)
  assert.match(text, /These grants apply only after an interactive browser plugin is enabled/)
  assert.doesNotMatch(text, /Bots browse, click and fill in forms freely\./)
  assert.doesNotMatch(text, /freely/)
})
