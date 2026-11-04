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
      followup() { this.followed = (this.followed ?? 0) + 1 },
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
  return { ctx, rt, home, fake, prompts, agents, agentOf, emitEvent, fireApprovals, stop, flush, platform }
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
  const room = s.rt.roomOf('r1')
  s.rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'member spoke' })
  s.rt.logRoom(room, { who: 'User', text: 'user spoke' })
  s.rt.logRoom(room, { who: 'DS Bot', kind: 'notice', reason: 'x', text: 'nope' })
  await s.flush()
  assert.equal(s.fake.sent.length, 2)
  assert.equal(s.fake.sent[1].text, '**Writer**: member spoke')
  assert.equal(s.fake.sent[1].chat.key, 'g1')
})

test('question card: buttons answer it, a stranger press is ignored, settled elsewhere edits the card', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 }, { id: 'u2', name: 'U2', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
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
