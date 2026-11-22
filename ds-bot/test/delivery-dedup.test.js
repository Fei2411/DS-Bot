import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { answerSender } from '../src/host/turns.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

const settle = async (check, ms = 4000) => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), 'condition not reached')
}

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

const baseSeed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function createLoopRig(t, seed = baseSeed()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-loop-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  const stepGate = Promise.withResolvers()
  const modes = { b: 'two-step-fail', requestId: 'req-dup-1319', callCount: 0 }

  root.tools.register({
    name: 'wait_step',
    description: 'Pause mid-turn so another Bot message can steer in',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      await stepGate.promise
      return { ok: true }
    },
  })

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(options) {
      modes.callCount += 1
      if (options.sessionId === 'b') {
        const last = options.messages.at(-1)
        const hasToolResult = last?.role === 'tool'
        if (!hasToolResult && modes.b === 'two-step-fail') {
          const args = '{}'
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: `call_${modes.callCount}`, name: 'wait_step', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call_${modes.callCount}`, name: 'wait_step', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'INVALID_REQUEST',
              status: 400,
              message: `invalid tool payload (request_id: ${modes.requestId})`,
              requestId: modes.requestId,
            },
          },
        }
        return
      }
      const reply = `Handled ${options.messages.length}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['dedup-test'], new TestAdapter())
  await mountAgentLoopTestHarness(root)

  const agents = new Map()
  for (const id of Object.keys(seed.bots)) {
    const bot = seed.bots[id]
    const sessions = [bot.sessionId, ...(bot.openParts ?? []).map(part => part.sessionId)]
    for (const sessionId of sessions) {
      agents.set(sessionId, await root.agentLoop.create(SessionId(sessionId), { provider: 'dedup-test', model: 'test' }))
    }
  }

  const deliveries = []
  const ctx = fakeContext({
    services: {
      agents: root.agents,
      llm: root.llm,
      sessions: root.sessions,
      tools: root.tools,
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: agents.get(sessionId) }),
        create: async () => ({ sessionId: 's-unused' }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async sessionId => ({ events: agents.get(sessionId)?.session.snapshotEvents() ?? [] }),
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
    if (event.type === 'user/message' && event.data?.source?.kind === 'bot') {
      deliveries.push({ sessionId: session.id, source: event.data.source, text: textOf({ content: event.data.content }) })
    }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  root.on('agent/inbox/discarded', (payload) => {
    for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) listener(payload)
  })

  const rt = createRuntime(ctx, { home })
  // Exercise the in-turn steering path, not busy-foreground task spawning.
  t.mock.method(rt, 'shouldMoveForeground', () => false)
  t.after(async () => {
    stepGate.resolve()
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: agents.get(sessionId) })
  return { home, rt, agents, tool, stepGate, modes, deliveries }
}

async function createRestartHost(t, home, logs, services) {
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        inbox,
        status: 'idle',
        followup(message) { calls.push(message) },
        steer(message) { calls.push(message) },
        cancel() {},
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      inspect: async sessionId => ({ events: logs.get(sessionId) ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    const session = agents.get(id)?.session ?? { id }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  await rt.load()
  const host = { ctx, rt, agentOf, emit, stop: () => ctx.dispose() }
  return host
}

test('a failed turn with steered follow-ups pushes only one failure notice per request_id and settles open works', async (t) => {
  const { home, rt, agents, tool, stepGate, modes, deliveries } = await createLoopRig(t)

  // Chief sends an initial task to Writer; Writer starts working and pauses in wait_step.
  await tool('message_bot', { to: 'Writer', message: 'Run task 1' }, 'a')
  await settle(() => modes.callCount >= 1 && rt.live.get('b')?.tool === 'wait_step')

  // While Writer is mid-turn, Chief steers a follow-up update (default when: 'now').
  await tool('message_bot', { to: 'Writer', message: 'Also include check 2' }, 'a')
  await settle(() => agents.get('b').inbox.nextStep.length === 1)

  // Let wait_step finish so Writer claims the steered follow-up and hits INVALID_REQUEST.
  stepGate.resolve()
  await agents.get('b').whenIdle()
  await settle(() => deliveries.some(entry => entry.sessionId === 'a' && entry.source.role === 'reply'))
  await agents.get('a').whenIdle()
  await realDelay(30)

  const failureRepliesToChief = deliveries.filter(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-dup-1319'))
  assert.equal(failureRepliesToChief.length, 1, 'Chief must receive the failure notice for req-dup-1319 only once')
  // The works are closed in memory; their save is queued without being awaited. Write
  // the state before reading the file, so a slow CI disk cannot show a stale work.
  await rt.save({ required: true })
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.works ?? {}), [], 'all works bound to the failed turn must be closed')

  // A subsequent turn that fails with a new request_id still notifies Chief.
  modes.b = 'fail-once'
  modes.requestId = 'req-new-456'
  await tool('message_bot', { to: 'Writer', message: 'Retry with clean args' }, 'a')
  await agents.get('b').whenIdle()
  await settle(() => deliveries.some(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-new-456')))
  await agents.get('a').whenIdle()
  const newReplies = deliveries.filter(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-new-456'))
  assert.equal(newReplies.length, 1)
})

test('answerSender is idempotent per exchangeId and per failure requestId while preserving late replies after abandonWork', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-answer-'))
  const seed = baseSeed()
  seed.works = {
    'ex-1': { from: 'a', to: 'b', open: [], results: [], at: 1 },
    'ex-parent': { from: 'a', to: 'b', open: ['ex-child-1', 'ex-child-2'], results: [], at: 1 },
    'ex-child-1': { from: 'a', to: 'b', parent: 'ex-parent', open: [], results: [], at: 2 },
    'ex-child-2': { from: 'a', to: 'b', parent: 'ex-parent', open: [], results: [], at: 3 },
    'ex-abandoned-parent': { from: 'a', to: 'a', open: ['ex-late'], results: [], at: 1 },
    'ex-late': { from: 'a', to: 'b', parent: 'ex-abandoned-parent', open: [], results: [], at: 2 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const host = await createRestartHost(t, home, new Map())
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const { rt } = host
  const src1 = { kind: 'bot', role: 'reply', exchangeId: 'ex-1', senderSessionId: 'b' }
  const req1 = { kind: 'bot', role: 'request', exchangeId: 'ex-1', senderSessionId: 'a' }
  answerSender(rt, 'b', req1, 'Final report verbatim')
  answerSender(rt, 'b', req1, 'Final report verbatim')
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 1, 'same exchangeId must only deliver once')

  // Failure deduplication by requestId also cleans up duplicate child open work entries.
  const child1 = { kind: 'bot', role: 'request', exchangeId: 'ex-child-1', senderSessionId: 'a' }
  const child2 = { kind: 'bot', role: 'request', exchangeId: 'ex-child-2', senderSessionId: 'a' }
  const failure = { code: 'INVALID_REQUEST', status: 400, requestId: 'req-same-99', message: 'bad arg' }
  answerSender(rt, 'b', child1, 'Writer failed (req-same-99)', undefined, { failure })
  answerSender(rt, 'b', child2, 'Writer failed (req-same-99)', undefined, { failure })
  await settle(() => host.agentOf('a').calls.length >= 2)
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 2, 'same requestId failure must only deliver once')
  assert.equal(rt.state.works['ex-child-2'], undefined, 'suppressed duplicate work must be removed')
  assert.deepEqual(rt.state.works['ex-parent'].open, ['ex-child-1'], 'suppressed duplicate must not stay stuck in parent.open')

  // abandonWork + late answer still delivers once, then a replay is blocked.
  rt.abandonWork('ex-late', 'user')
  await settle(() => host.agentOf('a').calls.length >= 3)
  const lateSource = { kind: 'bot', role: 'request', exchangeId: 'ex-late', senderSessionId: 'a' }
  answerSender(rt, 'b', lateSource, 'Actual late completion')
  await settle(() => host.agentOf('a').calls.length >= 4)
  answerSender(rt, 'b', lateSource, 'Actual late completion')
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 4, 'late reply arrives once and replay is blocked')
  assert.equal(src1.exchangeId, 'ex-1')
})

test('reconcileEnded does not duplicate replies or request_id failures after the asker moves to a fresh part', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-'))
  const logs = new Map()
  const seed = baseSeed()
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  const first = await createRestartHost(t, home, logs)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const request = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'ex-part-switch', senderName: 'Chief', senderSessionId: 'a' }
  first.rt.openWork('ex-part-switch', { from: 'a', to: 'b' })
  first.emit('b', 'turn/start', { turn: 1 })
  first.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nCheck' }], source: request })
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })

  // Deliver the reply to part 'a', Chief consumes it, then Chief advances to part 'a-2'.
  await first.rt.deliver({ fromId: 'b', toId: 'a', sessionId: 'a', text: 'The plan is ready.', role: 'reply', replyTo: 'ex-part-switch', exchangeId: 'reply-1' })
  const deliveredReply = first.agentOf('a').calls[0]
  first.emit('a', 'user/message', { content: deliveredReply.content, source: deliveredReply.source })
  first.rt.state.bots.a.segments = [{ sessionId: 'a', endedAt: 10 }]
  first.rt.state.bots.a.sessionId = 'a-2'
  await first.rt.save({ required: true })

  // Leave inflight.turns.b active as if plugin reload/restart happened before Writer's turn/end persisted,
  // while Writer's durable log holds the completed turn and Chief's new part 'a-2' has no record of it.
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: request, content: [{ type: 'text', text: '[Message from Chief]\nCheck' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  logs.set('a-2', [])
  await first.stop()

  const second = await createRestartHost(t, home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  await realDelay(30)

  assert.equal(second.agentOf('a-2').calls.length, 0, 'reply already in pair ledger must not be re-delivered after part switch')
  assert.equal(second.agentOf('a').calls.length, 0)
  assert.equal(second.agentOf('b').calls.length, 0)
  await second.stop()
})

test('resumeAll settles already-ended turns from disk without re-running or duplicating replies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-resume-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.works = { 'ex-ended': { from: 'a', to: 'b', open: [], results: [], at: 1 } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const logs = new Map()
  const request = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'ex-ended', senderName: 'Chief', senderSessionId: 'a' }
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: request, content: [{ type: 'text', text: '[Message from Chief]\nFinish' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Already finished answer.' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  logs.set('a', [])

  // Pre-seed inflight.turns as left behind if inflight.json did not clear on crash.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'ex-ended', senderSessionId: 'a' } } },
    queued: {},
  }))

  const first = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => first.agentOf('a').calls.length >= 1 || first.agentOf('b').calls.length >= 1)
  assert.equal(first.agentOf('b').calls.length, 0, 'completed turn on disk must not be re-run with resumeTurn')
  assert.equal(first.agentOf('a').calls.length, 1, 'completed turn reply must settle to Chief once')
  assert.match(textOf(first.agentOf('a').calls[0]), /Already finished answer\./)
  await first.stop()

  // Second crash before inflight clears: now reply is already in pair ledger, so nothing is re-sent.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'ex-ended', senderSessionId: 'a' } } },
    queued: {},
  }))
  const second = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  await realDelay(30)
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(second.agentOf('a').calls.length, 0, 'already-delivered reply must not be sent again')
  await second.stop()
})

