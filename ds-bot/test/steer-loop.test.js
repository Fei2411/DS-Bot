import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context, Service, symbols as cordisSymbols } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { install as installSteer } from '../src/host/steer.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

const committedUserTexts = (agent) => agent.session.snapshotEvents()
  .filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
  .map(event => textOf(event.data))

async function createSteerLoopRig(t, {
  holdCallNumbers = new Set(),
  holdPrepareSteps = new Set(),
  holdAbortCalls = new Set(),
  toolOnFirstCall = false,
  onPrompt = undefined,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-loop-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    views: {},
    prefs: {},
    revision: 0,
  }))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  const toolStarted = Promise.withResolvers()
  const toolGate = Promise.withResolvers()
  const callStarted = new Map()
  const callGates = new Map()
  for (const n of holdCallNumbers) {
    callStarted.set(n, Promise.withResolvers())
    callGates.set(n, Promise.withResolvers())
  }
  const prepareStarted = new Map()
  const prepareGates = new Map()
  for (const step of holdPrepareSteps) {
    prepareStarted.set(step, Promise.withResolvers())
    prepareGates.set(step, Promise.withResolvers())
  }
  const abortStarted = new Map()
  const abortGates = new Map()
  for (const n of holdAbortCalls) {
    abortStarted.set(n, Promise.withResolvers())
    abortGates.set(n, Promise.withResolvers())
  }
  const loggerWarnings = []
  const origWarn = root.logger.warn.bind(root.logger)
  root.logger.warn = (...args) => {
    loggerWarnings.push(args.map(String).join(' '))
    return origWarn(...args)
  }

  root.tools.register({
    name: 'slow_step',
    description: 'Pause tool execution so a steer arrives before step 2',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      toolStarted.resolve()
      await new Promise((resolve) => {
        if (exec?.signal?.aborted) { resolve(); return }
        const onAbort = () => resolve()
        exec?.signal?.addEventListener('abort', onAbort, { once: true })
        toolGate.promise.then(() => {
          exec?.signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      return { ok: true }
    },
  })

  if (holdPrepareSteps.size > 0) {
    let prepareCount = 0
    root.on('agent/request', async (req, next) => {
      const idx = ++prepareCount
      if (holdPrepareSteps.has(idx)) {
        prepareStarted.get(idx).resolve()
        await new Promise((resolve) => {
          if (req?.signal?.aborted) { resolve(); return }
          const onAbort = () => resolve()
          req?.signal?.addEventListener('abort', onAbort, { once: true })
          prepareGates.get(idx).promise.then(() => {
            req?.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      }
      return next()
    })
  }

  let callNo = 0
  const seenPrompts = []
  const completedReplies = []

  class SteerTestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(options) {
      const current = ++callNo
      const users = options.messages
        .filter(message => message.role === 'user' && message.source?.kind === 'user')
        .map(textOf)
      seenPrompts.push({ callNo: current, users })

      if (holdCallNumbers.has(current)) {
        callStarted.get(current).resolve()
        await new Promise((resolve) => {
          if (options.signal?.aborted) { resolve(); return }
          const onAbort = () => resolve()
          options.signal?.addEventListener('abort', onAbort, { once: true })
          callGates.get(current).promise.then(() => {
            options.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
        if (options.signal?.aborted) {
          if (holdAbortCalls.has(current)) {
            abortStarted.get(current).resolve()
            await abortGates.get(current).promise
          }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
      } else {
        // Yield once so any microtask STEER_CUT queued on `live.start()` can abort
        // before the reply finishes, matching real async LLM network calls.
        await realDelay(15)
        if (options.signal?.aborted) {
          if (holdAbortCalls.has(current)) {
            abortStarted.get(current).resolve()
            await abortGates.get(current).promise
          }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
      }

      if (toolOnFirstCall && current === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'slow_step', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'slow_step', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      const reply = `Reply #${current}: ${users.join(' | ')}`
      completedReplies.push(reply)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  root.llm.registerAdapter(['steer-test'], new SteerTestAdapter())
  await mountAgentLoopTestHarness(root)
  const agent = await root.agentLoop.create(SessionId('dm-a'), { provider: 'steer-test', model: 'test', cwd: workDir })

  // Minimal real-contract sessionController exposing prompt() and updateQueue()
  // with the exact same agent.steer() / agent.followup() semantics as DSH.
  const sessionController = {
    resolveAgent: async () => ({ agent }),
    create: async () => ({ sessionId: 'dm-a' }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
    async prompt(request) {
      if (typeof onPrompt === 'function') await onPrompt(request)
      const message = createUserMessage({
        content: request.content,
        source: { kind: 'user', ...(request.requestId ? { rpcId: request.requestId } : {}) },
      })
      if (request.mode === 'steer') agent.steer(message)
      else agent.followup(message)
      return { accepted: true }
    },
    async updateQueue(request) {
      const located = agent.inbox.nextTurn.find(item => item.id === request.itemId)
      if (located === undefined) throw Object.assign(new Error('not found'), { code: 'session/queue-item-not-found' })
      if (request.action.kind === 'steer') {
        if (agent.status !== 'running') throw Object.assign(new Error('not running'), { code: 'session/steer-unavailable' })
        agent.inbox.remove(request.itemId)
        agent.steer(located)
      }
      return { accepted: true }
    },
  }

  const ctx = fakeContext({
    services: {
      agents: root.agents,
      llm: root.llm,
      sessions: root.sessions,
      tools: root.tools,
      workspaceRegistry: {
        get: () => ({ id: 'w1', path: workDir }),
        list: () => [{ id: 'w1', path: workDir }],
        resolveByPath: async () => undefined,
        create: async path => ({ id: 'w1', path }),
        archiveSession: async () => {},
      },
      sessionController,
      sessionTitle: { rename: async () => {} },
    },
  })
  Object.assign(ctx, {
    agents: root.agents,
    llm: root.llm,
    sessions: root.sessions,
    tools: root.tools,
    sessionController,
  })

  root.on('session/event', (session, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  root.on('agent/inbox/inserted', (payload) => {
    for (const listener of ctx.listeners.get('agent/inbox/inserted') ?? []) {
      listener(payload)
    }
  })
  root.on('agent/assistant-stream', (payload) => {
    for (const listener of ctx.listeners.get('agent/assistant-stream') ?? []) {
      listener(payload)
    }
  })
  root.on('agent/pre-step', (req, next) => {
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](req, () => run(index + 1)) : next())
    return run(0)
  })

  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    try { agent.cancel({ kind: 'disposed' }) } catch {}
    toolGate.resolve()
    for (const gate of callGates.values()) gate.resolve()
    for (const gate of prepareGates.values()) gate.resolve()
    for (const gate of abortGates.values()) gate.resolve()
    await root.fiber.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  return { root, ctx, rt, agent, sessionController, seenPrompts, completedReplies, loggerWarnings, callStarted, callGates, prepareStarted, prepareGates, abortStarted, abortGates, toolStarted, toolGate }
}

test('real DSH ReactLoopAgent: rapid followup + steer during preStep never swallows the first message', async (t) => {
  const rig = await createSteerLoopRig(t)
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'CMD_1' }], source: { kind: 'user' } }))
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'CMD_2' }], source: { kind: 'user' } }))
  await rig.agent.whenIdle()

  assert.deepEqual(committedUserTexts(rig.agent), ['CMD_1', 'CMD_2'])
  assert.deepEqual(rig.seenPrompts.at(-1)?.users, ['CMD_1', 'CMD_2'])
})

test('real DSH ReactLoopAgent: burst of three rapid commands keeps all messages in FIFO order', async (t) => {
  const rig = await createSteerLoopRig(t)
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r1', mode: 'queue', content: [{ type: 'text', text: 'CMD_1' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r2', mode: 'steer', content: [{ type: 'text', text: 'CMD_2' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r3', mode: 'steer', content: [{ type: 'text', text: 'CMD_3' }] })
  await rig.agent.whenIdle()

  assert.deepEqual(committedUserTexts(rig.agent), ['CMD_1', 'CMD_2', 'CMD_3'])
  assert.deepEqual(rig.seenPrompts.at(-1)?.users, ['CMD_1', 'CMD_2', 'CMD_3'])
})

test('real DSH ReactLoopAgent: steer arriving during slow prepareRequest never swallows claimed message', async (t) => {
  const rig = await createSteerLoopRig(t, { holdPrepareSteps: new Set([1]) })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'FIRST_CMD' }], source: { kind: 'user' } }))
  await rig.prepareStarted.get(1).promise
  // Steer arrives deterministically while step 1 is inside prepareRequest (after step/start, before user/message).
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'SECOND_CMD' }], source: { kind: 'user' } }))
  await Promise.resolve()
  await Promise.resolve()
  rig.prepareGates.get(1).resolve()
  await rig.agent.whenIdle()

  assert.deepEqual(committedUserTexts(rig.agent), ['FIRST_CMD', 'SECOND_CMD'])
  assert.deepEqual(rig.seenPrompts.at(-1)?.users, ['FIRST_CMD', 'SECOND_CMD'])
})

