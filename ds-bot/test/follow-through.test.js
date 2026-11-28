import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { setTimeout as realDelay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { openCoordinationDb } from '../src/host/coordination-db.js'
import { fakeContext } from './fake-ctx.js'
import { stripWrittenCalls, writesToolCall } from '../src/host/turns.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
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

// One DS Bot host on `home`; a second start on the same home is a restart.
// Hosts by home: a home is removed only after its hosts stopped and their writes landed.
let rt
const started = new Map()

// The durable logs DSH keeps, by Session: what a Session's turns did and said.
async function start(home, logs, { pageOverride, agentSetup, flushOverride, resolveAgentOverride, preloadAgents = [] } = {}) {
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
      const keep = (message) => { calls.push(message); inbox.nextTurn.push(message) }
      const agent = {
        id: sessionId,
        session: {
          id: sessionId,
          requestHeader: () => undefined,
          snapshotEvents: () => (logs?.get(sessionId) ?? []).map((event, idx) => ({ seq: idx + 1, ...event })),
        },
        status: 'idle',
        calls,
        inbox,
        followup: keep,
        steer: keep,
        cancel() {},
      }
      agentSetup?.(sessionId, agent)
      agents.set(sessionId, agent)
    }
    return agents.get(sessionId)
  }
  for (const sid of preloadAgents) agentOf(sid)
  const ctx = fakeContext({ services: { agents } })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: resolveAgentOverride
        ? (sessionId => resolveAgentOverride(sessionId, agentOf))
        : (async sessionId => ({ agent: agentOf(sessionId) })),
      selectModel: async () => {},
      page: pageOverride ?? (async ({ address }) => {
        const sid = address?.sessionId ?? address?.childSessionId
        const list = logs?.get(sid) ?? []
        return { records: list.map((event, idx) => ({ event: { seq: idx + 1, ...event } })), hasMore: false }
      }),
      inspect: async sessionId => ({ events: logs?.get(sessionId) ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: flushOverride ?? (async () => {}) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    const session = agents.get(id)?.session ?? { id }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const askApproval = sessionId => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox' }, () => 'from-dsh')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await rt.adoptLiveWork()
  const host = { ctx, rt, agents, agentOf, emit, tool, call, askApproval, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t, state = seed()) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}

const settle = async (check, ms = 3000) => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')

// The diagnostics log, once the plugin's background write of it landed.
const readDiagnostics = async (home, wanted = () => true) => {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    try {
      const content = readFileSync(join(home, 'logs', 'diagnostics.jsonl'), 'utf8')
      const entries = content.trim() === '' ? [] : content.trim().split('\n').map(line => JSON.parse(line))
      if (wanted(entries)) return entries
    } catch {}
    await realDelay(10)
  }
  return []
}

// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Starts a round in 'r1' and opens Writer's turn in 'gb'.
async function openRoomTurn(t, host) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  run(host, 'gb', 1, host.agentOf('gb').calls[0])
  return () => result
}

// Chief asks Writer for the plan; Writer's turn takes it up and the work waits in coordDb.
const askWriter = async (host) => {
  await host.tool('delegate_work', { to: 'Writer', goal: 'Draft the plan' }, 'a')
  await settle(() => host.agentOf('b').calls.length >= 1)
  const request = host.agentOf('b').calls[0]
  run(host, 'b', 1, request)
  return request
}

// The durable log of Writer's Session: the turn that took the request up, and what it said.
const writerLog = (request, said, reason = { kind: 'completed' }, route) => [
  ...(route === undefined ? [] : [{ type: 'request/context', seq: 0, data: route }]),
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: request.source, content: request.content } },
  ...(said === undefined ? [] : [{ type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: said }] } } }]),
  { type: 'turn/end', seq: 4, data: { turn: 1, reason } },
]

