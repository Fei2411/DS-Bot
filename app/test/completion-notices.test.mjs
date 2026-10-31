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
