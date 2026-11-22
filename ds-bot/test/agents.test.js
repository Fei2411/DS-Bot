import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'
import { installAgentForks } from '../src/client/agent-fork.js'

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }

// Enough of the dsh services for the roster and the agents module; tool restrict
// calls and archived Sessions are recorded for the assertions.
let rt
function start(team, { config = {}, lock } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agents-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  if (lock !== undefined) writeFileSync(join(home, 'state.lock'), JSON.stringify(lock))
  const ctx = fakeContext()
  const workspaces = new Map()
  const created = []
  const archived = []
  const failArchive = { on: false }
  // Session id -> the id a WorkspaceUnknownSessionError names (usually itself):
  // the Session a third-party manager permanently deleted.
  const missing = new Map()
  const restricted = []
  const scoped = []
  const renamed = []
  let sessions = 0
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'read', 'write'].map(name => ({ name }))
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId) => {
        if (missing.has(sessionId)) {
          throw Object.assign(
            new Error(`cannot archive session '${missing.get(sessionId)}': live sessions and session persistence hold no such session`),
            { name: 'WorkspaceUnknownSessionError', sessionId: missing.get(sessionId) },
          )
        }
        if (failArchive.on) throw new Error('session is running')
        archived.push(sessionId)
      },
    },
    sessionController: {
      create: async (options) => {
        created.push(options)
        return { sessionId: `s${++sessions}` }
      },
      resolveAgent: async (sessionId) => {
        const agent = {
          session: { id: sessionId },
          ctx: {
            tools: {
              register: (tool) => { scoped.push({ sessionId, name: tool.name }); return () => {} },
              restrict: (filter) => { restricted.push({ sessionId, filter }); return () => {} },
            },
            effect: execute => execute(),
          },
          followup() {},
        }
        return { agent }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async (session, title) => { renamed.push({ id: session.id, title }) } },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const createdAgents = payload => (ctx.listeners.get('agent/created') ?? []).map(listener => listener(payload))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, created, archived, failArchive, missing, restricted, scoped, renamed, createdAgents, ctx, rt }
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('add-agent creates one record with a first Session in the DS Bot workspace', async (t) => {
  const { call, stop, created } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  assert.equal(agent.name, 'DSH Agent')
  assert.equal(agent.sessions.length, 1)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents.map(entry => entry.id), [agent.id])
  // The Session was created in the workspace the Bots live in.
  const workspaceId = view.workspaceId
  assert.equal(created.at(-1).workspaceId, workspaceId)
})

test('agent-chat pages the newest Session of the DSH Agent and refuses an unknown one', async (t) => {
  const { call, stop, ctx } = start(TEAM)
  t.after(stop)
  const pages = []
  ctx.sessionController.page = async (query) => { pages.push(query); return { records: [], hasMore: false } }
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  const page = (await call('agent-chat', { agentId: agent.id })).value
  assert.equal(page.sessionId, second.sessionId)
  assert.deepEqual(page.items, [])
  assert.equal(page.cursor, null)
  assert.equal(pages.at(-1).address.sessionId, second.sessionId)
  await call('agent-archive', { agentId: agent.id, sessionId: agent.sessions[0] })
  await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })
  const empty = (await call('agent-chat', { agentId: agent.id })).value
  assert.equal(empty.sessionId, undefined)
  assert.deepEqual(empty.items, [])
  const missing = await call('agent-chat', { agentId: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bot/not-found')
})

test('a running DSH Agent shows in the work view, and stop-agent cancels its turn', async (t) => {
  const { call, stop, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  assert.equal((await call('stop-agent', { agentId: agent.id })).value, false)
  const cancels = []
  rt.resolveAgent = async sessionId => ({ cancel: reason => cancels.push([sessionId, reason.kind]) })
  const emit = async event => { for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: agent.sessions[0] }, event) }
  await emit({ type: 'turn/start', time: 5, data: { turn: 1 } })
  assert.equal((await call('state', {})).value.work.agents[agent.id].since, 5)
  assert.equal((await call('stop-agent', { agentId: agent.id })).value, true)
  assert.deepEqual(cancels, [[agent.sessions[0], 'user']])
  await emit({ type: 'turn/end', data: { turn: 1 } })
  assert.deepEqual(rt.agentWorkView(), {})
})

test('a team holds at most one DSH Agent', async (t) => {
  const { call, stop } = start(TEAM)
  t.after(stop)
  await call('state', {})
  assert.equal((await call('add-agent')).ok, true)
  const again = await call('add-agent')
  assert.equal(again.ok, false)
  assert.equal(again.error.message, 'The team already has a DSH Agent')
})

test('agent-session appends Sessions; agent-archive removes one and archives it', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('state', {})).value.agents[0].sessions.length, 2)
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents[0].sessions, agent.sessions)
  assert.deepEqual(archived, [second.sessionId])
})

test('a failed archive keeps the Session in the Agent and answers with the error', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })
  assert.equal(failed.ok, false)
  // The Session stays with the Agent, so the restriction and the retry stay.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
})