test('a group room_work cut off mid-tool by a restart pauses as needs_verification instead of blindly re-running', async (t) => {
  const home = freshHome(t)
  seedCoord(home, (db) => {
    db.createWork({
      workId: 'rc-gb-1', botId: 'b', kind: 'room_work', originKind: 'group', roomId: 'r1',
      logicalAddress: 'room:r1:b', status: 'running', sessionId: 'gb', meta: { kind: 'room_call' },
    })
    db.recordDirectDeliveryAttempt({ workId: 'rc-gb-1', idempotencyKey: 'room-key-1', sessionId: 'gb' })
  })
  const logs = new Map([
    ['gb', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role: 'room', roomId: 'r1', idempotencyKey: 'room-key-1' }, content: [{ type: 'text', text: 'Check logs' }] } },
      { type: 'tool/call', seq: 3, data: { callId: 'tc-pwsh', name: 'pwsh', arguments: '{}' } },
    ]],
  ])
  const host = await start(home, logs)
  const work = host.rt.coordDb.getWork('rc-gb-1')
  assert.equal(work.status, 'needs_verification', 'interrupted group room_work with open tool call pauses cleanly')
  assert.equal(work.pauseReason, 'interrupted_tools')
  assert.deepEqual(work.pauseDetail?.interruptedTools, ['pwsh'])
  assert.equal(host.agentOf('gb').calls.length, 0, 'must not blindly re-run interrupted tool turn')
})

test('a request cut off before execution resumes under the same work on restart with zero inflight.json', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('delegate_work', { to: 'Writer', goal: 'Draft the plan' }, 'a')
  await settle(() => first.agentOf('b').calls.length === 1)
  const workId = first.agentOf('b').calls[0].source.coordWorkId
  assert.equal(existsSync(join(home, 'inflight.json')), false, 'v2 writes zero inflight.json')
  await first.stop()

  // DSH log is empty (crashed before Writer consumed the message): restart requeues & dispatches under same workId.
  const second = await start(home, new Map([['b', []]]))
  await settle(() => second.agentOf('b').calls.length === 1)
  const request = second.agentOf('b').calls[0]
  assert.equal(request.source.coordWorkId, workId)
  assert.equal(request.source.role, 'request')
  assert.match(text(request), /Draft the plan/)
})

test('when only DS Bot restarts, a turn still running in DSH is adopted without duplicating, and a later disposed restart resumes it', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const req = await askWriter(first)
  const workId = req.source.coordWorkId
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: req.source, content: req.content } },
  ])
  await first.stop()

  // DSH went on: Writer is still running when DS Bot reloads.
  const second = await start(home, logs, {
    preloadAgents: ['b'],
    agentSetup(sid, agent) {
      if (sid === 'b') agent.status = 'running'
    },
  })
  assert.equal(second.agentOf('b').calls.length, 0, 'still-running turn must be adopted, not duplicated')
  assert.equal(second.rt.coordDb.getWork(workId).status, 'running')

  // Writer's turn aborts on shutdown (`disposed`): work stays running in SQLite for restart recovery.
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  assert.equal(second.rt.coordDb.getWork(workId).status, 'running')
  await second.stop()

  // Next cold start (idle agent, no turn/end with tools): D2 sees consumed+aborted (0 tools) -> requeues and resumes!
  const third = await start(home, logs)
  await settle(() => third.agentOf('b').calls.length === 1)
  assert.equal(third.agentOf('b').calls[0].source.coordWorkId, workId)
})

