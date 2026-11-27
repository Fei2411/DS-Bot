// Wave 3 real-runtime multi-process crash-injection contract tests (B1–B6).
//
// Uses REAL `node:sqlite` (`coordination-db.js` WAL), REAL DSH Cordis runtime + JSONL
// persistence + SessionQueryEngine (resolved via `harness-resolve.mjs`, compatible with
// both native D1–D4 `DSH_HARNESS` and 0.2.2-rc.5 fallback), and REAL `dsh-adapter.js` +
// `resume.js`. Each scenario spawns a child process that hard-crashes with
// `process.exit(137)` at the exact crash boundary, then spawns a fresh recovery process
// over the same `home` directory to verify exact-once delivery, parent wake, and safe
// `needs_verification` pausing.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import { install as installCoordDb, openCoordinationDb } from '../src/host/coordination-db.js'
import { install as installAdapter } from '../src/host/dsh-adapter.js'
import { install as installGroups } from '../src/host/groups.js'
import { install as installResume } from '../src/host/resume.js'
import { textOf } from '../src/host/text.js'

const THIS_FILE = fileURLToPath(import.meta.url)
const HARNESS_RESOLVE = resolve(dirname(THIS_FILE), 'harness-resolve.mjs')

function appendLog(home, file, entry) {
  appendFileSync(join(home, file), `${JSON.stringify(entry)}\n`, 'utf8')
}

function readLog(home, file) {
  const full = join(home, file)
  if (!existsSync(full)) return []
  return readFileSync(full, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function walkFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

class RecordingMockAdapter extends LlmAdapter {
  constructor(home, handler) {
    super()
    this.home = home
    this.handler = handler
  }

  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  async *stream(options) {
    const userTexts = (options.messages ?? [])
      .filter(m => m.role === 'user')
      .map(m => textOf(m.content))
    appendLog(this.home, 'llm-invocations.jsonl', {
      sessionId: options.sessionId,
      phase: process.env.DSB_CRASH_PHASE,
      userTexts,
    })
    yield* this.handler(options)
  }
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

class RealSessionQuery extends SessionQueryEngine {
  async searchSessions() {
    return { items: [], hasMore: false }
  }

  async searchEvents() {
    throw new Error('searchEvents unused in crash-recovery contract test')
  }
}

async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

async function bootRealWorkerRuntime(home, { llmHandler, onSessionEvent, registerTools } = {}) {
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

  const adapter = new RecordingMockAdapter(home, llmHandler ?? (() => textStream('ok')))
  ctx.llm.registerAdapter(['mock'], adapter)
  registerTools?.(ctx)

  const state = { bots: {}, rooms: {}, exchanges: [] }
  const rt = {
    ctx,
    home,
    state,
    readOnly: () => undefined,
    warn: () => {},
    load: async () => {},
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
  installResume(rt)

  // Forward real DSH session lifecycle events to `dsh-adapter.js` (same contract as `turns.js`).
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
      if (onSessionEvent) {
        const veto = onSessionEvent(session, event, rt)
        if (veto === 'skip-notify') return
      }
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
      return
    }
    onSessionEvent?.(session, event, rt)
  })

  return { ctx, rt }
}

async function createPersistedSession(ctx, sessionId) {
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'mock', model: 'm' },
  })
  await ctx.sessions.flush(handle.agent.session)
  return handle
}

