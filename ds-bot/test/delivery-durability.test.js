import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { install as installLedger, bookFile, parseBook } from '../src/host/ledger.js'
import weixin from '../src/host/im/platforms/weixin.js'
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
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
    ...over,
  }
}

async function startHost(t, { home: existingHome, team, logs = new Map(), flushImpl, archiveCalls = [] } = {}) {
  const ownsHome = existingHome === undefined
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-durability-'))
  const workDir = join(home, 'workspace')
  mkdirSync(workDir, { recursive: true })
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const ctx = fakeContext()
  const agents = new Map()
  let seq = 0
  let nextCreated = 0

  const makeAgent = (id) => {
    const calls = []
    const events = []
    const session = {
      id,
      get seq() { return events.length },
      header: { cwd: workDir },
      requestHeader: () => ({ cwd: workDir, config: { provider: 'mock', model: 'mock-1' } }),
      snapshotEvents: () => [...events],
    }
    const inbox = {
      nextStep: [],
      nextTurn: [],
      prepend(queue, msg) {
        if (msg?.id !== undefined && [...this.nextStep, ...this.nextTurn].some(item => item?.id === msg.id)) {
          throw new Error(`message "${msg.id}" is already pending`)
        }
        ;(queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg)
      },
      append(queue, msg) {
        if (msg?.id !== undefined && [...this.nextStep, ...this.nextTurn].some(item => item?.id === msg.id)) {
          throw new Error(`message "${msg.id}" is already pending`)
        }
        ;(queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg)
      },
      remove(msgId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) {
            const [removed] = list.splice(at, 1)
            for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) listener({ agent, message: removed })
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
      send(message, target = 'next-turn', wake = true) {
        calls.push([wake ? (target === 'next-step' ? 'steer' : 'followup') : 'inject', message])
        inbox.append(target, message)
      },
      followup(message) {
        calls.push(['followup', message])
        inbox.append('next-turn', message)
      },
      steer(message) {
        calls.push(['steer', message])
        inbox.append('next-step', message)
      },
      inject(message) {
        calls.push(['inject', message])
        inbox.append('next-step', message)
      },
      cancel(cause) { calls.push(['cancel', cause]) },
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    }
    agents.set(id, agent)
    return agent
  }

  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: workDir }),
      resolveByPath: async () => ({ id: 'w1', path: workDir }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sid, opts) => { archiveCalls.push({ sid, opts }) },
    },
    sessionController: {
      create: async () => {
        const sid = `created-${++nextCreated}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      fork: async () => {
        const sid = `fork-${++nextCreated}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      resolveAgent: async sessionId => ({ agent: agents.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      inspect: async sessionId => ({ events: logs.get(sessionId) ?? agents.get(sessionId)?.session?.snapshotEvents?.() ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      flush: async session => (flushImpl ? flushImpl(session) : undefined),
      get: id => (agents.get(id) ?? makeAgent(id)).session,
    },
  })
  ctx.get = key => (key === 'agents' ? agents : undefined)

  const rt = createRuntime(ctx, { home })
  const stop = async () => {
    await ctx.dispose()
    if (ownsHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  t.after(stop)

  const emit = (id, type, data) => {
    const agent = agents.get(id) ?? makeAgent(id)
    const event = { type, seq: ++seq, time: Date.now(), data }
    agent.session.snapshotEvents = ((prev, ev) => () => [...prev(), ev])(agent.session.snapshotEvents, event)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agent.session, event)
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await rt.load()
  return { home, workDir, ctx, rt, agents, makeAgent, emit, tool, call, routes, stop }
}

// Real DSH ReactLoopAgent rig for testing agent/pre-step deterministic ordering.
async function createRealAgentRig(t, { streamHandler, team = makeTeam(), hasDshClock = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-durability-real-'))
  const workDir = join(home, 'workspace')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } }
    }
    async *stream(options) {
      yield* streamHandler(options)
    }
  }

  root.llm.registerAdapter(['test'], new TestAdapter())
  await mountAgentLoopTestHarness(root)

  const agents = new Map()
  let nextCreated = 0
  const registerSession = async (sid) => {
    const agent = await root.agentLoop.create(SessionId(sid), {
      provider: 'test',
      model: 'mock',
      cwd: workDir,
    })
    agents.set(sid, agent)
    return agent
  }
  for (const bot of Object.values(team.bots)) await registerSession(bot.sessionId ?? bot.id)

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
          const sid = `created-${++nextCreated}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        fork: async () => {
          const sid = `fork-${++nextCreated}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        resolveAgent: async sid => ({ agent: agents.get(sid) ?? root.agents.get(sid) ?? await registerSession(sid) }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async sid => ({ events: (agents.get(sid) ?? root.agents.get(sid))?.session?.snapshotEvents?.() ?? [] }),
      },
      sessionTitle: { rename: async () => {} },
      ...(hasDshClock ? { sessionProjections: { stateOf: (_session, key) => (key === 'timeContext' ? {} : undefined) } } : {}),
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
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](payload, () => run(index + 1)) : next())
    return run(0)
  })

  const rt = createRuntime(ctx, { home })
  for (const def of rt.teamTools) root.tools.register(def)

  t.after(async () => {
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()

  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agents.get(sessionId) })
  return { home, root, ctx, rt, agents, registerSession, tool }
}

test('F4 (turns.js): deferred later/joined preserve attachments and defer takenWork until owning turn consumes reply', async (t) => {
  const { rt, agents, emit } = await startHost(t, {
    team: makeTeam({
      works: {
        w_parent: { from: 'a', to: 'b', open: ['w_child'], results: [], at: 1 },
        w_child: { from: 'b', to: 'c', parent: 'w_parent', open: [], results: [], at: 2 },
        w_joined: { from: 'a', to: 'b', open: [], results: [], at: 3 },
      },
    }),
  })
  const img = { attachmentId: 'att-img-1', mediaType: 'image/png', name: 'chart.png' }
  const file = { attachmentId: 'att-file-1', mediaType: 'text/plain', name: 'report.txt' }

  // Writer is running an unrelated user turn.
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: textBlock('help me with something else'), source: { kind: 'user' } })

  // A child reply for w_parent arrives mid-turn with both image and file attachments -> pushed to entry.later.
  emit('dm-b', 'user/message', {
    content: [
      { type: 'text', text: '[Work completed by Reviewer · closed]\nReview details' },
      { type: 'image', attachment: img },
      { type: 'file', attachment: file },
    ],
    source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-reply-1', senderSessionId: 'c', senderName: 'Reviewer', work: 'w_parent', replyTo: 'w_child' },
  })
  // takenWork MUST NOT have cleared w_parent.open while deferred inside an unrelated busy turn!
  assert.deepEqual(rt.state.works.w_parent.open, ['w_child'], 'takenWork must stay deferred while reply sits in entry.later')

  // A peer request w_joined also steers into the same unrelated turn with an attachment -> pushed to entry.joined.
  emit('dm-b', 'user/message', {
    content: [
      { type: 'text', text: '[Work from Chief]\nInspect attachment' },
      { type: 'file', attachment: file },
    ],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w_joined', senderSessionId: 'a', senderName: 'Chief' },
  })

  // Unrelated user turn ends -> both later and joined redeliver with attachments preserved!
  emit('dm-b', 'assistant/message', assistantText('Done with user request.'))
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => (agents.get('dm-b')?.calls.length ?? 0) >= 2, 2000, 'deferred later and joined deliveries must land')

  const calls = agents.get('dm-b').calls.map(([, msg]) => msg)
  const deferredReply = calls.find(m => m.source?.exchangeId === 'ex-reply-1' && m.source?.deferred === true)
  const deferredReq = calls.find(m => m.source?.exchangeId === 'w_joined' && m.source?.deferred === true)
  assert.ok(deferredReply, 'deferred reply must be delivered')
  assert.deepEqual(deferredReply.content.filter(b => b.type === 'image').map(b => b.attachment), [img], 'deferred later must preserve images')
  assert.deepEqual(deferredReply.content.filter(b => b.type === 'file').map(b => b.attachment), [file], 'deferred later must preserve files')
  assert.ok(deferredReq, 'deferred joined request must be delivered')
  assert.deepEqual(deferredReq.content.filter(b => b.type === 'file').map(b => b.attachment), [file], 'deferred joined must preserve files')

  // Only when the deferred reply opens its own turn does takenWork clear w_parent.open.
  emit('dm-b', 'turn/start', { turn: 2 })
  emit('dm-b', 'user/message', { content: deferredReply.content, source: deferredReply.source })
  assert.deepEqual(rt.state.works.w_parent.open, [], 'takenWork must clear open once owning turn consumes deferred reply')
})

