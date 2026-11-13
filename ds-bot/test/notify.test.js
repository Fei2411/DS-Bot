import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOTIFY_KEY, badgeOf, noticeText, notifyKind, readNotifyPrefs, writeNotifyPrefs } from '../src/client/notify.js'

// #1504: a window the user is not looking at says a Bot answered, or a card waits on
// them. What may leave the app is the conversation's name and one line, never the message.
const base = { enabled: true, muted: false, group: false, viewing: false, focused: false }

test('a reply notifies only when the conversation is not being watched', () => {
  const reply = { before: { completionUnread: false }, after: { completionUnread: true } }
  assert.equal(notifyKind({ ...base, ...reply }), 'reply')
  // Looking at it in a focused window is enough on its own.
  assert.equal(notifyKind({ ...base, ...reply, viewing: true, focused: true }), undefined)
  // Looking at it in a background window is not: the window may be behind another app.
  assert.equal(notifyKind({ ...base, ...reply, viewing: true }), 'reply')
  // Unread already set: a second status update says nothing new.
  assert.equal(notifyKind({ ...base, before: { completionUnread: true }, after: { completionUnread: true } }), undefined)
})

test('a card waiting on the user notifies in a group too, and once', () => {
  const question = { before: {}, after: { pendingInteraction: { id: 'q1' } } }
  assert.equal(notifyKind({ ...base, group: true, ...question }), 'question')
  // The same card still pending is not a second notification.
  assert.equal(notifyKind({ ...base, group: true, before: question.after, after: question.after }), undefined)
})

test('a group says nothing for an ordinary reply: that is @-mentions (#945), not this', () => {
  assert.equal(notifyKind({ ...base, group: true, before: {}, after: { completionUnread: true } }), undefined)
})

test('the switches and the mute win over the event', () => {
  const reply = { before: {}, after: { completionUnread: true } }
  assert.equal(notifyKind({ ...base, ...reply, enabled: false }), undefined)
  assert.equal(notifyKind({ ...base, ...reply, muted: true }), undefined)
})

test('what goes out is the name and one line', () => {
  assert.deepEqual(noticeText({ title: 'Writer', kind: 'reply' }), { title: 'Writer', body: 'A new reply is waiting' })
  assert.deepEqual(noticeText({ title: 'Ops', kind: 'question' }), { title: 'Ops', body: 'Waiting for your answer' })
  assert.equal(noticeText({ title: '   ', kind: 'reply' }).title, 'DS Bot')
  assert.equal(noticeText({ title: 'x'.repeat(200), kind: 'reply' }).title.length, 60)
})

test('the switches default to on with nothing muted, and survive bad storage', () => {
  assert.deepEqual(readNotifyPrefs(null), { enabled: true, muted: {} })
  assert.deepEqual(readNotifyPrefs('not json'), { enabled: true, muted: {} })
  assert.deepEqual(readNotifyPrefs('{"enabled":false,"muted":{"s-1":true,"s-2":false}}'), { enabled: false, muted: { 's-1': true } })
  const off = writeNotifyPrefs({ enabled: true, muted: {} }, { enabled: false })
  assert.deepEqual(off, { enabled: false, muted: {} })
  const muted = writeNotifyPrefs(off, { mute: { id: 's-9', on: true } })
  assert.deepEqual(muted, { enabled: false, muted: { 's-9': true } })
  assert.deepEqual(writeNotifyPrefs(muted, { mute: { id: 's-9', on: false } }), { enabled: false, muted: {} })
  assert.equal(NOTIFY_KEY, 'ds-bot:notify')
})

test('the badge counts conversations with something new', () => {
  assert.equal(badgeOf([]), 0)
  assert.equal(badgeOf([{ unread: true }, {}, { pending: true }, { unread: false }]), 2)
  assert.equal(badgeOf(undefined), 0)
})
