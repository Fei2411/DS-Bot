import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// DSH 0.2.2 hands the `system-prompt/assemble` waterfall a presentation only —
// sections, contexts and variables — and adds the tool list afterwards (#814).
// A listener that reads either list off the result threw every Bot turn out of
// its first step, and the turn ended in 0 ms with
// "Cannot read properties of undefined (reading 'filter')" (#922, #926, #951, #952).
// These cases drive the real listener each shape the host has shipped.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const start = () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-assembly-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const liveAgents = new Map()
  // What a plugin registers on an Agent's own ctx, by event — DSH registers the
  // assembly filter there, not on the plugin's own context.
  const agentEvents = new Map()
  const ctx = fakeContext({ services: { agents: { list: () => [...liveAgents.values()], get: id => liveAgents.get(id) } } })
  const agentOf = (sessionId) => {
    const live = liveAgents.get(sessionId)
    if (live !== undefined) return live
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: '/team' }, requestHeader: () => undefined, deriveMessages: () => [] },
      ctx: {
        tools: {
          register: () => () => {},
          restrict: () => () => {},
        },
        effect: execute => (typeof execute === 'function' ? execute() : undefined),
        on(name, listener) {
          const byEvent = agentEvents.get(sessionId) ?? new Map()
          agentEvents.set(sessionId, byEvent)
          byEvent.set(name, [...(byEvent.get(name) ?? []), listener])
          return () => {}
        },
      },
      status: 'idle',
      followup() {},
      steer() {},
      inject() {},
      send() {},
      cancel() {},
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
      inbox: { nextStep: [], nextTurn: [], prepend() {}, append() {}, remove: () => false },
    }
    liveAgents.set(sessionId, agent)
    return agent
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: '/team' } : undefined),
      list: () => [{ id: 'w1', path: '/team' }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const agentCreated = async (sessionId) => {
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: agentOf(sessionId) })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, agentCreated, agentOf, agentEvents, stop }
}

// The listener the Bot's Agent got at creation — the very line the reports rode on.
const botAssemblyFilter = async (host, sessionId) => {
  const byEvent = host.agentEvents.get(sessionId)
  const listener = (byEvent?.get('system-prompt/assemble') ?? []).find(fn => /HIDDEN_TOOLS\.includes/.test(String(fn)))
  assert.ok(listener, "a Bot's Agent carries the assembly filter")
  return (assembly, next) => listener(assembly, { agent: host.agentOf('a'), signal: AbortSignal.timeout(60_000) }, next)
}

const SECTIONS = [
  { name: 'tool:subagent', text: 'delegation guidance' },
  { name: 'tool:show_view', text: 'the view card' },
  { name: 'persona', text: 'you' },
]

test('a DSH 0.2.2 presentation without a tool list assembles and drops the hidden sections', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const assemble = await botAssemblyFilter(host, 'a')
  // The shape dsh-system-prompt 0.2.2 hands over: sections, contexts and variables
  // only — the tool list is added by the host after the waterfall has run.
  const presentation = { sections: SECTIONS, contexts: [], variables: {} }
  const assembled = await assemble(presentation, async () => presentation)
  // A missing tool list falls back to an empty one (#922): the host replaces it
  // with the real list right after the waterfall, so nothing is lost here.
  assert.deepEqual(assembled.tools, [], 'a missing tool list falls back to an empty one')
  assert.deepEqual(assembled.sections.map(section => section.name), ['tool:show_view', 'persona'])
  assert.deepEqual(assembled.contexts, [])
  assert.deepEqual(assembled.variables, {})
})

test("an older host's assembly still loses the hidden tools and their guidance", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const assemble = await botAssemblyFilter(host, 'a')
  const assembly = {
    tools: [{ name: 'read' }, { name: 'subagent' }, { name: 'ask_user_question' }, { name: 'create_goal' }],
    sections: SECTIONS,
    contexts: [],
    variables: {},
  }
  const assembled = await assemble(assembly, async () => assembly)
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['read'])
  assert.deepEqual(assembled.sections.map(section => section.name), ['tool:show_view', 'persona'])
})

test('a presentation that carries neither list is passed through', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const assemble = await botAssemblyFilter(host, 'a')
  const presentation = { contexts: [{ name: 'runtime', text: 'here' }], variables: { cwd: '/team' } }
  const assembled = await assemble(presentation, async () => presentation)
  // Both list reads fall back rather than throw (#922), and the rest of the
  // presentation is kept as it came.
  assert.deepEqual(assembled.tools, [])
  assert.deepEqual(assembled.sections, [])
  assert.deepEqual(assembled.contexts, [{ name: 'runtime', text: 'here' }])
  assert.deepEqual(assembled.variables, { cwd: '/team' })
})

test('a plugin that listened earlier in the chain handing back nothing is survived', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const assemble = await botAssemblyFilter(host, 'a')
  // Another plugin's own assemble hook returned nothing at all (#946): the next
  // listener in the waterfall then resolves to nothing, and ds-bot reads it.
  const assembled = await assemble(undefined, async () => undefined)
  assert.deepEqual(assembled, { tools: [], sections: [] })
})
