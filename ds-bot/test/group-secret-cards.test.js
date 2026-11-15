// Key cards in a group chat (batch two): the card waits in the group dock, the value
// never leaves the host, and the note comes back to the member's hidden group Session.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const VALUE = 'test-value-9f3a2b'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', instructions: '', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', instructions: '', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', instructions: '', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  views: {},
  roomCards: {},
  secretRequests: {},
  prefs: {},
  revision: 0,
})

async function start(t, { secrets } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-secrets-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  if (secrets !== undefined) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, secrets }))
  const ctx = fakeContext()
  const delivered = []
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  Object.assign(ctx, {
    provide() {},
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async id => ({
        agent: { session: { id, header: { id } }, followup(message) { delivered.push({ sessionId: id, message }) }, steer() {}, cancel() {} },
      }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => (rt.teamTools.find(d => d.name === name) ?? ctx.registeredTools.get(name)).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const view = async () => (await call('state', {})).value
  const begin = (sessionId) => {
    const message = delivered.filter(entry => entry.sessionId === sessionId && entry.message?.content?.some?.(block => block.type === 'text')).at(-1)?.message
      ?? { content: [{ type: 'text', text: '' }], source: {} }
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source ?? {} })
    return message
  }
  const finish = (sessionId, reply) => {
    if (reply !== undefined) emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    return () => result
  }
  const say = value => ({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
  await tool('list_bots', {}, 'a')
  return { ctx, rt, tool, call, view, delivered, emit, begin, finish, round, say, home }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')
const cardsOf = host => host.rt.state.roomCards?.r1 ?? []
const requestsOf = host => host.rt.state.secretRequests?.b ?? []

test('a key card asked in a group sits in the group queue, under the request id', async (t) => {
  const host = await start(t)
  let concluded = 0
  const answer = await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() { concluded += 1 } })
  assert.equal(concluded, 1)
  assert.match(answer, /waiting above the group's composer/)
  const cards = cardsOf(host)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'secret')
  assert.equal(cards[0].name, 'DEMO_TOKEN')
  assert.equal(cards[0].botId, 'b')
  assert.equal(cards[0].id, requestsOf(host)[0].id)
  assert.equal(host.rt.state.questions.gb, undefined)

  // Asking again for the same key replaces the card, never stacks it.
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'again' }, 'gb', { callId: 's2', concludeTurn() {} })
  const after = cardsOf(host)
  assert.equal(after.length, 1)
  assert.equal(requestsOf(host).filter(request => request.status === 'pending').length, 1)
  assert.equal(requestsOf(host).find(request => request.status === 'canceled').purpose, 'build')
})

test('the asking member\'s slot waits while the other members carry on', async (t) => {
  const host = await start(t)
  const done = host.round('c1', host.say('说方案'))
  await settle(() => host.delivered.some(entry => entry.sessionId === 'ga'))
  host.begin('ga')
  host.finish('ga', '我先说。')
  await settle(() => host.delivered.some(entry => entry.sessionId === 'gb'))
  host.begin('gb')
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  host.finish('gb', undefined)
  await settle(() => host.delivered.some(entry => entry.sessionId === 'gc'))
  const slots = host.rt.roomProgress.get('c1').slots.map(slot => [slot.id, slot.status])
  assert.deepEqual(slots, [['a', 'posted'], ['b', 'waiting-answer'], ['c', 'speaking']])
  const gcMessage = host.begin('gc')
  host.finish('gc', '我看行。')
  await settle(() => done() !== undefined)
  // The relay call returns its ledger anchor now; the waiting member is told in the
  // round brief instead (roomPrompt's waitingNames line), so a later round does not
  // read its silence as a pass.
  const gcText = (gcMessage?.content ?? []).find(block => block.type === 'text')?.text ?? ''
  assert.match(gcText, /Waiting for the user's answer to a question card: Writer\./)
})

test('saving the key keeps it for the asking Bot only and tells it in the group', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const requestId = requestsOf(host)[0].id
  const saved = await host.call('secret-set', { requestId, value: VALUE })
  assert.equal(saved.ok, true)
  assert.equal(host.rt.canUseSecret('DEMO_TOKEN', 'b'), true)
  // No scope was sent: a group card defaults to the Bot that asked, not the whole team.
  assert.equal(host.rt.canUseSecret('DEMO_TOKEN', 'a'), false)
  assert.equal(cardsOf(host).length, 0)
  const note = host.delivered.filter(entry => entry.sessionId === 'gb').at(-1)
  assert.equal(note.message.source.role, 'room')
  assert.equal(note.message.source.roomId, 'r1')
  assert.match(text(note.message), /The user saved DEMO_TOKEN/)
  const line = host.rt.state.rooms.r1.log.find(entry => entry.kind === 'answer')
  assert.equal(line.text, 'Key card answered: DEMO_TOKEN')
  // The value is nowhere in the card state or the group log.
  for (const value of [JSON.stringify(host.rt.state.roomCards), JSON.stringify(host.rt.state.rooms.r1.log)]) {
    assert.equal(value.includes(VALUE), false)
  }
})

