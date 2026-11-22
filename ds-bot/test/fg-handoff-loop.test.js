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
import { fakeContext } from './fake-ctx.js'

const settle = async (check, ms = 4000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), label)
}

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

async function createRealLoopRig(t, { prefs = {}, failForkAndCreate = false, holdFirstModel = false, holdFork = false, delayResolveMs = 0 } = {}) {
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
  await mountAgentLoopTestHarness(root)

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
    await root.fiber.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  return { home, root, rootWarnings, rt, agents, toolStarted, toolGate, firstModelStarted, firstModelGate, forkStarted, forkGate, repliesBySession, modelCallsBySession }
}

test('real DSH SessionStore + ReactLoopAgent: Desktop steer while busy hands off foreground without reentrancy error', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  // Start a busy foreground turn that invokes a slow tool.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  assert.equal(rig.rt.shouldMoveForeground(rig.rt.botOf('a'), 'dm-a'), true)

  // Desktop/Web composer sends a message directly through ReactLoopAgent.steer()
  // (exact path of dsh-api-session-controller.prompt with mode='steer').
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'What are you doing?' }], source: { kind: 'user' } }))

  // Must NOT hit DSH Session.append() reentrancy guard, and must pull the message
  // out of dm-a's inbox immediately (never left stuck as "unread").
  assert.equal(
    rig.rootWarnings.some(line => line.includes('reenter')),
    false,
    `must not trigger DSH Session.append reentrancy error; warnings=${JSON.stringify(rig.rootWarnings)}`,
  )
  assert.equal(dmA.inbox.nextStep.length, 0, 'message must be pulled from busy foreground inbox, not left unread')

  // New foreground session forks and answers the new message immediately while dm-a keeps running in background.
  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    return fgSid !== 'dm-a'
      && (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('What are you doing?'))
  }, 5000, 'new foreground did not answer user message')

  const fgSid = rig.rt.botOf('a').sessionId
  assert.notEqual(fgSid, 'dm-a')
  const task = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
  assert.equal(task?.origin, 'fg-handoff')
  assert.equal(task?.status, 'running')

  // Now finish the background tool -> task settles and reports back to the new foreground.
  rig.toolGate.resolve()
  await settle(() => {
    const t0 = rig.rt.botOf('a').tasks.find(item => item.sessionId === 'dm-a')
    return t0?.status === 'completed'
      && (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Background slow work finished.'))
  }, 5000, 'background task did not settle and report back to new foreground')
})

test('real DSH SessionStore + ReactLoopAgent: post-handoff polling gap redirects stale steer without reentrancy error', async (t) => {
  const rig = await createRealLoopRig(t)
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'First foreground message' }], source: { kind: 'user' } }))
  await settle(() => rig.rt.botOf('a').sessionId !== 'dm-a', 5000, 'handoff did not commit')
  const fgSid = rig.rt.botOf('a').sessionId

  // Simulate Desktop tab still pointing at stale dm-a (now in taskOwners) before roster poll updates.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Stale tab message' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  assert.equal(dmA.inbox.nextStep.length, 0, 'stale message must be pulled from background task inbox')

  await settle(
    () => (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Stale tab message')),
    5000,
    'stale tab message was not redirected to new foreground',
  )
})

test('real DSH SessionStore + ReactLoopAgent: backgroundAfterSec=0 double steer forwards both without self-handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 0 } })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Rapid one' }], source: { kind: 'user' } }))
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Rapid two' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)
  assert.equal(dmA.inbox.nextStep.length, 0)

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    const replies = rig.repliesBySession.get(fgSid) ?? []
    return fgSid !== 'dm-a'
      && replies.some(r => r.includes('Rapid one'))
      && replies.some(r => r.includes('Rapid two'))
  }, 5000, 'both rapid messages must be answered on the single new foreground')

  assert.equal(rig.rt.botOf('a').tasks.length, 1, 'forwarding a 2-message batch at backgroundAfterSec=0 must not trigger a second spurious handoff')
})

test('real DSH SessionStore + ReactLoopAgent: failed pre-commit fork restores pulled steer without loop or reentrancy error', async (t) => {
  const rig = await createRealLoopRig(t, { failForkAndCreate: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise

  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Keep me on failure' }], source: { kind: 'user' } }))
  assert.equal(rig.rootWarnings.some(line => line.includes('reenter')), false)

  await settle(() => dmA.inbox.nextStep.some(m => textOf(m).includes('Keep me on failure')), 3000, 'pulled message must be restored on pre-commit failure')
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
})

test('real DSH SessionStore + ReactLoopAgent: fast-turn steer below waitMs still cuts running model call immediately', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  // Wait is 30s and toolCount=0 -> shouldMoveForeground is false, steer.js must cut immediately.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Interrupt right now' }], source: { kind: 'user' } }))

  await settle(
    () => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Interrupt right now')),
    4000,
    'fast-turn steer must cut the running model call and be answered immediately',
  )
  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'fast-turn steer must not hand off foreground')
  assert.equal(dmA.inbox.nextStep.length, 0)
})

