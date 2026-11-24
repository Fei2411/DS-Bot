import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

const committedUserTexts = (agent) => agent.session.snapshotEvents()
  .filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
  .map(event => textOf(event.data))

async function createSteerLoopRig(t, {
  holdCallNumbers = new Set(),
  abortExitDelayMs = 0,
  prepareDelayMs = 0,
  toolOnFirstCall = false,
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

  if (prepareDelayMs > 0) {
    root.on('agent/request', async (_req, next) => {
      await realDelay(prepareDelayMs)
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
          if (abortExitDelayMs > 0) await realDelay(abortExitDelayMs)
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
      } else {
        // Yield once so any microtask STEER_CUT queued on `live.start()` can abort
        // before the reply finishes, matching real async LLM network calls.
        await realDelay(15)
        if (options.signal?.aborted) {
          if (abortExitDelayMs > 0) await realDelay(abortExitDelayMs)
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
    await root.fiber.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  return { root, ctx, rt, agent, sessionController, seenPrompts, completedReplies, callStarted, callGates, toolStarted, toolGate }
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
  const rig = await createSteerLoopRig(t, { prepareDelayMs: 40 })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'FIRST_CMD' }], source: { kind: 'user' } }))
  // Wait until step/start has fired and prepareRequest is awaiting agent/request.
  await realDelay(15)
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'SECOND_CMD' }], source: { kind: 'user' } }))
  await rig.agent.whenIdle()

  assert.deepEqual(committedUserTexts(rig.agent), ['FIRST_CMD', 'SECOND_CMD'])
  assert.deepEqual(rig.seenPrompts.at(-1)?.users, ['FIRST_CMD', 'SECOND_CMD'])
})

test('real DSH ReactLoopAgent: multi-step tool turn preserves both step-2 claimed steer and follow-up steer during step-2 prepareRequest', async (t) => {
  const rig = await createSteerLoopRig(t, { prepareDelayMs: 30, toolOnFirstCall: true })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'START' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  // First steer lands during tool execution and will be claimed by Step 2's preStep.
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'STEER_DURING_TOOL' }], source: { kind: 'user' } }))
  rig.toolGate.resolve()
  // Second steer lands while Step 2 is in prepareRequest (before STEER_DURING_TOOL commits).
  await realDelay(10)
  rig.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'STEER_DURING_STEP2_PREPARE' }], source: { kind: 'user' } }))
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

test('real DSH ReactLoopAgent: rapid steers arriving during STEER_CUT abort window fold in FIFO order ahead of unsteered queued rows, while plain queue stays behind', async (t) => {
  const rig = await createSteerLoopRig(t, { holdCallNumbers: new Set([1]), abortExitDelayMs: 40 })
  rig.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'BASE' }], source: { kind: 'user' } }))
  await rig.callStarted.get(1).promise

  // Unsteered queued message waiting for a later turn.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'q0', mode: 'queue', content: [{ type: 'text', text: 'QUEUED_LATER' }] })

  // First steer triggers STEER_CUT; Turn 1 takes 40ms to finish unwinding.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's1', mode: 'steer', content: [{ type: 'text', text: 'STEER_1' }] })
  // Yield one microtask so maybeCut() fires and enters track.cutting = true.
  await Promise.resolve()
  await Promise.resolve()

  // Second and third steers arrive while Turn 1 is still aborting (`wakingAfterAbort`),
  // plus a plain queued prompt that must stay behind them.
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's2', mode: 'steer', content: [{ type: 'text', text: 'STEER_2' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 'q1', mode: 'queue', content: [{ type: 'text', text: 'QUEUED_AFTER' }] })
  await rig.sessionController.prompt({ sessionId: 'dm-a', requestId: 's3', mode: 'steer', content: [{ type: 'text', text: 'STEER_3' }] })

  await rig.agent.whenIdle()

  // Turn 2 must claim [STEER_1, STEER_2, STEER_3] together ahead of QUEUED_LATER and QUEUED_AFTER.
  const secondCall = rig.seenPrompts.find(entry => entry.callNo === 2)
  assert.deepEqual(secondCall?.users, ['BASE', 'STEER_1', 'STEER_2', 'STEER_3'])
  assert.deepEqual(committedUserTexts(rig.agent), ['BASE', 'STEER_1', 'STEER_2', 'STEER_3', 'QUEUED_LATER', 'QUEUED_AFTER'])
})
