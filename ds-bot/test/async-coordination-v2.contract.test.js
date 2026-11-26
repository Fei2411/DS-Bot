// Wave 3 real-runtime end-to-end contract tests (Report Section 7, Scenarios 2–6).
//
// Exercises REAL `node:sqlite` (`coordination-db.js` WAL), REAL DSH Cordis runtime +
// AgentLoop + ToolsService + nativeToolExecutor + JSONL persistence (compatible with both
// native D1–D4 `DSH_HARNESS` and 0.2.2-rc.5 fallback), REAL `dsh-adapter.js`, REAL
// `room-message.js` + `groups.js` + `room-reports.js`, and REAL read-only WAL snapshots.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as nativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  CoordinationError,
  canonicalizeWorkspaceDir,
  install as installCoordDb,
  openCoordinationDb,
} from '../src/host/coordination-db.js'
import { install as installAdapter } from '../src/host/dsh-adapter.js'
import { install as installBotTasks } from '../src/host/bot-tasks.js'
import { install as installGroups } from '../src/host/groups.js'
import { install as installTurns } from '../src/host/turns.js'
import { createRunCoordinator } from '../src/host/api/runs.js'
import {
  ROOM_MESSAGE_KINDS,
  addressedMembers,
  classifyBotGroupSpeech,
  newCallees,
  resolveUserInvite,
  roomCall,
  roomResult,
  roomVisible,
  waitsOnMember,
} from '../src/host/room-message.js'
import { createRoomReports } from '../src/host/room-reports.js'
import { textOf } from '../src/host/text.js'

const tempDirs = []
function makeHome(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsb-v2-${tag}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 15) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

async function* textStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolCallStream(id, name, args = {}) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class RecordingStreamAdapter extends LlmAdapter {
  constructor(calls, handler) {
    super()
    this.calls = calls
    this.handler = handler
  }

  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  async *stream(options) {
    const messages = options.messages ?? []
    const userTexts = messages.filter(m => m.role === 'user').map(m => textOf(m.content))
    const hasToolResults = messages.some(m => m.role === 'tool')
    const entry = {
      sessionId: options.sessionId,
      userTexts,
      hasToolResults,
      callIndex: this.calls.filter(c => c.sessionId === options.sessionId).length + 1,
    }
    this.calls.push(entry)
    yield* this.handler(options, entry)
  }
}

class RealSessionQuery extends SessionQueryEngine {
  async searchSessions() {
    return { items: [], hasMore: false }
  }

  async searchEvents() {
    throw new Error('searchEvents unused in v2 contract test')
  }
}

async function bootRealEnv(home, { bots = {}, llmHandler, registerTools, onTurnEnd } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(jsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  await ctx.plugin(RealSessionQuery)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ToolsService)
  await ctx.plugin(nativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  const llmCalls = []
  const adapter = new RecordingStreamAdapter(llmCalls, llmHandler ?? (() => textStream('ok')))
  ctx.llm.registerAdapter(['mock'], adapter)
  registerTools?.(ctx)

  const state = { bots, rooms: {}, exchanges: [], questions: {}, views: {}, switching: {} }
  const rt = {
    ctx,
    home,
    state,
    readOnly: () => undefined,
    warn: () => {},
    load: async () => {},
    save: async () => {},
    botOf: id => state.bots[id],
    resolveAgent: async (sessionId) => {
      const live = ctx.agents.get(sessionId)
      if (live) return live
      const resumed = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'm' },
      })
      return resumed.agent
    },
  }

  installCoordDb(rt)
  installAdapter(rt)

  const openTurnBySession = new Map()
  const lastAssistantText = new Map()
  ctx.on('session/event', (session, event) => {
    const sid = session.id
    if (event.type === 'turn/start') {
      openTurnBySession.set(sid, event.data.turn)
      lastAssistantText.delete(sid)
      rt.notifyTurnLifecycle({ type: 'turn/started', sessionId: sid, turn: event.data.turn })
    } else if (event.type === 'user/message') {
      rt.notifyTurnLifecycle({
        type: 'turn/user-message',
        sessionId: sid,
        turn: openTurnBySession.get(sid),
        source: event.data.source,
      })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content).trim()
      if (text !== '') lastAssistantText.set(sid, text)
    } else if (event.type === 'turn/end') {
      const turn = event.data.turn
      const reason = event.data.reason
      const text = lastAssistantText.get(sid) ?? ''
      openTurnBySession.delete(sid)
      onTurnEnd?.({ sessionId: sid, turn, reason, text })
      if (reason.kind === 'yielded') {
        rt.notifyTurnLifecycle({ type: 'turn/yielded', sessionId: sid, turn, reasonKind: 'yielded', text })
      } else if (reason.kind === 'error' || reason.kind === 'blocked') {
        rt.notifyTurnLifecycle({ type: 'turn/failed', sessionId: sid, turn, reasonKind: reason.kind, failure: reason.error })
      } else if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
        rt.notifyTurnLifecycle({
          type: 'turn/aborted',
          sessionId: sid,
          turn,
          reasonKind: reason.kind,
          cancelCause: reason.reason?.kind,
        })
      } else {
        rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: sid, turn, reasonKind: reason.kind, text })
      }
    }
  })

  async function ensureSession(sessionId) {
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.sessions.flush(handle.agent.session)
    return handle
  }

  return { ctx, rt, llmCalls, ensureSession }
}