async function checkAttachmentRecovery(t, prefix) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-attachment-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const services = { attachments: fakeAttachments() }
  const seed = baseSeed()
  seed.works = {
    parent: { from: 'user', to: 'a', open: ['child'], results: [], at: 1 },
    child: { from: 'a', to: 'b', parent: 'parent', open: [], results: [], at: 1 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const logs = new Map()
  const first = await createRestartHost(t, home, logs, services)
  const full = '结论\n'.repeat(70_000) + 'End of report.'
  const attachment = await first.rt.attachLong(full, 'Answer from Writer.txt')
  await first.rt.deliver({
    fromId: 'b', toId: 'a', ...attachment, role: 'reply', replyTo: 'child',
    text: prefix + attachment.text, length: prefix.length + attachment.length,
  })
  first.emit('a', 'user/message', { source: first.agentOf('a').calls[0].source })
  await first.stop()

  const request = { kind: 'bot', role: 'request', exchangeId: 'child', senderSessionId: 'a' }
  logs.set('b', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: request } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: request } },
    queued: {},
  }))
  const restarted = await createRestartHost(t, home, logs, services)
  t.mock.timers.tick(3000)
  await settle(() => restarted.rt.state.works.child === undefined)
  assert.ok(restarted.rt.answerText('parent', '', 'Chief').endsWith(prefix + full), 'parent keeps the entire reply, not its preview or a dialog-sized prefix')
  assert.equal(restarted.agentOf('a').calls.length, 0)
  assert.equal(restarted.agentOf('b').calls.length, 0)
  await restarted.stop()
}

