// A Bot's mark on the phone moves as the desktop sidebar's does (sidebar.js BotRow). The
// team state here has the shapes the computer sends (host/channel.js `live`: `activity`
// from turns.js activityView is one word per Bot; `work` from workView, roomWorkView and
// approvalsView), and the cases are the desktop's own (test/sidebar-approval-status.test.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot, TeamState } from '../connection.ts'
import { botMarkState, botRunning, workMarkState } from './mark-state.ts'

const reviewer = { id: 'reviewer', name: 'Reviewer', sessionId: 'reviewer-p2' } as Bot
const team = (extra: Record<string, unknown>) => ({ bots: [reviewer], ...extra }) as unknown as TeamState
const approval = (extra: Record<string, unknown>) => ({ id: 'a1', sessionId: 'reviewer-p2', botId: 'reviewer', tool: 'run_command', reason: 'rm', ...extra })

test('a running Bot shows what the computer says it does', () => {
  for (const word of ['thinking', 'searching', 'working', 'sending']) {
    assert.equal(botMarkState(team({ work: { bots: { reviewer: { tool: 'x' } } }, activity: { reviewer: word } }), reviewer), word)
  }
  // No word yet: working.
  assert.equal(botMarkState(team({ work: { bots: { reviewer: {} } } }), reviewer), 'working')
})

test('at work in a group only, it still works, with the word the computer gives', () => {
  const state = team({ work: { rooms: { g1: [{ botId: 'reviewer', tool: 'message_bot' }] } }, activity: { reviewer: 'sending' } })
  assert.equal(botRunning(state, 'reviewer'), true)
  assert.equal(botMarkState(state, reviewer), 'sending')
})

test('a skill to learn waits without stopping a running turn', () => {
  const learning = { reviewer: [{ id: 'p1', kind: 'agents' }] }
  assert.equal(botMarkState(team({ learning, work: { bots: { reviewer: {} } }, activity: { reviewer: 'working' } }), reviewer), 'working')
  assert.equal(botMarkState(team({ learning }), reviewer), 'alert', 'with no turn running it asks for you')
})

test('a running Bot paused on a tool approval asks for you', () => {
  const state = team({ work: { bots: { reviewer: { tool: 'run_command' } }, approvals: [approval({})] }, activity: { reviewer: 'alert' } })
  assert.equal(botMarkState(state, reviewer), 'alert')
  // A background task's approval waits without stopping the running turn.
  const task = team({ work: { bots: { reviewer: {} }, approvals: [approval({ taskId: 't1' })] }, activity: { reviewer: 'working' } })
  assert.equal(botMarkState(task, reviewer), 'working')
})

test("a group's approval shows on the group, not on the Bot (#1623)", () => {
  const state = team({
    learning: { reviewer: [{ id: 'p1', kind: 'skill', name: 's1' }] },
    work: { bots: { reviewer: {} }, approvals: [approval({ roomId: 'g1' })] },
    activity: { reviewer: 'alert' },
  })
  assert.equal(botMarkState(state, reviewer), 'working')
})

test('questions, cards and requests on the current part ask for you; an old part does not', () => {
  assert.equal(botMarkState(team({ questions: { 'reviewer-p2': { id: 'q1' } } }), reviewer), 'alert')
  assert.equal(botMarkState(team({ views: { 'reviewer-p2': { id: 'v1' } } }), reviewer), 'alert')
  assert.equal(botMarkState(team({ questions: { reviewer: { id: 'q0' } } }), reviewer), 'idle')
  assert.equal(botMarkState(team({ secretRequests: { reviewer: [{ id: 's1', status: 'pending' }] } }), reviewer), 'alert')
  assert.equal(botMarkState(team({ secretRequests: { reviewer: [{ id: 's1', status: 'answered' }] } }), reviewer), 'idle')
  assert.equal(botMarkState(team({ mailRequests: { reviewer: [{ id: 'm1', status: 'pending' }] } }), reviewer), 'alert')
  // A question stops even a running turn.
  assert.equal(botMarkState(team({ questions: { 'reviewer-p2': { id: 'q1' } }, work: { bots: { reviewer: {} } }, activity: { reviewer: 'thinking' } }), reviewer), 'alert')
})

test('waiting for work it handed on, with no turn running', () => {
  assert.equal(botMarkState(team({ activity: { reviewer: 'waiting' }, work: { waiting: { reviewer: { bots: ['coder'] } } } }), reviewer), 'waiting')
  assert.equal(botMarkState(team({}), reviewer), 'idle')
})

test("the activity row: thinking until a tool runs, then the tool's kind", () => {
  assert.equal(workMarkState(undefined), 'thinking')
  assert.equal(workMarkState({ switching: true, tool: 'grep' }), 'thinking')
  assert.equal(workMarkState({ tool: 'grep' }), 'searching')
  assert.equal(workMarkState({ tool: 'message_bot' }), 'sending')
  assert.equal(workMarkState({ tool: 'run_command' }), 'working')
})
