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
const { OPENING_WAIT_MS, openingModel, bindOpeningWait } = module.exports
const roster = {
  byId: {
    'bot-1': { id: 'bot-1', name: 'Chief' },
    'bot-2': { id: 'bot-2', name: 'Newcomer' },
  },
  roomsById: { 'room-1': { id: 'room-1', name: 'Ops' } },
}

// A clock the wait can be driven with, and the same store shape the client uses.
const waitRig = (onSlow) => {
  let queued = null
  const ui = {
    value: { pendingOpen: null },
    set(next) {
      const resolved = typeof next === 'function' ? next(ui.value) : next
      if (resolved === ui.value) return
      ui.value = resolved
    },
  }
  const wait = bindOpeningWait(ui, {
    onSlow,
    schedule: (fn, ms) => { queued = { fn, ms }; return queued },
    clear: () => { queued = null },
  })
  return { ui, wait, queued: () => queued }
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
  assert.equal(openingModel({ pending: { target: 'bot-2', id: 'bot-2', name: 'Newcomer', slow: true }, current: 'bot-2', roster }), null)
})

test('a Bot the roster does not know yet still shows the name it was opened with', () => {
  const model = openingModel({ pending: { target: 'bot-9', id: 'bot-9', name: 'Fresh' }, current: 'bot-1', roster })
  assert.equal(model.name, 'Fresh')
  assert.equal(model.bot, undefined)
})

test('a wait that runs out keeps the previous Bot hidden and only changes the note', () => {
  assert.equal(OPENING_WAIT_MS, 5000)
  const retries = []
  const { ui, wait, queued } = waitRig(() => retries.push('list'))
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  assert.equal(queued().ms, OPENING_WAIT_MS)
  const quiet = openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster })
  assert.equal(quiet.name, 'Newcomer')
  assert.equal(quiet.slow, false)
  queued().fn()
  const model = openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster })
  assert.equal(model.name, 'Newcomer')
  assert.equal(model.id, 'bot-2')
  assert.equal(model.slow, true)
  assert.notEqual(model.name, roster.byId['bot-1'].name)
  const tree = module.exports.OpeningCover({ model, column: 260 })
  assert.equal(tree.props.className, 'bt-opening')
  assert.equal(tree.props.style.left, '260px')
  assert.equal(tree.props.style.opacity, undefined)
  const text = flat(tree).filter(node => typeof node === 'string')
  assert.ok(text.includes('Newcomer'))
  assert.ok(text.includes('Still opening…'))
  assert.equal(text.includes('Chief'), false)
  assert.equal(text.includes('Opening…'), false)
  assert.match(module.exports.OPENING_CSS, /\.bt-opening\{[^}]*background:var\(--bt-main\)/)
  assert.deepEqual(retries, ['list'])
  queued().fn()
  assert.deepEqual(retries, ['list'])
  assert.equal(openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster }).name, 'Newcomer')
})

test('a late timeout does not uncover a Session the user opened afterwards', () => {
  const { ui, wait, queued } = waitRig()
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  const late = queued().fn
  wait.begin({ target: 'room-1', id: 'room-1', name: 'Ops' })
  late()
  const model = openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster })
  assert.equal(model.name, 'Ops')
  assert.equal(model.slow, false)
  assert.notEqual(model.name, 'Chief')
})

test('ending the wait lifts the cover, and a late timeout does not put the previous Bot back', () => {
  const { ui, wait, queued } = waitRig()
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  const late = queued().fn
  wait.end()
  assert.equal(ui.value.pendingOpen, null)
  assert.equal(queued(), null)
  late()
  assert.equal(ui.value.pendingOpen, null)
  assert.equal(openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster }), null)
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