test('a failed save puts the card and the key back', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const requestId = requestsOf(host)[0].id
  const realSave = host.rt.save
  host.rt.save = async () => { throw new Error('disk full') }
  const failed = await host.call('secret-set', { requestId, value: VALUE })
  host.rt.save = realSave
  assert.equal(failed.ok, false)
  assert.equal(requestsOf(host)[0].status, 'pending')
  assert.equal(cardsOf(host).length, 1)
  assert.deepEqual(host.rt.secretsView(), [])
  assert.equal(readFileSync(join(host.home, 'secrets.json'), 'utf8').includes(VALUE), false)
})

test('an allow card grants the asking Bot the key without touching its scope for others', async (t) => {
  const host = await start(t, {
    secrets: [{ name: 'SHARED_KEY', value: VALUE, purpose: 'p', scope: ['c'], requestedBy: 'c', createdAt: 1, updatedAt: 1 }],
  })
  await host.tool('request_secret', { name: 'SHARED_KEY', purpose: 'use it' }, 'gb', { callId: 's1', concludeTurn() {} })
  assert.equal(requestsOf(host)[0].kind, 'allow')
  const allowed = await host.call('secret-allow', { requestId: requestsOf(host)[0].id })
  assert.equal(allowed.ok, true)
  assert.equal(host.rt.canUseSecret('SHARED_KEY', 'b'), true)
  assert.equal(host.rt.canUseSecret('SHARED_KEY', 'a'), false)
  assert.equal(cardsOf(host).length, 0)
  assert.match(text(host.delivered.filter(entry => entry.sessionId === 'gb').at(-1).message), /The user let you use SHARED_KEY/)
})

test('canceling tells the member and leaves no card behind', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const canceled = await host.call('secret-cancel', { requestId: requestsOf(host)[0].id })
  assert.equal(canceled.ok, true)
  assert.equal(requestsOf(host)[0].status, 'canceled')
  assert.equal(cardsOf(host).length, 0)
  const note = host.delivered.filter(entry => entry.sessionId === 'gb').at(-1)
  assert.match(text(note.message), /The user canceled your request for DEMO_TOKEN/)
})

test('a key saved elsewhere settles the group card too, with its note in the group', async (t) => {
  const host = await start(t)
  // Writer waits in the group; Tester waits for the same key in its own chat.
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'group' }, 'gb', { callId: 's1', concludeTurn() {} })
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'own' }, 'c', { callId: 's2', concludeTurn() {} })
  const testerRequest = (host.rt.state.secretRequests.c ?? [])[0]
  const saved = await host.call('secret-set', { requestId: testerRequest.id, value: VALUE, scope: 'all' })
  assert.equal(saved.ok, true)
  assert.equal(requestsOf(host)[0].status, 'saved')
  assert.equal(cardsOf(host).length, 0)
  const note = host.delivered.filter(entry => entry.sessionId === 'gb').at(-1)
  assert.equal(note.message.source.roomId, 'r1')
  assert.match(text(note.message), /The user saved DEMO_TOKEN/)
})

test('deleting the group cancels a waiting key request and drops its card', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  await host.call('delete-room', { id: 'r1' })
  assert.equal(requestsOf(host)[0].status, 'canceled')
  assert.equal(host.rt.state.roomCards.r1, undefined)
})

test('a member removed from the group takes its waiting key request and card along', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const removed = await host.call('update-room', { id: 'r1', members: ['a', 'c'] })
  assert.equal(removed.ok, true)
  assert.equal(requestsOf(host)[0].status, 'canceled')
  assert.equal(host.rt.state.roomCards.r1, undefined)
})

