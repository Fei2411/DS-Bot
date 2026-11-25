import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRuntime } from '../index.js'
import { RESUME_DELAY_MS } from '../src/host/resume.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const sleepUntil = async (fn, ms = 5000, label = 'condition not met') => {
  const until = Date.now() + ms
  while (!fn() && Date.now() < until) await delay(10)
  assert.ok(fn(), label)
}

function seedTeam(over = {}) {
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

async function mountRealDsh(t, base) {
  const root = new Context()
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent']) {
    const mod = await import(`@deepseek-ai/${name}`)
    await root.plugin(mod.default ?? mod, {})
  }
  const persistence = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  await root.plugin(persistence, { root: join(base, 'sessions') })
  const sessionQueryMod = await import('@deepseek-ai/dsh-session-query')
  await root.plugin(sessionQueryMod.default)

  const calls = []
  class ScriptedAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(options) {
      calls.push(options.sessionId)
      const text = 'SCRIPTED OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['coord'], new ScriptedAdapter())
  const agentLoopMod = await import('@deepseek-ai/dsh-agent-loop')
  await root.plugin(agentLoopMod.default, { agents: [] })
  t.after(async () => { await root.fiber.dispose() })

  const agentOptions = { provider: 'coord', model: 'mock', cwd: base }
  const open = async sid => (await root.agentLoop.resume(root, { resumeSessionId: SessionId(sid), agentOptions })).agent
  const create = sid => root.agentLoop.create(SessionId(sid), agentOptions)
  return { root, calls, open, create }
}

function attachRuntime(t, dsh, home, base, { nextWorkerId = 'bg-a' } = {}) {
  const controller = {
    create: async () => { await dsh.create(nextWorkerId); return { sessionId: nextWorkerId } },
    resolveAgent: async sid => ({ agent: dsh.root.agents.get(sid) ?? await dsh.open(sid) }),
    selectModel: async () => {},
  }
  const services = {
    agents: dsh.root.agents,
    sessions: dsh.root.sessions,
    sessionQuery: dsh.root.sessionQuery,
    tools: dsh.root.tools,
    llm: dsh.root.llm,
    sessionController: controller,
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: { get: () => ({ id: 'w1', path: base }), resolveByPath: async () => ({ id: 'w1', path: base }) },
  }
  const ctx = Object.assign(fakeContext({ services }), services)
  const offSession = dsh.root.on('session/event', (s, event) => {
    for (const f of ctx.listeners.get('session/event') ?? []) if (f.length >= 2) f(s, event)
  })
  const offs = ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded'].map(ev =>
    dsh.root.on(ev, arg => { for (const f of ctx.listeners.get(ev) ?? []) f(arg) }),
  )
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    offSession()
    for (const off of offs) off()
    await ctx.dispose()
  })
  return { ctx, rt }
}

test('coordination.sqlite replays a committed task_report obligation without inflight.json', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-report-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    bots: {
      a: {
        id: 'a',
        name: 'Chief',
        role: 'Boss',
        sessionId: 'dm-a',
        createdAt: 1,
        tasks: [{ id: 'task-1', title: 'Audit', brief: 'Run audit', from: 'dm-a', sessionId: 'bg-a', status: 'completed', startedAt: 1, updatedAt: 2, endedAt: 2 }],
      },
    },
  })))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  fg1.followup(createUserMessage({ content: [{ type: 'text', text: 'Warm up.' }], source: { kind: 'user' } }))
  await fg1.whenIdle()
  assert.equal(await dsh1.root.sessions.flush(fg1.session), true)

  // Commit a pending task_report obligation directly in coordination.sqlite (simulating a crash right after commitTaskTerminal, with no inflight.json).
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  assert.equal(host1.rt.coordination.commitTaskTerminal({
    taskId: 'task-1',
    obligation: {
      id: 'task-report:task-1',
      kind: 'task_report',
      ownerId: 'task-1',
      botId: 'a',
      address: { foreground: true },
      deliveryId: 'task-report:task-1',
      payload: {
        toId: 'a',
        role: 'task-report',
        taskId: 'task-1',
        exchangeId: 'task-report:task-1',
        note: '"Audit" (task-1) finished',
        text: 'FINAL AUDIT REPORT',
        recordExchange: false,
      },
    },
  }), true)
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()
  assert.equal(existsSync(join(home, 'inflight.json')), false)

  // Fresh runtime recovers the pending SQLite obligation and delivers it exactly once.
  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await delay(RESUME_DELAY_MS + 400)
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  const reports = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'task-report')
  assert.equal(reports.length, 1)
  assert.equal(host2.rt.coordination.listPendingObligations().length, 0)
})

