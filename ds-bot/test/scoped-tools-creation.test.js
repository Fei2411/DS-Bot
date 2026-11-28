import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { CATALOG_PACK_TOOLS, GROUP_ONLY_TOOLS, TASK_HIDDEN_TEAM_TOOLS, TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'
import { BUILTIN_PACKS } from '../src/host/builtin-packs.js'

// tools.js keeps the DSH names a Bot Session never serves in one place; the
// assemble must add none of them.
const HIDDEN = ['ask_user_question', 'subagent', 'list_subagent_models', 'send_message']

// A Bot-owned Session gets its Agent before ds-bot records the owner, so the
// scoped show_view and the hidden-tool restrict used to wait for a later
// resolveAgent that a held kickoff never ran. These tests drive each creation
// path with another plugin's global show_view already in place and check the
// Agent's own tool list before its first step.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

let rt
const start = (team = TEAM, services = {}, globals = [], shared = {}) => {
  const home = shared.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-scoped-'))
  if (shared.home === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  // `scoped` and `restricted` model each Session's own tool layer, and
  // `liveAgents` the DSH registry: shared across two runtimes they keep a
  // Session's Agent alive through a disable and re-enable.
  const scoped = shared.scoped ?? []
  const restricted = shared.restricted ?? []
  const liveAgents = shared.liveAgents ?? new Map()
  services.agents ??= { list: () => [...liveAgents.values()], get: id => liveAgents.get(id) }
  const ctx = fakeContext({ services })
  // Another plugin's global show_view, in place before ds-bot loads.
  ctx.tools.register({ name: 'show_view', description: 'global', execute: async () => 'global' })
  for (const tool of globals) ctx.tools.register(tool)
  // DSH refuses a second global registration of one name — the throw that killed
  // ds-bot's boot in #703 — so the fake refuses the same way.
  const plainRegister = ctx.tools.register.bind(ctx.tools)
  ctx.tools.register = (tool) => {
    if (ctx.registeredTools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
    return plainRegister(tool)
  }
  let sessions = 0
  const agentOf = (sessionId) => {
    const held = liveAgents.get(sessionId)
    if (held !== undefined) return held
    const nextStep = []
    const nextTurn = []
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: '/team' }, requestHeader: () => undefined, deriveMessages: () => [] },
      ctx: {
        tools: {
          register: (tool) => {
            const entry = { sessionId, name: tool.name, tool }
            scoped.push(entry)
            // DSH's disposer unregisters; the fake drops the record.
            return () => { const at = scoped.indexOf(entry); if (at !== -1) scoped.splice(at, 1) }
          },
          restrict: (filter) => {
            const entry = { sessionId, deny: filter.deny ?? [] }
            restricted.push(entry)
            return () => { const at = restricted.indexOf(entry); if (at !== -1) restricted.splice(at, 1) }
          },
        },
        effect: execute => (typeof execute === 'function' ? execute() : undefined),
        on: () => () => {},
      },
      status: 'idle',
      followup() {},
      steer() {},
      inject() {},
      send(message, target) {
        ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
      },
      cancel() {},
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
      inbox: {
        nextStep,
        nextTurn,
        prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
        append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message) },
        remove(id) {
          for (const list of [nextStep, nextTurn]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      },
    }
    liveAgents.set(sessionId, agent)
    return agent
  }
  // ask_user_question is served, so the deny list is not empty in a Bot scope;
  // a Session's own registrations join its list and shadow globals of one name,
  // as DSH's scope view does.
  ctx.tools.schemas = (agent) => {
    const view = new Map()
    for (const name of ['ask_user_question', 'show_view']) view.set(name, { name })
    for (const entry of scoped.filter(entry => entry.sessionId === agent?.id)) {
      view.set(entry.name, { name: entry.name, description: entry.tool.description, parameters: entry.tool.parameters })
    }
    return [...view.values()]
  }
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
  // Sessions named in shared.live get their Agent into the registry before the
  // runtime and its first load — the state a restart leaves behind (#826).
  for (const liveId of shared.live ?? []) agentOf(liveId)
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data })
    }
  }
  const agentCreated = async (sessionId) => {
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: agentOf(sessionId) })
  }
  const tool = (name, args, sessionId, exec = {}) =>
    rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1', ...exec })
  const unload = () => ctx.dispose()
  const stop = async () => {
    await unload()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, tool, emit, agentCreated, agentOf, scoped, restricted, home, unload, stop }
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const hasShowView = (host, id) => host.scoped.some(entry => entry.sessionId === id && entry.name === 'show_view')
const denied = (host, id) => host.restricted.some(entry => entry.sessionId === id && entry.deny.includes('ask_user_question'))
const scopedNames = (host, id) => host.scoped.filter(entry => entry.sessionId === id).map(entry => entry.name)

test('a Bot assembly can omit sections and tools without per-Agent hooks', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const perAgentFilterHooks = []
  const toolsCreated = host.ctx.listeners.get('agent/created').find(fn => String(fn).includes('hideBotUnusedTools(agent)'))
  for (const id of ['a', 'b']) {
    const agent = host.agentOf(id)
    agent.ctx.on = (name) => {
      if (name === 'llm/stream' || name === 'system-prompt/assemble') perAgentFilterHooks.push({ id, name })
      return () => {}
    }
    await toolsCreated({ agent })
  }
  assert.deepEqual(perAgentFilterHooks, [])
  const listener = host.ctx.listeners.get('system-prompt/assemble').find(fn => fn.name === 'scopeTeamTools')
  assert.ok(listener)
  assert.deepEqual(await listener({}, { agent: host.agentOf('a') }, async () => ({})), {})
  const sample = () => ({
    sections: [{ name: 'team:policy' }, { name: 'tool:create_bot' }, { name: 'keep' }],
    tools: [{ name: 'subagent' }, { name: 'create_bot' }, { name: 'list_bots' }],
  })
  const mainResult = await listener({}, { agent: host.agentOf('a') }, async () => sample())
  assert.deepEqual(mainResult, {
    sections: [{ name: 'tool:create_bot' }, { name: 'keep' }],
    tools: [{ name: 'create_bot' }, { name: 'list_bots' }],
  })
  const botResult = await listener({}, { agent: host.agentOf('b') }, async () => sample())
  assert.deepEqual(botResult, {
    sections: [{ name: 'keep' }],
    tools: [{ name: 'list_bots' }],
  })
  const plainInput = sample()
  assert.equal(await listener({}, { agent: host.agentOf('plain') }, async () => plainInput), plainInput)
  const noAgentInput = sample()
  assert.equal(await listener({}, {}, async () => noAgentInput), noAgentInput)
})

test('team-admin filtering preserves other tools and sessions, including empty and sessionless requests', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const names = BUILTIN_PACKS['team-admin'].tools
  assert.deepEqual(names, ['create_bot', 'stop_bot', 'create_group', 'delete_group'])
  const filter = host.ctx.listeners.get('llm/stream').find(fn => fn.name === 'filterBuiltinTools')
  assert.ok(filter)
  host.ctx.llm.stream = options => filter(options, () => options)
  for (const id of ['a', 'b', 'plain']) await host.agentCreated(id)
  const available = ['update_bot', 'update_group', 'list_bot_models', 'list_bots', 'save_capability', 'schedule_create', 'group_goal']
  const allTools = [...names, ...available].map(name => ({ name }))
  for (const sessionId of ['a', 'b', 'plain', undefined]) {
    const options = sessionId === undefined ? { tools: allTools } : { sessionId, tools: allTools }
    const result = filter(options, () => options)
    assert.deepEqual(result.tools.map(tool => tool.name), sessionId === 'b' ? available : allTools.map(tool => tool.name))
  }
  for (const empty of [{}, { tools: [] }, { sessionId: 'b', tools: [] }]) assert.equal(filter(empty, () => empty), empty)
})