for (const role of ['reply', 'report', 'resume']) {
  test(`a completed ${role} continuation turn settles its work back to the caller after a plugin restart`, async (t) => {
    const state = seed()
    state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
    const home = freshHome(t, state)
    seedCoord(home, (db) => {
      db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
      db.createWork({ workId: 'x1', botId: 'b', kind: 'task', logicalAddress: 'task:x1', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
      db.createCall({ callId: 'c_x1', parentWorkId: 'fg:a', childWorkId: 'x1', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a' })
      db.receiveMessage({
        workId: 'x1', kind: 'result', dedupKey: `cont-${role}`, senderBotId: 'c',
        bodyPreview: 'Go on with the plan.',
        payload: { role, exchangeId: 'continuation-1', work: 'x1', text: 'Go on with the plan.' },
        wake: true,
      })
      const clm = db.claimReady({ workId: 'x1' })
      db.beginDeliveryAttempt({ workId: 'x1', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: `dk-${role}`, sessionId: 'b' })
    })
    const logs = new Map([
      ['b', [
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: { source: { kind: 'bot', role, idempotencyKey: `dk-${role}`, exchangeId: 'continuation-1', work: 'x1' }, content: [{ type: 'text', text: 'Go on with the plan.' }] } },
        { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'The final plan is ready.' }] } } },
        { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      ]],
    ])

    const second = await start(home, logs)
    await settle(() => second.agentOf('a').calls.length === 1)
    assert.equal(second.rt.coordDb.getWork('x1').status, 'done')
    assert.match(text(second.agentOf('a').calls[0]), /The final plan is ready\./)
    assert.equal(second.agentOf('c').calls.length, 0)
  })
}

test('an answer a turn produced while DS Bot was not watching goes to the Bot that waits for it, once', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first)
  const workId = request.source.coordWorkId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.match(text(reply), /The plan is ready\./)
  assert.equal(second.rt.coordDb.getWork(workId).status, 'done')
  assert.equal(second.agentOf('b').calls.length, 0)

  // Chief reads the answer; another restart finds nothing left to settle.
  run(second, 'a', 1, reply)
  second.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await second.stop()

  const third = await start(home, logs)
  await realDelay(30)
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn whose record cannot be read pauses as needs_verification (fail-closed) and is not run again', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first)
  const workId = request.source.coordWorkId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  // DSH cannot read that Session's record (I/O error): fail closed to needs_verification, never re-run!
  const unreadable = async () => { throw Object.assign(new Error('disk I/O error'), { code: 'EIO' }) }
  const second = await start(home, logs, { pageOverride: unreadable })
  const paused = second.rt.coordDb.getWork(workId)
  assert.equal(paused.status, 'needs_verification', 'unreadable session log must fail closed as needs_verification')
  assert.equal(paused.pauseReason, 'delivery_status_unreadable')
  assert.equal(second.agentOf('b').calls.length, 0, 'unreadable work must not be blindly re-run')
  assert.equal(second.agentOf('a').calls.length, 0)
  await second.stop()

  // Another restart keeps it paused as needs_verification until human resumes.
  const third = await start(home, logs)
  await realDelay(30)
  assert.equal(third.rt.coordDb.getWork(workId).status, 'needs_verification')
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn that ended without saying anything settles cleanly without re-running', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first)
  const workId = request.source.coordWorkId
  logs.set('b', writerLog(request, undefined))
  await first.stop()

  const second = await start(home, logs)
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.equal(second.rt.coordDb.getWork(workId).status, 'done')
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('a turn that ended on the token limit settles via D2 with partial text and does not re-run', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first)
  const workId = request.source.coordWorkId
  logs.set('b', writerLog(request, 'The plan is ready, up to the limit.', { kind: 'max-tokens' }, { provider: 'gateway', model: 'step-5' }))
  await first.stop()

  const second = await start(home, logs)
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.equal(second.rt.coordDb.getWork(workId).status, 'done')
  assert.match(text(second.agentOf('a').calls[0]), /The plan is ready, up to the limit\./)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('a watched turn cut off without text tells the asker instead of finishing silently', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await askWriter(host)
  host.agentOf('b').session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5' } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const reply = text(host.agentOf('a').calls[0])
  assert.match(reply, /\[cut off at the model's output limit before it wrote anything\]/)
  assert.doesNotMatch(reply, /finished without a reply/)
  // It is on record with the route that was over its window.
  const entries = await readDiagnostics(home, list => list.some(entry => entry.code === 'MAX_TOKENS'))
  const cutOff = entries.filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(cutOff.length, 1)
  assert.match(cutOff[0].text, /before it wrote anything \(gateway\/step-5\)/)
})

test('a watched turn cut off after writing text is passed on marked unfinished', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await askWriter(host)
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The first half.' }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const reply = text(host.agentOf('a').calls[0])
  assert.match(reply, /The first half\./)
  assert.match(reply, /\[cut off at the model's output limit; the answer is not complete\]$/)
})

test('the answer that goes up keeps what came back for the work in answerText', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  const home = freshHome(t, state)
  const host = await start(home)
  host.rt.openWork('x1', { from: 'a', to: 'b', toSession: 'b' })
  host.rt.openWork('y1', { from: 'b', to: 'c', parent: 'x1', toSession: 'c' })
  host.rt.closeWork('y1', 'Reviewer', 'The numbers check out.', { deliverDirect: true })
  const combined = host.rt.answerText('x1', 'The plan is ready.', 'Writer')
  assert.match(combined, /The plan is ready\./)
  assert.match(combined, /Reviewer:\nThe numbers check out\./)
})

test('an answer that already settled is not sent again on restart', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first)
  const workId = request.source.coordWorkId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  first.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => first.agentOf('a').calls.length === 1)
  run(first, 'a', 1, first.agentOf('a').calls[0])
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await first.stop()

  const second = await start(home, logs)
  await realDelay(30)
  assert.equal(second.rt.coordDb.getWork(workId).status, 'done')
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])
})

