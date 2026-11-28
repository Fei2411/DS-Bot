import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { openCoordinationDb } from '../src/host/coordination-db.js'
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

function seedCoord(home, fn) {
  const db = openCoordinationDb({ path: join(home, 'coordination.sqlite') })
  try {
    fn(db)
  } finally {
    db.close()
  }
}

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
        page: async ({ address }) => {
          const sid = address?.sessionId ?? address?.childSessionId
          const events = agents.get(sid)?.session.snapshotEvents() ?? []
          return { records: events.map((event, idx) => ({ event: { seq: idx + 1, ...event } })), hasMore: false }
        },
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

async function createRestartHost(t, home, logs, services, { pageOverride, agentSetup, preloadAgents = [] } = {}) {
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = {
        nextStep: [],
        nextTurn: [],
        remove(msgId) {
          for (const list of [this.nextStep, this.nextTurn]) {
            const at = list.findIndex(item => item?.id === msgId)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const agent = {
        id: sessionId,
        session: {
          id: sessionId,
          snapshotEvents: () => (logs.get(sessionId) ?? []).map((event, idx) => ({ seq: idx + 1, ...event })),
        },
        calls,
        inbox,
        status: 'idle',
        followup(message) { calls.push(message); inbox.nextTurn.push(message) },
        steer(message) { calls.push(message); inbox.nextStep.push(message) },
        cancel() {},
      }
      agentSetup?.(sessionId, agent)
      agents.set(sessionId, agent)
    }
    return agents.get(sessionId)
  }
  for (const sid of preloadAgents) agentOf(sid)
  const ctx = fakeContext({ services: { ...services, agents } })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      // DSH's controller is a cordis service: its methods read this.ctx, so a
      // detached call throws. The ctx stub lets a pageOverride assert that.
      ctx: { fixture: true },
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: pageOverride ?? (async function ({ address }) {
        const sid = address?.sessionId ?? address?.childSessionId
        const records = (logs.get(sid) ?? []).map((event, idx) => ({ event: { seq: idx + 1, ...event } }))
        return { records, hasMore: false }
      }),
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
  const host = { ctx, rt, agents, agentOf, emit, stop: () => ctx.dispose() }
  return host
}

test('a failed turn with steered follow-ups pushes only one failure notice per request_id and settles open works', async (t) => {
  const { rt, agents, tool, stepGate, modes, deliveries } = await createLoopRig(t)

  // Chief sends an initial task to Writer; Writer starts working and pauses in wait_step.
  await tool('delegate_work', { to: 'Writer', goal: 'Run task 1' }, 'a')
  await settle(() => modes.callCount >= 1 && rt.live.get('b')?.tool === 'wait_step')

  // A pre-upgrade inbox may still contain a second request steered into this turn.
  const previous = agents.get('b').session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source?.role === 'request').data
  const id = 'earlier-steered-work'
  const work = rt.openWork(id, { from: 'a', to: 'b', goal: 'Also include check 2' })
  const { coordWorkId: _dropCoordWorkId, ...prevSource } = previous.source
  agents.get('b').steer({ ...previous, id, source: { ...prevSource, exchangeId: id, workRef: work.ref } })
  await settle(() => agents.get('b').inbox.nextStep.length === 1)

  // Let wait_step finish so Writer claims the steered follow-up and hits INVALID_REQUEST.
  stepGate.resolve()
  await agents.get('b').whenIdle()
  await settle(() => deliveries.some(entry => entry.sessionId === 'a' && entry.source.role === 'reply'))
  await agents.get('a').whenIdle()
  await realDelay(30)

  const failureRepliesToChief = deliveries.filter(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-dup-1319'))
  assert.equal(failureRepliesToChief.length, 1, 'Chief must receive the failure notice for req-dup-1319 only once')
  const openNonFg = rt.coordDb.listWorks({ activeOnly: true }).filter(w => w.kind !== 'foreground')
  assert.deepEqual(openNonFg, [], 'all works bound to the failed turn must be closed')

  // A subsequent turn that fails with a new request_id still notifies Chief.
  modes.b = 'fail-once'
  modes.requestId = 'req-new-456'
  await tool('delegate_work', { to: 'Writer', goal: 'Retry with clean args' }, 'a')
  await agents.get('b').whenIdle()
  await settle(() => deliveries.some(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-new-456')))
  await agents.get('a').whenIdle()
  const newReplies = deliveries.filter(entry => entry.sessionId === 'a' && entry.source.role === 'reply' && entry.text.includes('req-new-456'))
  assert.equal(newReplies.length, 1)
})

test('SQLite settleWork and answerSender are idempotent per work/call while preserving late replies after abandonWork', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-answer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  const host = await createRestartHost(t, home, new Map())
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const { rt } = host
  await rt.adoptLiveWork()

  // 1) Atomic SQLite settleWork is idempotent: settling the same work twice delivers to caller only ONCE.
  rt.openWork('ex-1', { from: 'a', to: 'b', toSession: 'b', goal: 'Report' })
  const firstSettle = rt.coordDb.settleWork({ workId: 'ex-1', outcome: 'done', force: true, summary: 'Final report verbatim' })
  const secondSettle = rt.coordDb.settleWork({ workId: 'ex-1', outcome: 'done', force: true, summary: 'Final report verbatim' })
  assert.equal(firstSettle.settled, true)
  assert.equal(secondSettle.settled, false)
  assert.equal(secondSettle.alreadyTerminal, true)
  await rt.kickScheduler()
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 1, 'same work settlement must only deliver once')
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'user/message', { content: host.agentOf('a').calls[0].content, source: host.agentOf('a').calls[0].source })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // 2) answerSender checks pair ledger once delivered and suppresses replays.
  const req2 = { kind: 'bot', role: 'request', exchangeId: 'ex-ledger-dedup', senderSessionId: 'a' }
  assert.equal(answerSender(rt, 'b', req2, 'Ledger-checked report'), true)
  await settle(() => host.agentOf('a').calls.length >= 2 && rt.wasReplyDelivered('b', 'a', 'ex-ledger-dedup'))
  assert.equal(answerSender(rt, 'b', req2, 'Ledger-checked report'), false, 'already-delivered reply must be suppressed')
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 2)

  // 3) abandonWork settles work cleanly, then late answerSender delivers once and suppresses replay.
  rt.openWork('ex-abandoned-parent', { from: 'a', to: 'a', toSession: 'a', goal: 'Parent' })
  rt.openWork('ex-late', { from: 'a', to: 'b', parent: 'ex-abandoned-parent', toSession: 'b', goal: 'Late child' })
  assert.equal(rt.abandonWork('ex-late', 'user'), true)
  await settle(() => host.agentOf('a').calls.length >= 3)
  const lateSource = { kind: 'bot', role: 'request', exchangeId: 'ex-late', senderSessionId: 'a' }
  assert.equal(answerSender(rt, 'b', lateSource, 'Actual late completion'), true)
  await settle(() => host.agentOf('a').calls.length >= 4 && rt.wasReplyDelivered('b', 'a', 'ex-late'))
  assert.equal(answerSender(rt, 'b', lateSource, 'Actual late completion'), false, 'late reply replay must be blocked')
  await realDelay(30)
  assert.equal(host.agentOf('a').calls.length, 4, 'late reply arrives once and replay is blocked')
})

