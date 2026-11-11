import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const bundle = async (contents) => (await build({
  stdin: { contents, resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})).outputFiles[0].text

// A stand-in React that draws one tree with effects left out.
const react = {
  Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useCallback: fn => fn, useRef: current => ({ current }), useMemo: make => make(), useId: () => 'id',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const load = (text) => {
  const module = { exports: {} }
  runInNewContext(text, {
    module, exports: module.exports,
    window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout, clearTimeout, Promise,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key })),
  })
  return module.exports
}
const { CommandPalette } = load(await bundle("export { CommandPalette } from './src/client/palette.js'"))

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')

const roster = { byId: {}, roomsById: {}, bots: [], rooms: [], agents: [], exchangeTurns: {} }
const rowsFor = (start, base) => {
  const actions = { closePalette() {}, reportError() {}, ...base }
  const tree = CommandPalette({ start, token: 1, roster, actions, useSessions: pick => pick({ byId: {}, projectionsBySession: {} }) })
  return walk(tree, node => node.type === 'button' && node.props.role === 'option')
}
const classicRow = rows => rows.find(row => textOf(row) === 'Classic Agent mode')

test('the default list does not offer Classic Agent mode', () => {
  const rows = rowsFor('', { setSurface() {}, openSettings() {} })
  assert.ok(rows.length > 0)
  assert.equal(classicRow(rows), undefined)
})

test('typing finds Classic Agent mode, and choosing it switches the surface', () => {
  const calls = []
  for (const query of ['classic', 'agent mode', 'CLASSIC']) {
    const row = classicRow(rowsFor(query, { setSurface: mode => calls.push(mode) }))
    assert.ok(row !== undefined, `"${query}" finds the row`)
    row.props.onClick()
  }
  assert.deepEqual(calls, ['agent', 'agent', 'agent'])
})

test('a search that does not name it leaves it out', () => {
  assert.equal(classicRow(rowsFor('settings', { setSurface() {} })), undefined)
})

test('without a surface switch (no classic mode here) the row never shows', () => {
  assert.equal(classicRow(rowsFor('classic', {})), undefined)
})