test('a work that still waits for what it handed on stays waiting and is not prematurely settled', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  const home = freshHome(t, state)
  const first = await start(home)
  const request = await askWriter(first)
  const parentId = request.source.coordWorkId
  first.rt.openWork('y1', { from: 'b', to: 'c', parent: parentId, toSession: 'c' })
  assert.equal(first.rt.waitsWork(parentId), true)

  // Writer's turn ends while y1 is still open -> dsh-adapter yields parent work to `waiting`, NOT `done`!
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Waiting on Reviewer.' }] } })
  first.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(first.rt.coordDb.getWork(parentId).status, 'waiting', 'work with open child call must yield to waiting')
  assert.equal(first.agentOf('a').calls.length, 0)
  await first.stop()

  // Restart keeps parent work waiting (never settled prematurely).
  const second = await start(home)
  await realDelay(30)
  assert.equal(second.rt.coordDb.getWork(parentId).status, 'waiting')
  assert.equal(second.rt.waitsWork(parentId), true)
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a finished turn leaves nothing to pick up and writes zero inflight.json', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(existsSync(join(home, 'inflight.json')), false)
  assert.deepEqual(first.rt.coordDb.listInterruptedWorks(), [])
  await first.stop()

  const second = await start(home)
  await realDelay(30)
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a turn DSH stops as it shuts down (disposed) stays running for recovery; one the user stops settles stopped', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  const home = freshHome(t, state)
  const host = await start(home)

  await host.tool('delegate_work', { to: 'Writer', goal: 'Work disposed' }, 'a')
  await host.tool('delegate_work', { to: 'Reviewer', goal: 'Work user-stopped' }, 'a')
  await settle(() => host.agentOf('b').calls.length === 1 && host.agentOf('c').calls.length === 1)
  const reqB = host.agentOf('b').calls[0]
  const reqC = host.agentOf('c').calls[0]
  run(host, 'b', 1, reqB)
  run(host, 'c', 1, reqC)

  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })

  assert.equal(host.rt.coordDb.getWork(reqB.source.coordWorkId).status, 'running', 'disposed abort keeps work running for restart recovery')
  assert.equal(host.rt.coordDb.getWork(reqC.source.coordWorkId).status, 'stopped', 'user abort settles work as stopped')
})

test('unconsumed queued works survive restart, already-consumed or cancelled works do not re-run', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const fgB = first.rt.ensureForegroundWorkForBot('b')
  first.rt.coordDb.receiveMessage({ workId: fgB.workId, kind: 'request', dedupKey: 'k-plan', bodyPreview: 'Draft the plan', payload: { text: 'Draft the plan', role: 'request', exchangeId: 'ex-plan' }, wake: true })
  // Create a second independent task work that is cancelled before shutdown.
  first.rt.openWork('ex-cancelled', { from: 'a', to: 'b', toSession: 'b', goal: 'Never mind' })
  first.rt.cancelWork('ex-cancelled', { reason: 'user cancelled' })
  await first.stop()

  // Restart dispatches the queued foreground work once and never runs the cancelled work.
  const second = await start(home)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [delivered] = second.agentOf('b').calls
  assert.equal(delivered.source.exchangeId, 'ex-plan')
  assert.match(text(delivered), /Draft the plan/)
  assert.equal(second.rt.coordDb.getWork('ex-cancelled').status, 'stopped')
})