test('reconcileEnded does not duplicate replies or request_id failures after the asker moves to a fresh part', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-'))
  const logs = new Map()
  const seed = baseSeed()
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  const first = await createRestartHost(t, home, logs)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  await first.rt.adoptLiveWork()

  const request = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'ex-part-switch', senderName: 'Chief', senderSessionId: 'a' }
  first.rt.openWork('ex-part-switch', { from: 'a', to: 'b', toSession: 'b' })
  first.emit('b', 'turn/start', { turn: 1 })
  first.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nCheck' }], source: request })
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })

  // Deliver the reply to part 'a', Chief consumes it, settle work, then Chief advances to part 'a-2'.
  await first.rt.deliver({ fromId: 'b', toId: 'a', sessionId: 'a', text: 'The plan is ready.', role: 'reply', replyTo: 'ex-part-switch', exchangeId: 'reply-1' })
  first.rt.closeWork('ex-part-switch', 'Writer', 'The plan is ready.', { deliverDirect: true })
  const deliveredReply = first.agentOf('a').calls[0]
  first.emit('a', 'user/message', { content: deliveredReply.content, source: deliveredReply.source })
  first.rt.state.bots.a.segments = [{ sessionId: 'a', endedAt: 10 }]
  first.rt.state.bots.a.sessionId = 'a-2'
  await first.rt.save({ required: true })

  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: request, content: [{ type: 'text', text: '[Message from Chief]\nCheck' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  logs.set('a-2', [])
  await first.stop()

  const second = await createRestartHost(t, home, logs)
  await second.rt.adoptLiveWork()
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await realDelay(30)

  assert.equal(second.agentOf('a-2').calls.length, 0, 'reply already settled must not be re-delivered after part switch')
  assert.equal(second.agentOf('a').calls.length, 0)
  assert.equal(second.agentOf('b').calls.length, 0)
  await second.stop()
})

