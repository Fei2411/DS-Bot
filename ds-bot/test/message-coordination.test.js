import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRuntime } from '../index.js'
import { RESUME_DELAY_MS } from '../src/host/resume.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// Node's t.after hooks run in FIFO order, so per-test rmSync registered before
// mountRealDsh/attachRuntime would delete the temp folder while DSH and SQLite
// are still open. Clean temp folders once all test-level disposals finish.
const tempDirs = []
after(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {}
  }
})
const tempBase = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
const REPLAY_WAIT_MS = RESUME_DELAY_MS + 15_000

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
  const base = tempBase('ds-bot-coord-report-')
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
  await sleepUntil(
    () => host2.rt.coordination.listPendingObligations().length === 0
      && dsh2.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.role === 'task-report'),
    REPLAY_WAIT_MS,
    'task_report obligation should replay and settle',
  )
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  const reports = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'task-report')
  assert.equal(reports.length, 1)
  assert.equal(host2.rt.coordination.listPendingObligations().length, 0)
})

test('coordination.sqlite cold-evidence verification prevents double consumption and redundant resume', async (t) => {
  const base = tempBase('ds-bot-coord-evidence-')
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
  await sleepUntil(
    () => host2.rt.unreadOf('dm-a').length === 0
      && Object.keys(host2.rt.coordination.loadInitialState().turns).length === 0,
    REPLAY_WAIT_MS,
    'cold-evidence check should clear stale delivery and turn without replaying',
  )
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()

  const consumed = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'ex-once')
  const resumes = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'resume')
  assert.equal(consumed.length, 1)
  assert.equal(resumes.length, 0)
  assert.equal(dsh2.calls.length, 0)
})

test('logical address never redirects a closed task delivery to the Bot foreground chat', async (t) => {
  const base = tempBase('ds-bot-coord-closed-task-')
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
  await sleepUntil(
    () => host2.rt.unreadOf('bg-dead').length === 0
      && Object.keys(host2.rt.coordination.loadInitialState().queued).length === 0,
    REPLAY_WAIT_MS,
    'closed task delivery should be discarded on replay instead of redirected',
  )
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  assert.equal(fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'task').length, 0)
  assert.equal(dsh2.calls.length, 0)
})

test('work-notes persist in SQLite, reject third-party Bots, and inject on next step without interrupting', async (t) => {
  const base = tempBase('ds-bot-coord-worknotes-')
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
  const base = tempBase('ds-bot-coord-2265-')
  let ctx
  t.after(async () => { await ctx?.dispose() })
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
  ctx = fakeContext({
    services: { llm, sessionController },
  })
  ctx.llm = llm
  ctx.sessionController = sessionController
  const rt = createRuntime(ctx, { home })
  await rt.load()

  await rt.syncRoomSessions?.()
  await rt.syncRoomSessions?.()
  await rt.syncRoomSessions?.()
  assert.equal(selectAttempts, 1, 'missing group Session should not be retried indefinitely')
})

