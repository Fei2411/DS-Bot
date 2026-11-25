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

async function createRealLoopRig(t, { prefs = {}, failFork = false, failForkAndCreate = false, holdFirstModel = false, holdFork = false, delayResolveMs = 0, enableFlushPersistence = true, durable = false, slowSessionId = 'dm-a' } = {}) {
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
      const lastUser = options.messages.findLast(m => m.role === 'user' && (m.source?.kind === 'user' || m.source?.role === 'task-report' || m.source?.role === 'request'))
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

      if (options.sessionId === slowSessionId && !options.messages.some(m => m.role === 'tool') && lastText.includes('run slow work')) {
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
          if (failFork || failForkAndCreate) throw new Error('simulated fork failure')
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
  root.on('agent/assistant-stream', (payload) => {
    for (const listener of ctx.listeners.get('agent/assistant-stream') ?? []) {
      listener(payload)
    }
  })
  root.on('agent/inbox/discarded', (payload) => {
    for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) {
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

  // The explicit foreground handoff notice must instruct the new foreground how to inspect
  // or redirect the background task (`task_read` and `task_send`).
  const handoffNotice = rig.agents.get(fgSid).inbox.nextStep.find(item => item?.source?.role === 'task-handoff')
    ?? rig.agents.get(fgSid).session.snapshotEvents().find(ev => ev.type === 'user/message' && ev.data?.source?.role === 'task-handoff')?.data
  assert.ok(handoffNotice, 'explicit fg-handoff must inject a task-handoff notice on the new foreground')
  assert.match(textOf(handoffNotice), new RegExp(`task_read\\(task: "${task.id}"\\)`))
  assert.match(textOf(handoffNotice), new RegExp(`task_send\\(task: "${task.id}"`))

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

test('a failed journal write for input held during a fork leaves the original foreground in place', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, holdFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const moved = beginMove(rig)
  await rig.forkStarted.promise

  const save = t.mock.method(rig.rt, 'save', async () => {
    throw Object.assign(new Error('State write blocked during fork'), { code: 'EBUSY' })
  })
  const prompt = userPrompt('Restore the late steer to its original queue')
  old.steer(prompt)
  assert.equal(old.inbox.nextStep.length, 0)
  assert.deepEqual(journal(rig), [])
  rig.forkGate.resolve()

  assert.equal((await moved).code, 'EBUSY')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.taskOwners.has('dm-a'), false)
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

test('held input waits for a successful retry of the foreground commit save', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, holdFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const move = { botId: 'a', expectedSessionId: 'dm-a', operationId: 'retry-foreground-commit' }
  const moved = rig.rt.moveForegroundToBackground(move).catch(error => error)
  await rig.forkStarted.promise
  const prompt = userPrompt('Wait for the foreground commit', 'held-commit-retry')
  old.steer(prompt)
  await rig.rt.save()
  assert.equal(old.inbox.nextStep.length, 0)
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])

  const save = rig.rt.save
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (rig.rt.botOf('a').sessionId !== 'dm-a') {
      throw Object.assign(new Error('Foreground commit write blocked'), { code: 'EBUSY' })
    }
    return save(options)
  })
  rig.forkGate.resolve()
  assert.equal((await moved).code, 'EBUSY')
  assert.equal(rig.rt.botOf('a').sessionId, 'fork-1')
  assert.equal(JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).bots.a.sessionId, 'dm-a')
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  const fresh = rig.agents.get('fork-1')
  const admitted = () => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId)
  await new Promise(resolve => setImmediate(resolve))
  await fresh.whenIdle()
  assert.equal(admitted().length, 0)
  assert.deepEqual(rig.rt.state.pendingHandoffInputs?.map(item => item.messageId), [prompt.id])
  await rig.rt.reconcileTasksAfterRestart()
  assert.equal(admitted().length, 0)
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])

  blocked.mock.restore()
  assert.equal((await rig.rt.moveForegroundToBackground(move)).sessionId, 'fork-1')
  await fresh.whenIdle()
  assert.equal(admitted().length, 1)
  assert.equal(JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).bots.a.sessionId, 'fork-1')
  assert.deepEqual(journal(rig), [])
})