test('adoptLiveWork settles already-ended turns from disk via D2 without re-running or duplicating replies', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-resume-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'ex-ended', botId: 'b', kind: 'task', logicalAddress: 'task:ex-ended', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
    db.createCall({
      callId: 'c_ex-ended', parentWorkId: 'fg:a', childWorkId: 'ex-ended',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'req-ex-ended', bodyPreview: 'Finish', payload: { text: 'Finish', role: 'request' } },
    })
    const clm = db.claimReady({ workId: 'ex-ended' })
    db.beginDeliveryAttempt({ workId: 'ex-ended', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-ex-ended', sessionId: 'b' })
  })

  const logs = new Map([
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-ex-ended', exchangeId: 'ex-ended', senderSessionId: 'a' }, content: [{ type: 'text', text: '[Message from Chief]\nFinish' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Already finished answer.' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['a', []],
  ])

  const first = await createRestartHost(t, home, logs)
  await first.rt.adoptLiveWork()
  await settle(() => first.agentOf('a').calls.length >= 1)
  assert.equal(first.agentOf('b').calls.length, 0, 'completed turn on disk must not be re-run')
  assert.equal(first.agentOf('a').calls.length, 1, 'completed turn reply must settle to Chief once')
  assert.match(textOf(first.agentOf('a').calls[0]), /Already finished answer\./)
  // Chief consumes the delivered reply.
  const delivered = first.agentOf('a').calls[0]
  first.emit('a', 'turn/start', { turn: 1 })
  first.emit('a', 'user/message', { content: delivered.content, source: delivered.source })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await first.stop()

  // Second restart: already settled & consumed, so nothing is re-sent.
  const second = await createRestartHost(t, home, logs)
  await second.rt.adoptLiveWork()
  await realDelay(30)
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(second.agentOf('a').calls.length, 0, 'already-delivered reply must not be sent again')
  await second.stop()
})

async function checkAttachmentRecovery(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-attachment-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const services = { attachments: fakeAttachments() }
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  const logs = new Map()
  const first = await createRestartHost(t, home, logs, services)
  await first.rt.adoptLiveWork()

  first.rt.openWork('parent', { from: 'a', to: 'a', toSession: 'a', goal: 'Parent' })
  first.rt.openWork('child', { from: 'a', to: 'b', parent: 'parent', toSession: 'b', goal: 'Child' })
  const full = '结论\n'.repeat(70_000) + 'End of report.'
  const fullText = prefix + full
  const attachment = await first.rt.attachLong(full, 'Answer from Writer.txt')
  await first.rt.deliver({
    fromId: 'b', toId: 'a', ...attachment, role: 'reply', replyTo: 'child',
    text: prefix + attachment.text, length: prefix.length + attachment.length,
  })
  // Close child with full text -> handoffs.js keepResultFile persists full body in handoff-results/child.txt!
  first.rt.closeWork('child', 'Writer', fullText, { deliverDirect: true })
  await first.stop()

  const restarted = await createRestartHost(t, home, logs, services)
  await restarted.rt.adoptLiveWork()
  assert.equal(restarted.rt.coordDb.getWork('child').status, 'done')
  assert.ok(restarted.rt.answerText('parent', '', 'Chief').endsWith(fullText), 'parent keeps the entire reply across restart via resultRef file, not a truncated preview')
  assert.equal(restarted.agentOf('a').calls.length, 0)
  assert.equal(restarted.agentOf('b').calls.length, 0)
  await restarted.stop()
}

test('restart keeps the full attachment-backed reply in the parent work without re-delivery', t => checkAttachmentRecovery(t, ''))

test('restart keeps the fallback notice with the full attachment-backed reply', t => checkAttachmentRecovery(t, 'Writer could not send its reply to you (offline); what it had answered:\n'))

test('restart settles a completed peer handoff task from disk via D2 and replies to the asking Bot', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-task-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const seed = baseSeed()
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Peer request', origin: 'bot-handoff', status: 'running', exchangeId: 'child' }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'task:task-1', botId: 'b', kind: 'task', logicalAddress: 'task:task-1', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b-task' })
    db.createCall({
      callId: 'c_child', parentWorkId: 'fg:a', childWorkId: 'task:task-1',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'req-child', bodyPreview: 'Peer request', payload: { text: 'Peer request', role: 'request' } },
    })
    const clm = db.claimReady({ workId: 'task:task-1' })
    db.beginDeliveryAttempt({ workId: 'task:task-1', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-child', sessionId: 'b-task' })
  })
  const logs = new Map([['b-task', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-child', exchangeId: 'task:task-1', senderSessionId: 'a' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Peer task finished.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  const host = await createRestartHost(t, home, logs)
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('a').calls.length > 0)
  assert.equal(host.rt.coordDb.getWork('task:task-1').status, 'done')
  assert.equal(host.agentOf('a').calls.length, 1)
  assert.match(textOf(host.agentOf('a').calls[0]), /Peer task finished\./)
  assert.equal(host.agentOf('b-task').calls.length, 0)
  assert.equal(host.agentOf('b').calls.length, 0)
  await host.stop()
})

