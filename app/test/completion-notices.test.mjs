import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { completionNotices } from '../src/completion-notices.mjs'

test('native completion notifications suppress the focused chat, deduplicate and reopen the Bot', () => {
  const notices = []; const opened = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; notices.push(this) }
    show() { this.shown = true }
  }
  let focused = true
  const manager = completionNotices({ Notification, window: () => ({ isVisible: () => true, isFocused: () => focused }), open: () => opened.push('window'), navigate: id => opened.push(id) })
  manager.current('writer')
  const event = { id: '1', botId: 'writer', sessionId: 'writer', name: 'Writer' }
  assert.equal(manager.show(event), false)
  focused = false
  assert.equal(manager.show({ ...event, id: '2' }), true)
  assert.equal(manager.show({ ...event, id: '2' }), false)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].options.body, 'Task completed')
  notices[0].emit('click')
  assert.deepEqual(opened, ['window', 'writer'])
})

test('attention notifications name the kind and open the chat the wait belongs to', () => {
  const notices = []; const opened = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; notices.push(this) }
    show() { this.shown = true }
  }
  const manager = completionNotices({ Notification, window: () => ({ isVisible: () => false, isFocused: () => false }), open: () => opened.push('window'), navigate: id => opened.push(id) })
  assert.equal(manager.show({ id: 'a1', kind: 'approval', botId: 'writer', sessionId: 'member-1', roomId: 'room1', name: 'Writer' }), true)
  assert.equal(notices[0].options.body, 'Waiting for your approval')
  notices[0].emit('click')
  assert.deepEqual(opened, ['window', 'room1'])
  for (const [kind, body] of [
    ['question', 'Waiting for your answer'],
    ['view', 'A view waits for your answer'],
    ['secret', 'Waiting for a secret'],
    ['failure', 'The task failed'],
  ]) {
    assert.equal(manager.show({ id: kind, kind, botId: 'writer', sessionId: 'writer', name: 'Writer' }), true)
    assert.equal(notices.at(-1).options.body, body)
  }
  assert.equal(manager.show({ id: 'plain', botId: 'writer', sessionId: 'writer', name: 'Writer' }), true)
  assert.equal(notices.at(-1).options.body, 'Task completed')
})

// A notifier whose notices a test can read, and whose answers it can collect.
function notifier(options = {}) {
  const notices = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(init) { super(); this.options = init; notices.push(this) }
    show() { this.shown = true }
  }
  const sent = []
  const manager = completionNotices({
    Notification,
    window: () => ({ isVisible: () => false, isFocused: () => false }),
    open: () => {},
    navigate: () => {},
    answer: message => sent.push(message),
    platform: 'win32',
    ...options,
  })
  return { manager, notices, sent }
}

test('a group member approval names the tool and the command, and its buttons answer it', () => {
  const { manager, notices, sent } = notifier()
  manager.show({ id: 'a1', kind: 'approval', botId: 'writer', sessionId: 'member-1', roomId: 'room1', name: 'Writer', tool: 'bash', reason: 'Outside the workspace', detail: { text: 'Clean the build folder', code: 'rm -rf build' } })
  assert.equal(notices[0].options.body, 'Allow bash: rm -rf build — Clean the build folder · Outside the workspace')
  assert.deepEqual(notices[0].options.actions, [{ type: 'button', text: 'Allow once' }, { type: 'button', text: 'Reject' }])
  notices[0].emit('action', { actionIndex: 1, selectionIndex: -1 })
  assert.deepEqual(sent, [{ type: 'ds-bot:attention-answer', id: 'a1', kind: 'approval', sessionId: 'member-1', choice: 'reject' }])
})

test('an approval in a Bot’s own chat names what it asks and is answered in the chat', () => {
  const { manager, notices, sent } = notifier()
  manager.show({ id: 'a2', kind: 'approval', botId: 'writer', sessionId: 'writer', name: 'Writer', tool: 'bash', reason: 'Outside the workspace' })
  assert.equal(notices[0].options.body, 'Allow bash — Outside the workspace (answer it in the chat)')
  assert.equal(notices[0].options.actions, undefined)
  notices[0].emit('action', { actionIndex: 0 })
  assert.deepEqual(sent, [])
})