test('a failed foreground commit replays held input without another move request', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, holdFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const moved = beginMove(rig)
  await rig.forkStarted.promise
  const prompt = userPrompt('Replay this after writes recover', 'automatic-commit-replay')
  old.steer(prompt)
  await rig.rt.save()
  assert.equal(old.inbox.nextStep.length, 0)
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])

  const save = rig.rt.save
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (options?.required && rig.rt.botOf('a').sessionId === 'fork-1') {
      throw Object.assign(new Error('Foreground commit write blocked'), { code: 'EBUSY' })
    }
    return save(options)
  })
  rig.forkGate.resolve()
  assert.equal((await moved).code, 'EBUSY')
  blocked.mock.restore()
  await rig.rt.save()
  assert.equal(JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).bots.a.sessionId, 'fork-1')

  const fresh = rig.agents.get('fork-1')
  const task = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
  assert.equal(task?.status, 'running')
  const admitted = () => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId)
  await settle(() => admitted().length === 1 && journal(rig).length === 0, 3500,
    'the held input should be replayed without retrying the move or restarting the host')
  await fresh.whenIdle()
  assert.equal(admitted().length, 1)
  const queuedMessages = fresh.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
  const noticeIndex = queuedMessages.findIndex(message => message.source?.role === 'task-handoff'
    && message.source.taskId === task.id && textOf(message).includes('is still running'))
  const promptIndex = queuedMessages.findIndex(message => message.source?.rpcId === prompt.source.rpcId)
  assert.ok(noticeIndex >= 0 && noticeIndex < promptIndex, 'the active task notice must precede the recovered correction')
})

test('a stale-session prompt arriving during the foreground commit waits for a durable replay', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise

  const commitStarted = Promise.withResolvers()
  const commitGate = Promise.withResolvers()
  const save = rig.rt.save
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (rig.rt.botOf('a').sessionId === 'dm-a') return save(options)
    if (options?.required) {
      commitStarted.resolve()
      await commitGate.promise
    }
    throw Object.assign(new Error('Foreground commit write blocked'), { code: 'EBUSY' })
  })
  const moved = beginMove(rig)
  await commitStarted.promise
  const operationId = 'desktop:failed-commit-join'
  let joinedSettled = false
  const joined = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId })
    .catch(error => error).finally(() => { joinedSettled = true })
  assert.equal(rig.rt.taskOwners.has('dm-a'), true)
  const fresh = rig.agents.get('fork-1')
  const prompt = userPrompt('Send this from the stale tab', 'during-foreground-commit')
  const admitted = () => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId)
  const diskForeground = () => JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).bots.a.sessionId
  old.steer(prompt)
  assert.equal(old.inbox.nextStep.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(joinedSettled, false, 'a joined request must wait for the required move save')
  commitGate.resolve()

  assert.equal((await moved).code, 'EBUSY')
  assert.equal((await joined).code, 'EBUSY')
  assert.equal(rig.rt.state.completedMoveOps?.[operationId], undefined)
  await new Promise(resolve => setImmediate(resolve))
  await fresh.whenIdle()
  assert.equal(diskForeground(), 'dm-a')
  assert.equal(admitted().length, 0, 'a stale-session prompt must not reach an uncommitted foreground')
  assert.deepEqual(rig.rt.state.pendingHandoffInputs?.map(item => item.messageId), [prompt.id])
  await rig.rt.reconcileTasksAfterRestart()
  assert.equal(admitted().length, 0)

  blocked.mock.restore()
  await settle(() => admitted().length === 1 && journal(rig).length === 0, 4500, 'the stale-session prompt should replay after writes recover')
  assert.equal(diskForeground(), 'fork-1')
  assert.equal(admitted().length, 1)
})

test('a stale-session prompt missed by the commit snapshot is checkpointed before delivery', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise

  const commitWritten = Promise.withResolvers()
  const commitGate = Promise.withResolvers()
  const checkpointGate = Promise.withResolvers()
  const save = rig.rt.save
  let requiredWrites = 0
  t.mock.method(rig.rt, 'save', async (options) => {
    if (rig.rt.botOf('a').sessionId === 'dm-a') return save(options)
    if (!options?.required && requiredWrites < 2) throw new Error('Best-effort write blocked')
    if (options?.required && ++requiredWrites === 1) {
      await save(options)
      commitWritten.resolve()
      await commitGate.promise
      return
    }
    await checkpointGate.promise
    return save(options)
  })
  const moved = beginMove(rig)
  await commitWritten.promise
  const prompt = userPrompt('Sent after the commit snapshot', 'after-commit-snapshot')
  old.steer(prompt)
  const fresh = rig.agents.get('fork-1')
  const admitted = () => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId)
  assert.deepEqual(journal(rig), [])
  commitGate.resolve()
  await settle(() => requiredWrites === 2 || admitted().length > 0)
  assert.equal(admitted().length, 0, 'delivery must wait for the late input checkpoint')
  assert.equal(requiredWrites, 2)

  checkpointGate.resolve()
  assert.equal((await moved).sessionId, 'fork-1')
  await fresh.whenIdle()
  assert.equal(admitted().length, 1)
  assert.deepEqual(journal(rig), [])
})