test('restart keeps the full attachment-backed reply in the parent work without re-delivery', t => checkAttachmentRecovery(t, ''))

test('restart keeps the fallback notice with the full attachment-backed reply', t => checkAttachmentRecovery(t, 'Writer could not send its reply to you (offline); what it had answered:\n'))

test('restart settles a completed peer handoff task from disk and replies to the asking Bot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-task-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const seed = baseSeed()
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Peer request', origin: 'bot-handoff', status: 'running', exchangeId: 'child' }]
  seed.works = { child: { from: 'a', to: 'b', open: [], results: [], at: 1 } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const request = { kind: 'bot', role: 'request', exchangeId: 'child', senderSessionId: 'a' }
  const logs = new Map([['b-task', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: request } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Peer task finished.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { 'b-task': { botId: 'b', since: 1, trigger: request } },
    queued: {},
  }))
  const host = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => host.rt.state.bots.b.tasks[0].status === 'completed' && host.agentOf('a').calls.length > 0)
  assert.equal(host.agentOf('a').calls.length, 1)
  assert.match(textOf(host.agentOf('a').calls[0]), /Peer task finished\./)
  assert.equal(host.agentOf('b-task').calls.length, 0)
  assert.equal(host.agentOf('b').calls.length, 0)
  await host.stop()
})