test('restart settles a handoff task even when DSH page reads this.ctx', async (t) => {
  // DSH's sessionController methods read this.ctx on their first line: calling
  // them detached from the controller throws synchronously (#2036).
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-task-ctx-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const seed = baseSeed()
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Peer request', origin: 'bot-handoff', status: 'running', exchangeId: 'child' }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'task:task-1', botId: 'b', kind: 'task', logicalAddress: 'task:task-1', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b-task' })
    db.createCall({
      callId: 'c_child', parentWorkId: 'fg:a', childWorkId: 'task:task-1',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'req-child', bodyPreview: 'Peer request', payload: { text: 'Peer request', role: 'request' } },
    })
    const clm = db.claimReady({ workId: 'task:task-1' })
    db.beginDeliveryAttempt({ workId: 'task:task-1', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-child', sessionId: 'b-task' })
  })
  const logs = new Map([['b-task', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-child', exchangeId: 'task:task-1', senderSessionId: 'a' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Peer task finished.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  const host = await createRestartHost(t, home, logs, undefined, {
    pageOverride: async function page({ address }) {
      if (this === undefined || this.ctx === undefined) throw new TypeError("Cannot read properties of undefined (reading 'ctx')")
      const sid = address?.sessionId ?? address?.childSessionId
      return { records: (logs.get(sid) ?? []).map((event, idx) => ({ event: { seq: idx + 1, ...event } })), hasMore: false }
    },
  })
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('a').calls.length > 0)
  assert.equal(host.rt.coordDb.getWork('task:task-1').status, 'done')
  assert.match(textOf(host.agentOf('a').calls[0]), /Peer task finished\./)
  assert.equal(host.agentOf('b-task').calls.length, 0)
  await host.stop()
})

async function checkUnreadTaskReply(t, inInbox) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-task-queued-'))
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Reviewer', role: 'Reviewer', sessionId: 'c', createdAt: 3 }
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Peer request', origin: 'bot-handoff', status: 'waiting_work', exchangeId: 'request' }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'request', botId: 'b', kind: 'task', logicalAddress: 'task:request', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b-task' })
    db.createCall({ callId: 'c_request', parentWorkId: 'fg:a', childWorkId: 'request', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a' })
    db.receiveMessage({
      workId: 'request', kind: 'result', dedupKey: 'review-reply', senderBotId: 'c',
      bodyPreview: 'Review result.',
      payload: { role: 'reply', replyTo: 'review', work: 'request', exchangeId: 'review-reply', text: 'Review result.', renderedText: 'Review result.' },
      wake: true,
    })
    if (inInbox) {
      const clm = db.claimReady({ workId: 'request' })
      db.beginDeliveryAttempt({ workId: 'request', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'review-reply', sessionId: 'b-task' })
    }
  })

  const logs = new Map([['b-task', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'bot', role: 'request', exchangeId: 'request', senderSessionId: 'a' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Waiting for review.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  const host = await createRestartHost(t, home, logs, undefined, {
    preloadAgents: inInbox ? ['b-task'] : [],
    agentSetup(sid, agent) {
      if (inInbox && sid === 'b-task') {
        agent.inbox.nextTurn.push({
          id: 'parked-reply-1',
          source: { kind: 'bot', exchangeId: 'review-reply', idempotencyKey: 'review-reply', role: 'reply' },
          content: [{ type: 'text', text: 'Review result.' }],
        })
      }
    },
  })
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await host.rt.adoptLiveWork()
  await host.rt.reconcileTasksAfterRestart()

  // Both cases wake b-task with the single reply (never duplicating, never leaking to b or a foreground).
  assert.equal(host.agentOf('b-task').calls.length, 1)
  assert.equal(host.agentOf('b-task').calls[0].source.exchangeId, 'review-reply')
  assert.equal(host.agentOf('b').calls.length, 0)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.equal(host.rt.state.bots.b.tasks[0].status, 'waiting_work')
}

test('restart replays an unread child reply in its background task without rerunning the earlier turn', t => checkUnreadTaskReply(t, false))

test('restart adopts and wakes a parked child reply already in the task inbox without duplicating', t => checkUnreadTaskReply(t, true))

test('restart finds an unread task follow-up in the task’s successor inbox without leaking to foreground', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-moved-task-'))
  const seed = baseSeed()
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task-new', segments: [{ sessionId: 'b-task-old' }], title: 'Background task', status: 'running' }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'b' })
    db.createWork({ workId: 'task:task-1', botId: 'b', kind: 'task', logicalAddress: 'task:task-1', status: 'idle', parentWorkId: 'fg:b', sessionId: 'b-task-new' })
  })
  const host = await createRestartHost(t, home, new Map(), undefined, {
    preloadAgents: ['b-task-new'],
    agentSetup(sid, agent) {
      if (sid === 'b-task-new') {
        agent.inbox.nextTurn.push({ id: 'fu-1', source: { kind: 'bot', exchangeId: 'followup' }, content: [{ type: 'text', text: 'Only for the task' }] })
      }
    },
  })
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await host.rt.adoptLiveWork()
  await host.rt.reconcileTasksAfterRestart()
  assert.deepEqual(host.agentOf('b').calls, [], 'the foreground must not receive the task follow-up')
  assert.deepEqual(host.agentOf('b-task-new').calls, [], 'the successor inbox already has the follow-up')
  assert.equal(host.rt.state.bots.b.tasks[0].status, 'running')
})

