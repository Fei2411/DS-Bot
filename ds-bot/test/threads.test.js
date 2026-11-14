import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentSession, focusOpenPart, isOpenPart, openSessions, ownChatSessions, pushThreadPart, startOpenPart, successorOfMovedPart, threadCurrent, threadOf } from '../src/host/threads.js'

// #1501: a Bot's own chat can keep a second part live while the first one runs. Each
// thread (the current one and each open part) has its own earlier parts, so a handoff
// never reads the other thread's conversation.

const bot = () => ({
  id: 'w1',
  sessionId: 'w2',
  segments: [{ sessionId: 'w1', endedAt: 3 }],
  openParts: [{ sessionId: 'w3', segments: [{ sessionId: 'w4', endedAt: 5 }], startedAt: 6 }],
})

test('each part belongs to own thread, with that thread own earlier parts', () => {
  const b = bot()
  assert.deepEqual(threadOf(b, 'w2').segments.map(s => s.sessionId), ['w1'])
  assert.deepEqual(threadOf(b, 'w3').segments.map(s => s.sessionId), ['w4'])
  assert.equal(isOpenPart(b, 'w3'), true)
  assert.equal(isOpenPart(b, 'w2'), false)
  assert.equal(threadOf(b, 'nowhere'), undefined)
  assert.equal(threadCurrent(b, 'w2'), 'w2')
  assert.equal(threadCurrent(b, 'w3'), 'w3')
})

test('a fresh part replaces its own thread part and archives into that thread only', () => {
  const b = bot()
  assert.equal(pushThreadPart(b, 'w3', 'w5', { sessionId: 'w3', endedAt: 9 }), true)
  assert.equal(b.openParts[0].sessionId, 'w5')
  assert.deepEqual(b.openParts[0].segments.map(s => s.sessionId), ['w4', 'w3'])
  assert.deepEqual(b.segments.map(s => s.sessionId), ['w1'])
  assert.equal(b.sessionId, 'w2')
  assert.equal(pushThreadPart(b, 'w2', 'w6', { sessionId: 'w2', endedAt: 10 }), true)
  assert.equal(b.sessionId, 'w6')
  assert.deepEqual(b.segments.map(s => s.sessionId), ['w1', 'w2'])
  assert.deepEqual(b.openParts[0].segments.map(s => s.sessionId), ['w4', 'w3'])
})

test('a part opened while the Bot works leaves the running part live with its chain', () => {
  const b = bot()
  startOpenPart(b, 'w5', 7)
  assert.equal(b.sessionId, 'w5')
  assert.deepEqual(b.segments, [])
  assert.equal(b.openParts.at(-1).sessionId, 'w2')
  assert.deepEqual(b.openParts.at(-1).segments.map(s => s.sessionId), ['w1'])
  assert.equal(b.openParts.at(-1).startedAt, 7)
  assert.equal(isOpenPart(b, 'w2'), true)
})

test('making an open part current swaps both threads and their chains', () => {
  const b = bot()
  assert.equal(focusOpenPart(b, 'w3'), true)
  assert.equal(b.sessionId, 'w3')
  assert.deepEqual(b.segments.map(s => s.sessionId), ['w4'])
  assert.equal(b.openParts.at(-1).sessionId, 'w2')
  assert.deepEqual(b.openParts.at(-1).segments.map(s => s.sessionId), ['w1'])
  assert.equal(focusOpenPart(b, 'missing'), false)
})

test('every live thread is listed for a change that must reach them all', () => {
  const b = bot()
  assert.deepEqual(ownChatSessions(b), ['w2', 'w3'])
  assert.deepEqual(openSessions(b), ['w3', 'w4'])
  // An older state without open parts is the same single thread as before.
  assert.deepEqual(ownChatSessions({ sessionId: 's1' }), ['s1'])
  assert.deepEqual(openSessions({ sessionId: 's1' }), [])
})

test('a Bot that never ran uses its own id as the current session', () => {
  const b = { id: 'w1', segments: [] }
  assert.equal(currentSession(b), 'w1')
  assert.equal(threadOf(b, 'w1').thread, 'current')
  startOpenPart(b, 'w2', 8)
  assert.equal(b.openParts[0].sessionId, 'w1')
  assert.equal(b.sessionId, 'w2')
  assert.equal(threadOf(b, 'w1').thread, 'open')
})

test('a part that became a background thread while it moved records that thread successor', () => {
  // The user opened a new part while this part was switching: the switch captured the
  // foreground thread, but by the time the part moved on it belongs to an open thread.
  // Its successor must be recorded there, or scheduled tasks move to the new part.
  const b = { id: 'w1', sessionId: 'w2', segments: [] }
  startOpenPart(b, 'w3')
  assert.equal(pushThreadPart(b, 'w2', 'w4', { sessionId: 'w2', endedAt: 9 }), true)
  assert.equal(successorOfMovedPart(b, 'w4'), 'w4')
  // A foreground move needs no successor: bot.sessionId already names the fresh part.
  const fg = { id: 'w1', sessionId: 'w2', segments: [] }
  pushThreadPart(fg, 'w2', 'w5', { sessionId: 'w2', endedAt: 9 })
  assert.equal(successorOfMovedPart(fg, 'w5'), undefined)
})
