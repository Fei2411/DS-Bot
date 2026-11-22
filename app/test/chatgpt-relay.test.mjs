import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { createChatGPTRelay, previewRequest } from '../src/chatgpt-relay.mjs'
import { createChatGPTBridge } from '../src/chatgpt-bridge.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Streaming deadline exceeded')), 2000); timer.unref() })])

async function fixture(t, behavior = {}) {
  const requests = []
  let refreshes = 0
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) })
    if (behavior.handle) { behavior.handle(req, res, requests.length); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: synthetic-event\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const signIn = {
    status: () => ({ state: 'connected' }),
    getAccessToken: async () => { if (behavior.error) throw behavior.error; return refreshes ? 'synthetic-renewed' : 'synthetic-access' },
    refresh: async () => { refreshes++; if (behavior.refreshError) throw behavior.refreshError },
    listModels: async () => { if (behavior.error) throw behavior.error; return behavior.models ?? [{ id: 'model-z', name: 'Z' }, { id: 'model-a', name: 'A' }] },
  }
  const relay = await createChatGPTRelay({ signIn, maxBytes: behavior.maxBytes,
    responsesUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    fetch: (url, init) => { assert.equal(init.redirect, 'manual'); return fetch(url, init) },
  })
  t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  const { baseURL, secret } = relay.route()
  const post = (body = { input: [] }, options = {}) => fetch(`${baseURL}/responses`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body), ...options })
  return { relay, signIn, baseURL, secret, post, requests, get refreshes() { return refreshes } }
}

