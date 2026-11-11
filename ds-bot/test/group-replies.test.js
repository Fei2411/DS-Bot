import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stackReplies } from '../src/shared/group-replies.js'

// A transcript written before the host noted one status row per episode can hold the
// same "started on it" twice; the same row in a row adds nothing.
test('a repeated working row is folded, a new one after a report is kept', () => {
  const t = 1_000_000
  const items = stackReplies([
    { kind: 'working', botId: 'b1', name: 'B', time: t },
    { kind: 'working', botId: 'b1', name: 'B', time: t + 20_000 },
    { kind: 'text', botId: 'b1', time: t + 30_000, text: 'done' },
    { kind: 'working', botId: 'b1', name: 'B', time: t + 40_000 },
  ])
  assert.equal(items.length, 3)
  assert.deepEqual(items.map(item => item.reply.kind ?? 'text'), ['working', 'text', 'working'])
})

test('different members and far-apart rows are not folded', () => {
  const t = 2_000_000
  const other = stackReplies([
    { kind: 'working', botId: 'b1', name: 'B1', time: t },
    { kind: 'working', botId: 'b2', name: 'B2', time: t + 10_000 },
  ])
  assert.equal(other.length, 2)
  const apart = stackReplies([
    { kind: 'working', botId: 'b1', name: 'B', time: t },
    { kind: 'working', botId: 'b1', name: 'B', time: t + 20 * 60_000 },
  ])
  assert.equal(apart.length, 2)
})

test('a status row without a time is never folded', () => {
  const items = stackReplies([
    { kind: 'working', botId: 'b1', name: 'B' },
    { kind: 'working', botId: 'b1', name: 'B' },
  ])
  assert.equal(items.length, 2)
})