test('a stale-session prompt arriving after checkpoint rejection is replayed', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise

  const commitWritten = Promise.withResolvers()
  const commitGate = Promise.withResolvers()
  const checkpointStarted = Promise.withResolvers()
  const checkpoint = Promise.withResolvers()
  const save = rig.rt.save
  let requiredWrites = 0
  const blocked = t.mock.method(rig.rt, 'save', (options) => {
    if (rig.rt.botOf('a').sessionId === 'dm-a') return save(options)
    if (options?.required && ++requiredWrites === 1) {
      return save(options).then(() => {
        commitWritten.resolve()
        return commitGate.promise
      })
    }
    if (options?.required && requiredWrites === 2) {
      checkpointStarted.resolve()
      return checkpoint.promise
    }
    return Promise.reject(new Error('Best-effort write blocked'))
  })
  const moved = beginMove(rig)
  await commitWritten.promise
  const first = userPrompt('Sent before checkpoint rejection', 'before-checkpoint-rejection')
  const second = userPrompt('Sent after checkpoint rejection', 'after-checkpoint-rejection')
  old.steer(first)
  commitGate.resolve()
  await checkpointStarted.promise
  checkpoint.reject(Object.assign(new Error('Late checkpoint blocked'), { code: 'EBUSY' }))
  // The save's catch runs first; the handoff's outer finally is still pending.
  await new Promise((resolve) => queueMicrotask(() => {
    old.steer(second)
    resolve()
  }))
  assert.equal((await moved).sessionId, 'fork-1')
  blocked.mock.restore()
  const fresh = rig.agents.get('fork-1')
  const admitted = prompt => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId).length
  await settle(() => admitted(first) === 1, 4500, 'the first prompt should replay after writes recover')
  await rig.rt.reconcileTasksAfterRestart()
  await settle(() => admitted(second) === 1 && journal(rig).length === 0, 4500,
    'the prompt arriving after rejection must not be locked out of replay')
  assert.equal(admitted(second), 1, 'the prompt arriving after rejection must not be locked out of replay')
  assert.deepEqual(journal(rig), [])
})

test('a failed late checkpoint cannot roll back an already written move receipt', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise

  const commitWritten = Promise.withResolvers()
  const commitGate = Promise.withResolvers()
  const save = rig.rt.save
  let committed = false
  let lateCheckpointFailed = false
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (rig.rt.botOf('a').sessionId === 'dm-a') return save(options)
    if (options?.required && !committed) {
      await save(options)
      committed = true
      commitWritten.resolve()
      await commitGate.promise
      return
    }
    if (options?.required && lateCheckpointFailed) return save(options)
    if (options?.required) lateCheckpointFailed = true
    throw Object.assign(new Error('Late checkpoint blocked'), { code: 'EBUSY' })
  })
  const operationId = 'im:test:bg:late-checkpoint'
  const moved = rig.rt.moveForegroundToBackground({ botId: 'a', operationId }).catch(error => error)
  await commitWritten.promise
  const joinedOperationId = 'desktop:late-checkpoint-join'
  const joined = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: joinedOperationId }).catch(error => error)
  const diskReceipt = (id = operationId) => JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8')).completedMoveOps?.[id]
  assert.equal(diskReceipt()?.sessionId, 'fork-1')
  const prompt = userPrompt('Recover this without rolling back the move', 'late-checkpoint-failure')
  old.steer(prompt)
  commitGate.resolve()
  const moveResult = await moved
  const fresh = rig.agents.get('fork-1')
  const admitted = () => fresh.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.rpcId === prompt.source.rpcId)
  assert.equal(admitted().length, 0)
  assert.equal(lateCheckpointFailed, true)
  assert.deepEqual(await joined, moveResult, 'a caller joining the persisted move must not receive a no-op')
  assert.equal(diskReceipt(joinedOperationId)?.moved, true)

  blocked.mock.restore()
  await settle(() => admitted().length === 1 && journal(rig).length === 0, 4500, 'the late prompt should replay after writes recover')
  assert.equal(diskReceipt()?.sessionId, 'fork-1', 'replay must preserve the committed move receipt')
  assert.equal(moveResult.sessionId, 'fork-1')
  assert.deepEqual(await rig.rt.moveForegroundToBackground({ botId: 'a', operationId }), moveResult)
})