test('agent-archive clears a Session another plugin deleted outright', async (t) => {
  const { call, stop, archived, missing } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  // The Session body is gone: only its id is left in the Agent's list.
  missing.set(second.sessionId, second.sessionId)
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, agent.sessions)
  assert.deepEqual(archived, [], 'nothing was archived: the Session was already gone')
  // A miss that names another Session is not this Session's definite miss.
  const third = (await call('agent-session', { agentId: agent.id })).value
  missing.set(third.sessionId, 'someone-else')
  const failed = await call('agent-archive', { agentId: agent.id, sessionId: third.sessionId })
  assert.equal(failed.ok, false)
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [...agent.sessions, third.sessionId])
})

test('remove-agent drops a Session deleted outright and removes the Agent', async (t) => {
  const { call, stop, archived, missing } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  missing.set(second.sessionId, second.sessionId)
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.deepEqual(archived, [agent.sessions[0]])
})

test('a permanent-delete notification drops the reference, once, and it stays gone', async (t) => {
  const { call, stop, home, ctx } = start(TEAM)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  await ctx.emitAsync('session-manager/session-deleted', { sessionId: second.sessionId })
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, agent.sessions)
  // The same notification again, and one naming no Agent Session, change nothing.
  await ctx.emitAsync('session-manager/session-deleted', { sessionId: second.sessionId })
  await ctx.emitAsync('session-manager/session-deleted', { sessionId: 'not-in-any-agent' })
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, agent.sessions)
  // The reference must not come back on a restart.
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  await stop()
  const again = start(JSON.parse(saved))
  t.after(again.stop)
  assert.deepEqual((await again.call('state', {})).value.agents[0].sessions, agent.sessions)
})

test('a failed save keeps the reference and its Agent index for a retry', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { call, stop, home, ctx, rt } = start(TEAM)
  t.after(async () => { chmodSync(home, 0o700); await stop() })
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal(rt.agentOf(second.sessionId)?.id, agent.id)
  // A write that cannot land, as when the disk is full or the team moved to another
  // host. The save rebuilds the Agent index before it writes, so the failure leaves
  // the Session unindexed unless the listener rebuilds it with the reference.
  chmodSync(home, 0o500)
  try {
    await assert.rejects(
      ctx.emitAsync('session-manager/session-deleted', { sessionId: second.sessionId }),
      /EACCES|EPERM|permission denied/i,
    )
  } finally {
    chmodSync(home, 0o700)
  }
  // The reference is back in the list, and windows still see it as the Agent's own.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.equal(rt.agentOf(second.sessionId)?.id, agent.id)
  // Once a write can land, the same notice clears the reference and its index entry.
  await ctx.emitAsync('session-manager/session-deleted', { sessionId: second.sessionId })
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0]])
  assert.equal(rt.agentOf(second.sessionId), undefined)
})

test('a read-only host ignores unrelated delete notices and refuses owned ones', async (t) => {
  // Another dsh host holds state.lock before this host even starts or loads state.json.
  const { call, stop, ctx, rt } = start(
    { ...TEAM, agents: { a1: { id: 'a1', name: 'DSH Agent', sessions: ['s1'], createdAt: 1 } } },
    { lock: { pid: process.ppid, host: hostname(), token: 'other' } },
  )
  t.after(stop)
  // Deleting an unrelated non-Agent Session must not throw a read-only error.
  await ctx.emitAsync('session-manager/session-deleted', { sessionId: 'not-in-any-agent' })
  assert.equal(typeof rt.readOnly(), 'string')
  // Deleting an owned Agent Session still refuses to write and leaves the reference intact.
  await assert.rejects(
    ctx.emitAsync('session-manager/session-deleted', { sessionId: 's1' }),
    /another dsh|read-only/i,
  )
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, ['s1'])
  assert.equal(rt.agentOf('s1')?.id, 'a1')
})

test('agent-rename retitles an owned Session and refuses others', async (t) => {
  const { call, stop, renamed } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '  Scratch  ' })).ok, true)
  assert.deepEqual(renamed.at(-1), { id: agent.sessions[0], title: 'Scratch' })
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '   ' })).ok, false)
  // A Bot's Session cannot be renamed through the agent endpoint.
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: 'm1', title: 'x' })).ok, false)
})

test('remove-agent keeps the Agent with the Sessions it could not archive', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('remove-agent', { agentId: agent.id })
  assert.equal(failed.ok, false)
  // Nothing archived, so the Agent stays whole; the retry then removes it.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.equal((await call('state', {})).value.agents.length, 0)
})

test('remove-agent archives every Session and drops the record', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.deepEqual([...archived].sort(), [agent.sessions[0], second.sessionId].sort())
})

test('agents survive a state reload', async (t) => {
  const { call, stop, home } = start(TEAM)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // Restart on the saved file: the agent record is adopted, not lost.
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  await stop()
  const again = start(JSON.parse(saved))
  t.after(again.stop)
  const view = (await again.call('state', {})).value
  assert.deepEqual(view.agents.map(entry => entry.id), [agent.id])
})

