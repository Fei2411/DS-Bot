// Waits a Bot gave up: one hand-off that will not come back is closed with an explicit
// result, so the work above it goes on instead of waiting forever.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

let rt

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Editor', role: 'Edit', sessionId: 'd', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// A host over the plugin's own folder. Starting the same folder again is a restart:
// the first host is closed before the second one starts.
async function startHost(home, team, options = {}) {
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  // Scoped Cordis events (subagent lifecycle, tool results) reach the plugin
  // through a dispatch carrier DSH keys by the agent the event is for — that
  // carrier is what `this` is in a real listener call.
  const emitScoped = (parentId, name, ...args) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, ...args)
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, emitScoped, tool, call, home, stop: () => ctx.dispose() }
}

// The plugin folder of a test, and the hosts over it. A second host over the same
// folder is a restart. Everything is closed and removed when the test ends.
function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-results-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (team, options) => { const host = await startHost(home, team, options); hosts.push(host); return host } }
}

const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const textOf = content => content.map(block => block.text ?? '').join('\n')
const callsOf = (agents, id) => agents.get(id)?.calls ?? []
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const open = (id, message) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const take = id => open(id, agents.get(id).calls.at(-1)[1])
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, open, end, userTurn }
}

// The works the team file holds, once the saves made so far are done.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works ?? {}
}

// Chief asks Writer for work, and Writer hands it on to Tester and ends its turn, so
// Writer waits for a reply that never comes.
async function waitingForTester(start) {
  const host = await start(seed())
  const { agents, emit, tool } = host
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  turns.end('b', 'handed it on')
  const works = await worksIn(host)
  const parent = Object.entries(works).find(([, work]) => work.to === 'b')
  const child = Object.entries(works).find(([, work]) => work.to === 'c')
  assert.ok(parent, 'the work Chief asked Writer for is saved')
  assert.ok(child, 'the work Writer handed Tester is saved')
  return { host, turns, parent: parent[0], child: child[0] }
}