test('F4 (resume.js): unified recoverTurnDeferred recovers steered reply/ask_back/answer on user & cut turns, resendQueued guards stale states, atomic inflight write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-f4-resume-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const img = { attachmentId: 'att-img-2', mediaType: 'image/png', name: 'snap.png' }
  const team = makeTeam({
    works: {
      w_parent: { from: 'a', to: 'b', open: ['w_child'], results: [], at: 1 },
      w_ask: { from: 'b', to: 'c', state: 'need_input', question: 'Which env?', open: [], results: [], at: 2 },
      w_ans: { from: 'a', to: 'b', state: 'open', open: [], results: [], at: 3 },
      w_paused: { from: 'a', to: 'b', state: 'paused', paused: { reason: 'idle_loop', kind: 'delegate', text: 'paused' }, open: [], results: [], at: 4 },
      w_open_not_need_input: { from: 'b', to: 'c', state: 'open', open: [], results: [], at: 5 },
      w_need_input_not_open: { from: 'a', to: 'b', state: 'need_input', open: [], results: [], at: 6 },
    },
  })
  // Seed inflight.json:
  // 1) dm-b had an ordinary user turn (trigger === undefined, turn: 1) that COMPLETED in DSH log while offline,
  //    having absorbed a steered reply (for w_parent) + ask_back (for w_ask) + answer (for w_ans).
  // 2) dm-c had an INTERRUPTED turn (no turn/end) that absorbed a steered ask_back (for w_ask_c? let's test a steered request on cut turn!).
  // 3) queued entries for dm-b include paused, mismatched ask_back, mismatched answer -> all skipped; valid one resent.
  team.works.w_cut_primary = { from: 'a', to: 'c', open: [], results: [], at: 7 }
  team.works.w_cut_steered = { from: 'b', to: 'c', open: [], results: [], at: 8 }
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      'dm-b': { botId: 'b', turn: 1, since: 10 },
      'dm-c': { botId: 'c', turn: 1, since: 10, trigger: { role: 'request', exchangeId: 'w_cut_primary', senderSessionId: 'a' } },
    },
    queued: {
      'dm-b': [
        { at: 10, args: { fromId: 'a', toId: 'b', text: 'stale paused', role: 'request', exchangeId: 'w_paused' } },
        { at: 11, args: { fromId: 'c', toId: 'b', text: 'stale ask', role: 'ask_back', askWork: 'w_open_not_need_input', exchangeId: 'q-stale-ask' } },
        { at: 12, args: { fromId: 'a', toId: 'b', text: 'stale ans', role: 'answer', work: 'w_need_input_not_open', exchangeId: 'q-stale-ans' } },
        { at: 13, args: { fromId: 'c', toId: 'b', text: 'child done for paused parent', role: 'reply', work: 'w_paused', replyTo: 'w_child_of_paused', exchangeId: 'ex-child-for-paused-parent' } },
      ],
    },
  }))

  const logs = new Map([
    ['dm-b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: textBlock('ordinary user chat') } },
      {
        type: 'user/message', seq: 3,
        data: {
          source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-steered-reply', senderSessionId: 'c', senderName: 'Reviewer', work: 'w_parent', replyTo: 'w_child' },
          content: [{ type: 'text', text: '[Work completed by Reviewer]\nChild finished' }, { type: 'image', attachment: img }],
        },
      },
      {
        type: 'user/message', seq: 4,
        data: {
          source: { kind: SOURCE_KIND, role: 'ask_back', exchangeId: 'ex-steered-ask', senderSessionId: 'c', senderName: 'Reviewer', askWork: 'w_ask' },
          content: textBlock('[Work · Reviewer asks]\nWhich env?'),
        },
      },
      {
        type: 'user/message', seq: 5,
        data: {
          source: { kind: SOURCE_KIND, role: 'answer', exchangeId: 'ex-steered-ans', senderSessionId: 'a', senderName: 'Chief', work: 'w_ans' },
          content: textBlock('[Work · Chief answered]\nUse staging'),
        },
      },
      { type: 'assistant/message', seq: 6, data: { message: { content: textBlock('Done answering user.') } } },
      { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['dm-c', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w_cut_primary', senderSessionId: 'a', senderName: 'Chief' }, content: textBlock('[Work from Chief]\nPrimary cut work') } },
      { type: 'user/message', seq: 3, data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w_cut_steered', senderSessionId: 'b', senderName: 'Writer' }, content: textBlock('[Work from Writer]\nSteered during cut turn') } },
    ]],
  ])

  const host = await startHost(t, { home, team, logs })
  t.mock.timers.tick(3000)
  await settle(() => (host.agents.get('dm-b')?.calls.length ?? 0) >= 4 && (host.agents.get('dm-c')?.calls.length ?? 0) >= 2)

  const bMsgs = host.agents.get('dm-b').calls.map(([, m]) => m)
  // Ordinary user turn was completed -> MUST NOT be re-run as role: 'resume'!
  assert.equal(bMsgs.some(m => m.source?.role === 'resume'), false, 'completed ordinary user turn must not re-run via resumeTurn')
  // All 3 deferred messages from the completed user turn were recovered with attachments!
  const recReply = bMsgs.find(m => m.source?.exchangeId === 'ex-steered-reply')
  assert.ok(recReply && recReply.source.deferred === true)
  assert.deepEqual(recReply.content.filter(b => b.type === 'image').map(b => b.attachment), [img])
  assert.ok(bMsgs.some(m => m.source?.exchangeId === 'ex-steered-ask' && m.source?.role === 'ask_back' && m.source?.deferred === true))
  assert.ok(bMsgs.some(m => m.source?.exchangeId === 'ex-steered-ans' && m.source?.role === 'answer' && m.source?.deferred === true))
  // Stale paused request / mismatched ask_back / mismatched answer were filtered out by resendQueued,
  // while a child reply for a paused parent work MUST still be resent so it does not strand parent.open!
  assert.equal(bMsgs.some(m => ['w_paused', 'q-stale-ask', 'q-stale-ans'].includes(m.source?.exchangeId)), false, 'stale queued items must not be resent')
  assert.ok(bMsgs.some(m => m.source?.exchangeId === 'ex-child-for-paused-parent' && m.source?.role === 'reply'), 'child reply for paused parent work must still be resent')

  // Cut turn on dm-c resumed primary trigger AND recovered steered request w_cut_steered!
  const cMsgs = host.agents.get('dm-c').calls.map(([, m]) => m)
  assert.ok(cMsgs.some(m => m.source?.exchangeId === 'w_cut_primary' && m.source?.resumed === true))
  assert.ok(cMsgs.some(m => m.source?.exchangeId === 'w_cut_steered' && m.source?.deferred === true))

  // Atomic inflight.json write leaves no leftover .tmp files once async persist settles.
  await host.stop()
  assert.equal(readdirSync(home).filter(name => name.startsWith('inflight.json.') && name.endsWith('.tmp')).length, 0, 'atomic inflight.json write must leave no leftover .tmp files')
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')))
})

