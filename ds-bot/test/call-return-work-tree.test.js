import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const textOf = content => (Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : String(content ?? ''))
const textBlock = text => [{ type: 'text', text }]
const assistantText = text => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })

const settle = async (check, ms = 4000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), label)
}

function makeTeam(over = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
      ...over.bots,
    },
    rooms: over.rooms ?? {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: over.works ?? {},
    questions: {},
    views: {},
    prefs: over.prefs ?? {},
    revision: 0,
  }
}

async function startHost(t, { team = makeTeam(), forkImpl, pageEvents = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-tree-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const ctx = fakeContext()
  const agents = new Map()
  let seq = 0
  let nextFork = 0

  const makeAgent = (id) => {
    const events = []
    const calls = []
    const session = {
      id,
      header: { cwd: workDir },
      events,
      requestHeader: () => undefined,
      snapshotEvents: () => [...events],
      deriveMessages: () => events.flatMap((ev) => {
        if (ev.type === 'user/message') return [{ role: 'user', content: ev.data?.content ?? [], source: ev.data?.source }]
        if (ev.type === 'assistant/message') return [{ ...ev.data?.message, role: 'assistant' }]
        return []
      }),
    }
    const inbox = {
      nextStep: [],
      nextTurn: [],
      locate(msgId) {
        for (const [target, list] of [['next-turn', this.nextTurn], ['next-step', this.nextStep]]) {
          const index = list.findIndex(item => item?.id === msgId)
          if (index !== -1) return { target, index }
        }
        return undefined
      },
      prepend(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg) },
      append(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg) },
      remove(msgId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) {
            const [removed] = list.splice(at, 1)
            // Match real DSH dsh-agent-loop: inbox.remove() synchronously emits agent/inbox/discarded.
            for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) {
              listener({ agent, message: removed })
            }
            return true
          }
        }
        return false
      },
    }
    const agent = {
      id,
      session,
      status: 'idle',
      calls,
      inbox,
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
        on: () => () => {},
        effect: fn => fn?.(),
      },
      send(message, target = 'next-turn') {
        calls.push([target === 'next-step' ? 'steer' : 'followup', message])
        inbox.append(target, message)
        for (const listener of ctx.listeners.get('agent/inbox/inserted') ?? []) {
          listener({ agent, message })
        }
      },
      followup(message) {
        calls.push(['followup', message])
        inbox.append('next-turn', message)
        events.push({ type: 'user/message', seq: ++seq, data: { source: message.source, message, content: message.content } })
        for (const listener of ctx.listeners.get('agent/inbox/inserted') ?? []) {
          listener({ agent, message })
        }
      },
      steer(message) {
        calls.push(['steer', message])
        inbox.append('next-step', message)
        events.push({ type: 'user/message', seq: ++seq, data: { source: message.source, message, content: message.content } })
        for (const listener of ctx.listeners.get('agent/inbox/inserted') ?? []) {
          listener({ agent, message })
        }
      },
      inject(message) {
        calls.push(['inject', message])
        // Match real DSH dsh-agent-loop: agent.inject() calls send(msg, 'next-step', false).
        inbox.append('next-step', message)
      },
      cancel(cause) {
        calls.push(['cancel', cause])
      },
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    }
    agents.set(id, agent)
    return agent
  }

  for (const bot of Object.values(team.bots)) makeAgent(bot.sessionId ?? bot.id)
  for (const room of Object.values(team.rooms ?? {})) {
    makeAgent(room.sessionId ?? room.id)
    for (const sid of Object.values(room.sessions ?? {})) makeAgent(sid)
  }

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: workDir }),
      resolveByPath: async () => ({ id: 'w1', path: workDir }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => {
        const sid = `created-${++nextFork}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      fork: async (opts) => {
        if (typeof forkImpl === 'function') return forkImpl(opts, () => {
          const sid = `fork-${++nextFork}`
          makeAgent(sid)
          return sid
        })
        const sid = `fork-${++nextFork}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      resolveAgent: async (sessionId) => ({ agent: agents.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      page: async (sessionId) => ({ records: pageEvents[sessionId] ?? [], hasMore: false }),
      inspect: async (sessionId) => ({ events: pageEvents[sessionId] ?? agents.get(sessionId)?.session?.snapshotEvents?.() ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      flush: async () => {},
      messageProjections: [],
      get: id => (agents.get(id) ?? makeAgent(id)).session,
    },
  })
  ctx.get = key => (key === 'agents' ? agents : undefined)

  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()

  const emit = (id, type, data, extra) => {
    const agent = agents.get(id) ?? makeAgent(id)
    if (type === 'user/message' && data?.source?.exchangeId !== undefined) {
      for (const list of [agent.inbox.nextStep, agent.inbox.nextTurn]) {
        const at = list.findIndex(item => item?.source?.exchangeId === data.source.exchangeId)
        if (at !== -1) list.splice(at, 1)
      }
    }
    const event = { type, seq: ++seq, time: Date.now(), data, ...extra }
    agent.session.events.push(event)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agent.session, event)
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name)
    .execute(args, { agent: agents.get(sessionId) ?? makeAgent(sessionId), ...exec })

  return { rt, ctx, agents, makeAgent, emit, tool, home, workDir }
}

async function createRealAgentRig(t, { bots, prefs = {}, streamHandler, preStepHook } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-real-loop-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  const team = makeTeam({ bots, prefs })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  const repliesBySession = new Map()

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } }
    }
    async *stream(options) {
      yield* streamHandler(options, { repliesBySession })
    }
  }

  root.llm.registerAdapter(['test'], new TestAdapter())
  await mountAgentLoopTestHarness(root)

  const agents = new Map()
  let nextFork = 0

  const registerSession = async (sid) => {
    const agent = await root.agentLoop.create(SessionId(sid), {
      provider: 'test',
      model: 'mock',
      cwd: workDir,
    })
    agents.set(sid, agent)
    return agent
  }

  for (const bot of Object.values(team.bots)) {
    await registerSession(bot.sessionId)
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
        resolveByPath: async () => ({ id: 'w1', path: workDir }),
        create: async path => ({ id: 'w1', path }),
        archiveSession: async () => {},
      },
      sessionController: {
        create: async () => {
          const sid = `created-${++nextFork}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        fork: async () => {
          const sid = `fork-${++nextFork}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        resolveAgent: async (sessionId) => ({ agent: agents.get(sessionId) ?? root.agents.get(sessionId) ?? await registerSession(sessionId) }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async (sessionId) => ({ events: (agents.get(sessionId) ?? root.agents.get(sessionId))?.session?.snapshotEvents?.() ?? [] }),
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

  root.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const reply = textOf(event.data?.message?.content)
      if (reply) {
        const list = repliesBySession.get(session.id) ?? []
        list.push(reply)
        repliesBySession.set(session.id, list)
      }
    }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  for (const evName of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded']) {
    root.on(evName, (payload) => {
      for (const listener of ctx.listeners.get(evName) ?? []) listener(payload)
    })
  }
  root.on('agent/pre-step', async (payload, next) => {
    if (typeof preStepHook === 'function') {
      const res = await preStepHook(payload, next)
      if (res !== undefined) return res
    }
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](payload, () => run(index + 1)) : next())
    return run(0)
  })

  const rigRt = createRuntime(ctx, { home })
  // Register team tools on root so real ReactLoopAgent tool calls execute them directly.
  for (const def of rigRt.teamTools) {
    root.tools.register(def)
  }

  t.after(async () => {
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rigRt.load()

  const tool = (name, args, sessionId) => rigRt.teamTools.find(d => d.name === name)
    .execute(args, { agent: agents.get(sessionId) })

  return { rt: rigRt, ctx, root, agents, repliesBySession, tool, registerSession }
}

test('F1 (real ReactLoopAgent): user steer during <5s zero-tool hidden peer-Bot turn hands off immediately without STEER_CUT leak', async (t) => {
  const peerModelEntered = Promise.withResolvers()
  const peerModelRelease = Promise.withResolvers()
  let steerCutObserved = false

  const rig = await createRealAgentRig(t, {
    prefs: { backgroundAfterSec: 30 },
    async *streamHandler(options) {
      const allText = options.messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
      if (options.sessionId === 'dm-b' && allText.includes('audit config')) {
        peerModelEntered.resolve()
        await new Promise((resolve) => {
          if (options.signal?.aborted) { resolve(); return }
          const onAbort = () => { steerCutObserved = true; resolve() }
          options.signal?.addEventListener('abort', onAbort, { once: true })
          peerModelRelease.promise.then(() => {
            options.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Config audit complete.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Config audit complete.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const reply = allText.includes('Hello Writer') ? 'Hi user, ready to help!' : 'Noted.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // Chief delegates #W1 to idle Writer on dm-b.
  const receipt = await rig.tool('delegate_work', { to: 'Writer', goal: 'audit config' }, 'dm-a')
  assert.match(receipt, /#W1/)
  await peerModelEntered.promise

  // Elapsed is ~10ms (< 30s) and toolCount === 0, yet shouldMoveForeground MUST be true for hidden peer work.
  assert.equal(rig.rt.shouldMoveForeground(rig.rt.botOf('b'), 'dm-b'), true)

  // User sends a steer message to Writer's foreground dm-b while peer turn is in model phase.
  rig.agents.get('dm-b').steer(createUserMessage({
    content: textBlock('Hello Writer'),
    source: { kind: 'user' },
  }))

  // Fresh foreground session receives the user's message and replies visibly.
  await settle(() => {
    const fgSid = rig.rt.botOf('b').sessionId
    return fgSid !== 'dm-b' && (rig.repliesBySession.get(fgSid) ?? []).some(r => r.includes('Hi user'))
  }, 4000, 'user message must be answered on a fresh visible foreground session')

  const fgSid = rig.rt.botOf('b').sessionId
  assert.equal(steerCutObserved, false, 'hidden peer-Bot turn must NOT be aborted via STEER_CUT')
  assert.equal((rig.rt.state.exchangeTurns[fgSid] ?? []).length, 0, 'user foreground reply must remain visible (not hidden in exchangeTurns)')

  // Moved work #W1 must record toSession = 'dm-b' so answer_work / cancel_work route to the background task.
  const [workId, work] = Object.entries(rig.rt.state.works)[0]
  assert.equal(work.toSession, 'dm-b', 'handoffForeground must update work.toSession to the moved task session')
  assert.ok(work.toTaskId, 'handoffForeground must update work.toTaskId')

  // Release the moved bot-handoff peer turn: its real answer returns to Chief, NOT the user's message.
  peerModelRelease.resolve()
  await settle(() => rig.rt.state.works[workId] === undefined, 4000, 'moved #W1 must finish and close')
  await settle(() => {
    const events = rig.agents.get('dm-a').session.snapshotEvents()
    return events.some(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply' && textOf(ev.data?.content).includes('Config audit complete.'))
  }, 4000, 'Chief must receive the real #W1 answer, not the user reply')
  const chiefEvents = rig.agents.get('dm-a').session.snapshotEvents()
  assert.equal(
    chiefEvents.some(ev => textOf(ev.data?.content).includes('Hi user')),
    false,
    'user foreground reply must NEVER leak to Chief as #W1 answer',
  )
})

test('F1 (non-movable runtime): user next-step steer during hidden peer-Bot turn demotes to next-turn and steer.js refuses STEER_CUT', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t, {
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
        b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', model: 'local-cli/claude', createdAt: 2 },
      },
    }),
  })
  // Local CLI Bots now support moving hidden peer work to background (D8);
  // simulate a runtime/state where foreground handoff is disabled to verify the
  // defensive next-step -> next-turn demotion fallback.
  t.mock.method(rt, 'isLocalAgentRef', ref => ref === 'local-cli/claude')

  await tool('delegate_work', { to: 'Writer', goal: 'inspect logs' }, 'dm-a')
  const req = agents.get('dm-b').calls.at(-1)[1]
  const dmB = agents.get('dm-b')
  dmB.inbox.nextStep.length = 0
  dmB.status = 'running'
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: req.content, source: req.source })
  emit('dm-b', 'step/start', { turn: 1, step: 1 })

  assert.equal(rt.shouldMoveForeground(rt.botOf('b'), 'dm-b'), true, 'local CLI Bot supports isolating hidden peer work to background')

  t.mock.method(rt.contextRuntime, 'capabilitiesFor', () => ({ isLocal: true, canMoveToBackground: false }))
  assert.equal(rt.shouldMoveForeground(rt.botOf('b'), 'dm-b'), false)

  // User sends a next-step steer while foreground handoff is disabled during hidden #W1.
  const userMsg = createUserMessage({ content: textBlock('User question for Writer'), source: { kind: 'user' } })
  dmB.send(userMsg, 'next-step')
  await realDelay(30)

  assert.equal(dmB.inbox.nextStep.some(m => m.id === userMsg.id), false, 'user steer must be removed from next-step during hidden peer turn')
  assert.equal(dmB.inbox.nextTurn.some(m => m.id === userMsg.id), true, 'user steer must be demoted to next-turn')
  assert.equal(dmB.calls.some(([kind]) => kind === 'cancel'), false, 'steer.js must NOT fire STEER_CUT on a hidden peer turn')
})

test('F2: handoffForeground updates toSession so answer_work routes to moved task; task_start joins work tree (cycle block, cancel wake, parent cancel, caller deletion)', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t)

  // 1) handoffForeground -> ask_back -> answer_work routes to moved task session, NOT new foreground.
  await tool('delegate_work', { to: 'Writer', goal: 'prepare patch' }, 'dm-a')
  const req1 = agents.get('dm-b').calls.at(-1)[1]
  const dmB = agents.get('dm-b')
  dmB.status = 'running'
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: req1.content, source: req1.source })
  const newFg = await rt.handoffForeground(rt.botOf('b'), 'dm-b')
  assert.notEqual(newFg, 'dm-b')
  assert.equal(rt.state.works[req1.source.exchangeId].toSession, 'dm-b')

  await tool('ask_back', { question: 'Which branch?' }, 'dm-b')
  const askMsg = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: askMsg.content, source: askMsg.source })
  await tool('answer_work', { answer: 'Use dev.' }, 'dm-a')

  assert.ok(agents.get('dm-b').calls.some(([, m]) => m?.source?.role === 'answer' && m.source.work === req1.source.exchangeId), 'answer_work must route to moved task dm-b')
  assert.equal(agents.get(newFg).calls.some(([, m]) => m?.source?.role === 'answer'), false, 'answer_work must NOT leak into new foreground chat')

  // Close W1 cleanly after consuming Chief's answer to start next sub-scenario.
  const ansMsg = agents.get('dm-b').calls.findLast(([, m]) => m?.source?.role === 'answer')[1]
  emit('dm-b', 'user/message', { content: ansMsg.content, source: ansMsg.source })
  emit('dm-b', 'assistant/message', assistantText('Patch ready.'))
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => rt.state.works[req1.source.exchangeId] === undefined)

  // 2) Boss -> Writer (#W2) -> task_start (T1) -> cycle delegate_work(Chief) refused; delegate_work(Reviewer) (#W3) + cancel_work wakes T1; cancel_work(#W2) stops T1.
  const writerFg = rt.chatOf('b')
  await tool('delegate_work', { to: 'Writer', goal: 'coordinate release' }, 'dm-a')
  const req2 = agents.get(writerFg).calls.at(-1)[1]
  const w2Id = req2.source.exchangeId
  emit(writerFg, 'turn/start', { turn: 2 })
  emit(writerFg, 'user/message', { content: req2.content, source: req2.source })

  const started = await tool('task_start', { title: 'Release task', brief: 'Delegate QA' }, writerFg)
  assert.match(started, /Started background task/)
  const task1 = rt.botOf('b').tasks.at(-1)
  assert.equal(task1.parentWorkId, w2Id)
  assert.equal(rt.state.works[task1.workId].toSession, task1.sessionId)

  // Cycle refusal inside task_start: Chief is upstream via task:T1 -> W2 -> Chief.
  const aCallsBefore = agents.get('dm-a').calls.length
  const cycleRes = await tool('delegate_work', { to: 'Chief', goal: 'please check' }, task1.sessionId)
  assert.match(cycleRes, /Not sent: Chief is waiting for the result/)
  assert.equal(agents.get('dm-a').calls.length, aCallsBefore)

  // Task delegates #W3 to Reviewer; parent is task:T1.
  await tool('delegate_work', { to: 'Reviewer', goal: 'run smoke tests' }, task1.sessionId)
  const req3 = agents.get('dm-c').calls.at(-1)[1]
  const w3Id = req3.source.exchangeId
  assert.equal(rt.state.works[w3Id].parent, task1.workId)

  // User cancels #W3 while T1 is idle in waiting_work -> T1 must be woken with cancel summary!
  const t1CallsBefore = agents.get(task1.sessionId).calls.length
  assert.equal(await rt.cancelWorkByUser(w3Id, 'skip smoke'), true)
  await settle(() => agents.get(task1.sessionId).calls.length > t1CallsBefore, 2000, 'T1 must wake when child #W3 is cancelled')
  const wakeMsg = agents.get(task1.sessionId).calls.at(-1)[1]
  assert.equal(wakeMsg.source.role, 'reply')
  assert.equal(wakeMsg.source.work, task1.workId)
  assert.match(textOf(wakeMsg.content), /cancelled by the user/)

  // Cancelling parent #W2 must ALSO stop active child task_start task T1!
  await tool('cancel_work', { target: w2Id, reason: 'release postponed' }, 'dm-a')
  assert.equal(task1.status, 'stopped', 'cancelling parent work must stop linked task_start task')

  // 3) User-started task_start (no parent work) delegates #W4 -> external cancel_work wakes task!
  emit(writerFg, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  emit(writerFg, 'turn/start', { turn: 3 })
  emit(writerFg, 'user/message', { content: textBlock('Run background check'), source: { kind: 'user' } })
  await tool('task_start', { title: 'User bg check', brief: 'Ask Reviewer' }, writerFg)
  const task2 = rt.botOf('b').tasks.at(-1)
  assert.equal(task2.workId, undefined)
  await tool('delegate_work', { to: 'Reviewer', goal: 'check disk' }, task2.sessionId)
  const req4 = agents.get('dm-c').calls.at(-1)[1]
  const w4Id = req4.source.exchangeId
  const t2CallsBefore = agents.get(task2.sessionId).calls.length
  assert.equal(await rt.cancelWorkByUser(w4Id, 'no longer needed'), true)
  await settle(() => agents.get(task2.sessionId).calls.length > t2CallsBefore, 2000, 'user-started task must wake when its delegated work is cancelled')
  assert.match(textOf(agents.get(task2.sessionId).calls.at(-1)[1].content), /cancelled by the user/)

  // 4) Deleting caller Bot aborts target's bot-handoff work/task instead of silently dropping it.
  emit('dm-c', 'turn/start', { turn: 1 })
  emit('dm-c', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await tool('delegate_work', { to: 'Reviewer', goal: 'long job for Chief' }, 'dm-a')
  const reviewerHandoff = rt.botOf('c').tasks.find(item => item.origin === 'bot-handoff' && item.status === 'running')
  assert.ok(reviewerHandoff, 'Reviewer should have a running bot-handoff task')
  await rt.releaseBot('a', ['dm-a'])
  assert.equal(reviewerHandoff.status, 'stopped', 'deleting caller Bot must stop target bot-handoff task')
  assert.equal(rt.state.works[reviewerHandoff.exchangeId], undefined)
})