test('relay requires its per-launch bearer and exact Host and exposes only the two endpoints', async t => {
  const f = await fixture(t)
  for (const authorization of [undefined, 'Bearer wrong']) {
    const response = await fetch(`${f.baseURL}/models`, { headers: authorization ? { authorization } : {} })
    assert.equal(response.status, 401)
  }
  const status = await new Promise((resolve, reject) => {
    const req = request(`${f.baseURL}/models`, { headers: { host: 'localhost', authorization: `Bearer ${f.secret}` } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(status, 401)
  for (const path of ['/unknown', '/models?extra=1']) {
    assert.equal((await fetch(`${f.baseURL}${path}`, { headers: { authorization: `Bearer ${f.secret}` } })).status, 404)
  }
  assert.equal((await fetch(`${f.baseURL}/responses`, { headers: { authorization: `Bearer ${f.secret}` } })).status, 404)
  const other = await fixture(t)
  assert.notEqual(f.secret, other.secret)
  assert.equal(f.requests.length, 0)
})

test('relay lists models in OpenAI discovery format, preserving order and empty lists', async t => {
  const f = await fixture(t)
  assert.deepEqual(await (await fetch(`${f.baseURL}/models`, { headers: { authorization: `Bearer ${f.secret}` } })).json(), {
    object: 'list', data: [{ id: 'model-z', object: 'model', owned_by: 'openai' }, { id: 'model-a', object: 'model', owned_by: 'openai' }],
  })
  const empty = await fixture(t, { models: [] })
  assert.deepEqual(await (await fetch(`${empty.baseURL}/models`, { headers: { authorization: `Bearer ${empty.secret}` } })).json(), { object: 'list', data: [] })
})

test('relay applies preview restrictions, moves only system messages and namespaces tools without changing developer messages', async t => {
  const f = await fixture(t)
  const omit = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']
  const developer = { type: 'message', role: 'developer', content: 'developer rules' }
  const tools = [{ type: 'function', name: 'tool', parameters: {} }]
  const response = await f.post({ ...Object.fromEntries(omit.map(key => [key, 'remove'])), store: true, stream: false,
    instructions: 'existing', model: 'model-z', tools,
    input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system one' }] }, { role: 'system', content: 'system two' }, developer],
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'data: synthetic-event\n\ndata: [DONE]\n\n')
  assert.equal(f.requests[0].headers.authorization, 'Bearer synthetic-access')
  assert.deepEqual(f.requests[0].body, { store: false, stream: true, model: 'model-z', instructions: 'existing\n\nsystem one\n\nsystem two', tools: [{ type: 'namespace', name: 'ds_bot', description: 'DS Bot tools.', tools }], input: [developer] })
  await (await f.post({ input: 'hello' })).text()
  assert.deepEqual(f.requests[1].body.input, [{ role: 'user', content: 'hello' }])
})

// Wire shapes: https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces
// Call/output fields: https://developers.openai.com/api/reference/resources/responses/methods/create
const functionTool = { type: 'function', name: 'get_weather', description: 'Look up weather.', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false }, strict: true }
const customTool = { type: 'custom', name: 'run_query', format: { type: 'text' } }
const namespace = tools => ({ type: 'namespace', name: 'ds_bot', description: 'DS Bot tools.', tools })

test('namespace conversion preserves schemas, hosted tools, existing namespaces and call/output correlation', () => {
  const call = { type: 'function_call', id: 'fc_weather', call_id: 'call_weather', name: 'get_weather', arguments: '{"location":"Paris"}' }
  const output = { type: 'function_call_output', call_id: call.call_id, output: '{"temperature":25}' }
  const custom = { type: 'custom_tool_call', id: 'ctc_query', call_id: 'call_query', name: 'run_query', input: 'select 1' }
  const customOutput = { type: 'custom_tool_call_output', call_id: custom.call_id, output: '1' }
  const native = { type: 'namespace', name: 'crm', description: 'Customer tools.', tools: [functionTool] }
  const hosted = { type: 'web_search' }
  const body = { tools: [functionTool, hosted, customTool, native], input: [call, output, custom, customOutput, { ...call, namespace: 'crm' }], tool_choice: { type: 'function', name: 'get_weather' } }
  const before = structuredClone(body)
  const converted = previewRequest(body)
  assert.deepEqual(converted.tools, [hosted, native, namespace([functionTool, customTool])])
  assert.deepEqual(converted.input, [{ ...call, namespace: 'ds_bot' }, output, { ...custom, namespace: 'ds_bot' }, customOutput, { ...call, namespace: 'crm' }])
  assert.deepEqual(converted.tool_choice, body.tool_choice)
  assert.deepEqual(body, before)
  assert.deepEqual(previewRequest(converted), converted)
  assert.deepEqual(previewRequest({ input: [call], tools: [] }).input, [{ ...call, namespace: 'ds_bot' }])
  assert.deepEqual(previewRequest({ input: [], tools: [namespace([functionTool]), customTool] }).tools, [namespace([functionTool, customTool])])
})

for (const choice of ['auto', 'none', 'required', { type: 'custom', name: 'run_query' }, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'get_weather' }] }]) {
  test(`namespacing keeps documented tool_choice ${JSON.stringify(choice)} unchanged`, () => {
    assert.deepEqual(previewRequest({ input: [], tools: [functionTool, customTool], tool_choice: choice }).tool_choice, choice)
  })
}

for (const tools of [undefined, []]) test(`no tools produces no empty namespace (${JSON.stringify(tools)})`, () => {
  const body = { input: [], ...(tools ? { tools } : {}) }
  assert.deepEqual(previewRequest(body), { ...body, store: false, stream: true })
})

test('invalid tool containers are rejected instead of sent upstream', () => {
  for (const tools of [null, {}, 'tools', [customTool, { type: 'namespace', name: 'ds_bot' }]]) assert.throws(() => previewRequest({ input: [], tools }), /Invalid ChatGPT request/)
})

for (const newline of ['\n', '\r\n', '\r']) test(`documented tool events survive fragmented UTF-8 SSE and replay (${JSON.stringify(newline)})`, async t => {
  const call = { type: 'function_call', id: 'fc_weather', call_id: 'call_weather', name: 'get_weather', arguments: '{"location":"北京"}', namespace: 'ds_bot' }
  const custom = { type: 'custom_tool_call', id: 'ctc_query', call_id: 'call_query', name: 'run_query', input: 'select 1', namespace: 'ds_bot' }
  const plain = ({ namespace: _namespace, ...item }) => item
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' }, sequence_number: 0 },
    { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments, sequence_number: 1 },
    { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments, sequence_number: 2 },
    { type: 'response.output_item.done', output_index: 0, item: call, sequence_number: 3 },
    { type: 'response.output_item.added', output_index: 1, item: custom, sequence_number: 4 },
    { type: 'response.output_item.done', output_index: 2, item: { ...call, namespace: 'crm' }, sequence_number: 5 },
    { type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: '{"namespace":"ds_bot"}', sequence_number: 6 },
    ...['completed', 'incomplete', 'failed'].map((state, index) => ({ type: `response.${state}`, sequence_number: index + 7, response: { output: [call, custom], tools: [namespace([functionTool, customTool])], tool_choice: { type: 'function', name: 'get_weather' }, error: state === 'failed' ? { code: 'subscription_sharing_usage_limit_exceeded' } : null } })),
  ]
  const frame = event => `: keepalive${newline}id: ${event.sequence_number}${newline}event: ${event.type}${newline}` + JSON.stringify(event, null, 2).split('\n').map(line => `data: ${line}`).join(newline) + newline + newline
  const f = await fixture(t, { handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const bytes = Buffer.from(events.map(frame).join('') + `data: [DONE]${newline}${newline}`)
    for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await tick() }
    res.end()
  } })
  const response = await f.post({ input: [], tools: [functionTool, customTool] })
  const text = await response.text()
  const frames = text.split(newline + newline).filter(Boolean)
  assert.equal(frames.at(-1), 'data: [DONE]')
  const received = frames.slice(0, -1).map(part => JSON.parse(part.split(newline).filter(line => line.startsWith('data:')).map(line => line.slice(6)).join('\n')))
  assert.deepEqual(received, events.map(event => ({ ...event,
    ...(event.item ? { item: event.item.namespace === 'ds_bot' ? plain(event.item) : event.item } : {}),
    ...(event.response ? { response: { ...event.response, output: [plain(call), plain(custom)], tools: [functionTool, customTool] } } : {}),
  })))
  assert.ok(text.includes(`: keepalive${newline}id: 0${newline}event: response.output_item.added`))
  await (await f.post({ input: [received[3].item, { type: 'function_call_output', call_id: call.call_id, output: '25' }], tools: [functionTool] })).text()
  assert.deepEqual(f.requests[1].body.input, [call, { type: 'function_call_output', call_id: call.call_id, output: '25' }])
})

