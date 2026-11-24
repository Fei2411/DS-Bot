import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assembleLlmStream, install } from '../src/host/models.js'

const piApi = '@earendil-works/pi-ai/api/openai-completions.lazy'
const adapterUrl = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai')
const googleApi = '@earendil-works/pi-ai/api/google-generative-ai.lazy'
const resolution = registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(specifier, specifier === piApi || specifier === googleApi ? { ...context, parentURL: adapterUrl } : context) })
const [{ openAICompletionsApi }, { googleGenerativeAIApi }] = await Promise.all([import(piApi), import(googleApi)]).finally(() => resolution.deregister())

function openAIStream(attempt, res) {
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  if (attempt === 1) {
    for (const [id, command, description] of [['call_A', 'ls', 'a'], ['call_B', 'cat', 'b']]) {
      chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: '' } }] })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command, description }) } }] })
    }
    chunk({}, 'tool_calls')
  } else {
    chunk({ content: 'Recovered' })
    chunk({}, 'stop')
  }
  res.end('data: [DONE]\n\n')
}

const openAI = { api: openAICompletionsApi, name: 'openai-completions', path: '/v1', respond: openAIStream }

// A Gemini stream that stops on `finishReason` first, then answers on the next request.
const gemini = (finishReason, failedAttempts = 1) => ({
  api: googleGenerativeAIApi,
  name: 'google-generative-ai',
  path: '',
  respond: (attempt, res) => res.end(`data: ${JSON.stringify(attempt <= failedAttempts
    ? { candidates: [{ content: { role: 'model', parts: [] }, finishReason }] }
    : { candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered' }] }, finishReason: 'STOP' }] })}\n\n`),
})

// An OpenAI stream whose error only quotes a Gemini stop reason.
const quotedGeminiStop = 'Account blocked; last attempt log: Provider stopped with: MALFORMED_FUNCTION_CALL'
const openAIError = { ...openAI, respond: (attempt, res) => res.end(`data: ${JSON.stringify({ error: { message: quotedGeminiStop } })}\n\n`) }

async function boot(t, recover, provider = openAI, { retryPolicy } = {}) {
  let attempts = 0
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    provider.respond(++attempts, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const api = provider.api()
  const model = { id: 'mock', name: 'Mock', api: provider.name, provider: 'mock', baseUrl: `http://127.0.0.1:${server.address().port}${provider.path}`, input: ['text'], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const piProvider = { id: 'mock', name: 'Mock', auth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'mock-key' } }) } }, baseUrl: model.baseUrl, getModels: () => [model], stream: (...args) => api.stream(...args), streamSimple: (...args) => api.streamSimple(...args) }
  const profiles = new Map([['mock', { provider: 'mock', displayName: 'Mock', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 5000, ...retryPolicy && { retryPolicy: resolveRetryPolicy(retryPolicy, 'mock') } }]])
  ctx.llm.registerAdapter(['mock'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'mock-key', auth: { credentials: { read: async () => undefined }, authContext: { getEnv: () => undefined } } }))
  const failures = []
  ctx.on('agent/request-error', async (payload, next) => { failures.push(payload.failure); return next() })
  if (recover) install({ ctx, state: { bots: {} }, isBotSession: () => true, warn() {} })
  if (retryPolicy) ctx.plugin(llmRetry)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('malformed'), { provider: 'mock', model: 'mock' })
  const idle = new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ status }) => { if (status === 'idle') { dispose(); resolve() } })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }))
  await idle
  return { failures, attempts, events: agent.session.snapshotEvents() }
}

async function probeMalformedStream(t) {
  const result = await boot(t, false)
  if (result.failures.length === 0) {
    assert.equal(result.attempts, 2)
    assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    t.skip('The bundled adapter accepts the same-index stream without MALFORMED_RESPONSE')
    return undefined
  }
  assert.equal(result.failures[0]?.code, 'MALFORMED_RESPONSE')
  return result
}

test('the real pi-ai malformed stream reaches agent/request-error as MALFORMED_RESPONSE', async t => {
  const result = await probeMalformedStream(t)
  if (result === undefined) return
  assert.equal(result.attempts, 1, JSON.stringify(result.failures))
  assert.equal(result.failures[0]?.code, 'MALFORMED_RESPONSE')
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
})

test('a Bot retries the malformed stream and completes on the next response', async t => {
  if (await probeMalformedStream(t) === undefined) return
  const result = await boot(t, true)
  assert.equal(result.failures[0]?.code, 'MALFORMED_RESPONSE')
  assert.equal(result.attempts, 2)
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
})

