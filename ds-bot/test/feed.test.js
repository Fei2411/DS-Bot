import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function start({ pages = {}, services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-feed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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

// Reads Server-Sent Events off a response, one `{ event, data }` per call.
function reader(response) {
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
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

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

  // The feed's own listener is the last on session/event; the others need a live dsh.
  const onEvent = ctx.listeners.get('session/event').at(-1)
  onEvent({ id: 'm1c' }, userMessage('hello', 60))
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: { kind: 'user', text: 'hello', time: 60 } } })
  // A group Session or an earlier part is not a Bot's own chat now.
  onEvent({ id: 'm1' }, userMessage('old', 1))
  onEvent({ id: 'm1c' }, botMessage('hidden', 61, 7))

  const [onStream] = ctx.listeners.get('agent/assistant-stream')
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

test('live feed cancellation survives garbage collection of the request caller', () => {
  execFileSync(process.execPath, ['--expose-gc', '--import', new URL('./harness-resolve.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/feed-gc.mjs', import.meta.url))], { timeout: 5000 })
})

test('an already cancelled request cannot leave a live feed behind', { timeout: 5000 }, async t => {
  const { call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  abort.abort()
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  assert.equal(await next(), undefined)
})

test('a window that stops reading the feed is dropped', { timeout: 10_000 }, async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed'))
  const onEvent = ctx.listeners.get('session/event').at(-1)
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
  const onEvent = ctx.listeners.get('session/event').at(-1)
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
