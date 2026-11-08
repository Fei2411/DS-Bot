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

// DSH 0.2.2 exports the JSONL persistence as a plugin module; earlier DSH as a default class.
const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

// DSH's own Workspace registry, which holds the archive, on files in a temporary folder.
// The listed Sessions count as live, so they can be archived. The plugin's archive hooks
// on `plugin` (a fake context) run inside an archive as DSH runs them.
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
    host.inject(['workspaceRegistry'], inner => {
      clearTimeout(timer)
      resolve(inner.workspaceRegistry)
    })
  })
}

// Writer's current part is `w2`, its earlier part `w1`; the group's own Session is `g1`
// and Writer's Session in the group `gw`.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4, sessions: { w1: 'gw' } } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function team(t, archived) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-archived-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const registry = await dshRegistry(t, join(home, 'dsh'), ['m1', 'w1', 'w2', 'g1', 'gw', 'outside'], ctx)
  for (const id of archived) await registry.archiveSession(SessionId(id), { stopActivity: true })
  ctx.workspaceRegistry = registry
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { home, registry, call, rt }
}

const settled = async (check) => {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

test('opening an earlier part takes it out of the archive and archives the part it replaces', async (t) => {
  const { home, registry, call } = await team(t, ['w1'])
  await call('state')
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  await settled(() => registry.archivedSessionIds.includes('w2'))
  assert.deepEqual([...registry.archivedSessionIds].sort(), ['w2'])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.w1
  assert.equal(saved.sessionId, 'w1')
  assert.deepEqual(saved.segments.map(segment => segment.sessionId), ['w2'])
})

test('current team Sessions held archived in DSH are taken back out; earlier parts stay', async (t) => {
  const { registry, call } = await team(t, ['w1', 'w2', 'g1', 'gw', 'outside'])
  await call('state')
  await settled(() => registry.archivedSessionIds.length === 2)
  assert.deepEqual([...registry.archivedSessionIds].sort(), ['outside', 'w1'])
})

test('a current Session archived in DSH while the team runs is taken back out', async (t) => {
  const { registry, call } = await team(t, [])
  await call('state')
  await registry.archiveSession(SessionId('w2'), { stopActivity: true })
  await registry.archiveSession(SessionId('gw'))
  await registry.archiveSession(SessionId('outside'))
  await settled(() => registry.archivedSessionIds.length === 1)
  assert.deepEqual([...registry.archivedSessionIds], ['outside'])
})

test('a failed task move keeps the replaced part marked for the restart pass', async (t) => {
  const { home, registry, call, rt } = await team(t, ['w1'])
  await call('state')
  rt.moveSchedules = async () => { throw new Error('schedule store unavailable') }
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual([...registry.archivedSessionIds], [])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.bots.w1.sessionId, 'w1')
  assert.deepEqual(saved.switching, { w2: { botId: 'w1' } })
})