test('a queued request kept over a restart is dispatched however old (never dropped by age)', async (t) => {
  const home = freshHome(t)
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'a' })
    db.createWork({ workId: 'w-old', botId: 'b', kind: 'task', logicalAddress: 'task:w-old', status: 'idle', parentWorkId: 'fg:a', sessionId: 'b' })
    db.createCall({
      callId: 'c_w-old', parentWorkId: 'fg:a', childWorkId: 'w-old', callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'req-old', bodyPreview: 'Draft the plan', payload: { text: 'Draft the plan', role: 'request', exchangeId: 'w-old' } },
    })
  })

  const second = await start(home)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.equal(again.source.coordWorkId, 'w-old')
  assert.match(text(again), /Draft the plan/)

  run(second, 'b', 1, again)
  second.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.match(text(second.agentOf('a').calls[0]), /The plan is ready\./)
})

test('queued deliveries are kept whole in SQLite, not cut at fifty', async (t) => {
  const home = freshHome(t)
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'b' })
    for (let at = 1; at <= 55; at += 1) {
      db.receiveMessage({
        workId: 'fg:b', kind: 'request', dedupKey: `task-${at}`,
        bodyPreview: `Task ${at}`, payload: { text: `Task ${at}`, role: 'request', exchangeId: `ex-${at}` },
        wake: true,
      })
    }
  })

  const second = await start(home)
  await settle(() => second.agentOf('b').calls.length === 1)
  const body = text(second.agentOf('b').calls[0])
  assert.match(body, /Task 1/)
  assert.match(body, /Task 55/)
  assert.equal(second.rt.coordDb.listInbox('fg:b').length, 55, 'all 55 queued messages preserved without 50-item cap')
})

test('a delivery whose dispatch fails transiently stays queued in SQLite via D2 reconciliation and dispatches on next start', async (t) => {
  const home = freshHome(t)
  const first = await start(home, new Map(), {
    resolveAgentOverride: async (sid, fallback) => {
      if (sid === 'b') throw Object.assign(new Error('transient dispatch error'), { code: 'EIO' })
      return { agent: fallback(sid) }
    },
  })
  await first.tool('delegate_work', { to: 'Writer', goal: 'Draft the plan' }, 'a')
  // Dispatch failed before DSH accepted it -> D2 sees not_found in b's log -> coordDb requeues work instead of dropping it!
  const works = first.rt.coordDb.listWorks({ botId: 'b', kind: 'task', activeOnly: true })
  assert.equal(works.length, 1)
  assert.equal(works[0].status, 'queued', 'failed dispatch must requeue work in SQLite')
  await first.stop()

  const second = await start(home)
  await settle(() => second.agentOf('b').calls.length === 1)
  assert.equal(second.agentOf('b').calls[0].source.role, 'request')
  assert.match(text(second.agentOf('b').calls[0]), /Draft the plan/)
})

