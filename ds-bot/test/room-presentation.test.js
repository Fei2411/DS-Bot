import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A team on a DSH whose tools present as PTC unless an agent's scope declares
// otherwise. Agents are cached per Session and announced through agent/created the
// way DSH does, so a new group's agent exists before the group is recorded.
function start({ saved, presentAs } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-room-presentation-'))
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (_format, line) => warnings.push(line)
  const workspaces = new Map()
  const sent = []
  const agents = new Map()
  const declared = []
  const modes = new Map()
  ctx.tools.presentAs = () => { throw new Error('tools.presentAs() requires a scoped context (agent.ctx)') }
  // Each agent is its own scope, which takes one declaration.
  const makeAgent = (sessionId) => {
    let own
    return {
      id: sessionId,
      session: { id: sessionId },
      inbox: { nextTurn: [], nextStep: [], remove: () => false },
      ctx: {
        effect: execute => execute(),
        tools: {
          presentAs: presentAs ?? ((mode) => {
            if (own !== undefined) throw new Error(`tools.presentAs("${mode}") conflicts with "${own}" already declared for this scope`)
            own = mode
            declared.push({ sessionId, mode })
            modes.set(sessionId, mode)
            return () => {}
          }),
        },
      },
      followup: message => sent.push({ sessionId, message }),
    }
  }
  const announce = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async (sessionId) => {
        if (!agents.has(sessionId)) {
          const agent = makeAgent(sessionId)
          agents.set(sessionId, agent)
          await announce(agent)
        }
        return { agent: agents.get(sessionId) }
      },
      selectModel: async () => {},
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  // groups.js registers the first llm/stream listener (install.test.js pins the order).
  const stream = async (options, next = async function* passed() { yield { type: 'finish', reason: { kind: 'stop' }, passed: true } }) => {
    const events = []
    for await (const event of ctx.listeners.get('llm/stream')[0](options, next)) events.push(event)
    return events
  }
  // What the model is offered: every tool when the scope presents natively, else run_code alone.
  const offered = sessionId => (modes.get(sessionId) === 'native'
    ? [...ctx.registeredTools.keys()].map(name => ({ name }))
    : [{ name: 'run_code' }])
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, emit, stream, offered, announce, makeAgent, agents, declared, modes, warnings, sent, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const userOpens = text => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
const relayCallOf = events => events.find(event => event.type === 'block-end')?.block

const SAVED = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w1', name: 'Writer', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { g1: { id: 'g1', name: 'R1', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'everyone', createdAt: 3 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('a new group\'s Session presents its tools natively, once; Bot Sessions keep theirs', async (t) => {
  const { call, announce, agents, declared, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  // agent/created ran before the group was recorded; createRoom declared it.
  assert.deepEqual(declared, [{ sessionId: room.id, mode: 'native' }])
  // DSH announcing the same agent again does not declare a second time.
  await announce(agents.get(room.id))
  assert.deepEqual(declared, [{ sessionId: room.id, mode: 'native' }])
})

test('a group saved earlier presents natively when DSH creates its agent', async (t) => {
  const { announce, makeAgent, declared, stop } = start({ saved: SAVED })
  t.after(stop)
  await announce(makeAgent('m1'))
  await announce(makeAgent('w1'))
  assert.deepEqual(declared, [])
  await announce(makeAgent('g1'))
  assert.deepEqual(declared, [{ sessionId: 'g1', mode: 'native' }])
  // A new agent for the same Session (DSH disposed the old one) is a new scope.
  await announce(makeAgent('g1'))
  assert.deepEqual(declared, [{ sessionId: 'g1', mode: 'native' }, { sessionId: 'g1', mode: 'native' }])
})

test('an agent still being put together gets the declaration on a later retry', async (t) => {
  const { announce, makeAgent, declared, stop } = start({ saved: SAVED })
  t.after(stop)
  t.mock.timers.enable({ apis: ['setInterval'] })
  const agent = makeAgent('g1')
  const { ctx } = agent
  delete agent.ctx
  await announce(agent)
  assert.deepEqual(declared, [])
  t.mock.timers.tick(5_000)
  assert.deepEqual(declared, [])
  agent.ctx = ctx
  t.mock.timers.tick(5_000)
  assert.deepEqual(declared, [{ sessionId: 'g1', mode: 'native' }])
  t.mock.timers.tick(5_000)
  assert.equal(declared.length, 1)
})

test('a refused declaration warns once and the group still relays through run_code', async (t) => {
  let attempts = 0
  const presentAs = () => {
    attempts += 1
    throw new Error('tools.presentAs("native") conflicts with "ptc" already declared for this scope')
  }
  const { announce, makeAgent, stream, warnings, stop } = start({ saved: SAVED, presentAs })
  t.after(stop)
  t.mock.timers.enable({ apis: ['setInterval'] })
  const agent = makeAgent('g1')
  await announce(agent)
  await announce(agent)
  t.mock.timers.tick(15_000)
  assert.equal(attempts, 1)
  assert.equal(warnings.filter(line => /group chat g1 keeps its tool presentation/.test(line)).length, 1)
  const call = relayCallOf(await stream({ sessionId: 'g1', messages: userOpens('hi'), tools: [{ name: 'run_code' }] }))
  assert.equal(call.name, 'run_code')
})

test('the relay step calls group_relay directly unless only run_code is offered', async (t) => {
  const { stream, stop } = start({ saved: SAVED })
  t.after(stop)
  const messages = userOpens('hi')
  for (const tools of [undefined, [{ name: 'group_relay' }, { name: 'read_own_chat' }], [{ name: 'group_relay' }, { name: 'run_code' }]]) {
    const events = await stream({ sessionId: 'g1', messages, tools })
    const call = relayCallOf(events)
    assert.deepEqual([call.name, call.arguments], ['group_relay', '{}'])
    assert.equal(events.find(event => event.type === 'tool-call-delta').name, 'group_relay')
    assert.deepEqual(events.at(-1).reason, { kind: 'tool-calls' })
  }
  const events = await stream({ sessionId: 'g1', messages, tools: [{ name: 'run_code' }] })
  const call = relayCallOf(events)
  assert.equal(call.name, 'run_code')
  assert.deepEqual(JSON.parse(call.arguments), { description: 'Relay the group chat to its Bots', code: 'return await tools.group_relay({})', timeoutMs: 600_000 })
  const delta = events.find(event => event.type === 'tool-call-delta')
  assert.deepEqual([delta.id, delta.name, delta.argumentsDelta], [call.id, 'run_code', call.arguments])
})

test('Bot Sessions and auxiliary calls still reach the model', async (t) => {
  const { stream, stop } = start({ saved: SAVED })
  t.after(stop)
  for (const options of [
    { sessionId: 'm1', messages: userOpens('hi'), tools: [{ name: 'run_code' }] },
    { sessionId: 'g1', purpose: 'title', messages: userOpens('hi'), tools: [{ name: 'run_code' }] },
  ]) {
    const events = await stream(options)
    assert.equal(events.length, 1)
    assert.equal(events[0].passed, true)
  }
})

// The repro: Writer and Coder in 研发群 under PTC, the user says 大家好, and DSH's
// executor refuses any direct call but run_code. Both members answer.
async function hello({ presentAs } = {}) {
  const harness = start({ presentAs })
  const { call, emit, stream, offered, modes, sent, rt } = harness
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const coder = (await call('create-bot', { name: 'Coder' })).value
  const room = (await call('create-room', { name: '研发群', members: [writer.id, coder.id] })).value
  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '大家好' }] } })
  const step = relayCallOf(await stream({ sessionId: room.id, messages: userOpens('大家好'), tools: offered(room.id) }))
  const relay = () => harness.ctx.registeredTools.get('group_relay')
    .execute({}, { agent: harness.agents.get(room.id), callId: step.id, signal: new AbortController().signal })
  let running
  if (modes.get(room.id) !== 'native' && step.name !== 'run_code') {
    running = Promise.resolve(`Error: unknown tool "${step.name}": only \`run_code\` is callable directly`)
  } else if (step.name === 'run_code') {
    assert.equal(JSON.parse(step.arguments).code, 'return await tools.group_relay({})')
    running = relay()
  } else {
    running = relay()
  }
  let turn = 0
  const answered = []
  for (const text of ['大家好，我是 Writer。', '大家好，我是 Coder。']) {
    const next = await waitFor(() => sent.find(entry => !answered.includes(entry) && entry.message.source.role === 'room'))
    if (next === undefined) break
    answered.push(next)
    turn += 1
    await emit(next.sessionId, { type: 'turn/start', data: { turn } })
    await emit(next.sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId: next.message.source.exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(next.sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(next.sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const result = await running
  const log = rt.state.rooms[room.id].log.map(line => `${line.who}: ${line.text}`)
  return { harness, step, result, log }
}

test('#37: under PTC a greeting in 研发群 reaches every member through a direct group_relay', async (t) => {
  const { harness, step, log } = await hello()
  t.after(harness.stop)
  assert.equal(step.name, 'group_relay')
  assert.deepEqual(log, ['User: 大家好', 'Writer: 大家好，我是 Writer。', 'Coder: 大家好，我是 Coder。'])
})

test('#37: when the native declaration is refused, the round still runs inside run_code', async (t) => {
  const { harness, step, result, log } = await hello({ presentAs: () => { throw new Error('conflicts') } })
  t.after(harness.stop)
  assert.equal(step.name, 'run_code')
  assert.deepEqual(JSON.parse(result).replies.map(reply => reply.name), ['Writer', 'Coder'])
  assert.deepEqual(log, ['User: 大家好', 'Writer: 大家好，我是 Writer。', 'Coder: 大家好，我是 Coder。'])
})