test('replay of a non-forked handoff does not promise a report already delivered', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, holdFork: true, failFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const moved = beginMove(rig)
  await rig.forkStarted.promise
  const prompt = userPrompt('Use the result that is already here', 'already-reported')
  old.steer(prompt)
  await rig.rt.save()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])

  const save = rig.rt.save
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (options?.required && rig.rt.botOf('a').sessionId !== 'dm-a') {
      throw Object.assign(new Error('Foreground commit write blocked'), { code: 'EBUSY' })
    }
    return save(options)
  })
  rig.forkGate.resolve()
  assert.equal((await moved).code, 'EBUSY')
  const fresh = rig.agents.get(rig.rt.botOf('a').sessionId)
  assert.match(fresh.id, /^new-/)
  const task = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
  const transcript = () => fresh.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data)
  const fromTask = role => message => message.source?.role === role && message.source.taskId === task.id
  rig.toolGate.resolve()
  await settle(() => transcript().some(fromTask('task-report')), 4000, 'the background task must have reported before replay')
  assert.equal(task.status, 'completed')
  assert.equal(transcript().some(message => message.source?.rpcId === prompt.source.rpcId), false)

  blocked.mock.restore()
  await settle(() => transcript().some(message => message.source?.rpcId === prompt.source.rpcId) && journal(rig).length === 0,
    4500, 'the held prompt should be delivered after writes recover')
  const delivered = transcript()
  assert.equal(delivered.filter(fromTask('task-report')).length, 1)
  const context = delivered.find(fromTask('task-handoff'))
  assert.ok(context, 'the non-forked chat should still receive the old turn context')
  assert.doesNotMatch(textOf(context), /result is being delivered next/)
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

test('recovery does not replay a queued copy the user deleted after a failed flush', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const agent = rig.agents.get('dm-a')
  agent.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const prompt = userPrompt('Do not bring this back after I remove it')
  rig.rt.state.pendingHandoffInputs = [{
    id: prompt.id, messageId: prompt.id, botId: 'a', target: 'next-step',
    source: prompt.source, content: prompt.content,
  }]
  await rig.rt.save()
  const flush = t.mock.method(rig.rt.ctx.sessions, 'flush', async () => false)
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  const queued = agent.inbox.nextStep.find(item => item.source.rpcId === prompt.id)
  assert.ok(queued)
  assert.equal(agent.inbox.remove(queued.id), true)
  await rig.rt.save()
  flush.mock.restore()
  await rig.rt.reconcileTasksAfterRestart()

  assert.deepEqual(journal(rig), [])
  assert.equal(agent.inbox.nextStep.some(item => item.source.rpcId === prompt.id), false)
})

test('recovery honors queue deletion in a group whose session ID changed', async (t) => {
  const sessionId = 'replacement-group-session'
  const rig = await createRealLoopRig(t, { durable: true, slowSessionId: sessionId })
  const agent = await rig.makeRealAgent(sessionId)
  const roomId = 'stable-group'
  rig.rt.state.rooms[roomId] = { id: roomId, name: 'Group', sessionId: agent.id, members: ['a'] }
  await rig.rt.save()
  assert.equal(rig.rt.roomOf(agent.id).id, roomId)

  agent.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const prompt = userPrompt('Do not bring back this group prompt', 'rpc-group-delete')
  rig.rt.state.pendingHandoffInputs = [{
    id: prompt.source.rpcId, messageId: prompt.id, roomId, target: 'next-step',
    source: prompt.source, content: prompt.content,
  }]
  await rig.rt.save()
  const flush = t.mock.method(rig.rt.ctx.sessions, 'flush', async () => false)
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  const queued = agent.inbox.nextStep.find(item => item.source.rpcId === prompt.source.rpcId)
  assert.ok(queued)
  assert.equal(agent.inbox.remove(queued.id), true)
  await rig.rt.save()
  flush.mock.restore()
  await rig.rt.reconcileTasksAfterRestart()

  assert.deepEqual(journal(rig), [])
  assert.equal(agent.inbox.nextStep.some(item => item.source.rpcId === prompt.source.rpcId), false)
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
  rig.rt.botOf('a').segments = [{ sessionId: 'dm-a' }]
  rig.rt.botOf('a').sessionId = 'next-part'
  await rig.rt.save()
  rig.rt.ctx.sessions = sessions
  const moving = t.mock.method(rig.rt, 'isMovingInboxMessage', id => id === original.id)
  assert.equal(old.inbox.remove(original.id), true)
  moving.mock.restore()
  fresh.followup(clone)
  await fresh.whenIdle()
  const flush = t.mock.method(sessions, 'flush', async session => session.id === 'dm-a')
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])
  assert.deepEqual(flush.mock.calls.map(call => call.arguments[0].id), ['next-part'])
  flush.mock.restore()
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

