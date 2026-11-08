import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #976: a plugin update replaces the files under a running dsh and loads the plugin
// again in place. The process keeps its turns and child agents; the plugin's maps do
// not survive the reload. These tests load a second runtime over the same dsh side
// and expect it to adopt what dsh still runs.

// A team where Writer answers in group "Ops" from Session 'gb'; its own chat is 'b'.
const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

const settle = async (check, ms = 2000) => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

// The dsh side of the process: it outlives one plugin runtime and is shared by the
// runtime that is loaded again, child agents and Sessions included.
function dshSide() {
  const agentMap = new Map()
  const interrupted = []
  const cancelled = []
  const agentOf = (sessionId, { parent, status = 'running' } = {}) => {
    if (!agentMap.has(sessionId)) {
      agentMap.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId,
          header: parent === undefined ? {} : { origin: 'subagent', parentSession: parent },
          requestHeader: () => undefined,
          deriveMessages: () => [],
        },
        status,
        calls: [],
        followup(message) { this.calls.push(['followup', message]) },
        steer(message) { this.calls.push(['steer', message]) },
        inject(message) { this.calls.push(['inject', message]) },
        cancel(cause) { cancelled.push([sessionId, cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agentMap.get(sessionId)
  }
  const services = {
    agents: { list: () => [...agentMap.values()], get: id => agentMap.get(id) },
    subagents: { interrupt: async (id, options) => { interrupted.push([id, options]) } },
  }
  const props = {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, list: () => [] },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      inspect: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  }
  return { agentMap, interrupted, cancelled, agentOf, services, props }
}

// What dsh does for an in-place plugin reload: the old plugin context is disposed and
// a new runtime is created over the same dsh services, so nothing the plugin kept in
// memory is left behind.
async function loadPlugin(dsh, home, { served } = {}) {
  const ctx = fakeContext({ services: dsh.services })
  Object.assign(ctx, dsh.props)
  if (served !== undefined) ctx.tools.schemas = () => served.map(name => ({ name }))
  return { ctx, rt: createRuntime(ctx, { home }) }
}

const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reload-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  return home
}
// The plugin stops before its data goes, so nothing it still writes lands in a folder
// that is being removed.
const cleanup = (t, home, ctx) => t.after(async () => {
  await ctx?.dispose()
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

let seq = 0
const emit = (ctx, id, type, data) => {
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
  }
}

test('a plugin loaded again adopts a running turn and its child, so the group view and Stop still see it', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  // Writer is answering in the group, and the child it started there still runs.
  dsh.agentOf('gb')
  dsh.agentOf('child1', { parent: 'gb' })

  const first = await loadPlugin(dsh, home)
  await settle(() => first.rt.hasSubagents('gb') === true)
  await first.ctx.dispose()

  // Loaded again: the new runtime starts empty and adopts what dsh still runs.
  const second = await loadPlugin(dsh, home)
  cleanup(t, home, second.ctx)
  await settle(() => second.rt.hasSubagents('gb') === true)
  assert.equal(second.rt.live.get('gb')?.turn !== undefined, true, 'the running turn is known again')
  // The group view shows the member at work there, not idle.
  const work = second.rt.roomWorkView().r1 ?? []
  assert.equal(work.some(item => item.botId === 'b'), true)
  // Stop sees the turn and the child, stops both, and the child is gone.
  assert.equal(await second.rt.stopMemberWork('r1', 'b'), true)
  assert.deepEqual(dsh.interrupted.map(([id]) => id), ['child1'])
  assert.deepEqual(dsh.cancelled.map(([id]) => id), ['child1', 'gb'])
  assert.equal(second.rt.hasSubagents('gb'), false)
})

test('a child still running after the reload shows in its group, and settling clears it', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  // The member's own turn is over, the child it started is not.
  dsh.agentOf('gb', { status: 'idle' })
  const child = dsh.agentOf('child1', { parent: 'gb' })

  const first = await loadPlugin(dsh, home)
  await settle(() => first.rt.hasSubagents('gb') === true)
  await first.ctx.dispose()

  const second = await loadPlugin(dsh, home)
  cleanup(t, home, second.ctx)
  await settle(() => second.rt.hasSubagents('gb') === true)
  const shown = (second.rt.roomWorkView().r1 ?? []).find(item => item.botId === 'b')
  assert.equal(shown?.tool, 'subagent')

  // dsh settles the child after the reload: the notice reaches the parent Session.
  child.status = 'idle'
  emit(second.ctx, 'gb', 'user/message', {
    source: { kind: 'subagent-settled', senderSessionId: 'child1' },
    content: [{ type: 'text', text: 'the child result' }],
  })
  assert.equal(second.rt.hasSubagents('gb'), false)
  assert.equal((second.rt.roomWorkView().r1 ?? []).some(item => item.botId === 'b'), false)
})

test('adoption marks a running Bot Session and leaves an idle one alone', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  dsh.agentOf('b', { status: 'running' })
  dsh.agentOf('gb', { status: 'idle' })
  const { ctx, rt } = await loadPlugin(dsh, home)
  cleanup(t, home, ctx)
  await settle(() => rt.live.get('b')?.turn !== undefined)
  assert.equal(rt.live.get('gb')?.turn, undefined)
  assert.equal(rt.hasSubagents('gb'), false)
  assert.deepEqual(rt.roomWorkView(), {})
})

test('a plugin loaded again gives a live Bot Session its tools before its next request', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  const agent = dsh.agentOf('gb', { status: 'idle' })
  const registered = []
  const denied = []
  agent.ctx = {
    tools: {
      register: def => { registered.push(def.name); return () => {} },
      restrict: ({ deny }) => { denied.push(...deny); return () => {} },
    },
    on: () => () => {},
  }
  const served = ['read', 'subagent', 'workflow', 'message_bot', 'remember', 'recall', 'request_secret']
  const first = await loadPlugin(dsh, home, { served })
  await settle(() => registered.includes('message_bot'))
  await first.ctx.dispose()
  // The reload lifts the old scope with the old runtime; loading again puts the same
  // scope back, before any request of the running turn assembles.
  registered.length = 0
  denied.length = 0
  const second = await loadPlugin(dsh, home, { served })
  cleanup(t, home, second.ctx)
  await settle(() => registered.includes('message_bot'))
  for (const name of ['remember', 'recall', 'request_secret']) assert.equal(registered.includes(name), true, name)
  // The delegation tools a Bot Session must not use stay masked.
  assert.equal(denied.includes('subagent'), true)
  assert.equal(denied.includes('workflow'), true)
})