async function checkUnreadTaskReply(t, inInbox) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-task-queued-'))
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Reviewer', role: 'Reviewer', sessionId: 'c', createdAt: 3 }
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Peer request', origin: 'bot-handoff', status: 'waiting_work', exchangeId: 'request' }]
  seed.works = {
    request: { from: 'a', to: 'b', open: ['review'], results: [{ id: 'review', name: 'Reviewer', text: 'Review result.' }], at: 1 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const request = { kind: 'bot', role: 'request', exchangeId: 'request', senderSessionId: 'a' }
  const reply = { fromId: 'c', toId: 'b', sessionId: 'b-task', role: 'reply', replyTo: 'review', work: 'request', exchangeId: 'review-reply', text: 'Review result.' }
  const logs = new Map([['b-task', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: request } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Waiting for review.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { 'b-task': { botId: 'b', since: 1, trigger: request } },
    queued: inInbox ? {} : { 'b-task': [{ at: 2, args: reply }] },
  }))
  const host = await createRestartHost(t, home, logs)
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  if (inInbox) host.agentOf('b-task').inbox.nextTurn.push({ source: { kind: 'bot', exchangeId: reply.exchangeId } })
  const reconciliation = t.mock.method(host.rt, 'reconcileTasksAfterRestart')
  t.mock.timers.tick(3000)
  await settle(() => reconciliation.mock.callCount() > 0)
  await reconciliation.mock.calls[0].result
  assert.deepEqual(host.agentOf('b-task').calls.map(({ source }) => source.exchangeId), inInbox ? [] : ['review-reply'])
  assert.equal(host.agentOf('b').calls.length, 0)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.equal(host.rt.state.bots.b.tasks[0].status, 'waiting_work')
  assert.deepEqual(host.rt.state.works.request.open, ['review'])
}

test('restart replays an unread child reply in its background task without rerunning the earlier turn', t => checkUnreadTaskReply(t, false))

test('restart keeps a task active when a child reply is still in the agent inbox', t => checkUnreadTaskReply(t, true))

test('answerSender keeps separate continuations for distinct parent works sharing a failed turn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-parents-'))
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    'ex-no-parent': { from: 'a', to: 'b', open: [], results: [], at: 1 },
    'parent-1': { from: 'c', to: 'a', open: ['child-p1'], results: [], at: 1 },
    'child-p1': { from: 'a', to: 'b', parent: 'parent-1', open: [], results: [], at: 2 },
    'parent-2': { from: 'c', to: 'a', open: ['child-p2'], results: [], at: 1 },
    'child-p2': { from: 'a', to: 'b', parent: 'parent-2', open: [], results: [], at: 3 },
    'parent-consumed': { from: 'c', to: 'a', open: ['child-c1', 'child-c2'], results: [], at: 1 },
    'child-c1': { from: 'a', to: 'b', parent: 'parent-consumed', open: [], results: [], at: 2 },
    'child-c2': { from: 'a', to: 'b', parent: 'parent-consumed', open: [], results: [], at: 3 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const host = await createRestartHost(t, home, new Map())
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const { rt } = host
  const failure = { code: 'INVALID_REQUEST', status: 400, requestId: 'req-shared-parents', message: 'bad' }
  const dedupKey = 'turn:b:1:error:req-shared-parents'

  // Unparented work followed by parent-1 and parent-2 in the same failed turn: each distinct
  // parent work must receive its own continuation carrying `work`.
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'ex-no-parent', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-p1', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-p2', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  await settle(() => host.agentOf('a').calls.length >= 3)
  assert.deepEqual(
    host.agentOf('a').calls.map(msg => [msg.source.replyTo, msg.source.work]),
    [['ex-no-parent', undefined], ['child-p1', 'parent-1'], ['child-p2', 'parent-2']],
    'distinct parent works must never be suppressed by another parent or unparented failure',
  )

  // Same parent work, but once the first failed child was already consumed out of parent.open,
  // a second child's failure must still deliver so the parked parent is woken up.
  const sameParentFailure = { code: 'INVALID_REQUEST', status: 400, requestId: 'req-consumed-parent', message: 'bad' }
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-c1', senderSessionId: 'a' }, 'Writer failed', undefined, { failure: sameParentFailure }), true)
  await settle(() => host.agentOf('a').calls.length >= 4)
  rt.takenWork('parent-consumed', 'child-c1')
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-c2', senderSessionId: 'a' }, 'Writer failed', undefined, { failure: sameParentFailure }), true)
  await settle(() => host.agentOf('a').calls.length >= 5)
  assert.deepEqual(
    [host.agentOf('a').calls[4].source.replyTo, host.agentOf('a').calls[4].source.work],
    ['child-c2', 'parent-consumed'],
  )
})

