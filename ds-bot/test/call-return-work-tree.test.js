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

  // Moved work #W1 must record sessionId = 'dm-b' and taskId in coordDb so answer_work / cancel_work route to the background task.
  const movedWork = rig.rt.coordDb.listWorks({ activeOnly: true }).find(w => w.kind === 'task' && w.botId === 'b')
  assert.ok(movedWork, 'moved #W1 must exist in coordDb')
  const workId = movedWork.workId
  assert.equal(movedWork.sessionId, 'dm-b', 'handoffForeground must update work.sessionId to the moved task session')
  assert.ok(movedWork.apiMeta?.taskId, 'handoffForeground must update work.apiMeta.taskId')

  // Release the moved bot-handoff peer turn: its real answer returns to Chief, NOT the user's message.
  peerModelRelease.resolve()
  await settle(() => rig.rt.resolveWork(workId) === undefined, 4000, 'moved #W1 must finish and close')
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
  assert.equal(rt.resolveWork(req1.source.exchangeId)?.work?.toSession, 'dm-b')

  await tool('ask_back', { question: 'Which branch?' }, 'dm-b')
  const askMsg = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: askMsg.content, source: askMsg.source })
  await tool('answer_work', { answer: 'Use dev.' }, 'dm-a')
  emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // End Writer's yielded ask_back Turn 1 so the scheduler dispatches Chief's answer onto Turn 2 in dm-b.
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => agents.get('dm-b').calls.some(([, m]) => m?.source?.role === 'answer' && m.source.work === req1.source.exchangeId), 2000, 'answer_work must route to moved task dm-b')
  assert.equal(agents.get(newFg).calls.some(([, m]) => m?.source?.role === 'answer'), false, 'answer_work must NOT leak into new foreground chat')

  // Close W1 cleanly after consuming Chief's answer to start next sub-scenario.
  const ansMsg = agents.get('dm-b').calls.findLast(([, m]) => m?.source?.role === 'answer')[1]
  emit('dm-b', 'turn/start', { turn: 2 })
  emit('dm-b', 'user/message', { content: ansMsg.content, source: ansMsg.source })
  emit('dm-b', 'assistant/message', assistantText('Patch ready.'))
  emit('dm-b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => rt.resolveWork(req1.source.exchangeId) === undefined)
  // Consume Chief's reply turn on dm-a so fg:a releases its 1:1 claim.
  await settle(() => agents.get('dm-a').calls.some(([, m]) => m?.source?.replyTo === req1.source.exchangeId))
  const w1Rep = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 2 })
  emit('dm-a', 'user/message', { content: w1Rep.content, source: w1Rep.source })
  emit('dm-a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })

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
  assert.equal(rt.resolveWork(task1.workId)?.work?.toSession, task1.sessionId)
  // Writer ends Turn 2 after handing off to background task T1, parking #W2 in waiting on T1
  // so T1 holds the workspace cleanly while #W2 waits for T1's result.
  emit(writerFg, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => (agents.get(task1.sessionId)?.calls?.length ?? 0) >= 1, 2000, 'T1 initial prompt dispatched')
  const t1Init = agents.get(task1.sessionId).calls[0][1]
  emit(task1.sessionId, 'turn/start', { turn: 1 })
  emit(task1.sessionId, 'user/message', { content: t1Init.content, source: t1Init.source })

  // Cycle refusal inside task_start: Chief is upstream via task:T1 -> W2 -> Chief.
  const aCallsBefore = agents.get('dm-a').calls.length
  const cycleRes = await tool('delegate_work', { to: 'Chief', goal: 'please check' }, task1.sessionId)
  assert.match(cycleRes, /Not sent: Chief is waiting for the result/)
  assert.equal(agents.get('dm-a').calls.length, aCallsBefore)

  // Task delegates #W3 to Reviewer; parent is task:T1, then T1 yields Turn 1 into waiting_work.
  await tool('delegate_work', { to: 'Reviewer', goal: 'run smoke tests' }, task1.sessionId)
  const w3Work = rt.coordDb.listWorks({ botId: 'c', activeOnly: true }).find(w => w.parentWorkId === task1.workId)
  assert.ok(w3Work, '#W3 work created with parent task:T1')
  const w3Id = w3Work.workId
  assert.equal(w3Work.parentWorkId, task1.workId)
  emit(task1.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task1.status === 'waiting_work', 2000, 'T1 enters waiting_work after delegating #W3')

  // User cancels #W3 while T1 is idle in waiting_work -> T1 must be woken!
  const t1CallsBefore = agents.get(task1.sessionId).calls.length
  assert.equal(await rt.cancelWorkByUser(w3Id, 'skip smoke'), true)
  await settle(() => agents.get(task1.sessionId).calls.length > t1CallsBefore, 2000, 'T1 must wake when child #W3 is cancelled')
  const wakeMsg = agents.get(task1.sessionId).calls.at(-1)[1]
  assert.equal(wakeMsg.source.role, 'reply')
  assert.equal(wakeMsg.source.coordWorkId, task1.workId)

  // Cancelling parent #W2 must ALSO stop active child task_start task T1!
  await tool('cancel_work', { target: w2Id, reason: 'release postponed' }, 'dm-a')
  assert.equal(rt.coordDb.getWork(task1.workId)?.status, 'stopped', 'cancelling parent work must stop linked task_start coordDb work')

  // 3) User-started task_start (no parent work) delegates #W4 -> external cancel_work wakes task!
  emit(writerFg, 'turn/start', { turn: 3 })
  emit(writerFg, 'user/message', { content: textBlock('Run background check'), source: { kind: 'user' } })
  await tool('task_start', { title: 'User bg check', brief: 'Ask Reviewer' }, writerFg)
  const task2 = rt.botOf('b').tasks.at(-1)
  assert.equal(task2.workId, undefined)
  await settle(() => (agents.get(task2.sessionId)?.calls?.length ?? 0) >= 1, 2000, 'T2 initial prompt dispatched')
  const t2Init = agents.get(task2.sessionId).calls[0][1]
  emit(task2.sessionId, 'turn/start', { turn: 1 })
  emit(task2.sessionId, 'user/message', { content: t2Init.content, source: t2Init.source })
  await tool('delegate_work', { to: 'Reviewer', goal: 'check disk' }, task2.sessionId)
  const w4Work = rt.coordDb.listWorks({ botId: 'c', activeOnly: true }).find(w => w.title === 'check disk')
  assert.ok(w4Work, '#W4 work created')
  const w4Id = w4Work.workId
  emit(task2.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task2.status === 'waiting_work', 2000, 'T2 enters waiting_work after delegating #W4')
  const t2CallsBefore = agents.get(task2.sessionId).calls.length
  assert.equal(await rt.cancelWorkByUser(w4Id, 'no longer needed'), true)
  await settle(() => agents.get(task2.sessionId).calls.length > t2CallsBefore, 2000, 'user-started task must wake when its delegated work is cancelled')

  // 4) Deleting caller Bot aborts target's bot-handoff work/task instead of silently dropping it.
  emit('dm-c', 'turn/start', { turn: 1 })
  emit('dm-c', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await tool('delegate_work', { to: 'Reviewer', goal: 'long job for Chief' }, 'dm-a')
  const reviewerHandoff = rt.botOf('c').tasks.find(item => item.origin === 'bot-handoff' && item.status === 'running')
  assert.ok(reviewerHandoff, 'Reviewer should have a running bot-handoff task')
  await rt.releaseBot('a', ['dm-a'])
  assert.equal(rt.resolveWork(reviewerHandoff.exchangeId), undefined)
})

