import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A Bot has one conversation at a time. Parallel parts (#1548) were withdrawn: a new
// session replaces the current part only while the Bot is idle, and a team saved with
// parallel parts keeps them as earlier parts of the Bot's chat, archived.

const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

async function dshRegistry(t, root, live, plugin) {
  const host = new Context()
  t.after(() => host.fiber.dispose())
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  await host.plugin(SessionPersistence, { root: join(root, 'sessions') })
  await host.plugin({ name: 'live-sessions', apply: inner => inner.provide('sessions', { list: () => [], get: id => (live.includes(id) ? {} : undefined) }) })
  await host.plugin({
    name: 'plugin-hooks',
    apply: (inner) => {
      const hooks = name => plugin.listeners.get(name) ?? []
      inner.on('workspace/session-stop', payload => Promise.all(hooks('workspace/session-stop').map(listener => listener(payload))))
      inner.on('workspace/session-activity', (payload, next) => hooks('workspace/session-activity').reduceRight((rest, listener) => () => listener(payload, rest), next)())
    },
  })
  await host.plugin(WorkspaceRegistry)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Workspace registry did not start')), 5000)
    host.inject(['workspaceRegistry'], (inner) => {
      clearTimeout(timer)
      resolve(inner.workspaceRegistry)
    })
  })
}

// Writer's chat is `w2` with its earlier part `w1`.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// A team saved by a version with parallel parts: `w3` was opened while Writer was busy,
// with its own earlier part `w4`.
const LEGACY = JSON.parse(JSON.stringify(TEAM))
LEGACY.bots.w1.openParts = [{ sessionId: 'w3', segments: [{ sessionId: 'w4', endedAt: 5 }], startedAt: 6 }]

async function team(t, archived = [], state = TEAM, live = ['m1', 'w1', 'w2', 'w3', 'w4', 'w5']) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-parallel-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({})
  const registry = await dshRegistry(t, join(home, 'dsh'), live, ctx)
  for (const id of archived) await registry.archiveSession(SessionId(id), { stopActivity: true })
  ctx.workspaceRegistry = registry
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { home, registry, call, ctx, rt }
}

const saved = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await new Promise(resolve => setImmediate(resolve))
  }
}


const idleAgent = (followed = []) => ({
  id: 'w2', status: 'idle',
  session: { id: 'w2', header: {}, requestHeader: () => ({}), deriveMessages: () => [], toolHistory: () => [] },
  whenIdle: async () => {},
  runMaintenance: async job => job(AbortSignal.timeout(5_000)),
  inbox: { nextStep: [], nextTurn: [], remove: () => {} },
  followup: message => followed.push(message),
  inject: () => {},
  send: async () => {},
})

const readyForSwitch = (rt, ctx, agent) => {
  rt.resolveAgent = async () => agent
  rt.eventsBackwards = async function* () {}
  ctx.sessions = { flush: async () => {} }
  rt.runningJobs = () => []
  rt.createSession = async () => 'w5'
}

test('a team saved with parallel parts keeps them as earlier parts and archives them', async (t) => {
  const { home, registry, call, rt } = await team(t, [], LEGACY)
  const state = await call('state')
    const writer = state.value.bots.find(bot => bot.id === 'w1')
  assert.equal(writer.openParts, undefined)
  assert.equal(writer.sessionId, 'w2')
  assert.deepEqual(writer.parts, ['w1', 'w4', 'w3'])
  assert.equal(rt.chatOf('w1'), 'w2')
  // Still the Bot's, so its history reads, but no longer a live chat of its own.
  assert.equal(rt.selfOf('w3'), 'w1')
  assert.equal(rt.chatOwners.get('w3'), undefined)
  await until(() => [...registry.archivedSessionIds].includes('w3'))
  const kept = saved(home).bots.w1
  assert.equal(Object.hasOwn(kept, 'openParts'), false)
  assert.deepEqual(kept.segments.map(segment => segment.sessionId), ['w1', 'w4', 'w3'])
})

for (const [what, options] of [['a new session', {}], ['a blank session', { blank: true }], ['a handoff', { handoff: true }]]) {
  test(`${what} is refused while the Bot works and starts no part`, async (t) => {
    const { home, registry, call, rt } = await team(t)
    await call('state')
    rt.resolveAgent = async () => ({ id: 'w2', status: 'running', session: { id: 'w2', requestHeader: () => undefined } })
    const made = []
    rt.createSession = async (...args) => { made.push(args); return 'w5' }
    const result = await call('bot-new-part', { botId: 'w1', ...options })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/busy')
    assert.equal(made.length, 0)
    assert.deepEqual([...registry.archivedSessionIds], [])
    const writer = saved(home).bots.w1
    assert.equal(writer.sessionId, 'w2')
    assert.equal(writer.openParts, undefined)
    assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w1'])
  })
}

// The private chat's own work also blocks a new session: a running subagent, a waiting
// approval or a background job means the part is not idle, and the switch would archive
// it mid-work. A job list that cannot be read proves nothing and counts as busy.
for (const [what, mark] of [
  ['a subagent works', rt => { rt.hasSubagents = () => true }],
  ['an approval waits', rt => { rt.waitsForApproval = () => true }],
  ['a background job runs', rt => { rt.runningJobs = () => [{ id: 'j1', status: 'running' }] }],
  ['the job list cannot be read', rt => { rt.runningJobs = () => undefined }],
]) {
  for (const options of [{ blank: true }, { handoff: true }]) {
    test(`a ${options.blank ? 'blank session' : 'handoff'} is refused while ${what} in a private chat`, async (t) => {
      const { home, registry, call, rt } = await team(t)
      await call('state')
      rt.resolveAgent = async () => ({ id: 'w2', status: 'idle', session: { id: 'w2', requestHeader: () => undefined } })
      const made = []
      rt.createSession = async (...args) => { made.push(args); return 'w5' }
      mark(rt)
      const result = await call('bot-new-part', { botId: 'w1', ...options })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bot/busy')
      assert.equal(made.length, 0)
      assert.deepEqual([...registry.archivedSessionIds], [])
      assert.equal(saved(home).bots.w1.sessionId, 'w2')
    })
  }
}

test('a handoff replaces the idle part and starts the fresh one with the handoff package', async (t) => {
  const { home, registry, call, ctx, rt } = await team(t)
  await call('state')
  const followed = []
  readyForSwitch(rt, ctx, idleAgent(followed))
  const result = await call('bot-new-part', { botId: 'w1', handoff: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w5')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w1', 'w2'])
  assert.equal(writer.openParts, undefined)
  assert.deepEqual([...registry.archivedSessionIds], ['w2'])
  assert.equal(followed.length, 1)
  assert.match(String(followed[0]?.content?.[0]?.text ?? ''), /\[Handoff · part 3\]/)
})

// #1792: a blank session leaves a stuck conversation without carrying it along, but it
// still replaces the part: the old one is archived, not kept running beside it.
test('a blank session replaces the idle part and carries nothing over', async (t) => {
  const { home, registry, call, ctx, rt } = await team(t)
  await call('state')
  const followed = []
  readyForSwitch(rt, ctx, idleAgent(followed))
  const result = await call('bot-new-part', { botId: 'w1', blank: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w5')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w1', 'w2'])
  assert.equal(writer.openParts, undefined)
  assert.deepEqual([...registry.archivedSessionIds], ['w2'])
  assert.deepEqual(followed, [])
  assert.equal(rt.chatOwners.get('w5'), 'w1')
  assert.equal(rt.chatOwners.get('w2'), undefined)
})
