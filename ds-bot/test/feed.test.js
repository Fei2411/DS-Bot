import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 3,
  bots: {
    m1: { id: 'm1', sessionId: 'm1c', segments: [{ sessionId: 'm1', endedAt: 50 }], name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  // Chief's turn 7 answers another Bot, so the chat does not show it.
  exchangeTurns: { m1c: [7] },
  questions: {},
}

const userMessage = (text, time) => ({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const botMessage = (text, time, turn = 1) => ({ type: 'assistant/message', time, data: { turn, message: { content: [{ type: 'text', text }] } } })

function start({ pages = {}, services = {}, team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-feed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 100 } } }),
    // Two pages per Session, newest first, keyed by the cursor that asks for them.
    page: async ({ address, beforeSeq }) => pages[`${address.sessionId}:${beforeSeq ?? 'end'}`] ?? { records: [], hasMore: false },
  }
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, stop, routes }
}

// Reads Server-Sent Events off a response, one `{ event, data, id? }` per call.
function reader(response, { withId = false } = {}) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        const id = field('id')
        return withId
          ? { id, event: field('event'), data: JSON.parse(field('data')) }
          : { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

test('HTTP feed connections expire within the update deadline and reconnect with hello', async (t) => {
  const { call, stop, routes } = start()
  t.after(stop)
  await call('state')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connect = () => routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed'))
  const next = reader(await connect())
  assert.equal((await next()).event, 'hello')
  let closed = false
  const end = next().then(value => { closed = true; return value })
  t.mock.timers.tick(5_999)
  await Promise.resolve()
  assert.equal(closed, false)
  t.mock.timers.tick(1)
  assert.equal(await end, undefined)
  const reconnected = reader(await connect())
  assert.equal((await reconnected()).event, 'hello')
  t.mock.timers.tick(6_000)
  assert.equal(await reconnected(), undefined)
})

test('an already disconnected HTTP feed closes without waiting for its lifetime', async (t) => {
  const { stop, routes } = start()
  t.after(stop)
  const abort = new AbortController()
  abort.abort()
  const next = reader(await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal })))
  assert.equal((await next()).event, 'hello')
  assert.equal(await next(), undefined)
})

for (const scenario of ['chunk', 'start', 'end']) {
  test(`HTTP feed replays in-flight replies after a ${scenario} in the reconnect gap`, async (t) => {
    const { ctx, call, stop, routes } = start()
    t.after(stop)
    await call('state')
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const connect = async () => reader(await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed')))
    const onStream = ctx.listeners.get('agent/assistant-stream').at(-1)
    const emit = frame => onStream({ agent: { id: 'm1c' }, frame: { attemptId: 'gap', ...frame } })
    const first = await connect()
    assert.equal((await first()).event, 'hello')
    if (scenario !== 'start') {
      emit({ type: 'start', turn: 8 })
      assert.equal((await first()).data.phase, 'start')
      emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'Before' } })
      assert.equal((await first()).data.text, 'Before')
    }
    t.mock.timers.tick(6_000)
    assert.equal(await first(), undefined)
    if (scenario === 'start') emit({ type: 'start', turn: 8 })
    emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'Gap' } })
    if (scenario === 'end') emit({ type: 'end', outcome: { kind: 'abandoned' } })
    const next = await connect()
    assert.equal((await next()).event, 'hello')
    if (scenario !== 'end') {
      const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'gap' }
      assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'start' } })
      assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: scenario === 'chunk' ? 'BeforeGap' : 'Gap' } })
    }
    t.mock.timers.tick(6_000)
    assert.equal(await next(), undefined)
  })
}