test('F3 (atomic delivery rollback): pre-enqueue deliver failure rolls back ask_back, answer_work, delegate_work, resumePausedWork; post-enqueue flush failure does NOT roll back', async (t) => {
  const { rt, ctx, agents, emit, tool } = await startHost(t)

  // 1) Pre-enqueue failure in delegate_work (resolveAgent throws before enqueue) -> dropWork + forgetDelivery.
  const origResolve = ctx.sessionController.resolveAgent
  let failResolveFor = 'dm-b'
  ctx.sessionController.resolveAgent = async (sid) => {
    if (sid === failResolveFor) throw new Error('agent resolution failed')
    return origResolve(sid)
  }
  // Note: dispatchDelegation calls resolveAgent(chat) before openWork; test ensureCapabilities failure AFTER openWork!
  ctx.sessionController.resolveAgent = origResolve
  const origEnsure = rt.ensureCapabilities
  let failEnsureFor = 'dm-b'
  rt.ensureCapabilities = async (sid) => {
    if (sid === failEnsureFor) throw new Error('capability mount failed')
    return origEnsure(sid)
  }

  await assert.rejects(() => tool('delegate_work', { to: 'Writer', goal: 'will fail pre-enqueue' }, 'dm-a'), /capability mount failed/)
  assert.equal(Object.keys(rt.state.works).length, 0, 'pre-enqueue failure must drop opened work')
  assert.equal(rt.unreadOf('dm-b').length, 0, 'pre-enqueue failure must forget inflight delivery')

  // 2) Post-enqueue flush failure in delegate_work -> error.delivered === true -> work and inflight STAY intact!
  failEnsureFor = undefined
  const origFlush = ctx.sessions.flush
  let failFlushFor = 'dm-b'
  ctx.sessions.flush = async (session) => {
    if (session?.id === failFlushFor) throw new Error('disk flush failed')
    return origFlush(session)
  }
  await assert.rejects(() => tool('delegate_work', { to: 'Writer', goal: 'enqueued then flush fails' }, 'dm-a'), /disk flush failed/)
  assert.equal(Object.keys(rt.state.works).length, 1, 'post-enqueue flush failure must keep work open')
  assert.equal(rt.unreadOf('dm-b').length, 1, 'post-enqueue flush failure must keep inflight entry')
  failFlushFor = undefined

  // 3) Pre-enqueue failure in ask_back rolls back state/rounds/question + forgets inflight.
  const [workId] = Object.keys(rt.state.works)
  const req = agents.get('dm-b').calls.at(-1)[1]
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: req.content, source: req.source })
  failEnsureFor = 'dm-a'
  await assert.rejects(() => tool('ask_back', { question: 'Need info?' }, 'dm-b'), /capability mount failed/)
  assert.equal(rt.state.works[workId].state, 'open', 'failed ask_back must roll back state to open')
  assert.equal(rt.state.works[workId].rounds, 0, 'failed ask_back must roll back rounds')
  assert.equal(rt.state.works[workId].question, undefined, 'failed ask_back must clear question')
  assert.equal(rt.unreadOf('dm-a').length, 0, 'failed ask_back must forget inflight delivery')

  // Now let ask_back succeed so we can test answer_work pre-enqueue rollback.
  failEnsureFor = undefined
  await tool('ask_back', { question: 'Need info?' }, 'dm-b')
  assert.equal(rt.state.works[workId].state, 'need_input')
  const askMsg = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: askMsg.content, source: askMsg.source })

  failEnsureFor = 'dm-b'
  await assert.rejects(() => tool('answer_work', { answer: 'Use prod' }, 'dm-a'), /capability mount failed/)
  assert.equal(rt.state.works[workId].state, 'need_input', 'failed answer_work must roll back state to need_input')
  assert.equal(rt.state.works[workId].question, 'Need info?', 'failed answer_work must preserve question')
  assert.equal(rt.unreadOf('dm-b').filter(d => d.role === 'answer').length, 0, 'failed answer_work must forget inflight delivery')
  failEnsureFor = undefined

  // 4) Pre-enqueue failure on resumePausedWork: foreground delegate, spawnInBackground (reuseWork: true), and ask_back.
  // 4a) Foreground paused delegate rollback.
  rt.openWork('w-paused-fg', {
    from: 'a',
    to: 'b',
    goal: 'resume fg work',
    state: 'paused',
    paused: { reason: 'idle_loop', kind: 'delegate', text: 'resume fg work', when: 'now', bounces: 2, at: Date.now() },
  })
  rt.state.works['w-paused-fg'].rounds = 2
  failEnsureFor = 'dm-b'
  await assert.rejects(() => rt.resumePausedWork('w-paused-fg'), /capability mount failed/)
  assert.equal(rt.state.works['w-paused-fg'].state, 'paused', 'foreground resumePausedWork failure must restore paused state')
  assert.equal(rt.state.works['w-paused-fg'].paused?.kind, 'delegate', 'foreground resumePausedWork failure must restore paused payload')
  assert.equal(rt.state.works['w-paused-fg'].rounds, 2, 'foreground resumePausedWork failure must restore rounds')
  assert.equal(rt.unreadOf('dm-b').some(d => d.exchangeId === 'w-paused-fg'), false)
  failEnsureFor = undefined

  // 4b) spawnInBackground (reuseWork: true) rollback: must NOT close/delete paused work, must roll back toSession/toTaskId, and must NOT send failure reply to caller!
  // Also prove startup reconcileOrphanWorks() running concurrently during the openTaskPart/rollback await window never closes the work.
  rt.openWork('w-paused-bg', {
    from: 'a',
    to: 'b',
    goal: 'resume bg work',
    state: 'paused',
    paused: { reason: 'idle_loop', kind: 'delegate', text: 'resume bg work', when: 'now', bounces: 2, at: Date.now() },
  })
  rt.state.works['w-paused-bg'].rounds = 2
  // Writer's foreground is busy running a tool -> resumePausedWork takes spawnInBackground = true -> spawnBotHandoffTask({ reuseWork: true }).
  emit('dm-b', 'tool/call', { callId: 'busy-1', name: 'bash', arguments: '{}' })
  const chiefCallsBeforeBgRollback = agents.get('dm-a').calls.length
  let hitBgTaskSid
  let orphanSweepRanMidDispatch = false
  const origOpenTaskPart = rt.openTaskPart
  rt.openTaskPart = async (...args) => {
    // Exercise the exact race window where work.state is already 'open' before any
    // task exists in target.tasks and before any inflight delivery is recorded.
    await rt.reconcileOrphanWorks()
    orphanSweepRanMidDispatch = true
    return origOpenTaskPart(...args)
  }
  rt.ensureCapabilities = async (sid) => {
    if (sid.startsWith('created-') || sid.startsWith('fork-')) {
      hitBgTaskSid = sid
      throw new Error('task capability mount failed')
    }
    return origEnsure(sid)
  }
  await assert.rejects(() => rt.resumePausedWork('w-paused-bg'), /task capability mount failed/)
  rt.openTaskPart = origOpenTaskPart
  rt.ensureCapabilities = origEnsure
  assert.equal(orphanSweepRanMidDispatch, true, 'test must exercise concurrent reconcileOrphanWorks during dispatch')
  assert.ok(hitBgTaskSid, 'resumePausedWork must have entered spawnBotHandoffTask({ reuseWork: true })')
  assert.ok(rt.state.works['w-paused-bg'], 'spawnInBackground reuseWork rollback must keep work in state.works')
  assert.equal(rt.state.works['w-paused-bg'].state, 'paused', 'spawnInBackground reuseWork rollback must restore paused state')
  assert.equal(rt.state.works['w-paused-bg'].paused?.kind, 'delegate', 'spawnInBackground reuseWork rollback must keep paused payload')
  assert.equal(rt.state.works['w-paused-bg'].toSession, undefined, 'spawnInBackground reuseWork rollback must clear toSession')
  assert.equal(rt.state.works['w-paused-bg'].toTaskId, undefined, 'spawnInBackground reuseWork rollback must clear toTaskId')
  assert.equal(rt.state.works['w-paused-bg'].rounds, 2, 'spawnInBackground reuseWork rollback must restore rounds')
  assert.equal(agents.get('dm-a').calls.length, chiefCallsBeforeBgRollback, 'spawnInBackground reuseWork rollback must NOT send failure reply to caller')
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // 4c) Paused ask_back resume rollback.
  rt.openWork('w-paused-ask', {
    from: 'a',
    to: 'b',
    goal: 'paused ask work',
    state: 'paused',
    paused: { reason: 'ask_back_limit', kind: 'ask_back', question: 'Confirm deploy?', text: 'Confirm deploy?', rounds: 2, at: Date.now() },
  })
  rt.state.works['w-paused-ask'].rounds = 2
  rt.ensureCapabilities = async (sid) => {
    if (sid === 'dm-a') throw new Error('caller capability mount failed')
    return origEnsure(sid)
  }
  await assert.rejects(() => rt.resumePausedWork('w-paused-ask'), /caller capability mount failed/)
  rt.ensureCapabilities = origEnsure
  assert.equal(rt.state.works['w-paused-ask'].state, 'paused', 'ask_back resumePausedWork rollback must restore paused state')
  assert.equal(rt.state.works['w-paused-ask'].paused?.kind, 'ask_back')
  assert.equal(rt.state.works['w-paused-ask'].question, undefined)
  assert.equal(rt.state.works['w-paused-ask'].rounds, 2)

  // 5) Pre-enqueue failure on merged unread delegation (joins === true): must restore earlier.message and unread tracking!
  rt.dropWork('w-paused-fg')
  rt.dropWork('w-paused-bg')
  rt.dropWork('w-paused-ask')
  const writerAgent = agents.get('dm-b')
  writerAgent.inbox.nextStep.length = 0
  writerAgent.inbox.nextTurn.length = 0
  await tool('delegate_work', { to: 'Writer', goal: 'original unread task', when: 'queue' }, 'dm-a')
  const originalMsg = writerAgent.inbox.nextTurn.at(-1)
  assert.ok(originalMsg, 'first delegation sits unread in nextTurn')
  const joinedExchangeId = originalMsg.source.exchangeId
  rt.ensureCapabilities = async (sid) => {
    if (sid === 'dm-b') throw new Error('merge capability mount failed')
    return origEnsure(sid)
  }
  await assert.rejects(() => tool('delegate_work', { to: 'Writer', goal: 'second task trying to merge', when: 'queue' }, 'dm-a'), /merge capability mount failed/)
  rt.ensureCapabilities = origEnsure
  assert.ok(rt.state.works[joinedExchangeId], 'failed merge must keep original work open')
  assert.ok(
    [...writerAgent.inbox.nextStep, ...writerAgent.inbox.nextTurn].some(m => m.source?.exchangeId === joinedExchangeId && textOf(m.content).includes('original unread task')),
    'failed merge (joins === true) must restore original unread message back into agent.inbox',
  )
  assert.ok(
    rt.unreadOf('dm-b').some(d => d.exchangeId === joinedExchangeId && d.text.includes('original unread task')),
    'failed merge (joins === true) must restore original delivery tracking in resume.js',
  )
})