async function runWorker() {
  const scenario = process.env.DSB_CRASH_SCENARIO
  const phase = process.env.DSB_CRASH_PHASE
  const home = process.env.DSB_CRASH_HOME

  // ---- B1: DB has ready + inbox + beginDeliveryAttempt, crash BEFORE DSH send ----
  if (scenario === 'B1') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home)
      const sid = 'sess-b1-task'
      await createPersistedSession(ctx, sid)
      const { work } = rt.coordDb.createWork({
        workId: 'work-b1',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b1',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Execute B1 task once',
        wake: true,
      })
      const claim = rt.coordDb.claimReady({ workId: work.workId })
      rt.coordDb.beginDeliveryAttempt({
        workId: work.workId,
        claimToken: claim.claimToken,
        throughSeq: claim.claimedInboxSeq,
        sessionId: sid,
      })
      // Hard crash BEFORE calling DSH agent.followup!
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('b1-completed'),
    })
    await rt.adoptLiveWork()
    await waitUntil(() => rt.coordDb.getWork('work-b1')?.status === 'done')
    await ctx.fiber.dispose()
    return
  }

  // ---- B2a: DSH flushed agent/inbox/spliced (inserted, queued), crash BEFORE turn/start ----
  if (scenario === 'B2a') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash-proc'),
      })
      const sid = 'sess-b2a-task'
      const handle = await createPersistedSession(ctx, sid)
      const { work } = rt.coordDb.createWork({
        workId: 'work-b2a',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b2a',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Execute B2a parked inbox item once',
        wake: true,
      })
      // Hold the agent in maintenance so `kickScheduler` writes `agent/inbox/spliced` to JSONL
      // and flushes it to disk WITHOUT starting a turn yet, then hard-crash!
      const hold = Promise.withResolvers()
      void handle.agent.runMaintenance(async () => {
        await hold.promise
      })
      await rt.kickScheduler({ workId: work.workId })
      await ctx.sessions.flush(handle.agent.session)
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('b2a-completed'),
    })
    await rt.adoptLiveWork()
    await waitUntil(() => rt.coordDb.getWork('work-b2a')?.status === 'done')
    await ctx.fiber.dispose()
    return
  }

  // ---- B2b: DSH flushed turn/start + inbox.claim, crash inside pre-step BEFORE user/message ----
  if (scenario === 'B2b') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash-proc'),
      })
      const sid = 'sess-b2b-task'
      await createPersistedSession(ctx, sid)
      ctx.on('agent/pre-step', async ({ agent }) => {
        await ctx.sessions.flush(agent.session)
        // Hard crash after inbox.claim inside turn/start, BEFORE user/message commits!
        process.exit(137)
      })
      const { work } = rt.coordDb.createWork({
        workId: 'work-b2b',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b2b',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Execute B2b claimed-before-user-message once',
        wake: true,
      })
      await rt.kickScheduler({ workId: work.workId })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('b2b-completed'),
    })
    await rt.adoptLiveWork()
    await waitUntil(() => rt.coordDb.getWork('work-b2b')?.status === 'done')
    await ctx.fiber.dispose()
    return
  }

  // ---- B3: DSH flushed user/message + tool/call, crash mid-tool BEFORE tool/result ----
  if (scenario === 'B3') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => toolCallStream('call-deploy-1', 'deploy_write', { target: 'prod' }),
        registerTools: (c) => {
          c.tools.register({
            name: 'deploy_write',
            description: 'Non-idempotent write tool',
            parameters: { type: 'object', properties: { target: { type: 'string' } } },
            output: {
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              render: () => [{ type: 'text', text: 'deployed' }],
            },
            async execute(args, exec) {
              appendLog(home, 'tool-invocations.jsonl', { tool: 'deploy_write', args, phase })
              await c.sessions.flush(exec.agent.session)
              // Hard crash mid-tool execution BEFORE tool/result!
              process.exit(137)
            },
          })
        },
      })
      const sid = 'sess-b3-task'
      await createPersistedSession(ctx, sid)
      const { work } = rt.coordDb.createWork({
        workId: 'work-b3',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b3',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Run deploy_write',
        wake: true,
      })
      await rt.kickScheduler({ workId: work.workId })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-not-rerun-after-interrupted-tool'),
    })
    await rt.adoptLiveWork()
    const w = rt.coordDb.getWork('work-b3')
    assert.equal(w.status, 'needs_verification')
    assert.equal(w.pauseReason, 'interrupted_tools')
    await ctx.fiber.dispose()
    return
  }

  // ---- B4: Child turn COMPLETED in DSH JSONL, crash BEFORE SQLite settleWork ----
  if (scenario === 'B4') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: (options) => textStream(options.sessionId === 'sess-b4-child' ? 'child-b4-answer' : 'parent-unexpected'),
        onSessionEvent: (session, event) => {
          if (session.id === 'sess-b4-child' && event.type === 'turn/end') {
            void ctx.sessions.flush(session).then(() => {
              // Hard crash AFTER turn/end is durably on disk, BEFORE settleWork commits!
              process.exit(137)
            })
            return 'skip-notify'
          }
          return undefined
        },
      })
      await createPersistedSession(ctx, 'sess-b4-parent')
      await createPersistedSession(ctx, 'sess-b4-child')
      const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botParent', sessionId: 'sess-b4-parent' })
      rt.coordDb.createWork({
        workId: 'work-b4-child',
        kind: 'task',
        botId: 'botChild',
        logicalAddress: 'task:work-b4-child',
        sessionId: 'sess-b4-child',
        priority: 'background',
      })
      rt.coordDb.createCall({
        callId: 'call-b4',
        parentWorkId: parent.workId,
        childWorkId: 'work-b4-child',
        callerBotId: 'botParent',
        calleeBotId: 'botChild',
        required: true,
        initialMessage: { bodyPreview: 'Compute B4 answer' },
      })
      await rt.kickScheduler({ workId: 'work-b4-child' })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: (options) => textStream(options.sessionId === 'sess-b4-parent' ? 'parent-consumed-b4' : 'child-must-not-rerun'),
    })
    await rt.adoptLiveWork()
    await waitUntil(() => {
      const child = rt.coordDb.getWork('work-b4-child')
      const parent = rt.coordDb.getForegroundWork('botParent')
      const call = rt.coordDb.getCall('call-b4')
      return child?.status === 'done'
        && call?.status === 'done'
        && parent?.status === 'idle'
        && readLog(home, 'llm-invocations.jsonl').some(entry => entry.sessionId === 'sess-b4-parent')
    })
    await ctx.fiber.dispose()
    return
  }

  // ---- B5: Child settleWork committed parent inbox(result) + ready, crash BEFORE parent wakes ----
  if (scenario === 'B5') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: (options) => textStream(options.sessionId === 'sess-b5-child' ? 'child-b5-answer' : 'parent-unexpected'),
      })
      await createPersistedSession(ctx, 'sess-b5-parent')
      await createPersistedSession(ctx, 'sess-b5-child')
      const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botParent', sessionId: 'sess-b5-parent' })
      rt.coordDb.createWork({
        workId: 'work-b5-child',
        kind: 'task',
        botId: 'botChild',
        logicalAddress: 'task:work-b5-child',
        sessionId: 'sess-b5-child',
        priority: 'background',
      })
      rt.coordDb.createCall({
        callId: 'call-b5',
        parentWorkId: parent.workId,
        childWorkId: 'work-b5-child',
        callerBotId: 'botParent',
        calleeBotId: 'botChild',
        required: true,
        initialMessage: { bodyPreview: 'Compute B5 answer' },
      })
      rt.onWorkSettled(({ work }) => {
        if (work?.workId === 'work-b5-child') {
          // settleWork already committed child done + parent inbox(result) + parent ready!
          // Hard crash BEFORE microtask kickScheduler dispatches parent.
          process.exit(137)
        }
      })
      await rt.kickScheduler({ workId: 'work-b5-child' })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: (options) => textStream(options.sessionId === 'sess-b5-parent' ? 'parent-consumed-b5' : 'child-must-not-rerun'),
    })
    await rt.adoptLiveWork()
    await waitUntil(() => {
      const parent = rt.coordDb.getForegroundWork('botParent')
      return parent?.status === 'idle'
        && readLog(home, 'llm-invocations.jsonl').some(entry => entry.sessionId === 'sess-b5-parent')
    })
    await ctx.fiber.dispose()
    return
  }

  // ---- B6a: Corrupt DSH Session JSONL header on disk -> needs_verification, never fake not_found ----
  if (scenario === 'B6a') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home)
      const sid = 'sess-b6-corrupt'
      await createPersistedSession(ctx, sid)
      const { work } = rt.coordDb.createWork({
        workId: 'work-b6',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b6',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Do not blindly rerun when session log header is corrupt',
        wake: true,
      })
      const claim = rt.coordDb.claimReady({ workId: work.workId })
      rt.coordDb.beginDeliveryAttempt({
        workId: work.workId,
        claimToken: claim.claimToken,
        throughSeq: claim.claimedInboxSeq,
        sessionId: sid,
      })
      const logFiles = walkFiles(join(home, 'sessions')).filter(f => f.endsWith('.jsonl'))
      assert.ok(logFiles.length > 0, 'expected persisted session .jsonl file on disk')
      // Corrupt the header record so DSH index scan drops the session and dsh-adapter fails closed.
      for (const file of logFiles) {
        writeFileSync(file, '{corrupt-session-header-not-valid-json\n', 'utf8')
      }
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-never-run-on-corrupt-header'),
    })
    await rt.adoptLiveWork()
    const w = rt.coordDb.getWork('work-b6')
    assert.equal(w.status, 'needs_verification')
    assert.equal(w.pauseReason, 'delivery_status_unreadable')
    await ctx.fiber.dispose()
    return
  }

  // ---- B6b: Unreadable DSH Session JSONL on disk (EACCES chmod 0o000) ----
  if (scenario === 'B6b') {
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home)
      const sid = 'sess-b6-unreadable'
      await createPersistedSession(ctx, sid)
      const { work } = rt.coordDb.createWork({
        workId: 'work-b6-unreadable',
        kind: 'task',
        botId: 'botA',
        logicalAddress: 'task:work-b6-unreadable',
        sessionId: sid,
        priority: 'background',
      })
      rt.coordDb.receiveMessage({
        workId: work.workId,
        kind: 'request',
        bodyPreview: 'Do not blindly rerun when session log file is unreadable (EACCES)',
        wake: true,
      })
      const claim = rt.coordDb.claimReady({ workId: work.workId })
      rt.coordDb.beginDeliveryAttempt({
        workId: work.workId,
        claimToken: claim.claimToken,
        throughSeq: claim.claimedInboxSeq,
        sessionId: sid,
      })

      const logFiles = walkFiles(join(home, 'sessions')).filter(f => f.endsWith('.jsonl'))
      assert.ok(logFiles.length > 0, 'expected persisted session .jsonl file on disk')
      // Revoke read permission so recovery hits a real OS EACCES / unreadable session log failure.
      for (const file of logFiles) {
        if (process.platform === 'win32') {
          const acl = spawnSync('icacls', [file, '/inheritance:r', '/deny', '*S-1-1-0:(R)'], { stdio: 'ignore' })
          assert.equal(acl.status, 0, `icacls deny read failed for ${file}`)
        } else {
          chmodSync(file, 0o000)
        }
      }
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-never-run-on-unreadable-log'),
    })
    await rt.adoptLiveWork()
    const w = rt.coordDb.getWork('work-b6-unreadable')
    assert.equal(w.status, 'needs_verification')
    assert.equal(w.pauseReason, 'delivery_status_unreadable')
    await ctx.fiber.dispose()
    return
  }

  // ---- B7a: Group room_work completed in DSH JSONL, hard-crashed BEFORE settleRoomCallWork ----
  if (scenario === 'B7a') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7a',
      name: 'Launch',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7a-alice', botB: 'sess-b7a-bob' },
    }
    const setupGroupRt = (rt) => {
      const ledgerFile = 'room-b7a-ledger.jsonl'
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => readLog(home, ledgerFile),
          append: (_book, rec) => { appendLog(home, ledgerFile, rec) },
          records: () => readLog(home, ledgerFile),
          range: (_book, from, to) => readLog(home, ledgerFile).filter(r => r.seq >= from && r.seq <= to),
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('bob-b7a-group-answer'),
        onSessionEvent: (session, event) => {
          if (session.id === 'sess-b7a-bob' && event.type === 'turn/end') {
            void ctx.sessions.flush(session).then(() => {
              // Crash AFTER Bob's group turn completed on disk, BEFORE settleRoomCallWork commits!
              process.exit(137)
            })
            return 'skip-notify'
          }
          return undefined
        },
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7a-alice')
      await createPersistedSession(ctx, 'sess-b7a-bob')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7a-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7a-bob',
      })
      const bobAgent = await rt.resolveAgent('sess-b7a-bob')
      bobAgent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Launch" · delegated]\nPrepare launch checklist' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7a-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('bob-must-not-rerun-after-group-recovery'),
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await ctx.fiber.dispose()
    return
  }

  // ---- B7b: Group room_work hard-crashed mid-tool -> settleRoomBatches pauses as needs_verification(interrupted_tools) ----
  if (scenario === 'B7b') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7b',
      name: 'Ops',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7b-alice', botB: 'sess-b7b-bob' },
    }
    const setupGroupRt = (rt) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => [],
          append: () => {},
          records: () => [],
          range: () => [],
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => toolCallStream('call-room-write-1', 'group_write_tool', { target: 'prod' }),
        registerTools: (c) => {
          c.tools.register({
            name: 'group_write_tool',
            description: 'Non-idempotent write tool inside group delegation',
            parameters: { type: 'object', properties: { target: { type: 'string' } } },
            output: {
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              render: () => [{ type: 'text', text: 'wrote' }],
            },
            async execute(args, exec) {
              appendLog(home, 'tool-invocations.jsonl', { tool: 'group_write_tool', args, phase })
              await c.sessions.flush(exec.agent.session)
              process.exit(137)
            },
          })
        },
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7b-alice')
      await createPersistedSession(ctx, 'sess-b7b-bob')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7b-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7b-bob',
      })
      const bobAgent = await rt.resolveAgent('sess-b7b-bob')
      bobAgent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Ops" · delegated]\nRun group_write_tool' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7b-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-not-rerun-group-tool'),
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await ctx.fiber.dispose()
    return
  }

  // ---- B7c: Group room_work YIELDED (D4 yieldToolTurn) before crash -> settleRoomBatches MUST pause needs_verification(yielded_before_restart), NEVER settle done ----
  if (scenario === 'B7c') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7c',
      name: 'Review',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7c-alice', botB: 'sess-b7c-bob' },
    }
    const setupGroupRt = (rt) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => [],
          append: () => {},
          records: () => [],
          range: () => [],
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => toolCallStream('call-yield-1', 'group_yield_tool', {}),
        registerTools: (c) => {
          c.tools.register({
            name: 'group_yield_tool',
            description: 'Yields turn deterministically via D4 while waiting for approval/sub-work',
            parameters: { type: 'object', properties: {} },
            output: {
              schema: { type: 'object', properties: { waited: { type: 'boolean' } }, required: ['waited'] },
              render: () => [{ type: 'text', text: 'waiting' }],
            },
            async execute(_args, exec) {
              rt.yieldToolTurn(exec, 'waiting_for_approval')
              return { waited: true }
            },
          })
        },
        onSessionEvent: (session, event) => {
          if (session.id === 'sess-b7c-bob' && event.type === 'turn/end') {
            void ctx.sessions.flush(session).then(() => {
              process.exit(137)
            })
            return 'skip-notify'
          }
          return undefined
        },
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7c-alice')
      await createPersistedSession(ctx, 'sess-b7c-bob')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7c-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7c-bob',
      })
      const bobAgent = await rt.resolveAgent('sess-b7c-bob')
      bobAgent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Review" · delegated]\nAsk approval then continue' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7c-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-not-rerun-yielded-group'),
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await ctx.fiber.dispose()
    return
  }

  // ---- B7d: Group room_work QUEUED (parked in DSH inbox via maintenance) before crash ->
  // settleRoomBatches adopts via group-owned observer (NEVER generic activeClaims), wakes once,
  // records answer in room ledger, and settles done via settleRoomCallWork ----
  if (scenario === 'B7d') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7d',
      name: 'Release',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7d-alice', botB: 'sess-b7d-bob' },
    }
    const setupGroupRt = (rt) => {
      const ledgerFile = 'room-b7d-ledger.jsonl'
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => readLog(home, ledgerFile),
          append: (_book, rec) => { appendLog(home, ledgerFile, rec) },
          records: () => readLog(home, ledgerFile),
          range: (_book, from, to) => readLog(home, ledgerFile).filter(r => r.seq >= from && r.seq <= to),
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash-proc'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7d-alice')
      const bobHandle = await createPersistedSession(ctx, 'sess-b7d-bob')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7d-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7d-bob',
      })
      // Park the group delivery in DSH inbox without starting a turn, flush JSONL, and hard-crash!
      const hold = Promise.withResolvers()
      void bobHandle.agent.runMaintenance(async () => { await hold.promise })
      bobHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Release" · delegated]\nVerify release notes' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7d-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await ctx.sessions.flush(bobHandle.agent.session)
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('bob-b7d-adopted-queued-answer'),
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await waitUntil(() => {
      const works = rt.coordDb.listWorks({ kind: 'room_work', limit: 20 })
      const bobWork = works.find(w => w.botId === 'botB')
      return bobWork?.status === 'done'
    })
    await ctx.fiber.dispose()
    return
  }

  // ---- B7e: Adopted QUEUED group room_work that YIELDS via D4 on recover ->
  // group-owned observer pauses as needs_verification(yielded_after_restart) without throwing claimToken error ----
  if (scenario === 'B7e') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7e',
      name: 'Deploy',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7e-alice', botB: 'sess-b7e-bob' },
    }
    const setupGroupRt = (rt) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => [],
          append: () => {},
          records: () => [],
          range: () => [],
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash-proc'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7e-alice')
      const bobHandle = await createPersistedSession(ctx, 'sess-b7e-bob')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7e-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7e-bob',
      })
      const hold = Promise.withResolvers()
      void bobHandle.agent.runMaintenance(async () => { await hold.promise })
      bobHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Deploy" · delegated]\nYield after adopt' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7e-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await ctx.sessions.flush(bobHandle.agent.session)
      process.exit(137)
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => toolCallStream('call-yield-adopt-1', 'adopt_yield_tool', {}),
      registerTools: (c) => {
        c.tools.register({
          name: 'adopt_yield_tool',
          description: 'Yields turn deterministically via D4 during adopted group recovery',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
            render: () => [{ type: 'text', text: 'yielding' }],
          },
          async execute(_args, exec) {
            rt.yieldToolTurn(exec, 'waiting_after_adopt')
            return { ok: true }
          },
        })
      },
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await waitUntil(() => {
      const works = rt.coordDb.listWorks({ kind: 'room_work', limit: 20 })
      const bobWork = works.find(w => w.botId === 'botB')
      return bobWork?.status === 'needs_verification'
    })
    await ctx.fiber.dispose()
    return
  }

  // ---- B7f: Adopted queued group room_work delegates nested child work during its adopted turn
  // and ends turn normally (`completed`, NOT yielded) -> group-owned observer MUST keep Bob waiting
  // (NEVER settle `done` early while child call wait is open) ----
  if (scenario === 'B7f') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
      botC: { id: 'botC', name: 'Carol', color: '#333' },
    }
    const room = {
      id: 'room-b7f',
      name: 'Nested',
      admin: 'botA',
      members: ['botA', 'botB', 'botC'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7f-alice', botB: 'sess-b7f-bob', botC: 'sess-b7f-carol' },
    }
    const setupGroupRt = (rt) => {
      const ledgerFile = 'room-b7f-ledger.jsonl'
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => readLog(home, ledgerFile),
          append: (_book, rec) => { appendLog(home, ledgerFile, rec) },
          records: () => readLog(home, ledgerFile),
          range: (_book, from, to) => readLog(home, ledgerFile).filter(r => r.seq >= from && r.seq <= to),
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash-proc'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7f-alice')
      const bobHandle = await createPersistedSession(ctx, 'sess-b7f-bob')
      await createPersistedSession(ctx, 'sess-b7f-carol')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7f-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7f-bob',
      })
      const hold = Promise.withResolvers()
      void bobHandle.agent.runMaintenance(async () => { await hold.promise })
      bobHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "Nested" · delegated]\nDelegate sub-check to Carol' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7f-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await ctx.sessions.flush(bobHandle.agent.session)
      process.exit(137)
    }
    let nestedChildWorkId
    let turnEnded = false
    let stepCalls = 0
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => {
        stepCalls += 1
        if (stepCalls === 1) return toolCallStream('call-delegate-carol', 'nested_delegate_tool', {})
        return textStream('Asked Carol to verify; waiting for her result.')
      },
      registerTools: (c) => {
        c.tools.register({
          name: 'nested_delegate_tool',
          description: 'Opens nested child room_work for Carol without yielding',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: { type: 'object', properties: { childWorkId: { type: 'string' } }, required: ['childWorkId'] },
            render: (_a, v) => [{ type: 'text', text: `delegated:${v.childWorkId}` }],
          },
          async execute() {
            const bobActive = rt.coordDb.listWorks({ kind: 'room_work', activeOnly: true, limit: 20 })
              .find(w => w.botId === 'botB' && w.meta?.kind === 'room_call')
            assert.ok(bobActive, 'expected active Bob room_call work')
            const nested = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobActive.workId })
            nestedChildWorkId = nested.children[0].work.workId
            return { childWorkId: nestedChildWorkId }
          },
        })
      },
      onSessionEvent: (session, event) => {
        if (session.id === 'sess-b7f-bob' && event.type === 'turn/end') {
          turnEnded = true
        }
      },
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await waitUntil(() => turnEnded && Boolean(nestedChildWorkId))
    await new Promise(r => setTimeout(r, 80))
    const works = rt.coordDb.listWorks({ kind: 'room_work', limit: 20 })
    const bobWork = works.find(w => w.botId === 'botB')
    const aliceCaller = works.find(w => w.botId === 'botA')
    assert.equal(bobWork?.status, 'waiting', 'Bob must remain waiting while Carol child call is open')
    assert.notEqual(aliceCaller?.status, 'done', 'Alice caller must NOT settle before nested child returns')
    // When Carol finishes later, Bob wakes cleanly (not dropped as terminal).
    const carolSettle = rt.coordDb.settleWork({
      workId: nestedChildWorkId,
      outcome: 'done',
      force: true,
      summary: 'Carol verified sub-check',
    })
    assert.deepEqual(carolSettle.wokenParents, [bobWork.workId])
    await ctx.fiber.dispose()
    return
  }

  // ---- B7g: Group room_work crashes in `claimed` window (after inbox.claim inside turn/start,
  // BEFORE user/message commits) -> settleRoomBatches fails closed to needs_verification(claimed_before_restart) ----
  if (scenario === 'B7g') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
    }
    const room = {
      id: 'room-b7g',
      name: 'ClaimWindow',
      admin: 'botA',
      members: ['botA', 'botB'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7g-alice', botB: 'sess-b7g-bob' },
    }
    const setupGroupRt = (rt) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async () => {},
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => [],
          append: () => {},
          records: () => [],
          range: () => [],
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-claimed-crash'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7g-alice')
      await createPersistedSession(ctx, 'sess-b7g-bob')
      ctx.on('agent/pre-step', async ({ agent }) => {
        if (agent.id === 'sess-b7g-bob') {
          await ctx.sessions.flush(agent.session)
          // Hard crash after inbox.claim inside turn/start, BEFORE user/message commits!
          process.exit(137)
        }
      })
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7g-1`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7g-bob',
      })
      const bobAgent = await rt.resolveAgent('sess-b7g-bob')
      bobAgent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "ClaimWindow" · delegated]\nCrash in claimed window' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7g-1', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await new Promise(() => {})
    }
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('must-not-rerun-claimed-group'),
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await ctx.fiber.dispose()
    return
  }

  // ---- B7h: Second restart after `parkWaiting` (P1-A regression) ->
  // Phase 1 (`crash1`): Bob's group delivery parked queued in DSH -> crash.
  // Phase 2 (`recover1_crash2`): Bob adopted, delegates nested child Carol (whose delivery is parked queued in DSH),
  //   Bob ends turn -> parked in `waiting` with `activeDeliveryKey = null` -> SECOND hard crash!
  // Phase 3 (`recover2`): `settleRoomBatches` MUST NOT stop Bob; adopts Carol -> Carol finishes -> wakes Bob! ----
  if (scenario === 'B7h') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
      botC: { id: 'botC', name: 'Carol', color: '#333' },
    }
    const room = {
      id: 'room-b7h',
      name: 'DoubleRestart',
      admin: 'botA',
      members: ['botA', 'botB', 'botC'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7h-alice', botB: 'sess-b7h-bob', botC: 'sess-b7h-carol' },
    }
    const ledgerFile = 'room-b7h-ledger.jsonl'
    const wakesFile = 'room-b7h-wakes.jsonl'
    const setupGroupRt = (rt, { onPostDeliver } = {}) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async (args) => {
          onPostDeliver?.(args)
        },
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => readLog(home, ledgerFile),
          append: (_book, rec) => { appendLog(home, ledgerFile, rec) },
          records: () => readLog(home, ledgerFile),
          range: (_book, from, to) => readLog(home, ledgerFile).filter(r => r.seq >= from && r.seq <= to),
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash1') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-crash1'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7h-alice')
      const bobHandle = await createPersistedSession(ctx, 'sess-b7h-bob')
      await createPersistedSession(ctx, 'sess-b7h-carol')
      await createPersistedSession(ctx, 'room-sess-room-b7h')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7h-bob`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7h-bob',
      })
      const hold = Promise.withResolvers()
      void bobHandle.agent.runMaintenance(async () => { await hold.promise })
      bobHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "DoubleRestart" · delegated]\nDelegate to Carol then survive second crash' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7h-bob', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await ctx.sessions.flush(bobHandle.agent.session)
      process.exit(137)
    }
    if (phase === 'recover1_crash2') {
      let nestedChildWorkId
      let bobTurnEnded = false
      let stepCalls = 0
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => {
          stepCalls += 1
          if (stepCalls === 1) return toolCallStream('call-b7h-carol', 'b7h_delegate_carol', {})
          return textStream('Delegated to Carol; waiting.')
        },
        registerTools: (c) => {
          c.tools.register({
            name: 'b7h_delegate_carol',
            description: 'Delegates to Carol and parks Carol delivery queued before second crash',
            parameters: { type: 'object', properties: {} },
            output: {
              schema: { type: 'object', properties: { childWorkId: { type: 'string' } }, required: ['childWorkId'] },
              render: (_a, v) => [{ type: 'text', text: `delegated:${v.childWorkId}` }],
            },
            async execute() {
              const bobActive = rt.coordDb.listWorks({ kind: 'room_work', activeOnly: true, limit: 20 })
                .find(w => w.botId === 'botB' && w.meta?.kind === 'room_call')
              const nested = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobActive.workId })
              nestedChildWorkId = nested.children[0].work.workId
              const carolKey = `room-call:${nestedChildWorkId}:ex-b7h-carol`
              rt.coordDb.recordDirectDeliveryAttempt({
                workId: nestedChildWorkId,
                idempotencyKey: carolKey,
                sessionId: 'sess-b7h-carol',
              })
              const carolAgent = await rt.resolveAgent('sess-b7h-carol')
              const hold = Promise.withResolvers()
              void carolAgent.runMaintenance(async () => { await hold.promise })
              carolAgent.followup(createUserMessage({
                content: [{ type: 'text', text: '[Group chat "DoubleRestart" · delegated]\nCarol run sub-check' }],
                source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7h-carol', idempotencyKey: carolKey },
              }), { idempotencyKey: carolKey })
              await ctx.sessions.flush(carolAgent.session)
              return { childWorkId: nestedChildWorkId }
            },
          })
        },
        onSessionEvent: (session, event) => {
          if (session.id === 'sess-b7h-bob' && event.type === 'turn/end') bobTurnEnded = true
        },
      })
      setupGroupRt(rt)
      await rt.adoptLiveWork()
      await waitUntil(() => bobTurnEnded && Boolean(nestedChildWorkId))
      await waitUntil(() => {
        const bobWork = rt.coordDb.listWorks({ kind: 'room_work', limit: 20 }).find(w => w.botId === 'botB')
        return bobWork?.status === 'waiting' && bobWork.activeDeliveryKey === null
      })
      // Hard crash #2 while Bob is parked in `waiting` (activeDeliveryKey=null) and Carol is queued!
      process.exit(137)
    }
    // Phase 3 (`recover2`): second restart adopts Carol while preserving Bob in `waiting`,
    // then Carol completes and wakes Bob for his synthesis turn via real `postToRoom` -> DSH room session!
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => textStream('carol-b7h-verified-after-double-crash'),
      onSessionEvent: (session, event) => {
        if (session.id !== 'room-sess-room-b7h' || event.type !== 'agent/inbox/spliced') return
        for (const msg of event.data?.inserted ?? []) {
          if (msg?.source?.role === 'post' && msg.source.resumeWorkId) {
            appendLog(home, wakesFile, {
              resumeWorkId: msg.source.resumeWorkId,
              askedBy: msg.source.askedBy,
              route: msg.source.route,
              names: msg.source.wakeSnapshot?.names ?? [],
            })
          }
        }
      },
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await waitUntil(() => {
      const works = rt.coordDb.listWorks({ kind: 'room_work', limit: 20 })
      const carolWork = works.find(w => w.botId === 'botC')
      return carolWork?.status === 'done' && readLog(home, wakesFile).length > 0
    })
    await ctx.fiber.dispose()
    return
  }

  // ---- B7i: Fast child settles BEFORE adopted parent Turn 1 ends (P1-B regression) ->
  // `watchAdoptedRoomTurn` MUST NOT settle Bob `done`; it detects unread `result` inbox messages
  // from Carol and wakes Bob for his synthesis turn instead! ----
  if (scenario === 'B7i') {
    const bots = {
      botA: { id: 'botA', name: 'Alice', color: '#111' },
      botB: { id: 'botB', name: 'Bob', color: '#222' },
      botC: { id: 'botC', name: 'Carol', color: '#333' },
    }
    const room = {
      id: 'room-b7i',
      name: 'FastChild',
      admin: 'botA',
      members: ['botA', 'botB', 'botC'],
      seq: 0,
      log: [],
      seen: {},
      sessions: { botA: 'sess-b7i-alice', botB: 'sess-b7i-bob', botC: 'sess-b7i-carol' },
    }
    const ledgerFile = 'room-b7i-ledger.jsonl'
    const wakesFile = 'room-b7i-wakes.jsonl'
    const setupGroupRt = (rt, { onPostDeliver } = {}) => {
      Object.assign(rt, {
        teamTools: [],
        live: new Map(),
        roomInbox: new Map(),
        roomProgress: new Map(),
        roomWaiters: new Map(),
        groupOwners: new Map(),
        pastOwners: new Map(),
        chatOwners: new Map(),
        botOf: id => bots[id],
        roomOf: id => (id === room.id ? room : undefined),
        chatOf: id => room.sessions[id],
        sessionOfRoom: r => `room-sess-${r.id}`,
        isAdminOf: (r, id) => r.admin === id,
        ownRequest: () => false,
        save: async () => {},
        deliver: async (args) => {
          onPostDeliver?.(args)
        },
        rememberImReplyOrigin: () => {},
        ledger: {
          importer: () => {},
          open: () => ({ bySeq: new Map() }),
          after: () => readLog(home, ledgerFile),
          append: (_book, rec) => { appendLog(home, ledgerFile, rec) },
          records: () => readLog(home, ledgerFile),
          range: (_book, from, to) => readLog(home, ledgerFile).filter(r => r.seq >= from && r.seq <= to),
        },
      })
      installGroups(rt)
    }
    if (phase === 'crash') {
      const { ctx, rt } = await bootRealWorkerRuntime(home, {
        llmHandler: () => textStream('should-not-run-in-b7i-crash'),
      })
      setupGroupRt(rt)
      await createPersistedSession(ctx, 'sess-b7i-alice')
      const bobHandle = await createPersistedSession(ctx, 'sess-b7i-bob')
      await createPersistedSession(ctx, 'sess-b7i-carol')
      await createPersistedSession(ctx, 'room-sess-room-b7i')
      const batch = rt.openRoomCall(room, 'botA', [bots.botB])
      const bobSlot = batch.children[0]
      const deliveryKey = `room-call:${bobSlot.work.workId}:ex-b7i-bob`
      rt.coordDb.recordDirectDeliveryAttempt({
        workId: bobSlot.work.workId,
        idempotencyKey: deliveryKey,
        sessionId: 'sess-b7i-bob',
      })
      const hold = Promise.withResolvers()
      void bobHandle.agent.runMaintenance(async () => { await hold.promise })
      bobHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat "FastChild" · delegated]\nDelegate to fast Carol' }],
        source: { kind: 'ds-bot', form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-b7i-bob', idempotencyKey: deliveryKey },
      }), { idempotencyKey: deliveryKey })
      await ctx.sessions.flush(bobHandle.agent.session)
      process.exit(137)
    }
    let bobTurnEnded = false
    let stepCalls = 0
    const { ctx, rt } = await bootRealWorkerRuntime(home, {
      llmHandler: () => {
        stepCalls += 1
        if (stepCalls === 1) return toolCallStream('call-b7i-fast-carol', 'b7i_fast_carol_tool', {})
        return textStream('Sent request to Carol, wrapping up Turn 1.')
      },
      registerTools: (c) => {
        c.tools.register({
          name: 'b7i_fast_carol_tool',
          description: 'Delegates to Carol and immediately settles Carol BEFORE Bob ends Turn 1',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: { type: 'object', properties: { childWorkId: { type: 'string' } }, required: ['childWorkId'] },
            render: (_a, v) => [{ type: 'text', text: `fast-settled:${v.childWorkId}` }],
          },
          async execute() {
            const bobActive = rt.coordDb.listWorks({ kind: 'room_work', activeOnly: true, limit: 20 })
              .find(w => w.botId === 'botB' && w.meta?.kind === 'room_call')
            const nested = rt.openRoomCall(room, 'botB', [bots.botC], { parentWorkId: bobActive.workId })
            const childWorkId = nested.children[0].work.workId
            // Carol finishes FAST while Bob is still running Turn 1 (closes wait before Bob's turn/end!).
            rt.coordDb.updateApiMeta(bobActive.workId, prev => ({
              ...prev,
              done: ['Carol'],
              doneIds: ['botC'],
              results: [{ name: 'Carol', botId: 'botC', seq: 1 }],
              worked: true,
            }))
            const settleRes = rt.coordDb.settleWork({
              workId: childWorkId,
              outcome: 'done',
              force: true,
              summary: 'Carol fast result while Bob still running',
              resultRef: 'G1',
            })
            assert.deepEqual(settleRes.wokenParents, [], 'running parent must not be woken mid-turn')
            assert.deepEqual(settleRes.satisfiedParents, [bobActive.workId])
            return { childWorkId }
          },
        })
      },
      onSessionEvent: (session, event) => {
        if (session.id === 'sess-b7i-bob' && event.type === 'turn/end') bobTurnEnded = true
        if (session.id === 'room-sess-room-b7i' && event.type === 'agent/inbox/spliced') {
          for (const msg of event.data?.inserted ?? []) {
            if (msg?.source?.role === 'post' && msg.source.resumeWorkId) {
              appendLog(home, wakesFile, {
                resumeWorkId: msg.source.resumeWorkId,
                askedBy: msg.source.askedBy,
                route: msg.source.route,
                names: msg.source.wakeSnapshot?.names ?? [],
              })
            }
          }
        }
      },
    })
    setupGroupRt(rt)
    await rt.adoptLiveWork()
    await waitUntil(() => bobTurnEnded && readLog(home, wakesFile).length > 0)
    await ctx.fiber.dispose()
    return
  }

  throw new Error(`Unknown crash scenario: ${scenario}`)
}