test('unconfirmed tool/call without tool/result is held as TURN_UNVERIFIED instead of auto-resuming', async (t) => {
  const base = tempBase('ds-bot-coord-unconfirmed-tool-')
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
  const base = tempBase('ds-bot-coord-readonly-')
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

test('crash between SQLite commitTaskTerminal and state.json save reconciles task as completed, not interrupted', async (t) => {
  const base = tempBase('ds-bot-coord-task-marker-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seedTeam()))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(fg1.session)
  const t1 = await dsh1.create('task-1')
  await dsh1.root.sessions.flush(t1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  const exchangeId = 'task-report:t-1'
  host1.rt.coordination.commitTaskTerminal({
    taskId: 't-1',
    terminalSnapshot: { botId: 'a', status: 'completed', updatedAt: 20, endedAt: 20, summary: 'AUDIT DONE' },
    obligation: {
      id: exchangeId,
      kind: 'task_report',
      ownerId: 't-1',
      botId: 'a',
      address: { foreground: true },
      deliveryId: exchangeId,
      payload: {
        toId: 'a',
        address: { foreground: true },
        exchangeId,
        role: 'task-report',
        note: '"Audit" (t-1) finished',
        taskId: 't-1',
        text: 'AUDIT DONE',
        recordExchange: false,
      },
    },
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  // Simulate crash after SQLite commit but before state.json persisted task completion.
  writeFileSync(statePath, JSON.stringify(seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 't-1', title: 'Audit', sessionId: 'task-1', status: 'running', createdAt: 10, updatedAt: 10 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
    },
  })))

  // Restart with state.json STILL showing task t-1 as running.
  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  await dsh2.open('task-1')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await sleepUntil(() => {
    const fg = dsh2.root.agents.get('dm-a')
    return host2.rt.coordination.listPendingObligations().length === 0
      && host2.rt.coordination.listTerminalMarkers().length === 0
      && fg.session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === exchangeId)
  }, REPLAY_WAIT_MS, 'task completion report should replay once')
  await delay(300)
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  const reports = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'task-report')
  assert.equal(reports.length, 1, 'should not send a second conflicting interruption report')
  assert.match(reports[0].data.content[0].text, /AUDIT DONE/)
  assert.equal(host2.rt.botOf('a').tasks[0].status, 'completed')
  assert.equal(host2.rt.coordination.listTerminalMarkers().length, 0)
})

test('crash between SQLite room_report commit and state.json save does not duplicate group report', async (t) => {
  const base = tempBase('ds-bot-coord-room-marker-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seedTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 1 },
    },
  })))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(fg1.session)
  const dmB1 = await dsh1.create('dm-b')
  await dsh1.root.sessions.flush(dmB1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  const exchangeId = 'group-report:rr-1'
  host1.rt.coordination.commitObligation({
    id: 'room-report:rr-1',
    kind: 'room_report',
    ownerId: 'rr-1',
    botId: 'a',
    address: { foreground: true },
    deliveryId: exchangeId,
    payload: {
      toId: 'a',
      address: { foreground: true },
      exchangeId,
      sessionId: 'dm-a',
      role: 'report',
      roomId: 'r1',
      text: 'OPS REVIEW DONE',
      replyTo: 'sub-rr-1',
      work: 'parent-1',
    },
    terminalMarker: {
      kind: 'room_report',
      ownerId: 'rr-1',
      snapshot: {
        roomId: 'r1',
        roomName: 'Ops',
        botId: 'a',
        reportKey: 'sub-rr-1',
        sub: 'sub-rr-1',
        workResult: 'OPS REVIEW DONE',
        worked: true,
        imReplyOrigin: { connId: 'c1', chatKey: 'chat-1', senderId: 'u1', binding: 'bot:a' },
      },
    },
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  // Simulate crash after SQLite commit but before state.json persisted watcher removal,
  // child-work closure, or imReplyOrigins.
  writeFileSync(statePath, JSON.stringify(seedTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 1 },
    },
    works: {
      'parent-1': { from: 'b', to: 'a', ref: 'W1', state: 'open', open: ['sub-rr-1'], results: [], at: 5 },
      'sub-rr-1': { from: 'a', room: 'r1', parent: 'parent-1', ref: 'W2', state: 'open', open: [], results: [], at: 6 },
    },
    roomReports: {
      'rr-1': { id: 'rr-1', roomId: 'r1', botId: 'a', name: 'Chief', sub: 'sub-rr-1', fromPart: 'dm-a', after: 0, at: 10 },
    },
  })))

  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  await dsh2.open('dm-b')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await sleepUntil(() => {
    const fg = dsh2.root.agents.get('dm-a')
    return host2.rt.coordination.listPendingObligations().length === 0
      && host2.rt.coordination.listTerminalMarkers().length === 0
      && fg.session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === exchangeId)
  }, REPLAY_WAIT_MS, 'room report obligation should replay once')
  await delay(300)
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  const dmB2 = dsh2.root.agents.get('dm-b')
  await sleepUntil(() => {
    return dmB2.session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.role === 'reply' && e.data?.source?.replyTo === 'parent-1')
  }, 10_000, 'parent work should finish and return answer to asking Bot')
  await dmB2.whenIdle()
  const reports = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.role === 'report')
  assert.equal(reports.length, 1, 'stale roomReports watcher must be reconciled before settleRoomReports')
  assert.match(reports[0].data.content[0].text, /OPS REVIEW DONE/)
  assert.equal(host2.rt.state.roomReports?.['rr-1'], undefined)
  assert.equal(host2.rt.state.works['sub-rr-1'], undefined, 'delegated child work must be closed on marker recovery')
  const parentReply = dmB2.session.snapshotEvents().find(e => e.type === 'user/message' && e.data?.source?.role === 'reply' && e.data?.source?.replyTo === 'parent-1')
  assert.match(parentReply.data.content[0].text, /OPS REVIEW DONE/, 'parent answer must include preserved group work result from closeWork')
  assert.equal(host2.rt.state.imReplyOrigins?.['sub-rr-1']?.chatKey, 'chat-1', 'eligible IM reply origin must be restored on marker recovery')
})

