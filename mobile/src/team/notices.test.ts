import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoticeCursor } from './notices.ts'

test('reconnect replays first missed notice even when initial handshake seq was zero', () => {
  const cursor = createNoticeCursor()
  assert.deepEqual(cursor.connect({ boot: 'b1', seq: 0 }), { sameBoot: false, since: 0 })
  assert.deepEqual(cursor.acceptCatchUp('b1', false, { boot: 'b1', seq: 0, reset: true, notices: [] }), { reset: true, replay: [] })

  // Disconnect while notice seq=1 arrives on host, then reconnect with same boot.
  assert.deepEqual(cursor.connect({ boot: 'b1', seq: 1 }), { sameBoot: true, since: 0 })
  const caught = cursor.acceptCatchUp('b1', true, {
    boot: 'b1',
    seq: 1,
    reset: false,
    notices: [{ seq: 1, kind: 'message', botId: 'a', text: 'hi' }],
  })
  assert.equal(caught.reset, false)
  assert.deepEqual(caught.replay, [{ seq: 1, kind: 'message', botId: 'a', text: 'hi' }])
  assert.deepEqual(cursor.snapshot(), { boot: 'b1', seq: 1 })
})

test('initial connect starts at hello seq and skips older history', () => {
  const cursor = createNoticeCursor()
  assert.deepEqual(cursor.connect({ boot: 'b1', seq: 10 }), { sameBoot: false, since: 10 })
  const caught = cursor.acceptCatchUp('b1', false, {
    boot: 'b1',
    seq: 10,
    reset: true,
    notices: [{ seq: 9 }, { seq: 10 }],
  })
  assert.deepEqual(caught, { reset: true, replay: [] })
})

test('live notice arriving before catch-up resolves deduplicates replay and keeps monotonic seq', () => {
  const cursor = createNoticeCursor()
  cursor.connect({ boot: 'b1', seq: 3 })
  cursor.acceptCatchUp('b1', false, { boot: 'b1', seq: 3, reset: true, notices: [] })

  // Reconnect from seq=3; host now has seq=4 (missed) and emits seq=5 live before notices returns.
  assert.deepEqual(cursor.connect({ boot: 'b1', seq: 4 }), { sameBoot: true, since: 3 })
  assert.equal(cursor.acceptLive('b1', { seq: 5, text: 'newest' }), true)
  assert.equal(cursor.acceptLive('b1', { seq: 5, text: 'duplicate' }), false)

  const caught = cursor.acceptCatchUp('b1', true, {
    boot: 'b1',
    seq: 5,
    reset: false,
    notices: [{ seq: 4, text: 'older' }, { seq: 5, text: 'newest' }],
  })
  assert.deepEqual(caught, { reset: false, replay: [] })
  assert.deepEqual(cursor.snapshot(), { boot: 'b1', seq: 5 })
})

test('host reboot switches boot epoch cleanly and gap reset returns no stale replay', () => {
  const cursor = createNoticeCursor()
  cursor.connect({ boot: 'b1', seq: 5 })
  assert.deepEqual(cursor.connect({ boot: 'b2', seq: 2 }), { sameBoot: false, since: 2 })
  assert.deepEqual(cursor.acceptCatchUp('b2', false, { boot: 'b2', seq: 2, reset: true, notices: [{ seq: 1 }, { seq: 2 }] }), { reset: true, replay: [] })

  assert.deepEqual(cursor.connect({ boot: 'b2', seq: 9 }), { sameBoot: true, since: 2 })
  assert.deepEqual(cursor.acceptCatchUp('b2', true, { boot: 'b2', seq: 9, reset: true, notices: [{ seq: 8 }] }), { reset: true, replay: [] })
  assert.deepEqual(cursor.snapshot(), { boot: 'b2', seq: 9 })
})
