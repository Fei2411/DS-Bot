import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// The cover bundled once, with the minimal React stand-in the other client tests use.
const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/opening.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'fragment',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { OPENING_WAIT_MS, openingModel } = module.exports
const roster = {
  byId: { 'bot-2': { id: 'bot-2', name: 'Newcomer' } },
  roomsById: { 'room-1': { id: 'room-1', name: 'Ops' } },
}

test('nothing waits, nothing covers the conversation', () => {
  assert.equal(openingModel({ pending: null, current: 'bot-1', roster }), null)
})

test('a Bot whose Session has not landed fills the conversation area', () => {
  const model = openingModel({ pending: { target: 'bot-2', id: 'bot-2', name: 'Newcomer' }, current: 'bot-1', roster })
  assert.equal(model.name, 'Newcomer')
  assert.equal(model.bot.id, 'bot-2')
  assert.equal(model.group, false)
})

test('a group chat waits the same way', () => {
  const model = openingModel({ pending: { target: 'room-1', id: 'room-1', name: 'Ops' }, current: 'bot-1', roster })
  assert.equal(model.name, 'Ops')
  assert.equal(model.group, true)
  assert.equal(model.bot, undefined)
})

test('the cover goes away once the main view holds the Session', () => {
  assert.equal(openingModel({ pending: { target: 'bot-2', id: 'bot-2', name: 'Newcomer' }, current: 'bot-2', roster }), null)
})

test('a Bot the roster does not know yet still shows the name it was opened with', () => {
  const model = openingModel({ pending: { target: 'bot-9', id: 'bot-9', name: 'Fresh' }, current: 'bot-1', roster })
  assert.equal(model.name, 'Fresh')
  assert.equal(model.bot, undefined)
})

test('a wait never covers the window for longer than its own limit', () => {
  assert.equal(OPENING_WAIT_MS, 5000)
})

const flat = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach(child => flat(child, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  out.push(node)
  flat(node.props?.children, out)
  return out
}

test('the cover names the Bot, says it is opening, and leaves the sidebar uncovered', () => {
  const model = openingModel({ pending: { target: 'bot-2', id: 'bot-2', name: 'Newcomer' }, current: 'bot-1', roster })
  const tree = module.exports.OpeningCover({ model, column: 260 })
  const nodes = flat(tree)
  const text = nodes.filter(node => typeof node === 'string')
  assert.ok(text.includes('Newcomer'))
  assert.ok(text.includes('Opening…'))
  assert.equal(tree.props.role, 'status')
  assert.equal(tree.props.style.left, '260px')
})

test('no model draws nothing at all', () => {
  assert.equal(module.exports.OpeningCover({ model: null, column: 0 }), null)
})