function attachHostBuiltinFilters(root, host) {
  root.on('session/event', host.ctx.listeners.get('session/event').find(listener => listener.name === 'freezeBuiltinPacks'))
  root.on('llm/stream', host.ctx.listeners.get('llm/stream').find(listener => listener.name === 'filterBuiltinTools'))
  root.on('system-prompt/assemble', host.ctx.listeners.get('system-prompt/assemble').find(listener => listener.name === 'scopeTeamTools'))
  host.ctx.llm.stream = options => root.llm.stream(options)
}

for (const main of [false, true]) {
  for (const group of [false, true]) {
    test(`real DSH ${group ? 'group' : 'own-chat'} turn freezes team-admin during ${main ? 'demotion' : 'promotion'}`, async (t) => {
      const team = structuredClone(TEAM)
      team.rooms.r1.sessions = { a: 'ga', b: 'gb' }
      const host = start(team)
      t.after(host.stop)
      await host.call('state', {})
      const botId = main ? 'a' : 'b'
      const id = group ? `g${botId}` : botId
      const root = new Context()
      t.after(() => root.fiber.dispose())
      await mountAgentLoopTestDependencies(root)
      const seen = []
      class Adapter extends LlmAdapter {
        async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
        async *stream(options) {
          seen.push(options.tools.map(tool => tool.name))
          if (seen.length === 1) {
            yield { type: 'tool-call-delta', index: 0, id: 'flip', name: 'flip_role', argumentsDelta: '{}' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'flip', name: 'flip_role', arguments: '{}' } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          } else yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      root.llm.registerAdapter(['role-test'], new Adapter())
      await mountAgentLoopTestHarness(root)
      attachHostBuiltinFilters(root, host)
      const agent = await root.agentLoop.create(SessionId(id), { provider: 'role-test', model: 'test' })
      await host.ctx.listeners.get('agent/created').find(listener => String(listener).includes('hideBotUnusedTools(agent)'))({ agent })
      const message = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
      agent.ctx.tools.register({ name: 'flip_role', description: 'Change role', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: () => [] },
        execute() {
          rt.state.mainBotIds = main ? ['b'] : ['a', 'b']
          agent.followup(message('queued next turn'))
          return 'changed'
        },
      })
      agent.followup(message('first turn'))
      await agent.whenIdle()
      assert.equal(seen.length, 3)
      for (const [index, tools] of seen.entries()) {
        for (const name of BUILTIN_PACKS['team-admin'].tools) assert.equal(tools.includes(name), index < 2 ? main : !main, `${name} at request ${index}`)
        for (const name of ['update_bot', 'update_group', 'list_bot_models']) assert.ok(tools.includes(name), `${name} stays available at request ${index}`)
        assert.ok(tools.includes('list_bots'))
        assert.ok(tools.includes('save_capability'))
      }
    })
  }
}

test("an upgraded team's Main Bot keeps team-admin while an ordinary Bot's Agent is live", async (t) => {
  const team = structuredClone(TEAM)
  for (const bot of Object.values(team.bots)) {
    delete bot.sessionId
    delete bot.segments
    Object.assign(bot, { capabilities: [], packs: [] })
  }
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  const offered = new Map()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(options) {
      offered.set(String(options.sessionId), options.tools.map(tool => tool.name).filter(name => BUILTIN_PACKS['team-admin'].tools.includes(name)))
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['role-test'], new Adapter())
  await mountAgentLoopTestHarness(root)
  attachHostBuiltinFilters(root, host)
  const created = host.ctx.listeners.get('agent/created').find(listener => String(listener).includes('hideBotUnusedTools(agent)'))
  const agents = {}
  for (const id of ['a', 'b']) {
    agents[id] = await root.agentLoop.create(SessionId(id), { provider: 'role-test', model: 'test' })
    await created({ agent: agents[id] })
  }
  for (const id of ['a', 'b']) {
    agents[id].followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }))
    await agents[id].whenIdle()
  }
  assert.deepEqual(offered.get('a').toSorted(), [...BUILTIN_PACKS['team-admin'].tools].sort())
  assert.deepEqual(offered.get('b'), [])
})

test('Main Bot keeps team-admin across switched parts and background tasks while ordinary Bots are live', async (t) => {
  const team = structuredClone(TEAM)
  team.bots.a.sessionId = 'a-cur'
  team.bots.a.segments = [{ sessionId: 'a', endedAt: 1 }]
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  rt.state.bots.a.tasks = [{ id: 't1', title: 'Work', status: 'running', sessionId: 'a-task', segments: [], startedAt: 2, updatedAt: 2 }]
  await rt.save()
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  const offered = new Map()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(options) {
      const key = options.sessionId === undefined ? 'sessionless' : String(options.sessionId)
      offered.set(key, (options.tools ?? []).map(tool => tool.name).filter(name => BUILTIN_PACKS['team-admin'].tools.includes(name)))
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['role-test'], new Adapter())
  await mountAgentLoopTestHarness(root)
  attachHostBuiltinFilters(root, host)
  const created = host.ctx.listeners.get('agent/created').find(listener => String(listener).includes('hideBotUnusedTools(agent)'))
  const addedFilterHooks = []
  root.on('internal/listener', (name) => {
    if (name === 'llm/stream' || name === 'system-prompt/assemble') addedFilterHooks.push(name)
  })
  const agents = {}
  for (const id of ['a-cur', 'a-task', 'b']) {
    agents[id] = await root.agentLoop.create(SessionId(id), { provider: 'role-test', model: 'test' })
    await created({ agent: agents[id] })
  }
  assert.deepEqual(addedFilterHooks, [], 'creating Bot Agents adds no per-Agent llm/stream or system-prompt/assemble hooks')
  for (const id of ['a-cur', 'a-task', 'b']) {
    agents[id].followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }))
    await agents[id].whenIdle()
  }
  for await (const chunk of root.llm.stream({
    provider: 'role-test',
    model: 'test',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'aux' }] })],
    tools: BUILTIN_PACKS['team-admin'].tools.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
  })) void chunk
  const expected = [...BUILTIN_PACKS['team-admin'].tools].sort()
  assert.deepEqual(offered.get('a-cur').toSorted(), expected)
  assert.deepEqual(offered.get('a-task').toSorted(), expected)
  assert.deepEqual(offered.get('b'), [])
  assert.deepEqual(offered.get('sessionless').toSorted(), expected)
})

test('team tools retry without a step, without registering successful tools twice', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const agent = host.agentOf('a')
  const register = agent.ctx.tools.register
  agent.ctx.tools.register = undefined
  await host.agentCreated('a')
  let refused = false
  agent.ctx.tools.register = tool => {
    if (tool.name === 'list_bots' && !refused) { refused = true; throw new Error('not ready') }
    return register(tool)
  }
  await until(() => scopedNames(host, 'a').includes('list_bots'), 5000)
  const mainExpected = TEAM_TOOLS.filter(name => !['read_browser', 'read_document', 'group_relay', ...CATALOG_PACK_TOOLS].includes(name))
  for (const name of mainExpected) assert.equal(scopedNames(host, 'a').filter(n => n === name).length, 1)
})