for (const outcome of [{ kind: 'committed', eventType: 'assistant/message', seq: 101 }, { kind: 'committed', eventType: 'assistant/attempt', seq: 101 }, { kind: 'abandoned' }]) {
  test(`streaming survives HTTP feed rotation and cleans up ${outcome.eventType ?? outcome.kind} attempts`, async (t) => {
    const { ctx, call, stop, routes } = start()
    t.after(stop)
    await call('state')
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const connect = async () => reader(await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed')))
    const onStream = ctx.listeners.get('agent/assistant-stream').at(-1)
    const emit = frame => onStream({ agent: { id: 'm1c' }, frame: { attemptId: 'rotating', ...frame } })
    const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'rotating' }
    const first = await connect()
    assert.equal((await first()).event, 'hello')
    emit({ type: 'start', turn: 8 })
    assert.deepEqual(await first(), { event: 'stream', data: { ...target, phase: 'start' } })
    emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'Before' } })
    assert.deepEqual(await first(), { event: 'stream', data: { ...target, text: 'Before' } })
    t.mock.timers.tick(6_000)
    assert.equal(await first(), undefined)
    const second = await connect()
    assert.equal((await second()).event, 'hello')
    assert.deepEqual(await second(), { event: 'stream', data: { ...target, phase: 'start' } })
    assert.deepEqual(await second(), { event: 'stream', data: { ...target, text: 'Before' } })
    emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'After' } })
    assert.deepEqual(await second(), { event: 'stream', data: { ...target, text: 'After' } })
    emit({ type: 'end', outcome })
    assert.deepEqual(await second(), { event: 'stream', data: { ...target, phase: 'end' } })
    emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'Late' } })
    emit({ type: 'end', outcome })
    // A terminal frame without any connected client must also release its attempt.
    emit({ type: 'start', turn: 9 })
    assert.equal((await second()).data.phase, 'start')
    t.mock.timers.tick(6_000)
    assert.equal(await second(), undefined)
    emit({ type: 'end', outcome })
    const third = await connect()
    assert.equal((await third()).event, 'hello')
    emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'Late again' } })
    t.mock.timers.tick(6_000)
    assert.equal(await third(), undefined)
  })
}

test('state and live feed keep question, view, roomReport and imReplyOrigin routing metadata private', async (t) => {
  const imOrigin = { connId: 'private-connection', chatKey: 'private-chat', binding: 'room:r1' }
  const question = { id: 'q1', question: 'Which?', options: [{ label: 'A' }] }
  const view = { id: 'v1', title: 'Proceed?', view: { type: 'confirm', id: 'go' } }
  const { call, stop, routes } = start({
    team: {
      ...TEAM,
      questions: { m1c: { ...question, imOrigin } },
      views: { b2: { ...view, imOrigin } },
      roomReports: { rep1: { id: 'rep1', roomId: 'r1', botId: 'm1', name: 'Main', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: 1, imOrigin } },
      imReplyOrigins: { ex1: { ...imOrigin, at: Date.now() } },
    },
  })
  t.after(stop)
  const state = await call('state')
  assert.deepEqual(state.value.questions.m1c, question)
  assert.deepEqual(state.value.views.b2, view)
  assert.ok(!JSON.stringify(state).includes('imOrigin'))
  assert.ok(!JSON.stringify(state).includes('private-connection'))
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  const hello = await next()
  assert.equal(hello.event, 'hello')
  assert.ok(!JSON.stringify(hello).includes('imOrigin'))
  assert.ok(!JSON.stringify(hello).includes('private-connection'))
  const changed = await call('set-prefs', { motion: 'lively' })
  assert.ok(!JSON.stringify(changed).includes('imOrigin'))
  const revision = await next()
  assert.equal(revision.event, 'revision')
  assert.ok(!JSON.stringify(revision).includes('imOrigin'))
})