test('resumeAll checks the upstream work and asker for role=reply continuation turns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reply-resume-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    'up-work': { from: 'c', to: 'a', open: [], results: [{ id: 'sub-req', from: 'Writer', text: 'sub done' }], at: 1 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const logs = new Map([['a', []], ['b', []], ['c', []]])

  // First boot: Writer already delivered the child reply (`sub-reply` -> `sub-req`) to Chief,
  // and Chief was interrupted mid-continuation (`role: 'reply'`) before answering Lead (`up-work`).
  // resumeAll must NOT mistake the child reply for an already-delivered upstream answer.
  const seedHost = await createRestartHost(t, home, logs)
  await seedHost.rt.deliver({
    fromId: 'b', toId: 'a', sessionId: 'a', text: 'sub done',
    role: 'reply', replyTo: 'sub-req', exchangeId: 'sub-reply', work: 'up-work',
  })
  await seedHost.stop()

  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      a: {
        botId: 'a',
        since: 1,
        trigger: { role: 'reply', exchangeId: 'sub-reply', work: 'up-work', senderSessionId: 'b' },
      },
    },
    queued: {},
  }))
  const first = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => first.agentOf('a').calls.length >= 1)
  assert.equal(first.agentOf('a').calls[0].source.role, 'resume')
  assert.equal(first.agentOf('a').calls[0].source.work, 'up-work', 'unanswered upstream work must resume')

  // Now Chief delivers the upstream answer to Lead (`up-work`), then crashes before inflight clears.
  await first.rt.deliver({
    fromId: 'a', toId: 'c', sessionId: 'c', text: 'upstream final answer',
    role: 'reply', replyTo: 'up-work', exchangeId: 'up-reply',
  })
  await first.stop()

  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      a: {
        botId: 'a',
        since: 2,
        trigger: { role: 'reply', exchangeId: 'sub-reply', work: 'up-work', senderSessionId: 'b' },
      },
    },
    queued: {},
  }))
  const second = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  await realDelay(30)
  assert.equal(second.agentOf('a').calls.length, 0, 'already-answered upstream work must not resume again')
  assert.equal(second.agentOf('c').calls.length, 0, 'already-delivered upstream reply must not duplicate')
  assert.equal(second.rt.state.works['up-work'], undefined, 'upstream work is closed once confirmed delivered')
  await second.stop()
})

test('reconcileEnded settles distinct parent works that steered into the same failed turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-steered-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    'p1': { from: 'c', to: 'a', open: ['req-1'], results: [], at: 1 },
    'p2': { from: 'c', to: 'a', open: ['req-2'], results: [], at: 1 },
    'req-1': { from: 'a', to: 'b', parent: 'p1', open: [], results: [], at: 2 },
    'req-2': { from: 'a', to: 'b', parent: 'p2', open: [], results: [], at: 3 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const req1 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-1', senderName: 'Chief', senderSessionId: 'a' }
  const req2 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-2', senderName: 'Chief', senderSessionId: 'a' }
  const logs = new Map([
    ['a', []],
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: req1, content: [{ type: 'text', text: 'first' }] } },
      { type: 'user/message', seq: 3, data: { source: req2, content: [{ type: 'text', text: 'second' }] } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'error', error: { code: 'INVALID_REQUEST', status: 400, requestId: 'req-rec-1', message: 'bad' } } } },
    ]],
  ])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'req-1', senderSessionId: 'a' } } },
    queued: {},
  }))

  const host = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length >= 2)
  assert.deepEqual(
    host.agentOf('a').calls.map(msg => [msg.source.replyTo, msg.source.work]),
    [['req-1', 'p1'], ['req-2', 'p2']],
    'reconcileEnded must notify every distinct parent work steered into the failed turn',
  )
  await host.stop()
})

