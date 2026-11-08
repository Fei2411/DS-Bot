import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1105: the handoff note on a reasoning model. Its first attempt is the Bot's own
// request, so the provider serves the prefix from cache; after a cut-off the note is
// asked for with the least thinking and more room, and a route that still gives no
// usable note hands the note to the profile default model.

const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', model: 'deepseek/v4', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', model: 'deepseek/v4', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const NOTE = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
  .map(name => `## ${name}\n- (none)`).join('\n\n')
const CUT = { text: '## Goals\n- half', finish: 'max-tokens', output: 8_192 }
const HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'Write the report' }], source: { kind: 'user' } },
  { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
]
const TOOLS = [{ name: 'list_bots' }]

// Bot 'b' chats in Session 'b', whose last request went to `route`. The model answers
// each note request with the next of `replies`: a note, `{ text, finish, output }`, an
// Error, or a function of the move's controls that gives one of those. `efforts` gives
// each model's thinking levels, `limits` its declared output limit and `windows` its
// window; `defaultModel`, the profile default; `tokens`, the part's measured size.
async function start({ route = { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }, replies = [], efforts = {}, limits = {}, windows = {}, models = ['v4'], defaultModel, tokens } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-handoff-note-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  mkdirSync(team, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const services = {
    ...(defaultModel === undefined ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: defaultModel }), saveSelection: async () => {} } }),
    ...(tokens === undefined ? {} : { tokenMeter: { measure: () => ({ totalTokens: tokens }) } }),
  }
  const ctx = fakeContext({ services })
  const warnings = []
  const infos = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.logger.info = (...args) => infos.push(format(...args))
  const requests = []
  const created = []
  // Each run of the move gets its own signal; `cancel` stops the one running.
  const runs = []
  const cancel = () => runs.at(-1).abort(new Error('the move was cancelled'))
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const own = sessionId === 'b'
      agents.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId,
          header: { cwd: team },
          requestHeader: () => (own ? { config: route, tools: TOOLS } : undefined),
          deriveMessages: () => (own ? HISTORY : []),
          toolHistory: () => [],
        },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) {
          const run = new AbortController()
          runs.push(run)
          return fn(AbortSignal.any([run.signal, AbortSignal.timeout(60_000)]))
        },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async (_provider, model) => ({
        context: { contextWindow: windows[model] ?? 100_000 },
        ...(limits[model] === undefined ? {} : { defaultMaxTokens: limits[model] }),
        ...(efforts[model] === undefined ? {} : { reasoning: { efforts: efforts[model].map(id => ({ id })) } }),
      }),
      async* stream(request) {
        // Only the note is scripted; any other request of the move gets an empty answer.
        if (request.purpose !== 'compaction') {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        requests.push(request)
        const next = replies.shift()
        const reply = typeof next === 'function' ? next({ cancel }) : next
        if (reply instanceof Error) throw reply
        if (request.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted' } }
          return
        }
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        if (out.output !== undefined) yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: out.output } }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (options) => {
        created.push(options)
        return { sessionId: `s${created.length}` }
      },
      prompt: async () => ({ accepted: true }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  // "New session" in the Bot's chat: the part moves on even without a note.
  const moveOn = async () => {
    assert.equal(await rt.newPart('b'), true)
    await until(() => state().bots.b.sessionId === 's1')
    await until(() => infos.some(line => / moved on to part 2 /.test(line)))
    return state().bots.b.segments.at(-1)
  }
  const stop = async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, state, requests, warnings, infos, moveOn, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}
const promptOf = request => request.messages.at(-1).content[0].text
const asked = request => [`${request.provider}/${request.model}`, request.reasoningEffort, request.maxTokens]