test('real DSH ReactLoopAgent: multi-step tool turn preserves both step-2 claimed steer and follow-up steer during step-2 prepareRequest', async (t) => {
  const rig = await createSteerLoopRig(t, { holdPrepareSteps: new Set([2]), toolOnFirstCall: true })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'START' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  // First steer lands during tool execution and will be claimed by Step 2's preStep.
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'STEER_DURING_TOOL' }], source: { kind: 'user' } }))
  rig.toolGate.resolve()
  // Second steer lands deterministically while Step 2 is inside prepareRequest (before STEER_DURING_TOOL commits).
  await rig.prepareStarted.get(2).promise
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'STEER_DURING_STEP2_PREPARE' }], source: { kind: 'user' } }))
  await Promise.resolve()
  await Promise.resolve()
  rig.prepareGates.get(2).resolve()
  await rig.agent.whenIdle()

  assert.deepEqual(committedUserTexts(rig.agent), ['START', 'STEER_DURING_TOOL', 'STEER_DURING_STEP2_PREPARE'])
  assert.deepEqual(rig.seenPrompts.at(-1)?.users, ['START', 'STEER_DURING_TOOL', 'STEER_DURING_STEP2_PREPARE'])
})

test('real DSH ReactLoopAgent: atomic bot-steer-queue promotes multiple queued user messages in one turn without cascade cuts or losing non-user items', async (t) => {
  const rig = await createSteerLoopRig(t, { holdCallNumbers: new Set([1]) })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  const q1 = createUserMessage({ content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } })
  const botMsg = createUserMessage({ content: [{ type: 'text', text: '[Message from Writer]\npeer note' }], source: { kind: SOURCE_KIND, role: 'note' } })
  const q2 = createUserMessage({ content: [{ type: 'text', text: 'Q2' }], source: { kind: 'user' } })
  const q3 = createUserMessage({ content: [{ type: 'text', text: 'Q3' }], source: { kind: 'user' } })
  rig.agent.followup(q1)
  rig.agent.followup(botMsg)
  rig.agent.followup(q2)
  rig.agent.followup(q3)

  const res = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: [q1.id, q2.id, q3.id] })
  assert.deepEqual(res, { ok: true, value: { steered: 3 } })

  await rig.agent.whenIdle()

  // All 3 queued user messages were claimed together in Turn 2 (call #2) in exact FIFO order,
  // with zero cascade cuts and non-user botMsg staying separate in Turn 3.
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'Q1', 'Q2', 'Q3'])
  const secondCall = rig.seenPrompts.find(entry => entry.callNo === 2)
  assert.deepEqual(secondCall?.users, ['BASE', 'Q1', 'Q2', 'Q3'])
  const botCommitted = rig.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.id === botMsg.id)
  assert.equal(botCommitted, true, 'non-user queued message must still be delivered in its own turn')
})