// A turn that completed successfully but crashed before the deferred delivery of a
// request it read as steering leaves that request open: its caller or parent waits
// forever. The durable log still holds it, so the next start hands it back.
test('a completed turn hands a steered request back after a restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-completed-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    p1: { from: 'c', to: 'a', open: ['req-1'], results: [], at: 1 },
    p2: { from: 'c', to: 'a', open: ['req-2'], results: [], at: 1 },
    'req-1': { from: 'a', to: 'b', parent: 'p1', open: [], results: [], at: 2 },
    'req-2': { from: 'a', to: 'b', parent: 'p2', open: [], results: [], at: 3 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const req1 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-1', senderName: 'Chief', senderSessionId: 'a' }
  const req2 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-2', senderName: 'Chief', senderSessionId: 'a' }
  const image = { id: 'img-1', name: 'shot.png', mediaType: 'image/png' }
  const logs = new Map([
    ['a', []],
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: req1, content: [{ type: 'text', text: 'first' }] } },
      { type: 'user/message', seq: 3, data: { source: req2, content: [{ type: 'text', text: 'second' }, { type: 'image', attachment: image }] } },
      { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'req-1', senderSessionId: 'a' } } },
    queued: {},
  }))

  const host = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length >= 1 && host.agentOf('b').calls.length >= 1)

  const replies = host.agentOf('a').calls
  assert.equal(replies.filter(msg => msg.source.replyTo === 'req-1').length, 1, 'the primary request is answered once')
  assert.equal(replies.filter(msg => msg.source.replyTo === 'req-2').length, 0, 'the steered request is not answered with the turn\'s text')
  const handed = host.agentOf('b').calls
  assert.equal(handed.length, 1, 'the steered request is handed back once')
  assert.equal(handed[0].source.exchangeId, 'req-2')
  assert.equal(handed[0].source.role, 'request')
  assert.equal(handed[0].source.deferred, true, 'it reads as one the Bot already read')
  assert.match(textOf(handed[0]), /second/, 'the request keeps its text')
  assert.match(textOf(handed[0]), /answer it now/, 'it asks for the turn it still owes')
  assert.deepEqual(handed[0].content.filter(block => block.type === 'image').map(block => block.attachment), [image], 'the attachments are kept')

  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.works['req-1'], undefined, 'the answered request is closed')
  assert.deepEqual(state.works['req-2'], seed.works['req-2'], 'the handed-back request keeps its work and parent')
  assert.deepEqual(state.works['p2'].open, ['req-2'], 'its parent work still waits for it')
  await host.stop()
})

// The deferred delivery may already be in the durable log when the crash happens; it
// must not be handed back a second time.
test('a request already deferred before the crash is not handed back twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-deferred-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    p1: { from: 'c', to: 'a', open: ['req-1'], results: [], at: 1 },
    p2: { from: 'c', to: 'a', open: ['req-2'], results: [], at: 1 },
    'req-1': { from: 'a', to: 'b', parent: 'p1', open: [], results: [], at: 2 },
    'req-2': { from: 'a', to: 'b', parent: 'p2', open: [], results: [], at: 3 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const req1 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-1', senderName: 'Chief', senderSessionId: 'a' }
  const req2 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-2', senderName: 'Chief', senderSessionId: 'a' }
  const logs = new Map([
    ['a', []],
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: req1, content: [{ type: 'text', text: 'first' }] } },
      { type: 'user/message', seq: 3, data: { source: req2, content: [{ type: 'text', text: 'second' }] } },
      { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 6, data: { source: { ...req2, deferred: true }, content: [{ type: 'text', text: '[Message from Chief · you read it during your last task; answer it now]\nsecond' }] } },
    ]],
  ])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'req-1', senderSessionId: 'a' } } },
    queued: {},
  }))

  const host = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.filter(msg => msg.source.replyTo === 'req-1').length, 1, 'the primary request is answered once')
  assert.equal(host.agentOf('b').calls.length, 0, 'the deferred request is not handed back again')
  assert.deepEqual(host.rt.state.works['p2'].open, ['req-2'], 'its parent work is still waiting for its own turn')
  await host.stop()
})

