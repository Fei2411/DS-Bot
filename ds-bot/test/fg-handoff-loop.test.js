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

async function createRealLoopRig(t, { prefs = {}, failForkAndCreate = false, holdFirstModel = false } = {}) {
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
  let callSeq = 0
  let modelCalls = 0
  const repliesBySession = new Map()

  root.tools.register({
    name: 'slow_check',
    description: 'Pause mid-turn so a Desktop user message arrives while busy',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      toolStarted.resolve()
      await toolGate.promise
      return { ok: true, detail: 'background check done' }
    },
  })

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(options) {
      modelCalls += 1
      const callNo = modelCalls
      const last = options.messages.at(-1)
      const lastText = textOf(last)

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

      if (options.sessionId === 'dm-a' && last?.role === 'user' && lastText.includes('run slow work')) {
        const id = `call_${++callSeq}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'slow_check', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'slow_check', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      const reply = options.sessionId === 'dm-a' && last?.role === 'tool'
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
        resolveAgent: async sessionId => ({ agent: agents.get(sessionId) ?? root.agents.get(sessionId) }),
        create: async () => {
          if (failForkAndCreate) throw new Error('simulated create failure')
          const sid = `new-${++forkSeq}`
          await makeRealAgent(sid)
          return { sessionId: sid }
        },
        fork: async () => {
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

  // Forward real DSH session/event and agent/inbox/inserted to the DS Bot runtime.
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

  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    toolGate.resolve()
    firstModelGate.resolve()
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  return { home, root, rootWarnings, rt, agents, toolStarted, toolGate, firstModelStarted, firstModelGate, repliesBySession }
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

test('real DSH SessionStore + ReactLoopAgent: threshold tick between spliced and maybeCut microtask never strands steer unread', async (t) => {
  const rig = await createRealLoopRig(t, { prefs: { backgroundAfterSec: 30 }, holdFirstModel: true })
  const dmA = rig.agents.get('dm-a')

  dmA.followup(createUserMessage({ content: [{ type: 'text', text: 'Long first thought' }], source: { kind: 'user' } }))
  await rig.firstModelStarted.promise

  // Simulate clock crossing backgroundAfterSec right after `agent/inbox/spliced` +
  // `agent/inbox/inserted` both saw `false`, just before `maybeCut` microtask runs.
  let checks = 0
  t.mock.method(rig.rt, 'shouldMoveForeground', () => {
    checks += 1
    return checks > 2
  })

  dmA.steer(createUserMessage({ content: [{ type: 'text', text: 'Boundary steer' }], source: { kind: 'user' } }))

  await settle(
    () => (rig.repliesBySession.get('dm-a') ?? []).some(r => r.includes('Boundary steer')),
    4000,
    'boundary steer must not be stranded unread when threshold flips before maybeCut',
  )
  assert.equal(dmA.inbox.nextStep.length, 0)
})