test('restart never leaks a failed task session into foreground during legacy inflight migration', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-failed-task-'))
  const seed = baseSeed()
  seed.bots.b.tasks = [{ id: 'task-1', sessionId: 'b-task', title: 'Background task', status: 'failed' }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const args = { fromId: 'a', toId: 'b', sessionId: 'b-task', role: 'reply', exchangeId: 'reply', text: 'Result for the failed task' }
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: {}, queued: { 'b-task': [{ at: 1, args }] } }))
  const host = await createRestartHost(t, home, new Map())
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await host.rt.adoptLiveWork()
  await host.rt.reconcileTasksAfterRestart()
  // v2 strict isolation: terminal/failed task sessions are NEVER routed into foreground chat!
  assert.deepEqual(host.agentOf('b-task').calls, [])
  assert.deepEqual(host.agentOf('b').calls, [], 'failed background task session must never leak into foreground chat')
})

test('answerSender keeps separate continuations for distinct parent works sharing a failed turn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-parents-'))
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const host = await createRestartHost(t, home, new Map())
  t.after(async () => {
    await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const { rt } = host
  await rt.adoptLiveWork()
  rt.openWork('ex-no-parent', { from: 'a', to: 'b', toSession: 'b' })
  rt.openWork('parent-1', { from: 'c', to: 'a', toSession: 'a' })
  rt.openWork('child-p1', { from: 'a', to: 'b', parent: 'parent-1', toSession: 'b' })
  rt.openWork('parent-2', { from: 'c', to: 'a', toSession: 'a' })
  rt.openWork('child-p2', { from: 'a', to: 'b', parent: 'parent-2', toSession: 'b' })
  rt.openWork('parent-consumed', { from: 'c', to: 'a', toSession: 'a' })
  rt.openWork('child-c1', { from: 'a', to: 'b', parent: 'parent-consumed', toSession: 'b' })
  rt.openWork('child-c2', { from: 'a', to: 'b', parent: 'parent-consumed', toSession: 'b' })

  const failure = { code: 'INVALID_REQUEST', status: 400, requestId: 'req-shared-parents', message: 'bad' }
  const dedupKey = 'turn:b:1:error:req-shared-parents'

  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'ex-no-parent', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-p1', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-p2', senderSessionId: 'a' }, 'Writer failed', undefined, { failure, dedupKey }), true)
  await settle(() => host.agentOf('a').calls.length >= 3)
  assert.deepEqual(
    host.agentOf('a').calls.map(msg => [msg.source.replyTo, msg.source.work]),
    [['ex-no-parent', 'fg:a'], ['child-p1', 'parent-1'], ['child-p2', 'parent-2']],
    'distinct parent works must each receive their own continuation',
  )

  const sameParentFailure = { code: 'INVALID_REQUEST', status: 400, requestId: 'req-consumed-parent', message: 'bad' }
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-c1', senderSessionId: 'a' }, 'Writer failed', undefined, { failure: sameParentFailure }), true)
  await settle(() => host.agentOf('a').calls.length >= 4)
  assert.equal(answerSender(rt, 'b', { kind: 'bot', role: 'request', exchangeId: 'child-c2', senderSessionId: 'a' }, 'Writer failed', undefined, { failure: sameParentFailure }), true)
  await settle(() => host.agentOf('a').calls.length >= 5)
  assert.deepEqual(
    [host.agentOf('a').calls[4].source.replyTo, host.agentOf('a').calls[4].source.work],
    ['child-c2', 'parent-consumed'],
  )
})

test('adoptLiveWork resumes an interrupted upstream continuation work and skips it once already settled', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reply-resume-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'c', workId: 'fg:c', logicalAddress: 'foreground:c', sessionId: 'c' })
    db.createWork({ workId: 'up-work', botId: 'a', kind: 'task', logicalAddress: 'task:up-work', status: 'idle', parentWorkId: 'fg:c', sessionId: 'a' })
    db.createCall({
      callId: 'c_up-work', parentWorkId: 'fg:c', childWorkId: 'up-work',
      callerBotId: 'c', calleeBotId: 'a', returnAddress: 'foreground:c',
    })
    db.receiveMessage({
      workId: 'up-work', kind: 'result', dedupKey: 'sub-reply', senderBotId: 'b',
      bodyPreview: 'sub done',
      payload: { role: 'reply', replyTo: 'sub-req', work: 'up-work', text: 'sub done', renderedText: 'sub done' },
      wake: true,
    })
    const clm = db.claimReady({ workId: 'up-work' })
    db.beginDeliveryAttempt({ workId: 'up-work', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-up-cont', sessionId: 'a' })
  })

  const logs = new Map([['a', []], ['b', []], ['c', []]])
  const first = await createRestartHost(t, home, logs)
  await first.rt.adoptLiveWork()
  await settle(() => first.agentOf('a').calls.length >= 1)
  assert.equal(first.agentOf('a').calls[0].source.coordWorkId, 'up-work', 'unanswered upstream work must resume')

  // Now Chief settles up-work (reply delivered to Lead c), then crashes/restarts.
  first.rt.coordDb.settleWork({ workId: 'up-work', outcome: 'done', force: true, summary: 'upstream final answer' })
  await first.rt.kickScheduler()
  await settle(() => first.agentOf('c').calls.length >= 1)
  const leadDelivered = first.agentOf('c').calls[0]
  first.emit('c', 'turn/start', { turn: 1 })
  first.emit('c', 'user/message', { content: leadDelivered.content, source: leadDelivered.source })
  first.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await first.stop()

  const second = await createRestartHost(t, home, logs)
  await second.rt.adoptLiveWork()
  await realDelay(30)
  assert.equal(second.agentOf('a').calls.length, 0, 'already-answered upstream work must not resume again')
  assert.equal(second.agentOf('c').calls.length, 0, 'already-delivered upstream reply must not duplicate')
  assert.equal(second.rt.coordDb.getWork('up-work').status, 'done')
  await second.stop()
})

