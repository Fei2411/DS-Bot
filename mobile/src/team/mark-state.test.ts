// A Bot's mark on the phone moves as the desktop sidebar's does (sidebar.js BotRow). The
// team state here has the shapes the computer sends (host/channel.js `live`: `activity`
// from turns.js activityView is one word per Bot; `work` from workView, roomWorkView and
// approvalsView), and the cases are the desktop's own (test/sidebar-approval-status.test.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isComputerHandoff } from '../../../ds-bot/src/client/mark-states.js'
import type { Bot, TeamState } from '../connection.ts'
import { runningActivityOf, workPhrase } from '../ui/phrases.ts'
import { botMarkState, botPreviewKind, botRunning, hasUnreadBotReply, isTopBlockInView, mergeTeamState, ownWorkOf, shouldCelebrateSettle, workMarkState } from './mark-state.ts'

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

test('a browser or computer handoff blocks even a running turn, matching desktop dmMarkState', () => {
  const handoff = { reviewer: { callId: 'h1', reason: 'sign in' } }
  assert.equal(botMarkState(team({ browserHolds: handoff }), reviewer), 'alert')
  assert.equal(botMarkState(team({ browserHolds: handoff, work: { bots: { reviewer: {} } }, activity: { reviewer: 'working' } }), reviewer), 'alert')
  // A manual browser takeover (no callId) does not alert.
  assert.equal(botMarkState(team({ browserHolds: { reviewer: { reason: 'manual' } } }), reviewer), 'idle')
  // Computer-use handoff and app approval ask behave identically.
  const compAsk = { asks: { a1: { id: 'a1', botId: 'reviewer', appName: 'Safari' } } }
  assert.equal(botMarkState(team({ computerLive: compAsk, work: { bots: { reviewer: {} } }, activity: { reviewer: 'working' } }), reviewer), 'alert')
  // Group computer-use ask shows on the group, not on the Bot (#1623).
  const groupCompAsk = { asks: { a2: { id: 'a2', botId: 'reviewer', roomId: 'g1', appName: 'Safari' } } }
  assert.equal(botMarkState(team({ computerLive: groupCompAsk, work: { bots: { reviewer: {} } }, activity: { reviewer: 'working' } }), reviewer), 'working')
  assert.equal(botMarkState(team({ computerLive: { holds: { reviewer: { by: 'bot', reason: 'sign in' } } } }), reviewer), 'alert')
  assert.equal(botMarkState(team({ computerLive: { holds: { reviewer: { reason: 'takeover' } } } }), reviewer), 'idle')
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
  assert.equal(workMarkState('searching'), 'searching')
  assert.equal(workMarkState('waiting'), 'thinking')
})

test('between-turn states (#2305): failed, background tasks, and unread replies follow desktop priority', () => {
  const blockedBot = { ...reviewer, blocked: { code: 'auth', at: 1 }, latestTurn: 9 } as Bot
  assert.equal(botMarkState(team({}), blockedBot, { replied: true }), 'failed')
  // Last-turn failure on the current part yields failed; a newer host latestTurn (e.g. a stopped retry) clears it.
  const failedBot = { ...reviewer, failures: { 'reviewer-p2': { turn: 4, code: 'err' } } } as Bot
  assert.equal(botMarkState(team({}), failedBot), 'failed')
  assert.equal(botMarkState(team({}), { ...failedBot, latestTurn: 4 }), 'failed')
  assert.equal(botMarkState(team({}), { ...failedBot, latestTurn: 5 }), 'idle')
  assert.equal(botMarkState(team({}), failedBot, { latestTurn: 5 }), 'idle')
  // A failure on an older part does not count.
  const oldFailedBot = { ...reviewer, failures: { reviewer: { turn: 2, code: 'err' } } } as Bot
  assert.equal(botMarkState(team({}), oldFailedBot), 'idle')
  // Alert outranks failed; running outranks failed.
  assert.equal(botMarkState(team({ questions: { 'reviewer-p2': { id: 'q1' } } }), failedBot), 'alert')
  assert.equal(botMarkState(team({ work: { bots: { reviewer: {} } }, activity: { reviewer: 'thinking' } }), failedBot), 'thinking')
  // Background DM tasks show 'background' (group tasks do not); waiting_approval escalates to 'alert' when idle.
  const bgBot = { ...reviewer, tasks: [{ id: 't1', title: 'Build', status: 'running', sessionId: 's-t1' }] } as Bot
  assert.equal(botMarkState(team({}), bgBot, { replied: true }), 'background')
  const groupBgBot = { ...reviewer, tasks: [{ id: 't1', title: 'Build', status: 'running', sessionId: 's-t1', roomId: 'g1' }] } as Bot
  assert.equal(botMarkState(team({}), groupBgBot), 'idle')
  const bgApproveBot = { ...reviewer, tasks: [{ id: 't1', title: 'Deploy', status: 'waiting_approval', sessionId: 's-t1' }] } as Bot
  assert.equal(botMarkState(team({}), bgApproveBot), 'alert')
  assert.equal(botMarkState(team({ work: { bots: { reviewer: {} } }, activity: { reviewer: 'working' } }), bgApproveBot), 'working')
  // Unread reply shows 'replied' when otherwise idle.
  assert.equal(botMarkState(team({}), reviewer, { replied: true }), 'replied')
  assert.equal(botMarkState(team({}), reviewer, { replied: false }), 'idle')
})