test('giving up one wait closes that branch and the work above it goes on', async (t) => {
  const { start } = bench(t)
  const { host, turns, parent, child } = await waitingForTester(start)
  const { agents, call } = host
  const waiting = (await call('state', {})).value.work.waiting
  assert.deepEqual(waiting.b.waits.map(item => item.to), ['c'])
  assert.equal(waiting.b.waits[0].id, child)

  // The user picks the wait in the Bot's menu.
  const before = callsOf(agents, 'b').length
  assert.equal((await call('abandon-work', { id: child })).ok, true)
  const after = await worksIn(host)
  assert.equal(after[child], undefined)
  assert.deepEqual(after[parent].open, [])
  assert.equal(after[parent].results.length, 1)
  assert.equal(after[parent].results[0].abandoned, true)
  assert.match(after[parent].results[0].text, /No reply came back from Tester/)
  assert.match(after[parent].results[0].text, /gave up waiting/)
  const quiet = (await call('state', {})).value.work.waiting
  assert.equal(quiet.b, undefined)

  // Writer is brought back with that result, and its answer goes up to Chief.
  await settled(() => callsOf(agents, 'b').length === before + 1)
  const back = callsOf(agents, 'b').at(-1)[1]
  assert.match(textOf(back.content), /^\[Waiting given up · Tester did not hand back this work/)
  assert.match(textOf(back.content), /gave up waiting/)
  turns.open('b', back)
  turns.end('b', 'finished without it')
  await settled(() => callsOf(agents, 'a').length === 1)
  const up = textOf(callsOf(agents, 'a')[0][1].content)
  assert.match(up, /finished without it/)
  assert.match(up, /No reply came back from Tester/)
  assert.equal((await worksIn(host))[parent], undefined)
})

test('a reply that arrives after the wait was given up is a late answer', async (t) => {
  const { start } = bench(t)
  const { host, turns, parent, child } = await waitingForTester(start)
  const { agents, call } = host
  await call('abandon-work', { id: child })
  const before = await worksIn(host)

  // Tester finally answers the request it still had.
  turns.take('c')
  turns.end('c', 'here is the late answer')
  await settled(() => callsOf(agents, 'b').length === 3)
  const after = await worksIn(host)
  // The wait was settled once already: no second result, no wait again.
  assert.equal(after[parent].results.length, before[parent].results.length)
  assert.equal(after[child], undefined)
  assert.equal((await call('state', {})).value.work.waiting.b, undefined)
  // Its content still reaches Writer, marked as the late answer it is.
  const late = callsOf(agents, 'b').at(-1)[1]
  assert.match(textOf(late.content), /\[Late answer: the user had already given up waiting for this work/)
  assert.match(textOf(late.content), /here is the late answer/)
  assert.equal(late.source.work, undefined)
  assert.deepEqual((await worksIn(host)).abandonedWorks ?? {}, {})
})

test('giving up one branch leaves the other open works of the same work', async (t) => {
  const { start } = bench(t)
  const host = await start(seed())
  const { agents, emit, tool, call } = host
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  await tool('message_bot', { to: 'Editor', message: 'edit the draft' }, 'b')
  turns.end('b', 'handed both on')
  const works = await worksIn(host)
  const parent = Object.entries(works).find(([, work]) => work.to === 'b')[0]
  const tester = Object.entries(works).find(([, work]) => work.to === 'c')[0]
  const editor = Object.entries(works).find(([, work]) => work.to === 'd')[0]
  assert.deepEqual(works[parent].open, [tester, editor])

  const before = callsOf(agents, 'b').length
  await call('abandon-work', { id: tester })
  const after = await worksIn(host)
  assert.deepEqual(after[parent].open, [editor])
  assert.equal(after[parent].results.length, 1)
  assert.equal((await call('state', {})).value.work.waiting.b.waits.length, 1)
  assert.equal(callsOf(agents, 'a').length, 0, 'Chief hears nothing until Writer is done')

  // Editor's real reply still comes back, and Writer settles upward once with both.
  await settled(() => callsOf(agents, 'b').length === before + 1)
  turns.take('d')
  turns.end('d', 'editor done')
  await settled(() => callsOf(agents, 'b').length === before + 2)
  turns.open('b', callsOf(agents, 'b').at(-1)[1])
  turns.end('b', 'both accounted for')
  await settled(() => callsOf(agents, 'a').length === 1)
  const up = textOf(callsOf(agents, 'a')[0][1].content)
  assert.equal(up.match(/No reply came back from Tester/g).length, 1)
  assert.equal(up.match(/editor done/g).length, 1)
  assert.match(up, /both accounted for/)
})

test('a given-up wait stays given up across a restart', async (t) => {
  const { start } = bench(t)
  const first = await waitingForTester(start)
  await first.host.call('abandon-work', { id: first.child })
  const saved = await worksIn(first.host)
  await first.host.stop()

  const second = await start()
  await second.tool('list_bots', {}, 'a')
  const works = await worksIn(second)
  assert.equal(works[first.child], undefined)
  assert.equal(works[first.parent].results.length, saved[first.parent].results.length)
  assert.equal(works[first.parent].results[0].abandoned, true)
  assert.equal((await second.call('state', {})).value.work.waiting.b, undefined)
})

test('a restart gives up a wait whose target no longer exists, and only those', async (t) => {
  const team = seed()
  delete team.bots.c
  team.works = {
    p1: { from: 'a', to: 'b', open: ['gone-bot'], results: [], at: 1 },
    'gone-bot': { from: 'b', to: 'c', parent: 'p1', open: [], results: [], at: 2 },
    p2: { from: 'a', to: 'b', open: ['live-bot'], results: [], at: 3 },
    'live-bot': { from: 'b', to: 'd', parent: 'p2', open: [], results: [], at: 4 },
    p3: { from: 'b', to: 'd', open: ['gone-room'], results: [], at: 5 },
    'gone-room': { from: 'd', room: 'no-such-room', parent: 'p3', open: [], results: [], at: 6 },
  }
  const { home, start } = bench(t)
  const host = await start(team)
  await settled(() => {
    try {
      const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
      return saved.works?.['gone-bot'] === undefined && saved.works?.['gone-room'] === undefined
    } catch { return false }
  })
  const works = await worksIn(host)
  // The deleted Bot and the deleted group are given up, each with a result above.
  assert.equal(works['gone-bot'], undefined)
  assert.equal(works.p1.results[0].abandoned, true)
  assert.equal(works.p1.results[0].abandonedReason, 'gone')
  assert.match(works.p1.results[0].text, /is no longer on the team/)
  assert.equal(works['gone-room'], undefined)
  assert.equal(works.p3.results[0].abandoned, true)
  // A target that still exists and has not answered keeps waiting, even across a restart.
  assert.ok(works['live-bot'] !== undefined)
  assert.deepEqual(works.p2.open, ['live-bot'])
  assert.equal(works.p2.results.length, 0)
  // Writer hears about the wait that was given up for it.
  await settled(() => callsOf(host.agents, 'b').length >= 1)
  assert.match(textOf(callsOf(host.agents, 'b').at(-1)[1].content), /^\[Waiting given up · the other Bot did not hand back this work/)
})

// A subagent run's Session cannot be told gone for certain: DSH says nothing both
// when the Session is gone and when it cannot be read (resume.js relies on the same
// reading). The sweep leaves such a wait to the user's menu, whether the read is
// missing, refuses, times out, says nothing, or returns a live log.
test('a restart leaves a subagent wait alone, whatever the Session read says', async (t) => {
  const cases = [
    ['the host cannot read Sessions', undefined],
    ['the read refuses', async () => { throw new Error('inspect timed out') }],
    ['the read says nothing', async () => undefined],
    ['the read returns a live log', async () => ({ events: [] })],
  ]
  for (const [label, inspect] of cases) {
    const team = seed()
    delete team.bots.c
    team.works = {
      p1: { from: 'a', to: 'b', open: ['gone-bot'], results: [], at: 1 },
      'gone-bot': { from: 'b', to: 'c', parent: 'p1', open: [], results: [], at: 2 },
      p2: { from: 'a', to: 'b', open: ['r1'], results: [], at: 3 },
      r1: { from: 'b', parent: 'p2', child: 'sub1', name: 'subagent review', open: [], results: [], at: 4 },
    }
    const { home, start } = bench(t)
    const host = await start(team, { inspect })
    // The sweep ran: the work for the deleted Bot is settled.
    await settled(() => {
      try {
        return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works?.['gone-bot'] === undefined
      } catch { return false }
    })
    const works = await worksIn(host)
    assert.equal(works['gone-bot'], undefined, label)
    assert.equal(works.p1.results[0].abandonedReason, 'gone', label)
    // The run keeps waiting, and its Bot is not woken for it.
    assert.ok(works.r1 !== undefined, label)
    assert.deepEqual(works.p2.open, ['r1'], label)
    assert.equal(works.p2.results.length, 0, label)
    await settled(() => callsOf(host.agents, 'b').length === 1)
    await delay(20)
    assert.equal(callsOf(host.agents, 'b').length, 1, label)
    assert.equal((await host.call('state', {})).value.work.waiting.b.waits.length, 1, label)
  }
})