test('the live feed tells a window about saves, new chat entries and the reply being written', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const next = reader(response)
  assert.equal((await next()).event, 'hello')

  await call('set-prefs', { motion: 'lively' })
  const saved = await next()
  assert.equal(saved.event, 'revision')
  assert.equal(saved.data.revision > TEAM.revision, true)

  // The feed's own listener sits right before im's on session/event; the others need a live dsh.
  const onEvent = ctx.listeners.get('session/event').at(-2)
  onEvent({ id: 'm1c' }, userMessage('hello', 60))
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: { kind: 'user', text: 'hello', time: 60 } } })
  // A group Session or an earlier part is not a Bot's own chat now.
  onEvent({ id: 'm1' }, userMessage('old', 1))
  onEvent({ id: 'm1c' }, botMessage('hidden', 61, 7))

  const onStream = ctx.listeners.get('agent/assistant-stream').at(-1)
  const agent = { id: 'm1c' }
  onStream({ agent, frame: { type: 'start', attemptId: 'a7', turn: 7 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a7', chunk: { type: 'text-delta', text: 'hidden' } } })
  onStream({ agent, frame: { type: 'start', attemptId: 'a1', turn: 8 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: 'hmm' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'Hi ' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'there' } } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a1' } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a7' } })
  const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'a1' }
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'start' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'Hi ' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'there' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'end' } })

  // Status changes in a burst come as one notice.
  const onStatus = ctx.listeners.get('agent/status').at(-1)
  for (const id of ['b2', 'm1c', 'b2']) onStatus({ agent: { id }, status: 'running' })
  onStatus({ agent: { id: 'not-a-bot' }, status: 'running' })
  assert.deepEqual(await next(), { event: 'live', data: {} })

  abort.abort()
  assert.equal(await next(), undefined)
})

test('a DSH Agent Session changing status tells a window to read the live state', async (t) => {
  const agent = { id: 'a1', name: 'DSH Agent', sessions: ['s-agent'], createdAt: 4 }
  const { ctx, call, stop, routes } = start({ team: { ...TEAM, agents: { a1: agent } } })
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  ctx.listeners.get('agent/status').at(-1)({ agent: { id: agent.sessions[0] }, status: 'running' })
  assert.deepEqual(await next(), { event: 'live', data: {} })
  abort.abort()
})

test('a window that stops reading the feed is dropped', { timeout: 10_000 }, async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed'))
  const onEvent = ctx.listeners.get('session/event').at(-2)
  for (let index = 0; index < 1000; index += 1) onEvent({ id: 'm1c' }, userMessage(`line ${index}`, index))
  // What was queued before the drop still arrives, then the stream ends.
  const next = reader(response)
  let count = 0
  while (await next() !== undefined) count += 1
  assert.equal(count > 1 && count < 1000, true)
})