test('team tool retries stop at a bound and are cleaned up with their scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = host.agentOf('a')
  let attempts = 0
  agent.ctx.tools.register = () => { attempts++; throw new Error('unavailable') }
  const agentDisposers = []
  agent.ctx.effect = execute => { agentDisposers.push(execute()) }
  await host.agentCreated('a')
  const initial = attempts
  for (let i = 0; i < 10; i++) t.mock.timers.tick(1000)
  assert.ok(attempts > initial)
  const exhausted = attempts
  assert.equal(exhausted, initial * 6)
  t.mock.timers.tick(60_000)
  assert.equal(attempts, exhausted)
  for (const dispose of agentDisposers) dispose?.()
  const other = host.agentOf('b')
  const otherDisposers = []
  other.ctx.effect = execute => { otherDisposers.push(execute()) }
  other.ctx.tools.register = () => { attempts++; throw new Error('unavailable') }
  await host.agentCreated('b')
  for (const dispose of otherDisposers) dispose?.()
  const disposed = attempts
  t.mock.timers.tick(1000)
  assert.equal(attempts, disposed)
  const room = host.agentOf('r1')
  room.ctx.tools.register = () => { attempts++; throw new Error('unavailable') }
  await host.agentCreated('r1')
  await host.unload()
  const unloaded = attempts
  t.mock.timers.tick(60_000)
  assert.equal(attempts, unloaded)
})

test('a Bot Session gets its eligible team tools in its own scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const expected = [...TEAM_TOOLS].filter(name => !['read_browser', 'read_document', 'group_relay', ...CATALOG_PACK_TOOLS].includes(name)).sort()
  assert.deepEqual(scopedNames(host, 'a').sort(), expected)
})

test('a Bot with no connector off never reads the served schemas for the mask', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  rt.connectorOffFor = () => []
  const before = host.restricted.length
  let reads = 0
  const served = host.ctx.tools.schemas
  host.ctx.tools.schemas = (agent) => { reads += 1; return served(agent) }
  rt.reapplyToolMasks()
  assert.equal(reads, 0)
  assert.equal(host.restricted.length, before)
})

test('an off connector masks all its tools in one scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  host.ctx.tools.schemas = () => [{ name: 'ask_user_question' }, { name: 'mcp__notion__search' }, { name: 'mcp__notion__fetch' }]
  rt.connectorOffFor = () => ['mcp__notion__']
  rt.reapplyToolMasks()
  const masks = host.restricted.filter(entry => entry.sessionId === 'a' && entry.deny.some(name => name.startsWith('mcp__notion__')))
  assert.equal(masks.length, 1)
  assert.deepEqual(masks[0].deny, ['mcp__notion__search', 'mcp__notion__fetch'])
})

test('two prefixes matching the same tool deny it once', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  host.ctx.tools.schemas = () => [{ name: 'mcp__notion__search' }, { name: 'mcp__notion__fetch' }, { name: 'mcp__other__read' }]
  rt.connectorOffFor = () => ['mcp__notion__', 'mcp__notion__search']
  rt.reapplyToolMasks()
  const masks = host.restricted.filter(entry => entry.sessionId === 'a' && entry.deny.some(name => name.startsWith('mcp__notion__')))
  assert.equal(masks.length, 1, 'one restrict for the overlapping prefixes')
  assert.deepEqual(masks[0].deny, ['mcp__notion__search', 'mcp__notion__fetch'])
})

test('a Bot moved onto a local agent route gets the approval bridge, and loses it moving off', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('b')
  assert.equal(scopedNames(host, 'b').includes('approve_agent_action'), false)
  rt.isLocalAgentRef = ref => typeof ref === 'string' && ref.startsWith('local-acp-')
  const bot = rt.botOf('b')
  bot.model = 'local-acp-fake/default'
  rt.hideBotUnusedTools(host.agentOf('b'))
  assert.equal(scopedNames(host, 'b').includes('approve_agent_action'), true)
  assert.equal(scopedNames(host, 'b').filter(name => name === 'delegate_work').length, 1)
  bot.model = 'deepseek-official/deepseek-flash'
  rt.hideBotUnusedTools(host.agentOf('b'))
  assert.equal(scopedNames(host, 'b').includes('approve_agent_action'), false)
  assert.equal(scopedNames(host, 'b').includes('delegate_work'), true)
})

test('a Session ds-bot does not own sees none of the team tools', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.deepEqual(scopedNames(host, 'plain1'), [])
  // Nothing of the team's reaches the global layer a plain session reads; the
  // only team-named global is another plugin's show_view.
  const leaked = [...host.ctx.registeredTools.keys()].filter(name => TEAM_TOOLS.includes(name))
  assert.deepEqual(leaked, ['show_view'])
  assert.equal(host.ctx.registeredTools.get('show_view').description, 'global')
})

test("a group's own Session is scoped to group_relay alone", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('r1')
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
})

test("a Bot Session receives bot_recall alongside another plugin's global recall", async (t) => {
  // #703: a same-named global tool from another plugin must not fail apply(),
  // and inside a Bot Session ds-bot's bot_recall is served separately.
  const host = start(TEAM, {}, [{ name: 'recall', description: 'foreign recall', execute: async () => 'foreign' }])
  t.after(host.stop)
  assert.equal(host.ctx.registeredTools.get('recall').description, 'foreign recall')
  await host.call('state', {})
  await host.agentCreated('a')
  const recall = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'bot_recall')
  assert.match(String(recall?.tool?.description), /^Search your memory/)
})

test('a Bot made without a model has the scoped tools before its first step', async (t) => {
  const host = start({ ...TEAM, rooms: {} })
  t.after(host.stop)
  const created = await host.call('create-bot', { name: 'Solo' })
  assert.equal(created.ok, true)
  const id = created.value.id
  assert.ok(hasShowView(host, id), 'the Bot scope has ds-bot\'s show_view over the global one')
  assert.ok(denied(host, id), 'the blocking question tool is denied')
})

test('a group Session made for a member has the scoped tools before its first step', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const stop = new AbortController()
  t.after(() => stop.abort())
  // The user's post starts a round; Writer has no group Session yet, so the round
  // makes one — which used to keep whatever tools a global registration left.
  host.emit('r1', 'user/message', { content: [{ type: 'text', text: 'launch moved' }], source: { kind: 'user' } })
  void host.tool('group_relay', {}, 'r1', { callId: 'r1', signal: stop.signal }).catch(() => {})
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the group scope')
})

test('a fresh part Session has the scoped tools before its first step', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'ds-bot-scoped-proj-'))
  const host = start({ ...TEAM, rooms: {} }, {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async () => 'allowed-once' },
  })
  t.after(async () => {
    await host.stop()
    rmSync(project, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.call('state', {})
  host.agentOf('b').status = 'running'
  const moved = await host.tool('update_bot', { work_dir: project }, 'b')
  assert.equal(String(moved).includes('From your next step on'), true)
  // The next step sees the folder change and switches to a fresh part.
  const preStep = host.ctx.listeners.get('agent/pre-step').at(-1)
  const answer = await preStep(
    { agent: host.agentOf('b'), messages: [{ role: 'user', content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }], step: 2, signal: AbortSignal.timeout(60_000) },
    async () => 'next',
  )
  assert.deepEqual(answer, { kind: 'reject' })
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the fresh part')
})

test('a Session ds-bot does not own keeps only the global show_view', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.ok(!hasShowView(host, 'plain1'), 'no scoped show_view shadows the global one')
  assert.ok(!host.restricted.some(entry => entry.sessionId === 'plain1'), 'no restrict applies outside the team')
})