test('hasUnreadBotReply only fires for unread Bot replies, never a newer user message', () => {
  assert.equal(hasUnreadBotReply({ lastAt: 200, lastBotAt: 200 }, true), true)
  assert.equal(hasUnreadBotReply({ lastAt: 200, lastBotAt: 200 }, false), false)
  // User sent a message on desktop after an earlier bot reply and stopped before the Bot answered.
  assert.equal(hasUnreadBotReply({ lastAt: 250, lastBotAt: 200 }, true), false)
  // No bot reply recorded yet (or older host without lastBotAt).
  assert.equal(hasUnreadBotReply({ lastAt: 250 }, true), false)
})

test('runningActivityOf, ownWorkOf, and workPhrase separate DM foreground work from group work', () => {
  assert.equal(runningActivityOf(undefined, 'waiting'), undefined)
  assert.equal(runningActivityOf(undefined, 'alert'), undefined)
  assert.equal(runningActivityOf(undefined, 'thinking'), 'thinking')
  assert.equal(runningActivityOf(undefined, 'searching'), 'searching')
  assert.equal(runningActivityOf({ tool: 'web_search', roomId: 'g1' }, 'searching'), undefined)
  const detail = { tool: 'run_command', said: 'Running tests' }
  assert.equal(runningActivityOf(detail, 'waiting'), detail)
  // Real host shape: Bot working only in a group carries work.bots[id].roomId AND activity[id].
  const groupOnly = team({
    work: { bots: { reviewer: { tool: 'web_search', roomId: 'g1' } }, rooms: { g1: [{ botId: 'reviewer', tool: 'web_search' }] } },
    activity: { reviewer: 'searching' },
  })
  assert.equal(ownWorkOf(groupOnly, 'reviewer'), undefined)
  const roomOnly = team({ work: { rooms: { g1: [{ botId: 'reviewer', tool: 'web_search' }] } }, activity: { reviewer: 'searching' } })
  assert.equal(ownWorkOf(roomOnly, 'reviewer'), undefined)
  const dmWork = team({ work: { bots: { reviewer: detail }, rooms: { g1: [{ botId: 'reviewer', tool: 'web_search' }] } }, activity: { reviewer: 'working' } })
  assert.equal(ownWorkOf(dmWork, 'reviewer'), detail)
  assert.equal(workPhrase('thinking'), 'Thinking about it')
  assert.equal(workPhrase('searching'), 'Searching online')
  assert.equal(workPhrase('working'), 'On it')
})

test('isTopBlockInView tracks whether the details avatar scrolled out of the viewport', () => {
  assert.equal(isTopBlockInView(0, 0), true)
  assert.equal(isTopBlockInView(0, 120), true)
  assert.equal(isTopBlockInView(119, 120), true)
  assert.equal(isTopBlockInView(120, 120), false)
  assert.equal(isTopBlockInView(200, 120), false)
})

