import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install as installCoordDb } from '../src/host/coordination-db.js'
import { install as installAdapter, inspectDeliveryStatusFromEvents } from '../src/host/dsh-adapter.js'
import { install as installResume } from '../src/host/resume.js'
import { install as installDelivery } from '../src/host/delivery.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const tempDirs = []
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-w2a-test-'))
  tempDirs.push(dir)
  return dir
}

function makeFakeCtx({
  capabilities = {},
  agentsMap = new Map(),
  sessionEvents = new Map(),
  sessionErrors = new Map(),
  remoteAllowed = true,
  nativeDeliveryStatus,
  admitPromptContent,
} = {}) {
  const listeners = new Map()
  const cleanups = []
  const promptCalls = []
  const disposedObservations = []

  const sessionController = {
    capabilities,
    async prompt(request) {
      promptCalls.push(request)
      return { accepted: true, sessionId: request.sessionId }
    },
    async resolveAgent(sessionId) {
      const agent = agentsMap.get(sessionId)
      if (!agent) return { error: { code: 'session/not-found', message: `missing ${sessionId}` } }
      return { agent }
    },
  }
  if (typeof nativeDeliveryStatus === 'function') {
    sessionController.deliveryStatus = nativeDeliveryStatus
  }

  const ctx = {
    sessionController,
    sessions: {
      async flush() {},
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const arr = listeners.get(event)
        if (arr) {
          const idx = arr.indexOf(handler)
          if (idx !== -1) arr.splice(idx, 1)
        }
      }
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => cleanup?.()
    },
    get(service) {
      if (service === 'agents') {
        return {
          get: id => agentsMap.get(id),
          list: () => [...agentsMap.values()],
        }
      }
      if (service === 'sessionQuery') {
        return {
          async observeSession(sessionId) {
            if (sessionErrors.has(sessionId)) throw sessionErrors.get(sessionId)
            const events = sessionEvents.get(sessionId)
            if (!events) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
            return {
              events,
              inheritedEventCount: 0,
              [Symbol.dispose]() {
                disposedObservations.push(sessionId)
              },
            }
          },
        }
      }
      if (service === 'attachments' && typeof admitPromptContent === 'function') {
        return { admitPromptContent }
      }
      if (service === 'remoteAccess') {
        return {
          async allows({ id }) {
            return typeof remoteAllowed === 'function' ? remoteAllowed(id) : remoteAllowed
          },
        }
      }
      return undefined
    },
    async runHook(event, payload, terminalNext) {
      const handlers = listeners.get(event) ?? []
      let idx = 0
      const next = async () => {
        if (idx < handlers.length) {
          const fn = handlers[idx++]
          return fn(payload, next)
        }
        return terminalNext()
      }
      return next()
    },
    dispose() {
      while (cleanups.length > 0) cleanups.pop()()
    },
    promptCalls,
    disposedObservations,
  }
  return ctx
}

