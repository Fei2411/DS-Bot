import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { botHasPending, chatTargetOf, computerAsksForChat, pendingCountOf, pendingItemsOf, questionsForChat, roomHasPending } from './pending.ts'
import { setLang } from '../ui/i18n.ts'

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

test('learning proposals appear in Needs you and badges until handled', () => {
  const team: TeamState = { ...baseTeam, learning: {
    b1: [{ id: 'skill', botId: 'b1', name: 'review' }, { id: 'agents', botId: 'b1', kind: 'agents', folder: '/project' }],
    ghost: [{ id: 'gone', botId: 'ghost' }],
  } }
  assert.deepEqual(pendingItemsOf(team).map(item => item.key), ['learning-skill', 'learning-agents'])
  assert.equal(pendingCountOf(team), 2)
  assert.equal(botHasPending(team, baseTeam.bots[0]), true)
  assert.equal(roomHasPending(team, baseTeam.rooms![0]), false)
  assert.equal(pendingCountOf({ ...team, learning: { b1: [] } }), 0)
})

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
  assert.equal(items.some(item => item.kind === 'connector' && item.summary === 'Notion · Read wiki'), true)
  assert.equal(items.some(item => item.kind === 'connector' && item.summary === 'Mailbox · Read inbox'), true)
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

// The host's inbox list as ds-bot/test/inbox.test.js pins it: the host decides what
// waits, and the phone lists exactly that, in the same groups.
const inboxTeam = (items: NonNullable<TeamState['inbox']>['items']): TeamState => ({
  ...baseTeam,
  // An older host's fields that the list must not be read from any more.
  questions: { 's1-cur': { id: 'q-stale', question: 'Not this one' } },
  inbox: { count: items.length, counts: { decide: 0, fix: 0, suggest: 0 }, items },
})

test('a host that sends its inbox decides what Needs you lists, a group card under its group', () => {
  setLang('en')
  const team = inboxTeam([
    { id: 'question:q-group', kind: 'question', group: 'decide', ref: 'q-group', at: 35, botId: 'b2', roomId: 'r1', sessionId: 'r1-b2', text: 'Which branch?' },
    { id: 'mail:m1', kind: 'mail', group: 'decide', ref: 'm1', at: 70, botId: 'b1', sessionId: 's1-cur', text: 'Weekly report', to: 'team@example.com' },
    { id: 'room-paused:r1', kind: 'room-paused', group: 'fix', ref: 'r1', at: 40, roomId: 'r1', limit: 40, count: 40 },
    { id: 'paused:w1', kind: 'paused', group: 'fix', ref: 'w1', at: 44, botId: 'b1', to: 'b2', reason: 'ask_back', text: 'Which version?' },
    { id: 'blocked:b2', kind: 'blocked', group: 'fix', ref: 'b2', at: 50, botId: 'b2', text: 'RATE_LIMIT', status: 429 },
    { id: 'learning:p1', kind: 'learning', group: 'suggest', ref: 'p1', at: 90, botId: 'b2', text: 'skills/release-notes/SKILL.md', proposal: 'skill' },
  ])
  const items = pendingItemsOf(team)
  assert.deepEqual(items.map(item => [item.key, item.group]), [
    ['question:q-group', 'decide'], ['mail:m1', 'decide'], ['room-paused:r1', 'fix'], ['paused:w1', 'fix'], ['blocked:b2', 'fix'], ['learning:p1', 'suggest'],
  ])
  assert.deepEqual(items.map(item => item.summary), [
    'Which branch?',
    'Wants to send “Weekly report” to team@example.com',
    'Paused after 40 relays',
    'Hand-off to Coder paused · Which version?',
    'The model failed (RATE_LIMIT 429)',
    'skills/release-notes/SKILL.md',
  ])
  assert.equal(pendingCountOf(team), 6)
  // The group's question marks the group, not the member's own chat.
  assert.equal(roomHasPending(team, baseTeam.rooms![0]), true)
  assert.equal(botHasPending(team, baseTeam.bots[0]), true)
  const groupOnly = inboxTeam([{ id: 'question:q-group', kind: 'question', group: 'decide', ref: 'q-group', at: 35, botId: 'b2', roomId: 'r1', text: 'Which branch?' }])
  assert.equal(botHasPending(groupOnly, baseTeam.bots[1]), false)
  assert.equal(roomHasPending(groupOnly, baseTeam.rooms![0]), true)
  // Nothing waits: the old fields are not read.
  assert.equal(pendingCountOf(inboxTeam([])), 0)
  setLang('system')
})

test('distinct group questions preserve separate focus targets and render all asking member questions in the room', () => {
  const team: TeamState = {
    ...baseTeam,
    questions: {
      'r1-b1': { id: 'q-chief', question: 'Ship now?' },
      'r1-b2': { id: 'q-coder', question: 'Which branch?' },
    },
    inbox: {
      count: 2,
      counts: { decide: 2, fix: 0, suggest: 0 },
      items: [
        { id: 'question:q-chief', kind: 'question', group: 'decide', ref: 'q-chief', at: 10, botId: 'b1', roomId: 'r1', sessionId: 'r1-b1', text: 'Ship now?' },
        { id: 'question:q-coder', kind: 'question', group: 'decide', ref: 'q-coder', at: 20, botId: 'b2', roomId: 'r1', sessionId: 'r1-b2', text: 'Which branch?' },
      ],
    },
  }
  const rows = pendingItemsOf(team)
  assert.deepEqual(rows.map(row => chatTargetOf(row)), [
    { kind: 'room', id: 'r1', focus: 'question-q-chief' },
    { kind: 'room', id: 'r1', focus: 'question-q-coder' },
  ])
  const chatQuestions = questionsForChat(team, { room: baseTeam.rooms![0], sessionId: 'r1' })
  assert.deepEqual(chatQuestions.map(entry => ({ sessionId: entry.sessionId, id: entry.question.id, botName: entry.botName })), [
    { sessionId: 'r1-b1', id: 'q-chief', botName: 'Chief' },
    { sessionId: 'r1-b2', id: 'q-coder', botName: 'Coder' },
  ])
})

test('group computer-access asks route to the room chat instead of the member private chat', () => {
  const team = {
    ...baseTeam,
    computerLive: {
      asks: {
        'ask-group': { id: 'ask-group', botId: 'b2', roomId: 'r1', appName: 'Safari' },
        'ask-direct': { id: 'ask-direct', botId: 'b2', appName: 'Terminal' },
      },
    },
    inbox: {
      count: 2,
      counts: { decide: 2, fix: 0, suggest: 0 },
      items: [
        { id: 'computer:ask-group', kind: 'computer', group: 'decide', ref: 'ask-group', at: 10, botId: 'b2', roomId: 'r1', text: 'Safari' },
        { id: 'computer:ask-direct', kind: 'computer', group: 'decide', ref: 'ask-direct', at: 20, botId: 'b2', text: 'Terminal' },
      ],
    },
  } as TeamState
  const roomAsks = computerAsksForChat(team, { room: baseTeam.rooms![0] })
  assert.deepEqual(roomAsks, [{ id: 'ask-group', botId: 'b2', roomId: 'r1', appName: 'Safari', botName: 'Coder' }])
  const botAsks = computerAsksForChat(team, { bot: baseTeam.bots[1] })
  assert.deepEqual(botAsks, [{ id: 'ask-direct', botId: 'b2', appName: 'Terminal', botName: 'Coder' }])
})
