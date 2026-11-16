import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { pendingCountOf, pendingSectionsOf } from './pending.ts'

const state = {
  revision: 1,
  bots: [{ id: 'b1', sessionId: 's1', name: 'Chief' }],
  questions: {
    s1: { id: 'q1', question: 'Pick one' },
    ghost: { id: 'q2', question: 'Stale session' },
  },
  work: {
    approvals: [
      { id: 'a1', sessionId: 's1', botId: 'b1', tool: 'run', reason: 'needs ok' },
      { id: 'a2', sessionId: 's1', botId: 'b1', tool: 'run', reason: 'not answerable', answerable: false },
    ],
  },
  secretRequests: {
    b1: [{ id: 'sec1', name: 'API key', status: 'pending' }, { id: 'sec2', status: 'done' }],
  },
  browserHolds: {
    b1: { callId: 'c1', note: 'Log in' },
  },
  views: {
    s1: { id: 'v1', title: 'Table' },
    ghost: { id: 'v2', title: 'Stale session' },
  },
} as unknown as TeamState

test('the badge counts exactly the rows the Needs you page can show', () => {
  const rows = pendingSectionsOf(state)
  assert.equal(rows.questions.length, 1)
  assert.equal(rows.questions[0]?.key, 'q-q1')
  assert.equal(rows.approvals.length, 1)
  assert.equal(rows.secrets.length, 1)
  assert.equal(rows.handoffs.length, 1)
  assert.equal(rows.views.length, 1)
  assert.equal(rows.views[0]?.key, 'v-v1')
  assert.equal(pendingCountOf(state), 5)
})

test('a team with nothing pending counts zero', () => {
  assert.equal(pendingCountOf(null), 0)
  assert.equal(pendingCountOf({ revision: 1, bots: [] } as TeamState), 0)
})
