import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completionPermission, requestCompletionPermission, noticeCompletions } from '../src/client/completion-notices.js'

test('browser notifications require explicit permission, hide text and do not replay after reconnect', async t => {
  const originals = Object.fromEntries(['document', 'window', 'Notification'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, value] of Object.entries(originals)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key] } })
  let focused = true; let current = 'writer'; let requests = 0; let listener
  const notes = []; const unread = []; const claims = new Set(); const opened = []
  const stored = new Map([['ds-bot-notification-client', 'device']])
  class Notification {
    static permission = 'default'
    static requestPermission() { requests++; this.permission = 'granted'; return Promise.resolve('granted') }
    constructor(title, options) { this.title = title; this.options = options; notes.push(this) }
    close() {}
  }
  Object.assign(globalThis, { Notification, document: { visibilityState: 'visible', hasFocus: () => focused }, window: { focus() {} } })
  assert.equal(await completionPermission(), 'default'); assert.equal(requests, 0)
  assert.equal(await requestCompletionPermission(), 'granted'); assert.equal(requests, 1)
  const snapshot = { byId: { writer: { name: 'Private writer', private: true } }, completions: [] }
  const options = { roster: { getSnapshot: () => snapshot, subscribe: callback => { listener = callback; return () => {} } },
    shownSession: () => current, openSession: id => opened.push(id), markUnread: id => unread.push(id),
    claim: async id => { if (claims.has(id)) return false; claims.add(id); return true },
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, since: 10 }
  let stop = noticeCompletions(options)
  snapshot.completions.push({ id: 'focused', time: 11, botId: 'writer', sessionId: 'writer', kind: 'monitor' })
  listener(); await Promise.resolve()
  assert.equal(notes.length, 0); assert.deepEqual(unread, [])
  current = 'reader'; focused = false
  snapshot.completions.push({ id: 'background', time: 12, botId: 'writer', sessionId: 'writer', kind: 'monitor', text: 'Never show this' })
  listener(); await Promise.resolve()
  assert.equal(notes.length, 1); assert.equal(notes[0].options.body, 'Task completed')
  assert.deepEqual(unread, ['writer']); notes[0].onclick(); assert.deepEqual(opened, ['writer'])
  listener(); await Promise.resolve(); assert.equal(notes.length, 1)
  stop(); stop = noticeCompletions({ ...options, since: 13 }); await Promise.resolve()
  assert.equal(notes.length, 1)
  assert.deepEqual(unread, ['writer'])
  snapshot.byId.writer.notifyCompletion = false
  snapshot.completions.push({ id: 'disabled', time: 13, botId: 'writer', sessionId: 'writer' })
  listener(); await Promise.resolve(); assert.equal(notes.length, 1)
  stop()
  snapshot.monitorResults = [{ id: 'offline-hit', botId: 'writer', sessionId: 'writer', time: 14 }]
  stop = noticeCompletions({ ...options, since: 20 }); await Promise.resolve()
  assert.deepEqual(unread, ['writer', 'writer'])
  assert.equal(notes.length, 1)
  stop()
})