test('a deleted Bot takes its waiting key request and card along', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal(host.rt.state.secretRequests.b, undefined)
  assert.equal(host.rt.state.roomCards.r1, undefined)
})

test('trim never evicts a group key card: the cap bends instead', async (t) => {
  const host = await start(t)
  // Twenty pending group requests, each with its mirror card: every one may still be answered.
  const now = Date.now()
  host.rt.state.secretRequests.b = Array.from({ length: 20 }, (_, at) => ({ id: `k${at}`, sessionId: 'gb', roomId: 'r1', name: `KEY_${at}`, purpose: 'p', kind: 'fill', status: 'pending', askedAt: now + at }))
  host.rt.state.roomCards.r1 = host.rt.state.secretRequests.b.map(request => ({ id: request.id, kind: 'secret', botId: 'b', roomId: 'r1', askedAt: request.askedAt, name: request.name, purpose: 'p', requestKind: 'fill' }))
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const list = requestsOf(host)
  assert.equal(list.length, 21)
  assert.equal(list.filter(request => request.status === 'pending').length, 21)
  assert.equal(cardsOf(host).length, 21)
  // The settled records go first: no group request is dropped while a plain one could be.
  assert.equal(list.some(request => request.status === 'canceled'), false)
})

test('trim drops an evicted record together with the card it still had', async (t) => {
  const host = await start(t)
  const now = Date.now()
  // A settled group record that kept its mirror card (a crash between the two writes can
  // leave exactly this shape). Trim must not leave the card behind, unanswerable.
  host.rt.state.secretRequests.b = [{ id: 'gone', sessionId: 'gb', roomId: 'r1', name: 'OLD_KEY', purpose: 'p', kind: 'fill', status: 'saved', askedAt: now, settledAt: now + 1 }]
  host.rt.state.roomCards.r1 = [{ id: 'gone', kind: 'secret', botId: 'b', roomId: 'r1', askedAt: now, name: 'OLD_KEY', purpose: 'p', requestKind: 'fill' }]
  for (let at = 0; at < 19; at += 1) {
    host.rt.state.secretRequests.b.push({ id: `k${at}`, sessionId: 'gb', roomId: 'r1', name: `KEY_${at}`, purpose: 'p', kind: 'fill', status: 'pending', askedAt: now + 2 + at })
    host.rt.state.roomCards.r1.push({ id: `k${at}`, kind: 'secret', botId: 'b', roomId: 'r1', askedAt: now + 2 + at, name: `KEY_${at}`, purpose: 'p', requestKind: 'fill' })
  }
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  assert.equal(requestsOf(host).some(request => request.id === 'gone'), false)
  assert.equal(cardsOf(host).some(card => card.id === 'gone'), false)
  assert.equal(cardsOf(host).length, 20)
})

test('a note for a member that already left is only warned about', async (t) => {
  const host = await start(t)
  const warnings = []
  host.rt.warn = (...args) => warnings.push(args)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'gb', { callId: 's1', concludeTurn() {} })
  const requestId = requestsOf(host)[0].id
  // The member's hidden group Session is gone, but its card still waits: the answer must
  // still save the key, and losing the note must not fail it.
  delete host.rt.state.rooms.r1.sessions.b
  const saved = await host.call('secret-set', { requestId, value: VALUE })
  assert.equal(saved.ok, true)
  assert.equal(host.rt.canUseSecret('DEMO_TOKEN', 'b'), true)
  assert.equal(requestsOf(host)[0].status, 'saved')
  assert.equal(cardsOf(host).length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /secret note to %s in %s failed/)
  assert.equal(warnings[0][1], 'b')
  assert.equal(host.delivered.filter(entry => entry.sessionId === 'gb').length, 0)
})

test('an own-chat key card keeps its own session and does not need a room', async (t) => {
  const host = await start(t)
  await host.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'b', { callId: 's1', concludeTurn() {} })
  const request = (host.rt.state.secretRequests.b ?? [])[0]
  assert.equal(request.roomId, undefined)
  assert.equal(request.sessionId, 'b')
  assert.equal(host.rt.state.roomCards.r1, undefined)
})