if (process.env.DSB_CRASH_WORKER === '1') {
  runWorker().then(
    () => process.exit(0),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
} else {
  const tempDirs = []
  function makeHome(tag) {
    const dir = mkdtempSync(join(tmpdir(), `dsb-crash-${tag}-`))
    tempDirs.push(dir)
    return dir
  }

  function spawnPhase(home, scenario, phase) {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    env.DSB_CRASH_WORKER = '1'
    env.DSB_CRASH_SCENARIO = scenario
    env.DSB_CRASH_PHASE = phase
    env.DSB_CRASH_HOME = home
    return spawnSync(process.execPath, ['--import', pathToFileURL(HARNESS_RESOLVE).href, THIS_FILE], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      for (const file of walkFiles(dir)) {
        if (process.platform === 'win32') {
          try { spawnSync('icacls', [file, '/reset'], { stdio: 'ignore' }) } catch {}
        }
        try { chmodSync(file, 0o600) } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  describe('Wave 3 real-runtime multi-process crash recovery contracts (B1–B6)', () => {
    it('B1: crash after DB claim/beginDeliveryAttempt before DSH send -> replays exactly once on restart', () => {
      const home = makeHome('b1')
      const crash = spawnPhase(home, 'B1', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B1', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const calls = readLog(home, 'llm-invocations.jsonl')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].phase, 'recover')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        assert.equal(db.getWork('work-b1').status, 'done')
      } finally {
        db.close()
      }
    })

    it('B2a: crash after DSH flushed agent/inbox/spliced (queued) before turn/start -> wakes parked message exactly once without duplicate', () => {
      const home = makeHome('b2a')
      const crash = spawnPhase(home, 'B2a', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)

      const recover = spawnPhase(home, 'B2a', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const calls = readLog(home, 'llm-invocations.jsonl')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].userTexts.length, 1)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        assert.equal(db.getWork('work-b2a').status, 'done')
      } finally {
        db.close()
      }
    })

    it('B2b: crash after DSH inbox.claim inside turn/start before user/message -> recognizes consumed=false and delivers exactly once', () => {
      const home = makeHome('b2b')
      const crash = spawnPhase(home, 'B2b', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)

      const recover = spawnPhase(home, 'B2b', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const calls = readLog(home, 'llm-invocations.jsonl')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].phase, 'recover')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        assert.equal(db.getWork('work-b2b').status, 'done')
      } finally {
        db.close()
      }
    })

    it('B3: crash mid-tool after user/message + tool/call -> pauses as needs_verification(interrupted_tools) without rerunning side effect', () => {
      const home = makeHome('b3')
      const crash = spawnPhase(home, 'B3', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'tool-invocations.jsonl').length, 1)

      const recover = spawnPhase(home, 'B3', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      // Zero re-execution of LLM or side-effecting write tool after restart
      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 1)
      assert.equal(readLog(home, 'tool-invocations.jsonl').length, 1)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const w = db.getWork('work-b3')
        assert.equal(w.status, 'needs_verification')
        assert.equal(w.pauseReason, 'interrupted_tools')
        assert.deepEqual(w.pauseDetail?.interruptedTools, ['deploy_write'])
      } finally {
        db.close()
      }
    })

    it('B4: crash after DSH turn/end completed before SQLite settleWork -> settles child from cold D2 without rerunning child and wakes parent', () => {
      const home = makeHome('b4')
      const crash = spawnPhase(home, 'B4', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B4', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const calls = readLog(home, 'llm-invocations.jsonl')
      const childCalls = calls.filter(c => c.sessionId === 'sess-b4-child')
      const parentCalls = calls.filter(c => c.sessionId === 'sess-b4-parent')
      assert.equal(childCalls.length, 1, 'child turn must NEVER rerun after already completing in DSH JSONL')
      assert.equal(childCalls[0].phase, 'crash')
      assert.equal(parentCalls.length, 1, 'parent must wake exactly once with child result')
      assert.equal(parentCalls[0].phase, 'recover')
      assert.ok(parentCalls[0].userTexts.some(t => t.includes('child-b4-answer')))

      const db = openCoordinationDb({ home, readonly: true })
      try {
        assert.equal(db.getWork('work-b4-child').status, 'done')
        assert.equal(db.getCall('call-b4')?.status, 'done')
      } finally {
        db.close()
      }
    })

    it('B5: crash after settleWork wrote parent inbox(result) + ready before parent dispatched -> wakes parent exactly once on restart', () => {
      const home = makeHome('b5')
      const crash = spawnPhase(home, 'B5', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B5', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const calls = readLog(home, 'llm-invocations.jsonl')
      const childCalls = calls.filter(c => c.sessionId === 'sess-b5-child')
      const parentCalls = calls.filter(c => c.sessionId === 'sess-b5-parent')
      assert.equal(childCalls.length, 1)
      assert.equal(parentCalls.length, 1)
      assert.equal(parentCalls[0].phase, 'recover')
      assert.ok(parentCalls[0].userTexts.some(t => t.includes('child-b5-answer')))
    })

    it('B6a: corrupt DSH session JSONL header on disk -> pauses as needs_verification(delivery_status_unreadable), never fakes not_found or reruns', () => {
      const home = makeHome('b6a')
      const crash = spawnPhase(home, 'B6a', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B6a', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)
      const db = openCoordinationDb({ home, readonly: true })
      try {
        const w = db.getWork('work-b6')
        assert.equal(w.status, 'needs_verification')
        assert.equal(w.pauseReason, 'delivery_status_unreadable')
      } finally {
        db.close()
      }
    })

    it('B6b: unreadable DSH session JSONL on disk (EACCES chmod 0o000) -> pauses as needs_verification(delivery_status_unreadable), never reruns', () => {
      const home = makeHome('b6b')
      const crash = spawnPhase(home, 'B6b', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B6b', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)
      const db = openCoordinationDb({ home, readonly: true })
      try {
        const w = db.getWork('work-b6-unreadable')
        assert.equal(w.status, 'needs_verification')
        assert.equal(w.pauseReason, 'delivery_status_unreadable')
      } finally {
        db.close()
      }
    })

    it('B7a: group room_work completed in DSH JSONL before crash -> settleRoomBatches recovers result via cold D2 and settles done (never stopped or rerun)', () => {
      const home = makeHome('b7a')
      const crash = spawnPhase(home, 'B7a', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B7a', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const llmCalls = readLog(home, 'llm-invocations.jsonl')
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-b7a-bob').length, 1, 'group member turn must not rerun after cold D2 recovery')
      const roomLines = readLog(home, 'room-b7a-ledger.jsonl')
      assert.ok(roomLines.some(line => line.botId === 'botB' && line.text === 'bob-b7a-group-answer'), 'recovered group answer must be recorded in room ledger')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        assert.ok(bobWork, 'expected persisted Bob room_work')
        assert.equal(bobWork.status, 'done', 'completed group room_work must settle done, not stopped')
      } finally {
        db.close()
      }
    })

    it('B7b: group room_work crashed mid-tool -> settleRoomBatches pauses as needs_verification(interrupted_tools), never stopped or rerun', () => {
      const home = makeHome('b7b')
      const crash = spawnPhase(home, 'B7b', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'tool-invocations.jsonl').length, 1)

      const recover = spawnPhase(home, 'B7b', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      assert.equal(readLog(home, 'tool-invocations.jsonl').length, 1, 'interrupted group tool must not rerun on restart')
      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        assert.ok(bobWork, 'expected persisted Bob room_work')
        assert.equal(bobWork.status, 'needs_verification')
        assert.equal(bobWork.pauseReason, 'interrupted_tools')
        assert.deepEqual(bobWork.pauseDetail?.interruptedTools, ['group_write_tool'])
      } finally {
        db.close()
      }
    })

    it('B7c: group room_work yielded via D4 before crash -> settleRoomBatches pauses needs_verification(yielded_before_restart), never settles done', () => {
      const isNativeDsh = existsSync(join(process.env.DSH_HARNESS ?? '', 'packages/bundle/base/package.json'))
      const home = makeHome('b7c')
      const crash = spawnPhase(home, 'B7c', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B7c', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        assert.ok(bobWork, 'expected persisted Bob room_work')
        // On native DSH (`reason.kind === 'yielded'`), cold D2 sets `yielded: true` -> MUST pause `needs_verification(yielded_before_restart)` even with 0 open waits!
        // On 0.2.2-rc.5 fallback (whose JSONL format lacks `reason.kind === 'yielded'`), open waits guard it; without an open wait 0.2.2-rc.5 records `completed`.
        if (isNativeDsh) {
          assert.equal(bobWork.status, 'needs_verification')
          assert.equal(bobWork.pauseReason, 'yielded_before_restart')
        } else {
          assert.ok(bobWork.status === 'needs_verification' || bobWork.status === 'done')
        }
      } finally {
        db.close()
      }
    })

    it('B7d: group room_work parked queued in DSH inbox before crash -> settleRoomBatches adopts via group-owned observer, wakes once, writes room ledger, and settles done via settleRoomCallWork', () => {
      const home = makeHome('b7d')
      const crash = spawnPhase(home, 'B7d', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)

      const recover = spawnPhase(home, 'B7d', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const llmCalls = readLog(home, 'llm-invocations.jsonl')
      assert.equal(llmCalls.filter(c => c.sessionId === 'sess-b7d-bob').length, 1, 'parked group message must wake exactly once')
      const roomLines = readLog(home, 'room-b7d-ledger.jsonl')
      assert.ok(roomLines.some(line => line.botId === 'botB' && line.text === 'bob-b7d-adopted-queued-answer'), 'adopted group reply must flow into room ledger')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        const aliceCaller = works.find(w => w.botId === 'botA')
        assert.equal(bobWork?.status, 'done')
        assert.equal(aliceCaller?.status, 'done', 'caller room_work must settle through settleRoomCallWork')
      } finally {
        db.close()
      }
    })

    it('B7e: adopted queued group room_work that yields via D4 on recover -> group-owned observer pauses needs_verification(yielded_after_restart) without claimToken error', () => {
      const home = makeHome('b7e')
      const crash = spawnPhase(home, 'B7e', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B7e', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        assert.equal(bobWork?.status, 'needs_verification')
        assert.equal(bobWork?.pauseReason, 'yielded_after_restart')
      } finally {
        db.close()
      }
    })

    it('B7f: adopted queued group room_work delegates nested child work and ends turn normally -> stays waiting (never settles done early) and wakes when child settles', () => {
      const home = makeHome('b7f')
      const crash = spawnPhase(home, 'B7f', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B7f', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        const carolWork = works.find(w => w.botId === 'botC')
        assert.equal(carolWork?.status, 'done')
        assert.notEqual(bobWork?.status, 'done', 'Bob must not have been settled done before nested child returned')
      } finally {
        db.close()
      }
    })

    it('B7g: group room_work hard-crashes in claimed window (after inbox.claim, before user/message) -> fails closed to needs_verification(claimed_before_restart), never silently stopped', () => {
      const home = makeHome('b7g')
      const crash = spawnPhase(home, 'B7g', 'crash')
      assert.equal(crash.status, 137, `expected hard crash 137, got ${crash.status}: ${crash.stderr}`)
      assert.equal(readLog(home, 'llm-invocations.jsonl').length, 0)

      const recover = spawnPhase(home, 'B7g', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        assert.equal(bobWork?.status, 'needs_verification')
        assert.equal(bobWork?.pauseReason, 'claimed_before_restart')
      } finally {
        db.close()
      }
    })

    it('B7h: double hard-crash after parkWaiting -> second restart preserves waiting nested parent, adopts child, and wakes parent cleanly on child settle', () => {
      const home = makeHome('b7h')
      const crash1 = spawnPhase(home, 'B7h', 'crash1')
      assert.equal(crash1.status, 137, `expected crash1 137, got ${crash1.status}: ${crash1.stderr}`)

      const crash2 = spawnPhase(home, 'B7h', 'recover1_crash2')
      assert.equal(crash2.status, 137, `expected crash2 137, got ${crash2.status}: ${crash2.stderr}`)

      const recover2 = spawnPhase(home, 'B7h', 'recover2')
      assert.equal(recover2.status, 0, `recover2 failed: ${recover2.stderr}`)

      const wakes = readLog(home, 'room-b7h-wakes.jsonl')
      assert.equal(wakes.length, 1, 'Carol completing after second restart must wake Bob exactly once')
      assert.deepEqual(wakes[0].names, ['Carol'])
      assert.equal(wakes[0].askedBy, 'botB')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        const carolWork = works.find(w => w.botId === 'botC')
        const aliceCaller = works.find(w => w.botId === 'botA')
        assert.equal(carolWork?.status, 'done')
        assert.notEqual(bobWork?.status, 'stopped', 'second restart must NOT stop parked nested parent')
        assert.notEqual(bobWork?.status, 'done', 'Bob must wait for his synthesis turn rather than settling prematurely')
        assert.equal(wakes[0].resumeWorkId, bobWork.workId)
        assert.notEqual(aliceCaller?.status, 'done')
      } finally {
        db.close()
      }
    })

    it('B7i: fast child settles BEFORE adopted parent turn ends -> watchAdoptedRoomTurn does NOT settle parent done and wakes synthesis turn with unread child result', () => {
      const home = makeHome('b7i')
      const crash = spawnPhase(home, 'B7i', 'crash')
      assert.equal(crash.status, 137, `expected crash 137, got ${crash.status}: ${crash.stderr}`)

      const recover = spawnPhase(home, 'B7i', 'recover')
      assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`)

      const wakes = readLog(home, 'room-b7i-wakes.jsonl')
      assert.equal(wakes.length, 1, 'adopted parent finishing after fast child must trigger synthesis wake')
      assert.deepEqual(wakes[0].names, ['Carol'])
      assert.equal(wakes[0].askedBy, 'botB')
      assert.equal(wakes[0].route?.kind, 'result')

      const db = openCoordinationDb({ home, readonly: true })
      try {
        const works = db.listWorks({ kind: 'room_work', limit: 20 })
        const bobWork = works.find(w => w.botId === 'botB')
        const carolWork = works.find(w => w.botId === 'botC')
        const aliceCaller = works.find(w => w.botId === 'botA')
        assert.equal(carolWork?.status, 'done')
        assert.notEqual(bobWork?.status, 'done', 'Bob must NOT settle done while fast child result is unread')
        assert.notEqual(bobWork?.status, 'stopped')
        assert.equal(wakes[0].resumeWorkId, bobWork.workId)
        assert.notEqual(aliceCaller?.status, 'done', 'Alice must NOT settle before Bob synthesizes Carol result')
      } finally {
        db.close()
      }
    })
  })
}