test('real DSH ReactLoopAgent: rapid steers arriving during STEER_CUT abort window fold in FIFO order ahead of unsteered queued rows without re-entrancy recursion', async (t) => {
  const rig = await createSteerLoopRig(t, { holdCallNumbers: new Set([1]), holdAbortCalls: new Set([1]) })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  // Unsteered queued message waiting for a later turn.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'q0', mode: 'queue', content: [{ type: 'text', text: 'QUEUED_LATER' }] })

  // First steer triggers STEER_CUT; deterministically pause Turn 1 unwind at abort gate.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's1', mode: 'steer', content: [{ type: 'text', text: 'STEER_1' }] })
  await rig.abortStarted.get(1).promise

  const splicesBefore = rig.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').length
  // Second and third steers arrive while Turn 1 is still aborting (`wakingAfterAbort`),
  // plus a plain queued prompt that must stay behind them.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's2', mode: 'steer', content: [{ type: 'text', text: 'STEER_2' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'q1', mode: 'queue', content: [{ type: 'text', text: 'QUEUED_AFTER' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's3', mode: 'steer', content: [{ type: 'text', text: 'STEER_3' }] })
  const splicesAdded = rig.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').length - splicesBefore

  rig.abortGates.get(1).resolve()
  await rig.agent.whenIdle()

  // Folding S2 + Q1 + S3 must emit only O(1) inbox splices and zero listener errors.
  assert.ok(splicesAdded <= 15, `expected bounded inbox splices during STEER_CUT folding, got ${splicesAdded}`)
  assert.deepEqual(rig.loggerWarnings.filter(msg => msg.includes('agent/inbox/inserted')), [])

  // Turn 2 must claim [STEER_1, STEER_2, STEER_3] together ahead of QUEUED_LATER and QUEUED_AFTER.
  const secondCall = rig.seenPrompts.find(entry => entry.callNo === 2)
  assert.deepEqual(secondCall?.users, ['BASE', 'STEER_1', 'STEER_2', 'STEER_3'])
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'STEER_1', 'STEER_2', 'STEER_3', 'QUEUED_LATER', 'QUEUED_AFTER'])
})