test('a note cut off at the limit is asked for again shorter, with the least thinking and more room', async (t) => {
  const { requests, warnings, infos, moveOn, stop } = await start({ replies: [CUT, NOTE], efforts: { v4: ['off', 'high'] } })
  t.after(stop)
  const segment = await moveOn()
  assert.equal(segment.note, NOTE)
  assert.equal(segment.fallback, undefined)
  // The first attempt is the Bot's own request; only the retry changes effort and budget.
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', 'off', 32_768]])
  assert.doesNotMatch(promptOf(requests[0]), /cut off/)
  assert.match(promptOf(requests[1]), /was cut off at the output limit[^]*at most about 1,000 words/)
  for (const request of requests) {
    assert.deepEqual([request.sessionId, request.purpose, request.tools], ['b', 'compaction', TOOLS])
    assert.deepEqual(request.messages.slice(0, -1), HISTORY)
  }
  assert.ok(warnings.some(line => line.includes('handoff note attempt 1 of 2 for b not used: it was cut off at the output limit (deepseek/v4, finish max-tokens, 8192 output tokens, budget 8192)')), warnings.join('\n'))
  assert.ok(infos.some(line => line.includes('note written in 2 attempt(s)')))
})

test('the retry after a cut-off asks for the lowest level, or none, and stays within the route\'s own budget', async () => {
  for (const [levels, effort] of [[['low', 'high'], 'low'], [undefined, undefined]]) {
    const { requests, moveOn, stop } = await start({
      route: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high', maxTokens: 16_000 },
      replies: [CUT, NOTE],
      efforts: levels === undefined ? {} : { v4: levels },
    })
    try {
      assert.equal((await moveOn()).note, NOTE)
      assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', effort, 16_000]])
      if (effort === undefined) assert.equal('reasoningEffort' in requests[1], false)
    } finally {
      await stop()
    }
  }
})

test('a note without every section is asked for again as the Bot\'s own request', async (t) => {
  const { requests, moveOn, stop } = await start({ replies: ['## Goals\n- the report', NOTE], efforts: { v4: ['off', 'high'] } })
  t.after(stop)
  assert.equal((await moveOn()).note, NOTE)
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', 'high', 8_192]])
  assert.match(promptOf(requests[1]), /lacked these headings/)
})