test('closed destination falls back to foreground for completed replies and room_report obligations', async (t) => {
  const base = tempBase('ds-bot-coord-fallback-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 't-closed', title: 'Old', sessionId: 'task-old', status: 'stopped', createdAt: 10, updatedAt: 20, endedAt: 20 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
    },
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 1 },
    },
  })))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(fg1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  host1.rt.coordination.upsertDelivery('task-old', {
    toId: 'a',
    fromId: 'b',
    address: { taskId: 't-closed' },
    exchangeId: 'reply:w-closed',
    role: 'reply',
    text: 'COMPLETED PEER REPLY',
    recordExchange: false,
  })
  host1.rt.coordination.commitObligation({
    id: 'room-report:rr-closed',
    kind: 'room_report',
    ownerId: 'rr-closed',
    botId: 'a',
    address: { taskId: 't-closed' },
    deliveryId: 'group-report:rr-closed',
    payload: {
      toId: 'a',
      address: { taskId: 't-closed' },
      exchangeId: 'group-report:rr-closed',
      sessionId: 'task-old',
      role: 'report',
      roomId: 'r1',
      text: 'COMPLETED GROUP REPORT',
      replyTo: 'rr-closed',
    },
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await sleepUntil(() => {
    const evs = dsh2.root.agents.get('dm-a').session.snapshotEvents()
    return evs.some(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'reply:w-closed')
      && evs.some(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'group-report:rr-closed')
  }, REPLAY_WAIT_MS, 'both completed results should fall back to foreground and pass delivery admission')
  await dsh2.root.agents.get('dm-a').whenIdle()
})

test('work-notes disambiguate dual group assignments and inject only into matching batchKey', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const base = tempBase('ds-bot-coord-dual-batch-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 1 },
    },
    roomBatches: {
      'b-draft': { key: 'b-draft', roomId: 'r1', by: 'a', pending: ['b'], done: [], results: [], parentBatchKey: 'p1', createdAt: 10 },
      'b-release': { key: 'b-release', roomId: 'r1', by: 'a', pending: ['b'], done: [], results: [], parentBatchKey: 'p2', createdAt: 20 },
    },
  })))

  const sessionController = {
    page: async () => ({ records: [], hasMore: false }),
    resolveAgent: async sid => ({ agent: { id: sid, status: 'running', inbox: { nextStep: [], nextTurn: [] } } }),
  }
  const ctx = fakeContext({ services: { sessionController } })
  ctx.sessionController = sessionController
  ctx.sessions = { flush: async () => true }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose() })
  await rt.load()
  rt.live.set('rm-b', { turn: 1 })

  const room = rt.roomOf('r1')
  // Omitting work_id when two batches match must require disambiguation.
  await assert.rejects(
    rt.enqueueWorkNote(undefined, rt.botOf('a'), rt.botOf('b'), { text: 'Ambiguous', files: [] }, room),
    /Multiple open group assignments/,
  )
  // Naming the second assignment explicitly must succeed and store under b-release.
  await rt.enqueueWorkNote('b-draft', rt.botOf('a'), rt.botOf('b'), { text: 'Draft fix', files: [] }, room)
  await rt.enqueueWorkNote('b-release', rt.botOf('a'), rt.botOf('b'), { text: 'Release fix', files: [] }, room)
  assert.equal(rt.coordination.countWorkNotes('b-draft'), 1)
  assert.equal(rt.coordination.countWorkNotes('b-release'), 1)

  const fakeAgent = { id: 'rm-b', session: { id: 'rm-b', snapshotEvents: () => [] } }
  const preStepListeners = ctx.listeners.get('agent/pre-step') ?? []
  const runPreStep = async (payload) => {
    let idx = 0
    const next = async () => (idx < preStepListeners.length ? preStepListeners[idx++](payload, next) : { kind: 'proceed', messages: payload.messages })
    return next()
  }
  const releaseTurnMsg = { source: { kind: SOURCE_KIND, form: 'relay', role: 'room', roomId: 'r1', askedBy: 'a', batchKey: 'b-release' } }
  const decision = await runPreStep({ agent: fakeAgent, step: 1, messages: [releaseTurnMsg], signal: new AbortController().signal })
  const injected = decision.messages.filter(m => m?.source?.workNote)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.workNote, 'b-release')
  assert.match(injected[0].content[0].text, /Release fix/)
  assert.equal(rt.coordination.countWorkNotes('b-draft'), 1, 'b-draft note must remain untouched')
})

