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

// #1929: a Session gone from the library must not leave the cover up forever.
test('a wait that cannot succeed keeps the cover as a failure with a way out', () => {
  const { ui, wait, queued } = waitRig()
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  assert.ok(queued() !== null)
  wait.fail('bot-2')
  assert.equal(queued(), null)
  assert.equal(ui.value.pendingOpen.failed, true)
  const model = openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster })
  assert.equal(model.failed, true)
  assert.equal(model.slow, false)
  const recovered = []
  const tree = module.exports.OpeningCover({ model, column: 260, onNewSession: id => recovered.push(id) })
  const nodes = flat(tree)
  const text = nodes.filter(node => typeof node === 'string')
  assert.ok(text.includes('Newcomer'))
  assert.ok(text.includes('This session is no longer available.'))
  assert.ok(text.includes('New session'))
  const button = nodes.find(node => typeof node === 'object' && node?.props?.className === 'bt-soft bt-soft-sm bt-opening-new')
  assert.ok(button, 'the failure offers a new session')
  button.props.onClick()
  assert.deepEqual(recovered, ['bot-2'])
})

test('a failure for another wait changes nothing, and ending the wait still lifts it', () => {
  const { ui, wait } = waitRig()
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  wait.fail('room-1')
  assert.equal(ui.value.pendingOpen.failed, undefined)
  wait.fail('bot-2')
  assert.equal(ui.value.pendingOpen.failed, true)
  wait.end()
  assert.equal(ui.value.pendingOpen, null)
})

test('a group chat whose Session is gone says so without a Bot action', () => {
  const model = openingModel({ pending: { target: 'room-1', id: 'room-1', name: 'Ops', failed: true }, current: 'bot-1', roster })
  assert.equal(model.group, true)
  assert.equal(model.failed, true)
  assert.equal(model.bot, undefined)
  const tree = module.exports.OpeningCover({ model, column: 260, onNewSession: () => { throw new Error('a group has no new Bot session to offer') } })
  const text = flat(tree).filter(node => typeof node === 'string')
  assert.ok(text.includes('This session is no longer available.'))
  assert.equal(text.includes('New session'), false)
})

test('a part switch within the same Bot or group does not cover the current chat until it clears, unless the wait failed', () => {
  const chief = { id: 'bot-1', name: 'Chief', sessionId: 'part-2', parts: ['part-1'] }
  const ops = { id: 'room-1', name: 'Ops', sessionId: 'room-2', ownParts: ['room-1'] }
  const multiPart = {
    byId: { 'bot-1': chief, 'part-1': chief, 'part-2': chief },
    roomsById: { 'room-1': ops, 'room-2': ops },
  }
  // While part-1 is still on screen, keep showing Chief instead of flashing a cover.
  assert.equal(openingModel({ pending: { target: 'part-2', id: 'bot-1', name: 'Chief' }, current: 'part-1', roster: multiPart }), null)
  assert.equal(openingModel({ pending: { target: 'room-2', id: 'room-1', name: 'Ops' }, current: 'room-1', roster: multiPart }), null)
  // Once part-1 clears (archived before part-2 lands), the cover steps in.
  const covered = openingModel({ pending: { target: 'part-2', id: 'bot-1', name: 'Chief' }, current: null, roster: multiPart })
  assert.equal(covered?.name, 'Chief')
  // A failed wait must never be suppressed behind an earlier segment of the same Bot or group.
  const failedBot = openingModel({ pending: { target: 'part-2', id: 'bot-1', name: 'Chief', failed: true }, current: 'part-1', roster: multiPart })
  assert.equal(failedBot?.failed, true)
  assert.equal(failedBot?.bot?.id, 'bot-1')
  const failedRoom = openingModel({ pending: { target: 'room-2', id: 'room-1', name: 'Ops', failed: true }, current: 'room-1', roster: multiPart })
  assert.equal(failedRoom?.failed, true)
  assert.equal(failedRoom?.group, true)
})

test('a timed-out wait says the session is not available yet and offers retry alongside recovery (#2004 review)', () => {
  const { ui, wait } = waitRig()
  wait.begin({ target: 'bot-2', id: 'bot-2', name: 'Newcomer' })
  wait.fail('bot-2', 'timeout')
  const model = openingModel({ pending: ui.value.pendingOpen, current: 'bot-1', roster })
  assert.equal(model.failed, true)
  assert.equal(model.reason, 'timeout')
  assert.equal(model.target, 'bot-2')
  const retried = []
  const recovered = []
  const tree = module.exports.OpeningCover({
    model, column: 260,
    onRetry: target => retried.push(target),
    onNewSession: id => recovered.push(id),
  })
  const nodes = flat(tree)
  const text = nodes.filter(node => typeof node === 'string')
  assert.ok(text.includes('This session is not available yet.'))
  assert.equal(text.includes('This session is no longer available.'), false)
  assert.ok(text.includes('Try again'))
  assert.ok(text.includes('New session'))
  const retryBtn = nodes.find(node => typeof node === 'object' && node?.props?.className === 'bt-soft bt-soft-sm bt-opening-retry')
  const newBtn = nodes.find(node => typeof node === 'object' && node?.props?.className === 'bt-soft bt-soft-sm bt-opening-new')
  retryBtn.props.onClick()
  newBtn.props.onClick()
  assert.deepEqual(retried, ['bot-2'])
  assert.deepEqual(recovered, ['bot-2'])

  // Group timeout shows retry without New session.
  const roomModel = openingModel({ pending: { target: 'room-1', id: 'room-1', name: 'Ops', failed: true, reason: 'timeout' }, current: 'bot-1', roster })
  const roomTree = module.exports.OpeningCover({ model: roomModel, column: 260, onRetry: target => retried.push(target) })
  const roomText = flat(roomTree).filter(node => typeof node === 'string')
  assert.ok(roomText.includes('This session is not available yet.'))
  assert.ok(roomText.includes('Try again'))
  assert.equal(roomText.includes('New session'), false)
})