test('adoptLiveWork settles failed D2 works and wakes every distinct parent work', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-steered-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'c', workId: 'fg:c', logicalAddress: 'foreground:c', sessionId: 'c' })
    for (const [pId, rId, sid, key] of [
      ['p1', 'req-1', 'b-1', 'dk-r1'],
      ['p2', 'req-2', 'b-2', 'dk-r2'],
    ]) {
      db.createWork({ workId: pId, botId: 'a', kind: 'task', logicalAddress: `task:${pId}`, status: 'waiting', parentWorkId: 'fg:c', sessionId: `a-${pId}` })
      db.createCall({ callId: `c_${pId}`, parentWorkId: 'fg:c', childWorkId: pId, callerBotId: 'c', calleeBotId: 'a', returnAddress: 'foreground:c' })
      db.createWork({ workId: rId, botId: 'b', kind: 'task', logicalAddress: `task:${rId}`, status: 'idle', parentWorkId: pId, sessionId: sid })
      db.createCall({
        callId: `c_${rId}`, parentWorkId: pId, childWorkId: rId,
        callerBotId: 'a', calleeBotId: 'b', returnAddress: `task:${pId}`,
        initialMessage: { dedupKey: `in-${rId}`, bodyPreview: rId, payload: { text: rId, role: 'request' } },
      })
      const clm = db.claimReady({ workId: rId })
      db.beginDeliveryAttempt({ workId: rId, claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: key, sessionId: sid })
    }
  })

  const errReason = { kind: 'error', error: { code: 'INVALID_REQUEST', status: 400, requestId: 'req-rec-1', message: 'bad' } }
  const logs = new Map([
    ['b-1', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-r1' }, content: [{ type: 'text', text: 'first' }] } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: errReason } },
    ]],
    ['b-2', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-r2' }, content: [{ type: 'text', text: 'second' }] } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: errReason } },
    ]],
  ])

  const host = await createRestartHost(t, home, logs)
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('a-p1').calls.length >= 1 && host.agentOf('a-p2').calls.length >= 1)
  assert.equal(host.rt.coordDb.getWork('req-1').status, 'failed')
  assert.equal(host.rt.coordDb.getWork('req-2').status, 'failed')
  assert.equal(host.agentOf('a-p1').calls[0].source.coordWorkId, 'p1')
  assert.equal(host.agentOf('a-p2').calls[0].source.coordWorkId, 'p2')
  await host.stop()
})

// A primary work completes before crash while a second queued work (with attachments) still waits in SQLite:
// on restart, req-1 settles to its parent and req-2 dispatches cleanly with its attachments intact.
test('a completed primary work settles while a separate queued work with attachments dispatches after restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-completed-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const image = { id: 'img-1', name: 'shot.png', mediaType: 'image/png' }

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'c', workId: 'fg:c', logicalAddress: 'foreground:c', sessionId: 'c' })
    db.createWork({ workId: 'p1', botId: 'a', kind: 'task', logicalAddress: 'task:p1', status: 'waiting', parentWorkId: 'fg:c', sessionId: 'a' })
    db.createCall({ callId: 'c_p1', parentWorkId: 'fg:c', childWorkId: 'p1', callerBotId: 'c', calleeBotId: 'a', returnAddress: 'foreground:c' })
    db.createWork({ workId: 'p2', botId: 'a', kind: 'task', logicalAddress: 'task:p2', status: 'waiting', parentWorkId: 'fg:c', sessionId: 'a-p2' })
    db.createCall({ callId: 'c_p2', parentWorkId: 'fg:c', childWorkId: 'p2', callerBotId: 'c', calleeBotId: 'a', returnAddress: 'foreground:c' })

    db.createWork({ workId: 'req-1', botId: 'b', kind: 'task', logicalAddress: 'task:req-1', status: 'idle', parentWorkId: 'p1', sessionId: 'b' })
    db.createCall({
      callId: 'c_req-1', parentWorkId: 'p1', childWorkId: 'req-1', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'task:p1',
      initialMessage: { dedupKey: 'in-req-1', bodyPreview: 'first', payload: { text: 'first', role: 'request', exchangeId: 'req-1' } },
    })
    const clm = db.claimReady({ workId: 'req-1' })
    db.beginDeliveryAttempt({ workId: 'req-1', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-req-1', sessionId: 'b' })

    db.createWork({ workId: 'req-2', botId: 'b', kind: 'task', logicalAddress: 'task:req-2', status: 'idle', parentWorkId: 'p2', sessionId: 'b' })
    db.createCall({
      callId: 'c_req-2', parentWorkId: 'p2', childWorkId: 'req-2', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'task:p2',
      initialMessage: {
        dedupKey: 'in-req-2', bodyPreview: 'second',
        payload: { text: 'second', role: 'request', exchangeId: 'req-2', images: [image] },
      },
    })
  })

  const logs = new Map([
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-req-1', exchangeId: 'req-1' }, content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host = await createRestartHost(t, home, logs)
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('a').calls.length >= 1 && host.agentOf('b').calls.length >= 1)

  assert.equal(host.rt.coordDb.getWork('req-1').status, 'done', 'primary request settled')
  assert.match(textOf(host.agentOf('a').calls[0]), /first answer/)
  assert.equal(host.agentOf('a-p2').calls.length, 0, 'req-2 must not be answered with req-1 text')

  const handed = host.agentOf('b').calls
  assert.equal(handed.length, 1, 'second queued work dispatches once after primary settles')
  assert.equal(handed[0].source.exchangeId, 'req-2')
  assert.match(textOf(handed[0]), /second/)
  assert.deepEqual(handed[0].content.filter(block => block.type === 'image').map(block => block.attachment), [image], 'attachments preserved')
  assert.equal(host.rt.waitsWork('p2'), true, 'parent p2 still waits for req-2')
  await host.stop()
})

