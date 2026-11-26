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


test('initial unread and pending snapshots do not replay notifications', () => {
  assert.equal(notifyKind({ ...base, after: { completionUnread: true } }), undefined)
  assert.equal(notifyKind({ ...base, after: { pendingInteraction: 'existing-card' } }), undefined)
})

test('questions and group approvals use stable conversation ids after part switches', () => {
  const roster = { bots: [{ id: 'bot', sessionId: 'part-2', name: 'Bot' }], rooms: [{ id: 'room', sessionId: 'room-2', name: 'Group' }],
    questions: { 'part-2': { id: 'q1' } } }
  const statuses = new Map([['part-2', { completionUnread: true }], ['part-1', { completionUnread: true }], ['room-2', {}]])
  const rows = notificationRows({ roster, statuses, approvals: [{ id: 'a1', botId: 'bot', roomId: 'room' }] })
  assert.deepEqual(rows.map(row => [row.id, row.sessionId, row.pending]), [['bot', 'part-2', true], ['room', 'room-2', true]])
  const prefs = readNotifyPrefs('{"muted":{"bot":true}}')
  assert.equal(notifyKind({ ...base, before: {}, after: rows[0].status, muted: prefs.muted[rows[0].id] }), undefined)
  assert.equal(notifyKind({ ...base, before: {}, after: rows[1].status, group: true }), 'question')
  assert.equal(badgeOf(rows), 2)
})

function referenceRows({ statuses, roster, approvals = [] }) {
  const rows = []
  for (const [group, entries] of [[false, roster.bots ?? []], [true, roster.rooms ?? []]]) {
    for (const entry of entries) {
      const sessionId = entry.sessionId ?? entry.id
      const status = statuses?.get(sessionId)
      const question = roster.questions?.[sessionId]
      const waiting = approvals.filter(approval => group ? approval.roomId === entry.id : approval.roomId === undefined && approval.botId === entry.id)
      const interaction = status?.pendingInteraction
      const keys = [
        ...(question ? [`question:${question.id}`] : []),
        ...waiting.map(approval => `approval:${approval.id}`),
        ...(interaction !== undefined ? [`interaction:${interaction?.id ?? interaction?.kind ?? 'pending'}`] : []),
      ].sort()
      if (status === undefined && keys.length === 0) continue
      rows.push({
        id: entry.id, sessionId, name: entry.name, group,
        unread: status?.completionUnread === true, pending: keys.length > 0,
        status: { ...status, pendingInteraction: keys.length > 0 ? keys.join('|') : undefined },
      })
    }
  }
  return rows
}

test('indexed approvals match the reference rows, including empty and overlapping conversations', () => {
  const roster = { bots: [{ id: 'same' }, { id: 'other', sessionId: 'part-2' }], rooms: [{ id: 'same' }, { id: '__proto__' }],
    questions: { 'part-2': { id: 'q' } } }
  const approvals = [
    { id: 'z', botId: 'same' }, { id: 'a', botId: 'same' }, { id: 'a', botId: 'same' },
    { id: 'room', botId: 'other', roomId: 'same' }, { id: 'unknown', botId: 'missing' },
    { id: 'unknown-room', botId: 'same', roomId: 'missing' }, { id: 'null-room', botId: 'same', roomId: null },
    { id: 'special', roomId: '__proto__' },
  ]
  for (const input of [
    { roster: {} }, { roster: {}, approvals }, { roster, approvals: [] }, { roster, approvals },
    { roster, approvals: [...approvals].reverse(), statuses: new Map([['same', { completionUnread: true, pendingInteraction: null }]]) },
  ]) {
    assert.deepEqual(notificationRows(input), referenceRows(input))
    assert.equal(JSON.stringify(notificationRows(input)), JSON.stringify(referenceRows(input)))
  }
  assert.equal(notificationRows({ roster, approvals })[0].status.pendingInteraction, 'approval:a|approval:a|approval:z')
})

test('indexed approvals match the reference on seeded randomized snapshots', () => {
  let seed = 1738
  const random = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let trial = 0; trial < 200; trial += 1) {
    const entries = () => Array.from({ length: random(20) }, (_, i) => ({ id: `id-${i}`, name: `Name ${i}`, ...(random(2) ? { sessionId: `part-${i}` } : {}) }))
    const roster = { bots: entries(), rooms: entries(), questions: {} }
    const statuses = new Map()
    for (const entry of [...roster.bots, ...roster.rooms]) {
      const sessionId = entry.sessionId ?? entry.id
      if (random(3)) statuses.set(sessionId, { completionUnread: random(2) === 1,
        pendingInteraction: [undefined, null, { id: 'i' }, { kind: 'ask' }, {}][random(5)] })
      if (random(3) === 0) roster.questions[sessionId] = { id: `q-${random(10)}` }
    }
    const approvals = Array.from({ length: random(80) }, () => ({ id: `a-${random(20)}`, botId: `id-${random(25)}`,
      ...(random(2) ? { roomId: `id-${random(25)}` } : {}) }))
    const input = { roster, statuses: random(5) ? statuses : undefined, approvals }
    assert.deepEqual(notificationRows(input), referenceRows(input), `trial ${trial}`)
    assert.equal(JSON.stringify(notificationRows(input)), JSON.stringify(referenceRows(input)), `trial ${trial}`)
  }
})