test('a fork without a parent is adopted through the Bot API and survives a restart', async (t) => {
  const env = start(TEAM)
  let fix
  let again
  t.after(async () => { await fix?.dispose(); await again?.stop() })
  await env.call('state', {})
  const agent = (await env.call('add-agent')).value
  let view = (await env.call('state', {})).value
  const sessions = {
    list: { getSnapshot: () => ({ byId: { fork: { id: 'fork', blank: false } } }) },
    fork: async (options) => { options.onCreated?.('fork'); return 'fork' },
  }
  fix = installAgentForks({
    sessions, pending: new Map(),
    ownerOf: id => view.agents.find(entry => entry.sessions.includes(id))?.id,
    hasAgent: id => view.agents.some(entry => entry.id === id),
    ready: async () => {},
    adopt: async (agentId, sessionId) => {
      const response = await env.call('agent-adopt', { agentId, sessionId })
      assert.equal(response.ok, true)
    },
    refresh: async () => { view = (await env.call('state', {})).value },
    report: error => { throw error },
  })
  assert.equal(await sessions.fork({ sessionId: agent.sessions[0] }), 'fork')
  assert.ok(view.agents[0].sessions.includes('fork'))
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.ok(saved.agents[agent.id].sessions.includes('fork'))
  await fix.dispose()
  await env.stop()
  again = start(saved)
  const restarted = (await again.call('state', {})).value
  assert.ok(restarted.agents[0].sessions.includes('fork'))
})

test('a corrupt agents field resets instead of crashing the view', async (t) => {
  const { call, stop } = start({ ...TEAM, agents: 'junk' })
  t.after(stop)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents, [])
})

test('TEAM_TOOLS names exactly the tools ds-bot defines for Bot sessions', async (t) => {
  // read_browser exists only in the Desktop profile; the flag stands in for it.
  const { stop } = start(TEAM, { config: { browser: true } })
  t.after(stop)
  assert.deepEqual(rt.teamTools.map(d => d.name).sort(), [...TEAM_TOOLS].filter(name => name !== 'read_document').sort())
})

test('agent-session honors a known workspace and falls back to the team workspace', async (t) => {
  const { call, stop, created, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // An unknown workspace id falls back; a real one is used as given.
  await call('agent-session', { agentId: agent.id, workspaceId: 'nope' })
  assert.equal(created.at(-1).workspaceId, (await call('state', {})).value.workspaceId)
  const other = await ctx.workspaceRegistry.create('/tmp/elsewhere')
  await call('agent-session', { agentId: agent.id, workspaceId: other.id })
  assert.equal(created.at(-1).workspaceId, other.id)
})

test('agent-adopt takes an unowned Session and refuses team-owned ones', async (t) => {
  const { call, stop, restricted, scoped } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // A plain root Session (the workspace picker's blank, or a fork) joins the Agent.
  const adopted = (await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).value
  assert.equal(adopted.sessionId, 'fresh')
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [...agent.sessions, 'fresh'])
  // The team tools live on Bot scopes only, so the adopted Session needs no mask.
  assert.equal(restricted.length, 0)
  assert.equal(scoped.some(entry => entry.sessionId === 'fresh'), false)
  // Adopting again is a no-op.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).ok, true)
  // A Bot's Session and an unknown Agent are refused.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'm1' })).ok, false)
  assert.equal((await call('agent-adopt', { agentId: 'none', sessionId: 'fresh2' })).error.message, 'Unknown DSH Agent')
})

test('a Bot Session gets the team tools in its own scope; a DSH Agent Session gets none', async (t) => {
  const { call, stop, restricted, scoped, createdAgents } = start(TEAM)
  t.after(stop)
  await call('state', {})
  // A Bot resolving its agent gets every team tool scoped to it and no mask.
  createdAgents({
    agent: {
      session: { id: 'm1' },
      ctx: {
        tools: {
          register: tool => { scoped.push({ sessionId: 'm1', name: tool.name }) },
          restrict: filter => { restricted.push({ sessionId: 'm1', filter }) },
        },
        effect: execute => execute(),
      },
    },
  })
  await flush()
  assert.deepEqual(scoped.filter(entry => entry.sessionId === 'm1').map(entry => entry.name).sort(),
    [...TEAM_TOOLS].filter(name => name !== 'read_browser' && name !== 'read_document').sort())
  assert.equal(restricted.length, 0)
  // An Agent Session is a plain dsh conversation: nothing is scoped onto it and
  // nothing is masked, because the team tools never reach the global layer.
  const agent = (await call('add-agent')).value
  createdAgents({
    agent: {
      session: { id: agent.sessions[0] },
      ctx: {
        tools: {
          register: tool => { scoped.push({ sessionId: agent.sessions[0], name: tool.name }) },
          restrict: filter => { restricted.push({ sessionId: agent.sessions[0], filter }) },
        },
        effect: execute => execute(),
      },
    },
  })
  await flush()
  assert.equal(restricted.length, 0)
  assert.equal(scoped.some(entry => entry.sessionId === agent.sessions[0]), false)
})
