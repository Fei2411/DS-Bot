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

// #1501: a Bot's own chat can keep a second part live. The current part stays
// `chatOf`; parts opened while the Bot was busy stay live in `openParts` with their own
// earlier parts, and neither is archived or stopped when the other one takes over.

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

// Writer's foreground thread is `w2` (earlier part `w1`); a part opened while it was
// busy is `w3`, with its own earlier part `w4`.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: {
      id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2,
      segments: [{ sessionId: 'w1', endedAt: 3 }],
      openParts: [{ sessionId: 'w3', segments: [{ sessionId: 'w4', endedAt: 5 }], startedAt: 6 }],
    },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function team(t, archived = []) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-parallel-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const registry = await dshRegistry(t, join(home, 'dsh'), ['m1', 'w1', 'w2', 'w3', 'w4'], ctx)
  for (const id of archived) await registry.archiveSession(SessionId(id), { stopActivity: true })
  ctx.workspaceRegistry = registry
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { home, registry, call, rt }
}

const saved = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

test('the state lists the live open part and reads its run state, while chatOf stays the current part', async (t) => {
  const { call, rt } = await team(t)
  const first = (await call('state')).value
  assert.equal(first.bots.find(bot => bot.id === 'w1').sessionId, 'w2')
  assert.deepEqual(first.bots.find(bot => bot.id === 'w1').openParts.map(part => part.sessionId), ['w3'])
  assert.equal(first.partsRunning.w3, undefined)
  rt.live.set('w3', { turn: {} })
  const second = (await call('state')).value
  const writer = second.bots.find(bot => bot.id === 'w1')
  assert.equal(writer.sessionId, 'w2')
  // The run state comes from the live turns, not from the stored part.
  assert.equal(second.partsRunning.w3, true)
  assert.equal(second.partsRunning.w2, undefined)
  assert.deepEqual(writer.openParts[0].parts, ['w4'])
})

test('opening a live part swaps the threads and archives nothing', async (t) => {
  const { home, registry, call } = await team(t, ['w1'])
  await call('state')
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w3' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w3')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w4'])
  assert.equal(writer.openParts[0].sessionId, 'w2')
  assert.deepEqual(writer.openParts[0].segments.map(segment => segment.sessionId), ['w1'])
  // Neither part was archived or stopped: both are still live.
  assert.deepEqual([...registry.archivedSessionIds], ['w1'])
})

test('a new part made while the Bot works starts at once and leaves the running part live', async (t) => {
  const { home, registry, call, rt } = await team(t)
  await call('state')
  rt.live.set('w2', { turn: {} })
  rt.resolveAgent = async () => ({ id: 'w2', status: 'running', session: { requestHeader: () => undefined } })
  rt.createSession = async () => 'w5'
  const result = await call('bot-new-part', { botId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w5')
  assert.deepEqual(writer.segments, [])
  assert.deepEqual(writer.openParts.map(part => part.sessionId), ['w3', 'w2'])
  assert.deepEqual(writer.openParts.at(-1).segments.map(segment => segment.sessionId), ['w1'])
  // The running part is not archived and its turn is left alone.
  assert.deepEqual([...registry.archivedSessionIds], [])
  assert.deepEqual(rt.live.get('w2'), { turn: {} })
  assert.equal(rt.chatOwners.get('w5'), 'w1')
})

test('a foreground switch to an archived part does not touch the background part', async (t) => {
  const { home, registry, call, rt } = await team(t, ['w1'])
  await call('state')
  rt.live.set('w3', { turn: {} })
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w1')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w2'])
  // The background part and its chain stay exactly where they were.
  assert.equal(writer.openParts[0].sessionId, 'w3')
  assert.deepEqual(writer.openParts[0].segments.map(segment => segment.sessionId), ['w4'])
  // Only the part the foreground left is archived; the background part stays live.
  assert.deepEqual([...registry.archivedSessionIds], ['w2'])
})
