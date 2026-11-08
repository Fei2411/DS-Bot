import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
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

const text = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')
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

test('a tool whose registration failed is tried again, and another Agent is not disturbed', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  dsh.agentOf('gb', { status: 'idle' })
  dsh.agentOf('b', { status: 'idle' })
  const registered = { gb: [], b: [] }
  const attempts = { gb: [], b: [] }
  let rememberFailures = 0
  for (const id of ['gb', 'b']) {
    dsh.agentOf(id).ctx = {
      tools: {
        register: (def) => {
          attempts[id].push(def.name)
          // The first attempt happens while the Agent cannot take it yet.
          if (id === 'gb' && def.name === 'remember' && rememberFailures < 1) {
            rememberFailures += 1
            throw new Error('the Agent is not ready for scoped tools yet')
          }
          registered[id].push(def.name)
          return () => {}
        },
        restrict: () => () => {},
      },
      on: () => () => {},
    }
  }
  const { ctx, rt } = await loadPlugin(dsh, home)
  cleanup(t, home, ctx)
  // The scope was built once and 'remember' was refused; it must not count as added.
  await settle(() => attempts.gb.includes('remember'))
  assert.equal(registered.gb.includes('remember'), false)
  // The next sync tries it again, and this time it lands.
  rt.syncScopedTools()
  assert.equal(registered.gb.includes('remember'), true)
  const settled = attempts.gb.filter(name => name === 'remember').length
  assert.equal(settled, 2)
  rt.syncScopedTools()
  assert.equal(attempts.gb.filter(name => name === 'remember').length, settled)
  // The other Agent got the tool once, and was not touched by the retry.
  assert.equal(registered.b.includes('remember'), true)
  assert.equal(attempts.b.filter(name => name === 'remember').length, 1)
})

test('a running group turn that ends after the reload still posts its reply to the group', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  // Writer is mid-turn in the group, with the group's own Session live beside it.
  dsh.agentOf('gb')
  dsh.agentOf('r1', { status: 'idle' })
  const first = await loadPlugin(dsh, home)
  await settle(() => first.rt.live.get('gb')?.turn !== undefined)
  await first.ctx.dispose()

  const second = await loadPlugin(dsh, home)
  cleanup(t, home, second.ctx)
  await settle(() => second.rt.live.get('gb')?.turn !== undefined)
  assert.equal((second.rt.roomWorkView().r1 ?? []).some(item => item.botId === 'b'), true)

  emit(second.ctx, 'gb', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'The answer is ready.' }] } })
  emit(second.ctx, 'gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // The round's waiter went with the old plugin; the reply reaches the group's own
  // Session as a late group post.
  await settle(() => dsh.agentOf('r1').calls.some(([kind, message]) => kind === 'followup' && text(message).includes('[Group post from Writer]')))
  const post = dsh.agentOf('r1').calls.find(([kind, message]) => kind === 'followup' && text(message).includes('[Group post from Writer]'))
  assert.match(text(post[1]), /The answer is ready\./)
  assert.equal((second.rt.roomWorkView().r1 ?? []).some(item => item.botId === 'b'), false)
})


test('a new request joins a recovered turn and is answered in its own turn', async (t) => {
  const home = freshHome()
  const dsh = dshSide()
  dsh.agentOf('b')
  const { ctx, rt } = await loadPlugin(dsh, home)
  cleanup(t, home, ctx)
  await settle(() => rt.live.get('b')?.turn !== undefined)
  const delivered = []
  rt.deliver = async request => { delivered.push(request) }
  const request = { kind: 'bot', role: 'request', exchangeId: 'new-request', senderSessionId: 'a' }
  const message = { source: request, content: [{ type: 'text', text: 'A separate new request' }] }
  emit(ctx, 'b', 'user/message', message)
  emit(ctx, 'b', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'The old task result' }] } })
  emit(ctx, 'b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => delivered.length > 0)
  assert.equal(delivered.some(item => item.replyTo === request.exchangeId), false, 'old work must not answer a new request')
  assert.equal(delivered[0].deferred, true)
  assert.equal(delivered[0].exchangeId, request.exchangeId)
  assert.equal(delivered[0].text, 'A separate new request')
  // A fresh turn still lets its first input claim it, rather than deferring forever.
  emit(ctx, 'b', 'turn/start', { turn: 2 })
  emit(ctx, 'b', 'user/message', message)
  emit(ctx, 'b', 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'The new request result' }] } })
  emit(ctx, 'b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => delivered.some(item => item.replyTo === request.exchangeId))
  assert.equal(delivered.find(item => item.replyTo === request.exchangeId).text, 'The new request result')
})


test('a real DSH loop keeps post-reload input separate from the running task', async (t) => {
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  const release = Promise.withResolvers()
  let calls = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream() {
      const first = ++calls === 1
      if (first) await release.promise
      const text = first ? 'The old task result' : 'The new request result'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['reload-test'], new Adapter())
  await mountAgentLoopTestHarness(root)
  const agent = await root.agentLoop.create(SessionId('b'), { provider: 'reload-test', model: 'test' })
  const home = freshHome()
  const dsh = dshSide()
  dsh.agentMap.set('b', agent)
  dsh.services.agents = root.agents
  let active
  root.on('session/event', (session, event) => {
    for (const listener of active?.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  const first = await loadPlugin(dsh, home)
  active = first.ctx
  t.after(async () => {
    release.resolve()
    await root.fiber.dispose()
    await active?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'The original task' }] }))
  await settle(() => calls === 1, 5000)
  await first.ctx.dispose()
  const second = await loadPlugin(dsh, home)
  active = second.ctx
  const delivered = []
  second.rt.deliver = async request => { delivered.push(request) }
  await settle(() => second.rt.live.get('b')?.turn !== undefined)
  const request = { kind: 'bot', role: 'request', exchangeId: 'new-request', senderSessionId: 'a' }
  const message = () => createUserMessage({ source: request, content: [{ type: 'text', text: 'A separate new request' }] })
  agent.inject(message())
  release.resolve()
  await agent.whenIdle()
  await settle(() => delivered.length > 0)
  assert.equal(delivered.some(item => item.replyTo === request.exchangeId), false)
  assert.equal(delivered[0].deferred, true)
  agent.followup(message())
  await agent.whenIdle()
  await settle(() => delivered.some(item => item.replyTo === request.exchangeId))
  assert.equal(delivered.find(item => item.replyTo === request.exchangeId).text, 'The new request result')
})