test('real DSH ReactLoopAgent: updateQueue steer (including re-steering active cut anchor) and bot-steer-queue during STEER_CUT abort window keep FIFO order', async (t) => {
  const rig = await createSteerLoopRig(t, { holdCallNumbers: new Set([1]), holdAbortCalls: new Set([1]) })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  const qKeep = createUserMessage({ content: [{ type: 'text', text: 'KEEP_QUEUED' }], source: { kind: 'user' } })
  const q1 = createUserMessage({ content: [{ type: 'text', text: 'PROMOTE_1' }], source: { kind: 'user' } })
  const q2 = createUserMessage({ content: [{ type: 'text', text: 'PROMOTE_2' }], source: { kind: 'user' } })
  rig.agent.followup(qKeep)
  rig.agent.followup(q1)
  rig.agent.followup(q2)

  // First steer triggers STEER_CUT; deterministically pause Turn 1 unwind at abort gate.
  const anchor = createUserMessage({ content: [{ type: 'text', text: 'ANCHOR' }], source: { kind: 'user' } })
  rig.agent.steer(anchor)
  await rig.abortStarted.get(1).promise

  // Re-steering the active cut anchor itself via updateQueue must keep it pinned at nextTurn[0],
  // never demoting it behind unsteered qKeep.
  await rig.sessionController.updateQueue({ sessionId: 'dm-a', itemId: anchor.id, action: { kind: 'steer' } })
  assert.equal(rig.agent.inbox.nextTurn[0]?.id, anchor.id)

  // Simulate QueueDock deleting the anchor while STEER_CUT is still unwinding,
  // then steering q1 via updateQueue and q2 via bot-steer-queue.
  assert.equal(rig.agent.inbox.remove(anchor.id), true)
  await rig.sessionController.updateQueue({ sessionId: 'dm-a', itemId: q1.id, action: { kind: 'steer' } })
  const batchRes = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: [q2.id] })
  assert.deepEqual(batchRes, { ok: true, value: { steered: 1 } })

  rig.abortGates.get(1).resolve()
  await rig.agent.whenIdle()

  assert.deepEqual(rig.loggerWarnings.filter(msg => msg.includes('agent/inbox/inserted')), [])
  const secondCall = rig.seenPrompts.find(entry => entry.callNo === 2)
  assert.deepEqual(secondCall?.users, ['BASE', 'PROMOTE_1', 'PROMOTE_2'])
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'PROMOTE_1', 'PROMOTE_2', 'KEEP_QUEUED'])
})