test("a deleted Bot's Session keeps none of the scope when it is adopted as a plain one", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
  assert.ok(denied(host, 'b'))
  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'b'), false)
  // The Session lives on unowned: adopting it into the DSH Agent must not bring
  // the team tools back.
  const agent = (await host.call('add-agent', {})).value
  assert.equal((await host.call('agent-adopt', { agentId: agent.id, sessionId: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'b'), false)
})

test('a member who leaves the group loses the scoped tools', async (t) => {
  const team = {
    ...TEAM,
    bots: { ...TEAM.bots, c: { id: 'c', name: 'Scout', role: 'Scout', sessionId: 'c', createdAt: 3 } },
    rooms: { r1: { ...TEAM.rooms.r1, members: ['a', 'b', 'c'], sessions: { b: 'sb' } } },
  }
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('sb')
  assert.ok(hasShowView(host, 'sb'))
  assert.ok(denied(host, 'sb'))
  assert.equal((await host.call('update-room', { id: 'r1', remove: ['b'] })).ok, true)
  assert.deepEqual(scopedNames(host, 'sb'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'sb'), false)
  // Resolving the archived Session again does not bring the tools back.
  await host.agentCreated('sb')
  assert.deepEqual(scopedNames(host, 'sb'), [])
})

test('a deleted group loses its relay scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('r1')
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
  assert.equal((await host.call('delete-room', { id: 'r1' })).ok, true)
  assert.deepEqual(scopedNames(host, 'r1'), [])
})

test('a Session that becomes a Bot\'s again gets the scope back', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  // A Bot record naming the Session again — here written directly, the way an
  // adopted state could carry it — serves the tools again.
  rt.state.bots.b = { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 }
  await rt.save()
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
})

// public#1508: a connector MCP tool whose property is a union with no type of its own
// made Moonshot/KIMI refuse every turn, while other providers accepted it. The step's
// assemble hands connector schemas on plain; other tools keep the schema they had.
test('a connector tool schema reaches the model without unions, and other tools are left alone', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const listener = host.ctx.listeners.get('llm/stream')
    .find(listener => /plainConnectorSchemas/.test(String(listener)))
  assert.ok(listener, 'the connector schema listener is registered')
  const parameters = {
    type: 'object',
    properties: {
      sort_order: { oneOf: [{ type: 'string' }, { type: 'null' }], enum: ['ASC', 'DESC', null], description: 'Sort Order', title: 'Sort Order' },
    },
  }
  const read = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  const assembly = {
    tools: [
      { name: 'mcp__drupal__entity_list', description: 'List entities', parameters },
      { name: 'read', description: 'Read a file', parameters: read },
    ],
    sections: [],
  }
  host.ctx.llm.stream = options => listener(options, () => options)
  const assembled = listener(assembly, () => assembly)
  const connector = assembled.tools.find(tool => tool.name === 'mcp__drupal__entity_list')
  assert.deepEqual(connector.parameters.properties.sort_order, {
    type: 'string',
    enum: ['ASC', 'DESC'],
    description: 'Sort Order',
    title: 'Sort Order',
  })
  assert.equal(connector.parameters.type, 'object')
  // Another tool's schema is the same object: it was already plain.
  assert.equal(assembled.tools.find(tool => tool.name === 'read').parameters, read)
  // The same schema next step is served from the cache, unchanged.
  const again = listener(assembly, () => assembly)
  assert.equal(again.tools[0].parameters, connector.parameters)
})

// #826: after a DSH restart the creation path can miss a live Agent and nothing
// scoped it again, so the Session ran its requests without the team tools. The
// step's assemble scopes an owned Session the creation path missed and adds the
// names the request list was already built without.
const assemble = (host, agent, assembly = { tools: [], sections: [] }) => {
  const listener = host.ctx.listeners.get('system-prompt/assemble')
    .find(listener => /scopeTeamTools/.test(String(listener)))
  return listener(assembly, { agent, signal: AbortSignal.timeout(60_000) }, async () => assembly)
}

test("a group Session the creation path missed is scoped at the step's assemble", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  // The Agent is live but agent/created never ran for it and no save re-synced
  // the scopes — the state a restart left the reporter's group in.
  const agent = host.agentOf('r1')
  const assembled = await assemble(host, agent, { tools: [{ name: 'read' }], sections: [] })
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['read', 'group_relay'])
})

test("a Bot's own Session the creation path missed gets the whole scope at the assemble", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const agent = host.agentOf('a')
  const assembled = await assemble(host, agent, { tools: [{ name: 'read' }], sections: [] })
  const expected = [...TEAM_TOOLS].filter(name => !['read_browser', 'read_document', 'group_relay', ...CATALOG_PACK_TOOLS].includes(name)).sort()
  assert.deepEqual(scopedNames(host, 'a').sort(), expected)
  assert.deepEqual(assembled.tools.map(tool => tool.name).sort(), ['read', ...expected].sort())
  // The hidden DSH tools are masked and filtered as on the creation path: none
  // of their names joined the list the assemble added.
  assert.ok(denied(host, 'a'), 'the blocking question tool is denied')
  assert.ok(!HIDDEN.some(name => assembled.tools.some(tool => tool.name === name)))
})

test('the assemble registers nothing twice in an already scoped Session', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const before = host.scoped.length
  const assembly = { tools: [{ name: 'read' }], sections: [] }
  assert.equal(await assemble(host, host.agentOf('a'), assembly), assembly)
  assert.equal(host.scoped.length, before)
})

test('the assemble passes an unowned Session through unchanged', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const assembly = { tools: [{ name: 'read' }], sections: [] }
  assert.equal(await assemble(host, host.agentOf('plain1'), assembly), assembly)
  assert.deepEqual(scopedNames(host, 'plain1'), [])
})

test('a Session the load itself scoped still gets its tools into the step\'s list', async (t) => {
  // The restart case of #826: the Agent was already live when the runtime's
  // first load scoped it — the names were never on a collected tool list, so
  // the assemble must still add them to this step's.
  const host = start(TEAM, {}, [], { live: ['r1'] })
  t.after(host.stop)
  const assembled = await assemble(host, host.agentOf('r1'), { tools: [{ name: 'read' }], sections: [] })
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['read', 'group_relay'])
})

test('a hybrid group Session keeps run_code and receives its native relay schema', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const assembled = await assemble(host, host.agentOf('r1'), { tools: [{ name: 'read' }, { name: 'run_code' }], sections: [] })
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['read', 'run_code', 'group_relay'])
})

test('a PTC group Session gets its relay scoped but keeps run_code alone in the list', async (t) => {
  // A group made under the PTC preset relays through run_code; adding the scoped
  // group_relay to the list would make the hook pick the call it cannot declare.
  const host = start()
  t.after(host.stop)
  const agent = host.agentOf('r1')
  const assembly = { tools: [{ name: 'run_code' }], sections: [] }
  assert.equal(await assemble(host, agent, assembly), assembly)
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
})

test('a same-named global in the list is replaced by the scoped schema', async (t) => {
  // Another plugin's global show_view was collected for the request; the scoped
  // one that shadows it at execution replaces its schema in the list.
  const host = start()
  t.after(host.stop)
  const agent = host.agentOf('a')
  const assembled = await assemble(host, agent, { tools: [{ name: 'show_view', description: 'global' }], sections: [] })
  const named = assembled.tools.filter(tool => tool.name === 'show_view')
  assert.equal(named.length, 1)
  assert.notEqual(named[0].description, 'global')
})

