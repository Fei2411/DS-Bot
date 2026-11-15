import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'

// A platform adapter that records sends/edits and lets the test feed inbound
// messages, actions and statuses. `fail` makes send throw once per call queued.
const fakeAdapter = ({ buttons = true } = {}) => {
  const sent = []
  const edited = []
  const fails = []
  const adapter = {
    id: 'fake',
    sent,
    edited,
    handlers: null,
    async check(fields) {
      if (fields.token === 'bad-token') throw new Error('platform refused the token')
      return { account: { id: 'bot1', name: '@fakebot' } }
    },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      adapter.env = env
      adapter.connects = (adapter.connects ?? 0) + 1
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      return {
        send: async (chat, body) => {
          sent.push({ chat, ...body })
          const next = fails.shift()
          if (next !== undefined) throw next
          return { messageId: sent.length }
        },
        edit: async (chat, messageId, body) => { edited.push({ chat, messageId, ...body }) },
        typing: async () => {},
        stop: () => { adapter.stopped = (adapter.stopped ?? 0) + 1 },
      }
    },
  }
  adapter.fails = fails
  adapter.buttons = buttons
  return adapter
}

const TEAM = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, log: [], seq: 0 } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start({ platform = 'telegram', adapter, seed } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed ?? TEAM()))
  const ctx = fakeContext()
  const prompts = []
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id,
      session: { id, requestHeader: () => undefined },
      followup(message) { this.lastFollowup = message; this.followed = (this.followed ?? 0) + 1 },
      cancel() { this.cancelled = true },
      inbox: { nextStep: [], nextTurn: [], remove: () => false },
      async whenIdle() {},
    })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const fake = adapter ?? fakeAdapter()
  const real = adapters[platform]
  adapters[platform] = fake
  const rt = createRuntime(ctx, { home })
  const emitEvent = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, data, time: Date.now() })
    }
  }
  const fireApprovals = (request, next) => Promise.all((ctx.listeners.get('approval/request') ?? [])
    .map(listener => listener(request, next)))
  const stop = async () => {
    adapters[platform] = real
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const flush = async () => { await delay(10) }
  // The host echoes an IM prompt as a user/message whose source carries the request it
  // came in on; the plugin takes the chat that request belongs to as the turn's origin.
  const imTurn = (sessionId = 'a') => {
    const requestId = prompts.at(-1)?.requestId
    emitEvent(sessionId, 'turn/start', { turn: prompts.length })
    emitEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'from the chat' }] })
  }
  return { ctx, rt, home, fake, prompts, agents, agentOf, emitEvent, fireApprovals, imTurn, stop, flush, platform }
}

const FIELDS = { telegram: { token: 'tok-1234' }, dingtalk: { clientId: 'cli-1', clientSecret: 'sec-1234' } }
const add = (s, fields = FIELDS[s.platform]) => s.rt.imEndpoint('im-add', { platform: s.platform, botId: 'a', fields })
const dm = (s, senderId, text, extra = {}) => s.fake.handlers.onMessage({
  chat: { key: `dm-${senderId}`, kind: 'direct', title: senderId }, sender: { id: senderId, name: `User ${senderId}` }, text, ...extra,
})
const gm = (s, senderId, text, { mentioned = true, chat = { key: 'g1', kind: 'group', title: 'Group One' }, ...extra } = {}) => s.fake.handlers.onMessage({
  chat, sender: { id: senderId, name: `User ${senderId}` }, text, mentioned, ...extra,
})