test('a route that keeps cutting the note off hands it to the default model, whose note is used', async (t) => {
  const { requests, warnings, infos, moveOn, stop } = await start({
    replies: [CUT, { ...CUT, output: 32_768 }, NOTE],
    efforts: { v4: ['off', 'high'], flash: ['low', 'high'] },
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  const segment = await moveOn()
  assert.equal(segment.note, NOTE)
  assert.equal(segment.fallback, undefined)
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', 'off', 32_768], ['deepseek/flash', 'low', 32_768]])
  // The same conversation and tools, still asking for the shorter note.
  assert.deepEqual([requests[2].sessionId, requests[2].purpose, requests[2].tools], ['b', 'compaction', TOOLS])
  assert.deepEqual(requests[2].messages, requests[1].messages)
  assert.ok(warnings.some(line => line.includes('attempt 2 of 2 for b not used: it was cut off at the output limit (deepseek/v4, finish max-tokens, 32768 output tokens, budget 32768)')), warnings.join('\n'))
  assert.ok(infos.some(line => line.includes('note written in 3 attempt(s)')))
})

test('a request the route turns down goes to the default model at once', async (t) => {
  const { requests, warnings, moveOn, stop } = await start({
    replies: [{ text: '', finish: 'error', failure: '429: rate limited' }, NOTE],
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  assert.equal((await moveOn()).note, NOTE)
  assert.deepEqual(requests.map(request => request.model), ['v4', 'flash'])
  assert.ok(warnings.some(line => line.includes('attempt 1 of 2 for b not used: the request failed: 429: rate limited (deepseek/v4, finish error, budget 8192)')), warnings.join('\n'))
})

test('without a default model on another route the note fails as before', async (t) => {
  const { requests, warnings, moveOn, stop } = await start({ replies: [CUT, CUT], efforts: { v4: ['off', 'high'] }, defaultModel: 'v4' })
  t.after(stop)
  const segment = await moveOn()
  assert.equal(segment.fallback, 'failed')
  assert.equal(segment.note, undefined)
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', 'off', 32_768]])
  assert.ok(warnings.some(line => line.includes('failed past the hard line; moving on with the earlier note: no usable note in 2 attempts; the last one: it was cut off at the output limit')), warnings.join('\n'))
})

test('a default model that cannot write the note either fails the note', async (t) => {
  const { requests, warnings, moveOn, stop } = await start({
    replies: [CUT, CUT, { ...CUT, output: 32_768 }],
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  const segment = await moveOn()
  assert.equal(segment.fallback, 'failed')
  assert.equal(requests.length, 3)
  assert.ok(warnings.some(line => line.includes('attempt 3 for b, on the default model, not used: it was cut off at the output limit (deepseek/flash, finish max-tokens, 32768 output tokens, budget 32768)')), warnings.join('\n'))
  assert.ok(warnings.some(line => line.includes('no usable note in 3 attempts; the last one, on deepseek/flash: it was cut off at the output limit')), warnings.join('\n'))
})

test('the larger budget stays within the output limit each model declares', async (t) => {
  const { requests, moveOn, stop } = await start({
    replies: [CUT, CUT, NOTE],
    efforts: { v4: ['off', 'high'], flash: ['low', 'high'] },
    limits: { v4: 20_000, flash: 16_000 },
    tokens: 10_000,
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  assert.equal((await moveOn()).note, NOTE)
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192], ['deepseek/v4', 'off', 20_000], ['deepseek/flash', 'low', 16_000]])
})

test('a default model whose window cannot hold the part is not asked', async (t) => {
  const { requests, warnings, moveOn, stop } = await start({
    replies: [CUT, CUT],
    efforts: { v4: ['off', 'high'] },
    windows: { flash: 16_000 },
    tokens: 10_000,
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  assert.equal((await moveOn()).fallback, 'failed')
  assert.deepEqual(requests.map(request => request.model), ['v4', 'v4'])
  assert.ok(warnings.some(line => line.includes('no usable note in 2 attempts; the last one: it was cut off at the output limit')), warnings.join('\n'))
})

test('a default model whose window holds the part but not the larger budget is not asked', async (t) => {
  const { requests, moveOn, stop } = await start({
    replies: [CUT, CUT],
    efforts: { v4: ['off', 'high'] },
    windows: { flash: 30_000 },
    tokens: 10_000,
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  assert.equal((await moveOn()).fallback, 'failed')
  assert.deepEqual(requests.map(request => request.model), ['v4', 'v4'])
})

test('a request that throws, with no default model on another route, fails the note with its own error', async (t) => {
  const { requests, warnings, moveOn, stop } = await start({ replies: [new Error('socket hang up')], defaultModel: 'v4' })
  t.after(stop)
  const segment = await moveOn()
  assert.equal(segment.fallback, 'failed')
  assert.equal(requests.length, 1)
  assert.ok(warnings.some(line => line.includes('attempt 1 of 2 for b not used: the request failed: socket hang up (deepseek/v4, finish error, budget 8192)')), warnings.join('\n'))
  assert.ok(warnings.some(line => line.includes('moving on with the earlier note: socket hang up')), warnings.join('\n'))
})

test('a move cancelled during the note asks no other route', async (t) => {
  const cancelling = ({ cancel }) => {
    cancel()
    return CUT
  }
  const { rt, state, requests, warnings, stop } = await start({
    replies: [cancelling],
    models: ['v4', 'flash'],
    defaultModel: 'flash',
  })
  t.after(stop)
  assert.equal(await rt.newPart('b'), true)
  await until(() => warnings.some(line => line.includes('Writer did not move on to a fresh part')))
  assert.deepEqual(requests.map(asked), [['deepseek/v4', 'high', 8_192]])
  assert.equal(state().bots.b.sessionId, 'b')
  assert.ok(!warnings.some(line => /handoff note attempt/.test(line)), warnings.join('\n'))
})