test('G-08 & G-09: unseen completed/failed group turns reconcile once, double-interrupt resets tasks, aborted turn keeps non-stopped joined room call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-g08-g09-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const team = makeTeam({
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
        sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {},
        tasks: { gt1: { id: 'gt1', botId: 'c', goal: 'Check metrics', status: 'active', startedAt: 1, updatedAt: 5, progress: '' } },
        goal: {
          id: 'g1', title: 'Ship', status: 'active', current: 0, revision: 0,
          stages: [{ id: 's1', title: 'Stage 1', status: 'active', tasks: [{ id: 'gtask1', botId: 'c', title: 'Verify', status: 'working' }] }],
        },
      },
    },
  })
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      // gb finished with a reply while DS Bot was offline -> reconcileEndedGroupTurn -> lateRoomReply.
      gb: { botId: 'b', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-ex-1' } },
      // ga failed with an error while DS Bot was offline -> reconcileEndedGroupTurn -> lateRoomFailure.
      ga: { botId: 'a', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-ex-2' } },
      // gc was already resumed once and interrupted again -> goalTaskReset + blockTasks!
      gc: { botId: 'c', roomId: 'r1', turn: 2, since: 10, resumed: true, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-ex-3' } },
    },
    queued: {},
  }))

  const logs = new Map([
    ['gb', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-ex-1' }, content: textBlock('[Group chat "Ops"]\nGive status') } },
      { type: 'tool/call', seq: 3, data: { callId: 't1', name: 'bash', arguments: '{}' } },
      { type: 'assistant/message', seq: 4, data: { message: { content: textBlock('Deployment verified green.') } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['ga', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'room-ex-2' }, content: textBlock('[Group chat "Ops"]\nCoordinate') } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 throttled' } } } },
    ]],
    ['gc', []],
  ])

  const host = await startHost(t, { home, team, logs })
  t.mock.timers.tick(3000)
  await settle(() => (host.agents.get('r1')?.calls.length ?? 0) >= 3, 2000, 'all three group turns must post to r1')

  const roomPosts = host.agents.get('r1').calls.map(([, m]) => m)
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'b' && textOf(m.content).includes('Deployment verified green.')), 'G-08: unseen completed group turn must post via lateRoomReply')
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'a' && m.source?.failed?.code === 'RATE_LIMIT'), 'G-08: unseen failed group turn must post via lateRoomFailure')
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'c' && m.source?.resumed === true && m.source?.again === true))
  // Double-interrupt reset gc's goal task to pending and blocked its group task!
  assert.equal(host.rt.state.rooms.r1.goal.stages[0].tasks[0].status, 'pending', 'G-08: double-interrupt must call goalTaskReset')
  assert.equal(host.rt.state.rooms.r1.tasks.gt1.status, 'blocked', 'G-08: double-interrupt must call blockTasks')
  assert.equal(host.rt.state.rooms.r1.tasks.gt1.blocked?.cause, 'restarted')

  // G-09: On an aborted unrelated primary turn, a non-stopped joined `role: 'room'` call is redelivered (not dropped),
  // while a disposed abort does NOT redeliver.
  const gbBefore = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 10 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nOld task'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'old-room-1' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nNew non-stopped call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-room-keep' } })
  host.emit('gb', 'turn/end', { turn: 10, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > gbBefore, 1000, 'G-09: non-stopped joined room call must be redelivered on aborted primary turn')
  const redelivered = host.agents.get('gb').calls.at(-1)[1]
  assert.equal(redelivered.source.exchangeId, 'joined-room-keep')
  assert.equal(redelivered.source.deferred, true)

  const gbBeforeDisposed = host.agents.get('gb').calls.length
  host.emit('gb', 'turn/start', { turn: 11 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nOld task 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'old-room-2' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nShutdown call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-room-disposed' } })
  host.emit('gb', 'turn/end', { turn: 11, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await realDelay(30)
  assert.equal(host.agents.get('gb').calls.length, gbBeforeDisposed, 'G-09: disposed abort must not redeliver during shutdown')

  // P1-4 & P2-2: reconcileEndedGroupTurn dedups against real groups.js:noteFailure ledger rows
  // (`{ kind: 'notice', reason: 'failed', about: member.id }`) AND own-name-prefixed replies (`Writer: ...`)!
  const homeDedup = mkdtempSync(join(tmpdir(), 'ds-bot-g08-dedup-'))
  t.after(() => rmSync(homeDedup, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(homeDedup, 'ledger'), { recursive: true })
  writeFileSync(join(homeDedup, 'ledger', bookFile('group-r1')), [
    JSON.stringify({ seq: 1, who: 'DS Bot', kind: 'notice', reason: 'failed', names: ['Chief'], about: 'a', code: 'RATE_LIMIT', message: '429', time: 20 }),
    JSON.stringify({ seq: 2, botId: 'b', name: 'Writer', text: 'Deployment verified green.', time: 20 }),
  ].join('\n') + '\n', 'utf8')
  writeFileSync(join(homeDedup, 'inflight.json'), JSON.stringify({
    turns: {
      ga: { botId: 'a', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-dedup-err' } },
      gb: { botId: 'b', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-dedup-ok' } },
    },
    queued: {},
  }))
  const dedupTeam = makeTeam({
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
        sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 2, seen: {},
        goal: {
          id: 'g1', title: 'Ship', status: 'active', current: 0, revision: 0,
          stages: [{ id: 's1', title: 'Stage 1', status: 'active', tasks: [{ id: 'gtask1', botId: 'a', title: 'Check', status: 'working' }] }],
        },
      },
    },
  })
  const dedupLogs = new Map([
    ['ga', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'room-dedup-err' }, content: textBlock('[Group chat "Ops"]\nCoordinate') } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429' } } } },
    ]],
    ['gb', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-dedup-ok' }, content: textBlock('[Group chat "Ops"]\nGive status') } },
      { type: 'assistant/message', seq: 3, data: { message: { content: textBlock('Writer: Deployment verified green.') } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])
  const hostDedup = await startHost(t, { home: homeDedup, team: dedupTeam, logs: dedupLogs })
  t.mock.timers.tick(3000)
  await realDelay(40)
  assert.equal(hostDedup.agents.get('r1')?.calls.length ?? 0, 0, 'real noteFailure ledger row and own-name-prefixed reply must dedup cleanly without double posting')
  assert.equal(hostDedup.rt.state.rooms.r1.goal.stages[0].tasks[0].status, 'working', 'deduped failure must not re-run goalTaskReset')
})

test('F6 (real ReactLoopAgent + durability): pre-step orders silent notes before queued delegate_work, >50 notes kept, restart flush without waking, ledger mark after flush, handoff & cancel session targeting', async (t) => {
  // 1) Real ReactLoopAgent causal ordering: note_bot buffered during Turn 1 + delegate_work queued for Turn 2
  //    -> agent/pre-step prepends silent note BEFORE delegate_work on Turn 2 step 1!
  let releaseTurn1
  const turn1Entered = new Promise(resolve => { releaseTurn1 = resolve })
  let finishTurn1
  const holdTurn1 = new Promise(resolve => { finishTurn1 = resolve })
  let turn2Messages
  let writerStep = 0

  const rig = await createRealAgentRig(t, {
    async *streamHandler(options) {
      if (options.sessionId === 'dm-b') {
        writerStep += 1
        if (writerStep === 1) {
          releaseTurn1()
          await holdTurn1
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Turn 1 done.' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Turn 1 done.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        turn2Messages = options.messages.map(m => textOf(m.content))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Turn 2 saw note first.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Turn 2 saw note first.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '[PASS]' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '[PASS]' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // Start Turn 1 on Writer.
  const writer = rig.agents.get('dm-b')
  writer.followup({ id: 'u1', role: 'user', content: textBlock('start turn 1'), source: { kind: 'user' } })
  await turn1Entered
  // While Writer is busy in Turn 1: Chief leaves a silent note, then immediately queues delegate_work.
  await rig.tool('note_bot', { to: 'Writer', note: 'CRITICAL_NOTE_FIRST' }, 'dm-a')
  // While buffered, pair ledger must NOT mark it delivered yet!
  assert.equal(rig.rt.exchangesOf('a', 'b').some(e => e.text.includes('CRITICAL_NOTE_FIRST')), false, 'buffered silent note must not be marked delivered before flush')
  await rig.tool('delegate_work', { to: 'Writer', goal: 'QUEUED_WORK_SECOND', when: 'queue' }, 'dm-a')
  finishTurn1()

  await settle(() => turn2Messages !== undefined, 4000, 'Turn 2 must run and receive both messages')
  const noteIdx = turn2Messages.findIndex(text => text.includes('CRITICAL_NOTE_FIRST'))
  const workIdx = turn2Messages.findIndex(text => text.includes('QUEUED_WORK_SECOND'))
  assert.ok(noteIdx !== -1 && workIdx !== -1, `Turn 2 must see both messages: ${JSON.stringify(turn2Messages)}`)
  assert.ok(noteIdx < workIdx, `silent note (${noteIdx}) must causally precede queued delegate_work (${workIdx})`)
  await settle(() => rig.rt.exchangesOf('a', 'b').some(e => e.text.includes('CRITICAL_NOTE_FIRST')), 2000, 'ledger delivered mark must land after pre-step flush')
  await writer.whenIdle()

  // 1b) Real ReactLoopAgent P1-1 flush retry + P1-2 zero-wake on empty wake boundary:
  //     - Inject silent note -> first sessions.flush throws -> retry MUST NOT crash ReactLoopInbox with
  //       `message "<id>" is already pending`, and succeeds cleanly on second flush!
  //     - Empty pre-step batch (`messages: []` / hook-emptied `decision.messages: []`) with buffered silent notes
  //       MUST NOT wake an LLM stream call and MUST leave silent notes buffered intact!
  let reviewerStreamCalls = 0
  let releaseRetryTurn
  const retryTurnEntered = new Promise(resolve => { releaseRetryTurn = resolve })
  let finishRetryTurn
  const holdRetryTurn = new Promise(resolve => { finishRetryTurn = resolve })
  const rig2 = await createRealAgentRig(t, {
    hasDshClock: true,
    async *streamHandler(options) {
      if (options.sessionId === 'dm-c') {
        reviewerStreamCalls += 1
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'unexpected wake' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'unexpected wake' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (options.sessionId === 'dm-b') {
        releaseRetryTurn()
        await holdRetryTurn
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Retry turn done.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Retry turn done.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '[PASS]' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '[PASS]' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const origFlush = rig2.root.sessions.flush.bind(rig2.root.sessions)
  let failOnceFlush = false
  rig2.root.sessions.flush = async (session) => {
    if (failOnceFlush && session?.id === 'dm-b') {
      failOnceFlush = false
      throw new Error('simulated transient flush failure')
    }
    return origFlush(session)
  }
  const writer2 = rig2.agents.get('dm-b')
  writer2.followup({ id: 'u-retry-1', role: 'user', content: textBlock('busy turn for retry test'), source: { kind: 'user' } })
  await retryTurnEntered
  await rig2.tool('note_bot', { to: 'Writer', note: 'RETRY_AFTER_FLUSH_ERROR' }, 'dm-a')
  failOnceFlush = true
  finishRetryTurn()
  await writer2.whenIdle()
  await realDelay(30)
  // First flush failed, so note is still buffered (not yet marked delivered in pair ledger),
  // AND the message already sits in real ReactLoopInbox.nextStep.
  assert.equal(rig2.rt.exchangesOf('a', 'b').some(e => e.text.includes('RETRY_AFTER_FLUSH_ERROR')), false, 'failed flush must not mark delivered')
  // Retry flush on real ReactLoopAgent MUST skip duplicate agent.inject() and succeed cleanly!
  await rig2.rt.flushSilentNotes('dm-b')
  await settle(() => rig2.rt.exchangesOf('a', 'b').some(e => e.text.includes('RETRY_AFTER_FLUSH_ERROR')), 2000, 'retry flush must succeed on real ReactLoopInbox without duplicate-id crash')

  // P1-2: Warm up dm-c (so DSH runtime-context snapshot is already projected), then buffer a silent
  // note and trigger a REAL ReactLoopAgent empty wake boundary (followup immediately removed before
  // pre-step claims next-turn) -> MUST exit turn with 0 LLM calls and keep silent note buffered!
  const reviewer2 = rig2.agents.get('dm-c')
  reviewer2.followup({ id: 'warmup-c', role: 'user', content: textBlock('warmup'), source: { kind: 'user' } })
  await reviewer2.whenIdle()
  reviewerStreamCalls = 0
  rig2.rt.live.set('dm-c', { turn: 99 })
  await rig2.tool('note_bot', { to: 'Reviewer', note: 'ZERO_WAKE_EMPTY_PRESTEP' }, 'dm-a')
  const emptyWakeMsg = { id: 'tmp-removed-before-claim', role: 'user', content: textBlock('cancelled before claim'), source: { kind: 'user' } }
  await reviewer2.runMaintenance(async () => {
    reviewer2.followup(emptyWakeMsg)
    assert.equal(reviewer2.inbox.remove(emptyWakeMsg.id), true, 'queued message removed during maintenance leaves an empty wake boundary')
  })
  await reviewer2.whenIdle()
  assert.equal(reviewerStreamCalls, 0, 'real ReactLoopAgent empty wake boundary must never wake LLM on buffered silent note')
  const preStepListeners = rig2.ctx.listeners.get('agent/pre-step') ?? []
  const runPreStep = (payload, baseDecision) => {
    const run = idx => (idx < preStepListeners.length ? preStepListeners[idx](payload, () => run(idx + 1)) : Promise.resolve(baseDecision))
    return run(0)
  }
  const emptyClaimDecision = await runPreStep(
    { agent: reviewer2, step: 1, messages: [], signal: new AbortController().signal },
    { kind: 'enter', messages: [{ id: 'rc-1', role: 'user', content: textBlock('runtime'), source: { kind: 'runtime-context' } }] },
  )
  assert.equal(emptyClaimDecision.messages.some(m => textOf(m.content).includes('ZERO_WAKE_EMPTY_PRESTEP')), false, 'empty claimed batch must never prepend silent notes')
  const emptiedDecision = await runPreStep(
    { agent: reviewer2, step: 1, messages: [{ id: 'w-1', role: 'user', content: textBlock('hi'), source: { kind: 'user' } }], signal: new AbortController().signal },
    { kind: 'enter', messages: [] },
  )
  assert.equal(emptiedDecision.messages.some(m => textOf(m.content).includes('ZERO_WAKE_EMPTY_PRESTEP')), false, 'hook-emptied decision.messages must never prepend silent notes')
  assert.equal(reviewerStreamCalls, 0, 'empty pre-step must never trigger LLM stream call')
  // Note must still be buffered and flush cleanly once dm-c goes idle!
  rig2.rt.live.delete('dm-c')
  await rig2.rt.flushSilentNotes('dm-c')
  await settle(() => rig2.rt.exchangesOf('a', 'c').some(e => e.text.includes('ZERO_WAKE_EMPTY_PRESTEP')), 2000, 'silent note preserved after skipped empty pre-step must flush on idle')
  assert.equal(reviewerStreamCalls, 0, 'flushing silent note on idle must remain zero-wake')

  // 2) >50 silent notes buffered while busy (no silent 50-item cap!), persisted in inflight.json.silent,
  //    survive flush failure (restored back to buffer), and flush on restart WITHOUT waking!
  const home2 = mkdtempSync(join(tmpdir(), 'ds-bot-f6-persist-'))
  t.after(() => rmSync(home2, { recursive: true, force: true, maxRetries: 5 }))
  let failFlush = false
  const host1 = await startHost(t, {
    home: home2,
    team: makeTeam(),
    flushImpl: async () => { if (failFlush) throw new Error('transient flush error') },
  })
  host1.emit('dm-b', 'turn/start', { turn: 1 })
  host1.emit('dm-b', 'user/message', { content: textBlock('busy'), source: { kind: 'user' } })
  for (let i = 1; i <= 55; i += 1) {
    await host1.tool('note_bot', { to: 'Writer', note: `Silent note #${i}` }, 'dm-a')
  }
  await settle(() => {
    try { return (JSON.parse(readFileSync(join(home2, 'inflight.json'), 'utf8')).silent?.['dm-b']?.length ?? 0) === 55 } catch { return false }
  }, 2000, 'all 55 buffered silent notes must persist in inflight.json.silent without 50-item drop cap')

  // Flush failure restores all 55 entries instead of dropping them!
  failFlush = true
  host1.emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => {
    try { return (JSON.parse(readFileSync(join(home2, 'inflight.json'), 'utf8')).silent?.['dm-b']?.length ?? 0) === 55 } catch { return false }
  }, 2000, 'flush failure must restore buffered silent notes')
  await host1.stop()

  // Restart: inflight.json.silent flushes all 55 notes via agent.inject WITHOUT waking!
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host2 = await startHost(t, { home: home2 })
  t.mock.timers.tick(3000)
  await settle(() => (host2.agents.get('dm-b')?.calls.filter(([k]) => k === 'inject').length ?? 0) === 55, 2000, 'restart must flush all 55 silent notes without waking')
  assert.equal(host2.agents.get('dm-b').calls.every(([kind]) => kind === 'inject'), true, 'restored silent notes must only inject, never wake')
  assert.match(textOf(host2.agents.get('dm-b').calls[0][1].content), /Silent note #1$/)
  assert.match(textOf(host2.agents.get('dm-b').calls[54][1].content), /Silent note #55$/)
  t.mock.timers.reset()

  // 3) handoffForeground migrates buffered pendingSilent to new foreground session, AND
  //    cancel_work targets work.toSession (background task session) instead of foreground chat!
  const host3 = await startHost(t, { team: makeTeam() })
  host3.emit('dm-b', 'turn/start', { turn: 1 })
  host3.emit('dm-b', 'tool/call', { callId: 'c1', name: 'bash', arguments: '{}' })
  await host3.tool('note_bot', { to: 'Writer', note: 'Keep across handoff' }, 'dm-a')
  const newFgSid = await host3.rt.handoffForeground(host3.rt.botOf('b'), 'dm-b', [])
  await settle(() => (host3.agents.get(newFgSid)?.calls.filter(([k]) => k === 'inject').length ?? 0) >= 1, 2000, 'handoffForeground must migrate buffered silent notes to new foreground')
  assert.ok(host3.agents.get(newFgSid).calls.some(([k, m]) => k === 'inject' && textOf(m.content).includes('Keep across handoff')))

  // Spawn a bot-handoff task for Reviewer (busy foreground -> toSession = created-1), then cancel_work -> cancelled notice targets task session!
  host3.emit('dm-c', 'turn/start', { turn: 1 })
  host3.emit('dm-c', 'tool/call', { callId: 'c2', name: 'bash', arguments: '{}' })
  await host3.tool('delegate_work', { to: 'Reviewer', goal: 'bg work to cancel' }, 'dm-a')
  const bgTask = host3.rt.botOf('c').tasks.find(item => item.origin === 'bot-handoff')
  assert.ok(bgTask, 'bot-handoff task created')
  const fgCallsBeforeCancel = host3.agents.get('dm-c').calls.length
  await host3.tool('cancel_work', { target: 'Reviewer', reason: 'no longer needed' }, 'dm-a')
  await settle(() => (host3.agents.get(bgTask.sessionId)?.calls.some(([k, m]) => k === 'inject' && m.source?.role === 'cancelled')), 2000, 'cancel_work must target background task session')
  assert.equal(host3.agents.get('dm-c').calls.length, fgCallsBeforeCancel, 'cancel_work on background task must NOT pollute foreground chat')

  // 4) P1-3: parts.js:handOnHeld migrates silent entries cleanly without dual copies or premature delivered,
  //    AND deliver({ wake: true }) flush failure after wakeup does not re-buffer already-injected silent notes!
  let failForward = true
  const host4 = await startHost(t, {
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
        b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b-old', createdAt: 2 },
        c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
      },
    }),
    flushImpl: async (session) => {
      if (failForward && session.id === 'dm-b-new') throw new Error('forward flush failed')
    },
  })
  // Buffer a silent note on dm-b-old while it is busy, then simulate an interrupted part switch to dm-b-new.
  host4.emit('dm-b-old', 'turn/start', { turn: 1 })
  host4.emit('dm-b-old', 'user/message', { content: textBlock('busy before switch'), source: { kind: 'user' } })
  await host4.tool('note_bot', { to: 'Writer', note: 'Held across failed forward' }, 'dm-a')
  const writerBot = host4.rt.botOf('b')
  writerBot.segments = [{ sessionId: 'dm-b-old', endedAt: 1 }]
  writerBot.sessionId = 'dm-b-new'
  host4.rt.chatOwners.set('dm-b-new', 'b')
  host4.rt.state.switching = { 'dm-b-old': { botId: 'b' } }
  await host4.rt.heldBack()
  assert.equal(host4.rt.state.switching['dm-b-old'] !== undefined, true, 'failed handOnHeld must keep switching marker')
  // Failed flush on dm-b-new must NOT mark pair ledger delivered AND must NOT duplicate on both dm-b-old & dm-b-new!
  assert.equal(host4.rt.exchangesOf('a', 'b').some(e => e.text.includes('Held across failed forward')), false, 'failed handOnHeld flush must not mark delivered prematurely')
  await settle(() => {
    try {
      const data = JSON.parse(readFileSync(join(host4.home, 'inflight.json'), 'utf8'))
      return (data.silent?.['dm-b-old']?.length ?? 0) === 0 && (data.silent?.['dm-b-new']?.length ?? 0) === 1
    } catch { return false }
  }, 2000, 'silent note must remain buffered solely on dm-b-new for retry (no dual copy on dm-b-old)')
  // Retry succeeds cleanly without duplicate-id throw on strict inbox, and marks delivered ONCE!
  failForward = false
  await host4.rt.heldBack()
  assert.equal(host4.rt.state.switching['dm-b-old'], undefined, 'retried handOnHeld must clear switching marker')
  assert.equal(host4.agents.get('dm-b-new').calls.filter(([, m]) => textOf(m.content).includes('Held across failed forward')).length, 1, 'retry must not inject duplicate message')
  await settle(() => host4.rt.exchangesOf('a', 'b').some(e => e.text.includes('Held across failed forward')), 2000, 'ledger delivered mark must land once retry flush succeeds')

  // Busy target moveSilentNotes preserves entry.ledger until target goes idle and flushes (no premature delivered).
  host4.emit('dm-c', 'turn/start', { turn: 1 })
  host4.emit('dm-c', 'user/message', { content: textBlock('busy c'), source: { kind: 'user' } })
  await host4.tool('note_bot', { to: 'Reviewer', note: 'Deferred ledger across part move' }, 'dm-a')
  host4.emit('dm-c-next', 'turn/start', { turn: 1 })
  host4.rt.chatOwners.set('dm-c-next', 'c')
  await host4.rt.moveSilentNotes('dm-c', 'dm-c-next')
  assert.equal(host4.rt.exchangesOf('a', 'c').some(e => e.text.includes('Deferred ledger across part move')), false, 'moving silent note onto busy target must not mark delivered prematurely')
  host4.emit('dm-c-next', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await host4.rt.flushSilentNotes('dm-c-next')
  await settle(() => host4.rt.exchangesOf('a', 'c').some(e => e.text.includes('Deferred ledger across part move')), 2000, 'ledger delivered mark must land once busy target flushes')

  // P1-1b: deliver({ wake: true }) flush failure after followup woke the turn does NOT re-buffer already-injected silent notes!
  let failWakeFlush = true
  const host5 = await startHost(t, {
    team: makeTeam(),
    flushImpl: async () => { if (failWakeFlush) throw new Error('post-wake flush failure') },
  })
  host5.emit('dm-b', 'turn/start', { turn: 1 })
  host5.emit('dm-b', 'user/message', { content: textBlock('busy'), source: { kind: 'user' } })
  await host5.tool('note_bot', { to: 'Writer', note: 'Already injected before wake' }, 'dm-a')
  // End turn 1 without flushing yet by clearing live directly so pendingSilent stays populated for deliver({ wake: true }).
  host5.rt.live.delete('dm-b')
  await assert.rejects(() => host5.rt.deliver({ fromId: 'a', toId: 'b', text: 'waking work', role: 'request' }), /post-wake flush failure/)
  assert.equal(host5.rt.takeSilentEntries('dm-b').length, 0, 'deliver({ wake: true }) flush failure after wakeup must not re-buffer already-injected silent notes')
  failWakeFlush = false
})

test('F9 (ledger.js, delivery.js, handoffs.js): torn newline & prepend race fixes, drop clears lastWrite, incremental pairCache, disposed resolveAgent, async dropResults + orphan sweep', async (t) => {
  // 1) ledger.js: failed append sets entry.torn = true -> next queued append prepends `\n`,
  //    prepend queued behind a failed append does NOT resurrect the rolled-back record, and drop() clears lastWrite!
  const ledgerHome = mkdtempSync(join(tmpdir(), 'ds-bot-f9-ledger-'))
  t.after(() => rmSync(ledgerHome, { recursive: true, force: true, maxRetries: 5 }))
  const lrt = { home: ledgerHome, readOnly: () => undefined, warn() {} }
  installLedger(lrt)
  const bookPath = join(ledgerHome, 'ledger', bookFile('pair-a-b'))
  mkdirSync(join(ledgerHome, 'ledger'), { recursive: true })
  writeFileSync(bookPath, '{"id":"ok1","seq":2,"text":"good"}\n', 'utf8')
  assert.equal(lrt.ledger.records('pair-a-b').length, 1)

  // Make book path read-only (0o444) so appendFile fails while temp+rename prepend can still proceed.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail1', seq: 3, text: 'failed' })
    const fail1Write = lrt.ledger.written('pair-a-b')
    // Queue prepend synchronously behind the failing append!
    lrt.ledger.prepend('pair-a-b', [{ id: 'pre1', seq: 1, text: 'earlier' }])
    await assert.rejects(fail1Write)
    await lrt.ledger.flush('pair-a-b')
    chmodSync(bookPath, 0o644)
    const parsed = parseBook(readFileSync(bookPath, 'utf8'))
    assert.deepEqual(parsed.map(r => r.id), ['pre1', 'ok1'], 'failed append must never be resurrected by queued prepend')

    // Simulate a partial torn line left on disk after a failed append: queued append must start with `\n`!
    writeFileSync(bookPath, `${readFileSync(bookPath, 'utf8')}{"id":"torn-half"`, 'utf8')
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail2', seq: 4, text: 'boom' })
    const fail2Write = lrt.ledger.written('pair-a-b')
    // Restore write permission only AFTER fail2 fails (before queued ok2 runs inside serialized chain).
    const restored = fail2Write.catch(() => { chmodSync(bookPath, 0o644) })
    lrt.ledger.append('pair-a-b', { id: 'ok2', seq: 5, text: 'recovered' })
    await assert.rejects(fail2Write)
    await restored
    await lrt.ledger.flush('pair-a-b')
    const afterTorn = parseBook(readFileSync(bookPath, 'utf8'))
    assert.deepEqual(afterTorn.map(r => r.id), ['pre1', 'ok1', 'ok2'], 'queued append after failed append must prepend newline so it is not fused onto torn bytes')

    // drop() must clear stale rejected lastWrite so subsequent written() resolves!
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail3', seq: 6, text: 'fail-before-drop' })
    await assert.rejects(lrt.ledger.written('pair-a-b'))
    chmodSync(bookPath, 0o644)
    lrt.ledger.drop('pair-a-b')
    await assert.doesNotReject(() => lrt.ledger.written('pair-a-b'))
  }

  // 2) delivery.js incremental pairCache + disposed resolveAgent guard.
  const host = await startHost(t, { team: makeTeam() })
  await host.rt.deliver({ fromId: 'a', toId: 'b', text: 'hello 1', role: 'request', exchangeId: 'ex-1' })
  await host.rt.deliver({ fromId: 'b', toId: 'a', text: 'answer 1', role: 'reply', replyTo: 'ex-1', exchangeId: 'ex-2' })
  assert.equal(host.rt.wasReplyDelivered('b', 'a', 'ex-1'), true)
  assert.equal(host.rt.exchangeOf('ex-2', 'a', 'b')?.text, 'answer 1')
  await host.rt.deliver({ fromId: 'b', toId: 'a', text: 'fail notice', role: 'reply', replyTo: 'ex-1', exchangeId: 'ex-3', failureRequestId: 'req-err-1', work: 'w-parent' })
  assert.equal(host.rt.wasFailureRequestDelivered('b', 'a', 'req-err-1', 'dm-a', 'w-parent'), true)
  host.ctx.fiber = { uid: null }
  await assert.rejects(() => host.rt.resolveAgent('dm-a'), error => error.code === 'plugin/disposed')

  // 3) handoffs.js startup orphan handoff-results/*.txt sweep keeps referenced files and removes orphans.
  const orphanHome = mkdtempSync(join(tmpdir(), 'ds-bot-f9-orphans-'))
  t.after(() => rmSync(orphanHome, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(orphanHome, 'handoff-results'), { recursive: true })
  writeFileSync(join(orphanHome, 'handoff-results', 'kept-1.txt'), 'x'.repeat(2500), 'utf8')
  writeFileSync(join(orphanHome, 'handoff-results', 'orphan-old.txt'), 'stale orphan', 'utf8')
  await startHost(t, {
    home: orphanHome,
    team: makeTeam({
      works: {
        w1: { from: 'a', to: 'b', open: [], results: [{ id: 'kept-1', name: 'Reviewer', text: 'x'.repeat(2000), length: 2500, file: 'kept-1.txt' }], at: 1 },
      },
    }),
  })
  await settle(() => !existsSync(join(orphanHome, 'handoff-results', 'orphan-old.txt')), 2000, 'startup sweep must remove orphaned result files')
  assert.equal(existsSync(join(orphanHome, 'handoff-results', 'kept-1.txt')), true, 'referenced result file must be kept')
})

test('F10 + State Hygiene + Weixin: deleteBot/startup prune requests & pair ledgers, pruneSettledTasks archives sessions, feed/tails suppress tasks & silent [PASS], weixin coalesces poll warnings', async (t) => {
  // 1) requests.js + roster.js + bot-tasks.js pruneSettledTasks archiving.
  const archiveCalls = []
  const host = await startHost(t, {
    archiveCalls,
    team: makeTeam({
      requests: {
        'a\u0000chat\u0000keep-me': { fingerprint: 'f1', outcome: 'delivered', receipt: 'ok', at: 1 },
        'c\u0000chat\u0000drop-on-delete': { fingerprint: 'f2', outcome: 'delivered', receipt: 'ok', at: 1 },
        'ghost\u0000chat\u0000orphan': { fingerprint: 'f3', outcome: 'delivered', receipt: 'ok', at: 1 },
      },
    }),
  })
  // Startup orphan request sweep cleans ghost caller while keeping living Bots' requests!
  await settle(() => host.rt.state.requests['ghost\u0000chat\u0000orphan'] === undefined, 2000, 'startup pruneOrphanRequests must remove deleted-Bot requests')
  assert.ok(host.rt.state.requests['a\u0000chat\u0000keep-me'], 'living Bot request must remain')
  assert.ok(host.rt.state.requests['c\u0000chat\u0000drop-on-delete'], 'living Bot request must remain before deleteBot')

  // Create a pair ledger with Reviewer ('c') then delete Reviewer -> both its requests and pair ledger drop!
  await host.rt.deliver({ fromId: 'a', toId: 'c', text: 'bye', role: 'note', wake: false })
  await host.rt.ledger.flush('pair-a-c')
  assert.equal(existsSync(join(host.home, 'ledger', 'pair-a-c.jsonl')), true)
  await host.rt.deleteBot('c')
  await host.rt.ledger.flush('pair-a-c')
  assert.equal(host.rt.state.requests['c\u0000chat\u0000drop-on-delete'], undefined, 'deleteBot must clean deleted Bot requests')
  assert.equal(existsSync(join(host.home, 'ledger', 'pair-a-c.jsonl')), false, 'deleteBot must drop deleted Bot pair ledgers')

  // pruneSettledTasks archives pruned settled task sessions when > MAX_SETTLED_TASKS (50).
  const chief = host.rt.botOf('a')
  chief.tasks = Array.from({ length: 50 }, (_, idx) => ({
    id: `k_old_${idx}`, title: `Old ${idx}`, brief: 'old', from: 'dm-a', sessionId: `old-task-sess-${idx}`,
    segments: idx === 0 ? [{ sessionId: 'old-task-seg-0', endedAt: 1 }] : [],
    origin: 'task-start', status: 'completed', startedAt: idx + 1, updatedAt: idx + 1, endedAt: idx + 2,
  }))
  const startRes = await host.tool('task_start', { title: 'Task 51', brief: 'triggers prune' }, 'dm-a')
  assert.match(startRes, /^Started background task/, `task_start failed: ${startRes}`)
  const newestTask = chief.tasks.at(-1)
  host.agents.get(newestTask.sessionId).inbox.nextTurn.length = 0
  host.emit(newestTask.sessionId, 'turn/start', { turn: 1 })
  host.emit(newestTask.sessionId, 'assistant/message', assistantText('Done 51'))
  host.emit(newestTask.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => archiveCalls.some(c => c.sid === 'old-task-sess-0'), 4000, 'pruneSettledTasks must archive pruned task session')
  await settle(() => archiveCalls.some(c => c.sid === 'old-task-seg-0'), 4000, 'pruneSettledTasks must archive pruned task segments too')
  assert.equal(archiveCalls.find(c => c.sid === 'old-task-seg-0').opts?.stopActivity, undefined, 'archiving a pruned task must not forcibly stop Session activity')

  // 2) F10: feed.js skips taskOwners events & streams, and displayItems/feed/tails suppress silent [PASS] on Bot-triggered own-chat turns!
  const abort = new AbortController()
  t.after(() => abort.abort())
  const feedRes = await host.routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const reader = feedRes.body.getReader()
  const decoder = new TextDecoder()
  const received = []
  void (async () => {
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (let idx = buf.indexOf('\n\n'); idx >= 0; idx = buf.indexOf('\n\n')) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = block.split('\n').find(l => l.startsWith('event: '))?.slice(7)
        const dataLine = block.split('\n').find(l => l.startsWith('data: '))?.slice(6)
        if (ev && dataLine) received.push({ event: ev, data: JSON.parse(dataLine) })
      }
    }
  })()
  await settle(() => received.some(e => e.event === 'hello'), 1000)

  // Prime chatTail for dm-a.
  host.rt.chatTail('dm-a')
  await realDelay(20)

  // Start an active task on Chief and emit assistant/message + stream -> MUST NOT appear in foreground SSE feed!
  await host.tool('task_start', { title: 'Hidden task', brief: 'bg work' }, 'dm-a')
  const activeTask = host.rt.botOf('a').tasks.find(item => item.title === 'Hidden task')
  host.emit(activeTask.sessionId, 'turn/start', { turn: 1 })
  host.emit(activeTask.sessionId, 'assistant/message', assistantText('raw background task output'))
  for (const fn of host.ctx.listeners.get('agent/assistant-stream') ?? []) {
    fn({ agent: { id: activeTask.sessionId }, frame: { type: 'start', attemptId: 'att-task', turn: 1 } })
    fn({ agent: { id: activeTask.sessionId }, frame: { type: 'chunk', attemptId: 'att-task', chunk: { type: 'text-delta', text: 'raw task stream' } } })
  }

  // Emit a Bot-triggered own-chat reply turn outputting [PASS] -> suppressed in feed AND chatTail BEFORE turn/end!
  host.emit('dm-a', 'turn/start', { turn: 20 })
  host.emit('dm-a', 'user/message', { content: textBlock('[Work completed by Writer · closed]\ndone'), source: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b', exchangeId: 'rep-pass-1' } })
  host.emit('dm-a', 'assistant/message', assistantText('[PASS]'))

  // Emit a user-triggered turn outputting （收工。） -> MUST stay visible in feed and chatTail!
  host.emit('dm-a', 'turn/start', { turn: 21 })
  host.emit('dm-a', 'user/message', { content: textBlock('收工了吗'), source: { kind: 'user' } })
  host.emit('dm-a', 'assistant/message', assistantText('（收工。）'))
  host.emit('dm-a', 'turn/end', { turn: 21, reason: { kind: 'completed' } })

  await settle(() => received.some(e => e.event === 'message' && e.data?.item?.text === '（收工。）'), 1500)
  assert.equal(received.some(e => e.data?.sessionId === activeTask.sessionId), false, 'feed.js must never publish taskOwners events or streams')
  assert.equal(received.some(e => e.event === 'message' && e.data?.item?.text === '[PASS]'), false, 'feed.js must never flash silent [PASS] on Bot-triggered turn')
  assert.equal(host.rt.chatTail('dm-a')?.preview, '（收工。）', 'sidebar tail must show real user turn, never [PASS]')

  // P2-1: displayItems with seedTurn (historical mid-turn slice whose assistant/message omits event.data.turn)
  // must NOT be misclassified as live Bot-triggered turn when live.turn !== seedTurn!
  host.rt.live.set('dm-a', { turn: 30, info: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b' } })
  const histItems = host.rt.displayItems('dm-a', [{ type: 'assistant/message', seq: 5, time: 1, data: assistantText('[PASS]') }], undefined, 1)
  assert.equal(histItems.length, 1, 'historical mid-turn slice with seedTurn !== live.turn must not be suppressed by live Bot turn')
  host.rt.live.delete('dm-a')

  // 3) weixin.js: repeated consecutive identical transient poll failures coalesce and log recovery count.
  let pollCalls = 0
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url === '/ilink/bot/msg/notifystart') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ret: 0 }))
        return
      }
      if (req.url === '/ilink/bot/getupdates') {
        pollCalls += 1
        if (pollCalls <= 5) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ret: 500 }))
          return
        }
        if (pollCalls <= 7) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html>gateway error</html>')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'ok-1' }))
      }
    })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const warns = []
  const base = `http://127.0.0.1:${srv.address().port}/`
  const runtime = {}
  const handle = weixin.connect(
    { token: 'tok', baseUrl: '' },
    {
      fetch: globalThis.fetch,
      WebSocket: globalThis.WebSocket,
      config: { api: base, qr: base, cdn: `${base}cdn`, startRetryDelaysMs: [5], pollRetryMs: 5 },
      runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
      log: { warn: (...args) => warns.push(format(...args)) },
    },
    { onMessage: () => {}, onAction: () => {}, onStatus: () => {} },
  )
  t.after(() => { handle.stop(); srv.closeAllConnections?.(); srv.close() })
  await settle(() => runtime.cursor === 'ok-1', 3000, 'weixin poll must recover after transient errors')
  handle.stop()

  // 5 identical ret=500 errors logged ONCE (plus 1 summary when error changed), 2 unreadable logged ONCE, then 1 recovery log!
  assert.equal(warns.filter(w => w.includes('getupdates answered 500')).length, 1, `ret=500 must be coalesced: ${JSON.stringify(warns)}`)
  assert.ok(warns.some(w => /previous error repeated 5 times/.test(w)), `error change must report prior repeat count: ${JSON.stringify(warns)}`)
  assert.equal(warns.filter(w => w.includes('poll failed: WeChat answered an unreadable response')).length, 1, `unreadable repeats must be coalesced: ${JSON.stringify(warns)}`)
  assert.ok(warns.some(w => /recovered after 2 consecutive failures/.test(w)), `recovery must report suppressed count: ${JSON.stringify(warns)}`)
})

test('P1 merge regression (turns.js): aborted turn settles live roomWaiter without falsely coalescing away waiterless room calls in same room/scope', async (t) => {
  const host = await startHost(t, {
    team: makeTeam({
      rooms: {
        r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} },
      },
    }),
  })
  // 1) Same (roomId, askedBy) scope: live waiter settles with null, waiterless call STILL redelivers.
  const callsBefore1 = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nPrimary work'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'primary-abort-1' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nLive waiter call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-live-scoped' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nWaiterless same-scope call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-waiterless-scoped' } })
  let scopedWaiterResult = 'pending'
  host.rt.roomWaiters.set('joined-live-scoped', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { scopedWaiterResult = value },
    fail: failure => { scopedWaiterResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(scopedWaiterResult, null, 'live roomWaiter must settle immediately with null on abort')
  assert.equal(host.rt.roomWaiters.has('joined-live-scoped'), false)
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > callsBefore1, 1500, 'waiterless same-scope call must not be coalesced away by aborted live waiter')
  const added1 = host.agents.get('gb').calls.slice(callsBefore1).map(([, msg]) => msg)
  assert.deepEqual(added1.map(m => m.source?.exchangeId), ['joined-waiterless-scoped'])
  assert.equal(added1[0].source?.deferred, true)

  // 2) Room-wide (askedBy undefined): live waiter settles with null, room-wide waiterless call STILL redelivers.
  const callsBefore2 = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nPrimary work 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'primary-abort-2' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nLive waiter call 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-live-room' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nWaiterless room-wide call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-waiterless-room' } })
  let roomWaiterResult = 'pending'
  host.rt.roomWaiters.set('joined-live-room', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { roomWaiterResult = value },
    fail: failure => { roomWaiterResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(roomWaiterResult, null, 'room-wide live roomWaiter must settle immediately with null on abort')
  assert.equal(host.rt.roomWaiters.has('joined-live-room'), false)
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > callsBefore2, 1500, 'room-wide waiterless call must not be coalesced away by aborted live waiter')
  const added2 = host.agents.get('gb').calls.slice(callsBefore2).map(([, msg]) => msg)
  assert.deepEqual(added2.map(m => m.source?.exchangeId), ['joined-waiterless-room'])
  assert.equal(added2[0].source?.deferred, true)
})

test('P1 merge regression (resume.js): recoverTurnDeferred preserves deferred child replies and reports targeting task:<id> work nodes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-work-recover-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const attachment = { attachmentId: 'att-task-sub-1', mediaType: 'text/plain', name: 'build.log' }
  const team = makeTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {} },
    },
    works: {
      w_parent: { from: 'a', to: 'b', open: ['task:k_1'], results: [], at: 1 },
      'task:k_1': { from: 'b', parent: 'w_parent', toSession: 'task-b-1', toTaskId: 'k_1', name: 'task "Build"', child: 'k_1', open: ['w_sub_1', 'rep_1'], results: [], at: 2 },
      'task:k_other': { from: 'a', parent: 'w_other', toSession: 'task-a-1', toTaskId: 'k_other', name: 'task "Other"', child: 'k_other', open: ['w_sub_other'], results: [], at: 2 },
    },
  })
  team.bots.b.tasks = [{
    id: 'k_1', title: 'Build', brief: 'run build', from: 'dm-b', sessionId: 'task-b-1',
    segments: [], origin: 'task-start', workId: 'task:k_1', parentWorkId: 'w_parent',
    status: 'running', startedAt: 1, updatedAt: 1,
  }]
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      'task-b-1': { botId: 'b', turn: 1, since: 10 },
    },
    queued: {},
  }))

  const logs = new Map([
    ['task-b-1', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'task', taskId: 'k_1', exchangeId: 'task-init-1' }, content: textBlock('[Background task · Build]\nRun build') } },
      {
        type: 'user/message',
        seq: 3,
        data: {
          source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-task-reply-1', senderSessionId: 'c', senderName: 'Reviewer', work: 'task:k_1', replyTo: 'w_sub_1' },
          content: [{ type: 'text', text: '[Work completed by Reviewer]\nBuild log ready' }, { type: 'file', attachment }],
        },
      },
      {
        type: 'user/message',
        seq: 4,
        data: {
          source: { kind: SOURCE_KIND, role: 'report', exchangeId: 'ex-task-report-1', roomId: 'r1', work: 'task:k_1' },
          content: textBlock('[Group chat "Ops" · replies to your post]\nOps confirmed green'),
        },
      },
      {
        type: 'user/message',
        seq: 5,
        data: {
          source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-foreign-task-reply', senderSessionId: 'c', senderName: 'Reviewer', work: 'task:k_other', replyTo: 'w_sub_other' },
          content: textBlock('[Work completed by Reviewer]\nBelongs to Chief task, not Writer'),
        },
      },
      { type: 'assistant/message', seq: 6, data: assistantText('Checked initial step.') },
      { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host = await startHost(t, { home, team, logs })
  t.mock.timers.tick(3000)

  await settle(() => (host.agents.get('task-b-1')?.calls.length ?? 0) >= 2, 2000, 'deferred reply and report for task:k_1 must recover on restart')

  const delivered = host.agents.get('task-b-1').calls.map(([, msg]) => msg)
  const recoveredReply = delivered.find(m => m.source?.exchangeId === 'ex-task-reply-1')
  const recoveredReport = delivered.find(m => m.source?.exchangeId === 'ex-task-report-1')
  assert.ok(recoveredReply, 'deferred child reply targeting task:<id> work node must be recovered')
  assert.equal(recoveredReply.source?.deferred, true)
  assert.equal(recoveredReply.source?.work, 'task:k_1')
  assert.equal(recoveredReply.source?.replyTo, 'w_sub_1')
  assert.deepEqual(recoveredReply.content.filter(b => b.type === 'file').map(b => b.attachment), [attachment], 'recovered task child reply must preserve file attachments')
  assert.ok(recoveredReport, 'deferred group report targeting task:<id> work node must be recovered')
  assert.equal(recoveredReport.source?.deferred, true)
  assert.equal(recoveredReport.source?.work, 'task:k_1')
  assert.equal(recoveredReport.source?.roomId, 'r1')
  assert.equal(delivered.some(m => m.source?.exchangeId === 'ex-foreign-task-reply'), false, 'task:<id> owned by another Bot must not be recovered here')
  assert.equal(host.rt.botOf('b').tasks.find(item => item.id === 'k_1')?.status, 'running', 'task with recovered deferred replies must stay active, not be marked interrupted')
})