test('the assemble adds the recovered names once, not on every step', async (t) => {
  const host = start()
  t.after(host.stop)
  const agent = host.agentOf('r1')
  const first = await assemble(host, agent, { tools: [{ name: 'read' }], sections: [] })
  assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'group_relay'])
  const second = { tools: [{ name: 'read' }], sections: [] }
  assert.equal(await assemble(host, agent, second), second)
})

test('enabling OCR after a Bot is scoped, then disabling it, removes the scoped schema', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  assert.equal(scopedNames(host, 'a').includes('read_document'), false)
  const on = await host.call('deepseek-services-config', { ocr: true })
  assert.equal(on.ok, true)
  assert.equal(on.value.ocr.enabled, true)
  assert.equal(scopedNames(host, 'a').includes('read_document'), true)
  const off = await host.call('deepseek-services-config', { ocr: false })
  assert.equal(off.ok, true)
  assert.equal(off.value.ocr.enabled, false)
  assert.equal(scopedNames(host, 'a').includes('read_document'), false)
})

test('removeTeamTool still unloads other live Bots when one disposer throws', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  await host.agentCreated('b')
  const agentA = host.agentOf('a')
  const origRegister = agentA.ctx.tools.register
  agentA.ctx.tools.register = (tool) => {
    const dispose = origRegister(tool)
    if (tool.name !== 'read_document') return dispose
    return () => { dispose(); throw new Error('already disposed') }
  }
  await host.call('deepseek-services-config', { ocr: true })
  assert.equal(scopedNames(host, 'a').includes('read_document'), true)
  assert.equal(scopedNames(host, 'b').includes('read_document'), true)
  const off = await host.call('deepseek-services-config', { ocr: false })
  assert.equal(off.ok, true)
  assert.equal(scopedNames(host, 'a').includes('read_document'), false)
  assert.equal(scopedNames(host, 'b').includes('read_document'), false)
})

test('a live Bot Session gets its team tools back after a disable and re-enable', async (t) => {
  // A hot reload lifts the scope of Agents that are still live, and
  // agent/created does not fire again: the sync at the next load must scope
  // them before their next request.
  const shared = { scoped: [], restricted: [], liveAgents: new Map() }
  const first = start(TEAM, {}, [], shared)
  shared.home = first.home
  t.after(first.unload)
  await first.call('state', {})
  await first.agentCreated('a')
  assert.ok(hasShowView(first, 'a'))
  assert.ok(denied(first, 'a'))
  await first.unload()
  assert.deepEqual(scopedNames(first, 'a'), [])
  assert.equal(denied(first, 'a'), false)
  const second = start(TEAM, {}, [], shared)
  t.after(second.stop)
  await second.call('state', {})
  assert.ok(hasShowView(second, 'a'), 'the scoped team tools are back')
  assert.ok(denied(second, 'a'), 'the blocking question tool is denied again')
})


test('the real DSH loop normalizes connector parameters after tool assembly', async (t) => {
  const host = start()
  t.after(host.stop)
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  let seen
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(options) { seen = options; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  root.llm.registerAdapter(['schema-test'], new Adapter())
  root.on('llm/stream', host.ctx.listeners.get('llm/stream').find(listener => /plainConnectorSchemas/.test(String(listener))))
  host.ctx.llm.stream = options => root.llm.stream(options)
  root.tools.register({ name: 'mcp__drupal__entity_list', description: 'List entities',
    parameters: { type: 'object', properties: { sort_order: { oneOf: [{ type: 'string' }, { type: 'null' }], enum: ['ASC', 'DESC', null] } } },
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '',
  })
  await mountAgentLoopTestHarness(root)
  const agent = await root.agentLoop.create(SessionId('schema-session'), { provider: 'schema-test', model: 'test' })
  const idle = new Promise(resolve => {
    const off = root.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { off(); resolve() } })
  })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }))
  await idle
  assert.deepEqual(seen.tools.find(tool => tool.name === 'mcp__drupal__entity_list').parameters.properties.sort_order, { type: 'string', enum: ['ASC', 'DESC'] })
})

test('reapplying a connector mask keeps tools that the current scope already hides', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const name = 'mcp__notion__search'
  host.ctx.tools.schemas = agent => host.restricted.some(entry => entry.sessionId === agent.id && entry.deny.includes(name)) ? [] : [{ name }]
  rt.connectorOffFor = () => ['mcp__notion__']
  rt.reapplyToolMasks()
  rt.reapplyToolMasks()
  assert.ok(host.restricted.some(entry => entry.sessionId === 'a' && entry.deny.includes(name)))
  rt.connectorOffFor = () => []
  rt.reapplyToolMasks()
  assert.equal(host.restricted.some(entry => entry.sessionId === 'a' && entry.deny.includes(name)), false)
})

test('role and context tool pruning adapts across groupless/group, Main/Worker, packs, and task transitions', async (t) => {
  const team = {
    ...structuredClone(TEAM),
    rooms: {},
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
      c: { id: 'c', name: 'Scout', role: 'Scout', sessionId: 'c', createdAt: 3 },
    },
  }
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  for (const id of ['a', 'b', 'c']) await host.agentCreated(id)

  // 1) Main Bot in a 0-group, 0-pack team keeps create_group + create_bot + stop_bot + update_bot,
  // while pruning group-only tools, delete_group, group_relay, and catalog pack tools.
  const mainZero = scopedNames(host, 'a')
  for (const keep of ['create_group', 'create_bot', 'stop_bot', 'update_bot', 'save_capability', 'delete_capability']) {
    assert.equal(mainZero.includes(keep), true, `Main Bot must keep ${keep}`)
  }
  for (const drop of ['group_relay', 'delete_group', ...GROUP_ONLY_TOOLS, ...CATALOG_PACK_TOOLS]) {
    assert.equal(mainZero.includes(drop), false, `0-group Main Bot must prune ${drop}`)
  }

  // 2) Worker (non-Main) in 0 groups keeps update_bot (self-edit/workDir) and capability tools,
  // while pruning team-admin tools, all 6 group-only tools, group_relay, and catalog pack tools.
  const workerZero = scopedNames(host, 'b')
  for (const keep of ['update_bot', 'save_capability', 'delete_capability', 'list_bot_models', 'delegate_work']) {
    assert.equal(workerZero.includes(keep), true, `Worker must keep ${keep}`)
  }
  for (const drop of ['group_relay', ...BUILTIN_PACKS['team-admin'].tools, ...GROUP_ONLY_TOOLS, ...CATALOG_PACK_TOOLS]) {
    assert.equal(workerZero.includes(drop), false, `Groupless Worker must prune ${drop}`)
  }

  // 3) Main Bot creates the first group -> Main Bot and added Workers gain group tools on sync,
  // while own-chat-only prepare_ds_bot_issue stays on own chats and is pruned in group sessions.
  const createdRoom = await host.tool('create_group', { members: ['Writer', 'Scout'], name: 'Ops' }, 'a')
  assert.match(createdRoom, /Created group "Ops"/)
  assert.equal(scopedNames(host, 'a').includes('prepare_ds_bot_issue'), true, 'Main Bot own chat keeps prepare_ds_bot_issue')
  assert.equal(scopedNames(host, 'b').includes('prepare_ds_bot_issue'), true, 'Worker own chat keeps prepare_ds_bot_issue')
  const roomId = Object.keys(rt.state.rooms)[0]
  rt.state.rooms[roomId].sessions ??= {}
  rt.state.rooms[roomId].sessions.b = 'group-b'
  await rt.save()
  await host.agentCreated('group-b')
  assert.equal(scopedNames(host, 'group-b').includes('prepare_ds_bot_issue'), false, 'Group session must prune prepare_ds_bot_issue')
  assert.match(await host.tool('prepare_ds_bot_issue', { title: 't', what: 'w', steps: 's' }, 'group-b'), /own chat/)
  for (const name of [...GROUP_ONLY_TOOLS, 'delete_group']) {
    assert.equal(scopedNames(host, 'a').includes(name), true, `Main Bot must unlock ${name} once a group exists`)
  }
  for (const name of GROUP_ONLY_TOOLS) {
    assert.equal(scopedNames(host, 'b').includes(name), true, `Worker must unlock ${name} upon joining a group`)
  }
  for (const name of BUILTIN_PACKS['team-admin'].tools) {
    assert.equal(scopedNames(host, 'b').includes(name), false, `Worker must still hide ${name} after joining a group`)
  }

  // 4) Removing Worker from its last group prunes all 6 group-only tools again.
  assert.equal((await host.call('update-room', { id: roomId, remove: ['b'] })).ok, true)
  for (const name of GROUP_ONLY_TOOLS) {
    assert.equal(scopedNames(host, 'b').includes(name), false, `Worker leaving last group must prune ${name}`)
  }

  // 5) Deleting the last group prunes group-only tools + delete_group from Main Bot while keeping create_group.
  assert.equal((await host.call('delete-room', { id: roomId })).ok, true)
  assert.equal(scopedNames(host, 'a').includes('create_group'), true, 'Main Bot must keep create_group after deleting last group')
  for (const name of [...GROUP_ONLY_TOOLS, 'delete_group']) {
    assert.equal(scopedNames(host, 'a').includes(name), false, `Main Bot must prune ${name} when zero groups remain`)
  }

  // 6) Attaching a catalog pack unlocks use_pack/drop_pack; detaching prunes them again.
  await rt.capabilitySave({ name: 'guide', kind: 'skill', content: 'Docs' }, { ui: true })
  await rt.changeCapabilityAttachment('attach', { name: 'guide', mode: 'catalog' }, 'b')
  for (const name of CATALOG_PACK_TOOLS) {
    assert.equal(scopedNames(host, 'b').includes(name), true, `Bot with catalog pack must get ${name}`)
  }
  await rt.changeCapabilityAttachment('detach', { name: 'guide' }, 'b')
  for (const name of CATALOG_PACK_TOOLS) {
    assert.equal(scopedNames(host, 'b').includes(name), false, `Bot detaching last catalog pack must prune ${name}`)
  }

  // 7) Promoting Worker to Main Bot via set-main unlocks team-admin tools cleanly.
  assert.equal((await host.call('set-main', { id: 'b', main: true })).ok, true)
  for (const name of ['create_bot', 'stop_bot', 'create_group']) {
    assert.equal(scopedNames(host, 'b').includes(name), true, `Promoted Worker must unlock ${name}`)
  }
  assert.equal(scopedNames(host, 'b').includes('delete_group'), false, 'Promoted Main Bot still hides delete_group when 0 groups exist')
})