test('a second work already completed before the crash is not dispatched twice', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-deferred-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const seed = baseSeed()
  seed.bots.c = { id: 'c', name: 'Lead', role: 'Lead', sessionId: 'c', createdAt: 3 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    for (const [id, key] of [['req-1', 'dk-1'], ['req-2', 'dk-2']]) {
      db.createWork({ workId: id, botId: 'b', kind: 'task', logicalAddress: `task:${id}`, status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
      db.createCall({
        callId: `c_${id}`, parentWorkId: 'fg:a', childWorkId: id, callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
        initialMessage: { dedupKey: `in-${id}`, bodyPreview: id, payload: { text: id, role: 'request', exchangeId: id } },
      })
      const clm = db.claimReady({ workId: id })
      db.beginDeliveryAttempt({ workId: id, claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: key, sessionId: 'b' })
    }
  })

  const logs = new Map([
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-1' }, content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, data: { turn: 2 } },
      { type: 'user/message', seq: 6, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-2' }, content: [{ type: 'text', text: 'second' }] } },
      { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: 'second answer' }] } } },
      { type: 'turn/end', seq: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ]],
  ])

  const host = await createRestartHost(t, home, logs)
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('a').calls.length >= 1)
  await realDelay(30)
  assert.equal(host.agentOf('b').calls.length, 0, 'already-completed works must not be re-dispatched')
  assert.equal(host.rt.coordDb.getWork('req-1').status, 'done')
  assert.equal(host.rt.coordDb.getWork('req-2').status, 'done')
  await host.stop()
})

test('recovery does not re-dispatch a work already parked in inbox (D2 queued adopts and wakes once)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-raced-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'req-2', botId: 'b', kind: 'task', logicalAddress: 'task:req-2', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
    db.createCall({
      callId: 'c_req-2', parentWorkId: 'fg:a', childWorkId: 'req-2', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'in-req-2', bodyPreview: 'second', payload: { text: 'second', role: 'request', exchangeId: 'req-2' } },
    })
    const clm = db.claimReady({ workId: 'req-2' })
    db.beginDeliveryAttempt({ workId: 'req-2', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-parked-2', sessionId: 'b' })
  })

  const host = await createRestartHost(t, home, new Map(), undefined, {
    preloadAgents: ['b'],
    agentSetup(sid, agent) {
      if (sid === 'b') {
        agent.inbox.nextTurn.push({
          id: 'msg-parked-2',
          source: { kind: 'bot', role: 'request', exchangeId: 'req-2', idempotencyKey: 'dk-parked-2' },
          content: [{ type: 'text', text: 'second' }],
        })
      }
    },
  })
  await host.rt.adoptLiveWork()
  await realDelay(30)
  // adoptActiveDelivery removes the parked copy and re-enqueues it once (zero duplicates in inbox).
  assert.equal(host.agentOf('b').calls.filter(m => m.source?.exchangeId === 'req-2').length, 1, 'parked work woken exactly once')
  assert.equal(host.agentOf('b').inbox.nextTurn.filter(m => m.source?.exchangeId === 'req-2').length, 1, 'inbox holds exactly one copy')
  await host.stop()
})

