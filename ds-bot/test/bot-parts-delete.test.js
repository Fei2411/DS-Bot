import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Deleting a conversation (#1905): a part the user is not reading leaves the Bot's chat
// and its Session is archived; the part on screen stays, and a live parallel part goes
// with its own earlier parts once it is idle.

let rt

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-parts-delete-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const archived = []
  const agents = new Map()
  const agentFor = sessionId => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => [] },
        id: sessionId,
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
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
      archiveSession: async (id, options) => { archived.push({ id, options }) },
      unarchiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentFor(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stored = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await rt.load()
  return { rt, ctx, archived, emit, call, stored, home, stop }
}

const seed = (botExtra = {}) => ({
  version: 1,
  mainBotIds: ['b'],
  bots: { b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b2', createdAt: 1, ...botExtra } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

const earlier = (...ids) => ids.map((sessionId, index) => ({ sessionId, endedAt: index + 1 }))

test('deleting an earlier conversation takes it out of the Bot chat and archives it', async (t) => {
  const { archived, call, stored, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'b1' })
  assert.equal(out.ok, true)
  assert.equal(out.value, true)
  assert.deepEqual(archived.map(entry => entry.id), ['b1'])
  assert.equal(archived[0].options?.stopActivity, true)
  // The Bot keeps the conversation it is reading, and the deleted one is gone on disk.
  assert.equal(stored().bots.b.sessionId, 'b2')
  assert.deepEqual(stored().bots.b.segments ?? [], [])
})

test('the conversation on screen is never deleted from under the user', async (t) => {
  const { archived, call, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'b2' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bot/invalid')
  assert.match(out.error.message, /cannot be deleted/)
  assert.deepEqual(archived, [])
})

test('an unknown session, an empty id and an unknown Bot are refused', async (t) => {
  const { archived, call, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)

  const missing = await call('bot-delete-part', { botId: 'b', sessionId: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bot/not-found')
  const empty = await call('bot-delete-part', { botId: 'b', sessionId: '' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'bot/not-found')
  const bot = await call('bot-delete-part', { botId: 'ghost', sessionId: 'b1' })
  assert.equal(bot.ok, false)
  assert.equal(bot.error.message, 'Unknown Bot')
  assert.deepEqual(archived, [])
})

test('a background task session is refused: tasks are read-only', async (t) => {
  const { archived, call, stop } = await start(seed({
    segments: earlier('b1'),
    tasks: [{ id: 't1', title: 'Clean up', sessionId: 'tb', status: 'running', segments: [] }],
  }))
  t.after(stop)

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'tb' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bot/invalid')
  assert.match(out.error.message, /Background tasks/)
  assert.deepEqual(archived, [])
})

test('an idle parallel conversation goes with its own earlier parts', async (t) => {
  const { archived, call, stored, stop } = await start(seed({
    segments: earlier('b1'),
    openParts: [{ sessionId: 'o1', segments: earlier('o0'), startedAt: 5 }],
  }))
  t.after(stop)

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'o1' })
  assert.equal(out.ok, true)
  assert.deepEqual(archived.map(entry => entry.id).sort(), ['o0', 'o1'])
  // Its thread ends here, so the parts it was reading in that thread go with it.
  assert.equal(stored().bots.b.openParts, undefined)
  // The foreground chat and its own earlier parts are untouched.
  assert.equal(stored().bots.b.sessionId, 'b2')
  assert.deepEqual(stored().bots.b.segments.map(segment => segment.sessionId), ['b1'])
})

test('a parallel conversation that is working is refused, and deletable once it stops', async (t) => {
  const { archived, call, emit, stop } = await start(seed({
    openParts: [{ sessionId: 'o1', segments: [], startedAt: 5 }],
  }))
  t.after(stop)

  emit('o1', 'turn/start', { turn: 1 })
  const busy = await call('bot-delete-part', { botId: 'b', sessionId: 'o1' })
  assert.equal(busy.ok, false)
  assert.equal(busy.error.code, 'bot/busy')
  assert.deepEqual(archived, [])

  emit('o1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const after = await call('bot-delete-part', { botId: 'b', sessionId: 'o1' })
  assert.equal(after.ok, true)
  assert.deepEqual(archived.map(entry => entry.id), ['o1'])
})
