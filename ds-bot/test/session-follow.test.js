import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { addressOf } from '../src/host/session-follow.js'
import { fakeContext } from './fake-ctx.js'

// What DSH 0.2.2-rc.1 streamed through api/bot/session on the mock model
// (dev/record-follow.mjs): a turn that thinks and a turn that calls a tool, then a
// reconnect opening and the page before it.
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/recorded/dsh-follow-0.2.2-rc.1.json', import.meta.url), 'utf8'))
const LIVE = RECORDED.live.map(({ data }) => data)

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  questions: {},
}

function start({ follow, page } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const asked = { follow: [], page: [] }
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 } } }),
    follow: (request, signal) => {
      asked.follow.push({ request, signal })
      return follow(request, signal)
    },
    events: async (request, signal) => {
      asked.page.push(request)
      return page(request, signal)
    },
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
  const open = (query, signal) => routes['/api/bot/session'].fetch(new Request(`http://localhost/api/bot/session?${query}`, { signal }))
  return { ctx, call, open, asked, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

async function* frames(list, signal, { hold = false } = {}) {
  for (const frame of list) yield frame
  if (hold) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
}

async function events(response) {
  const text = await response.text()
  return text.split('\n\n').filter(block => block.startsWith('event: ')).map((block) => {
    const [event, data] = block.split('\n')
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) }
  })
}

test('the recorded follow keeps DSH\'s promise: one opening, then every event in order, the reply alongside', () => {
  const [opening, ...rest] = LIVE
  assert.equal(opening.type, 'snapshot')
  assert.ok(opening.records.every(record => record.event.seq <= opening.cursor))
  // Durable events come gap-free after the opening's cursor.
  const seqs = rest.filter(frame => frame.type === 'event').map(frame => frame.event.seq)
  assert.deepEqual(seqs, seqs.map((_, index) => opening.cursor + 1 + index))
  // The reply being written: each attempt starts, streams its chunks densely, and ends on
  // the event it committed as.
  const stream = rest.filter(frame => frame.type === 'assistant-stream').map(frame => frame.frame)
  const kinds = new Set(stream.filter(frame => frame.type === 'chunk').map(frame => frame.chunk.type))
  for (const kind of ['reasoning-delta', 'text-delta', 'tool-call-delta']) assert.ok(kinds.has(kind), kind)
  for (const end of stream.filter(frame => frame.type === 'end')) {
    const chunks = stream.filter(frame => frame.type === 'chunk' && frame.attemptId === end.attemptId)
    assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index))
    assert.equal(end.index, chunks.length)
    assert.equal(end.outcome.kind, 'committed')
    assert.ok(seqs.includes(end.outcome.seq))
  }
  // Opened again, the window gets the newest window up to the last event, and the page
  // before it joins on without a gap.
  const again = RECORDED.reconnect[0].data
  assert.equal(again.cursor, seqs.at(-1))
  const pageSeqs = RECORDED.page.records.map(record => record.event.seq)
  assert.equal(pageSeqs.at(-1) + 1, again.records[0].event.seq)
})

test('a window following a Session gets DSH\'s frames as they are, then the end', async (t) => {
  const { open, asked, stop } = start({ follow: (request, signal) => frames(LIVE, signal) })
  t.after(stop)
  const response = await open('id=session-main&max=20')
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const got = await events(response)
  assert.deepEqual(got.slice(0, -1).map(({ data }) => data), LIVE)
  assert.ok(got.slice(0, -1).every(({ event }) => event === 'frame'))
  assert.deepEqual(got.at(-1), { event: 'end', data: {} })
  // A passive read, with the reply being written, of the window size asked for.
  assert.deepEqual(asked.follow[0].request, { address: { kind: 'session', sessionId: 'session-main' }, assistantStream: true, maxMessages: 20 })
})

test('a window that leaves stops the follow in DSH', async (t) => {
  const { open, asked, stop } = start({ follow: (request, signal) => frames(LIVE.slice(0, 1), signal, { hold: true }) })
  t.after(stop)
  const leave = new AbortController()
  const response = await open('id=session-main', leave.signal)
  const reader = response.body.getReader()
  await reader.read()
  leave.abort()
  await reader.cancel().catch(() => {})
  assert.equal(asked.follow[0].signal.aborted, true)
})

