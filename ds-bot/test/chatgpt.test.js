import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshLlm from '@deepseek-ai/dsh-llm'
import * as dshPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { install as installChatGPT, appChatGPTRequest } from '../src/host/chatgpt.js'
import { install as installModels } from '../src/host/models.js'
import { install as installProviders } from '../src/host/providers.js'
import { install as installChannel } from '../src/host/channel.js'
import { createChatGPTRelay } from '../../app/src/chatgpt-relay.mjs'

async function fixture(t, { app = true, previous, status = { state: 'connected', account: { email: 'person@example.test' } }, models = [{ id: 'model-z', name: 'Z' }], modelError } = {}) {
  const effects = []
  const disposers = []
  const ipc = new EventEmitter()
  const calls = []
  const keys = {}
  const routes = { openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'api-model' }], compat: { supportsDeveloperRole: false } }, ...(previous ? { 'openai-chatgpt': previous } : {}) }
  let revision = 0
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: structuredClone(routes) }, user: { providers: structuredClone(routes) } }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      for (const op of ops) {
        assert.equal(op.path[0], 'providers')
        if (op.path.length === 2) {
          if (op.op === 'unset') delete routes[op.path[1]]
          else { assert.ok(op.value.models.length); routes[op.path[1]] = structuredClone(op.value) }
        } else routes[op.path[1]][op.path[2]] = structuredClone(op.value)
      }
      revision++
    },
  }
  const credentials = {
    set: async (ref, value) => { keys[ref] = value }, unset: async ref => { delete keys[ref] },
    describe: async ref => ({ configured: !!keys[ref], writable: true }),
  }
  const ctx = {
    get: name => ({ settings, credentials })[name],
    on: () => () => {}, effect: execute => { effects.push(execute) }, logger: { warn() {}, info() {} },
    connection: { fetch: { register: () => () => {} } },
    llm: { listConfigurableProviders: () => Object.entries(routes).map(([provider, profile]) => ({
      provider, displayName: profile.displayName ?? provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: true,
    })) },
  }
  const rt = { ctx, state: { bots: {}, rooms: {}, prefs: {} }, dropCatalog() {}, cachedCatalog: () => [], cachedDefault: () => undefined,
    catalog: async () => Object.entries(routes).flatMap(([provider, profile]) => profile.models.map(model => ({ ...model, provider, ref: `${provider}/${model.id}` }))),
    refresh: async () => {}, load: async () => {}, readOnly: () => undefined, phoneServe() {}, warn() {},
  }
  installProviders(rt)
  installChannel(rt)
  const request = async (method, body) => {
    calls.push({ method, body })
    if (method === 'chatgpt:status' || method === 'chatgpt:cancel') return status
    if (method === 'chatgpt:sign-in') return status = { state: 'connected', account: { email: 'person@example.test' } }
    if (method === 'chatgpt:sign-out') return status = { state: 'signed-out', account: status.account, remoteRevocationConfirmed: false }
    if (method === 'chatgpt:route') return { baseURL: 'http://127.0.0.1:12345/v1', secret: 'fake-relay-key' }
    if (method === 'chatgpt:models') { if (modelError) throw new Error('Models unavailable'); return models }
    throw new Error('Unexpected request')
  }
  installChatGPT(rt, { env: app ? { DS_BOT_APP: '1' } : {}, ipc, request })
  const start = async () => {
    for (const effect of effects.splice(0)) { const dispose = effect(); if (dispose) disposers.push(dispose) }
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
  }
  t.after(() => { for (const dispose of disposers) dispose() })
  return { rt, keys, calls, routes, start, ipc, post: (method, body) => rt.channelCall(method, body) }
}

test('all ChatGPT channel methods are unsupported outside the desktop app without IPC or route writes', async t => {
  const f = await fixture(t, { app: false })
  await f.start()
  for (const method of ['chatgpt', 'chatgpt-sign-in', 'chatgpt-cancel', 'chatgpt-sign-out', 'chatgpt-models']) {
    assert.deepEqual(await f.post(method), { ok: true, value: { state: 'unsupported' } })
  }
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.keys, {})
  assert.equal(f.routes['openai-chatgpt'], undefined)
})

