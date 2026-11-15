import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install as installChannel } from '../src/host/channel.js'
import { install as installThinking, thinkingMs } from '../src/host/thinking.js'

const reasoningRun = (time0, gaps, texts) => ({ type: 'reasoning-chunks', time0, index: 0, dt: gaps, texts })
const textRun = (time0, gaps, texts) => ({ type: 'text-chunks', time0, index: 0, dt: gaps, texts })
const message = (turn, step, stream, extra = {}) => ({ seq: turn * 10 + step, type: 'assistant/message', data: { turn, step, message: { content: [] }, stream, ...extra } })

test('a Turn’s thinking time sums its steps’ reasoning spans', () => {
  const events = [
    message(1, 1, [reasoningRun(1000, [500, 200], ['a', 'b', 'c']), textRun(1800, [100], ['reply'])]),
    message(1, 2, [reasoningRun(3000, [900], ['x', 'y']), textRun(4000, [], ['done'])]),
  ]
  // Step 1: 1000+500+200−1000 = 700; step 2: 3000+900−3000 = 900.
  assert.equal(thinkingMs(events, 1), 1600)
})

test('a step without reasoning records contributes 0, other turn events are ignored', () => {
  const events = [
    message(1, 1, [textRun(1000, [50], ['straight to text'])]),
    { type: 'tool/call', data: { turn: 1, step: 1 } },
    message(1, 2, [reasoningRun(3000, [500], ['a', 'b'])]),
    message(2, 1, [reasoningRun(5000, [1000], ['other', 'turn'])]),
  ]
  assert.equal(thinkingMs(events, 1), 500)
})

test('an interrupted message still counts its streamed reasoning', () => {
  const events = [message(1, 1, [reasoningRun(1000, [400, 300], ['a', 'b', 'c'])], { interrupted: true })]
  assert.equal(thinkingMs(events, 1), 700)
})

test('assistant/attempt streams are skipped', () => {
  const events = [
    { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [reasoningRun(1000, [9000], ['failed', 'try'])] } },
    message(1, 1, [reasoningRun(2000, [100], ['ok', 'now'])]),
  ]
  assert.equal(thinkingMs(events, 1), 100)
})

test('a turn with reasoning text but no stream records is unknown, not 0', () => {
  const events = [message(1, 1, undefined)]
  assert.equal(thinkingMs(events, 1), undefined)
  assert.equal(thinkingMs([{ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'old' }] } } }], 1), undefined)
})

test('several reasoning runs in one step span first to last', () => {
  const events = [message(1, 1, [
    reasoningRun(1000, [100], ['a', 'b']),
    textRun(2000, [50], ['tool intro']),
    reasoningRun(5000, [200], ['c', 'd']),
  ])]
  assert.equal(thinkingMs(events, 1), 4200)
})

test('thinkingOf caches only a closed turn', async () => {
  let pages = 0
  const rt = {
    eventsBackwards: async function* () {
      pages += 1
      for (const event of [...EVENTS].reverse()) yield event
    },
  }
  installThinking(rt)
  // Open turn: computed each call.
  assert.equal(await rt.thinkingOf('s', 1), 1000)
  assert.equal(await rt.thinkingOf('s', 1), 1000)
  assert.equal(pages, 2)
  EVENTS.push({ type: 'turn/end', data: { turn: 1 } })
  assert.equal(await rt.thinkingOf('s', 1), 1000)
  assert.equal(await rt.thinkingOf('s', 1), 1000)
  assert.equal(pages, 3)
})

test('reading an older turn also answers the closed turns read on the way', async () => {
  const events = [
    message(1, 1, [reasoningRun(1000, [1000], ['a', 'b'])]), { type: 'turn/end', data: { turn: 1 } },
    message(2, 1, [reasoningRun(5000, [2000], ['a', 'b'])]), { type: 'turn/end', data: { turn: 2 } },
    message(3, 1, [reasoningRun(9000, [3000], ['a', 'b'])]),
  ]
  let pages = 0
  const rt = { eventsBackwards: async function* () { pages += 1; for (const event of [...events].reverse()) yield event } }
  installThinking(rt)
  assert.equal(await rt.thinkingOf('s', 1), 1000)
  assert.equal(await rt.thinkingOf('s', 2), 2000)
  assert.equal(pages, 1)
  assert.equal(await rt.thinkingOf('s', 3), 3000)
  assert.equal(pages, 2)
})

const EVENTS = [message(1, 1, [reasoningRun(1000, [400, 600], ['a', 'b', 'c'])])]

const api = (handlers = {}) => {
  let route
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: () => () => {},
    effect: execute => { execute() },
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx,
    state: { revision: 0, bots: {}, rooms: {}, exchanges: [], questions: {}, agents: {}, secretRequests: {}, prefs: {} },
    save: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    load: async () => {},
    bootstrap: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    cachedCatalog: () => [],
    cachedDefault: () => undefined,
    reasoningOf: () => undefined,
    providersView: async () => ({}),
    secretsView: () => ({}),
    capabilityLibraryView: () => ({}),
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => ({}),
    waitingView: () => ({}),
    turnsView: () => ({}),
    memoryNews: () => ({}),
    memoryReviews: () => ({}),
    connectorsView: () => ({}),
    capabilityStatusesView: () => ({}),
    phoneView: () => null,
    phoneServe: () => {},
    selfOf: id => handlers.selfOf?.(id),
    thinkingOf: handlers.thinkingOf ?? (async () => undefined),
    warn() {},
  }
  installChannel(rt)
  const post = async (endpoint, payload) => {
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return response.json()
  }
  return { post }
}

test('the thinking endpoint answers ms only for a Bot session', async () => {
  const { post } = api({ selfOf: id => (id === 'bot-chat' ? 'bot-1' : undefined), thinkingOf: async () => 12000 })
  assert.deepEqual(await post('thinking', { sessionId: 'bot-chat', turn: 3 }), { ok: true, value: { ms: 12000 } })
  assert.deepEqual(await post('thinking', { sessionId: 'elsewhere', turn: 3 }), { ok: true, value: null })
  assert.deepEqual(await post('thinking', { sessionId: 'bot-chat', turn: 'x' }), { ok: true, value: null })
})

test('the thinking endpoint omits ms when the time is unknown', async () => {
  const { post } = api({ selfOf: () => 'bot-1', thinkingOf: async () => undefined })
  assert.deepEqual(await post('thinking', { sessionId: 's', turn: 1 }), { ok: true, value: {} })
})