// DSH's RemoteError codes for an address it cannot serve (dsh-api-session-controller 0.2.2-rc.1).
const remote = (code, message) => Object.assign(new Error(message), { code })

test('what DSH refuses reaches the window as gone, turned away, or a failure', async (t) => {
  let failure
  const { open, call, stop } = start({ follow: () => (async function* () { throw failure })(), page: async () => { throw failure } })
  t.after(stop)
  const cases = [
    [new Error('session "gone" not found'), 'bot/not-found'],
    [remote('session/not-found', 'session "gone" not found'), 'bot/not-found'],
    [remote('subagent/not-found', 'subagent is unavailable'), 'bot/not-found'],
    [remote('subagent/unauthorized', 'subagent does not belong to the supplied parent'), 'bot/refused'],
    [remote('session/agent-busy', 'subagent Sessions require their durable parent address'), 'bot/refused'],
    [new TypeError('cannot read properties of undefined'), 'bot/internal'],
  ]
  for (const [error, code] of cases) {
    failure = error
    assert.deepEqual(await events(await open('id=s1')), [{ event: 'error', data: { code, message: error.message } }], error.message)
    assert.equal((await call('session-page', { sessionId: 's1' })).error.code, code, `page: ${error.message}`)
  }
})

test('unloading the plugin ends a follow that is open', async (t) => {
  const { ctx, open, asked, stop } = start({ follow: (request, signal) => frames(LIVE.slice(0, 1), signal, { hold: true }) })
  t.after(stop)
  const response = await open('id=session-main')
  const reader = response.body.getReader()
  await reader.read()
  await ctx.dispose()
  assert.equal(asked.follow[0].signal.aborted, true)
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) { /* the rest, then the close */ }
})

test('a request that names no Session, or a bad size, is refused before DSH is asked', async (t) => {
  const { open, asked, stop } = start({ follow: (request, signal) => frames([], signal) })
  t.after(stop)
  for (const query of ['', 'id=a/b', 'id=s1&max=-1', 'id=s1&max=0', 'id=s1&max=x', 'id=s1&after=-1', 'id=s1&after=x', 'id=s1&parent=..%2F', 'id=s1&parent=p1&mode=forever']) {
    const response = await open(query)
    assert.equal(response.status, 400, query)
    assert.equal((await response.json()).error.code, 'bot/invalid')
  }
  assert.equal(asked.follow.length, 0)
})


test('a reconnect fills a gap wider than the opening before the opening and live frames', async (t) => {
  const logEvents = Array.from({ length: 22 }, (_, seq) => ({ type: 'event', seq, time: seq, data: {} }))
  const record = event => ({ type: 'event', event })
  const opening = {
    type: 'snapshot',
    header: { id: 'session-main', cwd: '/bench' },
    cursor: 20,
    records: logEvents.slice(17, 21).map(record),
    hasMore: true,
    projections: { asOfSeq: 20, values: {} },
    assistantStream: { revision: 8 },
  }
  const live = { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', revision: 9, startedAfterSeq: 20, turn: 3, step: 1 } }
  const follow = async function* () {
    yield opening
    yield { type: 'event', event: logEvents[21] }
    yield live
  }
  const page = async ({ beforeSeq, throughSeq, maxMessages }) => {
    assert.equal(throughSeq, 20)
    const end = Math.max(0, beforeSeq - 1)
    const start = Math.max(0, end - maxMessages + 1)
    return { cursor: 20, records: logEvents.slice(start, end + 1).map(record), hasMore: start > 0 }
  }
  const { open, asked, stop } = start({ follow, page })
  t.after(stop)
  const got = await events(await open('id=session-main&max=4&after=10'))
  assert.deepEqual(got.filter(({ event }) => event === 'frame').map(({ data }) => data), [
    ...logEvents.slice(11, 17).map(event => ({ type: 'event', event })),
    opening,
    { type: 'event', event: logEvents[21] },
    live,
  ])
  assert.deepEqual(asked.page.map(({ beforeSeq }) => beforeSeq), [17, 13])
})

test('a gap far beyond the live queue follows consumer backpressure without truncating', async (t) => {
  const total = 1600
  const boundary = 1551
  const eventAt = seq => ({ type: 'event', seq, time: seq, data: {} })
  const record = event => ({ type: 'event', event })
  const opening = {
    type: 'snapshot',
    header: { id: 'session-main', cwd: '/bench' },
    cursor: total,
    records: Array.from({ length: total - boundary + 1 }, (_, index) => record(eventAt(boundary + index))),
    hasMore: true,
    projections: { asOfSeq: total, values: {} },
    assistantStream: { revision: 1 },
  }
  const follow = async function* () {
    yield opening
    yield { type: 'event', event: eventAt(total + 1) }
  }
  const page = async ({ beforeSeq, throughSeq, maxMessages }) => {
    assert.equal(throughSeq, total)
    const end = Math.max(0, beforeSeq - 1)
    const start = Math.max(0, end - maxMessages + 1)
    return { cursor: total, records: Array.from({ length: end - start + 1 }, (_, index) => record(eventAt(start + index))), hasMore: start > 0 }
  }
  const { open, stop } = start({ follow, page })
  t.after(stop)
  const response = await open('id=session-main&max=100&after=0')
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    // A slow window must not turn the finite catch-up into the live-output drop guard.
    await new Promise(resolve => setTimeout(resolve, 1))
    text += decoder.decode(chunk.value, { stream: true })
  }
  const got = text.split('\n\n').filter(block => block.startsWith('event: ')).map((block) => {
    const [event, data] = block.split('\n')
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) }
  })
  const frames = got.filter(({ event }) => event === 'frame').map(({ data }) => data)
  assert.equal(frames.length, boundary - 1 + 2, 'gap frames, opening snapshot, and the first live event all arrive')
  assert.equal(frames[0].event.seq, 1)
  assert.equal(frames[boundary - 2].event.seq, boundary - 1)
  assert.equal(frames[boundary - 1].type, 'snapshot')
  assert.equal(frames.at(-1).event.seq, total + 1)
  assert.deepEqual(got.at(-1), { event: 'end', data: {} })
})