test('legacy group report without logical address replays to original private chat, not source group', async (t) => {
  const base = tempBase('ds-bot-coord-legacy-report-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam({
    rooms: {
      r1: { id: 'r1', name: 'Ops', sessionId: 'room-r1', members: ['a', 'b'], sessions: { a: 'rm-a', b: 'rm-b' }, mode: 'all', log: [], seen: {}, seq: 1 },
    },
  })))
  // Simulate v0.3.10 inflight.json: queued under dm-a with roomId: 'r1' (source group) and no address.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {},
    queued: {
      'dm-a': [{
        at: Date.now() - 1000,
        args: {
          toId: 'a',
          exchangeId: 'group-report:legacy-1',
          sessionId: 'dm-a',
          role: 'report',
          roomId: 'r1',
          text: 'LEGACY REPORT BODY',
          recordExchange: false,
        },
      }],
    },
  }))

  const dsh = await mountRealDsh(t, base)
  const dmA = await dsh.create('dm-a')
  await dsh.root.sessions.flush(dmA.session)
  const rmA = await dsh.create('rm-a')
  await dsh.root.sessions.flush(rmA.session)
  const host = attachRuntime(t, dsh, home, base)
  await host.rt.load()
  await sleepUntil(() => {
    return dsh.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'group-report:legacy-1')
  }, REPLAY_WAIT_MS, 'legacy group report should replay in dm-a')
  await dsh.root.agents.get('dm-a').whenIdle()
  assert.equal(
    dsh.root.agents.get('rm-a').session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.exchangeId === 'group-report:legacy-1').length,
    0,
    'legacy group report must not be misrouted into the source group session',
  )
})