function makeFakeAgent(sessionId, { zeroWakeNote = false, status = 'idle' } = {}) {
  const followups = []
  const steers = []
  const notes = []
  const cancelled = []
  const agent = {
    id: sessionId,
    status,
    session: { id: sessionId, snapshotEvents: () => [] },
    inbox: {
      nextStep: [],
      nextTurn: [],
      remove(id) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(m => m.id === id)
          if (at !== -1) {
            list.splice(at, 1)
            return true
          }
        }
        return false
      },
    },
    capabilities: { zeroWakeNote },
    followup(msg, opts) { followups.push({ msg, opts }) },
    steer(msg, opts) { steers.push({ msg, opts }) },
    cancel(reason) { cancelled.push(reason) },
    followups,
    steers,
    notes,
    cancelled,
  }
  if (zeroWakeNote) {
    agent.appendNote = (msg, opts) => { notes.push({ msg, opts }) }
  }
  return agent
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('W2-A dsh-adapter + delivery + resume', () => {
  it('D2 inspectDeliveryStatusFromEvents replays real DSH inbox splices, fork boundary, and tool/result error codes', () => {
    const events = [
      // Inherited parent events (indices 0..3)
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'agent/inbox/spliced', data: { target: 'note', start: 0, removedCount: 0, inserted: [{ id: 'n0', source: { idempotencyKey: 'inherited-note' } }] } },
      { seq: 3, type: 'user/message', data: { source: { idempotencyKey: 'inherited-key' } } },
      { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      // Fork boundary at index 4 (`inheritedEventCount = 4`)
      { seq: 5, type: 'session/end-seed', data: { inherited: true } },
      { seq: 6, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm1', source: { idempotencyKey: 'b3-key' } }] } },
      { seq: 7, type: 'turn/start', data: { turn: 2 } },
      // Real DSH claim splice: `{ target, start, removedCount, inserted: [], outcome: 'claimed' }`
      { seq: 8, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'claimed' } },
      { seq: 9, type: 'tool/call', data: { callId: 'c1', name: 'read_file' } },
      { seq: 10, type: 'tool/result', data: { message: { source: { callId: 'c1', toolName: 'read_file' } } } },
      { seq: 11, type: 'tool/call', data: { callId: 'c2', name: 'bash' } },
      { seq: 12, type: 'tool/result', data: { message: { source: { callId: 'c2', toolName: 'bash' } }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } },
      { seq: 13, type: 'tool/call', data: { callId: 'c3', name: 'write_file' } },
    ]

    const inherited = inspectDeliveryStatusFromEvents(events, { idempotencyKey: 'inherited-key' }, { inheritedEventCount: 4, liveStatus: 'idle' })
    assert.equal(inherited.status, 'not_found')

    // B3/B4 crash window: claimed via splice before user/message, host is idle -> aborted with c2 (TOOL_OUTCOME_UNKNOWN) + c3 (still open), NOT c1 (completed cleanly).
    const crashed = inspectDeliveryStatusFromEvents(events, { idempotencyKey: 'b3-key' }, { inheritedEventCount: 4, liveStatus: 'idle' })
    assert.equal(crashed.status, 'aborted')
    assert.equal(crashed.consumed, false)
    assert.equal(crashed.cancelCause, 'interrupted')
    assert.deepEqual(crashed.interruptedTools, ['bash', 'write_file'])

    const live = inspectDeliveryStatusFromEvents(events, { idempotencyKey: 'b3-key' }, { inheritedEventCount: 4, liveStatus: 'running' })
    assert.equal(live.status, 'running')
    assert.equal(live.turn, 2)

    // Canceled splice before consumption -> aborted, consumed: false
    const canceledEvents = [
      { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm9', source: { idempotencyKey: 'cancel-key' } }] } },
      { seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
    ]
    const canceled = inspectDeliveryStatusFromEvents(canceledEvents, { idempotencyKey: 'cancel-key' }, { liveStatus: 'idle' })
    assert.equal(canceled.status, 'aborted')
    assert.equal(canceled.consumed, false)
  })

  it('D2 native deliveryStatus uses flat { sessionId, ...query }, disposes observeSession, and propagates I/O errors', async () => {
    const home = makeHome()
    const seenReqs = []
    const ctxNative = makeFakeCtx({
      sessionEvents: new Map([['sess-valid-b1', []]]),
      nativeDeliveryStatus: async (req) => {
        seenReqs.push(req)
        if (req.sessionId === 'sess-native') {
          return { status: 'completed', consumed: true, toolCalls: 0, interruptedTools: [] }
        }
        return { status: 'not_found', consumed: false, toolCalls: 0, interruptedTools: [] }
      },
    })
    const rtNative = { ctx: ctxNative, home, readOnly: () => undefined, warn: () => {} }
    installCoordDb(rtNative)
    installAdapter(rtNative)

    const res = await rtNative.queryDeliveryStatus('sess-native', { idempotencyKey: 'k1' })
    assert.equal(res.status, 'completed')
    assert.deepEqual(seenReqs[0], { sessionId: 'sess-native', idempotencyKey: 'k1' })

    // Native D2 returning `not_found` for a valid indexed session on disk (B1) stays `not_found` (and disposes probe lease).
    const validDir = join(home, 'sessions', 'cwd1', 'sess-valid-b1')
    mkdirSync(validDir, { recursive: true })
    writeFileSync(join(validDir, 'session.v4.jsonl'), '{"type":"header"}\n', 'utf8')
    const b1Res = await rtNative.queryDeliveryStatus('sess-valid-b1', { idempotencyKey: 'unsent' })
    assert.equal(b1Res.status, 'not_found')
    assert.deepEqual(ctxNative.disposedObservations, ['sess-valid-b1'])

    // Native D2 returning `not_found` when persisted file exists on disk but observeSession throws not-found (B6a corrupt header) -> fails closed!
    const corruptDir = join(home, 'sessions', 'cwd1', 'sess-native-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'session.v4.jsonl'), '{corrupt-header\n', 'utf8')
    await assert.rejects(
      () => rtNative.queryDeliveryStatus('sess-native-corrupt', { idempotencyKey: 'k-corrupt' }),
      err => err.code === 'session/log_unreadable',
    )
    ctxNative.dispose()

    // Fallback observeSession disposes lease and propagates non-not-found errors.
    const ctxFallback = makeFakeCtx({
      sessionEvents: new Map([['sess-ok', []]]),
      sessionErrors: new Map([['sess-io-err', Object.assign(new Error('EIO disk error'), { code: 'EIO' })]]),
    })
    const rtFallback = { ctx: ctxFallback, home: makeHome(), readOnly: () => undefined, warn: () => {} }
    installCoordDb(rtFallback)
    installAdapter(rtFallback)

    const okStatus = await rtFallback.queryDeliveryStatus('sess-ok', { idempotencyKey: 'missing' })
    assert.equal(okStatus.status, 'not_found')
    assert.deepEqual(ctxFallback.disposedObservations, ['sess-ok'])

    const notFoundStatus = await rtFallback.queryDeliveryStatus('sess-absent', { idempotencyKey: 'missing' })
    assert.equal(notFoundStatus.status, 'not_found')

    await assert.rejects(
      () => rtFallback.queryDeliveryStatus('sess-io-err', { idempotencyKey: 'k2' }),
      err => err.code === 'EIO',
    )

    // B6 corrupt-header case: DSH skipped indexing and threw SESSION_QUERY_SESSION_NOT_FOUND,
    // while the persisted `.jsonl` file exists on disk (both real nested `<cwdKey>/<sessionId>/session.v4.jsonl`
    // and flat `<sessionId>.jsonl` layouts) -> MUST throw `session/log_unreadable`!
    const sessionsDir = join(rtFallback.home, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'sess-corrupt-hdr.jsonl'), '{corrupt-header\n', 'utf8')
    await assert.rejects(
      () => rtFallback.queryDeliveryStatus('sess-corrupt-hdr', { idempotencyKey: 'k3' }),
      err => err.code === 'session/log_unreadable',
    )
    const nestedDir = join(sessionsDir, 'cwd-hash-1', 'sess-nested-corrupt')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(nestedDir, 'session.v4.jsonl'), '{corrupt-header\n', 'utf8')
    await assert.rejects(
      () => rtFallback.queryDeliveryStatus('sess-nested-corrupt', { idempotencyKey: 'k3b' }),
      err => err.code === 'session/log_unreadable',
    )
    // Short/prefix sessionId must NOT falsely match sibling file or directory names.
    const shortNotFound = await rtFallback.queryDeliveryStatus('sess', { idempotencyKey: 'k4' })
    assert.equal(shortNotFound.status, 'not_found')
    ctxFallback.dispose()
  })

  it('D1 fallback buffers note without waking and acks ONLY note seq without touching earlier unread request', async () => {
    const home = makeHome()
    const agent = makeFakeAgent('sess-fg-1', { zeroWakeNote: false })
    const ctx = makeFakeCtx({ agentsMap: new Map([['sess-fg-1', agent]]) })
    const rt = {
      ctx,
      home,
      state: { bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-fg-1' } }, rooms: {}, exchanges: [] },
      readOnly: () => undefined,
      warn: () => {},
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      chatOf: id => rt.state.bots[id]?.sessionId,
      ledger: { importer() {}, records: () => [], append() {}, written: async () => {}, drop() {} },
    }
    installCoordDb(rt)
    installAdapter(rt)
    installDelivery(rt)

    const { work } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg-1' })

    // Insert seq 1 unread waking request first, then seq 2 silent note.
    rt.coordDb.receiveMessage({ workId: work.workId, kind: 'request', bodyPreview: 'Important task', wake: true })
    await rt.deliver({
      fromId: 'botA',
      toId: 'botA',
      sessionId: 'sess-fg-1',
      role: 'note',
      text: 'FYI background status update',
      wake: false,
    })
    assert.equal(agent.followups.length, 0)
    assert.equal(rt.coordDb.listInbox(work.workId, { unreadOnly: true }).length, 2)

    // Pre-step with only non-waking context does NOT attach note.
    const nonWakingDecision = await ctx.runHook('agent/pre-step', {
      agent,
      step: 1,
      messages: [{ source: { kind: 'time-context' } }],
    }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'time-context' } }] }))
    assert.equal(nonWakingDecision.messages.length, 1)

    // Pre-step with waking user message prepends note without marking SQLite read yet.
    const wakingDecision = await ctx.runHook('agent/pre-step', {
      agent,
      step: 1,
      messages: [{ source: { kind: 'user' } }],
    }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'user' } }] }))
    assert.equal(wakingDecision.messages.length, 2)
    assert.equal(wakingDecision.messages[0].source.coordNoteSeq, 2)
    assert.equal(rt.coordDb.listInbox(work.workId, { unreadOnly: true }).length, 2)

    // Acking note seq 2 via `turn/user-message` must mark ONLY seq 2 read, leaving seq 1 unread!
    rt.notifyTurnLifecycle({
      type: 'turn/user-message',
      sessionId: 'sess-fg-1',
      turn: 1,
      source: wakingDecision.messages[0].source,
    })
    const remaining = rt.coordDb.listInbox(work.workId, { unreadOnly: true })
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].seq, 1)
    assert.equal(remaining[0].kind, 'request')
    ctx.dispose()
  })

  it('D1 native appendNote delivers immediately with coordNoteSeq for clean ack', async () => {
    const home = makeHome()
    const agent = makeFakeAgent('sess-fg-2', { zeroWakeNote: true })
    const ctx = makeFakeCtx({ capabilities: { zeroWakeNote: true }, agentsMap: new Map([['sess-fg-2', agent]]) })
    const rt = {
      ctx,
      home,
      state: { bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-fg-2' } }, rooms: {}, exchanges: [] },
      readOnly: () => undefined,
      warn: () => {},
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      chatOf: id => rt.state.bots[id]?.sessionId,
      ledger: { importer() {}, records: () => [], append() {}, written: async () => {}, drop() {} },
    }
    installCoordDb(rt)
    installAdapter(rt)
    installDelivery(rt)

    const { work } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg-2' })
    const res = await rt.dispatchNote(work.workId, 'Native zero-wake note', { idempotencyKey: 'note-1' })
    assert.equal(res.delivered, true)
    assert.equal(res.queuedInDb, true)
    assert.equal(agent.notes.length, 1)
    assert.equal(agent.notes[0].msg.source.coordWorkId, work.workId)
    assert.equal(agent.notes[0].msg.source.coordNoteSeq, 1)

    rt.notifyTurnLifecycle({
      type: 'turn/user-message',
      sessionId: 'sess-fg-2',
      turn: 1,
      source: agent.notes[0].msg.source,
    })
    assert.equal(rt.coordDb.listInbox(work.workId, { unreadOnly: true }).length, 0)
    ctx.dispose()
  })

  it('D3 native session/before-prompt gate supports handled, redirect, and reject, while 0.2.2-rc.5 never wraps sessionController.prompt', async () => {
    const home = makeHome()
    let admittedCalled = false
    const ctxNative = makeFakeCtx({
      capabilities: { beforePrompt: true },
      admitPromptContent: async content => {
        admittedCalled = true
        return [...content, { type: 'admitted' }]
      },
    })
    const rtNative = { ctx: ctxNative, home, readOnly: () => undefined, warn: () => {} }
    installCoordDb(rtNative)
    installAdapter(rtNative)

    rtNative.registerPromptGate(async ({ sessionId, admitContent }) => {
      if (sessionId === 'sess-handled') {
        const blocks = await admitContent()
        assert.equal(blocks.at(-1).type, 'admitted')
        return { kind: 'handled' }
      }
      if (sessionId === 'sess-redirect-ok') return { kind: 'redirect', sessionId: 'sess-allowed', mode: 'followup' }
      if (sessionId === 'sess-reject') return { kind: 'reject', code: 'bot/stale', message: 'rejected' }
      return { kind: 'pass' }
    })

    const r1 = await ctxNative.runHook('session/before-prompt', {
      request: { sessionId: 'sess-handled', content: [{ type: 'text', text: 'hi' }] },
      admitContent: async () => {
        admittedCalled = true
        return [{ type: 'text', text: 'hi' }, { type: 'admitted' }]
      },
    }, async () => ({ kind: 'pass' }))
    assert.deepEqual(r1, { kind: 'handled' })
    assert.equal(admittedCalled, true)

    const r2 = await ctxNative.runHook('session/before-prompt', {
      request: { sessionId: 'sess-redirect-ok', content: [] },
    }, async () => ({ kind: 'pass' }))
    assert.deepEqual(r2, { kind: 'redirect', sessionId: 'sess-allowed', mode: 'followup' })

    const r3 = await ctxNative.runHook('session/before-prompt', {
      request: { sessionId: 'sess-reject', content: [] },
    }, async () => ({ kind: 'pass' }))
    assert.equal(r3.kind, 'reject')
    ctxNative.dispose()

    // Official 0.2.2-rc.5 (beforePrompt: false): never monkey-patches sessionController.prompt.
    const ctxFallback = makeFakeCtx({ capabilities: { beforePrompt: false } })
    const originalPrompt = ctxFallback.sessionController.prompt
    const rtFallback = { ctx: ctxFallback, home, readOnly: () => undefined, warn: () => {} }
    installCoordDb(rtFallback)
    installAdapter(rtFallback)
    assert.equal(ctxFallback.sessionController.prompt, originalPrompt)
    ctxFallback.dispose()
  })

  it('D4 fallback yieldToolTurn concludes turn and breaks step > 1 cleanly with enter []', async () => {
    const home = makeHome()
    const agent = makeFakeAgent('sess-yield')
    const ctx = makeFakeCtx({ agentsMap: new Map([['sess-yield', agent]]) })
    const rt = { ctx, home, readOnly: () => undefined, warn: () => {} }
    installCoordDb(rt)
    installAdapter(rt)

    let concluded = false
    rt.yieldToolTurn({ sessionId: 'sess-yield', concludeTurn: () => { concluded = true } }, 'waiting_child')
    assert.equal(concluded, true)

    const step2 = await ctx.runHook('agent/pre-step', {
      agent,
      step: 2,
      messages: [],
    }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'user' } }] }))
    assert.deepEqual(step2, { kind: 'enter', messages: [] })
    ctx.dispose()
  })

  it('kickScheduler dispatches ready work, does not prematurely ack on turn/started, and settles parent on turn/ended', async () => {
    const home = makeHome()
    const fgAgent = makeFakeAgent('sess-fg')
    const taskAgent = makeFakeAgent('sess-task-1')
    const ctx = makeFakeCtx({
      agentsMap: new Map([
        ['sess-fg', fgAgent],
        ['sess-task-1', taskAgent],
      ]),
    })
    const rt = {
      ctx,
      home,
      readOnly: () => undefined,
      warn: () => {},
      resolveAgent: async id => ctx.get('agents').get(id),
      localAgentCapability: () => ({ isLocalAgent: false, supportsSteer: true, serialPerSession: false, exclusiveWorkspace: false }),
    }
    installCoordDb(rt)
    installAdapter(rt)

    const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg' })
    const { work: childWork } = rt.coordDb.createWork({
      botId: 'botB',
      kind: 'task',
      parentWorkId: parent.workId,
      sessionId: 'sess-task-1',
    })
    rt.coordDb.createCall({
      parentWorkId: parent.workId,
      childWorkId: childWork.workId,
      callerBotId: 'botA',
      calleeBotId: 'botB',
      returnAddress: parent.logicalAddress,
      initialMessage: { bodyPreview: 'Build report' },
      required: true,
    })

    const settledEvents = []
    rt.onWorkSettled(ev => settledEvents.push(ev))

    await rt.kickScheduler()
    assert.equal(taskAgent.followups.length, 1)
    const sentMsg = taskAgent.followups[0].msg
    assert.equal(sentMsg.source.coordWorkId, childWork.workId)
    assert.equal(taskAgent.followups[0].opts.idempotencyKey, sentMsg.source.idempotencyKey)

    // `turn/started` records activeTurn WITHOUT prematurely marking inbox rows read!
    rt.notifyTurnLifecycle({ type: 'turn/started', sessionId: 'sess-task-1', turn: 1 })
    assert.equal(rt.coordDb.getWork(childWork.workId).activeTurn, 1)
    assert.equal(rt.coordDb.listInbox(childWork.workId, { unreadOnly: true }).length, 1)

    // Only `turn/user-message` commits inbox read watermark.
    rt.notifyTurnLifecycle({ type: 'turn/user-message', sessionId: 'sess-task-1', turn: 1, source: sentMsg.source })
    assert.equal(rt.coordDb.listInbox(childWork.workId, { unreadOnly: true }).length, 0)

    // Turn completion settles child and wakes parent.
    rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-task-1', turn: 1, reasonKind: 'completed', text: 'Report ready' })
    await new Promise(resolve => setImmediate(resolve))
    await rt.kickScheduler()

    assert.equal(rt.coordDb.getWork(childWork.workId).status, 'done')
    assert.equal(settledEvents.length, 1)
    assert.equal(fgAgent.followups.length, 1)
    assert.match(fgAgent.followups[0].msg.content[0].text, /Report ready/)
    ctx.dispose()
  })

  it('kickScheduler avoids CLI livelock and merges concurrent workId kicks without dropping later targets', async () => {
    const home = makeHome()
    const cliAgent1 = makeFakeAgent('sess-cli-1')
    const cliAgent2 = makeFakeAgent('sess-cli-2')
    const otherAgent = makeFakeAgent('sess-other')
    const ctx = makeFakeCtx({
      agentsMap: new Map([
        ['sess-cli-1', cliAgent1],
        ['sess-cli-2', cliAgent2],
        ['sess-other', otherAgent],
      ]),
    })

    let resolveSlowFirst
    const slowFirstPromise = new Promise(resolve => { resolveSlowFirst = resolve })

    const rt = {
      ctx,
      home,
      readOnly: () => undefined,
      warn: () => {},
      resolveAgent: async (id) => {
        if (id === 'sess-cli-1') await slowFirstPromise
        return ctx.get('agents').get(id)
      },
      localAgentCapability: (botId) => (botId === 'botCli'
        ? { isLocalAgent: true, supportsSteer: false, serialPerSession: true, exclusiveWorkspace: true }
        : { isLocalAgent: false, supportsSteer: true, serialPerSession: false, exclusiveWorkspace: false }),
    }
    installCoordDb(rt)
    installAdapter(rt)

    const { work: wCli1 } = rt.coordDb.createWork({ botId: 'botCli', kind: 'task', sessionId: 'sess-cli-1', workspaceDir: '/repo', workspaceMode: 'read' })
    const { work: wCli2 } = rt.coordDb.createWork({ botId: 'botCli', kind: 'task', sessionId: 'sess-cli-2', workspaceDir: '/repo', workspaceMode: 'read' })
    const { work: wOther } = rt.coordDb.createWork({ botId: 'botOther', kind: 'task', sessionId: 'sess-other', workspaceDir: '/other' })
    rt.coordDb.receiveMessage({ workId: wCli1.workId, kind: 'request', bodyPreview: 'CLI task 1', wake: true })
    rt.coordDb.receiveMessage({ workId: wCli2.workId, kind: 'request', bodyPreview: 'CLI task 2', wake: true })
    rt.coordDb.receiveMessage({ workId: wOther.workId, kind: 'request', bodyPreview: 'Other task', wake: true })

    // Kick targeted wCli1 first, then while pumping concurrently kick all (must not lose wOther!).
    const p1 = rt.kickScheduler({ workId: wCli1.workId })
    const p2 = rt.kickScheduler()
    resolveSlowFirst()
    await Promise.all([p1, p2])

    // wCli1 dispatched, wCli2 deferred due to exclusiveWorkspace (not livelocked), wOther dispatched immediately!
    assert.equal(cliAgent1.followups.length, 1)
    assert.equal(cliAgent2.followups.length, 0)
    assert.equal(otherAgent.followups.length, 1)
    assert.equal(rt.coordDb.getWork(wCli2.workId).status, 'queued')
    ctx.dispose()
  })

  it('resume.js adoptLiveWork migrates legacy inflight.json once, reconciles cold via D2, and pauses on unreadable log', async () => {
    const home = makeHome()
    writeFileSync(join(home, 'inflight.json'), JSON.stringify({
      version: 1,
      turns: {},
      queued: {},
    }), 'utf8')

    const sessionEvents = new Map([
      ['sess-task-cold', [
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dlv-cold-1' } } },
        { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Finished before crash' }] } } },
        { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ]],
    ])
    const sessionErrors = new Map([
      ['sess-task-corrupt', Object.assign(new Error('corrupt jsonl'), { code: 'EIO' })],
    ])
    const fgAgent = makeFakeAgent('sess-fg')
    const ctx = makeFakeCtx({
      agentsMap: new Map([['sess-fg', fgAgent]]),
      sessionEvents,
      sessionErrors,
    })
    let hydratedCold = false
    const rt = {
      ctx,
      home,
      state: {
        bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-fg' } },
        rooms: {},
        works: {},
      },
      load: async () => {},
      readOnly: () => undefined,
      warn: () => {},
      chatOf: id => rt.state.bots[id]?.sessionId,
      resolveAgent: async (id) => {
        if (id === 'sess-task-cold' || id === 'sess-task-corrupt') hydratedCold = true
        return ctx.get('agents').get(id)
      },
    }
    installCoordDb(rt)
    installAdapter(rt)
    installResume(rt)

    const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg' })
    const { work: childWork } = rt.coordDb.createWork({
      botId: 'botA',
      kind: 'task',
      parentWorkId: parent.workId,
      sessionId: 'sess-task-cold',
    })
    rt.coordDb.createCall({
      parentWorkId: parent.workId,
      childWorkId: childWork.workId,
      callerBotId: 'botA',
      calleeBotId: 'botA',
      returnAddress: parent.logicalAddress,
      initialMessage: { bodyPreview: 'Cold task' },
    })
    const claim1 = rt.coordDb.claimReady({ workId: childWork.workId })
    rt.coordDb.beginDeliveryAttempt({
      workId: childWork.workId,
      claimToken: claim1.claimToken,
      throughSeq: claim1.claimedInboxSeq,
      sessionId: 'sess-task-cold',
      idempotencyKey: 'dlv-cold-1',
    })

    // Second interrupted work whose session log throws EIO -> MUST pause as needs_verification, NOT requeue blindly!
    const { work: corruptWork } = rt.coordDb.createWork({
      botId: 'botA',
      kind: 'task',
      sessionId: 'sess-task-corrupt',
    })
    rt.coordDb.receiveMessage({ workId: corruptWork.workId, kind: 'request', bodyPreview: 'Corrupt log task', wake: true })
    const claim2 = rt.coordDb.claimReady({ workId: corruptWork.workId })
    rt.coordDb.beginDeliveryAttempt({
      workId: corruptWork.workId,
      claimToken: claim2.claimToken,
      throughSeq: claim2.claimedInboxSeq,
      sessionId: 'sess-task-corrupt',
      idempotencyKey: 'dlv-corrupt-1',
    })

    await rt.adoptLiveWork()

    assert.equal(hydratedCold, false)
    assert.equal(existsSync(join(home, 'inflight.json')), false)
    assert.equal(existsSync(join(home, 'inflight.json.migrated')), true)
    assert.equal(rt.coordDb.getWork(childWork.workId).status, 'done')
    assert.equal(rt.coordDb.getWork(corruptWork.workId).status, 'needs_verification')
    assert.equal(rt.coordDb.getWork(corruptWork.workId).pauseReason, 'delivery_status_unreadable')
    assert.equal(fgAgent.followups.length, 1)
    assert.match(fgAgent.followups[0].msg.content[0].text, /Finished before crash/)
    assert.deepEqual(ctx.disposedObservations, ['sess-task-cold'])
    ctx.dispose()
  })

  it('B2a adoptLiveWork wakes parked queued delivery without duplicating and settles on turn/ended (native & fallback)', async () => {
    // 1. Native D2 mode (`agent.send` with `idempotencyKey`)
    {
      const home = makeHome()
      const fgAgent = makeFakeAgent('sess-fg-b2a')
      const parkedAgent = makeFakeAgent('sess-b2a-native', { status: 'idle' })
      const sentNative = []
      parkedAgent.capabilities = { idempotency: true }
      parkedAgent.send = (msg, target, wake, opts) => { sentNative.push({ msg, target, wake, opts }) }
      parkedAgent.inbox.nextTurn.push({
        id: 'm-parked-1',
        content: [{ type: 'text', text: 'Parked native task' }],
        source: { kind: SOURCE_KIND, idempotencyKey: 'dlv-b2a-native', coordWorkId: 'w-b2a-native' },
      })
      const ctx = makeFakeCtx({
        capabilities: { idempotency: true },
        agentsMap: new Map([
          ['sess-fg-b2a', fgAgent],
          ['sess-b2a-native', parkedAgent],
        ]),
        nativeDeliveryStatus: async () => ({ status: 'queued', consumed: false, messageId: 'm-parked-1', toolCalls: 0, interruptedTools: [] }),
      })
      const rt = {
        ctx,
        home,
        state: { bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-fg-b2a' } }, rooms: {}, works: {} },
        load: async () => {},
        readOnly: () => undefined,
        warn: () => {},
        chatOf: id => rt.state.bots[id]?.sessionId,
        resolveAgent: async id => ctx.get('agents').get(id),
      }
      installCoordDb(rt)
      installAdapter(rt)
      installResume(rt)

      const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg-b2a' })
      const { work: childWork } = rt.coordDb.createWork({ workId: 'w-b2a-native', botId: 'botA', kind: 'task', parentWorkId: parent.workId, sessionId: 'sess-b2a-native' })
      rt.coordDb.createCall({ parentWorkId: parent.workId, childWorkId: childWork.workId, callerBotId: 'botA', calleeBotId: 'botA', returnAddress: parent.logicalAddress, initialMessage: { bodyPreview: 'Parked native task' } })
      const claim = rt.coordDb.claimReady({ workId: childWork.workId })
      rt.coordDb.beginDeliveryAttempt({ workId: childWork.workId, claimToken: claim.claimToken, throughSeq: claim.claimedInboxSeq, sessionId: 'sess-b2a-native', idempotencyKey: 'dlv-b2a-native' })

      await rt.adoptLiveWork()

      assert.equal(sentNative.length, 1)
      assert.equal(sentNative[0].target, 'next-turn')
      assert.equal(sentNative[0].wake, true)
      assert.equal(sentNative[0].opts.idempotencyKey, 'dlv-b2a-native')
      assert.equal(parkedAgent.followups.length, 0)

      // Claim was re-registered so turn/ended settles child and wakes parent!
      rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-b2a-native', turn: 1, reasonKind: 'completed', text: 'B2a native done' })
      await new Promise(resolve => setImmediate(resolve))
      await rt.kickScheduler()
      assert.equal(rt.coordDb.getWork(childWork.workId).status, 'done')
      assert.equal(fgAgent.followups.length, 1)
      assert.match(fgAgent.followups[0].msg.content[0].text, /B2a native done/)
      ctx.dispose()
    }

    // 2. Fallback 0.2.2-rc.5 mode (removes parked inbox entry then re-enqueues once via followup)
    {
      const home = makeHome()
      const fgAgent = makeFakeAgent('sess-fg-b2a-fb')
      const parkedAgent = makeFakeAgent('sess-b2a-fb', { status: 'idle' })
      parkedAgent.inbox.nextTurn.push({
        id: 'm-parked-fb',
        content: [{ type: 'text', text: 'Parked fallback task' }],
        source: { kind: SOURCE_KIND, idempotencyKey: 'dlv-b2a-fb', coordWorkId: 'w-b2a-fb' },
      })
      const sessionEvents = new Map([
        ['sess-b2a-fb', [
          { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm-parked-fb', source: { kind: SOURCE_KIND, idempotencyKey: 'dlv-b2a-fb' } }] } },
        ]],
      ])
      const ctx = makeFakeCtx({
        capabilities: {},
        agentsMap: new Map([['sess-fg-b2a-fb', fgAgent]]),
        sessionEvents,
      })
      const rt = {
        ctx,
        home,
        state: { bots: { botA: { id: 'botA', name: 'Alpha', sessionId: 'sess-fg-b2a-fb' } }, rooms: {}, works: {} },
        load: async () => {},
        readOnly: () => undefined,
        warn: () => {},
        chatOf: id => rt.state.bots[id]?.sessionId,
        resolveAgent: async id => (id === 'sess-b2a-fb' ? parkedAgent : ctx.get('agents').get(id)),
      }
      installCoordDb(rt)
      installAdapter(rt)
      installResume(rt)

      const { work: parent } = rt.coordDb.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-fg-b2a-fb' })
      const { work: childWork } = rt.coordDb.createWork({ workId: 'w-b2a-fb', botId: 'botA', kind: 'task', parentWorkId: parent.workId, sessionId: 'sess-b2a-fb' })
      rt.coordDb.createCall({ parentWorkId: parent.workId, childWorkId: childWork.workId, callerBotId: 'botA', calleeBotId: 'botA', returnAddress: parent.logicalAddress, initialMessage: { bodyPreview: 'Parked fallback task' } })
      const claim = rt.coordDb.claimReady({ workId: childWork.workId })
      rt.coordDb.beginDeliveryAttempt({ workId: childWork.workId, claimToken: claim.claimToken, throughSeq: claim.claimedInboxSeq, sessionId: 'sess-b2a-fb', idempotencyKey: 'dlv-b2a-fb' })

      await rt.adoptLiveWork()

      assert.equal(parkedAgent.inbox.nextTurn.length, 0)
      assert.equal(parkedAgent.followups.length, 1)
      assert.equal(parkedAgent.followups[0].msg.source.idempotencyKey, 'dlv-b2a-fb')

      rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-b2a-fb', turn: 1, reasonKind: 'completed', text: 'B2a fallback done' })
      await new Promise(resolve => setImmediate(resolve))
      await rt.kickScheduler()
      assert.equal(rt.coordDb.getWork(childWork.workId).status, 'done')
      assert.equal(fgAgent.followups.length, 1)
      assert.match(fgAgent.followups[0].msg.content[0].text, /B2a fallback done/)
      ctx.dispose()
    }
  })

  it('W2-A cross-module guards: bot.private privacyScoped, universal session mutex, runningJobs yield, and rich resultMeta', async () => {
    const home = makeHome()
    const sharedAgent = makeFakeAgent('sess-shared')
    const parentAgent = makeFakeAgent('sess-parent')
    const ctx = makeFakeCtx({
      agentsMap: new Map([
        ['sess-shared', sharedAgent],
        ['sess-parent', parentAgent],
      ]),
    })
    let activeJobs = [{ id: 'job-1' }]
    const rt = {
      ctx,
      home,
      state: {
        bots: {
          botP: { id: 'botP', name: 'Parent', sessionId: 'sess-parent', private: true },
          botW: { id: 'botW', name: 'Worker', sessionId: 'sess-shared' },
        },
        rooms: {},
        works: {},
      },
      load: async () => {},
      readOnly: () => undefined,
      warn: () => {},
      botOf: id => rt.state.bots[id],
      chatOf: id => rt.state.bots[id]?.sessionId,
      resolveAgent: async id => ctx.get('agents').get(id),
      runningJobs: sid => (sid === 'sess-shared' ? activeJobs : []),
    }
    installCoordDb(rt)
    installAdapter(rt)
    installResume(rt)

    // 1. `bot.private === true` sets `privacyScoped: true` on resume + legacy import!
    await rt.adoptLiveWork()
    const fgP = rt.coordDb.getForegroundWork('botP')
    assert.equal(fgP.privacyScoped, true)
    assert.equal(fgP.visibility, 'private')

    // 2. Two works sharing one normal DSH session: second is deferred (universal activeClaims mutex), NOT overwritten!
    const { work: w1 } = rt.coordDb.createWork({ workId: 'w_shared_1', workRef: 'W-7', botId: 'botW', kind: 'task', parentWorkId: fgP.workId, sessionId: 'sess-shared' })
    const { work: w2 } = rt.coordDb.createWork({ workId: 'w_shared_2', workRef: 'W-8', botId: 'botW', kind: 'task', parentWorkId: fgP.workId, sessionId: 'sess-shared' })
    rt.coordDb.createCall({ parentWorkId: fgP.workId, childWorkId: w1.workId, callerBotId: 'botP', calleeBotId: 'botW', returnAddress: fgP.logicalAddress, initialMessage: { bodyPreview: 'First' } })
    rt.coordDb.createCall({ parentWorkId: fgP.workId, childWorkId: w2.workId, callerBotId: 'botP', calleeBotId: 'botW', returnAddress: fgP.logicalAddress, initialMessage: { bodyPreview: 'Second' } })

    await rt.kickScheduler()
    assert.equal(sharedAgent.followups.length, 1)
    assert.equal(sharedAgent.followups[0].msg.source.coordWorkId, w1.workId)
    assert.equal(rt.coordDb.getWork(w2.workId).status, 'queued')

    // Stop w2 so steps 3 & 4 isolate w1's slow-job yield and parent wakeup cleanly.
    rt.coordDb.stopWork(w2.workId, { reason: 'test_cleanup' })

    // 3. `turn/ended` while `runningJobs(sessionId)` is non-empty -> yields to `waiting`, does NOT prematurely settle `done`!
    rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-shared', turn: 1, reasonKind: 'completed', text: 'Waiting on slow job' })
    assert.equal(rt.coordDb.getWork(w1.workId).status, 'waiting')

    // 4. Once jobs finish and w1 resumes & completes, `settleWork` forwards rich `resultMeta` (`replyTo`, `workRef`, `senderName`, protocol header)!
    activeJobs = []
    rt.coordDb.receiveMessage({ workId: w1.workId, kind: 'answer', bodyPreview: 'Job done', wake: true })
    await rt.kickScheduler({ workId: w1.workId })
    rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-shared', turn: 2, reasonKind: 'completed', text: 'Final verified answer' })
    await new Promise(resolve => setImmediate(resolve))
    await rt.kickScheduler()

    assert.equal(rt.coordDb.getWork(w1.workId).status, 'done')
    assert.equal(parentAgent.followups.length, 1)
    const delivered = parentAgent.followups[0].msg
    assert.equal(delivered.source.role, 'reply')
    assert.equal(delivered.source.replyTo, w1.workId)
    assert.equal(delivered.source.workRef, 'W-7')
    assert.equal(delivered.source.senderName, 'Worker')
    assert.match(delivered.content[0].text, /\[Work #W-7 completed by Worker/)
    assert.match(delivered.content[0].text, /Final verified answer/)

    // Finish parent's turn so fgP returns to idle before testing wait resolution guards.
    rt.notifyTurnLifecycle({ type: 'turn/ended', sessionId: 'sess-parent', turn: 1, reasonKind: 'completed', text: 'Ack' })
    assert.equal(rt.coordDb.getWork(fgP.workId).status, 'idle')

    // 5. Resolving a foreground wait without inboxMessage (or with wake: false) never emits a ghost `(continue work)` turn,
    // and `room_work(originKind='group')` is never raw-dispatched.
    rt.coordDb.addWait({ workId: fgP.workId, kind: 'user_question', targetId: 'question:q1', required: true })
    rt.coordDb.resolveWait({ workId: fgP.workId, kind: 'user_question', targetId: 'question:q1', wake: false })
    assert.equal(rt.coordDb.peekReady({ botId: 'botP' }).length, 0)
    // Even if a foreground wait is resolved with default wake: true and empty inbox, dsh-adapter yields back to idle instead of sending ghost text!
    rt.coordDb.addWait({ workId: fgP.workId, kind: 'user_question', targetId: 'question:q2', required: true })
    rt.coordDb.resolveWait({ workId: fgP.workId, kind: 'user_question', targetId: 'question:q2' })
    const { work: grpWork } = rt.coordDb.createWork({ botId: 'botW', kind: 'room_work', originKind: 'group', roomId: 'room-1', sessionId: 'sess-shared', status: 'queued' })
    await rt.kickScheduler()
    assert.equal(parentAgent.followups.length, 1)
    assert.equal(rt.coordDb.getWork(fgP.workId).status, 'idle')
    assert.equal(rt.coordDb.getWork(grpWork.workId).status, 'waiting')
    ctx.dispose()
  })
})