describe('Wave 3 real-runtime end-to-end coordination contracts (Scenarios 2–8)', () => {
  it('Scenario 2: foreground fast-path bypasses background workspace lock, shared canonical writable dir (including symlinks) serializes write tasks while distinct dirs run concurrently, mid-flight revise does not kill running tool, stopping task 1 spares sibling task and unblocks queued same-dir task', async () => {
    const home = makeHome('s2')
    const dirA = join(home, 'ws-alpha')
    const dirALink = join(home, 'ws-alpha-link')
    const dirB = join(home, 'ws-beta')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    symlinkSync(dirA, dirALink)
    assert.equal(canonicalizeWorkspaceDir(dirALink), canonicalizeWorkspaceDir(dirA))

    const latches = new Map()
    const startedTools = new Set()
    const abortedTools = new Set()

    const { ctx, rt, llmCalls, ensureSession } = await bootRealEnv(home, {
      bots: { botA: { id: 'botA', name: 'Alpha' } },
      registerTools: (c) => {
        c.tools.register({
          name: 'run_slow_cmd',
          description: 'Simulates a long-running background shell command',
          parameters: {
            type: 'object',
            properties: { tag: { type: 'string' } },
            required: ['tag'],
          },
          output: {
            schema: { type: 'object', properties: { tag: { type: 'string' }, done: { type: 'boolean' } }, required: ['tag', 'done'] },
            render: (_a, v) => [{ type: 'text', text: `cmd:${v.tag}:done` }],
          },
          async execute(args, exec) {
            const tag = args.tag
            const latch = Promise.withResolvers()
            latches.set(tag, latch)
            startedTools.add(tag)
            exec.signal?.addEventListener('abort', () => {
              abortedTools.add(tag)
              latch.reject(Object.assign(new Error(`aborted:${tag}`), { name: 'AbortError' }))
            }, { once: true })
            await latch.promise
            return { tag, done: true }
          },
        })
      },
      llmHandler: (options, entry) => {
        if (options.sessionId === 'sess-s2-fg') {
          return textStream('fg-instant-answer')
        }
        if (options.sessionId === 'sess-s2-bg1') {
          if (entry.callIndex === 1) return toolCallStream('call-bg1-1', 'run_slow_cmd', { tag: 'bg1-turn1' })
          if (entry.callIndex === 2) return textStream('bg1-turn1-finished')
          if (entry.callIndex === 3) return toolCallStream('call-bg1-2', 'run_slow_cmd', { tag: 'bg1-turn2' })
          return textStream('bg1-unexpected')
        }
        if (options.sessionId === 'sess-s2-bg2') {
          if (entry.callIndex === 1) return toolCallStream('call-bg2-1', 'run_slow_cmd', { tag: 'bg2-turn1' })
          return textStream('bg2-completed-cleanly')
        }
        if (options.sessionId === 'sess-s2-bg-same') {
          return textStream('bg-same-dir-completed-after-lock-released')
        }
        return textStream('ok')
      },
    })

    try {
      await ensureSession('sess-s2-fg')
      await ensureSession('sess-s2-bg1')
      await ensureSession('sess-s2-bg2')
      await ensureSession('sess-s2-bg-same')

      const fg = rt.coordDb.ensureForegroundWork({
        botId: 'botA',
        sessionId: 'sess-s2-fg',
        workspaceDir: dirA,
      }).work
      const bg1 = rt.coordDb.createWork({
        workId: 'task-s2-1',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:task-s2-1',
        sessionId: 'sess-s2-bg1',
        workspaceDir: dirA,
        workspaceMode: 'write',
        priority: 'background',
      }).work
      // Same canonical workspace via symlink -> MUST serialize behind bg1.
      const bgSame = rt.coordDb.createWork({
        workId: 'task-s2-same',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:task-s2-same',
        sessionId: 'sess-s2-bg-same',
        workspaceDir: dirALink,
        workspaceMode: 'write',
        priority: 'background',
      }).work
      // Distinct canonical workspace -> MUST run in parallel with bg1.
      const bg2 = rt.coordDb.createWork({
        workId: 'task-s2-2',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:task-s2-2',
        sessionId: 'sess-s2-bg2',
        workspaceDir: dirB,
        workspaceMode: 'write',
        priority: 'background',
      }).work
      assert.equal(bg1.workspaceDir, bgSame.workspaceDir, 'symlink workspaceDir must canonicalize identically')
      assert.notEqual(bg1.workspaceDir, bg2.workspaceDir)

      rt.coordDb.receiveMessage({ workId: bg1.workId, kind: 'request', bodyPreview: 'Run slow build 1', wake: true })
      rt.coordDb.receiveMessage({ workId: bgSame.workId, kind: 'request', bodyPreview: 'Run serialized write on same dir', wake: true })
      rt.coordDb.receiveMessage({ workId: bg2.workId, kind: 'request', bodyPreview: 'Run slow build 2 on distinct dir', wake: true })
      await rt.kickScheduler()

      // 2a: Distinct-dir write tasks run concurrently; same-canonical-dir write task stays serialized.
      await waitUntil(() => startedTools.has('bg1-turn1') && startedTools.has('bg2-turn1'))
      assert.equal(
        llmCalls.filter(c => c.sessionId === 'sess-s2-bg-same').length,
        0,
        'same canonical writable workspace (symlink) must serialize behind running write task',
      )
      assert.equal(rt.coordDb.getWork(bgSame.workId).status, 'queued')

      // 2b: Foreground fast-path executes immediately without being blocked by bg1's write workspace lock.
      rt.coordDb.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'What is 2+2?', wake: true })
      await rt.kickScheduler({ workId: fg.workId })
      await waitUntil(() =>
        llmCalls.some(c => c.sessionId === 'sess-s2-fg')
        && rt.coordDb.getWork(fg.workId).status === 'idle',
      )
      assert.equal(abortedTools.size, 0, 'foreground fast-path must not disturb running background commands')

      // 2c: Mid-flight revise on task-s2-1 bumps ONLY task-s2-1 revision and NEVER kills its running tool.
      rt.coordDb.receiveMessage({
        workId: bg1.workId,
        kind: 'revise',
        bodyPreview: 'Include VAT breakdown',
      })
      assert.equal(rt.coordDb.getWork(bg1.workId).revision, 2)
      assert.equal(rt.coordDb.getWork(bg2.workId).revision, 1)
      assert.equal(abortedTools.has('bg1-turn1'), false, 'revise must not abort in-flight command')

      // Release bg1 turn 1 -> because revision changed mid-flight, bg1 MUST NOT settle done;
      // it must automatically re-dispatch turn 2 carrying the revision ONLY to task-s2-1.
      latches.get('bg1-turn1').resolve()
      await waitUntil(() => startedTools.has('bg1-turn2'))
      const bg1RevCall = llmCalls.filter(c => c.sessionId === 'sess-s2-bg1').at(-1)
      assert.ok(bg1RevCall.userTexts.some(t => t.includes('Include VAT breakdown')), 'revision must reach task-s2-1')
      assert.ok(
        llmCalls.filter(c => c.sessionId === 'sess-s2-bg2').every(c => !c.userTexts.some(t => t.includes('Include VAT breakdown'))),
        'revision for task-s2-1 must never leak to task-s2-2',
      )
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s2-bg-same').length, 0, 'same-dir task still serialized during bg1 turn 2')

      // 2d: Stopping task-s2-1 cancels ONLY task-s2-1, spares sibling task-s2-2, AND unblocks queued bgSame!
      await rt.abortWorkExecution(bg1.workId, { reason: 'User stopped task 1' })
      await waitUntil(() =>
        rt.coordDb.getWork(bg1.workId).status === 'stopped'
        && abortedTools.has('bg1-turn2')
        && rt.coordDb.getWork(bgSame.workId).status === 'done',
      )
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s2-bg-same').length, 1)
      assert.equal(abortedTools.has('bg2-turn1'), false, 'stopping task 1 must never abort sibling task 2')
      assert.equal(rt.coordDb.getWork(bg2.workId).status, 'running')

      latches.get('bg2-turn1').resolve()
      await waitUntil(() => rt.coordDb.getWork(bg2.workId).status === 'done')
      assert.equal(rt.coordDb.getWork(bg1.workId).status, 'stopped')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('Scenario 3: multi-party delegations (A & D -> B) stay isolated, D4 ask_back yields deterministically with 0 wrap-up step, D1 zero-wake note does not wake idle work, and late result on cancelled work archives without resurrecting', async () => {
    const home = makeHome('s3')
    let activeAskWaitId
    const bFromATurnEnds = []

    const { ctx, rt, llmCalls, ensureSession } = await bootRealEnv(home, {
      bots: {
        botA: { id: 'botA', name: 'Alice' },
        botB: { id: 'botB', name: 'Bob' },
        botD: { id: 'botD', name: 'Dana' },
      },
      onTurnEnd: (ev) => {
        if (ev.sessionId === 'sess-s3-b-a') bFromATurnEnds.push(ev)
      },
      registerTools: (c) => {
        c.tools.register({
          name: 'ask_back_tool',
          description: 'Ask caller a blocking question and yield turn deterministically via D4',
          parameters: {
            type: 'object',
            properties: {
              askerWorkId: { type: 'string' },
              targetWorkId: { type: 'string' },
              question: { type: 'string' },
            },
            required: ['askerWorkId', 'targetWorkId', 'question'],
          },
          output: {
            schema: { type: 'object', properties: { waitId: { type: 'string' } }, required: ['waitId'] },
            render: (_a, v) => [{ type: 'text', text: `asked:${v.waitId}` }],
          },
          async execute(args, exec) {
            const asked = rt.coordDb.askBack({
              askerWorkId: args.askerWorkId,
              targetWorkId: args.targetWorkId,
              bodyPreview: args.question,
            })
            activeAskWaitId = asked.wait.waitId
            // D4 deterministic yield: must end turn right after tool/result without extra wrap-up LLM call.
            rt.yieldToolTurn(exec, 'waiting_for_answer')
            return { waitId: asked.wait.waitId }
          },
        })
      },
      llmHandler: (options, entry) => {
        if (options.sessionId === 'sess-s3-b-a') {
          if (entry.callIndex === 1) {
            return toolCallStream('call-ask-a', 'ask_back_tool', {
              askerWorkId: 'work-b-from-a',
              targetWorkId: 'fg:botA',
              question: 'Should the quote include tax?',
            })
          }
          // Resumed turn after A answers + revises + silent note attached.
          return textStream('quote-with-tax-for-A')
        }
        if (options.sessionId === 'sess-s3-b-d') {
          return textStream('report-for-D-only')
        }
        if (options.sessionId === 'sess-s3-a') {
          if (entry.userTexts.some(t => t.includes('Should the quote include tax?'))) {
            return textStream('A saw question')
          }
          return textStream('A consumed final quote')
        }
        if (options.sessionId === 'sess-s3-d') {
          return textStream('D consumed report')
        }
        return textStream('unexpected')
      },
    })

    try {
      await ensureSession('sess-s3-a')
      await ensureSession('sess-s3-d')
      await ensureSession('sess-s3-b-a')
      await ensureSession('sess-s3-b-d')
      await ensureSession('sess-s3-b-cancel')

      const fgA = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-s3-a' }).work
      const fgD = rt.coordDb.ensureForegroundWork({ botId: 'botD', sessionId: 'sess-s3-d' }).work

      rt.coordDb.createWork({
        workId: 'work-b-from-a',
        kind: 'task',
        botId: 'botB',
        logicalAddress: 'task:work-b-from-a',
        sessionId: 'sess-s3-b-a',
        workspaceMode: 'isolated',
      })
      rt.coordDb.createWork({
        workId: 'work-b-from-d',
        kind: 'task',
        botId: 'botB',
        logicalAddress: 'task:work-b-from-d',
        sessionId: 'sess-s3-b-d',
        workspaceMode: 'isolated',
      })
      rt.coordDb.createWork({
        workId: 'work-b-cancelled',
        kind: 'task',
        botId: 'botB',
        logicalAddress: 'task:work-b-cancelled',
        sessionId: 'sess-s3-b-cancel',
        workspaceMode: 'isolated',
      })

      // 3a: A and D delegate concurrently to B's isolated peer sessions.
      rt.coordDb.createCall({
        callId: 'call-a-b',
        parentWorkId: fgA.workId,
        childWorkId: 'work-b-from-a',
        callerBotId: 'botA',
        calleeBotId: 'botB',
        required: true,
        initialMessage: { bodyPreview: 'Prepare quote for Alice' },
      })
      rt.coordDb.createCall({
        callId: 'call-d-b',
        parentWorkId: fgD.workId,
        childWorkId: 'work-b-from-d',
        callerBotId: 'botD',
        calleeBotId: 'botB',
        required: true,
        initialMessage: { bodyPreview: 'Prepare report for Dana' },
      })
      await rt.kickScheduler()

      // 3b & 3c: work-b-from-a calls ask_back -> D4 yields -> waiting with ZERO extra wrap-up LLM call,
      // while work-b-from-d finishes independently and wakes Dana ONLY.
      await waitUntil(() =>
        rt.coordDb.getWork('work-b-from-a').status === 'waiting'
        && rt.coordDb.getWork('work-b-from-d').status === 'done'
        && llmCalls.some(c => c.sessionId === 'sess-s3-d'),
      )
      assert.ok(activeAskWaitId, 'ask_back_tool must create an open ask wait')
      assert.equal(
        llmCalls.filter(c => c.sessionId === 'sess-s3-b-a').length,
        1,
        'D4 yieldTurn must end the turn immediately after tool/result with 0 extra wrap-up LLM steps',
      )
      assert.equal(bFromATurnEnds.length, 1)
      if (rt.dshCapabilities().yieldTurn) {
        assert.equal(bFromATurnEnds[0].reason.kind, 'yielded', 'native DSH must emit turn/end reason yielded')
      }

      // 3c-note: D1 zero-wake silent note while work-b-from-a is waiting MUST NOT wake it.
      const bACallsBeforeNote = llmCalls.filter(c => c.sessionId === 'sess-s3-b-a').length
      await rt.dispatchNote('work-b-from-a', 'Context note: currency is USD', {
        workId: 'work-b-from-a',
        sessionId: 'sess-s3-b-a',
        idempotencyKey: 'note-s3-usd',
      })
      await new Promise(r => setTimeout(r, 80))
      assert.equal(
        llmCalls.filter(c => c.sessionId === 'sess-s3-b-a').length,
        bACallsBeforeNote,
        'D1 silent note must produce 0 extra wakes',
      )

      // 3d: A revises ("含税") and answers ask_back -> work-b-from-a resumes with revision + answer + note,
      // settles call-a-b, and wakes Alice ONLY (never Dana).
      rt.coordDb.receiveMessage({
        workId: 'work-b-from-a',
        kind: 'revise',
        bodyPreview: '含税报价',
      })
      rt.coordDb.receiveMessage({
        workId: 'work-b-from-a',
        kind: 'answer',
        waitId: activeAskWaitId,
        bodyPreview: 'Yes, include 13% VAT',
      })
      await rt.kickScheduler()

      await waitUntil(() =>
        rt.coordDb.getWork('work-b-from-a').status === 'done'
        && rt.coordDb.getCall('call-a-b').status === 'done'
        && llmCalls.some(c => c.sessionId === 'sess-s3-a' && c.userTexts.some(t => t.includes('quote-with-tax-for-A'))),
      )
      const bAResumedCall = llmCalls.filter(c => c.sessionId === 'sess-s3-b-a').at(-1)
      assert.ok(bAResumedCall.userTexts.some(t => t.includes('含税报价')))
      assert.ok(bAResumedCall.userTexts.some(t => t.includes('Yes, include 13% VAT')))
      assert.ok(bAResumedCall.userTexts.some(t => t.includes('currency is USD')), 'D1 silent note must attach on the next real waking turn')

      // Strict isolation: Dana's session never received Alice's revision or quote; Alice never received Dana's report.
      assert.ok(llmCalls.filter(c => c.sessionId === 'sess-s3-d').every(c => !c.userTexts.some(t => t.includes('含税报价') || t.includes('quote-with-tax-for-A'))))
      assert.ok(llmCalls.filter(c => c.sessionId === 'sess-s3-a').every(c => !c.userTexts.some(t => t.includes('report-for-D-only'))))

      // 3e: Cancelled work receiving a late result archives it without resurrecting or invoking LLM.
      await rt.abortWorkExecution('work-b-cancelled', { reason: 'Cancelled before late result' })
      assert.equal(rt.coordDb.getWork('work-b-cancelled').status, 'stopped')
      const late = rt.coordDb.receiveMessage({
        workId: 'work-b-cancelled',
        kind: 'result',
        bodyPreview: 'late-result-after-cancel',
      })
      assert.equal(late.accepted, true)
      assert.equal(late.archived, true)
      assert.equal(late.readyEnqueued, false)
      assert.equal(rt.coordDb.getWork('work-b-cancelled').status, 'stopped')
      await rt.kickScheduler()
      await new Promise(r => setTimeout(r, 60))
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s3-b-cancel').length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('Scenario 4: group 3-way protocol (visible / invite / call) and strict zero-echo — body @mentions trigger 0 wakes while explicit delegation settles and wakes caller exactly once', async () => {
    const home = makeHome('s4')
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
      botC: { id: 'botC', name: 'Carol', color: '#333' },
    }
    const members = Object.values(bots)
    const room = {
      id: 'room-design',
      name: 'Design',
      admin: 'botA',
      members: ['botA', 'botB', 'botC'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-s4-a', botB: 'sess-s4-b', botC: 'sess-s4-c' },
    }

    const { ctx, rt, llmCalls, ensureSession } = await bootRealEnv(home, {
      bots,
      llmHandler: (options) => {
        if (options.sessionId === 'sess-s4-b') return textStream('@Alice @Carol Pricing review done!')
        if (options.sessionId === 'sess-s4-c') return textStream('@Alice @Bob Legal review done!')
        if (options.sessionId === 'sess-s4-a') return textStream('@Bob @Carol Thanks everyone, summary finalized!')
        return textStream('unexpected')
      },
    })

    const records = []
    Object.assign(rt, {
      teamTools: [],
      live: new Map(),
      roomInbox: new Map(),
      roomProgress: new Map(),
      roomWaiters: new Map(),
      groupOwners: new Map(),
      pastOwners: new Map(),
      chatOwners: new Map(),
      roomOf: id => (id === room.id ? room : undefined),
      chatOf: id => `sess-s4-${id.slice(-1).toLowerCase()}`,
      sessionOfRoom: r => `room-sess-${r.id}`,
      isAdminOf: (r, id) => r.admin === id,
      ownRequest: () => false,
      deliver: async () => {},
      rememberImReplyOrigin: () => {},
      ledger: {
        importer: () => {},
        open: () => ({ bySeq: new Map() }),
        after: () => [],
        append: (_book, rec) => { records.push(rec) },
        records: () => records,
        range: (_book, from, to) => records.filter(r => r.seq >= from && r.seq <= to),
      },
    })
    installGroups(rt)

    try {
      await ensureSession('sess-s4-a')
      await ensureSession('sess-s4-b')
      await ensureSession('sess-s4-c')
      await ensureSession('room-sess-room-design')

      // 4a: Protocol invariants for visible / invite / call.
      assert.deepEqual(ROOM_MESSAGE_KINDS, ['visible', 'invite', 'call'])
      const invite = resolveUserInvite({ members, adminId: 'botA', mode: 'admin', mentions: { all: false, found: [] } })
      assert.deepEqual(invite, { kind: 'invite', to: ['botA'], reason: 'user_admin' })
      assert.deepEqual(addressedMembers(roomVisible(), members, 'botA'), [])
      assert.deepEqual(newCallees(roomVisible(), members), [])

      // 4b: Alice explicitly calls Bob & Carol via real `groups.js` (`openRoomCall`).
      const batch = rt.openRoomCall(room, 'botA', [bots.botB, bots.botC])
      assert.equal(batch.children.length, 2)
      const [bobSlot, carolSlot] = batch.children
      const aliceParent = batch.parentWork
      assert.equal(rt.coordDb.listWaits({ workId: aliceParent.workId, kind: 'call', status: 'open' }).length, 2)

      // Execute Bob's real DSH turn -> body contains `@Alice @Carol`, MUST create 0 new callees.
      const bobAgent = await rt.resolveAgent('sess-s4-b')
      const bobDone = Promise.withResolvers()
      const offBob = ctx.on('session/event', (session, ev) => {
        if (session.id === 'sess-s4-b' && ev.type === 'turn/end') bobDone.resolve(ev.data.reason)
      })
      bobAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Bob: review pricing' }],
        source: { kind: 'user' },
      }))
      const bobReason = await bobDone.promise
      offBob()
      assert.equal(bobReason.kind, 'completed')

      const bobRoute = classifyBotGroupSpeech({ activeCallId: bobSlot.call.callId, askedBy: 'botA' })
      assert.equal(bobRoute.kind, 'result')
      assert.deepEqual(newCallees(bobRoute, members), [], 'body @Carol in Bob result must spawn 0 new calls')

      // Settle ONLY Bob -> Carol still pending, so Alice MUST NOT be ready/woken yet!
      const bobSettle = rt.coordDb.settleWork({
        workId: bobSlot.work.workId,
        outcome: 'done',
        force: true,
        summary: '@Alice @Carol Pricing review done!',
      })
      assert.equal(bobSettle.settled, true)
      assert.deepEqual(bobSettle.wokenParents, [], 'Alice must wait until Carol also settles')

      // Execute Carol's real DSH turn -> body contains `@Alice @Bob`, MUST create 0 new callees.
      const carolAgent = await rt.resolveAgent('sess-s4-c')
      const carolDone = Promise.withResolvers()
      const offCarol = ctx.on('session/event', (session, ev) => {
        if (session.id === 'sess-s4-c' && ev.type === 'turn/end') carolDone.resolve(ev.data.reason)
      })
      carolAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Carol: review legal' }],
        source: { kind: 'user' },
      }))
      const carolReason = await carolDone.promise
      offCarol()
      assert.equal(carolReason.kind, 'completed')

      const carolRoute = classifyBotGroupSpeech({ activeCallId: carolSlot.call.callId, askedBy: 'botA' })
      assert.equal(carolRoute.kind, 'result')
      assert.deepEqual(newCallees(carolRoute, members), [], 'body @Bob in Carol result must spawn 0 new calls')

      // Settle Carol -> ALL required waits now closed -> Alice wakes EXACTLY ONCE!
      const carolSettle = rt.coordDb.settleWork({
        workId: carolSlot.work.workId,
        outcome: 'done',
        force: true,
        summary: '@Alice @Bob Legal review done!',
      })
      assert.deepEqual(carolSettle.wokenParents, [aliceParent.workId])
      assert.equal(rt.coordDb.peekReady({ botId: 'botA' }).filter(r => r.workId === aliceParent.workId).length, 1)

      // Alice runs her single summary turn (`@Bob @Carol Thanks everyone...`), classified as `visible` -> 0 echo wakes!
      const aliceAgent = await rt.resolveAgent('sess-s4-a')
      const aliceDone = Promise.withResolvers()
      const offAlice = ctx.on('session/event', (session, ev) => {
        if (session.id === 'sess-s4-a' && ev.type === 'turn/end') aliceDone.resolve(ev.data.reason)
      })
      aliceAgent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Summary batch arrived: Bob + Carol finished' }],
        source: { kind: 'user' },
      }))
      const aliceReason = await aliceDone.promise
      offAlice()
      assert.equal(aliceReason.kind, 'completed')

      const aliceConfirmRoute = classifyBotGroupSpeech({ resultRef: 'G2', activeCallId: 'ignored', askedBy: 'botB' })
      assert.deepEqual(aliceConfirmRoute, { kind: 'visible' })
      assert.deepEqual(addressedMembers(aliceConfirmRoute, members, 'botA'), [])
      assert.deepEqual(newCallees(aliceConfirmRoute, members), [])

      // Explicit `roomCall` still resolves explicit callees cleanly.
      assert.deepEqual(newCallees(roomCall(['botB']), members).map(m => m.id), ['botB'])

      // Total LLM calls across the entire group round: exactly 1 Bob + 1 Carol + 1 Alice = 3 (0 echo wakes).
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s4-b').length, 1)
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s4-c').length, 1)
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s4-a').length, 1)

      // Also verify room-reports settles exactly once into fg:botA with protocol header.
      const fgA = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-s4-a' }).work
      records.push({ seq: 1, who: 'Alice', botId: 'botA', text: 'Check spec', openingPost: true, time: 1 })
      records.push({ seq: 2, who: 'Bob', botId: 'botB', text: '@Alice @Carol Pricing review done!', time: 2 })
      room.seq = 2
      const reports = createRoomReports(rt, {
        hasActiveRoomCalls: () => false,
        exitMemberRoomCalls: async () => {},
        activeInRoom: () => false,
        runningRound: () => undefined,
        isFinalizing: () => false,
        laterPostsOf: () => [],
        bookOf: id => `group-${id}`,
        ensureRoomLog: () => {},
        rowOf: rec => ({ botId: rec.botId, name: rec.who, text: rec.text, kind: rec.kind }),
        saveSoon: () => {},
        nextRoomSeq: r => r.seq + 1,
      })
      reports.openRoomReportCall(room, { id: 'rep-s4', botId: 'botA', name: 'Alice', status: 'tracking', fromSeq: 1, parentWorkId: fgA.workId })
      await reports.settleRoomReports(room.id)
      const fgInbox = rt.coordDb.listInbox(fgA.workId).filter(m => m.kind === 'result')
      assert.equal(fgInbox.length, 1)
      assert.ok(fgInbox[0].payload.renderedText.startsWith('[Group chat "Design" · replies to your post]\n'))

      // 4c: Fail-closed `recordDirectDeliveryAttempt`: when SQLite write fails in real `group_relay` ->
      // `runRoundFrom` -> `memberTurn` -> `roomTurn`, `rt.deliver` MUST NOT be invoked, and final SQLite
      // status MUST stay `needs_verification(delivery_attempt_unpersisted)` (never overwritten to `failed`).
      let failClosedDeliverCalls = 0
      let attemptCalls = 0
      const origDeliver = rt.deliver
      const origRecordAttempt = rt.coordDb.recordDirectDeliveryAttempt
      rt.deliver = async () => { failClosedDeliverCalls += 1 }
      rt.ensureCapabilities = async () => {}
      rt.coordDb.recordDirectDeliveryAttempt = () => {
        attemptCalls += 1
        throw Object.assign(new Error('SQLITE_FULL: disk full'), { code: 'SQLITE_FULL' })
      }
      try {
        const groupRelay = rt.teamTools.find(t => t.name === 'group_relay')
        assert.ok(groupRelay, 'expected real group_relay tool registered by groups.js')
        const roomAgent = await rt.resolveAgent('room-sess-room-design')
        rt.roomInbox.set(room.id, [{
          botId: 'botA',
          name: 'Alice',
          text: 'Delegate to Bob under disk failure',
          route: roomCall(['botB']),
        }])
        await groupRelay.execute(
          { roundId: 'r-fail-closed' },
          { agent: { id: room.id, session: roomAgent.session }, callId: 'r-fail-closed', concludeTurn: () => {} },
        )
        await waitUntil(() => attemptCalls > 0 && rt.roomProgress.size === 0)
        assert.equal(failClosedDeliverCalls, 0, 'rt.deliver must NEVER fire when recordDirectDeliveryAttempt fails')
        const failedWorks = rt.coordDb.listWorks({ kind: 'room_work', limit: 50 })
          .filter(w => w.botId === 'botB' && w.pauseReason === 'delivery_attempt_unpersisted')
        assert.equal(failedWorks.length, 1, 'expected persisted fail-closed room_work after memberTurn completes')
        assert.equal(failedWorks[0].status, 'needs_verification', 'memberTurn must NOT overwrite needs_verification to failed')
      } finally {
        rt.deliver = origDeliver
        rt.coordDb.recordDirectDeliveryAttempt = origRecordAttempt
      }

      // 4d: P1-1 `lateRoomReply` zero-TOCTOU fast-child races ->
      // (1) Interleaving #1: Bob enters `lateRoomReply` with Carol's wait STILL OPEN; Carol settles MID-AWAIT
      //     during `await postToRoom(...)` (closing wait & writing unread `result` while Bob is still `running`).
      //     Bob MUST re-check SQLite after the await and trigger the synthesis wake (NEVER park silently in `waiting`).
      // (2) Interleaving #2: Bob enters `lateRoomReply` with 0 open waits & 0 unread results; Carol settles MID-AWAIT
      //     during `await rt.turnChanges(...)`. Bob's post-await zero-await critical section MUST catch Carol's
      //     unread result, NEVER settle Bob `done`, and trigger Bob's synthesis wake!
      const lateWakes = []
      const offLateWake = ctx.on('session/event', (session, event) => {
        if (session.id !== 'room-sess-room-design' || event.type !== 'agent/inbox/spliced') return
        for (const msg of event.data?.inserted ?? []) {
          if (msg?.source?.role === 'post' && msg.source.resumeWorkId) {
            lateWakes.push(msg.source)
          }
        }
      })
      const origTurnChanges = rt.turnChanges
      const origSave = rt.save
      try {
        rt.groupOwners.set('sess-s4-b', { roomId: room.id, botId: 'botB' })
        rt.groupOwners.set('sess-s4-c', { roomId: room.id, botId: 'botC' })

        // --- Interleaving #1: open wait at entry -> Carol settles DURING `await postToRoom` via real `rt.lateRoomReply` ---
        const outer1 = rt.openRoomCall(room, 'botA', [bots.botB])
        const bobLate1 = outer1.children[0].work
        const nested1 = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobLate1.workId })
        const carolFast1 = nested1.children[0].work
        let injectedDuringPost = false
        rt.save = async () => {
          if (!injectedDuringPost) {
            injectedDuringPost = true
            // Carol finishes through REAL `lateRoomReply` -> `settleRoomCallWork` mid-await while Bob is inside `await postToRoom(...)`!
            await rt.lateRoomReply(
              'sess-s4-c',
              { role: 'room', roomId: room.id, askedBy: 'botB', work: carolFast1.workId, exchangeId: 'ex-s4-c-1' },
              'Carol fast check done mid-postToRoom',
              { toolCount: 1 },
            )
          }
          return origSave?.()
        }
        await rt.lateRoomReply(
          'sess-s4-b',
          { role: 'room', roomId: room.id, askedBy: 'botA', work: bobLate1.workId, exchangeId: 'ex-s4-late-1' },
          'Turn 1 progress while Carol open',
          { toolCount: 1 },
        )
        rt.save = origSave
        assert.equal(injectedDuringPost, true)
        assert.equal(rt.coordDb.getWork(carolFast1.workId).status, 'done')
        assert.equal(rt.coordDb.getWork(bobLate1.workId).status, 'waiting', 'Bob must be parked waiting for synthesis (not done)')
        assert.notEqual(rt.coordDb.getWork(outer1.parentWork.workId).status, 'done', 'Alice must NOT settle early')
        assert.equal(lateWakes.filter(w => w.resumeWorkId === bobLate1.workId).length, 1, 'Interleaving #1 must wake Bob for synthesis')
        assert.deepEqual(lateWakes.find(w => w.resumeWorkId === bobLate1.workId)?.wakeSnapshot?.names, ['Carol'])

        // --- Interleaving #2: 0 open waits / 0 unread at entry -> Carol opens & settles DURING `await rt.turnChanges` ---
        const outer2 = rt.openRoomCall(room, 'botA', [bots.botB])
        const bobLate2 = outer2.children[0].work
        let carolFast2Id
        rt.turnChanges = async (sid, turn) => {
          if (sid === 'sess-s4-b' && carolFast2Id === undefined) {
            const nested2 = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobLate2.workId })
            carolFast2Id = nested2.children[0].work.workId
            await rt.lateRoomReply(
              'sess-s4-c',
              { role: 'room', roomId: room.id, askedBy: 'botB', work: carolFast2Id, exchangeId: 'ex-s4-c-2' },
              'Carol fast check done mid-turnChanges',
              { toolCount: 1 },
            )
          }
          return origTurnChanges?.(sid, turn)
        }
        await rt.lateRoomReply(
          'sess-s4-b',
          { role: 'room', roomId: room.id, askedBy: 'botA', work: bobLate2.workId, exchangeId: 'ex-s4-late-2' },
          'Turn 1 reply racing Carol inside turnChanges',
          { toolCount: 1 },
        )
        assert.ok(carolFast2Id)
        assert.equal(rt.coordDb.getWork(carolFast2Id).status, 'done')
        assert.equal(rt.coordDb.getWork(bobLate2.workId).status, 'waiting', 'Interleaving #2 MUST NOT settle Bob done')
        assert.notEqual(rt.coordDb.getWork(outer2.parentWork.workId).status, 'done', 'Alice must NOT settle prematurely')
        assert.equal(lateWakes.filter(w => w.resumeWorkId === bobLate2.workId).length, 1, 'Interleaving #2 must trigger synthesis wake')

        // --- Interleaving #3: Carol opens during `await rt.turnChanges` (wait stays OPEN), then
        //     Carol settles DURING Bob's post-park `await rt.save()`. `settleRoomCallWork(Carol)`
        //     already wakes & claims Bob (`running`); Bob's post-save check MUST be a strict no-op
        //     (EXACTLY ONE synthesis wake, and Bob MUST stay `running` — NEVER dragged back to `waiting`). ---
        rt.turnChanges = origTurnChanges
        rt.save = origSave
        const outer3 = rt.openRoomCall(room, 'botA', [bots.botB])
        const bobLate3 = outer3.children[0].work
        let carolFast3Id
        let settledDuringPostParkSave = false
        rt.turnChanges = async (sid, turn) => {
          if (sid === 'sess-s4-b' && carolFast3Id === undefined) {
            const nested3 = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobLate3.workId })
            carolFast3Id = nested3.children[0].work.workId
          }
          return origTurnChanges?.(sid, turn)
        }
        rt.save = async () => {
          if (carolFast3Id !== undefined && !settledDuringPostParkSave && rt.coordDb.getWork(bobLate3.workId)?.status === 'waiting') {
            settledDuringPostParkSave = true
            await rt.lateRoomReply(
              'sess-s4-c',
              { role: 'room', roomId: room.id, askedBy: 'botB', work: carolFast3Id, exchangeId: 'ex-s4-c-3' },
              'Carol settled during Bob post-park rt.save()',
              { toolCount: 1 },
            )
          }
          return origSave?.()
        }
        await rt.lateRoomReply(
          'sess-s4-b',
          { role: 'room', roomId: room.id, askedBy: 'botA', work: bobLate3.workId, exchangeId: 'ex-s4-late-3' },
          'Turn 1 reply parking right before Carol settles',
          { toolCount: 1 },
        )
        rt.turnChanges = origTurnChanges
        rt.save = origSave
        assert.equal(settledDuringPostParkSave, true, 'Interleaving #3 must inject Carol settlement during post-park rt.save()')
        assert.equal(rt.coordDb.getWork(carolFast3Id).status, 'done')
        assert.equal(rt.coordDb.getWork(bobLate3.workId).status, 'running', 'Bob must remain claimed running by wake #1 (not dragged back to waiting)')
        assert.equal(lateWakes.filter(w => w.resumeWorkId === bobLate3.workId).length, 1, 'Interleaving #3 MUST produce exactly ONE synthesis wake')
        assert.deepEqual(lateWakes.find(w => w.resumeWorkId === bobLate3.workId)?.wakeSnapshot?.names, ['Carol'])

        // 4e: P1-2 + P2 end-to-end held-state invariants (`paused` / `needs_verification` / `stopping`):
        // (1) `lateRoomFailure` MUST NOT overwrite a paused/needs_verification work to `failed`.
        // (2) Adopted `turn/end` (completed or error) MUST NOT overwrite a paused work to `done` or `failed`.
        // (3) REAL paused slot (`roomResult` resumeWorkId = heldBob.workId, NO monkeypatch on `recordDirectDeliveryAttempt`)
        //     flowing through `group_relay` -> `runRoundFrom` -> `memberTurn` -> `roomTurn` catching `coordination/work_paused`
        //     MUST preserve original `paused(no_progress)` untouched and NEVER deliver into DSH.
        const heldOuter = rt.openRoomCall(room, 'botA', [bots.botB])
        const heldBob = heldOuter.children[0].work
        rt.coordDb.pauseWork(heldBob.workId, { status: 'paused', reason: 'no_progress', detail: { count: 3 } })
        await rt.lateRoomFailure(
          'sess-s4-b',
          { role: 'room', roomId: room.id, askedBy: 'botA', work: heldBob.workId, exchangeId: 'ex-s4-held-fail' },
          { code: 'MODEL_ERR', message: 'Late model failure after pause' },
        )
        const afterLateFail = rt.coordDb.getWork(heldBob.workId)
        assert.equal(afterLateFail.status, 'paused', 'lateRoomFailure must NOT overwrite paused work to failed')
        assert.equal(afterLateFail.pauseReason, 'no_progress')

        // Adopted turn paused mid-flight (`watchAdoptedRoomTurn` receives `turn/end` while work is `paused`) ->
        // MUST keep `paused(user_hold)` untouched and NEVER settle `done` or `failed`!
        const adoptOuter = rt.openRoomCall(room, 'botA', [bots.botB])
        const adoptBob = adoptOuter.children[0].work
        const adoptKey = `room-call:${adoptBob.workId}:ex-s4-adopt-held`
        rt.coordDb.recordDirectDeliveryAttempt({
          workId: adoptBob.workId,
          idempotencyKey: adoptKey,
          sessionId: 'sess-s4-b',
        })
        const bobAgentAdopt = await rt.resolveAgent('sess-s4-b')
        const holdAdopt = Promise.withResolvers()
        void bobAgentAdopt.runMaintenance(async () => { await holdAdopt.promise })
        bobAgentAdopt.followup(createUserMessage({
          content: [{ type: 'text', text: 'Adopted turn that gets paused before turn/end' }],
          source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-s4-adopt-held', idempotencyKey: adoptKey },
        }), { idempotencyKey: adoptKey })
        await ctx.sessions.flush(bobAgentAdopt.session)
        let adoptedTurnEnded = false
        const offPauseMidAdopt = ctx.on('session/event', (session, event) => {
          if (session.id !== 'sess-s4-b') return
          if (event.type === 'user/message' && event.data?.source?.idempotencyKey === adoptKey) {
            rt.coordDb.pauseWork(adoptBob.workId, { status: 'paused', reason: 'user_hold' })
          }
          if (event.type === 'turn/end' && rt.coordDb.getWork(adoptBob.workId)?.status === 'paused') {
            adoptedTurnEnded = true
          }
        })
        try {
          await rt.settleRoomBatches()
          holdAdopt.resolve()
          await waitUntil(() => adoptedTurnEnded)
          await new Promise(r => setTimeout(r, 40))
          const afterAdoptedEnd = rt.coordDb.getWork(adoptBob.workId)
          assert.equal(afterAdoptedEnd.status, 'paused', 'watchAdoptedRoomTurn must NOT overwrite paused work on turn/end')
          assert.equal(afterAdoptedEnd.pauseReason, 'user_hold')
        } finally {
          offPauseMidAdopt()
        }

        // REAL paused slot through `group_relay` -> `runRoundFrom` -> `memberTurn` -> `roomTurn` ->
        // unpatched `recordDirectDeliveryAttempt` throwing `coordination/work_paused`:
        const origDeliver2 = rt.deliver
        let pausedDeliverCalls = 0
        rt.deliver = async () => { pausedDeliverCalls += 1 }
        try {
          const groupRelay2 = rt.teamTools.find(t => t.name === 'group_relay')
          const roomAgent2 = await rt.resolveAgent('room-sess-room-design')
          rt.roomInbox.set(room.id, [{
            botId: 'botC',
            name: 'Carol',
            text: '',
            done: true,
            askedBy: 'botB',
            batch: heldBob.workId,
            parentWorkId: heldBob.workId,
            resumeWorkId: heldBob.workId,
            resumeBy: 'botA',
            route: roomResult('botB', heldBob.workId),
          }])
          await groupRelay2.execute(
            { roundId: 'r-held-paused' },
            { agent: { id: room.id, session: roomAgent2.session }, callId: 'r-held-paused', concludeTurn: () => {} },
          )
          await waitUntil(() => rt.roomProgress.size === 0)
          assert.equal(pausedDeliverCalls, 0, 'paused work must never deliver into DSH')
          const afterPausedAttempt = rt.coordDb.getWork(heldBob.workId)
          assert.equal(afterPausedAttempt.status, 'paused', 'roomTurn catching coordination/work_paused must preserve paused status')
          assert.equal(afterPausedAttempt.pauseReason, 'no_progress', 'original pauseReason must NOT be overwritten to delivery_attempt_unpersisted')
        } finally {
          rt.deliver = origDeliver2
        }

        // 4f: Multi-generation nested synthesis consistency (Merge-when-waiting + Split-when-speaking):
        // (1) Merge-when-waiting: Bob Turn 1 delegates Carol (seq=1) -> Carol finishes fast and queues Bob's
        //     `waiting` synthesis slot; BEFORE synthesis starts speaking, Bob delegates Dave (seq=2) -> Dave
        //     also finishes fast. Dave MUST merge into the waiting synthesis slot (`finished.names` has BOTH
        //     Carol & Dave, `throughSeq === 2`), run EXACTLY ONE synthesis turn whose prompt includes BOTH
        //     (via quiet/owed `slot.finished`, not transcript luck), and ack both seqs on completion.
        // (2) Split-when-speaking: Bob's Gen 1 synthesis slot (`throughSeq === 1`, Carol) is ALREADY `speaking`;
        //     while Gen 1 is mid-delivery, Dave settles (`seq === 2`). Gen 1's `consumeParentResults` MUST
        //     ack ONLY `seq <= 1`, preserving Dave's unread row & `apiMeta`, so Bob does NOT settle `done`
        //     after Gen 1 and instead runs Gen 2 synthesis with Dave before settling `done`.
        bots.botD = { id: 'botD', name: 'Dave', color: '#444' }
        room.members.push('botD')
        room.sessions.botD = 'sess-s4-d'
        rt.groupOwners.set('sess-s4-d', { roomId: room.id, botId: 'botD' })
        await ensureSession('sess-s4-d')
        const origDeliver4f = rt.deliver
        try {
          const groupRelay4f = rt.teamTools.find(t => t.name === 'group_relay')
          const roomAgent4f = await rt.resolveAgent('room-sess-room-design')

          // --- 4f-1: Merge-when-waiting ---
          const bobTurn1Hold = Promise.withResolvers()
          const bobDeliverPrompts1 = []
          let bobCalls1 = 0
          let bobWork1Id
          let daveTriggered = false
          rt.deliver = async (req) => {
            const { sessionId: sid, text, exchangeId } = req
            if (sid === 'sess-s4-b') {
              bobCalls1 += 1
              bobDeliverPrompts1.push(String(text))
              const waiter = rt.roomWaiters.get(exchangeId)
              if (bobCalls1 === 1) {
                bobWork1Id = waiter.slot.workId
                // Delegate Carol first while Bob Turn 1 is still running in the active round.
                await rt.postToRoom(room, bots.botB, 'Carol check part 1', {
                  route: roomCall(['botC']),
                  parentWorkId: bobWork1Id,
                })
                // Wait until Carol finishes and queues Bob's waiting synthesis slot (seq=1).
                await waitUntil(() => {
                  const active = [...rt.roomProgress.values()].find(r => r.roomId === room.id && !r.closed)
                  return active?.slots.some(s => s.workId === bobWork1Id && s.resumedUpstream === true && s.status === 'waiting')
                })
                // Now delegate Dave while Bob Turn 1 is STILL running and synthesis slot is STILL `waiting`!
                daveTriggered = true
                await rt.postToRoom(room, bots.botB, 'Dave check part 2', {
                  route: roomCall(['botD']),
                  parentWorkId: bobWork1Id,
                })
                // Wait until Dave settles and merges into the waiting synthesis slot (`throughSeq >= 2`).
                await waitUntil(() => {
                  const active = [...rt.roomProgress.values()].find(r => r.roomId === room.id && !r.closed)
                  const waitingSlots = active?.slots.filter(s => s.workId === bobWork1Id && s.resumedUpstream === true && s.status === 'waiting') ?? []
                  return waitingSlots.length === 1 && (waitingSlots[0].finished?.names?.includes('Dave') === true)
                })
                const active = [...rt.roomProgress.values()].find(r => r.roomId === room.id && !r.closed)
                const waitingSlots = active.slots.filter(s => s.workId === bobWork1Id && s.resumedUpstream === true && s.status === 'waiting')
                assert.equal(waitingSlots.length, 1, 'Dave must merge into existing waiting synthesis slot (not spawn a 2nd slot)')
                assert.deepEqual([...waitingSlots[0].finished.names].sort(), ['Carol', 'Dave'])
                assert.equal(waitingSlots[0].finished.results.length, 2, 'merged slot.finished.results must carry both Carol and Dave')
                assert.equal(waitingSlots[0].throughSeq, 2)
                bobTurn1Hold.resolve()
                await bobTurn1Hold.promise
                // Simulate transcript window truncation AFTER `room.seen[botB] = seenAt` so synthesis
                // `roomPrompt` MUST inject Carol & Dave via `owed` from `slot.finished`, NOT transcript luck!
                setImmediate(() => {
                  room.seen.botB = room.seq
                  waiter.resolve('Bob Turn 1 progress')
                })
                return
              }
              // Synthesis turn (call #2): settle Bob cleanly.
              setImmediate(() => waiter.resolve('Bob final synthesis with Carol and Dave'))
              return
            }
            if (sid === 'sess-s4-c' || sid === 'sess-s4-d') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve(sid === 'sess-s4-c' ? 'Carol part 1 result' : 'Dave part 2 result'))
              return
            }
            if (sid === 'sess-s4-a') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve('Alice got merged synthesis'))
              return
            }
            return origDeliver4f(req)
          }
          rt.roomInbox.set(room.id, [{
            botId: 'botA',
            name: 'Alice',
            text: 'Bob please coordinate Carol then Dave',
            route: roomCall(['botB']),
          }])
          await groupRelay4f.execute(
            { roundId: 'r-4f-merge' },
            { agent: { id: room.id, session: roomAgent4f.session }, callId: 'r-4f-merge', concludeTurn: () => {} },
          )
          await waitUntil(() => rt.roomProgress.size === 0)
          assert.equal(daveTriggered, true)
          assert.equal(bobCalls1, 2, 'Bob must run Turn 1 + EXACTLY ONE merged synthesis turn')
          assert.match(bobDeliverPrompts1[1], /Carol part 1 result/, 'merged synthesis prompt must include Carol result via owed/slot.finished')
          assert.match(bobDeliverPrompts1[1], /Dave part 2 result/, 'merged synthesis prompt must include Dave result via owed/slot.finished')
          assert.equal(rt.coordDb.listInbox(bobWork1Id, { unreadOnly: true }).filter(m => m.kind === 'result').length, 0)
          assert.equal(rt.coordDb.getWork(bobWork1Id).status, 'done')

          // --- 4f-2: Split-when-speaking (bounded `throughSeq` consumption) ---
          const bobDeliverPrompts2 = []
          let bobCalls2 = 0
          let bobWork2Id
          let unreadAfterGen1Deliver = -1
          let apiMetaDoneAfterGen1Deliver = []
          rt.deliver = async (req) => {
            const { sessionId: sid, text, exchangeId } = req
            if (sid === 'sess-s4-b') {
              bobCalls2 += 1
              bobDeliverPrompts2.push(String(text))
              const waiter = rt.roomWaiters.get(exchangeId)
              if (bobCalls2 === 1) {
                bobWork2Id = waiter.slot.workId
                // Delegate Carol during Turn 1; Carol finishes before Turn 1 returns -> Gen 1 slot queued (`throughSeq = 1`).
                await rt.postToRoom(room, bots.botB, 'Carol check gen 1', {
                  route: roomCall(['botC']),
                  parentWorkId: bobWork2Id,
                })
                await waitUntil(() => {
                  const active = [...rt.roomProgress.values()].find(r => r.roomId === room.id && !r.closed)
                  return active?.slots.some(s => s.workId === bobWork2Id && s.resumedUpstream === true && s.status === 'waiting')
                })
                setImmediate(() => waiter.resolve('Bob Turn 1 done'))
                return
              }
              if (bobCalls2 === 2) {
                // Gen 1 synthesis slot is ALREADY `speaking` (`roomPrompt` built for Carol only, `throughSeq === 1`).
                // Before `rt.deliver` returns (so BEFORE `onDelivered` -> `consumeParentResults(bobWork2Id, 1)` runs),
                // Dave opens & settles `seq = 2` via `lateRoomReply` (outside the round)!
                const nestedDave = rt.openRoomCall(room, 'botB', [bots.botD], { parentWorkId: bobWork2Id })
                await rt.lateRoomReply(
                  'sess-s4-d',
                  { role: 'room', roomId: room.id, askedBy: 'botB', work: nestedDave.children[0].work.workId, exchangeId: 'ex-s4-4f-d2' },
                  'Dave gen 2 result',
                  { toolCount: 1 },
                )
                // After `rt.deliver` returns, `roomTurn` sets `room.seen.botB = seenAt` and invokes
                // `onDelivered()` -> `consumeParentResults(bobWork2Id, 1)`.
                // Advance `room.seen.botB = room.seq` in `setImmediate` so Gen 2 MUST get Dave via `owed` (`slot.finished`)!
                setImmediate(() => {
                  room.seen.botB = room.seq
                  unreadAfterGen1Deliver = rt.coordDb.listInbox(bobWork2Id, { unreadOnly: true }).filter(m => m.kind === 'result').length
                  apiMetaDoneAfterGen1Deliver = [...(rt.coordDb.getWork(bobWork2Id)?.apiMeta?.done ?? [])]
                  waiter.resolve('Bob Gen 1 synthesis (Carol only)')
                })
                return
              }
              // Gen 2 synthesis turn (call #3): receives Dave and settles Bob `done`.
              setImmediate(() => waiter.resolve('Bob Gen 2 synthesis (Dave)'))
              return
            }
            if (sid === 'sess-s4-c') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve('Carol gen 1 result'))
              return
            }
            if (sid === 'sess-s4-a') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve('Alice got split-gen synthesis'))
              return
            }
            return origDeliver4f(req)
          }
          rt.roomInbox.set(room.id, [{
            botId: 'botA',
            name: 'Alice',
            text: 'Bob run split-generation synthesis check',
            route: roomCall(['botB']),
          }])
          await groupRelay4f.execute(
            { roundId: 'r-4f-split' },
            { agent: { id: room.id, session: roomAgent4f.session }, callId: 'r-4f-split', concludeTurn: () => {} },
          )
          await waitUntil(() => rt.roomProgress.size === 0)
          assert.equal(unreadAfterGen1Deliver, 1, 'Gen 1 consumeParentResults(throughSeq=1) MUST leave Dave seq=2 UNREAD')
          assert.ok(apiMetaDoneAfterGen1Deliver.includes('Dave'), 'Gen 1 consumeParentResults MUST preserve Dave in apiMeta.done')
          assert.equal(bobCalls2, 3, 'Bob must run Turn 1 + Gen 1 (Carol) + Gen 2 (Dave)')
          assert.match(bobDeliverPrompts2[1], /Carol gen 1 result/, 'Gen 1 prompt must include Carol result')
          assert.doesNotMatch(bobDeliverPrompts2[1], /Dave gen 2 result/, 'Gen 1 prompt was built before Dave settled')
          assert.match(bobDeliverPrompts2[2], /Dave gen 2 result/, 'Gen 2 prompt MUST include Dave result via owed/slot.finished')
          assert.equal(rt.coordDb.listInbox(bobWork2Id, { unreadOnly: true }).filter(m => m.kind === 'result').length, 0)
          assert.equal(rt.coordDb.getWork(bobWork2Id).status, 'done')

          // --- 4f-3 (P1-2): Split-when-speaking where Gen 2 child FAILS ---
          // Dave fails (`outcome: 'failed'`, seq=2) before Gen 1's `consumeParentResults(throughSeq=1)`.
          // `consumeParentResults` MUST ack ONLY seq<=1, MUST NOT forge Dave into `apiMeta.done`/`doneIds`,
          // and when Gen 1 finishes Bob MUST unwind cleanly to `failed` (0 fake Gen 2 synthesis turns!).
          let bobCalls3 = 0
          let bobWork3Id
          let unreadAfterGen1Fail = []
          let apiMetaAfterGen1Fail
          rt.deliver = async (req) => {
            const { sessionId: sid, exchangeId } = req
            if (sid === 'sess-s4-b') {
              bobCalls3 += 1
              const waiter = rt.roomWaiters.get(exchangeId)
              if (bobCalls3 === 1) {
                bobWork3Id = waiter.slot.workId
                await rt.postToRoom(room, bots.botB, 'Carol check gen 1 (before Dave fails)', {
                  route: roomCall(['botC']),
                  parentWorkId: bobWork3Id,
                })
                await waitUntil(() => {
                  const active = [...rt.roomProgress.values()].find(r => r.roomId === room.id && !r.closed)
                  return active?.slots.some(s => s.workId === bobWork3Id && s.resumedUpstream === true && s.status === 'waiting')
                })
                setImmediate(() => waiter.resolve('Bob Turn 1 done'))
                return
              }
              if (bobCalls3 === 2) {
                // Gen 1 (`throughSeq === 1`, Carol) is `speaking`; before `onDelivered`, Dave FAILS (`seq = 2`).
                const nestedDaveFail = rt.openRoomCall(room, 'botB', [bots.botD], { parentWorkId: bobWork3Id })
                await rt.lateRoomFailure(
                  'sess-s4-d',
                  { role: 'room', roomId: room.id, askedBy: 'botB', work: nestedDaveFail.children[0].work.workId, exchangeId: 'ex-s4-4f-dfail' },
                  { code: 'MODEL_ERR', message: 'Dave crashed in Gen 2' },
                )
                setImmediate(() => {
                  unreadAfterGen1Fail = rt.coordDb.listInbox(bobWork3Id, { unreadOnly: true }).filter(m => m.kind === 'result')
                  apiMetaAfterGen1Fail = { ...(rt.coordDb.getWork(bobWork3Id)?.apiMeta ?? {}) }
                  waiter.resolve('Bob Gen 1 synthesis (Carol only)')
                })
                return
              }
              setImmediate(() => waiter.resolve('UNEXPECTED FAKE GEN 2'))
              return
            }
            if (sid === 'sess-s4-c') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve('Carol gen 1 result (ok)'))
              return
            }
            if (sid === 'sess-s4-a') {
              const waiter = rt.roomWaiters.get(exchangeId)
              setImmediate(() => waiter.resolve('Alice saw unwind'))
              return
            }
            return origDeliver4f(req)
          }
          rt.roomInbox.set(room.id, [{
            botId: 'botA',
            name: 'Alice',
            text: 'Bob run split-generation failed-child check',
            route: roomCall(['botB']),
          }])
          await groupRelay4f.execute(
            { roundId: 'r-4f-fail' },
            { agent: { id: room.id, session: roomAgent4f.session }, callId: 'r-4f-fail', concludeTurn: () => {} },
          )
          await waitUntil(() => rt.roomProgress.size === 0)
          assert.equal(unreadAfterGen1Fail.length, 1, 'Gen 1 must leave Dave failed row seq=2 UNREAD')
          assert.equal(unreadAfterGen1Fail[0].payload?.outcome, 'failed')
          assert.deepEqual(apiMetaAfterGen1Fail.done ?? [], [], 'failed Gen 2 child MUST NEVER be forged into apiMeta.done')
          assert.deepEqual(apiMetaAfterGen1Fail.doneIds ?? [], [], 'failed Gen 2 child MUST NEVER be forged into apiMeta.doneIds')
          assert.deepEqual(apiMetaAfterGen1Fail.results ?? [], [], 'failed Gen 2 child MUST NEVER be forged into apiMeta.results')
          assert.equal(bobCalls3, 2, 'Bob must NOT run a fake Gen 2 synthesis for a failed child')
          assert.equal(rt.coordDb.getWork(bobWork3Id).status, 'failed', 'Bob must unwind cleanly to failed when Gen 2 only has a failed child')
          assert.equal(rt.coordDb.listInbox(bobWork3Id, { unreadOnly: true }).filter(m => m.kind === 'result').length, 0)

          // --- 4f-4 (P1-1): Outside-round `postToRoom -> group Session -> REAL turns.js -> roomInbox -> group_relay` ---
          // Proves `turns.js` preserves `throughSeq` across the group Session serialization boundary so an
          // outside-round / late synthesis wake still carries a durable generation bound during Gen 1 `speaking`.
          const homeOut = makeHome('s4-outside-throughseq')
          const botsOut = {
            botA: { id: 'botA', name: 'Alice', color: '#111' },
            botB: { id: 'botB', name: 'Bob', color: '#222' },
            botC: { id: 'botC', name: 'Carol', color: '#333' },
            botD: { id: 'botD', name: 'Dave', color: '#444' },
          }
          const roomOut = {
            id: 'room-outside',
            name: 'Outside',
            admin: 'botA',
            members: ['botA', 'botB', 'botC', 'botD'],
            seq: 0,
            log: [],
            seen: {},
            sessions: { botA: 'sess-o-a', botB: 'sess-o-b', botC: 'sess-o-c', botD: 'sess-o-d' },
          }
          const outEnv = await bootRealEnv(homeOut, {
            bots: botsOut,
            llmHandler: () => textStream('ok'),
          })
          try {
            const rtOut = outEnv.rt
            rtOut.state.exchangeTurns = {}
            rtOut.state.works = {}
            rtOut.state.questions = {}
            rtOut.state.views = {}
            const outRecords = []
            Object.assign(rtOut, {
              teamTools: [],
              groupOwners: new Map([
                ['sess-o-a', { roomId: roomOut.id, botId: 'botA' }],
                ['sess-o-b', { roomId: roomOut.id, botId: 'botB' }],
                ['sess-o-c', { roomId: roomOut.id, botId: 'botC' }],
                ['sess-o-d', { roomId: roomOut.id, botId: 'botD' }],
              ]),
              pastOwners: new Map(),
              chatOwners: new Map(),
              roomOf: id => (id === roomOut.id ? roomOut : undefined),
              sessionOfRoom: r => r.id,
              isBotSession: id => ['sess-o-a', 'sess-o-b', 'sess-o-c', 'sess-o-d'].includes(id),
              selfOf: id => ({ 'sess-o-a': 'botA', 'sess-o-b': 'botB', 'sess-o-c': 'botC', 'sess-o-d': 'botD' }[id]),
              chatOf: id => `sess-o-${id.slice(-1).toLowerCase()}`,
              isAdminOf: (r, id) => r.admin === id,
              ownRequest: () => false,
              ensureCapabilities: async () => {},
              notify: () => {},
              emitLive: () => {},
              rememberImReplyOrigin: () => {},
              deliver: async () => {},
              ledger: {
                importer: () => {},
                open: () => ({ bySeq: new Map() }),
                after: () => [],
                append: (_book, rec) => { outRecords.push(rec) },
                records: () => outRecords,
                range: (_book, from, to) => outRecords.filter(r => r.seq >= from && r.seq <= to),
              },
            })
            installTurns(rtOut)
            installGroups(rtOut)
            await outEnv.ensureSession('sess-o-a')
            await outEnv.ensureSession('sess-o-b')
            await outEnv.ensureSession('sess-o-c')
            await outEnv.ensureSession('sess-o-d')
            await outEnv.ensureSession(roomOut.id)

            // Open nested Bob work (parked waiting) + Carol child, then settle Carol OUTSIDE any round!
            const outerOut = rtOut.openRoomCall(roomOut, 'botA', [botsOut.botB])
            const bobOutWork = outerOut.children[0].work
            rtOut.coordDb.parkWaiting(bobOutWork.workId)
            const nestedCarolOut = rtOut.openRoomCall(roomOut, 'botB', [botsOut.botC], { parentWorkId: bobOutWork.workId })
            await rtOut.lateRoomReply(
              'sess-o-c',
              { role: 'room', roomId: roomOut.id, askedBy: 'botB', work: nestedCarolOut.children[0].work.workId, exchangeId: 'ex-o-c1' },
              'Carol outside-round gen 1 result',
              { toolCount: 1 },
            )
            // Wait for REAL group Session + REAL `turns.js` to queue the post into `rtOut.roomInbox`!
            await waitUntil(() => (rtOut.roomInbox.get(roomOut.id) ?? []).some(p => p.resumeWorkId === bobOutWork.workId))
            const queuedPost = rtOut.roomInbox.get(roomOut.id).find(p => p.resumeWorkId === bobOutWork.workId)
            assert.equal(queuedPost.throughSeq, 1, 'turns.js MUST preserve throughSeq on roomInbox post')

            // Run REAL `group_relay` from `rtOut.roomInbox`, injecting Dave (seq=2) during Gen 1 `speaking`!
            const outPrompts = []
            let bobOutCalls = 0
            let gen1SlotThroughSeq
            let unreadAfterOutGen1 = -1
            rtOut.deliver = async (req) => {
              const { sessionId: sid, text, exchangeId } = req
              const waiter = rtOut.roomWaiters.get(exchangeId)
              if (sid === 'sess-o-b') {
                bobOutCalls += 1
                outPrompts.push(String(text))
                if (bobOutCalls === 1) {
                  gen1SlotThroughSeq = waiter.slot.throughSeq
                  const nestedDaveOut = rtOut.openRoomCall(roomOut, 'botB', [botsOut.botD], { parentWorkId: bobOutWork.workId })
                  await rtOut.lateRoomReply(
                    'sess-o-d',
                    { role: 'room', roomId: roomOut.id, askedBy: 'botB', work: nestedDaveOut.children[0].work.workId, exchangeId: 'ex-o-d2' },
                    'Dave outside-round gen 2 result',
                    { toolCount: 1 },
                  )
                  setImmediate(() => {
                    roomOut.seen.botB = roomOut.seq
                    unreadAfterOutGen1 = rtOut.coordDb.listInbox(bobOutWork.workId, { unreadOnly: true }).filter(m => m.kind === 'result').length
                    waiter.resolve('Bob outside-round Gen 1 synthesis')
                  })
                  return
                }
                setImmediate(() => waiter.resolve('Bob outside-round Gen 2 synthesis'))
                return
              }
              if (sid === 'sess-o-a') {
                setImmediate(() => waiter.resolve('Alice ack outside-round'))
                return
              }
            }
            const groupRelayOut = rtOut.teamTools.find(t => t.name === 'group_relay')
            const roomAgentOut = await rtOut.resolveAgent(roomOut.id)
            await groupRelayOut.execute(
              { roundId: 'r-outside-throughseq' },
              { agent: { id: roomOut.id, session: roomAgentOut.session }, callId: 'r-outside-throughseq', concludeTurn: () => {} },
            )
            await waitUntil(() => bobOutCalls >= 2 && rtOut.roomProgress.size === 0)
            assert.equal(gen1SlotThroughSeq, 1, 'group_relay -> startRound must propagate throughSeq === 1 onto Gen 1 slot')
            assert.equal(unreadAfterOutGen1, 1, 'outside-round Gen 1 must ack ONLY seq<=1, leaving Dave seq=2 UNREAD')
            assert.equal(bobOutCalls, 2, 'Bob must run Gen 1 (Carol) then Gen 2 (Dave)')
            assert.match(outPrompts[0], /Carol outside-round gen 1 result/)
            assert.doesNotMatch(outPrompts[0], /Dave outside-round gen 2 result/)
            assert.match(outPrompts[1], /Dave outside-round gen 2 result/, 'Gen 2 must deliver Dave via owed/slot.finished')
            assert.equal(rtOut.coordDb.listInbox(bobOutWork.workId, { unreadOnly: true }).filter(m => m.kind === 'result').length, 0)
            assert.equal(rtOut.coordDb.getWork(bobOutWork.workId).status, 'done')
          } finally {
            await outEnv.ctx.fiber.dispose()
          }
        } finally {
          rt.deliver = origDeliver4f
          delete bots.botD
          const dIdx = room.members.indexOf('botD')
          if (dIdx !== -1) room.members.splice(dIdx, 1)
          delete room.sessions.botD
          rt.groupOwners.delete('sess-s4-d')
        }
      } finally {
        rt.turnChanges = origTurnChanges
        rt.save = origSave
        offLateWake()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('Scenario 5: wait-graph cycle rejection (call & ask), 1000-step progressing chain never pauses, and hard-signal stagnation pauses only the stagnant chain until resumed', async () => {
    const home = makeHome('s5')
    const db = openCoordinationDb({ home })
    const room = {
      id: 'room-ops',
      name: 'Ops',
      admin: 'botA',
      members: ['botA', 'botB', 'botC'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 's5-a', botB: 's5-b', botC: 's5-c' },
    }
    const bots = new Map([
      ['botA', { id: 'botA', name: 'Alice', color: '#111' }],
      ['botB', { id: 'botB', name: 'Bob', color: '#222' }],
      ['botC', { id: 'botC', name: 'Carol', color: '#333' }],
    ])
    const records = []
    const rt = {
      home,
      coordDb: db,
      state: { questions: {}, views: {}, switching: {} },
      ctx: { on: () => {}, effect: () => {}, sessions: { flush: async () => {} } },
      teamTools: [],
      live: new Map(),
      roomInbox: new Map(),
      roomProgress: new Map(),
      roomWaiters: new Map(),
      groupOwners: new Map(),
      pastOwners: new Map(),
      chatOwners: new Map(),
      readOnly: () => undefined,
      load: async () => {},
      save: async () => {},
      warn: () => {},
      botOf: id => bots.get(id),
      roomOf: id => (id === room.id ? room : undefined),
      sessionOfRoom: r => `sess-${r.id}`,
      isAdminOf: (r, id) => r.admin === id,
      resolveAgent: async () => ({ followup: () => {}, session: {} }),
      ledger: {
        importer: () => {},
        open: () => ({ bySeq: new Map() }),
        after: () => [],
        append: (_book, rec) => { records.push(rec) },
        records: () => records,
        range: () => [],
      },
    }
    installGroups(rt)

    try {
      // 5a: Call cycle rejection (direct B->A and transitive C->A), recommending `ask`.
      const wA = db.createWork({ workId: 'w5-a', botId: 'botA', kind: 'task', status: 'waiting' }).work
      const wB = db.createWork({ workId: 'w5-b', botId: 'botB', kind: 'task', status: 'waiting', parentWorkId: wA.workId }).work
      const wC = db.createWork({ workId: 'w5-c', botId: 'botC', kind: 'task', status: 'running', parentWorkId: wB.workId }).work
      db.createCall({ callId: 'c5-ab', parentWorkId: wA.workId, childWorkId: wB.workId, callerBotId: 'botA', calleeBotId: 'botB' })
      db.createCall({ callId: 'c5-bc', parentWorkId: wB.workId, childWorkId: wC.workId, callerBotId: 'botB', calleeBotId: 'botC' })

      assert.throws(
        () => db.createCall({ callId: 'c5-ba', parentWorkId: wB.workId, childWorkId: wA.workId, callerBotId: 'botB', calleeBotId: 'botA' }),
        err => err instanceof CoordinationError && err.code === 'coordination/wait_cycle' && err.details?.suggestedAction === 'ask',
      )
      assert.throws(
        () => db.createCall({ callId: 'c5-ca', parentWorkId: wC.workId, childWorkId: wA.workId, callerBotId: 'botC', calleeBotId: 'botA' }),
        err => err instanceof CoordinationError && err.code === 'coordination/wait_cycle' && err.details?.suggestedAction === 'ask',
      )

      // 5b: B asking A (`askBack`) while A->B call is open SUCCEEDS; mutual ask cycle A->B is rejected recommending `user_question`.
      const askBA = db.askBack({ askerWorkId: wB.workId, targetWorkId: wA.workId, bodyPreview: 'Need API key scope' })
      assert.equal(askBA.wait.kind, 'ask')
      assert.throws(
        () => db.askBack({ askerWorkId: wA.workId, targetWorkId: wB.workId, bodyPreview: 'Which scope do you want?' }),
        err => err instanceof CoordinationError && err.code === 'coordination/ask_cycle' && err.details?.suggestedAction === 'user_question',
      )

      // 5c: 1,000-step progressing chain is NEVER truncated by a fixed turn counter.
      const wLong = db.createWork({ workId: 'w5-long-1000', botId: 'botA', kind: 'task', status: 'running' }).work
      for (let step = 1; step <= 1000; step += 1) {
        const res = db.recordProgressCheck({
          workId: wLong.workId,
          unresolvedKey: 'ci:fix-suite',
          workspaceDigest: `git-tree-${step}`,
          outputDigest: `failing-count-${1000 - step}`,
          errorSignature: `err-${step % 7}`,
        })
        assert.equal(res.stagnant, false, `step ${step} made hard-signal progress and must never pause`)
      }
      assert.equal(db.getWork(wLong.workId).status, 'running')

      // 5d: Multi-round hard-signal stagnation pauses ONLY the stagnant chain (sparing wLong) and resumes cleanly.
      const r1 = rt.openRoomCall(room, 'botA', [bots.get('botB')])
      assert.equal(waitsOnMember(db, room.id, 'botB', 'botA'), true)
      const c1 = rt.checkRoomProgressStagnation(room, r1.children[0].work.workId, {
        callerId: 'botA', calleeId: 'botB', text: 'same failing output',
      })
      assert.equal(c1.paused, false)
      db.settleWork({ workId: r1.children[0].work.workId, outcome: 'done', force: true })
      db.settleWork({ workId: r1.parentWork.workId, outcome: 'done', force: true })

      const r2 = rt.openRoomCall(room, 'botA', [bots.get('botB')])
      const c2 = rt.checkRoomProgressStagnation(room, r2.children[0].work.workId, {
        callerId: 'botA', calleeId: 'botB', text: 'same failing output',
      })
      assert.equal(c2.paused, false)
      db.settleWork({ workId: r2.children[0].work.workId, outcome: 'done', force: true })
      db.settleWork({ workId: r2.parentWork.workId, outcome: 'done', force: true })

      const r3 = rt.openRoomCall(room, 'botA', [bots.get('botB')])
      const c3 = rt.checkRoomProgressStagnation(room, r3.children[0].work.workId, {
        callerId: 'botA', calleeId: 'botB', text: 'same failing output',
      })
      assert.equal(c3.paused, true)
      assert.equal(db.getWork('rw_chain:room-ops').status, 'paused')
      assert.equal(db.getWork('rw_chain:room-ops').pauseReason, 'no_progress')
      assert.equal(db.getWork(wLong.workId).status, 'running', 'pausing stagnant chain must NOT pause unrelated works')

      const resumed = await rt.resumeRoomPause(room.id)
      assert.equal(resumed, true)
      assert.equal(db.getWork('rw_chain:room-ops').status, 'idle')
      assert.equal(db.getWork('rw_chain:room-ops').stagnationCount, 0)
    } finally {
      db.close()
    }
  })

  it('Scenario 6: all-entry consistency across foreground, IM origin isolation, external /v1 API Run, unified waits (approval/question/secret), privacy escalation guard, and independent readonly WAL window', async () => {
    const home = makeHome('s6')
    const { ctx, rt, llmCalls, ensureSession } = await bootRealEnv(home, {
      bots: {
        botA: { id: 'botA', name: 'Alice' },
        botPriv: { id: 'botPriv', name: 'Vault', private: true },
      },
      llmHandler: (options) => {
        if (options.sessionId === 'sess-s6-im') return textStream('IM approved task finished')
        if (options.sessionId === 'sess-s6-api') return textStream('API v1 run finished')
        return textStream('fg ok')
      },
    })

    const ro = openCoordinationDb({ home, readonly: true })
    try {
      await ensureSession('sess-s6-fg')
      await ensureSession('sess-s6-im')
      await ensureSession('sess-s6-api')

      // 6a: Desktop foreground, IM-originated task, and External /v1 API Run all live in the single `works` ledger.
      const fg = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-s6-fg' }).work
      const imOrigin = { connId: 'feishu-prod', chatKey: 'oc_team_42', senderId: 'ou_alice' }
      const imWork = rt.coordDb.createWork({
        workId: 'work-s6-im',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-s6-im',
        sessionId: 'sess-s6-im',
        originKind: 'im',
        imOrigin,
        status: 'waiting',
        workspaceMode: 'isolated',
      }).work

      const apiRun1 = rt.coordDb.createWork({
        workId: 'api:run_v1_99',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'api:run_v1_99',
        sessionId: 'sess-s6-api',
        originKind: 'api',
        apiRunId: 'run_v1_99',
        apiIdempotencyKey: 'tok1:botA:idem-99',
        apiMeta: { tokenName: 'ci-runner', mode: 'task' },
        workspaceMode: 'isolated',
      })
      assert.equal(apiRun1.created, true)
      const apiRunDup = rt.coordDb.createWork({
        workId: 'api:run_v1_dup',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'api:run_v1_dup',
        originKind: 'api',
        apiRunId: 'run_v1_dup',
        apiIdempotencyKey: 'tok1:botA:idem-99',
      })
      assert.equal(apiRunDup.deduplicated, true)
      assert.equal(apiRunDup.work.workId, 'api:run_v1_99')

      // 6b: Unified `waits` across approval, user_question, and secret.
      const approvalWait = rt.coordDb.addWait({
        waitId: 'wt-approval-1',
        workId: imWork.workId,
        kind: 'approval',
        targetId: 'apr-1',
        required: true,
        meta: { tool: 'shell', command: 'npm run deploy' },
      }).wait
      rt.coordDb.addWait({
        waitId: 'wt-question-1',
        workId: fg.workId,
        kind: 'user_question',
        targetId: 'q-1',
        required: true,
      })
      rt.coordDb.addWait({
        waitId: 'wt-secret-1',
        workId: fg.workId,
        kind: 'secret',
        targetId: 'sec-1',
        required: true,
      })

      // 6c: Privacy Bot boundary — private work cannot implicitly escalate to room visibility.
      const privWork = rt.coordDb.createWork({
        workId: 'work-s6-priv',
        kind: 'task',
        botId: 'botPriv',
        logicalAddress: 'task:work-s6-priv',
        privacyScoped: true,
        visibility: 'private',
      }).work
      assert.throws(
        () => rt.coordDb.createCall({
          callId: 'call-priv-leak',
          parentWorkId: fg.workId,
          childWorkId: privWork.workId,
          callerBotId: 'botA',
          calleeBotId: 'botPriv',
          visibleScope: 'room',
          roomId: 'room-public',
          explicitPublish: false,
        }),
        err => err instanceof CoordinationError && err.code === 'coordination/privacy_escalation',
      )

      // 6d: Independent readonly WAL window observes identical snapshot and rejects all writes.
      assert.equal(ro.readonly, true)
      const snap = ro.getSnapshot({ botId: 'botA' })
      assert.ok(snap.works.some(w => w.workId === fg.workId))
      assert.ok(snap.works.some(w => w.workId === imWork.workId && w.imOrigin?.chatKey === 'oc_team_42'))
      assert.ok(snap.works.some(w => w.workId === 'api:run_v1_99' && w.apiRunId === 'run_v1_99'))
      assert.deepEqual(
        snap.waits.map(w => w.kind).sort(),
        ['approval', 'secret', 'user_question'],
      )
      assert.throws(
        () => ro.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'illegal write' }),
        err => err instanceof CoordinationError && err.code === 'coordination/readonly',
      )

      // 6e: Resolving approval wakes IM work -> executes via real DSH -> settles with imOrigin intact;
      // API Run executes concurrently and settles cleanly, immediately visible to the readonly WAL window.
      rt.coordDb.resolveWait({
        waitId: approvalWait.waitId,
        status: 'resolved',
        resolution: { decision: 'allowed-once' },
        inboxMessage: { kind: 'answer', bodyPreview: 'Approval granted' },
        wake: true,
      })
      rt.coordDb.receiveMessage({
        workId: 'api:run_v1_99',
        kind: 'request',
        bodyPreview: 'Execute /v1 API task',
        wake: true,
      })
      await rt.kickScheduler()

      await waitUntil(() =>
        rt.coordDb.getWork(imWork.workId).status === 'done'
        && rt.coordDb.getWork('api:run_v1_99').status === 'done',
      )

      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s6-im').length, 1)
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-s6-api').length, 1)

      const roIm = ro.getWork(imWork.workId)
      const roApi = ro.getWorkByApiRunId('run_v1_99')
      assert.equal(roIm.status, 'done')
      assert.deepEqual(roIm.imOrigin, imOrigin, 'IM origin must stay intact for original-channel reply routing')
      assert.equal(roApi.status, 'done')
      assert.equal(ro.listWaits({ workId: imWork.workId, status: 'open' }).length, 0)
    } finally {
      ro.close()
      await ctx.fiber.dispose()
    }
  })

  it('Scenario 7: /v1 API Run persists work + Idempotency-Key + request input to SQLite BEFORE side effects; crash after dispatch never drops Run or duplicates on retry', async () => {
    const home = makeHome('s7')
    const bot = { id: 'botApi', name: 'ApiBot' }
    const principal = {
      keyId: 'key_v1_test',
      name: 'CI Token',
      assertBotAccess: () => ({ ok: true }),
      assertRoomAccess: () => ({ ok: true }),
      canAccessBot: () => true,
      canAccessRoom: () => true,
    }
    const authStub = {
      acquireRunSlot: () => ({ ok: true, release: () => {} }),
    }

    function makeApiRt(db, { startTask, sendUser }) {
      return {
        home,
        ctx: { on: () => () => {} },
        state: { bots: { [bot.id]: bot }, rooms: {}, questions: {}, views: {}, secretRequests: {} },
        coordDb: db,
        readOnly: () => undefined,
        warn: () => {},
        own: (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined),
        botOf: id => (id === bot.id ? bot : undefined),
        roomOf: () => undefined,
        chatOf: () => 'sess-api-chat',
        live: new Map(),
        chatOwners: new Map([['sess-api-chat', bot.id]]),
        startTask,
        sendUser,
      }
    }

    // Phase 1: Verify BOTH task mode and chat mode commit SQLite BEFORE side effects fire,
    // then simulate an immediate crash right inside the side-effecting call (never running syncWorkMeta).
    const db1 = openCoordinationDb({ home })
    const preSideEffectCheck = { task: false, chat: false }
    let taskRunId
    let chatRunId
    const crashErr = Object.assign(new Error('SIMULATED_CRASH_BEFORE_POST_SYNC'), { code: 'test/crash' })
    const runs1 = createRunCoordinator(makeApiRt(db1, {
      startTask: async () => {
        const ro = openCoordinationDb({ home, readonly: true })
        try {
          const found = ro.getWorkByApiIdempotencyKey('key_v1_test\0bot\0botApi\0idem-task-1')
          assert.ok(found, 'task API work + Idempotency-Key must already exist in SQLite BEFORE startTask runs')
          const inbox = ro.listInbox(found.workId)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].kind, 'request')
          assert.equal(inbox[0].payload?.text, 'Deploy build #42')
          taskRunId = found.apiRunId
          preSideEffectCheck.task = true
        } finally {
          ro.close()
        }
        // Hang/abandon process without calling finishRun (simulates SIGKILL right after side effect).
        return await new Promise(() => {})
      },
      sendUser: async () => {
        const ro = openCoordinationDb({ home, readonly: true })
        try {
          const found = ro.getWorkByApiIdempotencyKey('key_v1_test\0bot\0botApi\0idem-chat-1')
          assert.ok(found, 'chat API work + Idempotency-Key must already exist in SQLite BEFORE sendUser runs')
          const inbox = ro.listInbox(found.workId)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].payload?.text, 'Send weekly invoice')
          chatRunId = found.apiRunId
          preSideEffectCheck.chat = true
        } finally {
          ro.close()
        }
        return await new Promise(() => {})
      },
    }), authStub)

    // Fire both requests (their promises stay pending because we simulated SIGKILL inside dispatch).
    void runs1.startBotRun({
      principal,
      bot,
      mode: 'task',
      text: 'Deploy build #42',
      idempotencyKey: 'idem-task-1',
    }).catch(() => crashErr)
    void runs1.startBotRun({
      principal,
      bot,
      mode: 'chat',
      text: 'Send weekly invoice',
      idempotencyKey: 'idem-chat-1',
    }).catch(() => crashErr)

    await waitUntil(() => preSideEffectCheck.task && preSideEffectCheck.chat)
    assert.ok(taskRunId && chatRunId)
    db1.close()

    // Phase 2: Fresh host instance opens the same SQLite DB after restart.
    const db2 = openCoordinationDb({ home })
    let restartedTaskCalls = 0
    let restartedSendCalls = 0
    const runs2 = createRunCoordinator(makeApiRt(db2, {
      startTask: async () => { restartedTaskCalls += 1; return { id: 't-dup', sessionId: 's-dup' } },
      sendUser: async () => { restartedSendCalls += 1 },
    }), authStub)

    try {
      // Both crashed Runs remain queryable (never 404) and reconcile cleanly to stopped(api/host-restarted).
      const fetchedTask = runs2.getRunForPrincipal(taskRunId, principal)
      assert.equal(fetchedTask.ok, true)
      assert.equal(fetchedTask.run.status, 'stopped')
      assert.equal(fetchedTask.run.error?.code, 'api/host-restarted')

      const fetchedChat = runs2.getRunForPrincipal(chatRunId, principal)
      assert.equal(fetchedChat.ok, true)
      assert.equal(fetchedChat.run.status, 'stopped')
      assert.equal(fetchedChat.run.error?.code, 'api/host-restarted')

      // Retrying with the same Idempotency-Key replays the persisted Run with ZERO duplicate side effects!
      const replayTask = await runs2.startBotRun({
        principal,
        bot,
        mode: 'task',
        text: 'Deploy build #42',
        idempotencyKey: 'idem-task-1',
      })
      assert.equal(replayTask.replayed, true)
      assert.equal(replayTask.run.runId, taskRunId)
      assert.equal(restartedTaskCalls, 0)

      const replayChat = await runs2.startBotRun({
        principal,
        bot,
        mode: 'chat',
        text: 'Send weekly invoice',
        idempotencyKey: 'idem-chat-1',
      })
      assert.equal(replayChat.replayed, true)
      assert.equal(replayChat.run.runId, chatRunId)
      assert.equal(restartedSendCalls, 0)

      // Reusing the same Idempotency-Key with a different payload rejects with 409 conflict.
      await assert.rejects(
        () => runs2.startBotRun({
          principal,
          bot,
          mode: 'task',
          text: 'Deploy DIFFERENT build #99',
          idempotencyKey: 'idem-task-1',
        }),
        err => err?.status === 409 && err?.code === 'api/idempotency-conflict',
      )
      assert.equal(restartedTaskCalls, 0)
    } finally {
      runs2.dispose()
      db2.close()
    }

    // Phase 3: Honest post-restart reconciliation — linked active task stays `running` (never fake `stopped`)
    // and settles `completed` via REAL `bot-tasks.js` `reconcileEndedTask` -> `settleTask` production event chain;
    // chat-mode API Runs query cold D2 (`completed` vs `needs_verification` vs `not_found`).
    const homeHonest = makeHome('s7-honest')
    const db3 = openCoordinationDb({ home: homeHonest })
    let d2Responses = {}
    const taskBot = {
      id: bot.id,
      name: bot.name,
      sessionId: 'sess-api-chat',
      tasks: [
        {
          id: 'real-task-live',
          title: 'Deploy build post-restart',
          brief: 'Deploy build',
          from: 'sess-api-chat',
          sessionId: 'sess-real-task',
          workId: 'task:real-task-live',
          origin: 'api',
          status: 'running',
          startedAt: Date.now() - 5000,
          updatedAt: Date.now() - 1000,
        },
      ],
    }
    const rtHonest = {
      ...makeApiRt(db3, { startTask: async () => ({ id: 't', sessionId: 's' }), sendUser: async () => {} }),
      home: homeHonest,
      ctx: {
        on: () => () => {},
        effect: () => {},
        sessionController: {
          inspect: async () => ({
            events: [
              { type: 'turn/start', seq: 1, data: { turn: 1 } },
              {
                type: 'assistant/message',
                seq: 2,
                data: { message: { content: [{ type: 'text', text: 'Task finished post-restart' }] } },
              },
            ],
          }),
        },
      },
      state: { bots: { [bot.id]: taskBot }, rooms: {}, questions: {}, views: {}, secretRequests: {} },
      teamTools: [],
      taskOwners: new Map([['sess-real-task', { botId: bot.id, taskId: 'real-task-live' }]]),
      groupOwners: new Map(),
      pastOwners: new Map(),
      save: async () => {},
      load: async () => {},
      botOf: id => (id === bot.id ? taskBot : undefined),
      queryDeliveryStatus: async (_sid, q) => d2Responses[q?.idempotencyKey] ?? { status: 'not_found', consumed: false },
    }
    installAdapter(rtHonest)
    installBotTasks(rtHonest)
    rtHonest.queryDeliveryStatus = async (_sid, q) => d2Responses[q?.idempotencyKey] ?? { status: 'not_found', consumed: false }
    // Seed 1 active linked task Run + 3 interrupted chat Runs (completed, interrupted_tools, not_found).
    db3.createWork({
      workId: 'api:run_task_live',
      kind: 'task',
      botId: bot.id,
      logicalAddress: 'api:run_task_live',
      status: 'idle',
      originKind: 'api',
      apiRunId: 'run_task_live',
      apiMeta: { runId: 'run_task_live', mode: 'task', runStatus: 'queued', target: { kind: 'bot', id: bot.id, name: bot.name }, output: { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] }, usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 } },
    })
    db3.createWork({
      workId: 'task:real-task-live',
      kind: 'task',
      botId: bot.id,
      logicalAddress: 'task:real-task-live',
      sessionId: 'sess-real-task',
      status: 'running',
      originKind: 'api',
      meta: { taskId: 'real-task-live', apiRunId: 'run_task_live' },
    })
    for (const [runId, reqId] of [
      ['run_chat_done', 'api:k:run_chat_done'],
      ['run_chat_interrupted', 'api:k:run_chat_interrupted'],
      ['run_chat_unstarted', 'api:k:run_chat_unstarted'],
    ]) {
      db3.createWork({
        workId: `api:${runId}`,
        kind: 'task',
        botId: bot.id,
        logicalAddress: `api:${runId}`,
        status: 'idle',
        originKind: 'api',
        apiRunId: runId,
        apiMeta: { runId, requestId: reqId, mode: 'chat', runStatus: 'queued', sessionId: 'sess-api-chat', partId: 'sess-api-chat', target: { kind: 'bot', id: bot.id, name: bot.name }, output: { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] }, usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 } },
      })
    }
    d2Responses = {
      'api:k:run_chat_done': { status: 'completed', consumed: true, yielded: false, assistantText: 'Recovered chat answer' },
      'api:k:run_chat_interrupted': { status: 'aborted', consumed: true, interruptedTools: ['deploy_write'] },
      'api:k:run_chat_unstarted': { status: 'not_found', consumed: false },
    }
    const runs3 = createRunCoordinator(rtHonest, authStub)
    try {
      // Sync check: linked active task is `running` (NEVER falsely `stopped`).
      const liveTaskBefore = runs3.getRunForPrincipal('run_task_live', principal)
      assert.equal(liveTaskBefore.run.status, 'running')
      assert.equal(liveTaskBefore.run.taskId, 'real-task-live')

      // Async D2 reconciliation: honest classification for every chat Run.
      await runs3.reconcileInterruptedApiRunsAsync()
      assert.equal(runs3.getRunForPrincipal('run_chat_done', principal).run.status, 'completed')
      assert.equal(runs3.getRunForPrincipal('run_chat_done', principal).run.output.text, 'Recovered chat answer')
      assert.equal(runs3.getRunForPrincipal('run_chat_interrupted', principal).run.status, 'needs_verification')
      assert.equal(runs3.getRunForPrincipal('run_chat_unstarted', principal).run.status, 'stopped')

      // Drive the REAL `bot-tasks.js` settlement chain (`reconcileEndedTask` -> `settleTask` ->
      // `emitTaskEvent('task.completed')` + `rt.emitWorkSettled`) — ZERO manual listener invocation!
      const settled = await rtHonest.reconcileEndedTask('sess-real-task', { reason: { kind: 'completed' } })
      assert.equal(settled, true)
      const liveTaskAfter = runs3.getRunForPrincipal('run_task_live', principal)
      assert.equal(liveTaskAfter.run.status, 'completed')
      assert.equal(liveTaskAfter.run.output.text, 'Task finished post-restart')
    } finally {
      runs3.dispose()
      db3.close()
    }
  })

  it('Scenario 8: legacy inflight.queued preserves full >2000-char body & attachments through real dispatch, and resumeWork resets stagnation across the full rootWorkId chain', async () => {
    const home = makeHome('s8')
    const longPrefix = 'A'.repeat(2_100)
    const uniqueTail = 'TAIL_MARKER_MUST_SURVIVE_MIGRATION_98765'
    const fullLegacyText = `${longPrefix}\n${uniqueTail}`
    const receivedAttachments = []

    const { ctx, rt, llmCalls, ensureSession } = await bootRealEnv(home, {
      bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-s8-fg' } },
      llmHandler: () => textStream('migrated-full-body-received'),
    })
    ctx.on('session/event', (session, event) => {
      if (session.id === 'sess-s8-fg' && event.type === 'user/message' && Array.isArray(event.data?.content)) {
        for (const block of event.data.content) {
          if (block?.type === 'file') receivedAttachments.push(block.attachment)
        }
      }
    })

    try {
      await ensureSession('sess-s8-fg')
      rt.coordDb.importLegacyState({
        state: {
          bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-s8-fg' } },
          works: {},
        },
        inflight: {
          queued: {
            'sess-s8-fg': [
              {
                args: {
                  exchangeId: 'leg-ex-1',
                  fromId: 'botB',
                  toId: 'botA',
                  role: 'request',
                  text: fullLegacyText,
                  files: [{ id: 'att-legacy-1', name: 'spec.txt', mime: 'text/plain', size: 128 }],
                },
              },
            ],
          },
        },
      })

      await rt.kickScheduler()
      await waitUntil(() => llmCalls.some(c => c.sessionId === 'sess-s8-fg'))

      const call = llmCalls.find(c => c.sessionId === 'sess-s8-fg')
      assert.ok(
        call.userTexts.some(t => t.includes(uniqueTail) && t.length >= fullLegacyText.length),
        'legacy inflight.queued migration must deliver the full >2000-char text without 400-char truncation',
      )
      assert.ok(
        receivedAttachments.some(att => att?.id === 'att-legacy-1' && att?.name === 'spec.txt'),
        'legacy inflight.queued migration must preserve file attachments',
      )

      // P2-2: resumeWork({ resetProgress: true }) clears stagnation across BOTH root and child rows in the chain.
      const root = rt.coordDb.createWork({
        workId: 'chain-root-s8',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:chain-root-s8',
      }).work
      const child = rt.coordDb.createWork({
        workId: 'chain-child-s8',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:chain-child-s8',
        parentWorkId: root.workId,
        rootWorkId: root.workId,
      }).work

      const checkArgs = {
        unresolvedKey: 'same-stagnant-key',
        workspaceDigest: 'ws-0',
        outputDigest: 'out-0',
        errorSignature: 'err-0',
      }
      rt.coordDb.recordProgressCheck({ workId: child.workId, ...checkArgs })
      rt.coordDb.recordProgressCheck({ workId: child.workId, ...checkArgs })
      const paused = rt.coordDb.recordProgressCheck({ workId: child.workId, ...checkArgs })
      assert.equal(paused.stagnant, true)
      assert.equal(paused.paused, true)
      assert.equal(rt.coordDb.getWork(child.workId).status, 'paused')
      assert.equal(rt.coordDb.getWork(child.workId).stagnationCount, 3)
      assert.equal(rt.coordDb.getWork(root.workId).stagnationCount, 3)

      const resumed = rt.coordDb.resumeWork(child.workId, { resetProgress: true })
      assert.equal(resumed.resumed, true)
      assert.equal(resumed.work.status, 'queued')
      assert.equal(resumed.work.stagnationCount, 0)
      assert.equal(resumed.work.progressSignature, null)
      assert.equal(resumed.work.stagnationKey, null)
      assert.equal(rt.coordDb.getWork(root.workId).stagnationCount, 0)
      assert.equal(rt.coordDb.getWork(root.workId).progressSignature, null)
      assert.equal(rt.coordDb.getWork(root.workId).stagnationKey, null)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