test('real DSH ReactLoopAgent: background tasks prune task-blocked tools (team + global) while keeping defense-in-depth guards, and mid-turn state changes preserve KV cache until turn end', async (t) => {
  const team = {
    ...structuredClone(TEAM),
    rooms: {},
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
  }
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  rt.state.bots.b.tasks = [
    { id: 'k_own', title: 'Own task', status: 'running', sessionId: 'b-task', segments: [], startedAt: 2, updatedAt: 2 },
    { id: 'k_grp', title: 'Group task', roomId: 'r-temp', status: 'running', sessionId: 'b-gtask', segments: [], startedAt: 3, updatedAt: 3 },
    { id: 'k_fork', title: 'Forked task', status: 'running', sessionId: 'b-fork-task', forkedPrefixSessionId: 'b-fork-task', cacheAffinityId: 'b', segments: [], startedAt: 4, updatedAt: 4 },
    { id: 'k_grp_fork', title: 'Forked group task', roomId: 'r-temp', status: 'running', sessionId: 'b-gfork-task', forkedPrefixSessionId: 'b-gfork-task', cacheAffinityId: 'g-b', segments: [], startedAt: 4, updatedAt: 4 },
    { id: 'k_handoff', title: 'Handoff task', origin: 'fg-handoff', status: 'running', sessionId: 'b-handoff-task', segments: [], startedAt: 5, updatedAt: 5 },
    { id: 'k_bot_handoff', title: 'Fresh peer task', origin: 'bot-handoff', status: 'running', sessionId: 'b-peer-task', segments: [], startedAt: 5, updatedAt: 5 },
    { id: 'k_rotated', title: 'Rotated forked task', status: 'running', sessionId: 'b-fork-seg2', forkedPrefixSessionId: 'b-fork-seg1', cacheAffinityId: 'b', segments: [{ sessionId: 'b-fork-seg1', endedAt: 5 }], startedAt: 6, updatedAt: 6 },
  ]
  await rt.save()

  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  // Register global DSH tools that background tasks must mask (schedule_create, schedule_edit, browser_handoff).
  for (const name of ['schedule_create', 'schedule_edit', 'browser_handoff']) {
    root.tools.register({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'ok',
    })
  }
  host.ctx.tools.schemas = agent => root.tools.schemas(agent)

  const seenBySession = new Map()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } } }
    async *stream(options) {
      const sid = String(options.sessionId)
      const list = seenBySession.get(sid) ?? []
      list.push((options.tools ?? []).map(tool => tool.name))
      seenBySession.set(sid, list)
      if (sid === 'b' && list.length === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'mutate', name: 'mutate_mid_turn', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'mutate', name: 'mutate_mid_turn', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (sid === 'a' && list.length === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'mkgrp', name: 'create_group', argumentsDelta: JSON.stringify({ members: ['Writer'], name: 'Launch' }) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'mkgrp', name: 'create_group', arguments: JSON.stringify({ members: ['Writer'], name: 'Launch' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['prune-test'], new Adapter())
  await mountAgentLoopTestHarness(root)
  attachHostBuiltinFilters(root, host)
  const created = host.ctx.listeners.get('agent/created').find(listener => String(listener).includes('hideBotUnusedTools(agent)'))

  // 1) Own-chat background task & group background task on real ReactLoopAgent.
  for (const sid of ['b-task', 'b-gtask', 'b-fork-task', 'b-gfork-task', 'b-handoff-task', 'b-peer-task', 'b-fork-seg2']) {
    const agent = await root.agentLoop.create(SessionId(sid), { provider: 'prune-test', model: 'test' })
    await created({ agent })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run task' }] }))
    await agent.whenIdle()
  }
  const ownTaskTools = seenBySession.get('b-task')[0]
  const grpTaskTools = seenBySession.get('b-gtask')[0]
  const forkedTaskTools = seenBySession.get('b-fork-task')[0]
  const forkedGrpTaskTools = seenBySession.get('b-gfork-task')[0]
  const handoffTaskTools = seenBySession.get('b-handoff-task')[0]
  const peerTaskTools = seenBySession.get('b-peer-task')[0]
  const rotatedTaskTools = seenBySession.get('b-fork-seg2')[0]
  for (const blocked of [...TASK_HIDDEN_TEAM_TOOLS, 'schedule_create', 'schedule_edit', 'group_relay', ...CATALOG_PACK_TOOLS]) {
    assert.equal(ownTaskTools.includes(blocked), false, `own-chat task must prune ${blocked}`)
    assert.equal(grpTaskTools.includes(blocked), false, `group task must prune ${blocked}`)
    assert.equal(peerTaskTools.includes(blocked), false, `fresh non-fork bot-handoff task must prune ${blocked}`)
    assert.equal(rotatedTaskTools.includes(blocked), false, `rotated segment must prune ${blocked}`)
  }
  assert.equal(ownTaskTools.includes('delegate_work'), true, 'own-chat task keeps delegate_work')
  assert.equal(grpTaskTools.includes('delegate_work'), false, 'group task prunes delegate_work')
  assert.equal(ownTaskTools.includes('read_own_chat'), true, 'own-chat task keeps read_own_chat')

  // Forked and foreground-handoff tasks preserve the parent's tool prefix (no tool-removal KV reset)
  // while still blocking execution of foreground-only tools via defense-in-depth guards.
  // A forked group task keeps prepare_ds_bot_issue hidden to match its parent group session prefix.
  for (const kept of [...TASK_HIDDEN_TEAM_TOOLS, 'schedule_create', 'schedule_edit', 'browser_handoff']) {
    assert.equal(forkedTaskTools.includes(kept), true, `forked task must preserve ${kept} for KV cache prefix`)
    assert.equal(handoffTaskTools.includes(kept), true, `fg-handoff task must preserve ${kept} for KV cache prefix`)
    if (kept === 'prepare_ds_bot_issue') {
      assert.equal(forkedGrpTaskTools.includes(kept), false, 'forked group task must keep prepare_ds_bot_issue hidden like parent group session')
    } else {
      assert.equal(forkedGrpTaskTools.includes(kept), true, `forked group task must preserve ${kept} for KV cache prefix`)
    }
  }
  assert.equal(forkedGrpTaskTools.includes('delegate_work'), true, 'forked group task preserves parent delegate_work schema')
  assert.equal(rt.cacheAffinityOf('b-fork-task'), 'b')
  assert.equal(rt.cacheAffinityOf('b-gfork-task'), 'g-b')
  assert.equal(rt.cacheAffinityOf('b-peer-task'), undefined, 'non-fork bot-handoff task must not inherit cache affinity')
  assert.equal(rt.cacheAffinityOf('b-fork-seg2'), undefined, 'rotated segment must drop stale cache affinity')
  const forkSchedGuards = host.ctx.guards.map(fn => fn({ agent: { id: 'b-fork-task' }, name: 'schedule_create', arguments: {} })).filter(Boolean)
  assert.ok(forkSchedGuards.some(msg => /Background tasks cannot create or change schedules/.test(msg)))
  const forkBhGuards = host.ctx.guards.map(fn => fn({ agent: { id: 'b-fork-task' }, name: 'browser_handoff', arguments: {} })).filter(Boolean)
  assert.ok(forkBhGuards.some(msg => /Background tasks cannot hand the browser/.test(msg)))

  // Defense-in-depth: guard & execute() refusals remain intact even though schemas are pruned.
  const taskGuards = host.ctx.guards.map(fn => fn({ agent: { id: 'b-task' }, name: 'schedule_create', arguments: {} })).filter(Boolean)
  assert.ok(taskGuards.some(msg => /Background tasks cannot create or change schedules/.test(msg)))
  const bhGuards = host.ctx.guards.map(fn => fn({ agent: { id: 'b-task' }, name: 'browser_handoff', arguments: {} })).filter(Boolean)
  assert.ok(bhGuards.some(msg => /Background tasks cannot hand the browser/.test(msg)))

  // 2) KV-cache stability mid-turn: Worker starts groupless & packless; mid-turn tool adds a room
  // and attaches a catalog pack; Step 2 of Turn 1 MUST see the exact same frozen tool set as Step 1,
  // and Turn 2 MUST see the newly unlocked group + catalog pack tools!
  const workerAgent = await root.agentLoop.create(SessionId('b'), { provider: 'prune-test', model: 'test' })
  await created({ agent: workerAgent })
  workerAgent.ctx.tools.register({
    name: 'mutate_mid_turn',
    description: 'Mutate group & pack eligibility mid-turn',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() {
      rt.state.rooms.r9 = { id: 'r9', name: 'LiveRoom', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} }
      rt.state.bots.b.packs = ['demo-pack']
      await rt.save()
      workerAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next turn' }] }))
      return 'mutated'
    },
  })
  workerAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 1' }] }))
  await workerAgent.whenIdle()
  const workerSteps = seenBySession.get('b')
  assert.equal(workerSteps.length, 3, 'expected 2 steps in Turn 1 + 1 step in Turn 2')
  assert.deepEqual(workerSteps[1], workerSteps[0], 'Step 2 of Turn 1 must keep the exact same tool list (KV cache stable)')
  assert.equal(workerSteps[0].includes('post_to_group'), false)
  assert.equal(workerSteps[0].includes('use_pack'), false)
  assert.equal(workerSteps[2].includes('post_to_group'), true, 'Turn 2 must unlock group tools after turn/end sync')
  assert.equal(workerSteps[2].includes('use_pack'), true, 'Turn 2 must unlock catalog pack tools after turn/end sync')

  // 3) Main Bot creating the very first group mid-turn immediately unlocks post_to_group on Step 2!
  delete rt.state.rooms.r9
  await rt.save()
  const chiefAgent = await root.agentLoop.create(SessionId('a'), { provider: 'prune-test', model: 'test' })
  await created({ agent: chiefAgent })
  chiefAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'make first group' }] }))
  await chiefAgent.whenIdle()
  const chiefSteps = seenBySession.get('a')
  assert.equal(chiefSteps.length, 2)
  assert.equal(chiefSteps[0].includes('create_group'), true)
  assert.equal(chiefSteps[0].includes('post_to_group'), false, 'Step 1 has 0 groups so post_to_group is pruned')
  assert.equal(chiefSteps[1].includes('post_to_group'), true, 'Step 2 immediately unlocks post_to_group after create_group succeeds')
})