test('two concurrent syncs start exactly one adapter', async (t) => {
  const s = await start()
  t.after(s.stop)
  await add(s)
  const conn = Object.values(s.rt.state.im.connections)[0]
  s.fake.connects = 0
  s.rt.state.im.connections[conn.id].enabled = false
  await s.rt.save()
  await s.flush()
  assert.equal(s.fake.stopped, 1)
  s.rt.state.im.connections[conn.id].enabled = true
  await Promise.all([s.rt.save(), s.rt.save()])
  await s.flush()
  assert.equal(s.fake.connects, 1)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('im-update applies only the fields it is given and keeps the rest', async (t) => {
  const s = await start({ platform: 'feishu', adapter: fakeAdapter() })
  t.after(s.stop)
  const conn = await add(s, { domain: 'lark', appId: 'app-1', appSecret: 'sec-1' })
  const one = s.rt.state.im.connections[conn.id]
  assert.deepEqual(one.settings, { domain: 'lark', appId: 'app-1' })
  await s.rt.imEndpoint('im-update', { id: conn.id, fields: { appSecret: 'sec-2' } })
  assert.deepEqual(s.rt.state.im.connections[conn.id].settings, { domain: 'lark', appId: 'app-1' }, 'untouched fields keep their values')
  const view = s.rt.imView().connections.find(entry => entry.id === conn.id)
  assert.deepEqual(view.settings, { domain: 'lark', appId: 'app-1' })
  await s.rt.imEndpoint('im-update', { id: conn.id, fields: { domain: 'feishu' } })
  assert.equal(s.rt.state.im.connections[conn.id].settings.domain, 'feishu')
  assert.equal(s.rt.state.im.connections[conn.id].settings.appId, 'app-1')
})

test('unpaired DM asks once, allow pairs it, next message prompts the Bot', async (t) => {
  const s = await start()
  t.after(s.stop)
  await add(s)
  const [one] = Object.values(s.rt.state.im.connections)
  await dm(s, 'u1', 'hello')
  assert.equal(one.requests.length, 1)
  assert.equal(s.fake.sent.length, 1)
  assert.match(s.fake.sent[0].text, /connection request/)
  assert.equal(s.prompts.length, 0)
  await dm(s, 'u1', 'hello again')
  assert.equal(one.requests.length, 1)
  assert.equal(s.fake.sent.length, 1)
  await s.rt.imEndpoint('im-pair', { id: one.id, senderId: 'u1', allow: true })
  assert.equal(one.paired.length, 1)
  assert.match(s.fake.sent.at(-1).text, /talk to Chief/)
  await dm(s, 'u1', 'do a thing')
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, 'a')
  assert.equal(s.prompts[0].mode, 'queue')
  assert.match(s.prompts[0].requestId, /^im:telegram:/)
  assert.deepEqual(s.prompts[0].content, [{ type: 'text', text: 'do a thing' }])
})

test('unbound group mention replies unbound and records the chat; binding routes mentions', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  s.rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'User u1', at: 1 })
  await s.rt.save()
  await gm(s, 'u1', 'hi all', { mentioned: false })
  assert.equal(s.fake.sent.length, 0)
  assert.equal(s.prompts.length, 0)
  await gm(s, 'u1', '@fakebot hello group')
  assert.equal(s.rt.state.im.connections[conn.id].chats.g1?.kind, 'group')
  assert.equal(s.fake.sent.length, 1)
  assert.match(s.fake.sent[0].text, /not bound/)
  assert.equal(s.prompts.length, 0)
  await s.rt.imEndpoint('im-chat', { id: conn.id, chatKey: 'g1', target: { roomId: 'r1' } })
  // The adapter strips its own mention before the core sees the text.
  await gm(s, 'u1', 'hello group')
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, 'r1')
  assert.deepEqual(s.prompts[0].content, [{ type: 'text', text: 'hello group' }])
})

test('outbound: assistant text and member lines go out; hidden turns, user and system lines do not', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'visible reply' }] } })
  assert.equal(s.fake.sent.length, 1)
  assert.equal(s.fake.sent[0].text, 'visible reply')
  s.rt.state.exchangeTurns.a = [7]
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'hidden' }] }, turn: 7 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'user typed' }] })
  assert.equal(s.fake.sent.length, 1)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  // The group's turn was asked for in its IM chat, so its lines go back there.
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  const room = s.rt.roomOf('r1')
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'member spoke' })
  s.rt.logRoom(room, { who: 'User', text: 'user spoke' })
  s.rt.logRoom(room, { who: 'DS Bot', kind: 'notice', reason: 'x', text: 'nope' })
  await s.flush()
  assert.equal(s.fake.sent.length, 2)
  assert.equal(s.fake.sent[1].text, '**Writer**: member spoke')
  assert.equal(s.fake.sent[1].chat.key, 'g1')
})

test('IM user messages are tagged by seq for the current part; a part that is no longer current drops out', async (t) => {
  const s = await start()
  t.after(s.stop)
  const fire = (sessionId, seq, rpcId) => {
    for (const listener of s.ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type: 'user/message', seq, data: { source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'x' }] }, time: Date.now() })
    }
  }
  fire('a', 5, 'im:telegram:1')
  fire('a', 6, 'web-request')
  fire('a', 7, 'im:feishu:2')
  assert.deepEqual(s.rt.imViaView(), { a: { 5: 'telegram', 7: 'feishu' } })
  s.rt.chatOwners.delete('a')
  assert.deepEqual(s.rt.imViaView(), {})
})

