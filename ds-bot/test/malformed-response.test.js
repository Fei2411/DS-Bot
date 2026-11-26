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

function openAIStream(attempt, res, { singleCall = false } = {}) {
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  if (attempt === 1) {
    for (const [id, command, description] of [['call_A', 'ls', 'a'], ['call_B', 'cat', 'b']]) {
      chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: '' } }] })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command, description }) } }] })
      if (singleCall) break
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
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8')
    let body = ''
    for await (const chunk of req) body += chunk
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    provider.respond(++attempts, res, JSON.parse(body))
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

// The runtime context DSH admits for a request is its newest user message. DSH 0.2.2-rc.5 wraps
// it in <system-reminder>, rc.1 sends the bare text, and 0.2.3-alpha.2 sends text parts.
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.type === 'text' ? part.text : '').join('') : ''
const advisedOneTool = messages => textOf(messages.findLast(({ role }) => role === 'user')?.content).includes('call at most one tool')

// An OpenAI provider that fuses two parallel calls into one malformed call unless the newest
// runtime context asks for one tool; with `ignoreHint` it always does. After `limit` requests it
// answers in text, so a policy that retries without end fails an assertion instead of timing out.
function parallelCalls(hints, { ignoreHint = false, limit = 5 } = {}) {
  return {
    ...openAI,
    respond(_attempt, res, { messages }) {
      const advised = advisedOneTool(messages)
      hints.push(advised)
      const answer = hints.length > limit || messages.some(message => message.role === 'tool')
      openAIStream(answer ? 2 : 1, res, { singleCall: advised && !ignoreHint })
    },
  }
}

function assertRecoveredWithOneTool(result, hints) {
  const turnEnd = result.events.findLast(event => event.type === 'turn/end')
  assert.equal(turnEnd.data.reason.kind, 'completed', JSON.stringify({ hints, attempts: result.attempts, failures: result.failures }))
  assert.deepEqual(hints, [false, true, false])
  assert.deepEqual(result.failures.map(failure => failure.code), ['MALFORMED_RESPONSE'])
  const toolCalls = result.events.find(event => event.type === 'assistant/message').data.message.content.filter(block => block.type === 'tool-call')
  assert.deepEqual(toolCalls.map(({ id, name, arguments: args }) => [id, name, JSON.parse(args)]), [
    ['call_A', 'bash', { command: 'ls', description: 'a' }],
  ])
}

const fastBackoff = { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }

test('a Bot recovers when the provider repeats malformed parallel calls unless advised to use one tool', async t => {
  const hints = []
  const result = await boot(t, true, parallelCalls(hints), { retryPolicy: { mode: 'normal', maxRetries: 2 } })
  assertRecoveredWithOneTool(result, hints)
  assert.equal(result.events.some(event => event.type === 'llm/retry'), false)
})

for (const retryPolicy of [
  { mode: 'normal', maxRetries: 2, retryableCodes: ['MALFORMED_RESPONSE'], backoff: fastBackoff },
  { mode: 'always', backoff: fastBackoff },
]) {
  test(`a Bot asks for one tool call when DSH's ${retryPolicy.mode} policy retries malformed parallel calls`, async t => {
    const hints = []
    const result = await boot(t, true, parallelCalls(hints), { retryPolicy })
    assertRecoveredWithOneTool(result, hints)
    assert.equal(result.events.filter(event => event.type === 'llm/retry').length, 1)
  })
}

test('a malformed response keeps one retry budget when the policy already retries MALFORMED_RESPONSE', async t => {
  const hints = []
  const retryPolicy = { mode: 'normal', maxRetries: 1, retryableCodes: ['MALFORMED_RESPONSE'], backoff: fastBackoff }
  const result = await boot(t, true, parallelCalls(hints, { ignoreHint: true }), { retryPolicy })
  assert.equal(result.attempts, 2, JSON.stringify(hints))
  assert.deepEqual(hints, [false, true])
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
})