test('F3 (real ReactLoopAgent): fast answer_work before ask_back turn/end does NOT prematurely close work and delivers real answer on Turn 2', async (t) => {
  let writerStep = 0
  let rig
  const deliveredToChief = []

  rig = await createRealAgentRig(t, {
    async *streamHandler(options) {
      const allText = options.messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
      if (options.sessionId === 'dm-b') {
        writerStep += 1
        if (writerStep === 1) {
          // Turn 1: Writer calls ask_back.
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: 'call_ask', name: 'ask_back', argumentsDelta: '{"question":"Which env?"}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_ask', name: 'ask_back', arguments: '{"question":"Which env?"}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        // Turn 2 (after concludeTurn + fast answer_work): Writer sees "staging" and returns the real final answer.
        assert.ok(options.messages.some(m => textOf(m.content).includes('staging')), 'Turn 2 must see Chief answer')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Deployed to staging successfully.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Deployed to staging successfully.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (options.sessionId === 'dm-a') {
        deliveredToChief.push(allText)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '[PASS]' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '[PASS]' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  })

  // Intercept Chief receiving ask_back and IMMEDIATELY invoke answer_work BEFORE Writer's Turn 1 ends!
  const origDeliver = rig.rt.deliver
  rig.rt.deliver = async (args) => {
    const out = await origDeliver(args)
    if (args.role === 'ask_back' && args.toId === 'a') {
      await rig.tool('answer_work', { work_id: args.askWork, answer: 'staging' }, 'dm-a')
    }
    return out
  }

  await rig.tool('delegate_work', { to: 'Writer', goal: 'deploy service' }, 'dm-a')

  await settle(() => Object.keys(rig.rt.state.works).length === 0 && writerStep >= 2, 5000, 'Writer must complete Turn 2 and close work')
  await settle(() => deliveredToChief.some(t => t.includes('Deployed to staging successfully.')), 4000, 'Chief must receive the real Turn 2 final answer')

  assert.equal(writerStep, 2, 'concludeTurn must stop Turn 1 after ask_back and resume on Turn 2')
  const replyEvents = rig.agents.get('dm-a').session.snapshotEvents()
    .filter(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply')
  assert.equal(replyEvents.length, 1, 'Chief must receive exactly ONE closing reply, never a premature Turn 1 reply')
  assert.match(textOf(replyEvents[0].data.content), /Deployed to staging successfully\./)
})

test('F5: handleTurnEnd does not prematurely settle task_start when inbox follow-up or deferred joined request is pending', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t)

  // Case A: deliverToTask(..., { steer: false }) queues a follow-up in agent.inbox.nextTurn.
  await tool('task_start', { title: 'Multi-step job', brief: 'Step 1' }, 'dm-a')
  const task = rt.botOf('a').tasks[0]
  const taskAgent = agents.get(task.sessionId)
  taskAgent.inbox.nextTurn.length = 0
  emit(task.sessionId, 'turn/start', { turn: 1 })
  emit(task.sessionId, 'user/message', { content: textBlock('Step 1'), source: { kind: SOURCE_KIND, role: 'task', taskId: task.id, exchangeId: 'open-1' } })
  await rt.deliverToTask(task.id, { text: 'Step 2 follow-up', steer: false })
  emit(task.sessionId, 'assistant/message', assistantText('Step 1 done'))
  emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await realDelay(40)

  assert.equal(task.status, 'running', 'task must NOT settle while a queued follow-up sits in inbox/unreadOf')
  assert.equal(agents.get('dm-a').calls.some(([, m]) => m?.source?.role === 'task-report'), false)

  // Now clear inbox + read follow-up in Turn 2 -> task settles cleanly.
  const followMsg = taskAgent.inbox.nextTurn.shift()
  emit(task.sessionId, 'turn/start', { turn: 2 })
  emit(task.sessionId, 'user/message', { content: followMsg.content, source: followMsg.source })
  emit(task.sessionId, 'assistant/message', assistantText('Step 2 done'))
  emit(task.sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => task.status === 'completed', 2000, 'task must settle once Turn 2 drains inbox')

  // Case B: deferred joined peer request queued at Turn 1 turn/end keeps task active.
  await tool('task_start', { title: 'Joined peer job', brief: 'Primary' }, 'dm-a')
  const task2 = rt.botOf('a').tasks.at(-1)
  const task2Agent = agents.get(task2.sessionId)
  task2Agent.inbox.nextTurn.length = 0
  emit(task2.sessionId, 'turn/start', { turn: 1 })
  emit(task2.sessionId, 'user/message', { content: textBlock('Primary'), source: { kind: SOURCE_KIND, role: 'task', taskId: task2.id, exchangeId: 'open-2' } })
  emit(task2.sessionId, 'user/message', {
    content: textBlock('[Work from Writer]\nCheck extra file'),
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'joined-1', senderSessionId: 'b', senderName: 'Writer' },
  })
  emit(task2.sessionId, 'assistant/message', assistantText('Primary done'))
  emit(task2.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await realDelay(40)

  assert.equal(task2.status, 'running', 'task must NOT settle while a deferred joined request is queued')
})

test('F8: worked propagates up 3-Bot chain, task_start sub-work, and group report-back; pure-LLM 0-work chain still pauses', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t, {
    team: makeTeam({
      rooms: {
        r1: {
          id: 'r1',
          name: 'Dev Group',
          mode: 'everyone',
          members: ['b', 'c'],
          sessionId: 'room-r1',
          sessions: { b: 'room-r1-b', c: 'room-r1-c' },
          seq: 0,
          createdAt: 1,
        },
      },
    }),
  })

  // 1) 3-Bot chain: Chief -> Writer (0 own work tools) -> Reviewer (runs bash) x3 -> NEVER false idle_loop!
  for (let i = 1; i <= 3; i += 1) {
    const out = await tool('delegate_work', { to: 'Writer', goal: `coordinate task ${i}` }, 'dm-a')
    assert.match(out, /^Delegated work #W/, `round ${i} must not pause as idle_loop`)
    const reqW = agents.get('dm-b').calls.at(-1)[1]
    emit('dm-b', 'turn/start', { turn: i * 10 + 1 })
    emit('dm-b', 'user/message', { content: reqW.content, source: reqW.source })
    await tool('delegate_work', { to: 'Reviewer', goal: `execute bash ${i}` }, 'dm-b')
    const reqR = agents.get('dm-c').calls.at(-1)[1]
    emit('dm-b', 'turn/end', { turn: i * 10 + 1, reason: { kind: 'completed' } })

    // Reviewer runs a real work tool (`bash`) and returns to Writer.
    emit('dm-c', 'turn/start', { turn: i })
    emit('dm-c', 'user/message', { content: reqR.content, source: reqR.source })
    emit('dm-c', 'tool/call', { callId: `c${i}`, name: 'bash', arguments: '{"command":"ls"}' })
    emit('dm-c', 'tool/result', { callId: `c${i}` })
    emit('dm-c', 'assistant/message', assistantText(`bash output ${i}`))
    emit('dm-c', 'turn/end', { turn: i, reason: { kind: 'completed' } })
    await settle(() => agents.get('dm-b').calls.some(([, m]) => m?.source?.replyTo === reqR.source.exchangeId))

    // Writer's parent work MUST now have worked === true propagated from Reviewer!
    assert.equal(rt.state.works[reqW.source.exchangeId].worked, true, 'worked must propagate from Reviewer to Writer work')

    const repR = agents.get('dm-b').calls.at(-1)[1]
    emit('dm-b', 'turn/start', { turn: i * 10 + 2 })
    emit('dm-b', 'user/message', { content: repR.content, source: repR.source })
    emit('dm-b', 'assistant/message', assistantText(`summary ${i}`))
    emit('dm-b', 'turn/end', { turn: i * 10 + 2, reason: { kind: 'completed' } })
    await settle(() => rt.state.works[reqW.source.exchangeId] === undefined)
  }

  // 2) task_start sub-work propagates worked up to parent work.
  emit('dm-a', 'turn/start', { turn: 90 })
  emit('dm-a', 'user/message', { content: textBlock('reset pair loops'), source: { kind: 'user' } })
  emit('dm-a', 'turn/end', { turn: 90, reason: { kind: 'completed' } })
  await tool('delegate_work', { to: 'Writer', goal: 'delegate via task' }, 'dm-a')
  const reqT = agents.get('dm-b').calls.at(-1)[1]
  emit('dm-b', 'turn/start', { turn: 50 })
  emit('dm-b', 'user/message', { content: reqT.content, source: reqT.source })
  await tool('task_start', { title: 'Worker task', brief: 'Run tool' }, 'dm-b')
  const bgTask = rt.botOf('b').tasks.at(-1)
  emit('dm-b', 'turn/end', { turn: 50, reason: { kind: 'completed' } })

  const bgAgent = agents.get(bgTask.sessionId)
  bgAgent.inbox.nextTurn.length = 0
  emit(bgTask.sessionId, 'turn/start', { turn: 1 })
  emit(bgTask.sessionId, 'user/message', { content: textBlock('Run tool'), source: { kind: SOURCE_KIND, role: 'task', taskId: bgTask.id, exchangeId: 'open-t' } })
  emit(bgTask.sessionId, 'tool/call', { callId: 't1', name: 'bash', arguments: '{"command":"pwd"}' })
  emit(bgTask.sessionId, 'tool/result', { callId: 't1' })
  emit(bgTask.sessionId, 'assistant/message', assistantText('task worked'))
  emit(bgTask.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => bgTask.status === 'completed')
  assert.equal(rt.state.works[reqT.source.exchangeId].worked, true, 'worked must propagate from task_start sub-work to parent work')

  // 3) Group report-back propagates worked up to parent work via room-reports.
  rt.openWork('w-group-parent', { from: 'a', to: 'b' })
  rt.openWork('w-group-sub', { from: 'b', room: 'r1', parent: 'w-group-parent' })
  rt.state.roomReports = {
    'w-group-sub': { id: 'w-group-sub', roomId: 'r1', botId: 'b', name: 'Writer', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: Date.now(), sub: 'w-group-sub' },
  }
  rt.markRoomReportsWorked('r1', 'c')
  assert.equal(rt.state.roomReports['w-group-sub'].worked, true)
  await rt.settleRoomReports('r1')
  assert.equal(rt.state.works['w-group-parent'].worked, true, 'worked must propagate from group report-back to parent work')

  // 4) Pure-LLM 0-work chain (no work tools anywhere) STILL pauses at idle_loop!
  rt.dropWork('w-group-parent')
  rt.dropWork(reqT.source.exchangeId)
  rt.resetBotLoops('a')
  rt.resetBotLoops('b')
  rt.resetBotLoops('c')
  const goal = '收到，收工吧'
  await tool('delegate_work', { to: 'Writer', goal }, 'dm-a')
  const zeroW = agents.get('dm-b').calls.findLast(([, message]) => message?.source?.role === 'request' && textOf(message.content).endsWith(goal))?.[1]
  assert.ok(zeroW, 'Writer received the zero-work request')
  emit('dm-b', 'turn/start', { turn: 80 })
  emit('dm-b', 'user/message', { content: zeroW.content, source: zeroW.source })
  emit('dm-b', 'assistant/message', assistantText('收到，已收工。'))
  emit('dm-b', 'turn/end', { turn: 80, reason: { kind: 'completed' } })
  await settle(() => rt.state.works[zeroW.source.exchangeId] === undefined)

  const bounce = await tool('delegate_work', { to: 'Writer', goal: '好。' }, 'dm-a')
  assert.match(bounce, /^Paused work #W.*before waking Writer/, 'pure-LLM 0-work ping-pong must still pause')
})

test('Empirical #1 (real ReactLoopAgent): preStep hard error (info === undefined) and BLOCKING_CODES settle claimed & queued leaf works', async (t) => {
  let mode = 'prestep'
  const quotaEntered = Promise.withResolvers()
  const quotaRelease = Promise.withResolvers()
  const rig = await createRealAgentRig(t, {
    async preStepHook(payload, next) {
      if (mode === 'prestep' && payload.agent?.id === 'dm-b') {
        throw new LlmError('CLI binary not found', 'LOCAL_AGENT_MISSING')
      }
      return next()
    },
    async *streamHandler(options) {
      if (mode === 'quota' && options.sessionId === 'dm-b') {
        quotaEntered.resolve()
        await quotaRelease.promise
        throw new LlmError('quota exhausted', 'LOCAL_AGENT_QUOTA')
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // Case 1: preStep throws LOCAL_AGENT_MISSING before user/message is logged (entry.info === undefined).
  await rig.tool('delegate_work', { to: 'Writer', goal: 'run cli task' }, 'dm-a')
  await settle(() => Object.keys(rig.rt.state.works).length === 0, 4000, 'preStep error must settle claimed leaf work')
  await settle(() => {
    const events = rig.agents.get('dm-a').session.snapshotEvents()
    return events.some(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply' && textOf(ev.data?.content).includes('LOCAL_AGENT_MISSING'))
  }, 4000, 'Chief must receive failure notice for preStep-errored work')

  // Case 2: Turn fails with BLOCKING_CODES (LOCAL_AGENT_QUOTA) while another peer request AND a user-facing message sit in nextTurn.
  mode = 'quota'
  const dmB = rig.agents.get('dm-b')
  const userFacingQueued = createUserMessage({
    content: textBlock('[Work from Chief]\nAnswer user directly'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', audience: 'user', exchangeId: 'w-user-facing', senderSessionId: 'a', senderName: 'Chief' },
  })
  // Start a turn on dm-b (paused inside streamHandler) so we can deterministically queue both a peer work and a user-facing message before the quota failure.
  await rig.tool('delegate_work', { to: 'Writer', goal: 'first failing work', when: 'queue' }, 'dm-a')
  await quotaEntered.promise
  rig.rt.openWork('w-queued-2', { from: 'c', to: 'b', goal: 'queued work 2' })
  dmB.inbox.append('next-turn', createUserMessage({
    content: textBlock('[Work from Reviewer]\nqueued work 2'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'w-queued-2', senderSessionId: 'c', senderName: 'Reviewer' },
  }))
  dmB.inbox.append('next-turn', userFacingQueued)
  quotaRelease.resolve()

  await settle(() => rig.rt.state.works['w-queued-2'] === undefined, 4000, 'BLOCKING_CODES must settle queued peer work')
  await settle(() => {
    const events = rig.agents.get('dm-c').session.snapshotEvents()
    return events.some(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply' && textOf(ev.data?.content).includes('LOCAL_AGENT_QUOTA'))
  }, 4000, 'Reviewer must receive LOCAL_AGENT_QUOTA failure notice for queued peer work')
  await realDelay(30)
  assert.equal(dmB.inbox.nextTurn.some(m => m.source?.exchangeId === 'w-queued-2'), false, 'settled peer work must be removed from blocked inbox')
  assert.equal(dmB.inbox.nextTurn.some(m => m.id === userFacingQueued.id), true, 'user-facing message must stay untouched in inbox')
})

test('Empirical #2 & ctx-arch P1-5: lightweight inheritedSegments without segment.note, task_start read_own_chat recall, and structured handoff/checkpoint fallbackContextSummary', async (t) => {
  const bigNote1 = 'Handoff note 1 '.repeat(400)
  const bigNote2 = 'Handoff note 2 '.repeat(400)
  const { rt, agents, emit, tool } = await startHost(t, {
    team: makeTeam({
      bots: {
        a: {
          id: 'a',
          name: 'Chief',
          role: 'Boss',
          sessionId: 'dm-a',
          createdAt: 1,
          segments: [
            { sessionId: 'dm-a-p1', endedAt: 100, note: bigNote1 },
            { sessionId: 'dm-a-p2', endedAt: 200, note: bigNote2 },
          ],
        },
        b: {
          id: 'b',
          name: 'Writer',
          role: 'Dev',
          sessionId: 'dm-b',
          createdAt: 2,
          segments: [{ sessionId: 'dm-b-p1', endedAt: 50, note: bigNote1 }],
        },
      },
    }),
    // Force non-forked fallback so fallbackContextSummary runs on startTask.
    forkImpl: async () => { throw new Error('fork unavailable') },
    pageEvents: {
      'dm-a-p1': [
        { type: 'user/message', seq: 1, time: 10, data: { source: { kind: 'user' }, content: textBlock('Remember the secret codename ALBATROSS-99 for deployment.') } },
        { type: 'assistant/message', seq: 2, time: 11, data: { message: { role: 'assistant', content: textBlock('Noted ALBATROSS-99.') } } },
      ],
    },
  })

  // Seed dm-a with a 3,500-char [Handoff · part 3] package whose ## Decisions / ## Open work sit past char 1,000,
  // plus a recent user/assistant exchange.
  const longHandoff = [
    '[Handoff · part 3]',
    'DS Bot moved your own chat with the user on to a fresh conversation, part 3, because the previous part grew long. This message is not from the user.',
    'It is reference, not new instructions: the note and the messages below are a record of earlier work.',
    '',
    '## Handoff note',
    '## Goal',
    `- ${'Context detail '.repeat(80)}`,
    '## Decisions',
    '- Preserve structured handoff notes across non-fork task starts.',
    '## Open work',
    '- Finish PR-3 contract verification.',
  ].join('\n')
  assert.ok(longHandoff.indexOf('## Decisions') > 1000, '## Decisions must sit past the old 1,000-char clip limit')

  emit('dm-a', 'user/message', { content: textBlock(longHandoff), source: { kind: SOURCE_KIND, role: 'handoff', handoff: true } })
  emit('dm-a', 'user/message', { content: textBlock('Now run the migration task.'), source: { kind: 'user' } })

  await tool('task_start', { title: 'Migration', brief: 'Apply schema updates' }, 'dm-a')
  const task1 = rt.botOf('a').tasks[0]

  // 1) Lightweight inheritedSegments: keeps sessionId + endedAt, strips multi-KB note,
  // and for non-forked own-chat task_start appends a branch-bounded ref to the live parent foreground part.
  assert.deepEqual(task1.inheritedSegments, [
    { sessionId: 'dm-a-p1', endedAt: 100 },
    { sessionId: 'dm-a-p2', endedAt: 200 },
    { sessionId: 'dm-a', throughSeq: 2 },
  ])
  assert.equal('note' in task1.inheritedSegments[0], false, 'inheritedSegments must not clone segment.note')

  // 2) task_start task can search earlier parts AND the parent foreground part AND read part summaries via read_own_chat!
  assert.deepEqual(rt.partsOfThread('a', task1.sessionId).map(p => p.sessionId), ['dm-a-p1', 'dm-a-p2', 'dm-a', task1.sessionId])
  const found = await tool('read_own_chat', { query: 'ALBATROSS-99' }, task1.sessionId)
  assert.match(found, /ALBATROSS-99/, 'task_start task must find messages from earlier foreground parts via read_own_chat')
  const part1 = await tool('read_own_chat', { part: 1 }, task1.sessionId)
  assert.match(part1, /Handoff note 1/, 'read_own_chat({ part: 1 }) inside background task must hydrate segment.note from bot.segments')
  assert.doesNotMatch(part1, /context overflow/, 'read_own_chat({ part: 1 }) must not fall back to overflow placeholder')
  const openParentPart = await tool('read_own_chat', { part: 3 }, task1.sessionId)
  assert.match(openParentPart, /still open and has no closing handoff note yet/)

  // 3) fallbackContextSummary preserves structured ## Decisions / ## Open work headings with newlines past 1,000 chars!
  const taskPrompt = textOf(agents.get(task1.sessionId).calls[0][1].content)
  assert.match(taskPrompt, /## Handoff note\n## Goal/)
  assert.match(taskPrompt, /## Decisions\n- Preserve structured handoff notes across non-fork task starts\./)
  assert.match(taskPrompt, /## Open work\n- Finish PR-3 contract verification\./)
  assert.match(taskPrompt, /User: Now run the migration task\./)

  // 4) fallbackContextSummary handles real DSH compaction/summary TextBlock[] and skips paired compact-checkpoint replacement user/message!
  emit('dm-b', 'compaction/summary', {
    compactionId: 'cmp-1',
    summary: [{ type: 'text', text: '[Checkpoint 1]\n## Decisions\n- Keep API v2 compatibility intact.' }],
    shadowedRange: { start: 1, end: 1 },
  })
  emit('dm-b', 'user/message', {
    content: textBlock('This is an automatically generated checkpoint summarizing earlier conversation.'),
    source: { kind: 'compact-checkpoint', compactionId: 'cmp-1' },
  })
  emit('dm-b', 'user/message', { content: textBlock('Check v2 tests'), source: { kind: 'user' } })
  await tool('task_start', { title: 'Check v2', brief: 'Run API tests' }, 'dm-b')
  const taskB = rt.botOf('b').tasks[0]
  assert.deepEqual(taskB.inheritedSegments, [{ sessionId: 'dm-b-p1', endedAt: 50 }, { sessionId: 'dm-b', throughSeq: 6 }])
  const promptB = textOf(agents.get(taskB.sessionId).calls[0][1].content)
  assert.match(promptB, /\[Checkpoint 1\]\n## Decisions\n- Keep API v2 compatibility intact\./)
  assert.doesNotMatch(promptB, /\[object Object\]/, 'TextBlock[] compaction/summary must never stringify to [object Object]')
  assert.doesNotMatch(promptB, /automatically generated checkpoint/, 'paired compact-checkpoint user/message must not leak into transcript lines')
  assert.match(promptB, /User: Check v2 tests/)

  // 5) handoffForeground and spawnBotHandoffTask also store lightweight inheritedSegments without note.
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await tool('delegate_work', { to: 'Writer', goal: 'bg work with slim segments' }, 'dm-a')
  const botHandoffTask = rt.botOf('b').tasks.find(item => item.origin === 'bot-handoff')
  assert.deepEqual(botHandoffTask.inheritedSegments, [{ sessionId: 'dm-b-p1', endedAt: 50 }])
})

test('P1 #3 (real ReactLoopAgent): non-waking agent.inject()/note_bot in inbox.nextStep does NOT deadlock background task settlement or restart reconciliation', async (t) => {
  const rig = await createRealAgentRig(t, {
    async *streamHandler(options) {
      if (options.sessionId === 'dm-a') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Noted.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Noted.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // Background task session finishes cleanly.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Background job finished cleanly.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Background job finished cleanly.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  await rig.tool('task_start', { title: 'Audit job', brief: 'Run quick audit' }, 'dm-a')
  const task = rig.rt.botOf('a').tasks[0]
  const taskAgent = rig.agents.get(task.sessionId)
  // Inject a silent note directly into the real ReactLoopAgent while it runs (or right before turn/end),
  // mirroring note_bot/flushSilentNotes calling agent.inject() -> inbox.nextStep with wake=false.
  await rig.rt.deliver({
    fromId: 'b',
    toId: 'a',
    sessionId: task.sessionId,
    text: 'FYI: build server restarted earlier.',
    role: 'note',
    wake: false,
  })
  await settle(() => task.status === 'completed', 5000, 'task with silent note in inbox.nextStep must settle to completed, never deadlock')
  assert.equal(task.status, 'completed')

  // Also verify reconcileTasksAfterRestart settles an idle task holding ONLY a non-waking agent.inject() message.
  const idleTask = {
    id: 'k_idle_inject',
    title: 'Stale injected task',
    brief: 'Interrupted task',
    from: 'dm-a',
    sessionId: task.sessionId,
    segments: [],
    origin: 'task-start',
    status: 'running',
    startedAt: Date.now() - 5000,
    updatedAt: Date.now() - 5000,
  }
  rig.rt.botOf('a').tasks.push(idleTask)
  rig.rt.taskOwners.set(task.sessionId, { botId: 'a', taskId: idleTask.id })
  taskAgent.inject(createUserMessage({
    content: textBlock('[Note from Writer · FYI only, no reply needed]\nQuiet note'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'note', silent: true, exchangeId: 'note-restart-1' },
  }))
  assert.ok(taskAgent.inbox.nextStep.length >= 1, 'real ReactLoopAgent.inject() must populate inbox.nextStep while idle')
  assert.equal(taskAgent.status, 'idle', 'real ReactLoopAgent.inject() must not wake idle driver')
  await rig.rt.reconcileTasksAfterRestart(new Set())
  assert.equal(idleTask.status, 'interrupted', 'reconcileTasksAfterRestart must not hang on non-waking inbox.nextStep messages')
})

test('P1 #6: user-started background task (parent === undefined) wakes on abandonWork, reconcileLostWorks, and deleted-target paused work in forgetBot', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t, {
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
        b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
        c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
      },
    }),
  })

  // Start a user-initiated background task on Chief (parent === undefined for its delegations).
  await tool('task_start', { title: 'Release check', brief: 'Coordinate with Writer and Reviewer' }, 'dm-a')
  const task = rt.botOf('a').tasks[0]
  const taskAgent = agents.get(task.sessionId)
  taskAgent.inbox.nextTurn.length = 0
  taskAgent.inbox.nextStep.length = 0

  // 1) abandonWork wakes user-started background task when parent === undefined.
  emit(task.sessionId, 'turn/start', { turn: 1 })
  emit(task.sessionId, 'user/message', { content: textBlock('delegate to Writer'), source: { kind: SOURCE_KIND, role: 'task', taskId: task.id } })
  await tool('delegate_work', { to: 'Writer', goal: 'check changelog' }, task.sessionId)
  const [w1] = Object.keys(rt.state.works)
  assert.equal(rt.state.works[w1].parent, undefined)
  emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task.status === 'waiting_work', 1000)
  const callsBeforeAbandon = taskAgent.calls.length
  assert.equal(rt.abandonWork(w1), true, 'abandonWork must accept top-level work owned by an active task thread')
  assert.equal(rt.state.works[w1], undefined)
  await settle(() => taskAgent.calls.length > callsBeforeAbandon, 1000, 'abandonWork must wake waiting background task')
  assert.equal(taskAgent.calls.at(-1)[1].source.abandoned, true)

  // 2) forgetBot wakes user-started background task when a paused work's target Bot is deleted.
  rt.openWork('w-del-paused', {
    from: 'a', to: 'c', fromPart: task.sessionId, goal: 'paused on Reviewer', state: 'paused',
    paused: { reason: 'idle_loop', kind: 'delegate', text: 'paused on Reviewer', at: Date.now() },
  })
  const callsBeforeForget = taskAgent.calls.length
  await rt.deleteBot('c')
  assert.equal(rt.state.works['w-del-paused'], undefined)
  await settle(() => taskAgent.calls.length > callsBeforeForget, 1000, 'forgetBot must wake waiting task when paused work target is deleted')

  // 3) Startup reconcileLostWorks wakes user-started background task when target Bot is gone (both open and paused).
  const seeded = makeTeam({
    bots: {
      a: {
        id: 'a',
        name: 'Chief',
        role: 'Boss',
        sessionId: 'dm-a',
        createdAt: 1,
        tasks: [{
          id: 'k_wait1',
          title: 'Release check',
          brief: 'Waiting on deleted teammate',
          from: 'dm-a',
          sessionId: 'task-wait-1',
          segments: [],
          origin: 'task-start',
          status: 'waiting_work',
          startedAt: 10,
          updatedAt: 10,
        }],
      },
    },
    works: {
      'w-lost-open': { from: 'a', to: 'ghost-bot', fromPart: 'task-wait-1', open: [], results: [], at: 10 },
      'w-lost-paused': {
        from: 'a', to: 'ghost-bot', fromPart: 'task-wait-1', state: 'paused', open: [], results: [], at: 11,
        paused: { reason: 'idle_loop', kind: 'delegate', text: 'lost paused', at: 11 },
      },
    },
  })
  const restarted = await startHost(t, { team: seeded })
  await settle(
    () => restarted.rt.state.works['w-lost-open'] === undefined
      && restarted.rt.state.works['w-lost-paused'] === undefined
      && (restarted.agents.get('task-wait-1')?.calls.length ?? 0) >= 2,
    2000,
    'startup reconcileLostWorks must abandon both open and paused works for deleted targets and wake waiting task',
  )
  assert.equal(restarted.agents.get('task-wait-1').calls.filter(([, m]) => m.source?.abandoned === true).length, 2)
})

test('P2 #1: fast answer_work crossing actual Turn 1 -> Turn 2 boundary on bot-handoff task preserves work and waits without premature close', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t)

  // Writer foreground is busy running a tool -> Chief delegation spawns a bot-handoff task.
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'tool/call', { callId: 'fg-1', name: 'bash', arguments: '{}' })
  await tool('delegate_work', { to: 'Writer', goal: 'deploy artifact' }, 'dm-a')
  const task = rt.botOf('b').tasks.find(item => item.origin === 'bot-handoff')
  const taskAgent = agents.get(task.sessionId)
  const reqMsg = taskAgent.calls[0][1]
  const workId = reqMsg.source.exchangeId
  taskAgent.inbox.nextTurn.length = 0
  taskAgent.inbox.nextStep.length = 0

  // Turn 1 starts on the bot-handoff task and calls ask_back.
  emit(task.sessionId, 'turn/start', { turn: 1 })
  emit(task.sessionId, 'user/message', { content: reqMsg.content, source: reqMsg.source })
  await tool('ask_back', { question: 'Which region?' }, task.sessionId)
  const askMsg = agents.get('dm-a').calls.at(-1)[1]

  // Chief immediately answers BEFORE Writer's Turn 1 ends (state transitions back to 'open' while Turn 1 is still ending!).
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: askMsg.content, source: askMsg.source })
  await tool('answer_work', { answer: 'us-west-2' }, 'dm-a')
  assert.equal(rt.workStateOf(workId), 'open', 'work state flipped back to open before Turn 1 ended')
  const answerMsg = taskAgent.calls.at(-1)[1]
  // Simulate the answer sitting unread until Turn 2 (remove from inbox momentarily to isolate the lastAskedBackWork guard!).
  taskAgent.inbox.nextStep.length = 0
  taskAgent.inbox.nextTurn.length = 0
  rt.forgetDelivery?.(answerMsg.source.exchangeId)

  // Turn 1 ends BEFORE Turn 2 claims the answer!
  const chiefCallsBeforeEnd = agents.get('dm-a').calls.length
  emit(task.sessionId, 'assistant/message', { message: { role: 'assistant', content: textBlock('Asking Chief now.') } })
  emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await realDelay(30)

  // turns.js:askedBackWork prevented premature finish(), and bot-tasks.js:lastAskedBackWork kept task in waiting_work!
  assert.equal(agents.get('dm-a').calls.length, chiefCallsBeforeEnd, 'Turn 1 end must NOT prematurely close work to Chief')
  assert.ok(rt.state.works[workId], 'work must remain open across Turn 1 -> Turn 2 boundary')
  assert.equal(task.status, 'waiting_work', 'bot-handoff task must transition to waiting_work, NOT completed')

  // Turn 2 consumes Chief's answer and finishes cleanly -> closes work and settles task!
  emit(task.sessionId, 'turn/start', { turn: 2 })
  emit(task.sessionId, 'user/message', { content: answerMsg.content, source: answerMsg.source })
  emit(task.sessionId, 'assistant/message', { message: { role: 'assistant', content: textBlock('Deployed to us-west-2.') } })
  emit(task.sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => rt.state.works[workId] === undefined && task.status === 'completed' && agents.get('dm-a').calls.length >= chiefCallsBeforeEnd + 1, 2000)
  assert.equal(agents.get('dm-a').calls.length, chiefCallsBeforeEnd + 1)
  assert.match(textOf(agents.get('dm-a').calls.at(-1)[1].content), /Deployed to us-west-2\./)
})
