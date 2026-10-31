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