test('a deferred delivery that failed is sent again on retry in the same run', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-retry-'))
  let host
  t.after(async () => {
    await host?.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  host = await createRestartHost(t, home, new Map())
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

test('concurrent duplicate receiveMessage and kickScheduler dispatch each work at most once', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-concurrent-'))
  let host
  t.after(async () => {
    await host?.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))
  host = await createRestartHost(t, home, new Map())
  await host.rt.adoptLiveWork()

  const fgB = host.rt.ensureForegroundWorkForBot('b')
  const r1 = host.rt.coordDb.receiveMessage({ workId: fgB.workId, kind: 'request', dedupKey: 'req-once', bodyPreview: 'send once', payload: { text: 'send once', exchangeId: 'req-once' }, wake: true })
  const r2 = host.rt.coordDb.receiveMessage({ workId: fgB.workId, kind: 'request', dedupKey: 'req-once', bodyPreview: 'send once', payload: { text: 'send once', exchangeId: 'req-once' }, wake: true })
  assert.equal(r1.deduplicated, false)
  assert.equal(r2.deduplicated, true, 'duplicate dedupKey must be deduplicated in SQLite inbox')

  await Promise.all([host.rt.kickScheduler({ botId: 'b' }), host.rt.kickScheduler({ botId: 'b' })])
  assert.equal(host.agentOf('b').calls.filter(msg => msg.source.exchangeId === 'req-once').length, 1, 'concurrent kickScheduler dispatches once')
})

test('recovery does not dispatch a work after it was closed before kickScheduler ran', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-closed-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'req-2', botId: 'b', kind: 'task', logicalAddress: 'task:req-2', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
    db.createCall({
      callId: 'c_req-2', parentWorkId: 'fg:a', childWorkId: 'req-2', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'in-req-2', bodyPreview: 'second', payload: { text: 'second', role: 'request', exchangeId: 'req-2' } },
    })
  })

  const host = await createRestartHost(t, home, new Map())
  host.rt.closeWork('req-2', 'Writer', 'already answered', { deliverDirect: true })
  await host.rt.adoptLiveWork()
  await realDelay(30)
  assert.equal(host.agentOf('b').calls.length, 0, 'a closed work has nothing left to answer')
  await host.stop()
})

test('a work bound to a switched part session b-2 settles from b-2 logs after crash without re-running', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-handoff-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const seed = baseSeed()
  seed.bots.b.segments = [{ sessionId: 'b', endedAt: 10 }]
  seed.bots.b.sessionId = 'b-2'
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'req-1', botId: 'b', kind: 'task', logicalAddress: 'task:req-1', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b-2' })
    db.createCall({
      callId: 'c_req-1', parentWorkId: 'fg:a', childWorkId: 'req-1', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'in-req-1', bodyPreview: 'first', payload: { text: 'first', role: 'request', exchangeId: 'req-1' } },
    })
    const clm = db.claimReady({ workId: 'req-1' })
    db.beginDeliveryAttempt({ workId: 'req-1', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-b2', sessionId: 'b-2' })

    db.createWork({ workId: 'req-2', botId: 'b', kind: 'task', logicalAddress: 'task:req-2', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b-2' })
    db.createCall({
      callId: 'c_req-2', parentWorkId: 'fg:a', childWorkId: 'req-2', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'in-req-2', bodyPreview: '[URGENT]\nsecond across switch', payload: { text: '[URGENT]\nsecond across switch', role: 'request', exchangeId: 'req-2' } },
    })
  })

  const logs = new Map([
    ['b-2', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-b2', exchangeId: 'req-1' }, content: [{ type: 'text', text: '# Handoff\nYou were in the middle of a turn.' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'first answer after switch' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host = await createRestartHost(t, home, logs)
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('b-2').calls.length >= 1)

  assert.equal(host.rt.coordDb.getWork('req-1').status, 'done')
  const handed = host.agentOf('b-2').calls
  assert.equal(handed.length, 1, 'carried queued request dispatches once on b-2')
  assert.equal(handed[0].source.exchangeId, 'req-2')
  assert.match(textOf(handed[0]), /\[URGENT\]\nsecond across switch/)
  assert.doesNotMatch(textOf(handed[0]), /# Handoff/)
  await host.stop()
})

test('recovery does not duplicate a request a running DSH turn already owns', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dedup-reconcile-live-owned-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(baseSeed()))

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'req-2', botId: 'b', kind: 'task', logicalAddress: 'task:req-2', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
    db.createCall({
      callId: 'c_req-2', parentWorkId: 'fg:a', childWorkId: 'req-2', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'in-req-2', bodyPreview: 'second', payload: { text: 'second', role: 'request', exchangeId: 'req-2' } },
    })
    const clm = db.claimReady({ workId: 'req-2' })
    db.beginDeliveryAttempt({ workId: 'req-2', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-live-2', sessionId: 'b' })
  })

  const logs = new Map([
    ['b', [
      { type: 'turn/start', seq: 1, data: { turn: 2 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'request', idempotencyKey: 'dk-live-2', exchangeId: 'req-2' }, content: [{ type: 'text', text: 'second' }] } },
    ]],
  ])

  const host = await createRestartHost(t, home, logs, undefined, {
    preloadAgents: ['b'],
    agentSetup(sid, agent) {
      if (sid === 'b') agent.status = 'running'
    },
  })
  await host.rt.adoptLiveWork()
  await realDelay(30)
  assert.equal(host.agentOf('b').calls.length, 0, 'a request already owned by a live running turn must not be delivered again')
  assert.equal(host.rt.coordDb.getWork('req-2').status, 'running')
  await host.stop()
})