test('F3 (atomic delivery rollback): pre-enqueue deliver failure rolls back delegate_work; post-enqueue flush failure keeps work open; durable SQLite retries ask_back, answer_work, resumePausedWork cleanly', async (t) => {
  const { rt, ctx, agents, emit, tool } = await startHost(t)
  const activeNonFg = () => rt.coordDb.listWorks({ activeOnly: true, limit: 100 }).filter(w => w.kind !== 'foreground')

  // 1) Pre-enqueue failure in delegate_work (ensureCapabilities throws before agent.followup) -> drops opened work.
  const origEnsure = rt.ensureCapabilities
  let failEnsureFor = 'dm-b'
  rt.ensureCapabilities = async (sid) => {
    if (sid === failEnsureFor) throw new Error('capability mount failed')
    return origEnsure(sid)
  }

  await assert.rejects(() => tool('delegate_work', { to: 'Writer', goal: 'will fail pre-enqueue' }, 'dm-a'), /capability mount failed/)
  assert.equal(activeNonFg().length, 0, 'pre-enqueue failure must drop opened work in coordDb')
  assert.equal(agents.get('dm-b').calls.length, 0, 'pre-enqueue failure must not enqueue onto target agent')

  // 2) Post-enqueue flush failure in delegate_work -> error.delivered === true -> work stays open in coordDb!
  failEnsureFor = undefined
  const origFlush = ctx.sessions.flush
  let failFlushFor = 'dm-b'
  ctx.sessions.flush = async (session) => {
    if (session?.id === failFlushFor) throw new Error('disk flush failed')
    return origFlush(session)
  }
  await assert.rejects(() => tool('delegate_work', { to: 'Writer', goal: 'enqueued then flush fails' }, 'dm-a'), /disk flush failed/)
  assert.equal(activeNonFg().length, 1, 'post-enqueue flush failure must keep work open in coordDb')
  assert.equal(agents.get('dm-b').calls.length, 1, 'enqueued message must remain on target agent')
  failFlushFor = undefined

  // 3) Transient pre-enqueue failure on ask_back & answer_work: durable SQLite keeps ask/answer queued and delivers on next kick!
  const workId = activeNonFg()[0].workId
  const req = agents.get('dm-b').calls.at(-1)[1]
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: req.content, source: req.source })
  failEnsureFor = 'dm-a'
  await tool('ask_back', { question: 'Need info?' }, 'dm-b')
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(rt.resolveWork(workId)?.work?.state, 'need_input', 'ask_back wait persists durably in SQLite despite transient dispatch failure')
  assert.equal(agents.get('dm-a').calls.length, 0, 'ask_back not delivered while capability mount fails')
  failEnsureFor = undefined
  await rt.kickScheduler({ botId: 'a' })
  await settle(() => agents.get('dm-a').calls.length === 1, 1000, 'durable ask_back delivers once capability mount recovers')
  const askMsg = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: askMsg.content, source: askMsg.source })

  const writerCallsBeforeAnswer = agents.get('dm-b').calls.length
  failEnsureFor = 'dm-b'
  await tool('answer_work', { answer: 'Use prod' }, 'dm-a')
  emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(agents.get('dm-b').calls.length, writerCallsBeforeAnswer, 'answer_work waits in ready queue while capability mount fails')
  failEnsureFor = undefined
  await rt.kickScheduler({ workId })
  await settle(() => agents.get('dm-b').calls.length === writerCallsBeforeAnswer + 1, 1000, 'durable answer_work delivers once capability mount recovers')
  const ansMsg = agents.get('dm-b').calls.at(-1)[1]
  assert.equal(ansMsg.source.role, 'answer')
  emit('dm-b', 'turn/start', { turn: 2 })
  emit('dm-b', 'user/message', { content: ansMsg.content, source: ansMsg.source })
  emit('dm-b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => rt.resolveWork(workId) === undefined, 1000)

  // 4) Durable resumePausedWork across transient capability failure: paused work requeues and delivers on retry without losing work!
  rt.openCall({
    workId: 'w-paused-fg',
    parentWorkId: 'fg:a',
    callerBotId: 'a',
    calleeBotId: 'b',
    title: 'resume fg work',
    initialBody: 'resume fg work',
  })
  rt.pauseWork('w-paused-fg', { reason: 'no_progress', detail: { kind: 'delegate', text: 'resume fg work' } })
  assert.equal(rt.coordDb.getWork('w-paused-fg')?.status, 'paused')
  const writerCallsBeforeResume = agents.get('dm-b').calls.length
  failEnsureFor = 'dm-b'
  assert.equal(await rt.resumePausedWork('w-paused-fg'), true)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(agents.get('dm-b').calls.length, writerCallsBeforeResume, 'resumed work stays queued while capability mount fails')
  assert.equal(rt.coordDb.getWork('w-paused-fg')?.status, 'queued', 'reconcileDeliveryStatus requeues failed dispatch instead of dropping work')
  failEnsureFor = undefined
  await rt.kickScheduler({ workId: 'w-paused-fg' })
  await settle(() => agents.get('dm-b').calls.length === writerCallsBeforeResume + 1, 1000, 'resumed work dispatches cleanly on retry')
  rt.dropWork('w-paused-fg')
  // Finish chief foreground turn if any reply landed
  if (agents.get('dm-a').calls.length > 1) {
    const rep = agents.get('dm-a').calls.at(-1)[1]
    emit('dm-a', 'turn/start', { turn: 2 })
    emit('dm-a', 'user/message', { content: rep.content, source: rep.source })
    emit('dm-a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  }

  // 5) Pre-enqueue failure on a second delegation leaves an existing unread delegation untouched!
  const writerAgent = agents.get('dm-b')
  writerAgent.inbox.nextStep.length = 0
  writerAgent.inbox.nextTurn.length = 0
  await tool('delegate_work', { to: 'Writer', goal: 'original unread task', when: 'queue' }, 'dm-a')
  const originalMsg = writerAgent.inbox.nextTurn.at(-1)
  assert.ok(originalMsg, 'first delegation sits unread in nextTurn')
  const firstWorkId = originalMsg.source.coordWorkId
  // Writer has activeClaim for firstWorkId; simulate second delegation failing pre-enqueue before dispatch.
  rt.ensureCapabilities = async (sid) => {
    if (sid === 'dm-b') throw new Error('merge capability mount failed')
    return origEnsure(sid)
  }
  // Finish firstWorkId's activeClaim or let second work queue independently without mutating firstWorkId's inbox message.
  emit('dm-b', 'turn/start', { turn: 3 })
  emit('dm-b', 'user/message', { content: originalMsg.content, source: originalMsg.source })
  const firstTextBefore = textOf(originalMsg.content)
  assert.ok(firstTextBefore.includes('original unread task'))
  assert.ok(rt.resolveWork(firstWorkId), 'first work stays open and untouched')
  rt.ensureCapabilities = origEnsure
  emit('dm-b', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
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

  // Intercept Chief receiving ask_back via followup and IMMEDIATELY invoke answer_work BEFORE Writer's Turn 1 ends!
  const chiefAgent = rig.agents.get('dm-a')
  const origFollowup = chiefAgent.followup.bind(chiefAgent)
  chiefAgent.followup = (message, ...rest) => {
    const out = origFollowup(message, ...rest)
    if (message?.source?.role === 'ask_back' && message.source.askWork) {
      void rig.tool('answer_work', { work_id: message.source.askWork, answer: 'staging' }, 'dm-a')
    }
    return out
  }

  await rig.tool('delegate_work', { to: 'Writer', goal: 'deploy service' }, 'dm-a')

  await settle(
    () => rig.rt.coordDb.listWorks({ activeOnly: true }).filter(w => w.kind !== 'foreground' && w.originKind !== 'request_dedup').length === 0 && writerStep >= 2,
    5000,
    'Writer must complete Turn 2 and close work',
  )
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

test('F8: 3-Bot chain and task_start sub-work complete without false pause while hard-signal stagnation pauses only the stalled chain', async (t) => {
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

  // 1) 3-Bot chain: Chief -> Writer (0 own work tools) -> Reviewer (runs bash) x3 -> NEVER false pause!
  //    Writer yields its workspace write lock when Turn 1 ends, allowing Reviewer's write-mode work to dispatch.
  for (let i = 1; i <= 3; i += 1) {
    const out = await tool('delegate_work', { to: 'Writer', goal: `coordinate task ${i}` }, 'dm-a')
    assert.match(out, /^Delegated work #W/, `round ${i} must not pause`)
    const reqW = agents.get('dm-b').calls.at(-1)[1]
    emit('dm-b', 'turn/start', { turn: i * 10 + 1 })
    emit('dm-b', 'user/message', { content: reqW.content, source: reqW.source })
    await tool('delegate_work', { to: 'Reviewer', goal: `execute bash ${i}` }, 'dm-b')
    emit('dm-b', 'turn/end', { turn: i * 10 + 1, reason: { kind: 'completed' } })
    await settle(() => agents.get('dm-c').calls.length >= i, 2000, 'Reviewer must dispatch once Writer yields workspace write lock')
    const reqR = agents.get('dm-c').calls.at(-1)[1]

    // Reviewer runs a real work tool (`bash`) and returns to Writer.
    emit('dm-c', 'turn/start', { turn: i })
    emit('dm-c', 'user/message', { content: reqR.content, source: reqR.source })
    emit('dm-c', 'tool/call', { callId: `c${i}`, name: 'bash', arguments: '{"command":"ls"}' })
    emit('dm-c', 'tool/result', { callId: `c${i}` })
    emit('dm-c', 'assistant/message', assistantText(`bash output ${i}`))
    emit('dm-c', 'turn/end', { turn: i, reason: { kind: 'completed' } })
    await settle(() => agents.get('dm-b').calls.some(([, m]) => m?.source?.replyTo === reqR.source.exchangeId))

    const repR = agents.get('dm-b').calls.at(-1)[1]
    emit('dm-b', 'turn/start', { turn: i * 10 + 2 })
    emit('dm-b', 'user/message', { content: repR.content, source: repR.source })
    emit('dm-b', 'assistant/message', assistantText(`summary ${i}`))
    emit('dm-b', 'turn/end', { turn: i * 10 + 2, reason: { kind: 'completed' } })
    await settle(() => rt.resolveWork(reqW.source.exchangeId) === undefined)
    await settle(() => agents.get('dm-a').calls.length >= i)
    const repW = agents.get('dm-a').calls.at(-1)[1]
    emit('dm-a', 'turn/start', { turn: i })
    emit('dm-a', 'user/message', { content: repW.content, source: repW.source })
    emit('dm-a', 'turn/end', { turn: i, reason: { kind: 'completed' } })
  }

  // 2) task_start sub-work settles cleanly under its parent work.
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
  assert.equal(rt.coordDb.getWork(bgTask.workId)?.status, 'done')

  // 3) Hard-signal stagnation pauses ONLY the stalled chain when digests repeat unchanged.
  const stalledId = reqT.source.exchangeId
  rt.recordWorkProgress({ workId: stalledId, unresolvedKey: 'retry-step', outputDigest: 'same-out', errorSignature: 'E1', threshold: 3 })
  rt.recordWorkProgress({ workId: stalledId, unresolvedKey: 'retry-step', outputDigest: 'same-out', errorSignature: 'E1', threshold: 3 })
  const res = rt.recordWorkProgress({ workId: stalledId, unresolvedKey: 'retry-step', outputDigest: 'same-out', errorSignature: 'E1', threshold: 3 })
  assert.equal(res.stagnant, true)
  assert.equal(res.paused, true)
  assert.equal(rt.workStateOf(stalledId), 'paused')
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
  await settle(
    () => rig.rt.coordDb.listWorks({ activeOnly: true }).filter(w => w.kind !== 'foreground' && w.originKind !== 'request_dedup').length === 0,
    4000,
    'preStep error must settle claimed leaf work',
  )
  await settle(() => {
    const events = rig.agents.get('dm-a').session.snapshotEvents()
    return events.some(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply' && textOf(ev.data?.content).includes('LOCAL_AGENT_MISSING'))
  }, 4000, 'Chief must receive failure notice for preStep-errored work')

  // Case 2: Turn fails with BLOCKING_CODES (LOCAL_AGENT_QUOTA) while another peer work sits queued in SQLite `ready`
  // AND a user-facing message sits in nextTurn.
  mode = 'quota'
  const dmB = rig.agents.get('dm-b')
  const userFacingQueued = createUserMessage({
    content: textBlock('[Work from Chief]\nAnswer user directly'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', audience: 'user', exchangeId: 'w-user-facing', senderSessionId: 'a', senderName: 'Chief' },
  })
  // Start a turn on dm-b (paused inside streamHandler) so we can deterministically queue both a peer work and a user-facing message before the quota failure.
  await rig.tool('delegate_work', { to: 'Writer', goal: 'first failing work', when: 'queue' }, 'dm-a')
  await quotaEntered.promise
  await rig.tool('delegate_work', { to: 'Writer', goal: 'queued work 2', when: 'queue' }, 'dm-c')
  const w2 = rig.rt.coordDb.listWorks({ botId: 'b', activeOnly: true }).find(w => w.title === 'queued work 2')
  assert.ok(w2, 'queued work 2 must exist in coordDb')
  dmB.inbox.append('next-turn', userFacingQueued)
  quotaRelease.resolve()

  await settle(() => rig.rt.resolveWork(w2.workId) === undefined, 4000, 'BLOCKING_CODES must settle queued peer work')
  await settle(() => {
    const events = rig.agents.get('dm-c').session.snapshotEvents()
    return events.some(ev => ev.type === 'user/message' && ev.data?.source?.role === 'reply' && textOf(ev.data?.content).includes('LOCAL_AGENT_QUOTA'))
  }, 4000, 'Reviewer must receive LOCAL_AGENT_QUOTA failure notice for queued peer work')
  await realDelay(30)
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

  // 1) abandonWork wakes user-started background task when parent === task:<id>.
  emit(task.sessionId, 'turn/start', { turn: 1 })
  emit(task.sessionId, 'user/message', { content: textBlock('delegate to Writer'), source: { kind: SOURCE_KIND, role: 'task', taskId: task.id } })
  await tool('delegate_work', { to: 'Writer', goal: 'check changelog' }, task.sessionId)
  const w1Work = rt.coordDb.listWorks({ botId: 'b', activeOnly: true }).find(w => w.title === 'check changelog')
  assert.ok(w1Work, 'delegated work created in coordDb')
  const w1 = w1Work.workId
  emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task.status === 'waiting_work', 1000)
  const callsBeforeAbandon = taskAgent.calls.length
  assert.equal(rt.abandonWork(w1), true, 'abandonWork must accept top-level work owned by an active task thread')
  assert.equal(rt.resolveWork(w1), undefined)
  await settle(() => taskAgent.calls.length > callsBeforeAbandon, 1000, 'abandonWork must wake waiting background task')
  assert.equal(taskAgent.calls.at(-1)[1].source.abandoned, true)

  // 2) forgetBot wakes user-started background task when a paused work's target Bot is deleted.
  const abandonedWake = taskAgent.calls.at(-1)[1]
  emit(task.sessionId, 'turn/start', { turn: 2 })
  emit(task.sessionId, 'user/message', { content: abandonedWake.content, source: abandonedWake.source })
  rt.openCall({
    workId: 'w-del-paused',
    parentWorkId: `task:${task.id}`,
    callerBotId: 'a',
    calleeBotId: 'c',
    title: 'paused on Reviewer',
  })
  rt.pauseWork('w-del-paused', { reason: 'no_progress', detail: { kind: 'delegate', text: 'paused on Reviewer' } })
  emit(task.sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => rt.coordDb.getWork(`task:${task.id}`)?.status === 'waiting', 1000)
  const callsBeforeForget = taskAgent.calls.length
  await rt.deleteBot('c')
  assert.equal(rt.resolveWork('w-del-paused'), undefined)
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
  await restarted.rt.adoptLiveWork()
  await settle(
    () => restarted.rt.resolveWork('handoff:w-lost-open') === undefined
      && restarted.rt.resolveWork('handoff:w-lost-paused') === undefined
      && (restarted.agents.get('task-wait-1')?.calls.length ?? 0) >= 1,
    2000,
    'startup reconcileLostWorks must abandon both open and paused works for deleted targets and wake waiting task',
  )
  const abandonedCalls = restarted.agents.get('task-wait-1').calls.filter(([, m]) => m.source?.abandoned === true)
  assert.ok(abandonedCalls.length >= 1, 'waiting task must be woken with abandoned result(s)')
  const combinedWakeText = abandonedCalls.map(([, m]) => m.content.map(b => b.text ?? '').join('\n')).join('\n')
  assert.equal((combinedWakeText.match(/\[Waiting given up/g) ?? []).length, 2, 'batched wake must deliver both abandoned works once all child waits settle')
  const taskInboxResults = restarted.rt.coordDb.listInbox('task:k_wait1', { limit: 10 }).filter(m => m.kind === 'result' && m.payload?.abandoned === true)
  assert.equal(taskInboxResults.length, 2, 'both open and paused lost works must be recorded as abandoned results on task inbox')
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
  emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
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

  // turns.js:askedBackWork prevented premature finish(), and the scheduler immediately dispatches Turn 2 (running) or keeps task in waiting_work — never prematurely completed!
  assert.equal(agents.get('dm-a').calls.length, chiefCallsBeforeEnd, 'Turn 1 end must NOT prematurely close work to Chief')
  assert.ok(rt.resolveWork(workId), 'work must remain open across Turn 1 -> Turn 2 boundary')
  assert.notEqual(task.status, 'completed', 'bot-handoff task must NOT prematurely complete across Turn 1 -> Turn 2 boundary')
  assert.ok(task.status === 'running' || task.status === 'waiting_work', `expected running or waiting_work, got ${task.status}`)

  // Turn 2 consumes Chief's answer and finishes cleanly -> closes work and settles task!
  await settle(() => taskAgent.calls.some(([, m]) => m?.source?.role === 'answer'), 2000, 'scheduler must dispatch Chief answer after Turn 1 yields')
  const dispatchedAnswer = taskAgent.calls.findLast(([, m]) => m?.source?.role === 'answer')[1]
  emit(task.sessionId, 'turn/start', { turn: 2 })
  emit(task.sessionId, 'user/message', { content: dispatchedAnswer.content, source: dispatchedAnswer.source })
  emit(task.sessionId, 'assistant/message', { message: { role: 'assistant', content: textBlock('Deployed to us-west-2.') } })
  emit(task.sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => rt.resolveWork(workId) === undefined && task.status === 'completed' && agents.get('dm-a').calls.length >= chiefCallsBeforeEnd + 1, 2000)
  assert.equal(agents.get('dm-a').calls.length, chiefCallsBeforeEnd + 1)
  assert.match(textOf(agents.get('dm-a').calls.at(-1)[1].content), /Deployed to us-west-2\./)
})

test('R1 P0-1 & P2-1: direct user text reply closes user_question wait without phantom wake; pending inbox wakes on resolve; startup cancels orphan approval waits', async (t) => {
  const { rt, agents, emit } = await startHost(t)
  rt.coordDb.ensureForegroundWork({ botId: 'a', sessionId: 'dm-a' })

  // 1) Open an ask_user question card + SQLite required user_question wait on fg:a.
  rt.state.questions['dm-a'] = { id: 'q-direct-1', callId: 'call-q1', question: 'Proceed?' }
  rt.coordDb.addWait({
    workId: 'fg:a',
    kind: 'user_question',
    targetId: 'question:q-direct-1',
    required: true,
    meta: { cardId: 'q-direct-1', sessionId: 'dm-a' },
  })
  assert.equal(rt.coordDb.listWaits({ workId: 'fg:a', status: 'open' }).length, 1)

  // User replies directly in chat text (instead of clicking the card) -> closeCard closes SQLite wait.
  const callsBefore = agents.get('dm-a').calls.length
  emit('dm-a', 'turn/start', { turn: 1 })
  emit('dm-a', 'user/message', { content: textBlock('Yes, go ahead'), source: { kind: 'user' } })
  emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await realDelay(30)
  assert.equal(rt.coordDb.listWaits({ workId: 'fg:a', status: 'open' }).length, 0, 'direct user text reply must close user_question wait')
  assert.equal(agents.get('dm-a').calls.length, callsBefore, 'closing user_question wait with empty inbox must NOT fire phantom "(continue work)"')

  // 2) P2-1: when an unread waking message IS queued while a user_question wait is open, resolving the wait wakes fg:a!
  rt.coordDb.addWait({
    workId: 'fg:a',
    kind: 'user_question',
    targetId: 'question:q-pending-2',
    required: true,
    meta: { cardId: 'q-pending-2', sessionId: 'dm-a' },
  })
  rt.coordDb.parkWaiting('fg:a')
  rt.coordDb.receiveMessage({
    workId: 'fg:a',
    kind: 'result',
    bodyPreview: 'Child finished while question was open',
    payload: { renderedText: 'Child finished while question was open' },
  })
  rt.resolveUserQuestionWait({ sessionId: 'dm-a', kind: 'question', cardId: 'q-pending-2', status: 'resolved' })
  await settle(() => agents.get('dm-a').calls.some(([, m]) => textOf(m.content).includes('Child finished while question was open')), 2000, 'resolving user_question wait must wake work with unread waking inbox')

  // Complete that foreground turn so fg:a returns to idle.
  const wokenMsg = agents.get('dm-a').calls.at(-1)[1]
  emit('dm-a', 'turn/start', { turn: 2 })
  emit('dm-a', 'user/message', { content: wokenMsg.content, source: wokenMsg.source })
  emit('dm-a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })

  // 3) Orphan open approval wait after restart is cancelled by adoptLiveWork and unblocks pending inbox!
  rt.coordDb.addWait({
    workId: 'fg:a',
    kind: 'approval',
    targetId: 'approval:dead-appr-99',
    required: true,
    meta: { approvalId: 'dead-appr-99', sessionId: 'dm-a' },
  })
  rt.coordDb.parkWaiting('fg:a')
  rt.coordDb.receiveMessage({
    workId: 'fg:a',
    kind: 'result',
    bodyPreview: 'Result after orphan approval',
    payload: { renderedText: 'Result after orphan approval' },
  })
  await rt.adoptLiveWork()
  const remainingAppr = rt.coordDb.listWaits({ workId: 'fg:a', kind: 'approval', status: 'open' })
  assert.equal(remainingAppr.length, 0, 'adoptLiveWork must cancel orphan approval waits whose in-memory approval no longer exists')
  await settle(() => agents.get('dm-a').calls.some(([, m]) => textOf(m.content).includes('Result after orphan approval')), 2000, 'cancelling orphan approval wait must unblock pending inbox')
})

test('R1 P0-2 & P1-3: startTask records D2 idempotencyKey; restart preserves needs_verification without clobbering and surfaces standalone task in inboxView', async (t) => {
  const { rt, agents, tool } = await startHost(t)
  await tool('task_start', { title: 'deploy prod', brief: 'run deploy script' }, 'dm-a')
  const bot = rt.botOf('a')
  const task = bot.tasks[0]
  assert.ok(task, 'task_start must create a background task')
  const taskWorkId = `task:${task.id}`
  const dbWork = rt.coordDb.getWork(taskWorkId)
  assert.ok(dbWork?.activeDeliveryKey, 'startTask must record durable D2 activeDeliveryKey')
  const deliveredMsg = agents.get(task.sessionId).calls[0][1]
  assert.equal(deliveredMsg.source.idempotencyKey, dbWork.activeDeliveryKey, 'delivered task prompt must carry matching idempotencyKey')

  // Clear in-memory inbox & pending direct tracker (simulating fresh process after restart)
  // so reconcileTasksAfterRestart would previously have killed this task as idle/interrupted.
  agents.get(task.sessionId).inbox.nextTurn.length = 0
  agents.get(task.sessionId).inbox.nextStep.length = 0
  rt.forgetDelivery?.(deliveredMsg.source.exchangeId)
  rt.forgetWorkDeliveries?.(taskWorkId)

  // Simulate host restart with D2 reporting interrupted side-effect tools -> needs_verification.
  const origQuery = rt.queryDeliveryStatus
  rt.queryDeliveryStatus = async () => ({
    status: 'aborted',
    consumed: true,
    interruptedTools: [{ toolName: 'bash', callId: 'c1' }],
  })
  try {
    await rt.adoptLiveWork()
  } finally {
    rt.queryDeliveryStatus = origQuery
  }

  assert.equal(rt.coordDb.getWork(taskWorkId).status, 'needs_verification', 'reconcileTasksAfterRestart must NOT clobber needs_verification to stopped')
  assert.equal(task.status, 'waiting_work', 'task must remain active waiting_work for user verification, never interrupted')
  const inbox = rt.inboxView()
  assert.ok(
    inbox.items.some(item => item.kind === 'paused' && item.id === `paused:${taskWorkId}`),
    'standalone task in needs_verification must surface in inboxView()',
  )
})

test('R1 P1-1: user turn abort/yield and direct non-coordDb relay end do NOT settle or ack activeClaims, while pre-step hard failure does', async (t) => {
  const { rt, agents, emit, tool } = await startHost(t)
  await tool('delegate_work', { to: 'Writer', goal: 'audit schema' }, 'dm-a')
  await settle(() => agents.get('dm-b').calls.length >= 1, 2000)
  const reqMsg = agents.get('dm-b').calls[0][1]
  const workId = reqMsg.source.coordWorkId
  assert.ok(workId, 'delegate_work must dispatch coordWorkId')
  assert.equal(rt.coordDb.getWork(workId).status, 'running')

  // 1) Overlapping user turn aborted (hadUserMessage: true) -> must NOT touch active claim!
  rt.notifyTurnLifecycle({ type: 'turn/aborted', sessionId: 'dm-b', turn: 10, reasonKind: 'aborted', isUserTurn: true, hadUserMessage: true })
  assert.equal(rt.coordDb.getWork(workId).status, 'running', 'user turn abort must not settle active claim')

  // 2) Overlapping user turn yielded (hadUserMessage: true) -> must NOT yield or ack active claim!
  rt.notifyTurnLifecycle({ type: 'turn/yielded', sessionId: 'dm-b', turn: 11, reasonKind: 'yielded', isUserTurn: true, hadUserMessage: true })
  assert.equal(rt.coordDb.getWork(workId).status, 'running', 'user turn yield must not yield active claim')

  // 3) Direct non-coordDb relay turn (`task-report`, no coordWorkId) ended -> must NOT settle active claim!
  rt.notifyTurnLifecycle({
    type: 'turn/ended',
    sessionId: 'dm-b',
    turn: 12,
    reasonKind: 'completed',
    text: 'task report ack',
    info: { kind: SOURCE_KIND, role: 'task-report', exchangeId: 'tr-1' },
    isUserTurn: false,
    hadUserMessage: true,
  })
  assert.equal(rt.coordDb.getWork(workId).status, 'running', 'direct non-coordDb relay end must not settle active claim')
  assert.equal(rt.coordDb.listInbox(workId, { unreadOnly: true }).length, 1, 'unread inbox must NOT be prematurely acked')

  // 4) Pre-step hard failure before user/message (isUserTurn: true, hadUserMessage: false) -> MUST fail active claim!
  emit('dm-b', 'turn/start', { turn: 13 })
  emit('dm-b', 'turn/end', { turn: 13, reason: { kind: 'error', error: { code: 'MODEL_ERR', message: 'pre-step boom' } } })
  await settle(() => rt.coordDb.getWork(workId).status === 'failed', 2000, 'pre-step hard failure must fail active claim')
})

test('R1 P1-2: deliverToTask (task_send) delivers exactly once without double-enqueue or phantom "(continue work)"', async (t) => {
  const { rt, agents, tool } = await startHost(t)
  await tool('task_start', { title: 'bg build', brief: 'build artifacts' }, 'dm-a')
  const task = rt.botOf('a').tasks[0]
  const taskAgent = agents.get(task.sessionId)
  task.status = 'waiting_work'
  rt.coordDb.parkWaiting(`task:${task.id}`)
  const callsBefore = taskAgent.calls.length

  await rt.deliverToTask(task.id, { text: 'switch to release mode' })
  await rt.kickScheduler()
  await realDelay(40)

  const newCalls = taskAgent.calls.slice(callsBefore)
  assert.equal(newCalls.length, 1, 'deliverToTask + kickScheduler must deliver exactly once (no double-enqueue)')
  assert.match(textOf(newCalls[0][1].content), /switch to release mode/)
  assert.ok(!newCalls.some(([, m]) => textOf(m.content).includes('(continue work)')), 'must never fire phantom "(continue work)"')
})

test('R1 P1-3: resumePausedWork on group room_work (paused and needs_verification) routes through resumeRoomPause', async (t) => {
  const team = makeTeam({
    rooms: {
      r1: { id: 'r1', name: 'Design', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' } },
    },
  })
  const { rt, agents } = await startHost(t, { team })
  const room = rt.roomOf('r1')
  const created1 = rt.openRoomCall(room, 'a', [rt.botOf('b')])
  const w1 = created1.children[0].work.workId
  rt.coordDb.pauseWork(w1, { status: 'paused', reason: 'no_progress' })

  const resumed1 = await rt.resumePausedWork(w1)
  assert.equal(resumed1, true, 'resumePausedWork must succeed for paused group room_work')
  assert.notEqual(rt.coordDb.getWork(w1).status, 'paused')
  assert.ok(
    agents.get('room-r1').calls.some(([, m]) => m.source?.resumedPause === true && m.source?.resumedWorkIds?.includes(w1)),
    'resuming paused group room_work must route through resumeRoomPause and enqueue group resume post',
  )

  const created2 = rt.openRoomCall(room, 'a', [rt.botOf('b')])
  const w2 = created2.children[0].work.workId
  rt.coordDb.pauseWork(w2, { status: 'needs_verification', reason: 'interrupted_tools' })

  const resumed2 = await rt.resumePausedWork(w2)
  assert.equal(resumed2, true, 'resumePausedWork must succeed for needs_verification group room_work')
  assert.notEqual(rt.coordDb.getWork(w2).status, 'needs_verification')
  assert.ok(
    agents.get('room-r1').calls.some(([, m]) => m.source?.resumedPause === true && m.source?.resumedWorkIds?.includes(w2)),
    'resuming needs_verification group room_work must route through resumeRoomPause',
  )
})
