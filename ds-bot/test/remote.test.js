import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createRuntime } from '../index.js'
import * as pluginEntry from '../plugin.js'
import { API_VERSION, CAPABILITIES } from '../src/host/mobile.js'
import { RPC_NAMESPACE, createRemoteService, feedEvents, install as installRemote } from '../src/host/remote.js'
import { fakeContext } from './fake-ctx.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

async function startGatewayHost(ctx) {
  await ctx.plugin(TypertRegistry)
  // DSH >= 0.2.1-alpha.3 separates remoteAccess into its own Service; 0.2.0-rc.2 does not have it.
  if (TypertGatewayService.inject?.includes('remoteAccess')) {
    const { RemoteAccessService } = await import('@deepseek-ai/dsh-api-remote-access')
    await ctx.plugin(RemoteAccessService)
  }
  await ctx.plugin(TypertGatewayService)
}

function startHost(extraCtx = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-'))
  const ctx = fakeContext()
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  const workspaces = new Map()
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
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup() {} } }),
      selectModel: async () => {},
      prompt: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    ...extraCtx,
  })
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, routes, stop }
}

function ownerPeer(signal = new AbortController().signal) {
  return {
    id: 'peer-owner-1',
    signal,
    principal: { kind: 'owner' },
    interactions: 'answer',
  }
}

test('hello omits rpc capability and endpoints without a Typert Gateway', async (t) => {
  const { call, stop } = startHost()
  t.after(stop)
  const reply = await call('hello', { api: [1], client: 'dsh-go', platform: 'android' })
  assert.equal(reply.ok, true)
  assert.equal(reply.value.api, API_VERSION)
  assert.deepEqual(reply.value.capabilities, CAPABILITIES)
  assert.equal(reply.value.capabilities.includes('rpc'), false)
  assert.equal(reply.value.rpc, undefined)
})

test('channelCall and subscribeFeed mirror HTTP channel and SSE feed', async (t) => {
  const { rt, stop } = startHost()
  t.after(stop)

  const stateReply = await rt.channelCall('state', { avatars: 'ref' })
  assert.equal(stateReply.ok, true)
  assert.ok(Array.isArray(stateReply.value.bots))

  const events = []
  const untap = rt.subscribeFeed((event, data) => events.push({ event, data }))
  t.after(untap)

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'hello')
  assert.equal(events[0].data.api, API_VERSION)
  assert.equal(typeof events[0].data.boot, 'string')
  assert.equal(typeof events[0].data.seq, 'number')
  assert.equal(typeof events[0].data.revision, 'number')

  // publishFeed wakes when subscribeFeed holds the only listener (no SSE clients connected).
  rt.publishFeed('notice', { seq: 1, kind: 'message', text: 'hi' })
  assert.equal(events.length, 2)
  assert.deepEqual(events[1], { event: 'notice', data: { seq: 1, kind: 'message', text: 'hi' } })
})

test('feedEvents strips undefined, preserves order, and cleans up on abort', async () => {
  let active = true
  let push
  const subscribe = (listener) => {
    push = listener
    listener('hello', { revision: 3, optional: undefined })
    return () => { active = false }
  }
  const controller = new AbortController()
  const stream = feedEvents(subscribe, controller.signal)

  const first = await stream.next()
  assert.equal(first.done, false)
  assert.deepEqual(first.value, { event: 'hello', data: { revision: 3 } })
  assert.equal('optional' in first.value.data, false)
  assert.equal(active, true)

  push('revision', { revision: 4 })
  const second = await stream.next()
  assert.deepEqual(second.value, { event: 'revision', data: { revision: 4 } })

  const pending = stream.next()
  controller.abort()
  const ended = await pending
  assert.equal(ended.done, true)
  assert.equal(active, false)
})

test('feedEvents ends when queued events pass the backlog cap', async () => {
  let unsubscribed = false
  const subscribe = (listener) => {
    for (let i = 0; i < 600; i += 1) listener('tick', { i })
    return () => { unsubscribed = true }
  }
  const received = []
  for await (const item of feedEvents(subscribe, new AbortController().signal)) received.push(item)
  assert.equal(received.length, 512)
  assert.equal(unsubscribed, true)
})