test('paged catch-up that does not move backwards is stale instead of looping', async (t) => {
  const opening = {
    type: 'snapshot',
    header: { id: 'session-main', cwd: '/bench' },
    cursor: 10,
    records: [{ type: 'event', event: { type: 'event', seq: 10, time: 10, data: {} } }],
    hasMore: true,
  }
  const follow = async function* () { yield opening }
  const repeated = { type: 'event', seq: 9, time: 9, data: {} }
  const page = async () => ({ cursor: 10, records: [{ type: 'event', event: repeated }], hasMore: true })
  const { open, asked, stop } = start({ follow, page })
  t.after(stop)
  const got = await events(await open('id=session-main&max=4&after=0'))
  assert.equal(got.length, 1)
  assert.equal(got[0].event, 'error')
  assert.equal(got[0].data.code, 'bot/stale')
  assert.equal(asked.page.length, 2, 'the second repeated page proves the cut did not advance')
})

test('a subagent\'s Session is read under its parent', () => {
  assert.deepEqual(addressOf({ sessionId: 'child', parent: 'p1', mode: 'one-shot' }), { kind: 'subagent', parentSessionId: 'p1', childSessionId: 'child', mode: 'one-shot' })
  assert.equal(addressOf({ sessionId: 'child', parent: 'p1' }).mode, 'unknown')
  assert.throws(() => addressOf({ sessionId: 'child', parent: 'p1', mode: 'other' }), /subagent mode/)
})

test('session-page reads an earlier page through the channel', async (t) => {
  const { call, asked, stop } = start({ page: async () => RECORDED.page })
  t.after(stop)
  const answer = await call('session-page', { sessionId: 'session-main', beforeSeq: 23, maxMessages: 4 })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, RECORDED.page)
  assert.deepEqual(asked.page[0], { address: { kind: 'session', sessionId: 'session-main' }, beforeSeq: 23, maxMessages: 4 })
  for (const bad of [{ beforeSeq: 1.5 }, { maxMessages: 0 }, { throughSeq: -2 }]) {
    assert.equal((await call('session-page', { sessionId: 'session-main', ...bad })).error.code, 'bot/invalid', JSON.stringify(bad))
  }
  // -1 is DSH's empty cut.
  assert.equal((await call('session-page', { sessionId: 'session-main', throughSeq: -1 })).ok, true)
  assert.equal(asked.page.at(-1).throughSeq, -1)
  assert.equal((await call('session-nope', {})).error.code, 'bot/not-found')
})