test('isComputerHandoff handles null and empty reason strings safely, matching host inbox', () => {
  assert.equal(isComputerHandoff(undefined), false)
  assert.equal(isComputerHandoff(null), false)
  assert.equal(isComputerHandoff({ by: 'user', reason: '' }), false)
  assert.equal(isComputerHandoff({ by: 'user', reason: 'takeover' }), false)
  assert.equal(isComputerHandoff({ by: 'user', reason: 'sign in' }), true)
  assert.equal(isComputerHandoff({ by: 'bot', reason: '' }), true)
  assert.equal(botMarkState(team({ computerLive: { holds: { reviewer: null } } }), reviewer), 'idle')
  assert.equal(botMarkState(team({ computerLive: { holds: { reviewer: { by: 'user', reason: '' } } } }), reviewer), 'idle')
})

test('botPreviewKind keeps foreground work above deferred background approvals and preserves group work', () => {
  const bgApproval = approval({ taskId: 't1' })
  // Running foreground turn + background approval -> preview shows foreground work, not approval.
  const busy = team({ work: { bots: { reviewer: { tool: 'run_command', said: 'Building' } }, approvals: [bgApproval] }, activity: { reviewer: 'working' } })
  assert.equal(botPreviewKind(busy, reviewer).kind, 'doing')
  // Real host group-only shape: work.bots[id] carries roomId AND work.rooms[g1] lists the member.
  const hostGroupBusy = team({
    work: { bots: { reviewer: { tool: 'write_file', roomId: 'g1' } }, rooms: { g1: [{ botId: 'reviewer', tool: 'write_file' }] }, approvals: [bgApproval] },
    activity: { reviewer: 'working' },
  })
  const groupPreview = botPreviewKind(hostGroupBusy, reviewer)
  assert.equal(groupPreview.kind, 'group')
  assert.equal(groupPreview.roomId, 'g1')
  // Group work + background approval without work.bots -> preview shows group work.
  const groupBusy = team({ work: { rooms: { g1: [{ botId: 'reviewer', tool: 'write_file' }] }, approvals: [bgApproval] } })
  assert.equal(botPreviewKind(groupBusy, reviewer).kind, 'group')
  // Idle + background approval -> preview falls back to approval.
  const idleBg = team({ work: { approvals: [bgApproval] } })
  assert.equal(botPreviewKind(idleBg, reviewer).kind, 'approval')
  // Foreground approval still overrides a running turn.
  const fgApproval = team({ work: { bots: { reviewer: { tool: 'run_command' } }, approvals: [approval({})] } })
  assert.equal(botPreviewKind(fgApproval, reviewer).kind, 'approval')
})

test('shouldCelebrateSettle matches desktop useSettled transitions', () => {
  assert.equal(shouldCelebrateSettle('working', 'idle'), true)
  assert.equal(shouldCelebrateSettle('working', 'replied'), true)
  assert.equal(shouldCelebrateSettle('thinking', 'replied'), true)
  assert.equal(shouldCelebrateSettle('replied', 'idle'), false)
  assert.equal(shouldCelebrateSettle('idle', 'replied'), false)
  assert.equal(shouldCelebrateSettle('failed', 'idle'), false)
  assert.equal(shouldCelebrateSettle('alert', 'idle'), false)
  assert.equal(shouldCelebrateSettle('working', 'failed'), false)
})

test('mergeTeamState projects live botTails onto bots[] on unchanged-revision polls', () => {
  const prev = {
    revision: 5,
    liveKey: 'run:1',
    bots: [{ ...reviewer, lastAt: 100, preview: 'Old', failures: { 'reviewer-p2': { turn: 2, code: 'SERVER' } }, latestTurn: 2 }],
  } as unknown as TeamState
  assert.equal(botMarkState(prev, prev.bots[0]), 'failed')

  // Unchanged-revision poll after a stopped retry + Bot reply carries botTails without bots[].
  const next = {
    revision: 5,
    unchanged: true,
    liveKey: 'run:2',
    botTails: { reviewer: { lastAt: 300, lastBotAt: 300, latestTurn: 3, preview: 'Fixed.' } },
  } as unknown as TeamState
  const merged = mergeTeamState(prev, next)
  assert.equal(merged.bots[0].lastAt, 300)
  assert.equal(merged.bots[0].lastBotAt, 300)
  assert.equal(merged.bots[0].latestTurn, 3)
  assert.equal(merged.bots[0].preview, 'Fixed.')
  assert.equal(botMarkState(merged, merged.bots[0], { replied: hasUnreadBotReply(merged.bots[0], true) }), 'replied')
})