test('question options are buttons on Windows up to three, and a dropdown beyond that', () => {
  const { manager, notices, sent } = notifier()
  manager.show({ id: 'q1', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which one?', detail: 'Pick one', options: ['A', 'B', 'C'] })
  assert.equal(notices[0].options.body, 'Which one? (Pick one)')
  assert.deepEqual(notices[0].options.actions, [{ type: 'button', text: 'A' }, { type: 'button', text: 'B' }, { type: 'button', text: 'C' }])
  notices[0].emit('action', { actionIndex: 2 })
  assert.deepEqual(sent.at(-1), { type: 'ds-bot:attention-answer', id: 'q1', kind: 'question', sessionId: 'writer', selected: ['C'] })

  manager.show({ id: 'q2', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['One', 'Two', 'Three', 'Four'] })
  assert.deepEqual(notices[1].options.actions, [{ type: 'selection', text: 'Send', items: ['One', 'Two', 'Three', 'Four'] }])
  notices[1].emit('action', { actionIndex: 0, selectionIndex: 3 })
  assert.deepEqual(sent.at(-1).selected, ['Four'])
  notices[1].emit('action', { actionIndex: 0, selectionIndex: -1 })
  assert.deepEqual(sent.at(-1).selected, [])
})

test('other systems show every question option as a button', () => {
  const { manager, notices, sent } = notifier({ platform: 'darwin' })
  manager.show({ id: 'q3', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['One', 'Two', 'Three', 'Four'] })
  assert.deepEqual(notices[0].options.actions, ['One', 'Two', 'Three', 'Four'].map(text => ({ type: 'button', text })))
  notices[0].emit('action', { actionIndex: 3 })
  assert.deepEqual(sent.at(-1).selected, ['Four'])
})

test('a question that allows its own answer takes the typed reply as the custom answer', () => {
  const { manager, notices, sent } = notifier()
  manager.show({ id: 'q4', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['A', 'B'], allowCustom: true })
  assert.equal(notices[0].options.hasReply, true)
  assert.equal(notices[0].options.replyPlaceholder, 'Type your own answer')
  notices[0].emit('reply', { reply: '  Something else  ' })
  assert.deepEqual(sent.at(-1), { type: 'ds-bot:attention-answer', id: 'q4', kind: 'question', sessionId: 'writer', selected: [], custom: 'Something else' })
})

test('a multi-select question has no option buttons, and a typed reply only when it allows one', () => {
  const { manager, notices } = notifier()
  manager.show({ id: 'm1', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which features?', options: ['A', 'B', 'C'], multiSelect: true })
  assert.equal(notices[0].options.body, 'Which features? (choose several in the app)')
  assert.equal(notices[0].options.actions, undefined)
  assert.equal(notices[0].options.hasReply, undefined)
  manager.show({ id: 'm2', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which features?', options: ['A', 'B', 'C'], multiSelect: true, allowCustom: true })
  assert.equal(notices[1].options.actions, undefined)
  assert.equal(notices[1].options.hasReply, true)
})

test('a refused answer is said in a notice of its own, and an accepted one shows nothing more', () => {
  const { manager, notices } = notifier()
  manager.show({ id: 'q5', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['A', 'B'] })
  notices[0].emit('action', { actionIndex: 0 })
  manager.result({ type: 'ds-bot:attention-result', id: 'q5', ok: false, error: 'This question is no longer open' })
  assert.equal(notices.length, 2)
  assert.equal(notices[1].options.title, 'Writer')
  assert.equal(notices[1].options.body, 'This question is no longer open')
  manager.show({ id: 'q6', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['A', 'B'] })
  notices[2].emit('action', { actionIndex: 1 })
  manager.result({ type: 'ds-bot:attention-result', id: 'q6', ok: true })
  assert.equal(notices.length, 3)
})

test('an answer that cannot be handed to the Bot team is said at once', () => {
  const { manager, notices } = notifier({ answer: () => { throw new Error('The Bot team is not running.') } })
  manager.show({ id: 'q7', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: 'Which?', options: ['A', 'B'] })
  notices[0].emit('action', { actionIndex: 0 })
  assert.equal(notices.length, 2)
  assert.equal(notices[1].options.body, 'The Bot team is not running.')
})

test('long commands and questions are clipped to keep the notification short', () => {
  const { manager, notices } = notifier()
  const long = 'x'.repeat(400)
  manager.show({ id: 'a3', kind: 'approval', botId: 'writer', sessionId: 'member-1', roomId: 'room1', name: 'Writer', tool: 'bash', detail: { code: long } })
  assert.ok(notices[0].options.body.length <= 140)
  assert.ok(notices[0].options.body.endsWith('…'))
  manager.show({ id: 'q8', kind: 'question', botId: 'writer', sessionId: 'writer', name: 'Writer', question: long, options: ['A', 'B'] })
  assert.ok(notices[1].options.body.length <= 160)
})