test('hot rollback journal left by crash is rolled back after lock acquisition and replays committed report', async (t) => {
  const base = tempBase('ds-bot-coord-hot-journal-')
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
        tasks: [{ id: 'task-hj', title: 'HotJournal', brief: 'Check', from: 'dm-a', sessionId: 'bg-hj', status: 'completed', startedAt: 1, updatedAt: 2, endedAt: 2 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
    },
  })))

  const dsh1 = await mountRealDsh(t, base)
  const fg1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(fg1.session)
  const bg1 = await dsh1.create('dm-b')
  bg1.session.append('turn/start', { turn: 1 })
  await dsh1.root.sessions.flush(bg1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  const exchangeId = 'task-report:task-hj'
  host1.rt.coordination.upsertTurn('dm-b', { botId: 'b', turn: 1, since: 100 })
  host1.rt.coordination.commitTaskTerminal({
    taskId: 'task-hj',
    obligation: {
      id: exchangeId,
      kind: 'task_report',
      ownerId: 'task-hj',
      botId: 'a',
      address: { foreground: true },
      deliveryId: exchangeId,
      payload: {
        toId: 'a',
        role: 'task-report',
        taskId: 'task-hj',
        exchangeId,
        note: '"HotJournal" (task-hj) finished',
        text: 'HOT JOURNAL REPORT RECOVERED',
        recordExchange: false,
      },
    },
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  // Switch the DB to DELETE journal mode and synthesize a genuine hot rollback journal
  // (spilled dirty pages + non-zero page count, as left by a hard crash mid-write).
  const { DatabaseSync } = await import('node:sqlite')
  const { copyFileSync } = await import('node:fs')
  const dbPath = join(home, 'coordination.sqlite')
  const rawDb = new DatabaseSync(dbPath)
  rawDb.exec('PRAGMA journal_mode = DELETE')
  rawDb.exec('PRAGMA cache_size = 1')
  rawDb.exec('BEGIN IMMEDIATE')
  for (let i = 0; i < 8; i += 1) {
    rawDb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`uncommitted_${i}`, 'x'.repeat(8192))
  }
  const journalPath = `${dbPath}-journal`
  const savedJournal = join(base, 'hot.journal')
  const savedDb = join(base, 'hot.sqlite')
  assert.equal(existsSync(journalPath), true, 'DELETE journal should exist during uncommitted spilled write')
  copyFileSync(journalPath, savedJournal)
  copyFileSync(dbPath, savedDb)
  rawDb.exec('ROLLBACK')
  rawDb.close()
  copyFileSync(savedDb, dbPath)
  copyFileSync(savedJournal, journalPath)
  assert.equal(existsSync(join(home, 'inflight.json')), false)

  // Verify a read-only open indeed fails on this hot journal before lock recovery.
  assert.throws(() => {
    const ro = new DatabaseSync(dbPath, { readOnly: true })
    try { ro.prepare('SELECT value FROM meta WHERE key = ?').get('coord_gen') } finally { ro.close() }
  })

  // Fresh runtime must roll back the hot journal after acquiring state.lock, recover both the
  // active turn on dm-b (without crashing on missing firstTurn) and replay the report on dm-a!
  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  await dsh2.open('dm-b')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await sleepUntil(
    () => host2.rt.coordination.listPendingObligations().length === 0
      && dsh2.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === exchangeId)
      && dsh2.root.agents.get('dm-b').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.resumed === true),
    REPLAY_WAIT_MS,
    'both active turn and committed task_report behind a hot journal must recover after lock acquisition',
  )
  const fg2 = dsh2.root.agents.get('dm-a')
  await fg2.whenIdle()
  await dsh2.root.agents.get('dm-b').whenIdle()
  const reports = fg2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.exchangeId === exchangeId)
  assert.equal(reports.length, 1)
  assert.match(reports[0].data.content[0].text, /HOT JOURNAL REPORT RECOVERED/)
})

test('live turn started on another Bot during delayed WAL startup recovery never gets a spurious restart prompt', async (t) => {
  const base = tempBase('ds-bot-coord-live-wal-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  // Host 1 leaves an interrupted turn on dm-a in SQLite.
  const dsh1 = await mountRealDsh(t, base)
  const dmA1 = await dsh1.create('dm-a')
  dmA1.session.append('turn/start', { turn: 1 })
  await dsh1.root.sessions.flush(dmA1.session)
  const dmB1 = await dsh1.create('dm-b')
  await dsh1.root.sessions.flush(dmB1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  host1.rt.coordination.upsertTurn('dm-a', { botId: 'a', turn: 1, since: 100 })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  // Host 2 starts; during the 3s delayed recovery window, Bot B starts a brand-new live turn
  // (which creates/appends to the ordinary WAL file). When resumeAll runs, Bot B must NOT receive a restart prompt!
  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  const dmB2 = await dsh2.open('dm-b')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  // Simulate Bot B starting a fresh live turn before RESUME_DELAY_MS fires.
  dmB2.session.append('turn/start', { turn: 1 })

  await sleepUntil(
    () => dsh2.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.resumed === true),
    REPLAY_WAIT_MS,
    'pre-restart interrupted turn on dm-a should resume',
  )
  await dsh2.root.agents.get('dm-a').whenIdle()
  await delay(200)
  const resumedOnB = dmB2.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.resumed === true)
  assert.equal(resumedOnB.length, 0, 'live turn started on Bot B during startup recovery must never receive a spurious restart prompt')
})