// A completed turn with two steered requests under independent parent works, ready for
// a restart to recover the second one.
function completedSteerFixture() {
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.works = {
    p1: { from: 'c', to: 'a', open: ['req-1'], results: [], at: 1 },
    p2: { from: 'c', to: 'a', open: ['req-2'], results: [], at: 1 },
    'req-1': { from: 'a', to: 'b', parent: 'p1', open: [], results: [], at: 2 },
    'req-2': { from: 'a', to: 'b', parent: 'p2', open: [], results: [], at: 3 },
  }
  const req1 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-1', senderName: 'Chief', senderSessionId: 'a' }
  const req2 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-2', senderName: 'Chief', senderSessionId: 'a' }
  const logs = new Map([
    ['a', []],
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: req1, content: [{ type: 'text', text: 'first' }] } },
      { type: 'user/message', seq: 3, data: { source: req2, content: [{ type: 'text', text: 'second' }] } },
      { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])
  return { seed, logs, req2 }
}

function completedSteerHome(t, name, seed) {
  const home = mkdtempSync(join(tmpdir(), `ds-bot-${name}-`))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { b: { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'req-1', senderSessionId: 'a' } } },
    queued: {},
  }))
  return home
}

// Hold the agent resolution recovery makes for its own inbox check (the second one
// for this Session: resumeAll resolves the Session first to see whether it still
// runs), so the test can let the normal path act between that check and the delivery.
function holdRecoveryResolve(host) {
  const gate = Promise.withResolvers()
  const release = Promise.withResolvers()
  const resolve = host.ctx.sessionController.resolveAgent
  let seen = 0
  host.ctx.sessionController.resolveAgent = async (id) => {
    if (id === 'b' && ++seen === 2) { gate.resolve(); await release.promise }
    return resolve(id)
  }
  return { gate: gate.promise, release: () => release.resolve() }
}

// Run one normal deferred delivery of the same request just before recovery delivers
// it, the way the live turn path can.
function commitBeforeRecovery(host, req2) {
  const real = host.rt.deliver
  let injected = false
  host.rt.deliver = async (args) => {
    if (!injected && args.deferred === true && args.exchangeId === req2.exchangeId) {
      injected = true
      // In flight, not awaited: recovery must meet the delivery already going.
      void real({ fromId: 'a', toId: 'b', sessionId: 'b', text: 'second', role: 'request', exchangeId: req2.exchangeId, deferred: true })
    }
    return real(args)
  }
}

test('recovery does not hand a request back again when the normal path delivered it first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { seed, logs, req2 } = completedSteerFixture()
  const home = completedSteerHome(t, 'ds-bot-dedup-reconcile-raced', seed)
  const host = await createRestartHost(t, home, logs)
  commitBeforeRecovery(host, req2)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length >= 1 && host.agentOf('b').calls.length >= 1)
  await realDelay(30)
  const handed = host.agentOf('b').calls.filter(msg => msg.source.exchangeId === 'req-2' && msg.source.deferred === true)
  assert.equal(handed.length, 1, 'the request is handed back exactly once')
  await host.stop()
})


test('a deferred delivery that failed is sent again on retry in the same run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-retry-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  const host = await createRestartHost(t, home, new Map())
  t.after(() => host.stop())
  const agent = host.agentOf('b')
  const followup = agent.followup
  let follows = 0
  agent.followup = (message) => {
    follows += 1
    if (follows === 1) throw new Error('transient delivery failure')
    followup.call(agent, message)
  }
  const args = { fromId: 'a', toId: 'b', sessionId: 'b', text: 'retry me', role: 'request', exchangeId: 'req-retry', deferred: true }
  await assert.rejects(() => host.rt.deliver(args), /transient delivery failure/)
  await host.rt.deliver(args)
  assert.equal(follows, 2, 'the retry reaches the delivery again')
  assert.equal(host.agentOf('b').calls.filter(msg => msg.source.exchangeId === 'req-retry').length, 1, 'the retry lands in the inbox')
})

test('a concurrent duplicate waits for the delivery already going and shares its failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-concurrent-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  const host = await createRestartHost(t, home, new Map())
  t.after(() => host.stop())
  const agent = host.agentOf('b')
  const followup = agent.followup
  let follows = 0
  agent.followup = (message) => {
    follows += 1
    if (follows === 1) throw new Error('transient delivery failure')
    followup.call(agent, message)
  }
  const args = { fromId: 'a', toId: 'b', sessionId: 'b', text: 'send once', role: 'request', exchangeId: 'req-once', deferred: true }
  const first = host.rt.deliver(args)
  const second = host.rt.deliver({ ...args })
  await assert.rejects(first, /transient delivery failure/)
  await assert.rejects(second, /transient delivery failure/)
  assert.equal(follows, 1, 'the duplicate never starts a second delivery')
  assert.equal(host.agentOf('b').calls.filter(msg => msg.source.exchangeId === 'req-once').length, 0, 'nothing reached the inbox')
})