test('reconcile still injects non-forked handoff context when the deferred user input was discarded before writes recovered', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true, holdFork: true, failFork: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise
  const moved = beginMove(rig)
  await rig.forkStarted.promise
  const prompt = userPrompt('Cancelled before replay', 'discarded-before-replay')
  old.steer(prompt)
  await rig.rt.save()
  assert.deepEqual(journal(rig).map(item => item.messageId), [prompt.id])

  const save = rig.rt.save
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (options?.required && rig.rt.botOf('a').sessionId !== 'dm-a') {
      throw Object.assign(new Error('Foreground commit write blocked'), { code: 'EBUSY' })
    }
    return save(options)
  })
  rig.forkGate.resolve()
  assert.equal((await moved).code, 'EBUSY')

  const fresh = rig.agents.get(rig.rt.botOf('a').sessionId)
  assert.match(fresh.id, /^new-/)
  const task = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
  assert.ok(task)
  // User discarded the queued prompt while writes were blocked.
  rig.rt.state.pendingHandoffInputs[0].discarded = true

  blocked.mock.restore()
  await rig.rt.reconcileTasksAfterRestart()
  assert.deepEqual(journal(rig), [], 'discarded entry must clear once writes recover')
  const notice = fresh.inbox.nextStep.find(item => item?.source?.role === 'task-handoff' && item.source.taskId === task.id)
    ?? fresh.session.snapshotEvents().find(ev => ev.type === 'user/message' && ev.data?.source?.role === 'task-handoff' && ev.data.source.taskId === task.id)?.data
  assert.ok(notice, 'non-forked foreground must still receive task-handoff context even when the deferred prompt was discarded')
  assert.match(textOf(notice), new RegExp(`task_read\\(task: "${task.id}"\\)`))
})

test('joinInFlight registers failed move-receipt persistence in pendingSaveMoveOps so retry returns moved:true', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const old = rig.agents.get('dm-a')
  old.followup(userPrompt('Please run slow work'))
  await rig.toolStarted.promise

  const commitWritten = Promise.withResolvers()
  const commitGate = Promise.withResolvers()
  const save = rig.rt.save
  let committed = false
  let failJoinerReceipt = false
  const blocked = t.mock.method(rig.rt, 'save', async (options) => {
    if (rig.rt.botOf('a').sessionId === 'dm-a') return save(options)
    if (options?.required && !committed) {
      await save(options)
      committed = true
      commitWritten.resolve()
      await commitGate.promise
      return
    }
    if (options?.required && failJoinerReceipt) {
      throw Object.assign(new Error('Joiner receipt write failed'), { code: 'EBUSY' })
    }
    return save(options)
  })

  const opPrimary = 'op:join-primary'
  const opJoiner = 'op:join-secondary'
  const primary = rig.rt.moveForegroundToBackground({ botId: 'a', operationId: opPrimary })
  await commitWritten.promise
  // Enable receipt failure right before joiner joins and primary releases commitGate.
  failJoinerReceipt = true
  const joiner = rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: opJoiner })
  commitGate.resolve()

  const primaryRes = await primary
  assert.equal(primaryRes.moved, true)
  await assert.rejects(joiner, { code: 'EBUSY' })

  // Disk writes recover -> retrying opJoiner must NOT return { moved: false }!
  blocked.mock.restore()
  const retryRes = await rig.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: opJoiner })
  assert.deepEqual(retryRes, primaryRes)
  const disk = JSON.parse(readFileSync(join(rig.home, 'state.json'), 'utf8'))
  assert.equal(disk.completedMoveOps?.[opJoiner]?.sessionId, primaryRes.sessionId)
  assert.equal(disk.completedMoveOps?.[opJoiner]?.taskId, primaryRes.taskId)
  assert.equal(disk.completedMoveOps?.[opJoiner]?.moved, true)
})