test('hot journal recovery with stale _coordGen mirror and live startup delivery preserves committed SQLite deliveries', async (t) => {
  const base = tempBase('ds-bot-coord-hot-stale-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  const dsh1 = await mountRealDsh(t, base)
  const dmA1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(dmA1.session)
  const dmB1 = await dsh1.create('dm-b')
  await dsh1.root.sessions.flush(dmB1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()
  const committedEx = 'ex-sqlite-newer-delivery'
  host1.rt.coordination.upsertDelivery('dm-a', {
    fromId: 'b',
    fromName: 'Writer',
    toId: 'a',
    sessionId: 'dm-a',
    role: 'reply',
    replyTo: 'w-committed',
    exchangeId: committedEx,
    text: 'COMMITTED SQLITE DELIVERY SURVIVED',
    address: { foreground: true },
  })
  const newerGen = host1.rt.coordination.currentGen()
  assert.ok(newerGen > 0)
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  // Leave a stale `_coordGen`-stamped inflight.json (older than SQLite) with an old turn and old queued item.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    _coordGen: Math.max(0, newerGen - 1),
    turns: { 'dm-b': { botId: 'b', turn: 1, since: 50 } },
    queued: {
      'dm-a': [{
        at: 50,
        args: {
          fromId: 'b',
          fromName: 'Writer',
          toId: 'a',
          sessionId: 'dm-a',
          role: 'reply',
          replyTo: 'w-stale',
          exchangeId: 'ex-stale-mirror',
          text: 'STALE MIRROR DELIVERY MUST NOT WIN',
          address: { foreground: true },
        },
      }],
    },
  }))

  // Synthesize a genuine hot rollback journal so pre-lock read-only open fails.
  const { DatabaseSync } = await import('node:sqlite')
  const { copyFileSync } = await import('node:fs')
  const dbPath = join(home, 'coordination.sqlite')
  const rawDb = new DatabaseSync(dbPath)
  rawDb.exec('PRAGMA journal_mode = DELETE')
  rawDb.exec('PRAGMA cache_size = 1')
  rawDb.exec('BEGIN IMMEDIATE')
  for (let i = 0; i < 8; i += 1) {
    rawDb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`uncommitted_${i}`, 'y'.repeat(8192))
  }
  const journalPath = `${dbPath}-journal`
  const savedJournal = join(base, 'hot.journal')
  const savedDb = join(base, 'hot.sqlite')
  copyFileSync(journalPath, savedJournal)
  copyFileSync(dbPath, savedDb)
  rawDb.exec('ROLLBACK')
  rawDb.close()
  copyFileSync(savedDb, dbPath)
  copyFileSync(savedJournal, journalPath)

  // Fresh runtime starts; also simulate a live delivery arriving during startup before recovery runs.
  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  await dsh2.open('dm-b')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await host2.rt.deliver({
    fromId: 'a',
    fromName: 'Chief',
    toId: 'b',
    sessionId: 'dm-b',
    role: 'request',
    exchangeId: 'ex-live-startup-req',
    text: 'Live startup work',
    address: { foreground: true },
  })

  await sleepUntil(
    () => dsh2.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === committedEx),
    REPLAY_WAIT_MS,
    'committed SQLite delivery must survive hot journal recovery even with stale mirror and live startup delivery',
  )
  await dsh2.root.agents.get('dm-a').whenIdle()
  await dsh2.root.agents.get('dm-b').whenIdle()
  const aEvents = dsh2.root.agents.get('dm-a').session.snapshotEvents().filter(e => e.type === 'user/message')
  assert.equal(aEvents.some(e => e.data?.source?.exchangeId === committedEx), true)
  assert.equal(aEvents.some(e => e.data?.source?.exchangeId === 'ex-stale-mirror'), false, 'stale mirror delivery must not overwrite SQLite')
  const bResumed = dsh2.root.agents.get('dm-b').session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.resumed === true)
  assert.equal(bResumed.length, 0, 'stale mirror ended turn must not resurrect on dm-b')
})