test('real DSH ReactLoopAgent: bot-steer-queue with empty ids does not steer queued rows and hidden peer work signals fallback', async (t) => {
  const rig = await createSteerLoopRig(t, { holdCallNumbers: new Set([1]) })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  const q1 = createUserMessage({ content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } })
  rig.agent.followup(q1)

  // Explicit empty ids must NOT escalate to steering all queued rows.
  const emptyRes = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: [] })
  assert.deepEqual(emptyRes, { ok: true, value: { steered: 0 } })
  assert.equal(rig.agent.inbox.nextTurn.length, 1)
  assert.equal(rig.agent.inbox.nextStep.length, 0)

  // Hidden peer-Bot work requiring foreground isolation returns fallback: true so
  // the client invokes per-row steering and triggers foreground handoff.
  const origIsolate = rig.rt.mustIsolateHiddenWork
  rig.rt.mustIsolateHiddenWork = () => true
  try {
    const hiddenRes = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: [q1.id] })
    assert.deepEqual(hiddenRes, { ok: true, value: { steered: 0, fallback: true } })
    assert.equal(rig.agent.inbox.nextTurn.length, 1)
  } finally {
    rig.rt.mustIsolateHiddenWork = origIsolate
  }

  // Local CLI Bot sessions still promote queued rows via bot-steer-queue to next-step
  // without triggering a host STEER_CUT.
  const origLocalCli = rig.rt.isLocalCliSession
  rig.rt.isLocalCliSession = () => true
  try {
    const cliRes = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: [q1.id] })
    assert.deepEqual(cliRes, { ok: true, value: { steered: 1 } })
    assert.equal(rig.agent.inbox.nextTurn.length, 0)
    assert.deepEqual(rig.agent.inbox.nextStep.map(m => m.id), [q1.id])
    await Promise.resolve()
    await Promise.resolve()
    // Call #1 must still be held (not aborted by STEER_CUT).
    assert.equal(rig.agent.inbox.nextStep.map(m => m.id)[0], q1.id)
  } finally {
    rig.rt.isLocalCliSession = origLocalCli
  }

  rig.callGates.get(1).resolve()
  await rig.agent.whenIdle()
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'Q1'])
})

test('real DSH ReactLoopAgent: bot-steer-queue rejects a retired foreground part and concurrent same-requestId steers stay tracked', async (t) => {
  const secondEntered = Promise.withResolvers()
  const secondRelease = Promise.withResolvers()
  let dupCalls = 0
  const rig = await createSteerLoopRig(t, {
    holdCallNumbers: new Set([1]),
    holdAbortCalls: new Set([1]),
    onPrompt: async (request) => {
      if (request.requestId === 'dup-req') {
        dupCalls += 1
        if (dupCalls === 2) {
          secondEntered.resolve()
          await secondRelease.promise
        }
      }
    },
  })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  // Simulate a switched-away foreground part still present in chatOwners.
  const origChatOf = rig.rt.chatOf
  rig.rt.chatOf = () => 'dm-a-part-2'
  try {
    const staleRes = await rig.rt.channelCall('bot-steer-queue', { sessionId: 'dm-a', ids: ['any'] })
    assert.equal(staleRes.ok, false)
    assert.equal(staleRes.error?.code, 'bot/not-found')
    assert.deepEqual(rig.rt.steerQueued('dm-a'), { steered: 0 })
  } finally {
    rig.rt.chatOf = origChatOf
  }

  // Concurrent same-requestId steer RPCs: the first finishing must not clear tracking
  // while the second is still in flight before inserting into the STEER_CUT abort window.
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'KEEP_QUEUED' }], source: { kind: 'user' } }))
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's-cut', mode: 'steer', content: [{ type: 'text', text: 'STEER_1' }] })
  await rig.abortStarted.get(1).promise

  // While a foreground handoff is active, steer.js must NOT fold/mutate the retiring inbox.
  const origHandingOff = rig.rt.isHandingOff
  rig.rt.isHandingOff = () => true
  try {
    await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'handoff-steer', mode: 'steer', content: [{ type: 'text', text: 'HANDOFF_MSG' }] })
    // Must remain at tail of nextTurn (not folded ahead of KEEP_QUEUED).
    assert.equal(rig.agent.inbox.nextTurn.at(-1)?.content?.[0]?.text, 'HANDOFF_MSG')
    assert.equal(rig.agent.inbox.nextStep.length, 0)
    // Remove synthetic handoff message before testing concurrent same-requestId folding.
    assert.equal(rig.agent.inbox.remove(rig.agent.inbox.nextTurn.at(-1).id), true)
  } finally {
    rig.rt.isHandingOff = origHandingOff
  }

  const p1 = rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'dup-req', mode: 'steer', content: [{ type: 'text', text: 'STEER_DUP_1' }] })
  const p2 = rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'dup-req', mode: 'steer', content: [{ type: 'text', text: 'STEER_DUP_2' }] })
  await secondEntered.promise
  await p1
  secondRelease.resolve()
  await p2
  rig.abortGates.get(1).resolve()
  await rig.agent.whenIdle()

  assert.deepEqual(rig.loggerWarnings.filter(msg => msg.includes('agent/inbox/inserted')), [])
  const secondCall = rig.seenPrompts.find(entry => entry.callNo === 2)
  assert.deepEqual(secondCall?.users, ['BASE', 'STEER_1', 'STEER_DUP_1', 'STEER_DUP_2'])
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'STEER_1', 'STEER_DUP_1', 'STEER_DUP_2', 'KEEP_QUEUED'])
})

