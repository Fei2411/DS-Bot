import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enterSteers, steerable, steerQueued } from '../src/client/enter-steer.js'

const input = (over = {}) => ({ phase: 'plain', draft: '', attachmentIds: [], queue: [{ id: 'm1', source: { kind: 'user' } }], ...over })
const event = (over = {}) => ({ key: 'Enter', ...over })

test('plain Enter on an empty composer with the user\'s queue steers', () => {
  assert.equal(enterSteers(event(), input()), true)
  assert.equal(enterSteers(event(), input({ draft: '   \n\t  ' })), true)
  assert.equal(steerable(input()), true)
})

test('modifiers, IME and key repeat pass Enter through', () => {
  for (const over of [
    { key: 'a' },
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { getModifierState: key => key === 'AltGraph' },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
  ]) {
    assert.equal(enterSteers(event(over), input()), false, JSON.stringify(over))
  }
})

test('a non-empty draft, attachments, a busy phase or no user queue stay put', () => {
  for (const over of [
    { draft: 'hello' },
    { attachmentIds: ['a1'] },
    { phase: 'submitting' },
    { phase: 'adjudicating' },
    { phase: 'claimed' },
    { queue: [] },
    { queue: [{ id: 'm1', source: { kind: 'bot' } }, { id: 'm2', source: { kind: 'user-question-reply' } }] },
    { queue: [{ id: 'm1' }] },
  ]) {
    assert.equal(enterSteers(event(), input(over)), false, JSON.stringify(over))
    assert.equal(steerable(input(over)), false, JSON.stringify(over))
  }
  assert.equal(steerable(undefined), false)
})

const session = (queued, results = []) => {
  const calls = []
  return {
    calls,
    projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': queued }) }) },
    updateQueue: async (id, action) => {
      calls.push([id, action])
      const next = results.length === 0 ? { ok: true } : results.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

test('steerQueued steers only the user\'s own rows in FIFO order', async () => {
  const queued = [
    { id: 'u1', source: { kind: 'user' } },
    { id: 'b1', source: { kind: 'bot' } },
    { id: 'u2', source: { kind: 'user' } },
    { id: 'r1', source: { kind: 'user-question-reply' } },
    { id: 'u3', source: { kind: 'user' } },
  ]
  const s = session(queued)
  assert.equal(await steerQueued(s), 'done')
  assert.deepEqual(s.calls, [['u1', { kind: 'steer' }], ['u2', { kind: 'steer' }], ['u3', { kind: 'steer' }]])
})

test('steerQueued converges silently on a stale queue or a stopped Agent', async () => {
  for (const code of ['session/steer-unavailable', 'session/queue-item-not-found']) {
    const s = session(
      [{ id: 'u1', source: { kind: 'user' } }, { id: 'u2', source: { kind: 'user' } }],
      [{ ok: true }, { ok: false, error: { code } }],
    )
    assert.equal(await steerQueued(s), 'done', code)
    assert.deepEqual(s.calls, [['u1', { kind: 'steer' }], ['u2', { kind: 'steer' }]])
  }
})

test('steerQueued reports other failures', async () => {
  const s = session(
    [{ id: 'u1', source: { kind: 'user' } }, { id: 'u2', source: { kind: 'user' } }],
    [{ ok: false, error: { code: 'session/gone' } }],
  )
  assert.equal(await steerQueued(s), 'failed')
  assert.deepEqual(s.calls, [['u1', { kind: 'steer' }]])
  const rejecting = session([{ id: 'u1', source: { kind: 'user' } }], [new Error('offline')])
  assert.equal(await steerQueued(rejecting), 'failed')
})

test('steerQueued on an empty or other-source queue calls nothing', async () => {
  for (const queued of [[], [{ id: 'b1', source: { kind: 'bot' } }]]) {
    const s = session(queued)
    assert.equal(await steerQueued(s), 'done')
    assert.deepEqual(s.calls, [])
  }
  const empty = { projections: { faceOf: () => ({ getSnapshot: () => undefined }) }, updateQueue: () => assert.fail() }
  assert.equal(await steerQueued(empty), 'done')
})