test('the chat endpoint pages a Bot\'s own chat from the newest part back', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const { call, stop } = start({
    pages: {
      'm1c:end': { records: [record(userMessage('second', 70), 41), record(botMessage('reply', 71), 42)], hasMore: true },
      'm1c:41': { records: [record(userMessage('first', 60), 40)], hasMore: false },
      'm1:end': { records: [record(userMessage('long ago', 5), 3)], hasMore: false },
    },
  })
  t.after(stop)
  await call('state')
  const first = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(first, {
    sessionId: 'm1c',
    items: [{ kind: 'user', text: 'second', time: 70, seq: 41 }, { kind: 'bot', text: 'reply', time: 71, seq: 42 }],
    cursor: { part: 1, beforeSeq: 41 },
  })
  // The current part's first message has the line that marks where the part began.
  const second = (await call('chat', { botId: 'm1', cursor: first.cursor })).value
  assert.deepEqual(second.items, [{ kind: 'divider', time: 50 }, { kind: 'user', text: 'first', time: 60, seq: 40 }])
  assert.deepEqual(second.cursor, { part: 0 })
  const third = (await call('chat', { botId: 'm1', cursor: second.cursor })).value
  assert.deepEqual([third.items, third.cursor], [[{ kind: 'user', text: 'long ago', time: 5, seq: 3 }], null])
  assert.equal((await call('chat', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('a show_view call in a part reads back as a view row with its blueprint', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const showView = (time, args) => ({ type: 'tool/call', time, data: { callId: 'c1', name: 'show_view', arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
  const { call, stop } = start({
    pages: {
      'm1c:end': {
        records: [
          record(userMessage('look', 70), 41),
          record(showView(71, { title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) } }), 42),
          // A view needs no title; a call the tool refused leaves no row. Other tools stay out too.
          record(showView(72, { view: { type: 'text', text: 'y' } }), 43),
          record(showView(72, { title: 'Refused', view: { type: 'nope' } }), 45),
          record({ type: 'tool/call', time: 73, data: { callId: 'c3', name: 'list_bots', arguments: '{}' } }, 44),
        ],
        hasMore: false,
      },
    },
  })
  t.after(stop)
  await call('state')
  const page = (await call('chat', { botId: 'm1' })).value
  const row = page.items.find(item => item.kind === 'view')
  assert.equal(row.title, 'A long note')
  assert.equal(row.callId, 'c1')
  assert.equal(row.view.children.length, 4)
  assert.equal(JSON.stringify(row.view).length > 7500, true)
  assert.deepEqual(page.items.map(item => item.kind), ['divider', 'user', 'view', 'view'])
  assert.equal(page.items.at(-1).title, '')
})

test('view replay omits hidden, refused and interactive calls in pages and the live feed', async (t) => {
  const view = { type: 'text', text: 'Visible' }
  const cases = [
    { turn: 7, arguments: { title: 'Hidden', view } },
    { arguments: { title: 'Refused wait', view, await_reply: true } },
    { arguments: { title: 'Too long', view: { type: 'text', text: 'x'.repeat(7800) } } },
    { arguments: { title: 'Interactive', view: { type: 'confirm', id: 'ok' } } },
    { arguments: '{invalid' },
    { arguments: { title: '  Accepted  ', view: { type: 'progress', percent: '40' } } },
  ]
  const events = cases.map((data, index) => ({
    type: 'tool/call', time: 70 + index, seq: 41 + index,
    data: { turn: 8, callId: `v${index}`, name: 'show_view', ...data },
  }))
  const { ctx, call, stop, routes } = start({ pages: { 'm1c:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const expected = { kind: 'view', title: 'Accepted', view: { type: 'progress', percent: 40 }, callId: 'v5', time: 75 }
  const page = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(page.items.filter(item => item.kind === 'view'), [expected])

  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  const onEvent = ctx.listeners.get('session/event').at(-2)
  for (const event of events) onEvent({ id: 'm1c' }, event)
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: expected } })
})

test('a display view is retained when its part becomes earlier history', async (t) => {
  const view = { type: 'text', text: 'From the first part' }
  const event = { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'old-view', name: 'show_view', arguments: JSON.stringify({ title: 'Earlier card', view }) } }
  const { call, stop } = start({ pages: { 'm1:end': { records: [{ event }], hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [{ kind: 'view', title: 'Earlier card', view, callId: 'old-view', time: 20 }])
})

test('a question or view card closed without an answer reads back in earlier history, including hidden turns; an answered one does not', async (t) => {
  const options = [{ label: 'Short' }, { label: 'Long' }]
  const pick = { type: 'options', id: 'lane', options: [{ label: 'Ship now' }] }
  const meter = { type: 'metric', label: 'Done', value: '3' }
  const events = [
    { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'q-closed', name: 'ask_user', arguments: JSON.stringify({ question: 'Which draft?', options }) } },
    { type: 'tool/call', time: 21, seq: 4, data: { turn: 1, callId: 'q-answered', name: 'ask_user', arguments: JSON.stringify({ question: 'Answered', options }) } },
    { type: 'tool/call', time: 22, seq: 5, data: { turn: 1, callId: 'v-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Pick a lane', view: pick }) } },
    { type: 'tool/call', time: 23, seq: 6, data: { turn: 2, callId: 'v-hidden-meter', name: 'show_view', arguments: JSON.stringify({ title: 'Hidden meter', view: meter }) } },
    { type: 'tool/call', time: 24, seq: 7, data: { turn: 2, callId: 'v-hidden-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Browser default?', view: pick }) } },
  ]
  const team = {
    ...TEAM,
    exchangeTurns: { ...TEAM.exchangeTurns, m1: [2] },
    closedCards: { m1: { 'q-closed': 'replied', 'v-closed': 'dismissed', 'v-hidden-closed': 'replied' } },
  }
  const { call, stop } = start({ team, pages: { 'm1:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [
    { kind: 'closed', closed: 'replied', question: { question: 'Which draft?', options, multiSelect: false }, callId: 'q-closed', time: 20 },
    { kind: 'closed', closed: 'dismissed', title: 'Pick a lane', view: pick, callId: 'v-closed', time: 22 },
    { kind: 'closed', closed: 'replied', title: 'Browser default?', view: pick, callId: 'v-hidden-closed', time: 24 },
  ])
})

test('the run-stats endpoint reads DSH\'s figures for the current part of a Bot\'s chat', async (t) => {
  const views = { sessionStats: { turns: 3 }, tokenUsage: { cacheReadTokens: 9 }, contextPressure: { contextWindow: 100 } }
  const read = []
  const sessionProjections = {
    snapshot: (session, keys) => {
      read.push([session.id, keys])
      return { asOfSeq: 7, values: views }
    },
  }
  const { call, stop } = start({ services: { sessionProjections } })
  t.after(stop)
  await call('state')
  assert.deepEqual((await call('run-stats', { botId: 'm1' })).value, views)
  assert.deepEqual(read, [['m1c', ['sessionStats', 'tokenUsage', 'contextPressure']]])
  assert.equal((await call('run-stats', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('without DSH\'s session projections the run-stats endpoint has nothing to show', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  await call('state')
  assert.deepEqual(await call('run-stats', { botId: 'm1' }), { ok: true, value: null })
})

test('HTTP feed clean rotation resumes with resumed: true and zero duplicate events, and replays gap events in order', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connect = (query = '', headers = {}) => routes['/api/bot/feed'].fetch(new Request(`http://localhost/api/bot/feed${query}`, { headers }))

  // Initial connect without cursor reports resumed: false and boot-scoped SSE id `<boot>:<seq>`.
  const first = reader(await connect(), { withId: true })
  const hello1 = await first()
  assert.equal(hello1.event, 'hello')
  assert.equal(hello1.data.resumed, false)
  assert.equal(Number.isSafeInteger(hello1.data.feedSeq), true)
  const boot = hello1.data.boot
  assert.equal(typeof boot, 'string')
  assert.equal(hello1.id, `${boot}:${hello1.data.feedSeq}`)

  // Rotate cleanly while idle: reconnect with ?after=&boot= returns resumed: true and replays nothing.
  t.mock.timers.tick(6_000)
  assert.equal(await first(), undefined)
  const second = reader(await connect(`?after=${hello1.data.feedSeq}&boot=${encodeURIComponent(boot)}`), { withId: true })
  const hello2 = await second()
  assert.equal(hello2.event, 'hello')
  assert.equal(hello2.data.resumed, true)
  assert.equal(hello2.data.feedSeq, hello1.data.feedSeq)
  assert.equal(hello2.id, `${boot}:${hello1.data.feedSeq}`)

  // Emit a live event while connected, then rotate and emit two events during the reconnect gap.
  const onEvent = ctx.listeners.get('session/event').at(-2)
  onEvent({ id: 'm1c' }, userMessage('before-gap', 60))
  const msg1 = await second()
  assert.equal(msg1.event, 'message')
  const seq1 = hello1.data.feedSeq + 1
  assert.equal(msg1.id, `${boot}:${seq1}`)

  t.mock.timers.tick(6_000)
  assert.equal(await second(), undefined)

  // Events occurring during the rotation gap must be retained and replayed on resume.
  await call('set-prefs', { motion: 'lively' })
  onEvent({ id: 'm1c' }, userMessage('during-gap', 61))

  // Reconnect using boot-scoped Last-Event-ID header (without query params) also resumes cleanly.
  const third = reader(await connect('', { 'Last-Event-ID': `${boot}:${seq1}` }), { withId: true })
  const hello3 = await third()
  assert.equal(hello3.event, 'hello')
  assert.equal(hello3.data.resumed, true)
  assert.equal(hello3.data.feedSeq, seq1)
  const missed1 = await third()
  const missed2 = await third()
  assert.equal(missed1.event, 'revision')
  assert.equal(missed1.id, `${boot}:${seq1 + 1}`)
  assert.equal(missed2.event, 'message')
  assert.equal(missed2.data.item.text, 'during-gap')
  assert.equal(missed2.id, `${boot}:${seq1 + 2}`)
  t.mock.timers.tick(6_000)
  assert.equal(await third(), undefined)
})

test('HTTP feed rejects boot-less or old-boot cursors after host restart (resumed: false)', async (t) => {
  // Host 1 starts and emits a boot-scoped id.
  const host1 = start()
  t.after(host1.stop)
  await host1.call('state')
  const first = reader(await host1.routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed')), { withId: true })
  const hello1 = await first()
  assert.equal(hello1.event, 'hello')
  const oldBoot = hello1.data.boot
  const oldSeq = hello1.data.feedSeq
  assert.equal(hello1.id, `${oldBoot}:${oldSeq}`)

  // Host 2 simulates a restart (new boot, feedSeq = 0).
  const host2 = start()
  t.after(host2.stop)
  await host2.call('state')
  const connect2 = (query = '', headers = {}) => host2.routes['/api/bot/feed'].fetch(new Request(`http://localhost/api/bot/feed${query}`, { headers }))

  // Bare numeric Last-Event-ID: 0 (no boot) must NOT resume across restart.
  const bareHeader = reader(await connect2('', { 'Last-Event-ID': String(oldSeq) }), { withId: true })
  const bareHello = await bareHeader()
  assert.equal(bareHello.event, 'hello')
  assert.equal(bareHello.data.resumed, false, 'boot-less Last-Event-ID must never return resumed: true')

  // Bare ?after=0 without boot query param must NOT resume.
  const bareQuery = reader(await connect2(`?after=${oldSeq}`), { withId: true })
  const bareQueryHello = await bareQuery()
  assert.equal(bareQueryHello.event, 'hello')
  assert.equal(bareQueryHello.data.resumed, false, 'boot-less ?after= must never return resumed: true')

  // Old boot Last-Event-ID from Host 1 must NOT resume on Host 2.
  const staleBoot = reader(await connect2('', { 'Last-Event-ID': `${oldBoot}:${oldSeq}` }), { withId: true })
  const staleHello = await staleBoot()
  assert.equal(staleHello.event, 'hello')
  assert.equal(staleHello.data.resumed, false, 'previous host boot id must never return resumed: true')
  assert.notEqual(staleHello.data.boot, oldBoot)
})

test('HTTP feed delivers full 512-event replay with concurrent live events without slow-consumer eviction', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connect = (query = '', headers = {}) => routes['/api/bot/feed'].fetch(new Request(`http://localhost/api/bot/feed${query}`, { headers }))

  const first = reader(await connect(), { withId: true })
  const hello1 = await first()
  const boot = hello1.data.boot
  const startSeq = hello1.data.feedSeq
  t.mock.timers.tick(6_000)
  assert.equal(await first(), undefined)

  // Fill the replay ring to its full 512-event capacity during the rotation gap.
  const onEvent = ctx.listeners.get('session/event').at(-2)
  for (let i = 1; i <= 512; i += 1) {
    onEvent({ id: 'm1c' }, userMessage(`replay-${i}`, 100 + i))
  }

  // Reconnect with full 512-event replay pending, and publish 5 concurrent live events BEFORE the reader pulls.
  const res = await connect(`?after=${startSeq}&boot=${encodeURIComponent(boot)}`)
  for (let i = 1; i <= 5; i += 1) {
    onEvent({ id: 'm1c' }, userMessage(`live-${i}`, 700 + i))
  }

  const next = reader(res, { withId: true })
  const resumedHello = await next()
  assert.equal(resumedHello.event, 'hello')
  assert.equal(resumedHello.data.resumed, true)
  assert.equal(resumedHello.data.feedSeq, startSeq)

  // Drain all 512 replayed events + 5 concurrent live events in strict FIFO order without premature disconnect.
  for (let i = 1; i <= 512; i += 1) {
    const ev = await next()
    assert.ok(ev, `replay event ${i} must not be dropped by slow-consumer eviction`)
    assert.equal(ev.event, 'message')
    assert.equal(ev.data.item.text, `replay-${i}`)
    assert.equal(ev.id, `${boot}:${startSeq + i}`)
  }
  for (let i = 1; i <= 5; i += 1) {
    const ev = await next()
    assert.ok(ev, `concurrent live event ${i} must arrive in order after full replay`)
    assert.equal(ev.event, 'message')
    assert.equal(ev.data.item.text, `live-${i}`)
    assert.equal(ev.id, `${boot}:${startSeq + 512 + i}`)
  }
  t.mock.timers.tick(6_000)
  assert.equal(await next(), undefined)
})

test('HTTP feed invalidates resume after 30s local disconnect outage even with zero intervening events', async (t) => {
  const { call, stop, routes } = start()
  t.after(stop)
  await call('state')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const connect = (query = '', headers = {}) => routes['/api/bot/feed'].fetch(new Request(`http://localhost/api/bot/feed${query}`, { headers }))

  const first = reader(await connect(), { withId: true })
  const hello1 = await first()
  const boot = hello1.data.boot
  const seq = hello1.data.feedSeq
  t.mock.timers.tick(6_000)
  assert.equal(await first(), undefined)

  // Stay disconnected for > 30s (past orphan workspace watch grace window) with zero events.
  t.mock.timers.tick(35_000)
  const afterOutage = reader(await connect(`?after=${seq}&boot=${encodeURIComponent(boot)}`), { withId: true })
  const helloAfter = await afterOutage()
  assert.equal(helloAfter.event, 'hello')
  assert.equal(helloAfter.data.resumed, false, 'outage beyond 30s must return resumed: false so watches and state refresh')
  t.mock.timers.tick(6_000)
})

test('HTTP feed reports resumed: false on sequence gap, future cursor, or mismatched boot', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connect = (query = '', headers = {}) => routes['/api/bot/feed'].fetch(new Request(`http://localhost/api/bot/feed${query}`, { headers }))

  const first = reader(await connect(), { withId: true })
  const hello1 = await first()
  const boot = hello1.data.boot
  const startSeq = hello1.data.feedSeq

  // Mismatched boot (e.g. after host restart) must never report resumed: true.
  const wrongBoot = reader(await connect(`?after=${startSeq}&boot=different-boot`), { withId: true })
  const wrongBootHello = await wrongBoot()
  assert.equal(wrongBootHello.event, 'hello')
  assert.equal(wrongBootHello.data.resumed, false)

  // Future cursor (after > current feedSeq) must report resumed: false.
  const future = reader(await connect(`?after=${startSeq + 999}&boot=${encodeURIComponent(boot)}`), { withId: true })
  const futureHello = await future()
  assert.equal(futureHello.event, 'hello')
  assert.equal(futureHello.data.resumed, false)

  // Overflow the replay ring (> 512 events) so startSeq is evicted -> resumed: false.
  const onEvent = ctx.listeners.get('session/event').at(-2)
  for (let i = 0; i < 600; i += 1) onEvent({ id: 'm1c' }, userMessage(`ev-${i}`, 100 + i))

  const gapped = reader(await connect(`?after=${startSeq}&boot=${encodeURIComponent(boot)}`), { withId: true })
  const gappedHello = await gapped()
  assert.equal(gappedHello.event, 'hello')
  assert.equal(gappedHello.data.resumed, false)
  assert.equal(gappedHello.data.feedSeq >= startSeq + 600, true)
  t.mock.timers.tick(6_000)
})

test('HTTP feed stamps per-seq block ordinal on multi-block messages including identical text blocks', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')

  const onEvent = ctx.listeners.get('session/event').at(-2)
  onEvent({ id: 'm1c' }, {
    type: 'assistant/message',
    seq: 42,
    time: 1200,
    data: {
      turn: 3,
      message: {
        content: [
          { type: 'text', text: 'Ready' },
          { type: 'tool-call', id: 'c1' },
          { type: 'text', text: 'Set' },
          { type: 'text', text: 'Ready' },
        ],
      },
    },
  })

  const frames = [await next(), await next(), await next()]
  assert.deepEqual(
    frames.map(f => [f.event, f.data.item.kind, f.data.item.seq, f.data.item.block, f.data.item.text]),
    [
      ['message', 'bot', 42, 0, 'Ready'],
      ['message', 'bot', 42, 1, 'Set'],
      ['message', 'bot', 42, 2, 'Ready'],
    ],
  )
})