for (const [finishReason, message] of [
  ['MALFORMED_FUNCTION_CALL', 'Provider stopped with: MALFORMED_FUNCTION_CALL'],
  ['UNEXPECTED_TOOL_CALL', 'Provider stopped with: UNEXPECTED_TOOL_CALL'],
  ['MALFORMED_RESPONSE', 'Unhandled stop reason: MALFORMED_RESPONSE'],
]) {
  test(`a Bot retries a Gemini ${finishReason} stop and completes on the next response`, async t => {
    const unrecovered = await boot(t, false, gemini(finishReason))
    assert.deepEqual(unrecovered.failures, [{ code: 'PI_AI_ERROR', message }])
    const result = await boot(t, true, gemini(finishReason))
    assert.equal(result.attempts, 2)
    assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  })
}

test('an OpenAI PI_AI_ERROR that quotes a Gemini stop reason is not retried as malformed', async t => {
  const unrecovered = await boot(t, false, openAIError)
  assert.deepEqual(unrecovered.failures.map(failure => failure.code), ['PI_AI_ERROR'])
  assert.match(unrecovered.failures[0].message, /Account blocked/)
  const result = await boot(t, true, openAIError)
  assert.equal(result.attempts, 1)
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
})

test('a Gemini malformed stop keeps one retry budget when the policy already retries PI_AI_ERROR', async t => {
  const retryPolicy = { mode: 'normal', maxRetries: 1, retryableCodes: ['PI_AI_ERROR'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
  const result = await boot(t, true, gemini('MALFORMED_FUNCTION_CALL', 5), { retryPolicy })
  assert.equal(result.attempts, 2)
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
  const recovered = await boot(t, true, gemini('MALFORMED_FUNCTION_CALL'), { retryPolicy })
  assert.equal(recovered.attempts, 2)
  assert.equal(recovered.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
})

function handler(providerPolicy) {
  const listeners = new Map()
  const warnings = []
  install({ ctx: { on: (name, fn) => listeners.set(name, fn), llm: { providerRetryPolicy: () => providerPolicy } }, state: { bots: {} }, isBotSession: id => id === 'bot', warn: message => warnings.push(message) })
  return { run: listeners.get('agent/request-error'), warnings }
}

const payload = () => ({ agent: { id: 'bot' }, turn: 1, step: 1, failure: { code: 'MALFORMED_RESPONSE' }, signal: new AbortController().signal })
const next = async () => undefined

test('malformed retries are bounded per agent, turn and step', async () => {
  const { run, warnings } = handler()
  const p = payload()
  assert.deepEqual(await run(p, next), { kind: 'retry' })
  assert.deepEqual(await run(p, next), { kind: 'retry' })
  assert.equal(await run(p, next), undefined)
  p.step += 1
  assert.deepEqual(await run(p, next), { kind: 'retry' })
  p.turn += 1
  assert.deepEqual(await run(p, next), { kind: 'retry' })
  assert.deepEqual(await run(payload(), next), { kind: 'retry' })
  assert.equal(warnings.length, 5)
})

test('other failures, non-Bots, aborts and downstream decisions do not consume retries', async () => {
  const { run, warnings } = handler()
  const p = payload()
  assert.equal(await run({ ...p, failure: { code: 'TIMEOUT' } }, next), undefined)
  assert.equal(await run({ ...p, agent: { id: 'human' } }, next), undefined)
  assert.equal(await run({ ...p, signal: AbortSignal.abort() }, next), undefined)
  const decision = { kind: 'retry' }
  assert.equal(await run(p, async () => decision), decision)
  assert.equal(warnings.length, 0)
  const controller = new AbortController()
  const pending = run({ ...p, signal: controller.signal }, next)
  setTimeout(() => controller.abort(), 10)
  assert.equal(await pending, undefined)
})

test('only Gemini malformed stops among PI_AI_ERROR failures consume malformed retries', async () => {
  const { run, warnings } = handler()
  const p = payload()
  for (const message of ['Unhandled stop reason: OTHER_REASON', 'pi-ai stream for model "mock" ended pending', 'MALFORMED_RESPONSE', quotedGeminiStop, 'Provider stopped with: MALFORMED_FUNCTION_CALL.']) {
    assert.equal(await run({ ...p, failure: { code: 'PI_AI_ERROR', message } }, next), undefined)
  }
  assert.equal(warnings.length, 0)
  assert.deepEqual(await run({ ...p, failure: { code: 'PI_AI_ERROR', message: 'Unhandled stop reason: MALFORMED_RESPONSE' } }, next), { kind: 'retry' })
})

test('Gemini malformed stops leave the retry to a policy that already retries PI_AI_ERROR', async () => {
  const failure = { code: 'PI_AI_ERROR', message: 'Provider stopped with: UNEXPECTED_TOOL_CALL' }
  for (const retryPolicy of [{ mode: 'normal', maxRetries: 1, retryableCodes: ['PI_AI_ERROR'] }, { mode: 'always' }]) {
    const { run, warnings } = handler()
    assert.equal(await run({ ...payload(), failure, retryPolicy }, next), undefined)
    assert.equal(warnings.length, 0)
  }
  const { run } = handler()
  assert.deepEqual(await run({ ...payload(), failure, retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'] } }, next), { kind: 'retry' })
})

test('auxiliary calls do not retry a PI_AI_ERROR that only quotes a Gemini stop reason', async () => {
  for (const throws of [true, false]) {
    let attempts = 0
    const failure = { code: 'PI_AI_ERROR', message: quotedGeminiStop }
    const ctx = { llm: { async *stream() {
      attempts += 1
      if (throws) throw Object.assign(new Error(failure.message), { code: failure.code, failure })
      yield { type: 'finish', reason: { kind: 'error', failure } }
    } } }
    const request = assembleLlmStream(ctx, { provider: 'mock', model: 'mock' }, { backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    if (throws) await assert.rejects(request, { code: 'PI_AI_ERROR' })
    else assert.equal((await request).finish.failure.code, 'PI_AI_ERROR')
    assert.equal(attempts, 1)
  }
})

test('auxiliary Gemini malformed stops retry twice, thrown or finished', async () => {
  for (const throws of [true, false]) {
    let attempts = 0
    const failure = { code: 'PI_AI_ERROR', message: 'Provider stopped with: MALFORMED_FUNCTION_CALL' }
    const ctx = { llm: { async *stream() {
      attempts += 1
      if (throws) throw Object.assign(new Error(failure.message), { code: failure.code, failure })
      yield { type: 'finish', reason: { kind: 'error', failure } }
    } } }
    const request = assembleLlmStream(ctx, { provider: 'mock', model: 'mock' }, { backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    if (throws) await assert.rejects(request, { code: 'PI_AI_ERROR' })
    else assert.equal((await request).finish.failure.code, 'PI_AI_ERROR')
    assert.equal(attempts, 3)
  }
})

test('auxiliary malformed responses retry twice, discarding partial attempts', async () => {
  let attempts = 0
  const ctx = { llm: { async *stream() {
    attempts += 1
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'bad arguments' } } }
  } } }
  const result = await assembleLlmStream(ctx, { provider: 'mock', model: 'mock' }, { backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
  assert.equal(attempts, 3)
  assert.equal(result.finish.failure.code, 'MALFORMED_RESPONSE')
})

for (const [policy, retries] of [
  [{ mode: 'normal', maxRetries: 0 }, 0],
  [{ mode: 'normal', maxRetries: 1 }, 1],
  [{ mode: 'normal', maxRetries: 5 }, 2],
  [{ mode: 'always', maxRetries: 0 }, 2],
  [{ mode: 'off' }, 0],
  [{}, 0],
]) {
  test(`malformed retries honor ${JSON.stringify(policy)} in the hook and auxiliary calls`, async () => {
    for (const prepared of [true, false]) {
      const { run, warnings } = handler(prepared ? { mode: 'always' } : policy)
      const p = { ...payload(), retryPolicy: prepared ? policy : undefined, provider: 'mock' }
      for (let retry = 0; retry < retries; retry += 1) assert.deepEqual(await run(p, next), { kind: 'retry' })
      assert.equal(await run(p, next), undefined)
      assert.equal(warnings.length, retries)
    }
    for (const throws of [true, false]) {
      let attempts = 0
      const failure = { code: 'MALFORMED_RESPONSE', message: 'bad arguments' }
      const ctx = { llm: {
        providerRetryPolicy: () => policy,
        async *stream() {
          attempts += 1
          if (throws) throw Object.assign(new Error(failure.message), failure)
          yield { type: 'finish', reason: { kind: 'error', failure } }
        },
      } }
      const request = assembleLlmStream(ctx, { provider: 'mock', model: 'mock' }, { backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
      if (throws) await assert.rejects(request, { code: 'MALFORMED_RESPONSE' })
      else assert.equal((await request).finish.failure.code, 'MALFORMED_RESPONSE')
      assert.equal(attempts, retries + 1)
    }
  })
}
