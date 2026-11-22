import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { install as installChatGPT, appChatGPTRequest } from '../src/host/chatgpt.js'
import { install as installProviders } from '../src/host/providers.js'
import { install as installChannel } from '../src/host/channel.js'

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