test('real DSH SessionStore + ReactLoopAgent: threshold tick between spliced and maybeCut microtask cuts cleanly without double delivery or false handoff', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  // Steer while still below backgroundAfterSec (both steer.js and bot-tasks.js see false),
  // then advance the real turn's `entry.since` past the threshold BEFORE the `maybeCut` microtask runs.
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

  // Queue a prompt before the handoff threshold.
  const queued = createUserMessage({ content: [{ type: 'text', text: 'Draft queued prompt' }], source: { kind: 'user' } })
  dmA.followup(queued)
  assert.equal(dmA.inbox.nextTurn.length, 1)

  // Now cross the handoff threshold and edit the queued prompt in place via inbox.replace().
  rig.rt.live.get('dm-a').since = Date.now() - 31_000
  assert.equal(rig.rt.shouldMoveForeground(rig.rt.botOf('a'), 'dm-a'), true)
  const edited = Object.freeze({ ...queued, content: [{ type: 'text', text: 'Edited queued prompt' }] })
  assert.equal(dmA.inbox.replace(queued.id, edited), true)
  await realDelay(50)

  assert.equal(rig.rt.botOf('a').sessionId, 'dm-a', 'editing a queued prompt must not trigger foreground handoff')
  assert.equal(rig.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(dmA.inbox.nextTurn.length, 1, 'edited prompt must remain queued')
  assert.equal(textOf(dmA.inbox.nextTurn[0]), 'Edited queued prompt')
})

test('real DSH SessionStore + ReactLoopAgent: handoff transfers earlier queued user prompts in FIFO order and survives stopping the task', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  // Queue an earlier user prompt and a non-user notice before the handoff threshold.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Earlier queued prompt' }], source: { kind: 'user' } }))
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Internal notice' }], source: { kind: 'tool-jobs', form: 'notice', summary: 'job' } }))
  assert.equal(dmA.inbox.nextTurn.length, 2)

  // Cross threshold and send a new prompt that triggers foreground handoff.
  rig.rt.live.get('dm-a').since = Date.now() - 31_000
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Trigger handoff prompt' }], source: { kind: 'user' } }))

  await settle(() => {
    const fgSid = rig.rt.botOf('a').sessionId
    const replies = rig.repliesBySession.get(fgSid) ?? []
    return fgSid !== 'dm-a'
      && replies.some(r => r.includes('Earlier queued prompt'))
      && replies.some(r => r.includes('Trigger handoff prompt'))
  }, 5000, 'both earlier queued prompt and triggering prompt must arrive on new foreground')

  const fgSid = rig.rt.botOf('a').sessionId
  const replies = rig.repliesBySession.get(fgSid) ?? []
  const earlierIdx = replies.findIndex(r => r.includes('Earlier queued prompt'))
  const triggerIdx = replies.findIndex(r => r.includes('Trigger handoff prompt'))
  assert.ok(earlierIdx !== -1 && triggerIdx !== -1 && earlierIdx < triggerIdx, `must preserve FIFO order; replies=${JSON.stringify(replies)}`)
  assert.equal(dmA.inbox.nextTurn.some(m => m.source?.kind === 'user'), false, 'no user prompt may remain stranded on the moved task')
  assert.equal(dmA.inbox.nextTurn.some(m => m.source?.kind === 'tool-jobs'), true, 'non-user notices stay with the background task')

  // Stopping the background task must not have lost the earlier user prompt (already answered on fgSid).
  const task = rig.rt.botOf('a').tasks[0]
  await rig.rt.stopTask('a', task.id)
  assert.equal(task.status, 'stopped')
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
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Move to background' }], source: { kind: 'user' } }))
  await settle(() => rig.rt.botOf('a').sessionId !== 'dm-a'
    && (rig.repliesBySession.get(rig.rt.botOf('a').sessionId) ?? []).some(r => r.includes('Move to background')), 5000)
  const fgSid = rig.rt.botOf('a').sessionId

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

test('real DSH SessionStore + ReactLoopAgent: startup reconcile waits for an in-flight handoff instead of stranding pre-crash pendingHandoffInputs', async (t) => {
  const rig = await createRealLoopRig(t, { holdFork: true })
  const dmA = rig.agents.get('dm-a')

  // Start a busy turn and trigger a brand-new live handoff paused in `fork()`.
  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Please run slow work' }], source: { kind: 'user' } }))
  await rig.toolStarted.promise
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Check the budget' }], source: { kind: 'user' } }))
  await rig.forkStarted.promise
  assert.equal(rig.rt.isHandingOff('dm-a'), true, 'live handoff must be in flight when startup reconcile runs')

  // Prepend a pre-crash saved prompt AFTER `forkStarted` (after resume.js's 0ms startup
  // timer has already passed) so the queue holds `[E_old, E_live]` while `handoffing` is active.
  rig.rt.state.pendingHandoffInputs = [
    { id: 'rpc-pre-crash-1', botId: 'a', content: [{ type: 'text', text: 'Summarize the report' }], source: { kind: 'user', rpcId: 'rpc-pre-crash-1' }, at: Date.now() - 10_000 },
    ...(rig.rt.state.pendingHandoffInputs ?? []),
  ]
  assert.equal(rig.rt.state.pendingHandoffInputs.length, 2, 'must have both pre-crash and live pending entries before reconcile')

  // Startup reconcile must wait on `handoffing` (not return early and strand `E_old`),
  // then replay `E_old` onto the new foreground without duplicating `E_live`.
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
  await reconcilePromise

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

  // Simulate a prompt that DSH durably accepted before crash and is now running on dm-a,
  // while its pendingHandoffInputs record survived on disk because the host crashed before clearing it.
  dmA.followup(createUserMessage({
    content: [{ type: 'text', text: 'Please run slow work for status update' }],
    source: { kind: 'user', rpcId: 'rpc-already-running-1' },
  }))
  await rig.toolStarted.promise

  // A follow-up user message moves dm-a (still running rpc-already-running-1) into background.
  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'New foreground question' }], source: { kind: 'user' } }))
  await rig.forkStarted.promise

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
  await reconcilePromise

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