test('feedEvents streams past the ring capacity when consumer keeps pace with pending items', async () => {
  let push
  let unsubscribed = false
  const subscribe = (listener) => {
    push = listener
    listener('hello', { i: 0 })
    listener('tick', { i: 1 })
    return () => { unsubscribed = true }
  }
  const controller = new AbortController()
  const stream = feedEvents(subscribe, controller.signal)
  const seen = []
  for (let i = 0; i < 1500; i += 1) {
    const next = await stream.next()
    assert.equal(next.done, false)
    seen.push(next.value.data.i)
    if (i + 2 < 1500) push('tick', { i: i + 2 })
  }
  assert.equal(seen.length, 1500)
  assert.equal(seen[0], 0)
  assert.equal(seen[1499], 1499)
  controller.abort()
  const ended = await stream.next()
  assert.equal(ended.done, true)
  assert.equal(unsubscribed, true)
})

test('createRemoteService serves dsBot/call and dsBot/feed through real DSH TypertGatewayService', async (t) => {
  const root = new Context()
  const received = []
  const abortedStates = []
  const listeners = new Set()

  // Real Cordis + TypertRegistry (+ RemoteAccessService when present) + TypertGatewayService stack.
  await startGatewayHost(root)
  t.after(async () => { await root.fiber.dispose() })

  const rt = {
    async channelCall(endpoint, payload, signal) {
      received.push({ endpoint, payload, aborted: signal?.aborted ?? false })
      if (endpoint === 'abort-probe') {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            abortedStates.push(signal.aborted)
            reject(signal.reason ?? new Error('aborted'))
          }, { once: true })
        })
      }
      if (endpoint === 'slim') return { ok: true, value: { id: 'b1', avatar: { shape: 'whale', image: undefined } } }
      return { ok: true, value: { endpoint, payload } }
    },
    subscribeFeed(listener) {
      listeners.add(listener)
      listener('hello', { revision: 1, api: 1, boot: 'b-gw', seq: 0, dropped: undefined })
      return () => listeners.delete(listener)
    },
  }

  // Register through the same ctx.inject(['typertGateway'], ...) path `remote.install(rt)` uses.
  const fork = await root.plugin((sub) => {
    installRemote({ ...rt, ctx: sub })
  })
  await tick()

  const gateway = root.typertGateway
  assert.equal(gateway.claimsEndpoint(`${RPC_NAMESPACE}/call`), true)
  assert.equal(gateway.claimsEndpoint(`${RPC_NAMESPACE}/feed`), true)

  // 1. Unary call with explicit { endpoint, payload }
  const callReply = await gateway.dispatchRpc(
    `${RPC_NAMESPACE}/call`,
    { args: { endpoint: 'hello', payload: { api: [1], client: 'dsh-go' } } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(callReply.ok, true)
  assert.deepEqual(callReply.value, {
    ok: true,
    value: { endpoint: 'hello', payload: { api: [1], client: 'dsh-go' } },
  })
  assert.deepEqual(received[0], { endpoint: 'hello', payload: { api: [1], client: 'dsh-go' }, aborted: false })

  // 2. Unary call omitting `payload` + `undefined` stripped by `plain` so Typert accepts JSON
  const omittedPayload = await gateway.dispatchRpc(
    `${RPC_NAMESPACE}/call`,
    { args: { endpoint: 'slim' } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(omittedPayload.ok, true)
  assert.deepEqual(omittedPayload.value, { ok: true, value: { id: 'b1', avatar: { shape: 'whale' } } })
  assert.equal('image' in omittedPayload.value.value.avatar, false)

  // 3. Cancellation signal reaches rt.channelCall when peer/request aborts
  const abortControl = new AbortController()
  const inflight = gateway.dispatchRpc(
    `${RPC_NAMESPACE}/call`,
    { args: { endpoint: 'abort-probe', payload: {} } },
    abortControl.signal,
    ownerPeer(),
  )
  await tick()
  abortControl.abort()
  const abortedResult = await inflight
  assert.equal(abortedResult.ok, false)
  assert.deepEqual(abortedStates, [true])

  // 4. Stream call `dsBot/feed` opens at `hello`, delivers live events, and cleans up on abort
  const feedControl = new AbortController()
  const wireStream = await gateway.openWireStream(
    `${RPC_NAMESPACE}/feed`,
    { args: {} },
    undefined,
    ownerPeer(),
    feedControl.signal,
    feedControl,
    undefined,
  )
  const iterator = wireStream[Symbol.asyncIterator]()
  const firstFrame = await iterator.next()
  assert.equal(firstFrame.done, false)
  assert.deepEqual(firstFrame.value, {
    event: 'hello',
    data: { revision: 1, api: 1, boot: 'b-gw', seq: 0 },
  })
  assert.equal(listeners.size, 1)

  for (const listener of listeners) listener('room', { roomId: 'r1' })
  const roomFrame = await iterator.next()
  assert.equal(roomFrame.done, false)
  assert.deepEqual(roomFrame.value, { event: 'room', data: { roomId: 'r1' } })

  feedControl.abort()
  await assert.rejects(() => iterator.next(), error => error?.code === 'gateway/cancelled')
  await tick()
  assert.equal(listeners.size, 0)

  // 5. Disposing the plugin withdraws the Remote endpoints from TypertGatewayService
  await fork.dispose()
  await tick()
  assert.equal(gateway.claimsEndpoint(`${RPC_NAMESPACE}/call`), false)
  assert.equal(gateway.claimsEndpoint(`${RPC_NAMESPACE}/feed`), false)

  assert.equal(typeof createRemoteService(rt), 'function')
})

test('full ds-bot runtime serves real hello, state and live feed through TypertGatewayService', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-full-'))
  const root = new Context()
  await startGatewayHost(root)
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const fake = fakeContext()
  const workspaces = new Map()
  let sessions = 0
  root.provide('events', fake.events)
  root.provide('tools', fake.tools)
  root.provide('systemPrompt', fake.systemPrompt)
  root.provide('connection', fake.connection)
  root.provide('llm', {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-v4-flash' }],
    resolveModelInfo: async () => ({}),
  })
  root.provide('workspaceRegistry', {
    get: id => workspaces.get(id),
    resolveByPath: async () => undefined,
    create: async (path) => {
      const workspace = { id: `w${workspaces.size + 1}`, path }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    archiveSession: async () => {},
  })
  root.provide('sessionController', {
    create: async () => ({ sessionId: `s${++sessions}` }),
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup() {} } }),
    selectModel: async () => {},
    prompt: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('sessions', { flush: async () => {} })

  let rt
  await root.plugin((sub) => {
    rt = createRuntime(sub, { home })
  })
  await tick()

  const gateway = root.typertGateway
  assert.equal(gateway.claimsEndpoint('dsBot/call'), true)
  assert.equal(gateway.claimsEndpoint('dsBot/feed'), true)

  const feedControl = new AbortController()
  const wireStream = await gateway.openWireStream(
    'dsBot/feed',
    { args: {} },
    undefined,
    ownerPeer(),
    feedControl.signal,
    feedControl,
    undefined,
  )
  const iterator = wireStream[Symbol.asyncIterator]()
  const helloEvent = await iterator.next()
  assert.equal(helloEvent.value.event, 'hello')
  assert.equal(helloEvent.value.data.api, API_VERSION)

  const rpcHello = await gateway.dispatchRpc(
    'dsBot/call',
    { args: { endpoint: 'hello', payload: { api: [1], client: 'dsh-go' } } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(rpcHello.ok, true)
  assert.equal(rpcHello.value.ok, true)
  assert.equal(rpcHello.value.value.capabilities.includes('rpc'), true)
  assert.deepEqual(rpcHello.value.value.rpc, { call: 'dsBot/call', feed: 'dsBot/feed' })

  const rpcState = await gateway.dispatchRpc(
    'dsBot/call',
    { args: { endpoint: 'state', payload: { avatars: 'ref', locale: 'zh-CN' } } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(rpcState.ok, true)
  assert.equal(rpcState.value.ok, true)
  assert.ok(rpcState.value.value.bots.length >= 1)

  // Updating a Bot saves state and emits a `revision` frame over `dsBot/feed`.
  const beforeUpdateRev = rt.state.revision
  const botId = rpcState.value.value.bots[0].id
  const updated = await gateway.dispatchRpc(
    'dsBot/call',
    { args: { endpoint: 'update-bot', payload: { id: botId, name: 'Remote Chief' } } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(updated.ok, true)
  assert.equal(updated.value.ok, true)
  const targetRev = rt.state.revision
  assert.ok(targetRev > beforeUpdateRev)

  // Drain any earlier startup/bootstrap revision frames until `update-bot`'s revision arrives.
  let revEvent
  for (let i = 0; i < 10; i += 1) {
    const next = await iterator.next()
    if (next.value.event === 'revision' && next.value.data.revision >= targetRev) {
      revEvent = next
      break
    }
  }
  assert.ok(revEvent)
  assert.equal(revEvent.value.event, 'revision')
  assert.ok(revEvent.value.data.revision > helloEvent.value.data.revision)

  const unknownEndpoint = await gateway.dispatchRpc(
    'dsBot/call',
    { args: { endpoint: 'no-such-endpoint', payload: {} } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(unknownEndpoint.ok, true)
  assert.equal(unknownEndpoint.value.ok, false)
  assert.equal(unknownEndpoint.value.error.code, 'bot/not-found')

  feedControl.abort()
  await assert.rejects(() => iterator.next(), error => error?.code === 'gateway/cancelled')
  await rt.dispose?.()
})

test('plugin entry tracks late TypertGatewayService mount and disposal in hello', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-entry-'))
  const root = new Context()
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const fake = fakeContext()
  const routes = {}
  const register = fake.connection.fetch.register
  fake.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  root.provide('events', fake.events)
  root.provide('tools', fake.tools)
  root.provide('systemPrompt', fake.systemPrompt)
  root.provide('connection', fake.connection)
  root.provide('llm', { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1', path: home }), archiveSession: async () => {} })
  root.provide('sessionController', { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id, seq: 1 }, followup() {} } }), selectModel: async () => {}, prompt: async () => {}, page: async () => ({ records: [], hasMore: false }) })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('sessions', { flush: async () => {} })
  await root.plugin(pluginEntry, { home })
  for (let i = 0; i < 20 && !routes['/api/bot']; i += 1) await tick()

  const callHttp = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  // Before typertGateway exists, HTTP hello omits `rpc`.
  const before = await callHttp('hello', { api: [1] })
  assert.equal(before.value.capabilities.includes('rpc'), false)
  assert.equal(before.value.rpc, undefined)

  // Late mount of typertGateway registers dsBot Remote methods and turns `rpc` on.
  const gwFork = await root.plugin(startGatewayHost)
  for (let i = 0; i < 20 && !root.typertGateway?.claimsEndpoint('dsBot/call'); i += 1) await tick()

  assert.equal(root.typertGateway.claimsEndpoint('dsBot/call'), true)
  assert.equal(root.typertGateway.claimsEndpoint('dsBot/feed'), true)

  const afterHttp = await callHttp('hello', { api: [1] })
  assert.equal(afterHttp.value.capabilities.includes('rpc'), true)
  assert.deepEqual(afterHttp.value.rpc, { call: 'dsBot/call', feed: 'dsBot/feed' })

  const reply = await root.typertGateway.dispatchRpc(
    'dsBot/call',
    { args: { endpoint: 'hello', payload: { api: [1] } } },
    new AbortController().signal,
    ownerPeer(),
  )
  assert.equal(reply.ok, true)
  assert.equal(reply.value.ok, true)
  assert.deepEqual(reply.value.value.rpc, { call: 'dsBot/call', feed: 'dsBot/feed' })

  // Disposing typertGateway turns `rpc` back off on HTTP hello.
  await gwFork.dispose()
  await tick()
  const disposed = await callHttp('hello', { api: [1] })
  assert.equal(disposed.value.capabilities.includes('rpc'), false)
  assert.equal(disposed.value.rpc, undefined)
})