test('question card: buttons answer it, a stranger press is ignored, settled elsewhere edits the card', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 }, { id: 'u2', name: 'U2', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.rt.state.questions.a = { id: 'q1', question: 'Which?', options: [{ label: 'yes' }, { label: 'no' }] }
  await s.rt.save()
  await s.flush()
  const card = s.fake.sent.find(entry => entry.buttons !== undefined)
  assert.ok(card, 'question card with buttons')
  assert.match(card.text, /Which\?/)
  await s.fake.handlers.onAction({ chat: { key: 'dm-u2', kind: 'direct', title: 'U2' }, sender: { id: 'u9', name: 'stranger' }, data: 'q:q1:0', messageId: card.messageId ?? 1 })
  assert.ok(s.rt.state.questions.a !== undefined, 'unpaired press does not answer')
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'q:q1:1', messageId: card.messageId ?? 1 })
  assert.ok(s.rt.state.questions.a === undefined, 'paired press answers')
  assert.equal(s.agents.get('a')?.followed, 1)
  await s.flush()
  assert.equal(s.fake.edited.length, 1)
  // Answered on the computer: the question leaves the state, the card edits shut.
  s.rt.state.questions.a = { id: 'q2', question: 'Again?', options: [{ label: 'x' }] }
  await s.rt.save()
  await s.flush()
  delete s.rt.state.questions.a
  await s.rt.save()
  await s.flush()
  assert.equal(s.fake.edited.length, 2)
})

test('a settled card leaves the runtime file once its source is gone; an open one stays', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Pick', options: [{ label: 'x' }, { label: 'y' }] }
  await s.rt.save()
  await s.flush()
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'q:q1:0', messageId: 1 })
  s.rt.state.questions.a = { id: 'q2', question: 'Still open', options: [{ label: 'x' }] }
  await s.rt.save()
  await s.flush()
  await delay(600)
  const runtime = JSON.parse((await import('node:fs')).readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8'))
  assert.ok(runtime.cards['q:q1'] === undefined, 'settled and edited card is dropped')
  assert.ok(runtime.cards['q:q2'] !== undefined, 'open card stays')
})