for (const [finishReason, messages] of [
  ['MALFORMED_FUNCTION_CALL', ['Provider stopped with: MALFORMED_FUNCTION_CALL']],
  ['UNEXPECTED_TOOL_CALL', ['Provider stopped with: UNEXPECTED_TOOL_CALL']],
  ['MALFORMED_RESPONSE', ['Provider stopped with: MALFORMED_RESPONSE', 'Unhandled stop reason: MALFORMED_RESPONSE']],
]) {
  test(`a Bot retries a Gemini ${finishReason} stop and completes on the next response`, async t => {
    const unrecovered = await boot(t, false, gemini(finishReason))
    assert.equal(unrecovered.failures.length, 1)
    assert.equal(unrecovered.failures[0].code, 'PI_AI_ERROR')
    assert.ok(messages.includes(unrecovered.failures[0].message), `unexpected failure message: ${unrecovered.failures[0].message}`)
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
  const contexts = []
  const systemPrompt = { context: entry => contexts.push(entry) }
  install({ ctx: { on: (name, fn) => listeners.set(name, fn), llm: { providerRetryPolicy: () => providerPolicy }, systemPrompt }, state: { bots: {} }, isBotSession: id => id === 'bot', warn: message => warnings.push(message) })
  const hint = ({ agent, signal }) => contexts.map(entry => entry.text({ agent, signal })).join('')
  return { run: listeners.get('agent/request-error'), warnings, hint }
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
  for (const message of ['Unhandled stop reason: OTHER_REASON', 'pi-ai stream for model "mock" ended pending', 'MALFORMED_RESPONSE', quotedGeminiStop, 'Provider stopped with: MALFORMED_FUNCTION_CALL.', 'Provider stopped with: MALFORMED_RESPONSE.']) {
    assert.equal(await run({ ...p, failure: { code: 'PI_AI_ERROR', message } }, next), undefined)
  }
  assert.equal(warnings.length, 0)
  assert.deepEqual(await run({ ...p, failure: { code: 'PI_AI_ERROR', message: 'Unhandled stop reason: MALFORMED_RESPONSE' } }, next), { kind: 'retry' })
  assert.deepEqual(await run({ ...p, failure: { code: 'PI_AI_ERROR', message: 'Provider stopped with: MALFORMED_RESPONSE' } }, next), { kind: 'retry' })
})

test('a retry decided downstream asks for one tool call only after malformed tool-call arguments', async () => {
  const toolArgs = { code: 'MALFORMED_RESPONSE', message: 'Tool call "bash": Unexpected non-whitespace character after JSON at position 34' }
  const retry = { kind: 'retry' }
  const { run, warnings, hint } = handler()
  const p = { ...payload(), failure: toolArgs }
  assert.equal(await run(p, async () => retry), retry)
  assert.match(hint(p), /call at most one tool/)
  assert.equal(hint(p), '')
  for (const other of [{ ...payload(), failure: { code: 'MALFORMED_RESPONSE', message: 'bad arguments' } }, { ...payload(), agent: { id: 'human' }, failure: toolArgs }]) {
    assert.equal(await run(other, async () => retry), retry)
    assert.equal(hint(other), '')
  }
  const declined = { ...payload(), failure: toolArgs }
  assert.equal(await run(declined, async () => ({ kind: 'fail' })).then(decision => decision.kind), 'fail')
  assert.equal(hint(declined), '')
  assert.equal(warnings.length, 0)
})

test('malformed responses leave the retry to a normal policy that already retries MALFORMED_RESPONSE', async () => {
  const { run, warnings } = handler()
  assert.equal(await run({ ...payload(), retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['MALFORMED_RESPONSE'] } }, next), undefined)
  assert.equal(warnings.length, 0)
  assert.deepEqual(await run({ ...payload(), retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'] } }, next), { kind: 'retry' })
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
