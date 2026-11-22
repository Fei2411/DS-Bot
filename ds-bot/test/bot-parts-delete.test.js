import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { closesBrowser } from '../src/host/browser/hold.js'
import { fakeContext } from './fake-ctx.js'

// Deleting a conversation (#1905): a part the user is not reading leaves the Bot's chat
// and its Session is archived; the part on screen stays, and a part still waiting to
// retire keeps its place until its reminders have moved.

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

test('a browser handoff raised from a deleted part stays with the user, detached from it', async (t) => {
  const { rt, stored, stop } = await start(seed({
    sessionId: 'b4',
    segments: earlier('b1', 'b2'),
  }))
  t.after(stop)
  const holds = []
  let hold = { sessionId: 'b1', callId: 'c1', by: 'Writer', reason: 'sign in' }
  rt.browserChannel = {
    holdOf: () => hold,
    setHold: (botId, next) => { holds.push([botId, next]); hold = next },
  }

  // Deleting another part leaves a hold on a part that is still there alone.
  await rt.deletePart('b', 'b2')
  assert.deepEqual(holds, [])

  // The hold's own part goes: the page stays in the user's hands with no conversation
  // attached, so Give back cannot answer the chat the user is reading, and the Bot's
  // browser tools stay refused until the user gives the page back.
  await rt.deletePart('b', 'b1')
  assert.deepEqual(holds.map(([botId]) => botId), ['b'])
  assert.equal(hold.by, 'user')
  assert.equal(hold.sessionId, undefined)
  assert.equal(hold.callId, undefined)
  assert.match(hold.note, /controlling this browser/)
  // Detached, so the hold subscriber leaves the user's Chromium window and tabs open
  // (`mountBrowserPlugin` closes a browser only when `closesBrowser(hold)` holds).
  assert.equal(hold.detached, true)
  assert.equal(closesBrowser(hold), false)
  assert.equal(closesBrowser({ by: 'user', reason: 'stopped' }), true)
  assert.deepEqual(stored().bots.b.retiredSessions, ['b2', 'b1'])
})

test('a part waiting to retire is refused until its tasks have moved', async (t) => {
  const { rt, archived, call, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)
  // A legacy part folded into the chat and still listed by `store.js` until `retireParts`
  // has moved its tasks: archiving it here would drop the reminders it is owed.
  rt.state.retiredParts = [{ sessionId: 'b1', botId: 'b' }]

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'b1' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bot/busy')
  assert.deepEqual(archived, [])

  // Once the retirement pass has moved them, the part deletes like any other.
  delete rt.state.retiredParts
  const after = await call('bot-delete-part', { botId: 'b', sessionId: 'b1' })
  assert.equal(after.ok, true)
  assert.deepEqual(archived.map(entry => entry.id), ['b1'])
})

test('a part with an unfinished move is refused, and its recovery record stays', async (t) => {
  const { rt, archived, call, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)
  // `startSwitch` drops the live job but leaves this record for `handOnHeld` when moving
  // the input or the reminders failed (parts.js, `runSwitch`).
  rt.state.switching = { b1: { botId: 'b' } }

  const out = await call('bot-delete-part', { botId: 'b', sessionId: 'b1' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bot/busy')
  assert.deepEqual(archived, [])
  // The part and the record are still there for the restart pass to finish the move.
  assert.deepEqual(rt.botOf('b').segments.map(segment => segment.sessionId), ['b1'])
  assert.deepEqual(rt.state.switching, { b1: { botId: 'b' } })
})

test('a deleted private part keeps its id on the Bot, so the archive stays closed', async (t) => {
  const { rt, stored, stop } = await start(seed({ segments: earlier('b1') }))
  t.after(stop)

  await rt.deletePart('b', 'b1')
  // The id is remembered after it leaves the chat list (#1939): privacy.js adds these
  // to the Sessions a private Bot speaks from.
  assert.deepEqual(stored().bots.b.retiredSessions, ['b1'])
  assert.deepEqual(stored().bots.b.segments ?? [], [])
})