test('connector offFor unmounts and restores Agent-scoped team tools (mail_*) across live toggle, assemble, creation, addTeamTool, and removeTeamTool', async (t) => {
  const host = start()
  t.after(() => {
    for (const name of ['mail_search', 'mail_send', 'mail_read']) rt.removeTeamTool(name)
    host.stop()
  })
  await host.call('state', {})
  await host.agentCreated('a')
  await host.agentCreated('b')

  const makeTool = (name) => ({
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return 'ok' },
  })
  rt.addTeamTool(makeTool('mail_search'))
  rt.addTeamTool(makeTool('mail_send'))
  assert.equal(scopedNames(host, 'a').includes('mail_search'), true)
  assert.equal(scopedNames(host, 'a').includes('mail_send'), true)
  assert.equal(scopedNames(host, 'b').includes('mail_search'), true)

  // Turn off mail for Bot a only (also with a global MCP tool denied at the same time).
  host.ctx.tools.schemas = (agent) => [
    ...scopedNames(host, agent.id).map(name => ({ name })),
    { name: 'mcp__notion__search' },
  ]
  rt.connectorOffFor = (botId) => botId === 'a' ? ['mail_', 'mcp__notion__'] : []
  rt.reapplyToolMasks()

  // Bot a's scoped mail_* tools are unmounted directly; global MCP tool uses restrict(); Bot b keeps mail_*.
  assert.equal(scopedNames(host, 'a').includes('mail_search'), false)
  assert.equal(scopedNames(host, 'a').includes('mail_send'), false)
  assert.equal(scopedNames(host, 'b').includes('mail_search'), true)
  assert.equal(scopedNames(host, 'b').includes('mail_send'), true)
  assert.equal(host.restricted.some(entry => entry.sessionId === 'a' && entry.deny.includes('mcp__notion__search')), true)
  assert.equal(host.restricted.some(entry => entry.sessionId === 'a' && entry.deny.some(n => n.startsWith('mail_'))), false)

  // Subsequent hideBotUnusedTools (system-prompt/assemble) must NOT re-register hidden mail_* tools.
  rt.hideBotUnusedTools(host.agentOf('a'))
  assert.equal(scopedNames(host, 'a').includes('mail_search'), false)
  assert.equal(scopedNames(host, 'a').includes('mail_send'), false)

  // A mail tool added while mail is off for Bot a skips Bot a, registers on Bot b, and joins Bot a once re-enabled.
  rt.addTeamTool(makeTool('mail_read'))
  assert.equal(scopedNames(host, 'a').includes('mail_read'), false)
  assert.equal(scopedNames(host, 'b').includes('mail_read'), true)

  // Removing a hidden mail tool clears it so turning mail back on does not re-register a removed tool.
  rt.removeTeamTool('mail_send')

  // Re-enabling mail for Bot a restores the remaining mail tools and lifts the MCP mask.
  rt.connectorOffFor = () => []
  rt.reapplyToolMasks()
  assert.equal(scopedNames(host, 'a').includes('mail_search'), true)
  assert.equal(scopedNames(host, 'a').includes('mail_read'), true)
  assert.equal(scopedNames(host, 'a').includes('mail_send'), false)
  assert.equal(host.restricted.some(entry => entry.sessionId === 'a' && entry.deny.includes('mcp__notion__search')), false)

  // A freshly created Agent whose Bot already has mail off never receives mail_* on creation,
  // and receives them immediately when mail is turned back on.
  rt.connectorOffFor = (botId) => botId === 'b' ? ['mail_'] : []
  await host.agentCreated('b')
  assert.equal(scopedNames(host, 'b').includes('mail_search'), false)
  assert.equal(scopedNames(host, 'b').includes('mail_read'), false)
  rt.connectorOffFor = () => []
  rt.reapplyToolMasks()
  assert.equal(scopedNames(host, 'b').includes('mail_search'), true)
  assert.equal(scopedNames(host, 'b').includes('mail_read'), true)
})

