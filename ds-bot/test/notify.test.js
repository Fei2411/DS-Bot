import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOTIFY_KEY, badgeOf, noticeText, notificationRows, notifyKind, readNotifyPrefs, writeNotifyPrefs } from '../src/client/notify.js'

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
  assert.deepEqual(noticeText({ title: 'Ops', kind: 'question' }), { title: 'Ops', body: 'Waiting for you' })
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


test('initial unread and pending snapshots do not replay notifications', () => {
  assert.equal(notifyKind({ ...base, after: { completionUnread: true } }), undefined)
  assert.equal(notifyKind({ ...base, after: { pendingInteraction: 'existing-card' } }), undefined)
})

// What waits, as the host's inbox lists it (src/host/inbox.js; test/inbox.test.js).
const item = (kind, ref, place) => ({ id: `${kind}:${ref}`, kind, group: kind === 'learning' ? 'suggest' : 'decide', ref, at: 1, ...place })
const inboxOf = (...items) => ({ count: items.length, counts: {}, items })

test('what waits uses stable conversation ids after part switches; a group\'s cards are the group\'s', () => {
  const roster = {
    bots: [{ id: 'bot', sessionId: 'part-2', name: 'Bot' }], rooms: [{ id: 'room', sessionId: 'room-2', name: 'Group' }],
    inbox: inboxOf(item('question', 'q1', { botId: 'bot', sessionId: 'part-2' }), item('approval', 'a1', { botId: 'bot', roomId: 'room' })),
  }
  const statuses = new Map([['part-2', { completionUnread: true }], ['part-1', { completionUnread: true }], ['room-2', {}]])
  const rows = notificationRows({ roster, statuses })
  assert.deepEqual(rows.map(row => [row.id, row.sessionId, row.pending, row.status.pendingInteraction]), [
    ['bot', 'part-2', true, 'question:q1'],
    ['room', 'room-2', true, 'approval:a1'],
  ])
  const prefs = readNotifyPrefs('{"muted":{"bot":true}}')
  assert.equal(notifyKind({ ...base, before: {}, after: rows[0].status, muted: prefs.muted[rows[0].id] }), undefined)
  assert.equal(notifyKind({ ...base, before: {}, after: rows[1].status, group: true }), 'question')
  assert.equal(badgeOf(rows), 2)
})

test('every kind the inbox lists makes a row wait, and a new item there notifies once', () => {
  const roster = { bots: [{ id: 'ops', name: 'Ops' }], rooms: [{ id: 'desk', name: 'Desk' }] }
  const rowsWith = (...items) => notificationRows({ roster: { ...roster, inbox: inboxOf(...items) }, statuses: new Map() })
  assert.deepEqual(rowsWith(), [])
  for (const kind of ['approval', 'question', 'view', 'secret', 'connector', 'mail', 'computer', 'handoff', 'blocked', 'learning']) {
    const [row] = rowsWith(item(kind, 'r1', { botId: 'ops' }))
    assert.deepEqual([row.id, row.pending], ['ops', true], kind)
  }
  for (const kind of ['question', 'goal', 'room-paused']) {
    const rows = rowsWith(item(kind, 'r1', { botId: 'ops', roomId: 'desk' }))
    assert.deepEqual(rows.map(row => [row.id, row.pending]), [['desk', true]], kind)
  }
  // An item answered and another asked keeps the row waiting, and says so again.
  const first = rowsWith(item('approval', 'a1', { botId: 'ops' }))[0].status
  const second = rowsWith(item('approval', 'a2', { botId: 'ops' }))[0].status
  assert.equal(notifyKind({ ...base, before: first, after: second }), 'question')
  assert.equal(notifyKind({ ...base, before: second, after: second }), undefined)
  // A card the shell holds itself still counts.
  const held = notificationRows({ roster, statuses: new Map([['ops', { pendingInteraction: { id: 'i1' } }]]) })
  assert.equal(held[0].status.pendingInteraction, 'interaction:i1')
})