test('a reply that fails to reach the asker stays queued in SQLite and wakes the asker once its session recovers', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  const home = freshHome(t, state)
  const first = await start(home, new Map(), {
    resolveAgentOverride: async (sid, fallback) => {
      if (sid === 'b') throw Object.assign(new Error('transient b offline'), { code: 'EIO' })
      return { agent: fallback(sid) }
    },
  })
  first.rt.openWork('x1', { from: 'a', to: 'b', toSession: 'b' })
  first.rt.openWork('y1', { from: 'b', to: 'c', parent: 'x1', toSession: 'c' })
  // Reviewer finishes y1 -> result lands in x1's inbox, x1 dispatch to b fails transiently and stays queued!
  first.rt.closeWork('y1', 'Reviewer', 'The numbers check out.')
  await settle(() => first.rt.coordDb.getWork('y1').status === 'done')
  await realDelay(30)
  assert.equal(first.rt.coordDb.getWork('x1').status, 'queued', 'parent work x1 stays queued in SQLite after failed dispatch')
  await first.stop()

  // Next start: b is healthy -> x1 dispatches with Reviewer's result, Writer finishes and replies to Chief!
  const second = await start(home)
  await settle(() => second.agentOf('b').calls.length === 1)
  const notice = second.agentOf('b').calls[0]
  assert.match(text(notice), /The numbers check out\./)
  run(second, 'b', 2, notice)
  second.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  second.emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.match(text(second.agentOf('a').calls[0]), /The plan is ready\./)
})

test('new deliveries before recovery do not overwrite earlier queued inbox entries in SQLite', async (t) => {
  const home = freshHome(t)
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'b' })
    db.receiveMessage({ workId: 'fg:b', kind: 'request', dedupKey: 'k-before-1', bodyPreview: 'Task before shutdown', payload: { text: 'Task before shutdown', role: 'request' }, wake: true })
    db.receiveMessage({ workId: 'fg:b', kind: 'request', dedupKey: 'k-before-2', bodyPreview: 'Task before recovery', payload: { text: 'Task before recovery', role: 'request' }, wake: true })
  })

  const third = await start(home)
  await settle(() => third.agentOf('b').calls.length === 1)
  const body = text(third.agentOf('b').calls[0])
  assert.ok(body.indexOf('Task before shutdown') !== -1 && body.indexOf('Task before recovery') !== -1)
  assert.ok(body.indexOf('Task before shutdown') < body.indexOf('Task before recovery'), 'FIFO order preserved across restart')
})

test('a resend that cannot open the Session keeps queued works in SQLite for the next start', async (t) => {
  const home = freshHome(t)
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'b' })
    for (const msg of ['Task 1', 'Task 2', 'Task 3']) {
      db.receiveMessage({ workId: 'fg:b', kind: 'request', dedupKey: msg, bodyPreview: msg, payload: { text: msg, role: 'request' }, wake: true })
    }
  })

  // Session fails with transient error on start 2: all 3 stay queued in SQLite (none silently dropped).
  const second = await start(home, new Map(), {
    resolveAgentOverride: async (sid, fallback) => {
      if (sid === 'b') throw Object.assign(new Error('transient offline'), { code: 'EIO' })
      return { agent: fallback(sid) }
    },
  })
  assert.equal(second.rt.coordDb.listInbox('fg:b', { unreadOnly: true }).length, 3)
  assert.equal(second.rt.coordDb.getWork('fg:b').status, 'queued')
  await second.stop()

  // Next start delivers all three intact.
  const third = await start(home)
  await settle(() => third.agentOf('b').calls.length === 1)
  const body = text(third.agentOf('b').calls[0])
  assert.match(body, /Task 1/)
  assert.match(body, /Task 2/)
  assert.match(body, /Task 3/)
})

test('a child request kept for retry keeps its parent work waiting, and the result flows up after restart', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  const home = freshHome(t, state)
  const first = await start(home, new Map(), {
    resolveAgentOverride: async (sid, fallback) => {
      if (sid === 'c') throw Object.assign(new Error('transient c offline'), { code: 'EIO' })
      return { agent: fallback(sid) }
    },
  })
  first.rt.openWork('x1', { from: 'a', to: 'b', toSession: 'b' })
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a' } })
  await first.tool('delegate_work', { to: 'Reviewer', goal: 'Check the numbers' }, 'b')
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Reviewer is on the numbers.' }] } })
  first.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.equal(first.rt.waitsWork('x1'), true, 'parent x1 still waits for Reviewer child work')
  const childWork = first.rt.coordDb.listWorks({ botId: 'c', kind: 'task', activeOnly: true })[0]
  assert.ok(childWork !== undefined && childWork.status === 'queued', 'child work kept queued for retry')
  await first.stop()

  const second = await start(home)
  await settle(() => second.agentOf('c').calls.length === 1)
  run(second, 'c', 1, second.agentOf('c').calls[0])
  second.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
  second.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => second.agentOf('b').calls.length === 1)
  const reply = second.agentOf('b').calls[0]
  assert.match(text(reply), /The numbers check out\./)
  run(second, 'b', 2, reply)
  second.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  second.emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.match(text(second.agentOf('a').calls[0]), /The plan is ready\./)
})

