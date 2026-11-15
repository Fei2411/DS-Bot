import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { botHasPending, pendingCountOf, pendingItemsOf, roomHasPending } from './pending.ts'

const baseTeam: TeamState = {
  revision: 1,
  bots: [
    { id: 'b1', name: 'Chief', sessionId: 's1-cur', parts: ['b1'] },
    { id: 'b2', name: 'Coder', sessionId: 'b2' },
  ],
  rooms: [
    { id: 'r1', name: 'Group', members: ['b1', 'b2'] },
  ],
  mainBotId: 'b1',
  mainBotIds: ['b1'],
}

test('pendingCountOf matches pendingItemsOf when questions or views reference orphaned or non-current sessions', () => {
  const team: TeamState = {
    ...baseTeam,
    questions: {
      // b1 is currently on s1-cur; an old part 'b1' or deleted session 'ghost' is not open in Chat or NeedsYou
      b1: { id: 'q-old', question: 'Old part question' },
      ghost: { id: 'q-ghost', question: 'Deleted bot question' },
    },
    views: {
      ghost: { id: 'v-ghost', title: 'Orphan view', view: {} },
    },
  }
  assert.equal(pendingItemsOf(team).length, 0)
  assert.equal(pendingCountOf(team), 0)
  assert.equal(botHasPending(team, baseTeam.bots[0]), false)
})

test('pendingItemsOf, pendingCountOf, botHasPending, and roomHasPending cover all five pending kinds consistently', () => {
  const team: TeamState = {
    ...baseTeam,
    questions: { 's1-cur': { id: 'q1', question: 'Pick a branch' } },
    views: { b2: { id: 'v1', title: 'Confirm release', view: {} } },
    work: {
      approvals: [
        { id: 'a1', sessionId: 's1-cur', botId: 'b1', tool: 'bash', reason: 'run', answerable: true },
        { id: 'a2', sessionId: 'r1-b2', botId: 'b2', roomId: 'r1', tool: 'write', reason: 'save', answerable: true },
        { id: 'a3', sessionId: 'b2', botId: 'b2', tool: 'click', reason: 'desktop-only', answerable: false },
      ],
    },
    secretRequests: {
      b1: [{ id: 'sec1', name: 'TOKEN', status: 'pending' }, { id: 'sec2', name: 'OLD', status: 'saved' }],
    },
    connectorRequests: {
      b2: [
        { id: 'con1', connectorId: 'notion', name: 'Notion', purpose: 'Read wiki', status: 'pending' },
        { id: 'con-mail', connectorId: 'mail', name: 'Mailbox', purpose: 'Read inbox', status: 'pending' },
        { id: 'con2', connectorId: 'github', name: 'GitHub', status: 'done' },
      ],
    },
    browserHolds: {
      b2: { callId: 'hold-1', reason: 'verification', note: 'Complete 2FA' },
    },
  }
  const items = pendingItemsOf(team)
  assert.equal(pendingCountOf(team), items.length)
  assert.equal(items.length, 8)
  assert.equal(items.some(item => item.kind === 'connector' && item.connectorId === 'notion' && item.purpose === 'Read wiki'), true)
  assert.equal(items.some(item => item.kind === 'connector' && item.connectorId === 'mail' && item.purpose === 'Read inbox'), true)
  assert.equal(botHasPending(team, baseTeam.bots[0]), true)
  assert.equal(botHasPending(team, baseTeam.bots[1]), true)
  assert.equal(roomHasPending(team, baseTeam.rooms![0]), true)

  const settled: TeamState = {
    ...baseTeam,
    questions: {},
    views: {},
    work: { approvals: [] },
    secretRequests: { b1: [{ id: 'sec1', name: 'TOKEN', status: 'saved' }] },
    connectorRequests: { b2: [{ id: 'con1', connectorId: 'notion', name: 'Notion', status: 'connected' }] },
    browserHolds: {},
  }
  assert.equal(pendingCountOf(settled), 0)
  assert.equal(pendingItemsOf(settled).length, 0)
  assert.equal(botHasPending(settled, baseTeam.bots[0]), false)
  assert.equal(botHasPending(settled, baseTeam.bots[1]), false)
  assert.equal(roomHasPending(settled, baseTeam.rooms![0]), false)
})