test('collectAdmittedIdsFromEvents does not mistake an in-place inbox splice replacement for a turn claim', async (t) => {
  const rig = await createRealLoopRig(t, { durable: true })
  const agent = rig.agents.get('dm-a')
  const original = userPrompt('Original queued prompt', 'rpc-replace-check')
  const replacement = createUserMessage({ content: [{ type: 'text', text: 'Edited queued prompt' }], source: { kind: 'user', rpcId: 'rpc-replace-check' } })

  // Synthetic event sequence: insert original, in-place replace without `outcome: 'canceled'`,
  // then remove replacement -> neither is pending or committed, and original was NOT claimed!
  const syntheticEvents = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [original] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [replacement] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
  ]
  const origSnapshot = agent.session.snapshotEvents.bind(agent.session)
  t.mock.method(agent.session, 'snapshotEvents', () => syntheticEvents)

  // Queue a pending handoff input for that rpcId: because the replace was NOT a claim and
  // the message is neither pending nor committed, reconcile must replay it rather than dropping it.
  rig.rt.state.pendingHandoffInputs = [{
    id: original.source.rpcId,
    messageId: original.id,
    botId: 'a',
    target: 'next-turn',
    source: original.source,
    content: original.content,
  }]
  await rig.rt.save()
  await rig.rt.reconcileTasksAfterRestart()
  agent.session.snapshotEvents = origSnapshot
  await agent.whenIdle()

  assert.deepEqual(journal(rig), [])
  assert.ok((rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Original queued prompt')), 'reconcile must replay when splice was a replace rather than a claim')
})

test('real DSH ReactLoopAgent: steering queued user messages behind hidden peer-Bot work preserves [Q1, Q2] FIFO order', async (t) => {
  const rig = await createRealLoopRig(t, { holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  // Turn 1: ordinary user turn pauses in model stream so a peer request + two user followups queue behind it.
  dmA.followup(userPrompt('NORMAL_TURN'))
  await rig.firstModelStarted.promise

  const peerReq = createUserMessage({
    content: [{ type: 'text', text: '[Message from Peer]\nPlease run slow work for peer' }],
    source: { kind: 'bot', role: 'request', senderSessionId: 'dm-b', senderName: 'Peer', exchangeId: 'ex-hidden-fifo' },
  })
  const q1 = userPrompt('FIRST_QUEUED')
  const q2 = userPrompt('SECOND_QUEUED')
  dmA.followup(peerReq)
  dmA.followup(q1)
  dmA.followup(q2)
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'ordinary busy turn must keep queued messages on dm-a')

  // Finish Turn 1 -> Turn 2 starts the hidden peer request and pauses inside slow_check with [q1, q2] still queued.
  rig.firstModelGate.resolve()
  await rig.toolStarted.promise
  assert.deepEqual(dmA.inbox.nextTurn.map(item => item.id), [q1.id, q2.id])

  // Atomic batch steer signals fallback so per-row steering triggers foreground handoff.
  assert.deepEqual(rig.rt.steerQueued('dm-a', [q1.id, q2.id]), { steered: 0, fallback: true })

  // Per-row fallback steers q1 first; interceptForegroundUserMessage pulls q2 too
  // and must forward [q1, q2] in FIFO order (not [q2, q1]).
  assert.equal(dmA.inbox.remove(q1.id), true)
  dmA.steer(q1)

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    if (fgSid === 'dm-a') return false
    const fresh = rig.agents.get(fgSid)
    const users = fresh?.session?.snapshotEvents?.()
      .filter(ev => ev.type === 'user/message' && ev.data?.source?.kind === 'user')
      .map(ev => textOf(ev.data)) ?? []
    return fresh?.status === 'idle' && users.includes('FIRST_QUEUED') && users.includes('SECOND_QUEUED')
  }, 5000, 'new foreground must consume both forwarded user messages')

  const fgSid = rig.rt.botOf('a').sessionId
  const fresh = rig.agents.get(fgSid)
  const users = fresh.session.snapshotEvents()
    .filter(ev => ev.type === 'user/message' && ev.data?.source?.kind === 'user')
    .map(ev => textOf(ev.data))
  assert.deepEqual(users.slice(-2), ['FIRST_QUEUED', 'SECOND_QUEUED'])

  rig.toolGate.resolve()
  await dmA.whenIdle()
})