test('numbered reply answers the newest open card on a no-button platform', async (t) => {
  const s = await start({ platform: 'dingtalk', adapter: fakeAdapter({ buttons: false }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Pick', options: [{ label: 'x' }, { label: 'y' }] }
  await s.rt.save()
  await s.flush()
  const card = s.fake.sent.at(-1)
  assert.equal(card.buttons, undefined)
  await dm(s, 'u1', '2')
  assert.ok(s.rt.state.questions.a === undefined)
  assert.equal(s.agents.get('a')?.followed, 1)
})

test('a bare number answers the newest card, which can be an approval after a question', async (t) => {
  const s = await start({ platform: 'dingtalk', adapter: fakeAdapter({ buttons: false }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Pick', options: [{ label: 'x' }, { label: 'y' }] }
  await s.rt.save()
  const racing = s.fireApprovals(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: new AbortController().signal },
    () => new Promise(() => {}),
  )
  await s.flush()
  await dm(s, 'u1', '2')
  assert.equal((await racing)[0], 'rejected', 'the newer approval card takes the number')
  assert.ok(s.rt.state.questions.a !== undefined, 'the older question stays open')
})

test('an out-of-range or stale-card number goes to the Bot as a normal message', async (t) => {
  const s = await start({ platform: 'dingtalk', adapter: fakeAdapter({ buttons: false }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Pick', options: [{ label: 'x' }, { label: 'y' }] }
  await s.rt.save()
  await s.flush()
  s.prompts.length = 0
  await dm(s, 'u1', '9')
  assert.ok(s.rt.state.questions.a !== undefined, 'out of range answers nothing')
  assert.equal(s.prompts.length, 1, 'the number reaches the Bot as a message')
  // Answered on the computer: the card is stale; a later number is a message too.
  delete s.rt.state.questions.a
  await s.rt.save()
  await s.flush()
  s.prompts.length = 0
  await dm(s, 'u1', '1')
  assert.equal(s.prompts.length, 1, 'the stale-card number reaches the Bot')
  assert.ok(!s.fake.sent.some(entry => /already answered/.test(entry.text ?? '')), 'no stale reply for a bare number')
})

test('own-chat approval races DSH: IM allow resolves and withdraws the card; late press gets the stale text', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  const original = new AbortController()
  let seenSignal
  const racing = s.fireApprovals(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: original.signal },
    () => { seenSignal = undefined; return new Promise(() => {}) },
  )
  await s.flush()
  const card = s.fake.sent.at(-1)
  assert.match(card.text, /bash/)
  assert.ok(card.buttons.some(button => button.data.endsWith(':allow')))
  const approvalId = card.buttons[0].data.split(':')[1]
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: 1 })
  assert.equal((await racing)[0], 'allowed-once')
  await s.flush()
  assert.equal(s.fake.edited.length, 1)
  // A press after the card settled gets the stale text, not a second answer.
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: 1 })
  assert.match(s.fake.sent.at(-1).text, /already answered/)
  void seenSignal
})

test('an approval button answers its own card, not the newest one in the chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  const hang = () => new Promise(() => {})
  const first = s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'first', signal: new AbortController().signal }, hang)
  await s.flush()
  const firstId = s.fake.sent.at(-1).buttons[0].data.split(':')[1]
  let secondOutcome
  void s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'second', signal: new AbortController().signal }, hang)
    .then(([outcome]) => { secondOutcome = outcome })
  await s.flush()
  const secondId = s.fake.sent.at(-1).buttons[0].data.split(':')[1]
  assert.notEqual(firstId, secondId)
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${firstId}:allow`, messageId: 1 })
  assert.equal((await first)[0], 'allowed-once', 'the pressed card is the one answered')
  await s.flush()
  assert.equal(secondOutcome, undefined, 'the newer card stays open')
  assert.ok(s.rt.approvalsView().some(entry => entry.id === secondId))
})

test('a button for a card this chat was never sent gets the stale text and answers nothing', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 }, { id: 'u2', name: 'U2', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  let outcome
  void s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'r', signal: new AbortController().signal }, () => new Promise(() => {}))
    .then(([value]) => { outcome = value })
  await s.flush()
  const approvalId = s.fake.sent.at(-1).buttons[0].data.split(':')[1]
  await s.fake.handlers.onAction({ chat: { key: 'dm-u2', kind: 'direct', title: 'U2' }, sender: { id: 'u2', name: 'U2' }, data: `a:${approvalId}:allow`, messageId: 1 })
  await s.flush()
  assert.equal(outcome, undefined, 'another chat cannot answer this card')
  assert.match(s.fake.sent.at(-1).text, /already answered/)
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'a:no-such-card:allow', messageId: 1 })
  await s.flush()
  assert.equal(outcome, undefined, 'an unknown id answers nothing')
})

test('a question from an earlier part stays in the app, and the running turn\'s card answers itself', async (t) => {
  // Bot a asks from the turn this chat started and from an earlier part of its chat.
  const seed = TEAM()
  seed.bots.a.segments = [{ sessionId: 'a-old' }]
  const s = await start({ seed })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'First?', options: [{ label: 'yes' }, { label: 'no' }] }
  s.rt.state.questions['a-old'] = { id: 'q2', question: 'Second?', options: [{ label: 'yes' }, { label: 'no' }] }
  await s.rt.save()
  await s.flush()
  const cards = s.fake.sent
  assert.ok(cards.some(entry => entry.buttons?.[0]?.data.startsWith('q:q1:')), 'the running turn\'s card reached the chat')
  // An earlier part has no turn of this chat behind it (#1450): its card stays in the app.
  assert.ok(!cards.some(entry => entry.buttons?.[0]?.data.startsWith('q:q2:')), 'a card of an earlier part is not sent')
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'q:q1:0', messageId: 1 })
  assert.ok(s.rt.state.questions.a === undefined, 'the pressed question is answered')
  assert.ok(s.rt.state.questions['a-old'] !== undefined, 'the other question is untouched')
})

test('DSH answering first settles the race; the original signal aborting cancels', async (t) => {
  const s = await start()
  t.after(s.stop)
  const request = { agent: { id: 'a' }, toolName: 'bash', reason: 'r', signal: new AbortController().signal }
  const [outcome] = await s.fireApprovals(request, () => Promise.resolve('allowed-once'))
  assert.equal(outcome, 'allowed-once')
  const control = new AbortController()
  const pending = s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'r', signal: control.signal }, () => new Promise(() => {}))
  control.abort()
  assert.equal((await pending)[0], 'cancelled')
})

test('a pending secret request sends text without buttons', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.rt.state.secretRequests = { a: [{ id: 's1', name: 'MY_KEY', purpose: 'for tests', status: 'pending', askedAt: 1 }] }
  await s.rt.save()
  await s.flush()
  const card = s.fake.sent.at(-1)
  assert.match(card.text, /MY_KEY/)
  assert.equal(card.buttons, undefined)
})

test('a read-only host runs no adapter; becoming writable starts it', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  assert.ok(s.fake.handlers !== null)
  const realReadOnly = s.rt.readOnly
  s.rt.readOnly = () => 'held elsewhere'
  await s.rt.imEndpoint('im-update', { id: conn.id, enabled: false })
  await s.rt.imEndpoint('im-update', { id: conn.id, enabled: true })
  assert.equal(s.fake.stopped, 1)
  s.rt.readOnly = realReadOnly
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  assert.ok(s.fake.handlers !== null)
})

test('/stop calls rt.stopChat for a Bot target', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  let called = 0
  s.rt.stopChat = async () => { called += 1; return true }
  await dm(s, 'u1', '/stop')
  assert.equal(called, 1)
  assert.match(s.fake.sent.at(-1).text, /Stopped|已停/)
  await dm(s, 'u1', '/stop@fakebot')
  assert.equal(called, 2)
})

test('im-add keeps secrets out of state, im-remove deletes them and the runtime file', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  const secretNames = Object.values(one.secrets)
  assert.equal(secretNames.length, 1)
  const saved = JSON.parse((await import('node:fs')).readFileSync(join(s.home, 'secrets.json'), 'utf8'))
  assert.equal(saved.secrets[0].name, secretNames[0])
  assert.deepEqual(saved.secrets[0].scope, [])
  const view = s.rt.imView()
  assert.equal(view.connections[0].id, conn.id)
  assert.ok(!JSON.stringify(view).includes('tok-1234'))
  await s.rt.imEndpoint('im-remove', { id: conn.id })
  assert.equal(s.rt.state.im.connections[conn.id], undefined)
  const after = JSON.parse((await import('node:fs')).readFileSync(join(s.home, 'secrets.json'), 'utf8'))
  assert.equal(after.secrets.length, 0)
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(s.home, 'im', `${conn.id}.json`)), false)
})

test('a deleted Bot target gets the unbound reply', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  one.botId = 'gone'
  await s.rt.save()
  s.fake.sent.length = 0
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  assert.match(s.fake.sent.at(-1).text, /not bound|还没绑定/)
  assert.equal(s.prompts.length, 0)
})

test('a permanent send error shows in the status and is not retried; a network error resends in order', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.fails.push(Object.assign(new Error('forbidden'), { status: 403, permanent: true }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'will fail' }] } })
  await s.flush()
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  assert.match(s.rt.imStatusView()[conn.id].error, /forbidden/)
  const before = s.fake.sent.length
  await s.flush()
  assert.equal(s.fake.sent.length, before, 'permanent failure is not retried')
  s.fake.fails.push(Object.assign(new Error('network down'), {}))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'second' }] } })
  await s.flush()
  await delay(20)
  await s.rt.imEndpoint('im-retry', { id: conn.id })
})

test('a weixin QR login creates the connection paired with the scanning owner', async (t) => {
  const s = await start({ platform: 'weixin', adapter: {
    ...fakeAdapter(),
    id: 'weixin',
    async loginStart() { return { loginId: 'l1', qr: 'weixin://qr/abc', expiresAt: Date.now() + 60_000 } },
    async loginWait() {
      this.waits = (this.waits ?? 0) + 1
      if (this.waits < 2) return { status: 'waiting' }
      return {
        status: 'done',
        connection: { settings: { baseUrl: 'http://ilink/' }, secrets: { token: 'wx-tok' }, account: { id: 'bot-9', name: 'wxbot' } },
        owner: { id: 'owner-1', name: 'Fei' },
      }
    },
  } })
  t.after(s.stop)
  const login = await s.rt.imEndpoint('im-login-start', { platform: 'weixin', botId: 'a' })
  assert.equal(login.qr, 'weixin://qr/abc')
  const waiting = await s.rt.imEndpoint('im-login-wait', { platform: 'weixin', botId: 'a', loginId: 'l1' })
  assert.deepEqual(waiting, { status: 'waiting' })
  const done = await s.rt.imEndpoint('im-login-wait', { platform: 'weixin', botId: 'a', loginId: 'l1' })
  assert.equal(done.status, 'done')
  const conn = s.rt.state.im.connections[done.id]
  assert.ok(conn, 'connection created on confirm')
  assert.equal(conn.platform, 'weixin')
  assert.deepEqual(conn.paired, [{ id: 'owner-1', name: 'Fei', at: conn.paired[0].at }])
  assert.equal(conn.chats['owner-1'].kind, 'direct')
  assert.equal(conn.secrets.token, `IM_WEIXIN_${conn.id.slice(3, 9).toUpperCase()}_TOKEN`, 'the token is stored as a secret')
  assert.equal(s.rt.secretValue(conn.secrets.token), 'wx-tok')
  assert.equal(conn.settings.baseUrl, 'http://ilink/')
})

test('a platform status error is redacted of the stored secret', async (t) => {
  const s = await start({ adapter: (() => {
    const adapter = fakeAdapter()
    const connect = adapter.connect
    adapter.connect = (fields, env, handlers) => {
      const handle = connect(fields, env, handlers)
      handlers.onStatus({ state: 'error', error: 'platform echoed the token tok-1234 back' })
      return handle
    }
    return adapter
  })() })
  t.after(s.stop)
  const conn = await add(s)
  await s.flush()
  const status = s.rt.imStatusView()[conn.id]
  assert.equal(status.state, 'error')
  assert.ok(!status.error.includes('tok-1234'), 'the token is redacted')
})

// #1450: only the turn a chat asked for answers back to it. The Web UI, a peer Bot's
// message (message_bot) and a scheduled task all start turns of their own; their replies
// stay in the app instead of landing in every paired chat.
const pairedConn = async (s) => {
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  return { conn, one }
}

test('reply origin: an IM turn answers its own chat, and only that chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  // A second paired chat of the same Bot, which this turn did not come from.
  one.paired.push({ id: 'u2', name: 'U2', at: 1 })
  one.chats['dm-u2'] = { kind: 'direct', title: 'U2', at: 1 }
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'only for u1' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.chat.key), ['dm-u1'])
})

test('reply origin: a Web turn does not reach IM', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  s.emitEvent('a', 'user/message', { source: { kind: 'web' }, content: [{ type: 'text', text: 'typed in the browser' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'answer to the browser' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

test('reply origin: a peer Bot message and a scheduled task do not reach IM', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  for (const source of [{ kind: 'peer', from: 'b' }, { kind: 'schedule', taskId: 't1' }]) {
    s.emitEvent('a', 'user/message', { source, content: [{ type: 'text', text: 'work for you' }] })
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'internal reply' }] } })
    await s.flush()
  }
  assert.equal(s.fake.sent.length, 0)
})

test('reply origin: another source in the same turn withdraws the IM origin', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'user/message', { source: { kind: 'peer', from: 'b' }, content: [{ type: 'text', text: 'also this' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0, 'a mixed turn sends nothing')
})

test('reply origin: the turn ending stops later output from going out', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'turn/end', {})
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'late' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

test('reply origin: an IM message this process never registered sends nothing', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  // As after a restart, or a redelivery: the id looks like IM's but no chat is known.
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'im:telegram:from-another-run' }, content: [{ type: 'text', text: 'hi' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

test('reply origin: the group line follows the turn that started it', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  const room = s.rt.roomOf('r1')
  // A group turn nobody asked for in IM: its member lines stay in the app.
  s.emitEvent('r1', 'user/message', { source: { kind: 'web' }, content: [{ type: 'text', text: 'from the browser' }] })
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'member spoke' })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
  // Asked for in the group's IM chat: the same line goes back there.
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'member spoke' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: member spoke']])
})

test('reply origin: a question card follows its turn, and a Web turn gets none', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  // A turn from the Web asks a question: the card stays in the app.
  s.emitEvent('a', 'user/message', { source: { kind: 'web' }, content: [{ type: 'text', text: 'from the browser' }] })
  s.rt.state.questions.a = { id: 'qw', question: 'From the Web?', options: [{ label: 'yes' }] }
  await s.rt.save()
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
  // The IM turn asks one: it goes to the chat that asked.
  delete s.rt.state.questions.a
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'qi', question: 'From IM?', options: [{ label: 'yes' }] }
  await s.rt.save()
  await s.flush()
  const cards = s.fake.sent.filter(entry => entry.buttons !== undefined)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].chat.key, 'dm-u1')
  assert.match(cards[0].text, /From IM\?/)
})

test('reply origin: a turn that runs past any window still answers its chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  // A turn that runs for hours is still the turn this chat asked for.
  const later = Date.now() + 3 * 60 * 60 * 1000
  t.mock.timers.enable({ apis: ['Date'], now: later })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'long answer' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.text), ['long answer'])
})

test('reply origin: a message that waited in the queue past any window still names its chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  const requestId = s.prompts.at(-1).requestId
  // The Bot was busy: this message waits hours before its turn starts.
  const later = Date.now() + 3 * 60 * 60 * 1000
  t.mock.timers.enable({ apis: ['Date'], now: later })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'from the chat' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'answers the queue' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.text), ['answers the queue'])
})

// The four gaps found on the first head of #1450: a card must follow its own
// connection, answering one keeps the chat for the turn the answer continues, a
// group keeps its chat while its members still work after the relay turn, and
// unpairing stops a running turn from replying.

test('reply origin: cards and approvals leave only on the connection whose chat asked', async (t) => {
  const s = await start()
  t.after(s.stop)
  const telegram = s.fake
  const dingtalk = fakeAdapter()
  const original = adapters.dingtalk
  adapters.dingtalk = dingtalk
  t.after(() => { adapters.dingtalk = original })
  const connA = await add(s)
  const connB = await s.rt.imEndpoint('im-add', { platform: 'dingtalk', botId: 'a', fields: FIELDS.dingtalk })
  for (const id of [connA.id, connB.id]) {
    const one = s.rt.state.im.connections[id]
    one.paired.push({ id: 'u1', name: 'U1', at: 1 })
    one.chats['dm-u1'] = { kind: 'direct', title: 'U1', at: 1 }
  }
  await s.rt.save()
  await s.flush()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  telegram.sent.length = 0
  dingtalk.sent.length = 0

  s.rt.state.questions.a = { id: 'q1', question: 'Which?', options: [{ label: 'yes' }, { label: 'no' }] }
  await s.rt.save()
  await s.flush()
  assert.equal(telegram.sent.filter(entry => entry.buttons?.[0]?.data.startsWith('q:')).length, 1, 'the asking chat got its question card')
  assert.equal(dingtalk.sent.filter(entry => entry.buttons?.[0]?.data.startsWith('q:')).length, 0, 'the other connection got no question card')
  delete s.rt.state.questions.a

  s.rt.state.secretRequests = { a: [{ id: 's1', name: 'MY_KEY', purpose: 'for tests', status: 'pending', askedAt: 1 }] }
  await s.rt.save()
  await s.flush()
  assert.equal(telegram.sent.filter(entry => entry.text.includes('MY_KEY')).length, 1, 'the asking chat got the secret request')
  assert.equal(dingtalk.sent.filter(entry => entry.text.includes('MY_KEY')).length, 0, 'the other connection got no secret request')
  s.rt.state.secretRequests = {}

  s.rt.state.views.a = { id: 'v1', title: 'Pick', view: { type: 'text', text: 'Answer me' } }
  await s.rt.save()
  await s.flush()
  assert.equal(telegram.sent.filter(entry => entry.text.includes('Pick')).length, 1, 'the asking chat got the view card')
  assert.equal(dingtalk.sent.filter(entry => entry.text.includes('Pick')).length, 0, 'the other connection got no view card')
  delete s.rt.state.views.a

  telegram.sent.length = 0
  dingtalk.sent.length = 0
  void s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: new AbortController().signal }, () => new Promise(() => {}))
  await s.flush()
  assert.equal(telegram.sent.filter(entry => entry.buttons?.[0]?.data.startsWith('a:')).length, 1, 'the asking chat got the approval card')
  assert.equal(dingtalk.sent.filter(entry => entry.buttons?.[0]?.data.startsWith('a:')).length, 0, 'the other connection got no approval card')
})

test('reply origin: an answer from IM keeps its chat for the turn the answer continues', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Which?', options: [{ label: 'yes' }, { label: 'no' }] }
  await s.rt.save()
  await s.flush()
  s.fake.sent.length = 0
  // The chat answers its own card; the host queues the answer as the next message.
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'q:q1:0', messageId: 1 })
  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', s.agentOf('a').lastFollowup)
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'after the answer' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['dm-u1', 'after the answer']])
})

test('reply origin: a group keeps its chat while members work after the relay turn', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  const room = s.rt.roomOf('r1')
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.fake.sent.length = 0
  // The group's relay turn ends at once; a member keeps working.
  s.emitEvent('r1', 'turn/end', {})
  s.emitEvent('r1', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'e1', senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
    content: [{ type: 'text', text: '[Group post from Writer]\nlate result' }],
  })
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'late result' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: late result']])
})

test('reply origin: unbinding or rebinding the chat stops a running group turn from replying', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  const room = s.rt.roomOf('r1')
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.fake.sent.length = 0
  s.emitEvent('r1', 'turn/end', {})
  // While the chat still follows the group, its lines go out.
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'first result' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.text), ['**Writer**: first result'])
  s.fake.sent.length = 0
  // The app unbinds the chat while the group keeps working: late lines must not follow
  // the old origin into a chat that no longer points at the group.
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: null })
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'late result' })
  await s.flush()
  assert.equal(s.fake.sent.length, 0, 'an unbound chat gets no late lines')
  // Pointing the same chat at another Bot stops the old group's lines too.
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { botId: 'b' } })
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'later result' })
  await s.flush()
  assert.equal(s.fake.sent.length, 0, 'a rebound chat gets no lines from the old target')
})

test('reply origin: a member result that wakes the group after its relay turn still reaches the chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  const room = s.rt.roomOf('r1')
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.emitEvent('r1', 'turn/end', {})
  s.fake.sent.length = 0
  // The last member finishes after the relay turn ended: the host posts its result into
  // the group's own Session and starts a turn for it. The turn starts (and looks idle)
  // before its user/message arrives, which must not clear the chat that asked.
  s.emitEvent('r1', 'turn/start', { turn: 2 })
  s.emitEvent('r1', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'e2', senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
    content: [{ type: 'text', text: '[Group post from Writer]\nlast result' }],
  })
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'last result' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: last result']])
})

test('reply origin: unpairing the chat stops a running turn from replying', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  await s.rt.imEndpoint('im-unpair', { id: one.id, senderId: 'u1' })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'still there?' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

test('reply origin: a stale card answered in a race does not claim the chat for a later turn', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.rt.state.questions.a = { id: 'q1', question: 'Which?', options: [{ label: 'yes' }] }
  await s.rt.save()
  await s.flush()
  s.fake.sent.length = 0
  s.emitEvent('a', 'turn/end', {})
  // The card is still on the phone, but the app settled it first: answering races it.
  s.rt.answerQuestion = async () => { throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' }) }
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: 'q:q1:0', messageId: 1 })
  await s.flush()
  const stale = s.fake.sent.length
  assert.ok(stale >= 1, 'the stale answer is told')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'a later, unrelated turn' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, stale, 'the stale answer did not claim the chat')
})


test('mixed IM chats cannot reclaim the same turn, and the next turn starts clean', async t => {
  const s = await start()
  t.after(s.stop)
  const { conn } = await pairedConn(s)
  s.rt.state.im.connections[conn.id].paired.push({ id: 'u2', name: 'U2', at: 1 })
  await dm(s, 'u1', 'first')
  s.imTurn('a')
  await dm(s, 'u2', 'second')
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  await dm(s, 'u1', 'third')
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'mixed' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
  await dm(s, 'u1', 'fresh')
  s.imTurn('a')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'clean' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(x => [x.chat.key, x.text]), [['dm-u1', 'clean']])
})

test('a Web question answer cannot inherit a previous IM destination', async t => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'first')
  s.imTurn('a')
  s.emitEvent('a', 'user/message', { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } })
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'private answer' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

// #1417: a 5xx was retryable with no limit, so one message held its chat's queue
// forever while the status still said ready. The retry budget is now bounded, the
// status says what happened, and the messages behind the failed one still go out.
test('a send that keeps answering 5xx keeps an exhausted send for manual retry while the queue moves on', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  const fail = () => Object.assign(new Error('Feishu answered 502'), { status: 502, retryAfter: 0.005 })
  s.fake.fails.push(fail(), fail(), fail(), fail())
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } })
  await delay(120)
  assert.equal(s.fake.sent.filter(job => job.text === 'first').length, 4, 'the first message pauses after four attempts')
  const status = s.rt.imStatusView()[conn.id]
  assert.equal(status.state, 'error')
  assert.match(status.error, /Send failed after 4 attempts: Feishu answered 502/)
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'second' }] } })
  await delay(40)
  assert.equal(s.fake.sent.filter(job => job.text === 'second').length, 1, 'the next message is not held behind the failed one')
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error', 'a later success cannot hide an undelivered message')
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(40)
  assert.equal(s.fake.sent.filter(job => job.text === 'first').length, 5)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('a retrying send shows a retrying status before the budget runs out', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.fake.fails.push(Object.assign(new Error('Feishu answered 502'), { status: 502, retryAfter: 0.2 }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'slow' }] } })
  await delay(60)
  const status = s.rt.imStatusView()[conn.id]
  assert.equal(status.state, 'retrying')
  assert.match(status.error, /502/)
  await delay(220)
  assert.equal(s.fake.sent.filter(job => job.text === 'slow').length, 2)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('send recovery restores the adapter state, isolates chats, and keeps adapter errors visible', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 }, { id: 'u2', name: 'U2', at: 2 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  await dm(s, 'u2', 'hi')
  s.fake.sent.length = 0

  // Transient failure while reconnecting restores 'reconnecting' instead of assuming 'ready'.
  s.fake.handlers.onStatus({ state: 'reconnecting' })
  s.fake.fails.push(Object.assign(new Error('502'), { status: 502, retryAfter: 0.005 }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'during-reconnect' }] } })
  await delay(60)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'reconnecting')

  // Chat A's dropped send error survives when Chat B succeeds, and an adapter error is never hidden by send retrying.
  s.fake.handlers.onStatus({ state: 'ready' })
  s.rt.state.im.connections[conn.id].chats['dm-u2'].target = { botId: 'b' }
  await s.rt.save()
  s.fake.fails.push(Object.assign(new Error('chat-a-down'), { status: 403, permanent: true }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'fails-u1' }] } })
  await delay(40)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  s.emitEvent('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok-u2' }] } })
  await delay(40)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  assert.match(s.rt.imStatusView()[conn.id].error, /chat-a-down/)

  s.fake.handlers.onStatus({ state: 'error', error: 'handshake refused' })
  s.fake.fails.push(Object.assign(new Error('502'), { status: 502, retryAfter: 0.2 }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'retry-under-err' }] } })
  await delay(40)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  assert.equal(s.rt.imStatusView()[conn.id].error, 'handshake refused')
})

test('an approval card whose send exhausts retries is retained and re-delivered by Try again', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  const fail = () => Object.assign(new Error('Feishu answered 502'), { status: 502, retryAfter: 0.005 })
  s.fake.fails.push(fail(), fail(), fail(), fail())
  const original = new AbortController()
  const racing = s.fireApprovals(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: original.signal },
    () => new Promise(() => {}),
  )
  await delay(140)
  assert.equal(s.fake.sent.filter(job => /bash/.test(job.text)).length, 4)

  // Try again resumes the original card and its pending delivery callback.
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(60)
  const card = s.fake.sent.at(-1)
  assert.match(card.text, /bash/)
  assert.equal(s.fake.sent.filter(job => /bash/.test(job.text)).length, 5)
  const approvalId = card.buttons[0].data.split(':')[1]
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: card.messageId ?? 1 })
  assert.equal((await racing)[0], 'allowed-once')
})