const WRITTEN = 'Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>'
// A reply cut off inside the model's own call template keeps only its closing tags,
// as the group report shows (it pasted the CJK brackets the model wrote).
const ORPHAN_TAGS = '＜/parameter＞\n＜/function＞\n＜/tool_call＞'
const MIXED_TAGS = '＜/parameter＞ ＜parameter=name＞length"＞15 Hi, everyone.'

test('a tool call written as text gets one more turn on the same round slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Written again: the text goes on without the call.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Checking now.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('a group member that leaves only the call tags gets the same retry, and never posts the tags', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: ORPHAN_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Leftover tags again: the round gets one readable line, no markup.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: ORPHAN_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Tried to run a tool but wrote the call as text, so it did not run.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('call tags mixed into the text are stripped, and the readable part still goes out', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: MIXED_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.equal(retry.source.retried, true)
  assert.equal(result(), undefined)

  // Written again: what was said around the tags goes on, without them.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: MIXED_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  const [reply] = result().replies.map(entry => entry.text)
  assert.match(reply, /Hi, everyone\./)
  assert.doesNotMatch(reply, /parameter|function|tool_call/)
})

test('a group member cut off on the token limit is not counted as a silent pass', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  // The turn wrote nothing: the round must not read it as the member having passed.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['[cut off at the model\'s output limit before it wrote anything]'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('a group member cut off on the token limit keeps what it said and marks it unfinished', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Half of the answer.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Half of the answer.\n\n[cut off at the model\'s output limit; the answer is not complete]'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('in its own chat, a Bot that wrote a tool call as text is asked to make it', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'b', 1, { content: [{ type: 'text', text: 'move the docs' }], source: { kind: 'user' } })
  // A call made for real, with or without text around it, is no retry.
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const retry = host.agentOf('b').calls[0]
  assert.deepEqual([retry.source.role, retry.source.retried], ['retry', true])
  assert.match(text(retry), /^\[Your last reply wrote a tool call as text, so nothing ran\]/)
})

test('a written tool call is told apart from text about one', () => {
  assert.equal(writesToolCall(WRITTEN), true)
  assert.equal(writesToolCall('<function=read>\n<parameter=path>a.md</parameter></function>'), true)
  assert.equal(writesToolCall('Models such as Step write `<tool_call>` tags in their template.'), false)
  assert.equal(writesToolCall(undefined), false)
  assert.equal(stripWrittenCalls(WRITTEN), 'Checking now.')

  // A call cut off before its opening tags is still one.
  assert.equal(writesToolCall('</parameter>\n</function>\n</tool_call>'), true)
  assert.equal(writesToolCall(ORPHAN_TAGS), true)
  assert.equal(writesToolCall(MIXED_TAGS), true)
  assert.equal(stripWrittenCalls('</parameter>\n</function>\n</tool_call>'), '')
  assert.equal(stripWrittenCalls(ORPHAN_TAGS), '')
  assert.equal(stripWrittenCalls(MIXED_TAGS), 'length"＞15 Hi, everyone.')
  assert.equal(stripWrittenCalls('Checking </parameter> now.'), 'Checking now.')

  // Ordinary text keeps its marks, also when it talks about the tags.
  assert.equal(stripWrittenCalls('plain <text> with an angle or two'), 'plain <text> with an angle or two')
  assert.equal(writesToolCall('plain <text> with an angle or two'), false)
  assert.equal(stripWrittenCalls('a < b or c > d'), 'a < b or c > d')
})
