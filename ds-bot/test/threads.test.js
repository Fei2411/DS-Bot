import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentSession, openSessions, ownChatSessions, pushThreadPart, threadCurrent, threadCurrentOfPart, threadOf, threadOfPart } from '../src/host/threads.js'

// Each thread of a Bot's own chat (the single continuous foreground chat and each
// Bot-owned background task) has its own earlier parts, so a handoff never reads
// another thread's conversation.

const bot = () => ({
  id: 'w1',
  sessionId: 'w2',
  segments: [{ sessionId: 'w1', endedAt: 3 }],
  tasks: [
    { id: 't1', sessionId: 'w3', status: 'running', segments: [{ sessionId: 'w4', endedAt: 5 }], startedAt: 6 },
    { id: 't2', sessionId: 'w7', status: 'completed', segments: [{ sessionId: 'w8', endedAt: 7 }], startedAt: 8 },
  ],
})

test('each part belongs to its own thread, with that thread own earlier parts', () => {
  const b = bot()
  assert.deepEqual(threadOf(b, 'w2').segments.map(s => s.sessionId), ['w1'])
  assert.deepEqual(threadOf(b, 'w3').segments.map(s => s.sessionId), ['w4'])
  assert.equal(threadOf(b, 'w2').thread, 'current')
  assert.equal(threadOf(b, 'w3').thread, 'task')
  assert.equal(threadOf(b, 'nowhere'), undefined)
  assert.equal(threadCurrent(b, 'w2'), 'w2')
  assert.equal(threadCurrent(b, 'w3'), 'w3')
  assert.equal(threadOfPart(b, 'w4').taskId, 't1')
  assert.equal(threadCurrentOfPart(b, 'w4'), 'w3')
  // Settled tasks are no longer live delivery targets.
  assert.equal(threadCurrentOfPart(b, 'w7'), undefined)
  assert.equal(threadCurrentOfPart(b, 'w8'), undefined)
})

test('a fresh part replaces its own thread part and archives into that thread only', () => {
  const b = bot()
  assert.equal(pushThreadPart(b, 'w3', 'w5', { sessionId: 'w3', endedAt: 9 }), true)
  assert.equal(b.tasks[0].sessionId, 'w5')
  assert.deepEqual(b.tasks[0].segments.map(s => s.sessionId), ['w4', 'w3'])
  assert.deepEqual(b.segments.map(s => s.sessionId), ['w1'])
  assert.equal(b.sessionId, 'w2')
  assert.equal(pushThreadPart(b, 'w2', 'w6', { sessionId: 'w2', endedAt: 10 }), true)
  assert.equal(b.sessionId, 'w6')
  assert.deepEqual(b.segments.map(s => s.sessionId), ['w1', 'w2'])
  assert.deepEqual(b.tasks[0].segments.map(s => s.sessionId), ['w4', 'w3'])
})

test('every live thread is listed for a change that must reach them all', () => {
  const b = bot()
  assert.deepEqual(ownChatSessions(b), ['w2', 'w3'])
  assert.deepEqual(openSessions(b), ['w3', 'w4', 'w7', 'w8'])
  assert.deepEqual(ownChatSessions({ sessionId: 's1' }), ['s1'])
  assert.deepEqual(openSessions({ sessionId: 's1' }), [])
})

test('a Bot that never ran uses its own id as the current session', () => {
  const b = { id: 'w1', segments: [] }
  assert.equal(currentSession(b), 'w1')
  assert.equal(threadOf(b, 'w1').thread, 'current')
})