test('bot-handoff crash after commitTaskTerminal replays peer_result obligation and closes work once', async (t) => {
  const base = tempBase('ds-bot-coord-peer-result-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  const team = seedTeam()
  team.works = {
    'w-handoff-1': { from: 'a', to: 'b', open: [], results: [], at: 10 },
  }
  team.bots.b.tasks = [{
    id: 'task-ho-1',
    title: 'Handoff research',
    sessionId: 'task-ho-sess-1',
    status: 'running',
    origin: 'bot-handoff',
    exchangeId: 'w-handoff-1',
    createdAt: 10,
    updatedAt: 10,
  }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const dsh1 = await mountRealDsh(t, base)
  const dmA1 = await dsh1.create('dm-a')
  await dsh1.root.sessions.flush(dmA1.session)
  const dmB1 = await dsh1.create('dm-b')
  await dsh1.root.sessions.flush(dmB1.session)
  const host1 = attachRuntime(t, dsh1, home, base)
  await host1.rt.load()

  // Simulate crash right after commitTaskTerminal committed the bot-handoff terminal marker
  // + peer_result obligation in SQLite, before state.json save or answerSender delivery ran.
  const replyExchangeId = 'reply:w-handoff-1'
  host1.rt.coordination.commitTaskTerminal({
    taskId: 'task-ho-1',
    terminalSnapshot: {
      botId: 'b',
      status: 'completed',
      updatedAt: 20,
      endedAt: 20,
      summary: 'HANDOFF RESULT COMMITTED',
      handoffExchangeId: 'w-handoff-1',
      handoffBotName: 'Writer',
      handoffResult: 'HANDOFF RESULT COMMITTED',
      handoffWorked: true,
    },
    obligation: {
      id: 'peer-result:w-handoff-1',
      kind: 'peer_result',
      ownerId: 'task-ho-1',
      botId: 'a',
      address: { foreground: true },
      deliveryId: replyExchangeId,
      payload: {
        fromId: 'b',
        fromName: 'Writer',
        toId: 'a',
        sessionId: 'dm-a',
        role: 'reply',
        replyTo: 'w-handoff-1',
        exchangeId: replyExchangeId,
        address: { foreground: true },
        text: 'HANDOFF RESULT COMMITTED',
      },
    },
  })
  await host1.ctx.dispose()
  await dsh1.root.fiber.dispose()

  const dsh2 = await mountRealDsh(t, base)
  await dsh2.open('dm-a')
  await dsh2.open('dm-b')
  const host2 = attachRuntime(t, dsh2, home, base)
  await host2.rt.load()
  await sleepUntil(
    () => host2.rt.coordination.listPendingObligations().length === 0
      && dsh2.root.agents.get('dm-a').session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.exchangeId === replyExchangeId),
    REPLAY_WAIT_MS,
    'peer_result obligation should replay to asking Bot and reconcile task/work state',
  )
  await dsh2.root.agents.get('dm-a').whenIdle()
  const taskAfter = host2.rt.botOf('b').tasks.find(item => item.id === 'task-ho-1')
  assert.equal(taskAfter?.status, 'completed', 'bot-handoff task must reconcile as completed, not interrupted')
  assert.equal(host2.rt.state.works?.['w-handoff-1'], undefined, 'delegated work must be closed during marker reconciliation')
  const replies = dsh2.root.agents.get('dm-a').session.snapshotEvents().filter(e => e.type === 'user/message' && e.data?.source?.exchangeId === replyExchangeId)
  assert.equal(replies.length, 1)
  assert.match(replies[0].data.content[0].text, /HANDOFF RESULT COMMITTED/)
})

test('incomplete SQLite schema does not crash startup and completes initialization after lock', async (t) => {
  const base = tempBase('ds-bot-coord-partial-schema-')
  const home = join(base, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedTeam()))

  // Simulate a DB left with only the first two tables (`meta`, `deliveries`) and user_version = 0.
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'coordination.sqlite')
  const partial = new DatabaseSync(dbPath)
  partial.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE deliveries (
      exchange_id TEXT PRIMARY KEY, session_id TEXT, address_json TEXT, role TEXT NOT NULL,
      bot_id TEXT NOT NULL, room_id TEXT, task_id TEXT, work_id TEXT, args_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  partial.close()

  const dsh = await mountRealDsh(t, base)
  await dsh.create('dm-a')
  const host = attachRuntime(t, dsh, home, base)
  assert.equal(host.rt.coordination.hadInitialReadFailure(), true, 'incomplete schema must trigger initialReadFailed instead of throwing during install')
  await host.rt.load()
  assert.equal(host.rt.coordination.recoverAfterLock(), true, 'recoverAfterLock must complete schema initialization once lock is held')
  assert.equal(host.rt.coordination.hadInitialReadFailure(), false)
  // All tables are now present and writable.
  host.rt.coordination.upsertTurn('dm-a', { botId: 'a', turn: 1, since: 100 })
  assert.equal(host.rt.coordination.loadInitialState().turns['dm-a']?.botId, 'a')
})
