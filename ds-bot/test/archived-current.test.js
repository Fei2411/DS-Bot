import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A team whose current Sessions DSH holds archived: Writer's current part `w2`, the
// group's own Session `g1` and Writer's group Session `gw`. `w1` is an earlier part
// and stays archived.
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

test('current team Sessions held archived by DSH are taken back out; earlier parts stay', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-archived-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const archived = new Set(['w1', 'w2', 'g1', 'gw', 'outside'])
  const unarchived = []
  ctx.workspaceRegistry = {
    ...ctx.workspaceRegistry,
    get archivedSessionIds() { return [...archived] },
    unarchiveSession: async (id) => { archived.delete(id); unarchived.push(id) },
  }
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }) }))).json()
  // The unarchive runs after the load returns.
  for (let i = 0; i < 20 && unarchived.length < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(unarchived.sort(), ['g1', 'gw', 'w2'])
  assert.deepEqual([...archived].sort(), ['outside', 'w1'])
})
