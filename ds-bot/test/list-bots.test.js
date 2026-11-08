import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief (Main, its own chat 'a'), Writer (in group Ops) and Reader (in group Docs).
// Writer's own chat carries a question card that has waited two days (#1141).
const DAY = 24 * 60 * 60_000
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Reader', role: 'Read', sessionId: 'c', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} },
    r2: { id: 'r2', name: 'Docs', members: ['c'], mode: 'admin', admin: 'c', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: { b: { id: 'q1', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, askedAt: Date.now() - 2 * DAY } },
  prefs: {},
  revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-list-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {}, steer: () => {}, cancel: () => {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { tool, stop }
}

test('list_bots narrows to one Bot and leaves the rest out', async (t) => {
  const host = await start()
  t.after(host.stop)
  const all = await host.tool('list_bots', {}, 'a')
  assert.match(all, /- Chief/)
  assert.match(all, /- Writer/)
  assert.match(all, /- Reader/)

  const one = await host.tool('list_bots', { bot: 'Writer' }, 'a')
  assert.match(one, /- Writer/)
  assert.doesNotMatch(one, /- Chief/)
  assert.doesNotMatch(one, /- Reader/)
})

test('list_bots narrows to the members of one group', async (t) => {
  const host = await start()
  t.after(host.stop)
  const ops = await host.tool('list_bots', { group: 'Ops' }, 'a')
  assert.match(ops, /- Writer/)
  assert.doesNotMatch(ops, /- Reader/)
  // Only the group asked for is described, not the whole list of groups.
  assert.match(ops, /- "Ops"/)
  assert.doesNotMatch(ops, /- "Docs"/)
})

test('a name that matches nothing says so instead of printing the whole roster', async (t) => {
  const host = await start()
  t.after(host.stop)
  assert.match(await host.tool('list_bots', { bot: 'Ghost' }, 'a'), /No Bot named "Ghost"/)
  assert.match(await host.tool('list_bots', { group: 'Ghost' }, 'a'), /No group chat named "Ghost"/)
  // A Bot outside that group is reported as missing from it, not silently listed.
  assert.match(await host.tool('list_bots', { bot: 'Reader', group: 'Ops' }, 'a'), /No Bot named "Reader" in "Ops"/)
})

test('a waiting card says how long it has waited', async (t) => {
  const host = await start()
  t.after(host.stop)
  const all = await host.tool('list_bots', {}, 'a')
  assert.match(all, /a question card in its own chat waits for the user's answer \(for 2880 min\)/)
})
