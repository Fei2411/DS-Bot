// #2361: a Main Bot that moved on to a fresh part must keep the team-admin tools
// (create_bot / stop_bot / create_group / delete_group) in every part, across
// restarts, even when the Bot record's own writeback was lost (a crash between
// creating the fresh part and saving it, or an older state overwriting the file).
// Ordinary Bots must never get them. Before the fix the fresh part resolved to no
// owner in that state, so the main scope fell to false and the pack was hidden.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { BUILTIN_PACKS } from '../src/host/builtin-packs.js'

let rt
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start({ services = {}, home: reuse, state: seed = TEAM } = {}) {
  const root = reuse === undefined
    ? realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-lineage-')))
    : join(reuse, '..', '..')
  const home = reuse ?? join(root, 'dsh', 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  if (reuse === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext({ services })
  ctx.logger = { warn: () => {}, info: () => {} }
  const created = []
  const agents = new Map()
  const cwds = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const nextStep = []
      const nextTurn = []
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, seq: 0, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: () => () => {} }, effect: fn => (typeof fn === 'function' ? fn() : undefined), on: () => () => {} },
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        send() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep, nextTurn,
          prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
          append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message) },
          remove() { return false },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [{ id: 'w1', path: team }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? team)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const writeState = (value) => writeFileSync(join(home, 'state.json'), JSON.stringify(value))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, rt, root, home, team, project, created, agentOf, call, tool, preStep, state, writeState, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await settle()
  }
}
const said = (id, body, exchangeId) => ({ id, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user', ...(exchangeId ? { exchangeId } : {}) } })
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  approval: { request: async () => 'allowed-once' },
}
const PACK = BUILTIN_PACKS['team-admin'].tools

// The ordinary case behind #2361: the Main Bot moves on to a fresh part and the
// team-admin tools must still be there — in the live host and after a restart —
// while an ordinary Bot never sees them.
test('the Main Bot keeps the team-admin tools in a fresh part and after a restart', async (t) => {
  const host = await start({ services })
  host.agentOf('a').status = 'running'
  assert.equal((await host.tool('update_bot', { work_dir: host.project }, 'a')).includes('From your next step on'), true)
  assert.deepEqual(await host.preStep('a', [said('m1', 'go on', 'e1')], 2), { kind: 'reject' })
  await until(() => host.state().bots.a.sessionId === 's1' && host.state().switching?.a === undefined)

  assert.equal(rt.selfOf('s1'), 'a')
  assert.deepEqual([...rt.hiddenBuiltinTools('s1')], [], 'team-admin must not be hidden in the fresh part')
  assert.equal(rt.toolScopeForTurn('s1').main, true)
  assert.equal(rt.toolScopeForTurn('b').main, false)
  for (const name of PACK) assert.equal(rt.hiddenBuiltinTools('b').has(name), true)
  const home = host.home
  await host.stop({ keep: true })

  const second = await start({ home, services })
  t.after(second.stop)
  assert.equal(second.rt.selfOf('s1'), 'a')
  assert.deepEqual([...second.rt.hiddenBuiltinTools('s1')], [], 'team-admin must survive a restart')
  assert.equal(second.rt.toolScopeForTurn('s1').main, true)
  assert.equal(second.rt.toolScopeForTurn('b').main, false)
  for (const name of PACK) assert.equal(second.rt.hiddenBuiltinTools('b').has(name), true)
})

// Drives the Main Bot onto a fresh part through the folder-move switch, then
// simulates the crash window: the state file as it was BEFORE the writeback save
// (the record lost its sessionId, the fresh part exists only in lineage evidence),
// and a restart.
test('a lost writeback after a part switch cannot take the team-admin tools away after a restart', async (t) => {
  const host = await start({ services })
  host.agentOf('a').status = 'running'
  assert.equal((await host.tool('update_bot', { work_dir: host.project }, 'a')).includes('From your next step on'), true)
  assert.deepEqual(await host.preStep('a', [said('m1', 'go on', 'e1')], 2), { kind: 'reject' })
  await until(() => host.state().bots.a.sessionId === 's1' && host.state().switching?.a === undefined)
  assert.equal(rt.selfOf('s1'), 'a')
  const current = host.state()

  // The crash window: the file holds only what survived — the lineage entry written
  // the moment the fresh part was created, but neither the writeback of the Bot
  // record nor the segment or the switch marker. Everything the switch wrote in
  // memory after that first save is gone. (Once the writeback lands, the entry is
  // redundant and dropped from the live file, so it is injected back here.)
  const drifted = structuredClone(current)
  delete drifted.bots.a.sessionId
  delete drifted.bots.a.segments
  delete drifted.switching
  drifted.partOwners = { s1: { botId: 'a', at: Date.now() } }
  host.writeState(drifted)
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  assert.equal(second.rt.selfOf('s1'), 'a', 'the fresh part must still resolve to the Main Bot')
  assert.equal(second.rt.isBotSession('s1'), true)
  assert.deepEqual([...second.rt.hiddenBuiltinTools('s1')], [], 'team-admin must not be hidden in the fresh part')
  assert.equal(second.rt.toolScopeForTurn('s1').main, true)
  // The ordinary Bot keeps no access, in its own part.
  assert.equal(second.rt.toolScopeForTurn('b').main, false)
  for (const name of PACK) assert.equal(second.rt.hiddenBuiltinTools('b').has(name), true)
})