test('real DSH ToolsService + ReactLoopAgent contract: mail_* unmount/restore with synchronous tools/change, global MCP mask, plugin overlap, and fast-path invariant', async (t) => {
  const host = start()
  const root = new Context()
  t.after(async () => {
    for (const name of ['mail_search', 'mail_send']) rt.removeTeamTool(name)
    await root.fiber.dispose()
    host.stop()
  })
  await host.call('state', {})
  await mountAgentLoopTestDependencies(root)

  // Register an inherited global MCP tool on root.tools, and forward real synchronous tools/change to host.ctx.
  root.tools.register({
    name: 'mcp__notion__search',
    description: 'Search Notion',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'ok',
  })
  let schemaReads = 0
  host.ctx.tools.schemas = (agent) => { schemaReads += 1; return root.tools.schemas(agent) }
  let localCliNotifications = 0
  rt.notifyLocalAgentToolsChanged = () => { localCliNotifications += 1 }
  root.on('tools/change', () => {
    for (const fn of host.ctx.listeners.get('tools/change') ?? []) fn()
  })

  const seenBySession = new Map()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } } }
    async *stream(options) {
      const sid = String(options.sessionId)
      const list = seenBySession.get(sid) ?? []
      list.push((options.tools ?? []).map(tool => tool.name))
      seenBySession.set(sid, list)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['mail-mask-test'], new Adapter())
  await mountAgentLoopTestHarness(root)
  attachHostBuiltinFilters(root, host)
  const created = host.ctx.listeners.get('agent/created').find(listener => String(listener).includes('hideBotUnusedTools(agent)'))

  const makeMailTool = (name) => ({
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'ok',
  })
  rt.addTeamTool(makeMailTool('mail_search'))
  rt.addTeamTool(makeMailTool('mail_send'))

  const agentA = await root.agentLoop.create(SessionId('a'), { provider: 'mail-mask-test', model: 'test' })
  const agentB = await root.agentLoop.create(SessionId('b'), { provider: 'mail-mask-test', model: 'test' })
  await created({ agent: agentA })
  await created({ agent: agentB })

  const namesOf = (agent) => root.tools.schemas(agent).map(s => s.name)
  assert.equal(namesOf(agentA).includes('mail_search'), true)
  assert.equal(namesOf(agentA).includes('mail_send'), true)
  assert.equal(namesOf(agentA).includes('mcp__notion__search'), true)

  // Turn off both mail (Agent-scoped) and notion (inherited global) for Bot a only.
  // Real DSH ToolsService synchronously emits tools/change on every dispose()/restrict().
  localCliNotifications = 0
  rt.connectorOffFor = (botId) => botId === 'a' ? ['mail_', 'mcp__notion__'] : []
  rt.reapplyToolMasks()
  assert.equal(localCliNotifications, 1, 'batched reapplyToolMasks coalesces synchronous tools/change notifications')

  // Verify live schemas (the exact source local-agents/index.js toolsFor reads) and real ReactLoopAgent options.tools.
  assert.equal(namesOf(agentA).includes('mail_search'), false)
  assert.equal(namesOf(agentA).includes('mail_send'), false)
  assert.equal(namesOf(agentA).includes('mcp__notion__search'), false)
  assert.equal(namesOf(agentB).includes('mail_search'), true)
  assert.equal(namesOf(agentB).includes('mail_send'), true)
  assert.equal(namesOf(agentB).includes('mcp__notion__search'), true)

  agentA.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'with mail off' }] }))
  await agentA.whenIdle()
  const turnOffTools = seenBySession.get('a').at(-1)
  assert.equal(turnOffTools.includes('mail_search'), false)
  assert.equal(turnOffTools.includes('mail_send'), false)
  assert.equal(turnOffTools.includes('mcp__notion__search'), false)

  // Plugin + connector overlapping denial: lifting plugin first keeps mail_search hidden until connector also lifts.
  let pluginBlocked = true
  rt.pluginDeniedRules = (botId) => botId === 'a' && pluginBlocked
    ? { prefixes: [], exact: [], scopedDenied: new Set(['mail_search']), protectedTools: new Set() }
    : { prefixes: [], exact: [], scopedDenied: new Set(), protectedTools: new Set() }
  rt.reapplyToolMasks()
  pluginBlocked = false
  rt.reapplyToolMasks()
  assert.equal(namesOf(agentA).includes('mail_search'), false, 'lifting plugin alone must keep connector-disabled mail_search hidden')

  // Re-enable mail and notion for Bot a: both Agent-scoped mail_* and global mcp__notion__search return immediately.
  localCliNotifications = 0
  rt.connectorOffFor = () => []
  rt.reapplyToolMasks()
  assert.equal(localCliNotifications, 1)
  assert.equal(namesOf(agentA).includes('mail_search'), true)
  assert.equal(namesOf(agentA).includes('mail_send'), true)
  assert.equal(namesOf(agentA).includes('mcp__notion__search'), true)

  agentA.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'with mail back on' }] }))
  await agentA.whenIdle()
  const turnOnTools = seenBySession.get('a').at(-1)
  assert.equal(turnOnTools.includes('mail_search'), true)
  assert.equal(turnOnTools.includes('mail_send'), true)
  assert.equal(turnOnTools.includes('mcp__notion__search'), true)

  // Fast-path invariant after full restore: another reapplyToolMasks() reads 0 schemas.
  schemaReads = 0
  rt.reapplyToolMasks()
  assert.equal(schemaReads, 0, 'fast path must not read ctx.tools.schemas when no connector is off')
})