test('a converted function call reaches DSH before upstream completion', async t => {
  let finish
  const event = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_weather', call_id: 'call_weather', name: 'get_weather', namespace: 'ds_bot', arguments: '' } }
  const f = await fixture(t, { handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    finish = () => res.end('data: [DONE]\n\n')
  } })
  const reader = (await bounded(f.post({ input: [], tools: [functionTool] }))).body.getReader()
  const first = new TextDecoder().decode((await bounded(reader.read())).value)
  assert.deepEqual(JSON.parse(first.slice(6)), { ...event, item: { type: 'function_call', id: 'fc_weather', call_id: 'call_weather', name: 'get_weather', arguments: '' } })
  finish()
  while (!(await reader.read()).done) {}
})

test('relay rejects malformed, invalid and oversized bodies without contacting upstream', async t => {
  const f = await fixture(t, { maxBytes: 64 })
  assert.equal((await f.post(null)).status, 400)
  assert.equal((await f.post({ input: {} })).status, 400)
  assert.equal((await f.post({}, { body: '{' })).status, 400)
  assert.equal((await f.post({ input: 'x'.repeat(100) })).status, 413)
  assert.equal(f.requests.length, 0)
})

test('SSE chunks arrive before the upstream completes', async t => {
  let finish
  const f = await fixture(t, { handle: (_req, res) => {
    res.writeHead(201, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('data: first\n\n')
    finish = () => res.end('data: last\n\n')
  } })
  const response = await bounded(f.post())
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await bounded(reader.read())).value), 'data: first\n\n')
  finish()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n')
  assert.equal((await reader.read()).done, true)
})