test('startup creates a distinct plan route with local credentials, models and provider marker', async t => {
  const f = await fixture(t)
  await f.start()
  assert.deepEqual(f.routes['openai-chatgpt'], { displayName: 'ChatGPT (plan)', api: 'openai-responses',
    baseURL: 'http://127.0.0.1:12345/v1', apiKeyEnv: 'OPENAI_CHATGPT_API_KEY',
    models: [{ id: 'model-z', name: 'Z' }], compat: { supportsDeveloperRole: true },
  })
  assert.equal(f.keys.OPENAI_CHATGPT_API_KEY, 'fake-relay-key')
  assert.deepEqual(f.routes.openai, { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'api-model' }], compat: { supportsDeveloperRole: false } })
  const row = (await f.rt.providersView()).providers.find(item => item.id === 'openai-chatgpt')
  assert.equal(row.auth, 'chatgpt')
  assert.equal(row.key.writable, false)
  assert.equal(row.removable, false)
  assert.ok(!JSON.stringify(await f.post('providers')).includes('fake-relay-key'))
  assert.ok((await f.post('provider-key', { provider: 'openai-chatgpt', value: 'manual' })).error.message.includes('ChatGPT sign-in'))
  assert.ok((await f.post('provider-key', { provider: 'openai-chatgpt', value: null })).error.message.includes('ChatGPT sign-in'))
  assert.ok((await f.post('provider-remove', { provider: 'openai-chatgpt' })).error.message.includes('ChatGPT sign-out'))
  assert.equal(f.keys.OPENAI_CHATGPT_API_KEY, 'fake-relay-key')
})

test('sign-in consent, status, cancel, models refresh and sign-out are routed through IPC', async t => {
  const f = await fixture(t, { status: { state: 'signed-out' }, models: [{ id: 'model-a', name: 'A' }] })
  await f.start()
  assert.equal(f.routes['openai-chatgpt'], undefined)
  assert.deepEqual(await f.post('chatgpt'), { ok: true, value: { state: 'signed-out' } })
  assert.equal((await f.post('chatgpt-sign-in', { consent: true })).value.state, 'connected')
  assert.deepEqual(f.calls.find(item => item.method === 'chatgpt:sign-in').body, { consent: true })
  assert.deepEqual((await f.post('chatgpt-models')).value, [{ id: 'model-a', name: 'A' }])
  assert.equal((await f.post('chatgpt-cancel')).value.state, 'connected')
  const signedOut = await f.post('chatgpt-sign-out')
  assert.equal(signedOut.value.remoteRevocationConfirmed, false)
  assert.equal(signedOut.value.state, 'signed-out')
  assert.equal(f.routes['openai-chatgpt'].models[0].id, 'model-a')
  assert.ok(!JSON.stringify(signedOut).includes('fake-relay-key'))
})

test('each launch updates the secret and relay endpoint even when model discovery fails', async t => {
  const f = await fixture(t, { previous: { models: [{ id: 'old-model' }], baseURL: 'http://127.0.0.1:1/v1', api: 'openai-responses' }, modelError: true })
  await f.start()
  assert.equal(f.routes['openai-chatgpt'].baseURL, 'http://127.0.0.1:12345/v1')
  assert.equal(f.keys.OPENAI_CHATGPT_API_KEY, 'fake-relay-key')
  assert.equal(f.routes['openai-chatgpt'].models[0].id, 'old-model')
  assert.equal((await f.post('chatgpt-models')).ok, false)
})

test('signed-out accounts keep their route, while never-signed-in installations remove it', async t => {
  for (const account of [undefined, { email: 'person@example.test' }]) {
    const f = await fixture(t, { previous: { models: [{ id: 'old-model' }], api: 'openai-responses' }, status: { state: 'signed-out', ...(account ? { account } : {}) } })
    await f.start()
    assert.equal(!!f.routes['openai-chatgpt'], !!account)
  }
})