test('coordination.sqlite cold-evidence verification prevents double consumption and redundant resume', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-evidence-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  fg1.followup(createUserMessage({
    content: [{ type: 'text', text: '[Update]\nAlready processed once.' }],
    source: { kind: SOURCE_KIND, form: 'relay', role: 'update', exchangeId: 'ex-once' },
  }))
  await fg1.whenIdle()
  assert.equal(await dsh1.root.sessions.flush(fg1.session), true)
  const lastTurn = fg1.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data?.turn
  assert.equal(typeof lastTurn, 'number')

  // Seed stale delivery AND stale active_turn directly in coordination.sqlite (no inflight.json).
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  host1.rt.coordination.upsertDelivery('dm-a', {
    toId: 'a',
    sessionId: 'dm-a',
    address: { foreground: true },
    role: 'update',
    exchangeId: 'ex-once',
    text: 'Already processed once.',
  })
  host1.rt.coordination.upsertTurn('dm-a', { botId: 'a', turn: lastTurn, since: Date.now() })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await delay(RESUME_DELAY_MS + 400)
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()

  const consumed = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'ex-once')
  const resumes = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'resume')
  assert.equal(consumed.length, 1)
  assert.equal(resumes.length, 0)
  assert.equal(dsh2.calls.length, 0)
})

test('logical address never redirects a closed task delivery to the Bot foreground chat', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-closed-task-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    bots: {
      a: {
        id: 'a',
        name: 'Chief',
        role: 'Boss',
        sessionId: 'dm-a',
        createdAt: 1,
        tasks: [{ id: 'task-dead', title: 'Dead', brief: 'Never run in DM', from: 'dm-a', sessionId: 'bg-dead', status: 'failed', startedAt: 1, updatedAt: 2, endedAt: 2 }],
      },
    },
  })))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  fg1.followup(createUserMessage({ content: [{ type: 'text', text: 'Hi.' }], source: { kind: 'user' } }))
  await fg1.whenIdle()
  assert.equal(await dsh1.root.sessions.flush(fg1.session), true)

  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  host1.rt.coordination.upsertDelivery('bg-dead', {
    toId: 'a',
    sessionId: 'bg-dead',
    address: { taskId: 'task-dead' },
    role: 'task',
    taskId: 'task-dead',
    exchangeId: 'start-dead',
    text: 'Must never appear in dm-a',
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await delay(RESUME_DELAY_MS + 400)
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  assert.equal(fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'task').length, 0)
  assert.equal(dsh2.calls.length, 0)
})

test('work-notes persist in SQLite, reject third-party Bots, and inject on next step without interrupting', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-worknotes-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  const sessionController = { page: async () => ({ records: [], hasMore: false }) }
  const ctx = fakeContext({
    services: { sessionController },
  })
  ctx.sessionController = sessionController
  let flushed = true
  ctx.sessions = { flush: async () => flushed }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose() })
  await rt.load()

  const opened = rt.openWork('w-1', { from: 'a', to: 'b', goal: 'Check pricing' })
  assert.ok(opened?.ref)

  // Third-party Bot C cannot inject a correction into A -> B's work.
  await assert.rejects(
    rt.enqueueWorkNote(opened.ref, rt.botOf('c'), rt.botOf('b'), { text: 'Sneaky update', files: [] }),
    /No open work with that reference/,
  )

  // Authorized caller A enqueues a mid-work update durably into coordination.sqlite.
  const receipt = await rt.enqueueWorkNote(opened.ref, rt.botOf('a'), rt.botOf('b'), { text: 'Include tax', files: [] })
  assert.match(receipt, /Update recorded for Writer/)
  assert.equal(rt.coordination.countWorkNotes('w-1'), 1)
  assert.equal(rt.unreadWorkNotes('w-1', opened), 1)

  // Step 1 on Writer's session handling work w-1 receives the update in pre-step decision.
  const sessionEvents = []
  const fakeAgent = { id: 'dm-b', session: { id: 'dm-b', snapshotEvents: () => sessionEvents } }
  const preStepListeners = ctx.listeners.get('agent/pre-step') ?? []
  const runPreStep = async (payload) => {
    let idx = 0
    const next = async () => {
      if (idx < preStepListeners.length) return preStepListeners[idx++](payload, next)
      return { kind: 'proceed', messages: payload.messages }
    }
    return next()
  }
  const initialMsg = { source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'w-1' } }
  const decision = await runPreStep({ agent: fakeAgent, step: 1, messages: [initialMsg], signal: new AbortController().signal })
  const noteMsg = decision.messages.find(m => m?.source?.workNote === 'w-1')
  assert.ok(noteMsg, 'work note should be injected at pre-step')
  assert.match(noteMsg.content[0].text, /Include tax/)

  // Confirm consumption after session/event + flush clears SQLite row.
  rt.workNoteTaken(fakeAgent.session, noteMsg.source)
  await sleepUntil(() => rt.coordination.countWorkNotes('w-1') === 0, 2000, 'work note should clear after flush')
  assert.equal(rt.unreadWorkNotes('w-1', opened), 0)
})