test('recovery does not hand a request back after its work closed while it checked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { seed, logs } = completedSteerFixture()
  const home = completedSteerHome(t, 'ds-bot-dedup-reconcile-closed', seed)
  const host = await createRestartHost(t, home, logs)
  const held = holdRecoveryResolve(host)
  t.mock.timers.tick(3000)
  await held.gate
  // The work is settled by the normal path while recovery waits on its checks.
  host.rt.closeWork('req-2', 'Writer', 'already answered')
  held.release()
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('b').calls.length, 0, 'a closed work has nothing left to answer')
  await host.stop()
})

// A turn that carried a steered request across a part switch holds it under
// source.joined on the handoff message rather than as a separate user/message.
// A crash between turn/end in the new part and deferred delivery must still recover it.
test('a steered request carried across a part switch via source.joined is recovered after a crash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-handoff-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  seed.bots.b.segments = [{ sessionId: 'b', endedAt: 10 }]
  seed.bots.b.sessionId = 'b-2'
  seed.works = {
    p1: { from: 'c', to: 'a', open: ['req-1'], results: [], at: 1 },
    p2: { from: 'c', to: 'a', open: ['req-2'], results: [], at: 1 },
    'req-1': { from: 'a', to: 'b', parent: 'p1', open: [], results: [], at: 2 },
    'req-2': { from: 'a', to: 'b', parent: 'p2', open: [], results: [], at: 3 },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const req2 = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'req-2', senderName: 'Chief', senderSessionId: 'a' }
  const handoff = {
    kind: 'bot',
    form: 'relay',
    role: 'request',
    exchangeId: 'req-1',
    senderName: 'Chief',
    senderSessionId: 'a',
    handoff: true,
    resume: true,
    joined: [{ info: req2, text: '[URGENT]\nsecond across switch' }],
  }
  const logs = new Map([
    ['a', []],
    ['b-2', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: handoff, content: [{ type: 'text', text: '# Handoff\nYou were in the middle of a turn.' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'first answer after switch' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { 'b-2': { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: 'req-1', senderSessionId: 'a' } } },
    queued: {},
  }))

  const host = await createRestartHost(t, home, logs)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length >= 1 && host.agentOf('b-2').calls.length >= 1)

  const replies = host.agentOf('a').calls
  assert.equal(replies.filter(msg => msg.source.replyTo === 'req-1').length, 1, 'the primary request is answered once')
  assert.equal(replies.filter(msg => msg.source.replyTo === 'req-2').length, 0, 'the carried request is not answered with the turn\'s text')
  const handed = host.agentOf('b-2').calls
  assert.equal(handed.length, 1, 'the carried steered request is handed back once')
  assert.equal(handed[0].source.exchangeId, 'req-2')
  assert.equal(handed[0].source.role, 'request')
  assert.equal(handed[0].source.deferred, true)
  assert.match(textOf(handed[0]), /\[URGENT\]\nsecond across switch/, 'the carried text is kept verbatim')
  assert.doesNotMatch(textOf(handed[0]), /# Handoff/, 'the handoff body is not re-sent as the steered request')
  assert.equal(host.rt.state.works['req-1'], undefined)
  assert.deepEqual(host.rt.state.works['p2'].open, ['req-2'])
  await host.stop()
})

// While recoverJoinedRequests awaits alreadyAnswered / resolveAgent, a live turn can
// already pick up the deferred exchangeId — clearing queued notes and inbox while the
// work is still open. Recovery must check rt.live before delivering a second copy.
test('recovery does not duplicate a request a newly started live turn already owns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { seed, logs, req2 } = completedSteerFixture()
  const home = completedSteerHome(t, 'ds-bot-dedup-reconcile-live-owned', seed)
  const host = await createRestartHost(t, home, logs)
  const held = holdRecoveryResolve(host)
  t.mock.timers.tick(3000)
  await held.gate

  // The Bot's next turn starts and reads req-2 while recovery is paused on resolveAgent:
  // unreadOf and agent.inbox are both empty, and req-2's work is still open.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'user/message', {
    content: [{ type: 'text', text: '[Message from Chief · you read it during your last task; answer it now]\nsecond' }],
    source: { ...req2, deferred: true },
  })
  assert.equal(host.rt.unreadOf('b').length, 0)
  assert.equal(host.rt.live.get('b')?.info?.exchangeId, 'req-2')

  held.release()
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('b').calls.length, 0, 'a request already owned by a live turn must not be delivered again')
  await host.stop()
})