test('empty model results never create invalid placeholder routes or erase existing models', async t => {
  for (const previous of [undefined, { models: [{ id: 'old-model' }], api: 'openai-responses' }]) {
    const f = await fixture(t, { previous, models: [] })
    await f.start()
    assert.equal(!!f.routes['openai-chatgpt'], !!previous)
    if (previous) assert.equal(f.routes['openai-chatgpt'].models[0].id, 'old-model')
    assert.deepEqual((await f.post('chatgpt-models')).value, [])
  }
})

test('main-process status pushes are accepted and listeners are disposed', async t => {
  const f = await fixture(t, { status: { state: 'unsupported' } })
  await f.start()
  f.ipc.emit('message', { type: 'chatgpt:changed', status: { state: 'signing-in' } })
  assert.deepEqual(f.rt.chatgptStatus, { state: 'signing-in' })
})

test('IPC requests correlate replies and use fixed errors rather than remote diagnostics', async () => {
  const ipc = new EventEmitter()
  ipc.send = (message, callback) => {
    callback()
    ipc.emit('message', { type: 'ds-bot:chatgpt-response', id: 'other', result: 'wrong' })
    ipc.emit('message', { type: 'ds-bot:chatgpt-response', id: message.id, result: { state: 'connected' } })
  }
  assert.deepEqual(await appChatGPTRequest('chatgpt:status', undefined, ipc), { state: 'connected' })
  assert.equal(ipc.listenerCount('message'), 0)
  ipc.send = message => ipc.emit('message', { type: 'ds-bot:chatgpt-response', id: message.id, error: { state: 'needs-sign-in', message: 'synthetic-secret' } })
  await assert.rejects(appChatGPTRequest('chatgpt:sign-in', {}, ipc), error => error.state === 'needs-sign-in' && !error.message.includes('synthetic-secret'))
  ipc.send = () => { throw new Error('synthetic-secret') }
  await assert.rejects(appChatGPTRequest('chatgpt:status', {}, ipc), /Check the connection status/)
  assert.equal(ipc.listenerCount('message'), 0)
})