test('401 refreshes and retries exactly once, forwarding final status and subscription errors unchanged', async t => {
  for (const always401 of [false, true]) {
    const body = '{"error":{"code":"subscription_sharing_limit","message":"synthetic policy"}}'
    const f = await fixture(t, { handle: (_req, res, count) => { res.writeHead(count === 1 || always401 ? 401 : 429, { 'content-type': 'application/json' }); res.end(body) } })
    const response = await f.post()
    assert.equal(response.status, always401 ? 401 : 429)
    assert.equal(await response.text(), body)
    assert.equal(f.refreshes, 1)
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].headers.authorization, 'Bearer synthetic-renewed')
  }
})

test('redirects are refused without following them', async t => {
  const f = await fixture(t, { handle: (_req, res) => { res.writeHead(302, { location: '/leak' }); res.end('sensitive upstream body') } })
  const response = await f.post()
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'relay_redirect_refused')
  assert.equal(f.requests.length, 1)
})

test('token and model errors have only safe fixed local messages and state codes', async t => {
  for (const state of ['needs-sign-in', 'signed-out', 'plan-usage-off', 'temporarily-unavailable', 'unsupported']) {
    const f = await fixture(t, { error: Object.assign(new Error('synthetic-secret'), { state }) })
    for (const response of [await f.post(), await fetch(`${f.baseURL}/models`, { headers: { authorization: `Bearer ${f.secret}` } })]) {
      assert.equal(response.status, ['temporarily-unavailable', 'unsupported'].includes(state) ? 503 : 401)
      const body = await response.text()
      assert.ok(body.includes(`chatgpt_${state === 'signed-out' ? 'needs-sign-in' : state}`))
      assert.ok(!body.includes('synthetic-secret'))
    }
  }
})

test('disconnecting an SSE client aborts the upstream request', async t => {
  let disconnected
  const closed = new Promise(resolve => { disconnected = resolve })
  const f = await fixture(t, { handle: (_req, res) => { res.on('close', disconnected); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n') } })
  const controller = new AbortController()
  const response = await f.post(undefined, { signal: controller.signal })
  await response.body.getReader().read()
  controller.abort()
  await bounded(closed)
})

test('IPC bridge correlates requests, sanitizes failures and cancels an active sign-in', async () => {
  const replies = []
  let options
  const signIn = { status: () => ({ state: 'signed-out' }),
    signIn: input => { options = input; return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true })) },
    listModels: async () => [], signOut: async () => ({ state: 'signed-out', remoteRevocationConfirmed: false }),
  }
  const bridge = createChatGPTBridge({ signIn, relay: { route: () => ({ baseURL: 'loopback', secret: 'synthetic-local' }), close() {} }, openExternal() {} })
  const call = (method, body) => bridge.handle({ type: 'ds-bot:chatgpt', id: method, method, body }, value => replies.push(value))
  assert.equal(bridge.handle({ type: 'other' }, () => {}), false)
  call('chatgpt:sign-in', { consent: true }); await tick()
  assert.equal(options.consent, true)
  call('chatgpt:cancel'); await tick()
  assert.ok(options.signal.aborted)
  assert.equal(replies.find(item => item.id === 'chatgpt:sign-in').error.state, 'signed-out')
  assert.ok(!JSON.stringify(replies).includes('synthetic-secret'))
  for (const method of ['chatgpt:status', 'chatgpt:route', 'chatgpt:models', 'chatgpt:sign-out']) call(method)
  await tick()
  assert.ok(replies.find(item => item.id === 'chatgpt:route').result.secret)
  assert.equal(replies.find(item => item.id === 'chatgpt:sign-out').result.remoteRevocationConfirmed, false)
})
