import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const settle = async (check, ms = 4000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), label)
}

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

async function createRealLoopRig(t, { prefs = {}, failForkAndCreate = false, holdFirstModel = false, holdFork = false, delayResolveMs = 0, enableFlushPersistence = true, durable = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-fg-loop-'))
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
    prefs,
    revision: 0,
  }))

  const root = new Context()
  const rootWarnings = []
  const origWarn = root.logger.warn.bind(root.logger)
  root.logger.warn = (...args) => {
    rootWarnings.push(args.map(String).join(' '))
    return origWarn(...args)
  }
  await mountAgentLoopTestDependencies(root)
  const sessionDir = join(home, 'sessions')
  if (durable) await root.plugin(SessionPersistence, { root: sessionDir })

  const toolStarted = Promise.withResolvers()
  const toolGate = Promise.withResolvers()
  const firstModelStarted = Promise.withResolvers()
  const firstModelGate = Promise.withResolvers()
  const forkStarted = Promise.withResolvers()
  const forkGate = Promise.withResolvers()
  let callSeq = 0
  let modelCalls = 0
  const repliesBySession = new Map()
  const modelCallsBySession = new Map()

  root.tools.register({
    name: 'slow_check',
    description: 'Pause mid-turn so a Desktop user message arrives while busy',
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
      return { ok: true, detail: 'background check done' }
    },
  })

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(options) {
      modelCalls += 1
      modelCallsBySession.set(options.sessionId, (modelCallsBySession.get(options.sessionId) ?? 0) + 1)
      const callNo = modelCalls
      const last = options.messages.at(-1)
      const lastUser = options.messages.findLast(m => m.role === 'user' && (m.source?.kind === 'user' || m.source?.role === 'task-report'))
      const lastText = textOf(lastUser ?? last)

      if (holdFirstModel && options.sessionId === 'dm-a' && callNo === 1) {
        firstModelStarted.resolve()
        await new Promise((resolve) => {
          if (options.signal?.aborted) { resolve(); return }
          const onAbort = () => resolve()
          options.signal?.addEventListener('abort', onAbort, { once: true })
          firstModelGate.promise.then(() => {
            options.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
      }

      if (options.sessionId === 'dm-a' && !options.messages.some(m => m.role === 'tool') && lastText.includes('run slow work')) {
        const id = `call_${++callSeq}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'slow_check', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'slow_check', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      const reply = options.sessionId === 'dm-a' && options.messages.some(m => m.role === 'tool')
        ? 'Background slow work finished.'
        : `Answered on ${options.sessionId}: ${lastText}`
      const list = repliesBySession.get(options.sessionId) ?? []
      list.push(reply)
      repliesBySession.set(options.sessionId, list)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fg-test'], new TestAdapter())
  const harness = await mountAgentLoopTestHarness(root)
  let offFlush = enableFlushPersistence ? root.on('session/flush', async () => {}) : undefined

  const agents = new Map()
  const makeRealAgent = async (sid) => {
    const agent = await root.agentLoop.create(SessionId(sid), { provider: 'fg-test', model: 'test', cwd: workDir })
    agents.set(sid, agent)
    return agent
  }
  await makeRealAgent('dm-a')

  let forkSeq = 0
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
      sessionController: {
        resolveAgent: async (sessionId) => {
          if (delayResolveMs > 0) await realDelay(delayResolveMs)
          return { agent: agents.get(sessionId) ?? root.agents.get(sessionId) }
        },
        create: async () => {
          if (failForkAndCreate) throw new Error('simulated create failure')
          const sid = `new-${++forkSeq}`
          await makeRealAgent(sid)
          return { sessionId: sid }
        },
        fork: async () => {
          if (holdFork) {
            forkStarted.resolve()
            await forkGate.promise
          }
          if (failForkAndCreate) throw new Error('simulated fork failure')
          const sid = `fork-${++forkSeq}`
          await makeRealAgent(sid)
          return { sessionId: sid }
        },
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async sessionId => ({ events: (agents.get(sessionId) ?? root.agents.get(sessionId))?.session.snapshotEvents() ?? [] }),
      },
      sessionTitle: { rename: async () => {} },
    },
  })
  Object.assign(ctx, {
    agents: root.agents,
    llm: root.llm,
    sessions: root.sessions,
    tools: root.tools,
    workspaceRegistry: ctx.get('workspaceRegistry'),
    sessionController: ctx.get('sessionController'),
    sessionTitle: ctx.get('sessionTitle'),
  })

  // Forward real DSH session/event, agent/inbox/inserted, and agent/pre-step to the DS Bot runtime.
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
  root.on('agent/pre-step', (req, next) => {
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](req, () => run(index + 1)) : next())
    return run(0)
  })

  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    for (const agent of agents.values()) {
      try { agent.cancel({ kind: 'disposed' }) } catch {}
    }
    toolGate.resolve()
    firstModelGate.resolve()
    forkGate.resolve()
    if (durable) await Promise.all([...agents.values()].map(agent => agent.whenIdle()))
    await root.fiber.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  const setFlushPersistence = (enabled, fn = async () => {}) => {
    offFlush?.()
    offFlush = enabled ? root.on('session/flush', fn) : undefined
  }
  return { home, root, rootWarnings, rt, agents, makeRealAgent, harness, toolStarted, toolGate, firstModelStarted, firstModelGate, forkStarted, forkGate, repliesBySession, modelCallsBySession, setFlushPersistence }
}

test('real DSH SessionStore + ReactLoopAgent: Desktop steer and queue while busy stay on the same session without auto fg-handoff (#2077)', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 0 } })
  const dmA = rig.agents.get('dm-a')

  // Start a busy foreground turn that invokes a slow tool.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  assert.equal(rig.rt.shouldMoveForeground(rig.rt.botOf('a'), 'dm-a'), false, 'ordinary busy user turn must NOT auto-move foreground')
  assert.equal(rig.rt.canMoveForeground(rig.rt.botOf('a'), 'dm-a'), true, 'explicit move-to-background must be available while running with empty inbox')

  // Desktop/Web composer sends a steer while the slow tool is running -> stays on dm-a!
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Use option B instead' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'steer must NOT fork or switch foreground')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0, 'steer must NOT create a background task')
  assert.equal(dmA.inbox.nextStep.length, 1, 'steer remains in dm-a nextStep for the earliest safe boundary')
  assert.equal(rig.rt.canMoveForeground(rig.rt.botOf('a'), 'dm-a'), false, 'explicit move is disabled while user inbox has pending messages')

  // Queue another follow-up -> also stays on dm-a.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Tell me when finished' }], source: { kind: 'user' } }))
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)

  // Release slow tool -> dm-a consumes the steer and queued follow-up on the same session.
  rig.toolGate.resolve()
  await settle(() => (rig.repliesBySession.get('dm-a') ?? []).length >= 2, 5000, 'dm-a must finish slow work and answer queued follow-up')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
})

test('real DSH SessionStore + ReactLoopAgent: explicit moveForegroundToBackground hands off busy turn intact and reports back', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  assert.equal(rig.rt.canMoveForeground(rig.rt.botOf('a'), 'dm-a'), true)

  const turn = rig.rt.live.get('dm-a')?.turn
  const moved = await rig.rt.moveForegroundToBackground({
    botId: 'a',
    expectedSessionId: 'dm-a',
    expectedTurn: turn,
    operationId: 'op-move-1',
  })
  assert.equal(moved.moved, true)
  assert.notEqual(moved.sessionId, 'dm-a')
  assert.ok(moved.taskId)

  // Replaying the exact operationId is idempotent and does not fork again.
  const replay = await rig.rt.moveForegroundToBackground({
    botId: 'a',
    expectedSessionId: 'dm-a',
    expectedTurn: turn,
    operationId: 'op-move-1',
  })
  assert.deepEqual(replay, moved)
  assert.equal(rig.rt.botOf('a').tasks.length, 1)

  const fgSid = rig.rt.botOf('a').sessionId
  assert.equal(fgSid, moved.sessionId)
  const task = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
  assert.equal(task?.origin, 'fg-handoff')
  assert.equal(task?.status, 'running')

  // User chats freely on the new foreground while dm-a keeps running in background.
  rig.agents.get(fgSid).followup(createUserMessage({ content: [{ type: 'text', text: 'What are you doing?' }], source: { kind: 'user' } }))
  await settle(
    () => (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('What are you doing?')),
    5000,
    'new foreground did not answer user message',
  )

  // Finish the background tool -> task settles and reports back to the new foreground.
  rig.toolGate.resolve()
  await settle(() => {
    const t0 = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
    return t0?.status === 'completed'
      && (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Background slow work finished.'))
  }, 5000, 'background task did not settle and report back to new foreground')
})

test('real DSH SessionStore + ReactLoopAgent: post-handoff polling gap redirects stale steer once without reentrancy or recursive fg-handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 0 } })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const moved = await rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  const fgSid = moved.sessionId
  assert.notEqual(fgSid, 'dm-a')

  // Simulate Desktop tab still pointing at stale dm-a (now in taskOwners) before roster poll updates.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Stale tab message' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  assert.equal(dmA.inbox.nextStep.length, 0, 'stale message must be pulled from background task inbox')

  await settle(
    () => (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Stale tab message')),
    5000,
    'stale tab message was not redirected to new foreground',
  )
  assert.equal(rig.rt.botOf('a').sessionId, fgSid, 'redirecting stale tab input must NOT trigger a second recursive fg-handoff')
  assert.equal(rig.rt.botOf('a').tasks.length, 1)
})

test('real DSH SessionStore + ReactLoopAgent: concurrent messages during an explicit handoff fork drain cleanly onto the single new foreground without self-handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 0 }, holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await rig.forkStarted.promise

  // Two messages arrive while the explicit handoff fork is still in flight.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Rapid one' }], source: { kind: 'user' } }))
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Rapid two' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  assert.equal(dmA.inbox.nextStep.length, 0)

  rig.forkGate.resolve()
  await movePromise

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    const replies = rig.repliesBySession.get(fgSid) ?? []
    return fgSid !== 'dm-a'
      && replies.some(r => r.includes('Rapid one'))
      && replies.some(r => r.includes('Rapid two'))
  }, 5000, 'both rapid messages must be answered on the single new foreground')

  assert.equal(rig.rt.botOf('a').tasks.length, 1, 'forwarding a 2-message batch at backgroundAfterSec=0 must not trigger a second spurious handoff')
})

test('real DSH SessionStore + ReactLoopAgent: failed pre-commit fork during explicit handoff restores concurrent steer without loop or dropping journal on restore failure (#2087)', async (t) => {
  const rig = await createRealLoopRig(t, { failForkAndCreate: true, holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }).catch(err => err)
  await rig.forkStarted.promise
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Keep me on failure' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  rig.forkGate.resolve()
  const err = await movePromise
  assert.ok(err instanceof Error)

  await settle(() => dmA.inbox.nextStep.some(m => textOf(m).includes('Keep me on failure')), 3000, 'pulled message must be restored on pre-commit failure')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'successfully restored input clears journal')
})

test('real DSH SessionStore + ReactLoopAgent: steer after waitMs still cuts running model call immediately (#2077)', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 1 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  // Simulate a turn running well past backgroundAfterSec (1s): steer MUST still cut in-place!
  rig.rt.live.get('dm-a').since = Date.now() - 10_000
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Interrupt right now' }], source: { kind: 'user' } }))

  await settle(
    () => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Interrupt right now')),
    4000,
    'steer past backgroundAfterSec must cut the running model call and be answered immediately',
  )
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'steer must not hand off foreground')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(dmA.inbox.nextStep.length, 0)
})

test('real DSH SessionStore + ReactLoopAgent: threshold tick between spliced and maybeCut microtask cuts cleanly without double delivery or false handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Boundary steer' }], source: { kind: 'user' } }))
  rig.rt.live.get('dm-a').since = Date.now() - 31_000

  await settle(
    () => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Boundary steer')),
    4000,
    'boundary steer must be cut and answered once on dm-a without handoff',
  )
  await realDelay(50)
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'STEER_CUT turn must NOT be handed off to background')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0, 'must not spawn a false background task for a STEER_CUT turn')
  assert.equal(
    (rig.repliesBySession.get('dm-a') ?? []).filter(r => r.includes('Boundary steer')).length,
    1,
    'boundary steer must be answered exactly once (no duplicate delivery)',
  )
  assert.equal(dmA.inbox.nextStep.length, 0)
})

test('real DSH SessionStore + ReactLoopAgent: inbox.replace() queue edit on a busy Bot keeps prompt queued instead of triggering handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  const queued = createUserMessage({ content: [{ type: 'text', text: 'Draft queued prompt' }], source: { kind: 'user' } })
  dmA.followup(queued)
  assert.equal(dmA.inbox.nextTurn.length, 1)

  rig.rt.live.get('dm-a').since = Date.now() - 31_000
  assert.equal(rig.rt.shouldMoveForeground(rig.rt.botOf('a'), 'dm-a'), false)
  const edited = Object.freeze({ ...queued, content: [{ type: 'text', text: 'Edited queued prompt' }] })
  assert.equal(dmA.inbox.replace(queued.id, edited), true)
  await realDelay(50)

  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'editing a queued prompt must not trigger foreground handoff')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(dmA.inbox.nextTurn.length, 1, 'edited prompt must remain queued')
  assert.equal(textOf(dmA.inbox.nextTurn[0]), 'Edited queued prompt')
})

test('real DSH SessionStore + ReactLoopAgent: explicit moveForegroundToBackground discards unused candidate fork if turn finishes naturally mid-fork', async (t) => {
  const rig = await createRealLoopRig(t, { holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-natural-finish' })
  await rig.forkStarted.promise

  // Slow work finishes naturally BEFORE the candidate fork commits.
  rig.toolGate.resolve()
  await settle(() => dmA.status === 'idle' && rig.rt.live.get('dm-a')?.turn === undefined, 4000, 'old turn must finish before releasing fork')
  rig.forkGate.resolve()

  const result = await movePromise
  assert.equal(result.moved, false, 'naturally finished turn must not produce a ghost already-done background task')
  assert.equal(result.sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
})

test('real DSH SessionStore + ReactLoopAgent: durable pendingHandoffInputs replays on restart and deduplicates already-admitted prompts', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  // Seed two persisted pending transfers as if the host crashed mid-handoff:
  // one not yet admitted on dm-a, and one already admitted with the same rpcId.
  const admittedMsg = createUserMessage({ content: [{ type: 'text', text: 'Already admitted before crash' }], source: { kind: 'user', rpcId: 'rpc-admitted-1' } })
  dmA.followup(admittedMsg)
  await settle(() => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Already admitted before crash')), 4000)

  rig.rt.state.pendingHandoffInputs = [
    { id: 'rpc-admitted-1', botId: 'a', content: [{ type: 'text', text: 'Already admitted before crash' }], source: { kind: 'user', rpcId: 'rpc-admitted-1' }, at: Date.now() },
    { id: 'rpc-lost-2', botId: 'a', content: [{ type: 'text', text: 'Recovered after crash' }], source: { kind: 'user', rpcId: 'rpc-lost-2' }, at: Date.now() },
  ]
  await rig.rt.reconcileTasksAfterRestart()

  await settle(() => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Recovered after crash')), 4000, 'persisted transfer must replay on restart')
  assert.equal(
    (rig.repliesBySession.get('dm-a') ?? []).filter(r => r.includes('Already admitted before crash')).length,
    1,
    'already-admitted prompt must not be duplicated on restart replay',
  )
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'cleared pendingHandoffInputs must be removed from state')
})

test('real DSH SessionStore + ReactLoopAgent: polling-gap steer on an idle active taskOwners session rejects empty wake and resists concurrent reconcileTasksAfterRestart', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  const moved = await rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  const fgSid = moved.sessionId

  // Attach an open outgoing work to dm-a so when slow_check ends, dm-a stays an ACTIVE
  // `waiting_work` task (still inside `rt.taskOwners`) while `dmA.status === 'idle'`.
  rig.rt.state.works['w-open-1'] = { id: 'w-open-1', from: 'a', to: 'b', fromPart: 'dm-a', openedAt: Date.now() }
  rig.toolGate.resolve()
  await settle(() => rig.rt.botOf('a').tasks[0]?.status === 'waiting_work' && dmA.status === 'idle', 5000)
  assert.equal(rig.rt.taskOwners.has('dm-a'), true, 'waiting_work task must remain in rt.taskOwners')
  assert.equal(dmA.status, 'idle')
  const callsBefore = rig.modelCallsBySession.get('dm-a') ?? 0

  // Stale Desktop tab sends a prompt to the idle `taskOwners` session while startup
  // `reconcileTasksAfterRestart()` also fires concurrently (must NOT duplicate!).
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Late stale tab prompt' }], source: { kind: 'user' } }))
  const reconcilePromise = rig.rt.reconcileTasksAfterRestart()

  await settle(
    () => (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Late stale tab prompt')),
    4000,
    'late prompt on idle taskOwners session must redirect to foreground',
  )
  await reconcilePromise
  await realDelay(60)

  const lastTurnEnd = dmA.session.snapshotEvents().findLast(ev => ev.type === 'turn/end')
  assert.equal(lastTurnEnd?.data?.reason?.kind, 'blocked', 'phantom empty wake on idle taskOwners session must be rejected via agent/pre-step')
  assert.equal(rig.modelCallsBySession.get('dm-a') ?? 0, callsBefore, 'idle taskOwners session must not invoke LLM on redirected input')
  assert.equal(
    (rig.repliesBySession.get(fgSid) ?? []).filter(r => r.includes('Late stale tab prompt')).length,
    1,
    'concurrent reconcileTasksAfterRestart must not duplicate an in-flight transfer',
  )
})

test('real DSH SessionStore + ReactLoopAgent: startup reconcile waits for an in-flight explicit handoff instead of stranding pre-crash pendingHandoffInputs', async (t) => {
  const rig = await createRealLoopRig(t, { holdFork: true })
  const dmA = rig.agents.get('dm-a')

  // Start a busy turn and trigger an explicit handoff paused in `fork()`.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await rig.forkStarted.promise
  // A user message arrives while the explicit handoff is paused mid-fork.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Check the budget' }], source: { kind: 'user' } }))
  assert.equal(rig.rt.isHandingOff('dm-a'), true, 'live handoff must be in flight when startup reconcile runs')

  // Prepend a pre-crash saved prompt AFTER `forkStarted` (after resume.js's 0ms startup
  // timer has already passed) so the queue holds `[E_old, E_live]` while `handoffing` is active.
  rig.rt.state.pendingHandoffInputs = [
    { id: 'rpc-pre-crash-1', botId: 'a', content: [{ type: 'text', text: 'Summarize the report' }], source: { kind: 'user', rpcId: 'rpc-pre-crash-1' }, at: Date.now() - 10_000 },
    ...(rig.rt.state.pendingHandoffInputs ?? []),
  ]
  assert.equal(rig.rt.state.pendingHandoffInputs.length, 2, 'must have both pre-crash and live pending entries before reconcile')

  let reconciled = false
  const reconcilePromise = rig.rt.reconcileTasksAfterRestart().then(() => { reconciled = true })
  await realDelay(30)
  assert.equal(reconciled, false, 'reconcileTasksAfterRestart must wait for the in-flight handoff to settle')
  assert.equal(
    rig.rt.state.pendingHandoffInputs?.some(item => item?.id === 'rpc-pre-crash-1'),
    true,
    'pre-crash entry must still be pending while handoff is paused',
  )

  rig.forkGate.resolve()
  await Promise.all([movePromise, reconcilePromise])

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    const replies = rig.repliesBySession.get(fgSid) ?? []
    return fgSid !== 'dm-a'
      && replies.some(r => r.includes('Check the budget'))
      && replies.some(r => r.includes('Summarize the report'))
  }, 5000, 'both the live handoff prompt and the pre-crash saved prompt must reach the new foreground')

  const fgSid = rig.rt.botOf('a').sessionId
  const replies = rig.repliesBySession.get(fgSid) ?? []
  assert.equal(replies.filter(r => r.includes('Check the budget')).length, 1, 'live handoff prompt must be answered exactly once')
  assert.equal(replies.filter(r => r.includes('Summarize the report')).length, 1, 'pre-crash prompt must be replayed exactly once')
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'pendingHandoffInputs must be drained and cleared')
})

test('real DSH SessionStore + ReactLoopAgent: concurrent reconcileTasksAfterRestart short-circuits via inFlightTransferIds and cleans malformed/id-less entries', async (t) => {
  const rig = await createRealLoopRig(t, { delayResolveMs: 40 })
  // Let resume.js's 0ms startup reconcile timer settle before spying on replay calls.
  await realDelay(20)
  const ensureSpy = t.mock.method(rig.rt, 'ensureCapabilities')

  rig.rt.state.pendingHandoffInputs = [
    null,
    { id: 'rpc-concurrent-reconcile-1', botId: 'a', content: [{ type: 'text', text: 'Only replay once' }], source: { kind: 'user', rpcId: 'rpc-concurrent-reconcile-1' }, at: Date.now() - 5000 },
    { botId: 'a', content: [{ type: 'text', text: 'Idless crash entry' }], source: { kind: 'user' }, at: Date.now() - 4000 },
  ]

  await Promise.all([
    rig.rt.reconcileTasksAfterRestart(),
    rig.rt.reconcileTasksAfterRestart(),
  ])

  await settle(() => {
    const replies = rig.repliesBySession.get('dm-a') ?? []
    return replies.some(r => r.includes('Only replay once')) && replies.some(r => r.includes('Idless crash entry'))
  }, 4000, 'both valid pre-crash prompts must replay onto dm-a')
  await realDelay(60)

  const replies = rig.repliesBySession.get('dm-a') ?? []
  assert.equal(replies.filter(r => r.includes('Only replay once')).length, 1, 'concurrent reconcile calls must not duplicate a keyed transfer')
  assert.equal(replies.filter(r => r.includes('Idless crash entry')).length, 1, 'concurrent reconcile calls must not duplicate an id-less transfer')
  assert.equal(ensureSpy.mock.callCount(), 2, 'each of the 2 valid entries must enter forwardPulledMessages exactly once (second concurrent reconcile short-circuited via inFlightTransferIds)')
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'malformed and id-less entries must be fully cleared from state')
})

test('real DSH SessionStore + ReactLoopAgent: startup reconcile deduplicates a saved prompt already running in a turn moved to background by a live handoff', async (t) => {
  const rig = await createRealLoopRig(t, { holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({
    content: [{ type: 'text', text: 'Please run slow work for status update' }],
    source: { kind: 'user', rpcId: 'rpc-already-running-1' },
  }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await rig.forkStarted.promise
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'New foreground question' }], source: { kind: 'user' } }))

  rig.rt.state.pendingHandoffInputs = [
    {
      id: 'rpc-already-running-1',
      botId: 'a',
      content: [{ type: 'text', text: 'Please run slow work for status update' }],
      source: { kind: 'user', rpcId: 'rpc-already-running-1' },
      at: Date.now() - 10_000,
    },
    ...(rig.rt.state.pendingHandoffInputs ?? []),
  ]

  const reconcilePromise = rig.rt.reconcileTasksAfterRestart()
  await realDelay(20)
  rig.forkGate.resolve()
  await Promise.all([movePromise, reconcilePromise])

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    return fgSid !== 'dm-a'
      && (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('New foreground question'))
  }, 5000, 'new foreground must answer the new follow-up')
  await realDelay(60)

  const fgSid = rig.rt.botOf('a').sessionId
  const fgReplies = rig.repliesBySession.get(fgSid) ?? []
  assert.equal(
    fgReplies.some(r => r.includes('Please run slow work for status update')),
    false,
    'prompt already running in the moved background session must NOT be replayed onto the new foreground',
  )
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'deduplicated pending entry must be cleared from state')
})

test('real DSH SessionStore + ReactLoopAgent: #2087 restorePulledMessages keeps journal when rollback fails and recovers on reconcile', async (t) => {
  const rig = await createRealLoopRig(t, { failForkAndCreate: true, holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }).catch(err => err)
  await rig.forkStarted.promise

  // Inject a steer while fork is in flight, then simulate rollback rejection on dmA.send().
  const origSend = dmA.send.bind(dmA)
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Never drop me on rollback failure' }], source: { kind: 'user', rpcId: 'rpc-keep-2087' } }))
  dmA.send = () => { throw new Error('simulated rollback rejection') }
  rig.forkGate.resolve()
  await movePromise

  // Journal MUST survive rollback failure (not silently cleared!).
  assert.equal(
    rig.rt.state.pendingHandoffInputs?.some(item => item?.id === 'rpc-keep-2087'),
    true,
    'failed rollback must retain entry in pendingHandoffInputs',
  )
  assert.equal(rig.rt.state.pendingHandoffInputs?.[0]?.originalSessionId, 'dm-a')

  // Restore send() and release tool -> reconcile recovers the preserved message cleanly.
  dmA.send = origSend
  rig.toolGate.resolve()
  await settle(() => dmA.status === 'idle', 4000)
  const repliesBefore = (rig.repliesBySession.get('dm-a') ?? []).length
  await rig.rt.reconcileTasksAfterRestart()
  await settle(
    () => dmA.session.snapshotEvents().some(ev => ev.type === 'user/message' && textOf(ev.data?.message ?? ev.data).includes('Never drop me on rollback failure'))
      && (rig.repliesBySession.get('dm-a') ?? []).length > repliesBefore,
    4000,
    'reconcile must deliver the retained journal entry once session is writable again',
  )
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined)
})

test('real DSH SessionStore + ReactLoopAgent: flush() returning false keeps pendingHandoffInputs and releases retry lock on both forward and rollback', async (t) => {
  // 1) Forward path with NO persistence listener -> real SessionStore.flush() returns false -> journal MUST stay.
  const rig = await createRealLoopRig(t, { holdFork: true, enableFlushPersistence: false })
  const dmA = rig.agents.get('dm-a')
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await rig.forkStarted.promise
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Need flush confirmation' }], source: { kind: 'user', rpcId: 'rpc-no-flush-fwd' } }))
  rig.forkGate.resolve()
  await movePromise

  const fgSid = rig.rt.botOf('a').sessionId
  await settle(() => (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Need flush confirmation')), 4000)
  assert.equal(
    rig.rt.state.pendingHandoffInputs?.some(item => item?.id === 'rpc-no-flush-fwd'),
    true,
    'forwardPulledMessages must NOT clear journal when real SessionStore.flush() returns false',
  )
  // Once a persistence listener is active, reconcile sees the message is already admitted on fgSid, flushes true, and clears journal without duplicating.
  rig.setFlushPersistence(true)
  await rig.rt.reconcileTasksAfterRestart()
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined)
  assert.equal((rig.repliesBySession.get(fgSid) ?? []).filter(r => r.includes('Need flush confirmation')).length, 1)

  // 2) Rollback path with NO persistence listener -> real SessionStore.flush() returns false -> journal MUST stay.
  const rig2 = await createRealLoopRig(t, { failForkAndCreate: true, holdFork: true, enableFlushPersistence: false })
  const dm2 = rig2.agents.get('dm-a')
  dm2.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig2.toolStarted.promise
  const failMove = rig2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }).catch(err => err)
  await rig2.forkStarted.promise
  dm2.steer(createUserMessage({ content: [{ type: 'text', text: 'Rollback needs real flush' }], source: { kind: 'user', rpcId: 'rpc-no-flush-rb' } }))
  rig2.forkGate.resolve()
  await failMove
  assert.equal(
    rig2.rt.state.pendingHandoffInputs?.some(item => item?.id === 'rpc-no-flush-rb'),
    true,
    'restorePulledMessages must NOT clear journal when real SessionStore.flush() returns false',
  )
  rig2.setFlushPersistence(true)
  await rig2.rt.reconcileTasksAfterRestart()
  assert.equal(rig2.rt.state.pendingHandoffInputs, undefined, 'reconcile must clear after verifying admission with real flush')
})

test('real DSH SessionStore + ReactLoopAgent: isAdmittedOn recognizes real user/message data.id without rpcId so reconcile does not replay consumed input', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  const userMsg = createUserMessage({ content: [{ type: 'text', text: 'Consumed without rpcId' }], source: { kind: 'user' } })
  dmA.followup(userMsg)
  await settle(() => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Consumed without rpcId')), 4000)

  // Verify real DSH event layout: ev.data.id === userMsg.id (no ev.data.message wrapper, no rpcId).
  const userEv = dmA.session.snapshotEvents().find(ev => ev.type === 'user/message' && ev.data?.id === userMsg.id)
  assert.ok(userEv !== undefined, 'real DSH user/message event must carry data.id directly')
  assert.equal(userEv.data.message, undefined)
  assert.equal(rig.rt.isAdmittedOn(dmA, userMsg.id), true)

  // Simulate restart recovery entry referencing that consumed message id (no rpcId).
  rig.rt.state.pendingHandoffInputs = [{
    id: userMsg.id,
    messageId: userMsg.id,
    originalSessionId: 'dm-a',
    botId: 'a',
    content: userMsg.content,
    source: { kind: 'user' },
    at: Date.now() - 5000,
  }]
  await rig.rt.reconcileTasksAfterRestart()
  await realDelay(50)
  assert.equal(
    (rig.repliesBySession.get('dm-a') ?? []).filter(r => r.includes('Consumed without rpcId')).length,
    1,
    'already-consumed real DSH user/message without rpcId must NOT be replayed',
  )
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined)
})

test('real DSH SessionStore + ReactLoopAgent: second message arriving while rollback awaits flush is never stranded', async (t) => {
  const rig = await createRealLoopRig(t, { failForkAndCreate: true, holdFork: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  const rollbackFlushStarted = Promise.withResolvers()
  const rollbackFlushGate = Promise.withResolvers()
  let pauseNextFlush = false
  rig.setFlushPersistence(true, async () => {
    if (pauseNextFlush) {
      pauseNextFlush = false
      rollbackFlushStarted.resolve()
      await rollbackFlushGate.promise
    }
  })

  const movePromise = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }).catch(err => err)
  await rig.forkStarted.promise
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'First during fork' }], source: { kind: 'user', rpcId: 'rpc-rb-1' } }))

  pauseNextFlush = true
  rig.forkGate.resolve()
  await rollbackFlushStarted.promise

  // Second message arrives while rollback of first message is awaiting flush().
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Second during rollback flush' }], source: { kind: 'user', rpcId: 'rpc-rb-2' } }))
  rollbackFlushGate.resolve()
  await movePromise

  rig.toolGate.resolve()
  await settle(() => {
    const userTexts = dmA.session.snapshotEvents()
      .filter(ev => ev.type === 'user/message')
      .map(ev => textOf(ev.data))
    return dmA.status === 'idle'
      && userTexts.some(msg => msg.includes('First during fork'))
      && userTexts.some(msg => msg.includes('Second during rollback flush'))
  }, 5000, 'both messages must be consumed on dm-a without stranding the second message')
  assert.equal(rig.rt.state.pendingHandoffInputs, undefined, 'no journal entry may be left stranded after rollback')
})

const journal = rig => JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).pendingHandoffInputs ?? []
const beginMove = rig => rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }).catch(err => err)
const userPrompt = (text, rpcId) => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) },
})

for (const flushFailure of ['false', 'throw']) {
  test(`a ${flushFailure} durability checkpoint keeps accepted input in the handoff journal`, async (t) => {
    const rig = await createRealLoopRig(t, { durable: true, failForkAndCreate: true, holdFork: true })
    const old = rig.agents.get('dm-a')
    old.followup(userPrompt('Please run slow work'))
    await rig.toolStarted.promise
    const prompt = userPrompt('Keep this until the storage confirms it')
    const moved = beginMove(rig)
    await rig.forkStarted.promise
    old.steer(prompt)
    await settle(() => journal(rig).some(item => item.messageId === prompt.id))
    const sessions = rig.rt.ctx.sessions
    rig.rt.ctx.sessions = { flush: async () => {
      if (flushFailure === 'throw') throw new Error('Fixture storage failure')
      return false
    } }
    rig.forkGate.resolve()
    await moved
    assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
    assert.equal(old.inbox.nextStep.filter(item => item.id === prompt.id).length, 1)

    const [claimed] = rig.harness.claim(old, 'next-step', 1)
    assert.equal(claimed.id, prompt.id)
    assert.equal(old.inbox.nextStep.some(item => item.id === prompt.id), false)
    assert.equal(old.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === prompt.id), false)
    rig.rt.ctx.sessions = sessions
    await sessions.flush(old.session)
    await rig.rt.reconcileTasksAfterRestart()
    assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
    assert.equal(old.inbox.nextStep.some(item => item.id === prompt.id), false)
    old.session.append('user/message', claimed, { surfaceOp: 'append' })
    await rig.rt.reconcileTasksAfterRestart()
    assert.deepEqual(journal(rig), [])
    assert.equal(old.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === prompt.id).length, 1)
  })
}

test('a failed team state write rolls back to the original durable inbox', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const save = t.mock.method(rig.rt, 'save', async () => {
    throw Object.assign(new Error('State write blocked'), { code: 'EBUSY' })
  })
  const prompt = userPrompt('Restore this despite an EBUSY state file')
  const moved = rig.rt.handoffForeground(rig.rt.botOf('a'), 'dm-a', [{ msg: prompt, target: 'next-step', oldAgent: old }]).catch(err => err)
  assert.equal((await moved).code, 'EBUSY')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.deepEqual(old.inbox.nextStep.map(item => item.id), [prompt.id])
  const stored = await rig.root.sessionPersistence.open(SessionId('dm-a'), 'read')
  try {
    const { events } = await stored.read()
    const last = events.findLast(event => event.type === 'agent/inbox/spliced')
    assert.deepEqual(last.data.inserted.map(item => item.id), [prompt.id])
  } finally {
    await stored.close()
    save.mock.restore()
  }
})

test('legacy handoff records with the same RPC ID replay independently for different Bots', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  rig.rt.state.bots.b = { id: 'b', name: 'Other Bot', sessionId: 'dm-b' }
  await rig.makeRealAgent('dm-b')
  const id = 'shared-rpc'
  rig.rt.state.pendingHandoffInputs = ['a', 'b'].map(botId => ({
    id, botId, source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text: `Prompt for ${botId}` }],
  }))
  await rig.rt.save()
  await rig.rt.reconcileTasksAfterRestart()
  await Promise.all(['dm-a', 'dm-b'].map(sid => rig.agents.get(sid).whenIdle()))
  assert.deepEqual(journal(rig), [])
  for (const botId of ['a', 'b']) assert.equal(rig.repliesBySession.get(`dm-${botId}`)?.length ?? 0, 1, `Bot ${botId} should receive its own input`)
})

test('recovery recognizes a restored input after a later part switch copies it to a new message ID', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, failForkAndCreate: true, holdFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const prompt = userPrompt('Message without an RPC ID')
  const moved = beginMove(rig)
  await rig.forkStarted.promise
  old.steer(prompt)
  await settle(() => journal(rig).some(item => item.messageId === prompt.id))
  const sessions = rig.rt.ctx.sessions
  rig.rt.ctx.sessions = { flush: async () => false }
  rig.forkGate.resolve()
  await moved
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  const original = old.inbox.nextStep.find(item => item.id === prompt.id)
  const clone = createUserMessage({ content: original.content, source: original.source })
  assert.notEqual(clone.id, original.id)
  const fresh = await rig.makeRealAgent('next-part')
  rig.rt.botOf('a').sessionId = 'next-part'
  await rig.rt.save()
  rig.rt.ctx.sessions = sessions
  assert.equal(old.inbox.remove(original.id), true)
  fresh.followup(clone)
  await fresh.whenIdle()
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig), [])
  const recovered = fresh.session.snapshotEvents().filter(event => event.type === 'user/message'
    && textOf(event.data) === textOf(prompt))
  assert.deepEqual(recovered.map(event => event.data.id), [clone.id])
})

test('reconcile must not clear moved-source admission when persistence is still failing', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, failForkAndCreate: true, holdFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const move = beginMove(rig)
  await rig.forkStarted.promise
  const prompt = userPrompt('Keep this until the original queue confirms storage')
  old.steer(prompt)
  await settle(() => journal(rig).some(item => item.messageId === prompt.id))
  const flush = t.mock.method(rig.rt.ctx.sessions, 'flush', async () => false)
  rig.forkGate.resolve()
  await move
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  assert.deepEqual(old.inbox.nextStep.map(message => message.id), [prompt.id])
  await rig.makeRealAgent('next-part')
  rig.rt.botOf('a').sessionId = 'next-part'
  await rig.rt.save()
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  flush.mock.restore()
})