test('ChatGPT models expose selectable reasoning efforts through real DSH pi-ai and relay, preserving Default semantics and prompt cache prefix', async t => {
  const requests = []
  let nextResponse
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const custom = nextResponse
    nextResponse = undefined
    if (custom) {
      res.end(custom.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      return
    }
    res.end([
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}`,
      '',
      '',
    ].join('\n'))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  const relay = await createChatGPTRelay({
    signIn: {
      status: () => ({ state: 'connected' }),
      getAccessToken: async () => 'synthetic-access',
      refresh: async () => {},
      listModels: async () => [],
    },
    responsesUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
  })
  t.after(() => relay.close())
  const { baseURL, secret } = relay.route()

  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.plugin(dshLlm.LlmRuntime)
  const keys = { OPENAI_CHATGPT_API_KEY: secret }
  const routes = {
    'openai-chatgpt': {
      displayName: 'ChatGPT (plan)', api: 'openai-responses', baseURL,
      apiKeyEnv: 'OPENAI_CHATGPT_API_KEY', models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
      compat: { supportsDeveloperRole: true },
    },
  }
  let revision = 0
  const piAiFiber = ctx.plugin(dshPiAi, { providers: structuredClone(routes) })
  ctx.provide('credentials', {
    resolve: async ref => (ref in keys ? { value: keys[ref] } : undefined),
    set: async (ref, value) => { keys[ref] = value },
    unset: async ref => { delete keys[ref] },
    describe: async ref => ({ configured: !!keys[ref], writable: true }),
  })
  ctx.provide('settings', {
    configure: () => () => {},
    describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: structuredClone(routes) }, user: { providers: structuredClone(routes) } }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      const candidate = structuredClone(routes)
      for (const op of ops) {
        if (op.path.length === 2) candidate[op.path[1]] = structuredClone(op.value)
        else candidate[op.path[1]][op.path[2]] = structuredClone(op.value)
      }
      dshPiAi.Config({ providers: structuredClone(candidate) })
      await piAiFiber.update({ providers: structuredClone(candidate) })
      for (const key of Object.keys(routes)) delete routes[key]
      Object.assign(routes, candidate)
      revision++
    },
  })
  ctx.provide('connection', { fetch: { register: () => () => {} } })
  await new Promise(resolve => setImmediate(resolve))

  const ipc = new EventEmitter()
  const rt = {
    ctx, state: { bots: { b1: { id: 'b1', model: 'openai-chatgpt/gpt-5.5' } }, rooms: {}, prefs: {} },
    refresh: async () => {}, load: async () => {}, readOnly: () => undefined, phoneServe() {}, warn() {},
  }
  installModels(rt)
  installProviders(rt)
  let servedModels = [{ id: 'gpt-5.5', name: 'GPT-5.5', reasoningEfforts: false }]
  const request = async (method) => {
    if (method === 'chatgpt:status') return { state: 'connected', account: { email: 'person@example.test' } }
    if (method === 'chatgpt:route') return { baseURL, secret }
    if (method === 'chatgpt:models') return servedModels
    throw new Error('Unexpected request')
  }
  installChatGPT(rt, { env: { DS_BOT_APP: '1' }, ipc, request })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  // While reasoning is disabled, reasoningOf caches undefined.
  assert.equal(await rt.reasoningOf('openai-chatgpt/gpt-5.5'), undefined)

  // Refresh with supported reasoning efforts from ChatGPT sign-in:
  // - gpt-5.5 defaults to medium (so off is omitted and Default keeps upstream default)
  // - gpt-5.4 defaults to none (so off: 'none' is offered)
  // - gpt-6.2-sol supports low..max
  // - gpt-4o is non-reasoning
  servedModels = [
    {
      id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, inputModalities: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    },
    {
      id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, inputModalities: ['text', 'image'],
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    },
    {
      id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', contextWindow: 272000, inputModalities: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    },
    { id: 'gpt-4o', name: 'GPT-4o', reasoningEfforts: false },
  ]
  const refreshed = await rt.chatgptModels()
  assert.equal(refreshed.length, 4)
  assert.equal(routes['openai-chatgpt'].models[0].inputModalities, undefined)
  assert.deepEqual(routes['openai-chatgpt'].models[0].input, ['text', 'image'])

  // dropCatalog() cleared reasoningCache, so efforts are immediately available.
  assert.deepEqual((await rt.reasoningOf('openai-chatgpt/gpt-5.5')).efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual((await rt.reasoningOf('openai-chatgpt/gpt-5.4')).efforts.map(e => e.id), ['off', 'low', 'medium', 'high', 'xhigh'])
  assert.deepEqual((await rt.reasoningOf('openai-chatgpt/gpt-6.2-sol')).efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(await rt.reasoningOf('openai-chatgpt/gpt-4o'), undefined)
  assert.equal(await rt.resolveEffort('openai-chatgpt/gpt-5.4', 'xhigh'), 'xhigh')
  assert.equal(await rt.desiredEffort({ effort: 'max' }, 'openai-chatgpt/gpt-6.2-sol'), 'max')
  assert.equal(await rt.desiredEffort({ effort: 'off' }, 'openai-chatgpt/gpt-5.5'), undefined)
  const catalog = await rt.catalog({ fresh: true })
  const used = catalog.find(entry => entry.ref === 'openai-chatgpt/gpt-5.5')
  assert.deepEqual(used.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])

  const runTurn = async (model, reasoningEffort, extra = {}) => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-chatgpt',
      model,
      system: 'Be brief.',
      sessionId: 'sess-chatgpt-cache-1',
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages: [dshLlm.createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      ...extra,
    })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish)
    return { chunks, finish }
  }

  // Default (unset effort) on gpt-5.5 omits `reasoning` instead of disabling thinking,
  // requests encrypted reasoning for stateless multi-turn cache continuity, keeps the
  // system prompt in `input[0]` as `developer` (no uncached top-level `instructions`),
  // and forwards session affinity headers + prompt_cache_key.
  const planRef = 'openai-chatgpt/gpt-5.5'
  assert.equal((await rt.botReasoningOf(planRef)).defaultEffort, undefined)
  await runTurn('gpt-5.5', await rt.desiredEffort({}, planRef))
  assert.equal(requests.at(-1).body.reasoning, undefined)
  assert.deepEqual(requests.at(-1).body.include, ['reasoning.encrypted_content'])
  assert.equal(requests.at(-1).body.instructions, undefined)
  assert.equal(requests.at(-1).body.input[0].role, 'developer')
  assert.equal(requests.at(-1).body.prompt_cache_key, 'sess-chatgpt-cache-1')
  assert.equal(requests.at(-1).headers['session-id'], 'sess-chatgpt-cache-1')
  assert.equal(requests.at(-1).headers['x-client-request-id'], 'sess-chatgpt-cache-1')

  // Explicit 'xhigh' sends reasoning.effort + reasoning.encrypted_content through the relay.
  await runTurn('gpt-6.2-sol', 'xhigh')
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'xhigh', summary: 'auto' })
  assert.deepEqual(requests.at(-1).body.include, ['reasoning.encrypted_content'])

  // Model with default_reasoning_level === 'none' sends effort='none' for explicit 'off'
  // and omits reasoning.encrypted_content.
  await runTurn('gpt-5.4', 'off')
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'none' })
  assert.equal(requests.at(-1).body.include, undefined)

  // Non-reasoning model (gpt-4o) keeps system prompt in `input[0]` as `developer`
  // (never hoisted to uncached top-level `instructions`) and never adds `include`.
  await runTurn('gpt-4o', undefined)
  assert.equal(requests.at(-1).body.instructions, undefined)
  assert.equal(requests.at(-1).body.input[0].role, 'developer')
  assert.equal(requests.at(-1).body.include, undefined)

  // Multi-step tool-call replay on Default effort (gpt-6.2-sol): encrypted reasoning
  // returned in step 1 is replayed verbatim in step 2 alongside the namespaced tool call,
  // with byte-identical prefix, tools, prompt_cache_key, and session-id headers.
  const toolDef = { name: 'get_weather', description: 'Look up weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
  const reasoningItem = { type: 'reasoning', id: 'rs_step1', summary: [{ type: 'summary_text', text: 'Checking weather.' }], encrypted_content: 'enc_blob_step1' }
  const callItem = { type: 'function_call', id: 'fc_step1', call_id: 'call_step1', name: 'get_weather', namespace: 'ds_bot', arguments: '{"city":"Tokyo"}' }
  nextResponse = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_step1', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    { type: 'response.output_item.added', output_index: 1, item: { ...callItem, arguments: '' } },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_step1', arguments: callItem.arguments },
    { type: 'response.output_item.done', output_index: 1, item: callItem },
    { type: 'response.completed', response: { id: 'resp_step1', status: 'completed', output: [reasoningItem, callItem], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } },
  ]
  const userMsg = dshLlm.createUserMessage({ content: [{ type: 'text', text: 'Weather in Tokyo?' }], source: { kind: 'user' } })
  const step1 = await runTurn('gpt-6.2-sol', undefined, { tools: [toolDef], messages: [userMsg] })
  const step1Req = requests.at(-1)
  assert.deepEqual(step1Req.body.include, ['reasoning.encrypted_content'])
  const blocks = step1.chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  const toolCallBlock = blocks.find(block => block.type === 'tool-call')
  assert.ok(toolCallBlock)
  const assistantMsg = dshLlm.createAssistantMessage({
    content: blocks,
    source: { provider: 'openai-chatgpt', model: 'gpt-6.2-sol', replayState: step1.finish.replayState },
  })
  const toolResultMsg = dshLlm.createToolResultMessage({
    callId: toolCallBlock.id,
    content: [{ type: 'text', text: '22C sunny' }],
    isError: false,
  })
  await runTurn('gpt-6.2-sol', undefined, { tools: [toolDef], messages: [userMsg, assistantMsg, toolResultMsg] })
  const step2Req = requests.at(-1)
  assert.deepEqual(step2Req.body.input.slice(0, 2), step1Req.body.input)
  assert.deepEqual(step2Req.body.tools, step1Req.body.tools)
  assert.equal(step2Req.body.instructions, undefined)
  assert.equal(step2Req.body.prompt_cache_key, step1Req.body.prompt_cache_key)
  assert.equal(step2Req.headers['session-id'], step1Req.headers['session-id'])
  assert.equal(step2Req.headers['x-client-request-id'], step1Req.headers['x-client-request-id'])
  assert.deepEqual(step2Req.body.input[2], reasoningItem)
  assert.deepEqual(step2Req.body.input[3], callItem)
  assert.deepEqual(step2Req.body.input[4], { type: 'function_call_output', call_id: 'call_step1', output: '22C sunny' })
})

test('first ChatGPT sign-in falls back for omitted reasoning levels with or without an openai route and ignores custom openai gateways', async t => {
  // 1. Pure ChatGPT plan user with no `openai` route at all: family fallback applies to
  // known reasoning models and skips chat-only models.
  const pure = await fixture(t, {
    status: { state: 'signed-out' },
    models: [
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', contextWindow: 272000, inputModalities: ['text', 'image'] },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-5-chat-latest', name: 'GPT-5 Chat' },
    ],
  })
  await pure.start()
  assert.equal((await pure.post('chatgpt-sign-in')).value.state, 'connected')
  assert.deepEqual(pure.routes['openai-chatgpt'].models, [
    { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', contextWindow: 272000, input: ['text', 'image'], reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
    { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', reasoningEfforts: { medium: 'medium', high: 'high', xhigh: 'xhigh' } },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-5-chat-latest', name: 'GPT-5 Chat' },
  ])

  // 2. Official `openai` route (no custom baseURL) is consulted via resolveModelInfo, omitting 'off'.
  const withOpenAI = await fixture(t, {
    status: { state: 'signed-out' },
    models: [{ id: 'custom-future-model', name: 'Future' }],
  })
  withOpenAI.rt.ctx.llm.listProviders = () => [{ id: 'openai', name: 'OpenAI' }]
  withOpenAI.rt.ctx.llm.resolveModelInfo = async (provider, model) => (provider === 'openai' && model === 'custom-future-model'
    ? { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    : undefined)
  await withOpenAI.start()
  assert.equal((await withOpenAI.post('chatgpt-sign-in')).value.state, 'connected')
  assert.deepEqual(withOpenAI.routes['openai-chatgpt'].models, [
    { id: 'custom-future-model', name: 'Future', reasoningEfforts: { low: 'low', high: 'high' } },
  ])

  // 3. `openai` route repointed to a custom gateway baseURL is NOT consulted.
  const repointed = await fixture(t, {
    status: { state: 'signed-out' },
    models: [{ id: 'custom-future-model', name: 'Future' }],
  })
  repointed.routes.openai.baseURL = 'https://third-party-gateway.example/v1'
  repointed.rt.ctx.llm.listProviders = () => [{ id: 'openai', name: 'OpenAI' }]
  let called = false
  repointed.rt.ctx.llm.resolveModelInfo = async () => { called = true; return { reasoning: { efforts: [{ id: 'high', name: 'High' }] } } }
  await repointed.start()
  assert.equal((await repointed.post('chatgpt-sign-in')).value.state, 'connected')
  assert.equal(called, false)
  assert.deepEqual(repointed.routes['openai-chatgpt'].models, [{ id: 'custom-future-model', name: 'Future' }])
})