test('dead group session stops infinite model selection retry (#2265)', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-2265-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-dead', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 0 },
    },
  })))

  let selectAttempts = 0
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ provider: 'mock', id: 'm1', name: 'M1', inputModalities: ['text', 'image'] }],
    resolveModel: async () => ({ provider: 'mock', id: 'm1', name: 'M1', inputModalities: ['text', 'image'] }),
    getModel: async () => ({ provider: 'mock', id: 'm1', name: 'M1', inputModalities: ['text', 'image'] }),
  }
  const sessionController = {
    selectModel: async ({ sessionId }) => {
      if (sessionId === 'room-dead') {
        selectAttempts += 1
        throw Object.assign(new Error('session "room-dead" not found'), { code: 'session/not-found' })
      }
    },
    resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'not found' } }),
  }
  const ctx = fakeContext({
    services: { llm, sessionController },
  })
  ctx.llm = llm
  ctx.sessionController = sessionController
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose() })
  await rt.load()

  await rt.syncRoomSessions?.()
  await rt.syncRoomSessions?.()
  await rt.syncRoomSessions?.()
  assert.equal(selectAttempts, 1, 'missing group Session should not be retried indefinitely')
})

test('unconfirmed tool/call without tool/result is held as TURN_UNVERIFIED instead of auto-resuming', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-unconfirmed-tool-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  const calls = []
  const diagnostics = []
  const logs = new Map([
    ['dm-a', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy' }] } },
      { type: 'tool/call', seq: 3, data: { callId: 'call-1', name: 'bash', arguments: '{"command":"deploy.sh"}' } },
    ]],
  ])
  const fakeAgent = {
    id: 'dm-a',
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    session: { id: 'dm-a', snapshotEvents: () => logs.get('dm-a') },
    followup: msg => calls.push(msg),
    steer: msg => calls.push(msg),
    inject: () => {},
  }
  const makeCtx = () => {
    const sessions = { flush: async () => true }
    const sessionController = {
      inspect: async sid => ({ events: logs.get(sid) ?? [] }),
      resolveAgent: async () => ({ agent: fakeAgent }),
    }
    const ctx = fakeContext({
      services: { sessions, sessionController },
    })
    ctx.sessions = sessions
    ctx.sessionController = sessionController
    return ctx
  }

  // Seed an active turn directly into coordination.sqlite (simulating hard crash mid-tool).
  const ctx1 = makeCtx()
  const rt1 = createRuntime(ctx1, { home })
  await rt1.load()
  rt1.coordination.upsertTurn('dm-a', { botId: 'a', turn: 1, since: Date.now() })
  await ctx1.dispose()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx2 = makeCtx()
  const rt2 = createRuntime(ctx2, { home })
  const origNote = rt2.noteFailure
  rt2.noteFailure = (entry) => { diagnostics.push(entry); return origNote?.(entry) }
  t.after(async () => { await ctx2.dispose() })
  await rt2.load()
  t.mock.timers.tick(RESUME_DELAY_MS + 100)
  await sleepUntil(() => diagnostics.some(d => d?.code === 'TURN_UNVERIFIED'), 3000, 'should record TURN_UNVERIFIED')
  assert.equal(calls.length, 0, 'must not blindly re-run unconfirmed side-effectful tool turn')
})

test('read-only host never creates or mutates coordination.sqlite', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-coord-readonly-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose() })
  // Force read-only state before any coordination writes.
  rt.readOnly = () => ({ pid: 99999 })
  assert.equal(existsSync(join(home, 'coordination.sqlite')), false)
  assert.equal(rt.coordination.upsertDelivery('dm-a', { toId: 'a', exchangeId: 'ro-1', role: 'update', text: 'nope' }), 0)
  assert.equal(rt.coordination.commitTaskTerminal({ taskId: 't-ro', obligation: { id: 'task-report:t-ro', kind: 'task_report', ownerId: 't-ro', botId: 'a', address: { foreground: true }, payload: {} } }), false)
  assert.equal(existsSync(join(home, 'coordination.sqlite')), false)
})