test('real Cordis Service proxy: steer wrappers intercept through proxy and restore cleanly on plugin reload without leaking', async (t) => {
  class RealSessionController extends Service {
    constructor(ctx) {
      super(ctx, 'sessionController')
      this.calls = []
    }
    async prompt(request) {
      this.calls.push(['prompt', request.requestId])
      return { accepted: true }
    }
    async updateQueue(request) {
      this.calls.push(['updateQueue', request.itemId])
      return { accepted: true }
    }
  }

  const root = new Context()
  await root.plugin(RealSessionController)
  t.after(() => root.fiber.dispose())

  const rawTarget = root.sessionController[cordisSymbols.original]
  assert.ok(rawTarget instanceof RealSessionController)
  assert.notEqual(root.sessionController.prompt, root.sessionController.prompt, 'Cordis traceable proxy returns fresh shadow functions per read')
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)

  const makeRt = (ctx) => ({
    ctx,
    state: { prefs: {} },
    chatOwners: new Map([['dm-a', 'a']]),
    groupOwners: new Map(),
    taskOwners: new Map(),
    live: new Map(),
    isBotSession: id => id === 'dm-a',
  })

  // First plugin mount wraps on the unwrapped Cordis target.
  const fiber1 = root.plugin({
    name: 'steer-reload-1',
    inject: ['sessionController'],
    apply(ctx) { installSteer(makeRt(ctx)) },
  })
  await fiber1
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), true)
  assert.equal(Object.hasOwn(rawTarget, 'updateQueue'), true)
  await root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r1', mode: 'steer', content: [] })
  await root.sessionController.updateQueue({ sessionId: 'dm-a', itemId: 'm1', action: { kind: 'steer' } })

  // Disposing the plugin must cleanly delete own wrappers and expose prototype methods again.
  await fiber1.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false, 'prompt wrapper must be removed on plugin unload')
  assert.equal(Object.hasOwn(rawTarget, 'updateQueue'), false, 'updateQueue wrapper must be removed on plugin unload')
  assert.equal(rawTarget.prompt, RealSessionController.prototype.prompt)
  assert.equal(rawTarget.updateQueue, RealSessionController.prototype.updateQueue)

  // Reinstalling a second time must not stack or leak the first instance.
  const fiber2 = root.plugin({
    name: 'steer-reload-2',
    inject: ['sessionController'],
    apply(ctx) { installSteer(makeRt(ctx)) },
  })
  await fiber2
  await root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r2', mode: 'steer', content: [] })
  await fiber2.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)
  assert.deepEqual(rawTarget.calls, [['prompt', 'r1'], ['updateQueue', 'm1'], ['prompt', 'r2']])
})
