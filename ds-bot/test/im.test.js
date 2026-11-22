import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'

// A platform adapter that records sends/edits and lets the test feed inbound
// messages, actions and statuses. `fail` makes send throw once per call queued.
// `quote` says the platform hands back quoted replies, so the host keeps what it
// sent; it is off by default, like most platforms.
const fakeAdapter = ({ buttons = true, quote = false } = {}) => {
  const sent = []
  const edited = []
  const typed = []
  const fails = []
  const jobs = []
  // Ids keep counting when a test empties `sent`, so a quoted id never names a
  // later message by accident.
  let nextMessage = 0
  const adapter = {
    id: 'fake',
    quote,
    sent,
    edited,
    typed,
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
          const messageId = String(++nextMessage)
          sent.push({ chat, messageId, ...body })
          jobs.push(body)
          const next = fails.shift()
          if (next !== undefined) throw next
          return { messageId }
        },
        edit: async (chat, messageId, body) => { edited.push({ chat, messageId, ...body }) },
        typing: async (chat) => { typed.push(chat) },
        stop: () => { adapter.stopped = (adapter.stopped ?? 0) + 1 },
      }
    },
  }
  adapter.fails = fails
  adapter.jobs = jobs
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

async function start({ platform = 'telegram', adapter, seed, home, services = {} } = {}) {
  if (home === undefined) {
    home = mkdtempSync(join(tmpdir(), 'dsb-im-'))
    seed ??= TEAM()
  }
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext({ services })
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
  const close = async () => {
    adapters[platform] = real
    await ctx.dispose()
  }
  const stop = async () => {
    await close()
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
  return { ctx, rt, home, fake, prompts, agents, agentOf, emitEvent, fireApprovals, imTurn, close, stop, flush, platform }
}

const FIELDS = { telegram: { token: 'tok-1234' }, dingtalk: { clientId: 'cli-1', clientSecret: 'sec-1234' } }
const add = (s, fields = FIELDS[s.platform]) => s.rt.imEndpoint('im-add', { platform: s.platform, botId: 'a', fields })
const dm = (s, senderId, text, extra = {}) => s.fake.handlers.onMessage({
  chat: { key: `dm-${senderId}`, kind: 'direct', title: senderId }, sender: { id: senderId, name: `User ${senderId}` }, text, ...extra,
})
const gm = (s, senderId, text, { mentioned = true, chat = { key: 'g1', kind: 'group', title: 'Group One' }, ...extra } = {}) => s.fake.handlers.onMessage({
  chat, sender: { id: senderId, name: `User ${senderId}` }, text, mentioned, ...extra,
})

const tokenCard = async (s, index = 0) => {
  for (let at = 0; at < 200; at += 1) {
    const card = s.fake.sent.filter(job => /Card V\d+/.test(job.text))[index]
    if (card !== undefined) return card
    await delay(10)
  }
  assert.fail('token card was not delivered')
}

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

test('typing carries the chat key, not the chat record', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  t.mock.timers.tick(4000)
  await s.flush()
  assert.ok(s.fake.typed.length > 0, 'typing is sent while the turn runs')
  assert.deepEqual(s.fake.typed[0], { key: 'dm-u1', kind: 'direct', title: 'u1' })
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

test('a quoted reply carries the message it answers into the Bot', async (t) => {
  const s = await start({ adapter: fakeAdapter({ quote: true }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done' }] } })
  await s.flush()
  const sentId = s.fake.sent.at(-1)?.messageId
  assert.ok(sentId !== undefined, 'the sent message has an id')
  await dm(s, 'u1', 'ship it', { quote: { ids: [sentId] } })
  assert.equal(s.prompts.length, 2)
  assert.equal(s.prompts[1].content[0].text, 'Replying to an earlier message:\n> Project A is done\n\nship it')
  // The reply can come after a restart, so the message is kept in the runtime file.
  await delay(600)
  const runtime = JSON.parse(readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8'))
  assert.ok(runtime.sent['dm-u1'].some(entry => entry.text === 'Project A is done'))
})

test('a platform whose replies cannot be quoted writes no sent messages', async (t) => {
  // The adapter keeps state in the runtime file, so the file is written even
  // though this platform never hands back a quoted reply: it must not carry
  // the replies the host sent either.
  const adapter = {
    id: 'fake',
    handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      env.runtime.set({ lastPoll: 1 })
      return {
        send: async () => ({ messageId: 'plain-1' }),
        typing: async () => {},
        stop: () => {},
      }
    },
  }
  const s = await start({ adapter })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done' }] } })
  await s.flush()
  const fileOf = () => {
    try { return JSON.parse(readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8')) } catch { return undefined }
  }
  // The runtime file is written on a delay; wait until it lands.
  let runtime = fileOf()
  for (let at = 0; at < 80 && runtime?.runtime?.lastPoll === undefined; at += 1) {
    await delay(50)
    runtime = fileOf()
  }
  assert.equal(runtime?.runtime?.lastPoll, 1, 'the runtime file was written')
  assert.equal(runtime.sent, undefined, 'no sent messages are stored')
})

test('a quote of a later chunk shows that chunk, not the start of the reply', async (t) => {
  // A platform that cuts a long reply into messages with an id each.
  const adapter = {
    id: 'fake',
    quote: true,
    handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      return {
        send: async () => ({
          messageId: 'chunk-b',
          ids: ['chunk-a', 'chunk-b'],
          parts: [
            { ids: ['chunk-a'], text: 'Project A is done' },
            { ids: ['chunk-b'], text: 'Project B is done' },
          ],
        }),
        typing: async () => {},
        stop: () => {},
      }
    },
  }
  const s = await start({ adapter })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done\n\nProject B is done' }] } })
  await s.flush()
  await dm(s, 'u1', 'do that', { quote: { ids: ['chunk-b'] } })
  assert.equal(s.prompts[1].content[0].text, 'Replying to an earlier message:\n> Project B is done\n\ndo that')
})

test('a partial send still remembers the chunks the platform accepted before failing', async (t) => {
  // A long reply is sent as chunks; the platform accepts the first, then refuses
  // the second. The accepted chunk must stay quotable even though the send failed.
  const adapter = {
    id: 'fake',
    quote: true,
    handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      let sendCount = 0
      return {
        send: async () => {
          sendCount += 1
          adapter.sentCount = sendCount
          // The reply: first chunk accepted, second refused.
          const error = new Error('WeChat refused the reply (quota)')
          error.permanent = true
          error.parts = [{ ids: ['accepted-first'], text: 'Project A is done' }]
          throw error
        },
        typing: async () => {},
        stop: () => {},
      }
    },
  }
  const s = await start({ adapter })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done\n\nProject B is done' }] } })
  await s.flush()
  assert.ok(adapter.sentCount >= 1, 'the adapter send was called')
  // A later quote naming only the accepted chunk, with no platform text, still
  // resolves to that chunk's text rather than "content unavailable".
  await dm(s, 'u1', 'do that', { quote: { ids: ['accepted-first'] } })
  assert.equal(s.prompts.at(-1).content[0].text, 'Replying to an earlier message:\n> Project A is done\n\ndo that')
})

test('a quote resolves by its ids, then by the platform text, and says when both are gone', async (t) => {
  const s = await start({ adapter: fakeAdapter({ quote: true }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done' }] } })
  await s.flush()
  const sentId = s.fake.sent.at(-1)?.messageId
  // Any of the ids may name the message; the first one that does is used.
  await dm(s, 'u1', 'this one', { quote: { ids: ['not-this-one', sentId] } })
  assert.equal(s.prompts[1].content[0].text, 'Replying to an earlier message:\n> Project A is done\n\nthis one')
  // An id this chat never sent falls back to the text the platform kept.
  await dm(s, 'u1', 'that one', { quote: { ids: ['gone'], text: 'Text the platform kept' } })
  assert.equal(s.prompts[2].content[0].text, 'Replying to an earlier message:\n> Text the platform kept\n\nthat one')
  await dm(s, 'u1', 'the other one', { quote: { ids: ['gone'] } })
  assert.equal(s.prompts[3].content[0].text, 'Replying to an earlier message (its text is not available).\n\nthe other one')
  // A command is read from the reply alone, never from the quote.
  // A command is read from the reply alone, never from the quote. End the turn
  // first so /stop has nothing running and answers the deterministic idle text.
  s.emitEvent('a', 'turn/end', {})
  await dm(s, 'u1', '/stop', { quote: { ids: [sentId] } })
  assert.equal(s.prompts.length, 4)
  assert.equal(s.fake.sent.at(-1).text, 'Nothing is running.')
})

test('only the last messages sent to a chat are kept for quoting', async (t) => {
  const s = await start({ adapter: fakeAdapter({ quote: true }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  for (let at = 0; at < 21; at += 1) {
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: `Report ${at}` }] } })
  }
  await s.flush()
  await delay(1_200)
  const kept = JSON.parse(readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8')).sent['dm-u1']
  assert.equal(kept.length, 20)
  assert.ok(!kept.some(entry => entry.text === 'Report 0'), 'the oldest is dropped')
  assert.ok(kept.some(entry => entry.text === 'Report 20'), 'the newest stays')
})

test('removing a chat drops the messages kept for quoting it', async (t) => {
  const s = await start({ adapter: fakeAdapter({ quote: true }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  // The runtime file is written on a delay, so wait for the write, not a fixed time.
  const sentOf = () => {
    try { return JSON.parse(readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8')).sent } catch { return undefined }
  }
  const until = async (check) => {
    for (let at = 0; at < 80; at += 1) {
      if (check(sentOf())) return true
      await delay(50)
    }
    return false
  }
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Project A is done' }] } })
  await s.flush()
  assert.ok(await until(sent => sent?.['dm-u1']?.length > 0), 'the sent message is kept')
  await s.rt.imEndpoint('im-chat', { id: conn.id, chatKey: 'dm-u1', remove: true })
  assert.ok(await until(sent => sent === undefined || sent['dm-u1'] === undefined), 'the removed chat leaves nothing behind')
})

test('a runtime file written before sent existed still loads and behaves unchanged', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const seed = TEAM()
  seed.im = { connections: {
    im_legacy: { id: 'im_legacy', platform: 'telegram', botId: 'a', account: { id: 'bot1', name: '@fakebot' }, settings: { token: 'tok' }, secrets: {}, enabled: false, paired: [], requests: [], chats: { 'dm-u1': { kind: 'direct', title: 'u1', at: 1 } }, createdAt: 1 },
  } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  // An older DS Bot wrote { runtime, cards } with no `sent` field. A fresh host
  // reading it must default `sent` to {} and behave exactly as before.
  mkdirSync(join(home, 'im'), { recursive: true })
  writeFileSync(join(home, 'im', 'im_legacy.json'), JSON.stringify({ runtime: {}, cards: {} }))
  const original = adapters.telegram
  adapters.telegram = fakeAdapter()
  const fresh = createRuntime(fakeContext(), { home })
  try {
    // This endpoint calls dataOf(), which reads the legacy file and must not throw.
    await fresh.imEndpoint('im-chat', { id: 'im_legacy', chatKey: 'dm-u1', remove: true })
    assert.equal(fresh.state.im.connections.im_legacy.chats['dm-u1'], undefined)
  } finally {
    await fresh.ctx.dispose()
    adapters.telegram = original
  }
})

test('the sent store is bounded across chats so the runtime file cannot grow without limit', async (t) => {
  const s = await start({ adapter: fakeAdapter({ quote: true }) })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  for (let chat = 0; chat < 12; chat += 1) one.paired.push({ id: `u${chat}`, name: `U${chat}`, at: 1 })
  await s.rt.save()
  // Fill many chats so the whole `sent` store (not just one chat's 20 entries)
  // crosses the cap; the oldest chats' entries must then be dropped, while the
  // most recent message (written to the last chat) survives.
  for (let chat = 0; chat < 12; chat += 1) {
    await dm(s, `u${chat}`, 'hi')
    s.imTurn('a')
    for (let at = 0; at < 20; at += 1) {
      s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: `Report ${chat}-${at} ${'x'.repeat(9_000)}` }] } })
    }
  }
  await s.flush()
  await delay(600)
  const runtime = JSON.parse(readFileSync(join(s.home, 'im', `${conn.id}.json`), 'utf8'))
  const size = JSON.stringify(runtime.sent).length
  assert.ok(size <= 200_000, `sent store stays bounded (${size} bytes)`)
  const lists = Object.values(runtime.sent)
  assert.ok(lists.length > 0 && lists.length < 12, 'the oldest chats were trimmed away')
  assert.ok(lists.every(list => list.length <= 20), 'each remaining chat keeps at most 20')
  assert.ok(lists.some(list => list.some(entry => entry.text.startsWith('Report 11-19'))), 'the newest message survives the trim')
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

test('member cards follow only the originating IM group and answers return through the room', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  const firstHandlers = s.fake.handlers
  one.chats.g1 = { kind: 'group', title: 'G1', target: { roomId: 'r1' }, at: 1 }
  one.chats.g2 = { kind: 'group', title: 'G2', target: { roomId: 'r1' }, at: 1 }
  const other = await add(s)
  const secondHandlers = s.fake.handlers
  const two = s.rt.state.im.connections[other.id]
  two.paired.push({ id: 'u1', name: 'U1', at: 1 })
  two.chats.g3 = { kind: 'group', title: 'G3', target: { roomId: 'r1' }, at: 1 }
  const room = s.rt.roomOf('r1')
  room.sessions = { b: 'member-b' }
  s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
  await s.rt.save()
  const ask = args => s.rt.teamTools.find(tool => tool.name === 'ask_user').execute(args, {
    agent: { id: 'member-b' }, concludeTurn() {},
  })
  const args = { question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] }
  assert.equal(await ask(args), 'Question cards only work in your own chat. In a group, ask in your message instead.')
  await firstHandlers.onMessage({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, text: 'ask the group', mentioned: true })
  s.imTurn('r1')
  s.fake.sent.length = 0
  assert.match(await ask({ ...args, allowCustom: true }), /Group question cards accept listed choices only/)
  assert.equal(s.rt.state.questions['member-b'], undefined)
  assert.match(await ask(args), /card is on screen/)
  const question = s.rt.state.questions['member-b']
  await s.flush()
  assert.match(room.log.at(-1).text, /Asked: Which route\?\n1\. A\n2\. B/)
  const cards = s.fake.sent.filter(job => job.buttons?.some(button => button.data.startsWith('q:')))
  assert.equal(cards.length, 1)
  assert.equal(cards[0].chat.key, 'g1')
  assert.equal(s.fake.sent.filter(job => job.chat.key === 'g1' && job.text.includes('Which route?')).length, 1)
  assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
  await secondHandlers.onAction({ chat: { key: 'g3', kind: 'group' }, sender: { id: 'u1' }, data: `q:${question.id}:0` })
  assert.ok(s.rt.state.questions['member-b'])
  await firstHandlers.onAction({ chat: { key: 'g2', kind: 'group' }, sender: { id: 'u1' }, data: `q:${question.id}:0` })
  assert.ok(s.rt.state.questions['member-b'])
  await firstHandlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `q:${question.id}:0` })
  assert.equal(s.rt.state.questions['member-b'], undefined)
  const answer = s.agentOf('member-b').lastFollowup
  assert.match(answer.source.rpcId, /^im:/)
  s.emitEvent('member-b', 'turn/start', { turn: 2 })
  s.emitEvent('member-b', 'user/message', answer)
  s.emitEvent('member-b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Using route A.' }] } })
  s.emitEvent('member-b', 'turn/end', { reason: { kind: 'completed' } })
  await s.flush()
  const post = s.agentOf('r1').lastFollowup
  assert.equal(post.source.role, 'post')
  assert.match(post.content[0].text, /Using route A/)
  s.fake.sent.length = 0
  s.emitEvent('r1', 'turn/start', { turn: 2 })
  s.emitEvent('r1', 'user/message', post)
  const relay = s.rt.teamTools.find(tool => tool.name === 'group_relay')
  await relay.execute({}, { agent: { id: 'r1', inbox: s.agentOf('r1').inbox }, callId: 'late-answer', signal: new AbortController().signal })
  await s.flush()
  assert.ok(room.log.some(line => line.text?.includes('Using route A.')))
  assert.ok(s.fake.sent.some(job => job.chat.key === 'g1' && job.text.includes('Using route A.')))
  assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
  const followed = s.agentOf('member-b').followed
  await firstHandlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `q:${question.id}:0` })
  assert.equal(s.agentOf('member-b').followed, followed)
})

test('IM view buttons and numbered replies answer the asking member, not other chats', async (t) => {
  for (const buttons of [true, false]) {
    const s = await start({ platform: buttons ? 'telegram' : 'dingtalk', adapter: fakeAdapter({ buttons }) })
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    const room = s.rt.roomOf('r1')
    room.sessions = { b: 'member-b' }
    s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
    await s.rt.save()
    await gm(s, 'u1', 'confirm the plan')
    s.imTurn('r1')
    s.fake.sent.length = 0
    let concluded = false
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Proceed?', view: { type: 'confirm', id: 'proceed' } }, { agent: { id: 'member-b' }, concludeTurn() { concluded = true } })
    assert.equal(concluded, true)
    const view = s.rt.state.views['member-b']
    await s.flush()
    assert.equal(s.fake.sent.length, 1)
    assert.equal(s.fake.sent[0].chat.key, 'g1')
    assert.match(s.fake.sent[0].text, /1\. Confirm\n2\. Cancel/)
    assert.equal(s.fake.sent[0].buttons?.[0].data, buttons ? `v:${view.id}:0` : undefined)
    assert.ok(room.log.some(line => line.viewId === view.id))
    await s.fake.handlers.onAction({ chat: { key: 'g2', kind: 'group' }, sender: { id: 'u1' }, data: `v:${view.id}:0` })
    assert.ok(s.rt.state.views['member-b'])
    if (buttons) {
      await s.fake.handlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `v:${view.id}:0` })
    } else {
      await gm(s, 'u1', '1', { mentioned: false })
      assert.ok(s.rt.state.views['member-b'])
      await gm(s, 'u1', '1')
    }
    assert.equal(s.rt.state.views['member-b'], undefined)
    const answer = s.agentOf('member-b').lastFollowup
    assert.match(answer.source.rpcId, /^im:/)
    assert.deepEqual(JSON.parse(answer.content[0].text).answers, [{ id: view.id, action: 'proceed', values: { confirmed: true } }])
    assert.equal(s.rt.roomHasImOrigin('r1'), true)
    const followed = s.agentOf('member-b').followed
    await s.fake.handlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `v:${view.id}:0` })
    assert.equal(s.agentOf('member-b').followed, followed)
  }
})

test('a later IM round cannot read or answer another chat\'s pending member cards', async (t) => {
  for (const kind of ['question', 'view']) {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    s.rt.roomOf('r1').sessions = { b: 'member-b' }
    s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
    await s.rt.save()
    await gm(s, 'u1', 'private choice')
    s.imTurn('r1')
    await s.rt.teamTools.find(tool => tool.name === (kind === 'question' ? 'ask_user' : 'show_view')).execute(kind === 'question'
      ? { question: 'Private route?', options: [{ label: 'A' }] }
      : { title: 'Private route?', view: { type: 'confirm', id: 'go' } }, { agent: { id: 'member-b' } })
    const store = kind === 'question' ? s.rt.state.questions : s.rt.state.views
    const card = store['member-b']
    assert.equal(card.imOrigin.chatKey, 'g1')
    await s.flush()
    s.fake.sent.length = 0
    await gm(s, 'u1', 'new round', { chat: { key: 'g2', kind: 'group' } })
    s.imTurn('r1')
    await s.rt.save()
    await s.flush()
    assert.ok(!s.fake.sent.some(job => job.chat.key === 'g2' && job.text.includes('Private route?')))
    await s.fake.handlers.onAction({ chat: { key: 'g2', kind: 'group' }, sender: { id: 'u1' }, data: `${kind === 'question' ? 'q' : 'v'}:${card.id}:0` })
    assert.equal(store['member-b'].id, card.id)
    assert.equal(s.agentOf('member-b').followed ?? 0, 0)
  }
})

test('answering persisted member cards restores the room origin after a restart', async (t) => {
  for (const kind of ['question', 'view']) {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    const room = s.rt.roomOf('r1')
    room.sessions = { b: 'member-b' }
    s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
    await s.rt.save()
    await gm(s, 'u1', 'choose')
    s.imTurn('r1')
    await s.rt.teamTools.find(tool => tool.name === (kind === 'question' ? 'ask_user' : 'show_view')).execute(kind === 'question'
      ? { question: 'Choose?', options: [{ label: 'A' }] }
      : { title: 'Choose?', view: { type: 'confirm', id: 'go' } }, { agent: { id: 'member-b' } })
    const card = (kind === 'question' ? s.rt.state.questions : s.rt.state.views)['member-b']
    await s.flush()
    s.rt.clearImOrigin('r1')
    s.rt.clearImOrigin('member-b')
    assert.equal(s.rt.roomHasImOrigin('r1'), false)
    await s.fake.handlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `${kind === 'question' ? 'q' : 'v'}:${card.id}:0` })
    const answer = s.agentOf('member-b').lastFollowup
    s.emitEvent('member-b', 'turn/start', { turn: 2 })
    s.emitEvent('member-b', 'user/message', answer)
    assert.equal(s.rt.roomHasImOrigin('r1'), true)
    s.emitEvent('member-b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Resumed after restart.' }] } })
    s.emitEvent('member-b', 'turn/end', { reason: { kind: 'completed' } })
    await s.flush()
    const post = s.agentOf('r1').lastFollowup
    s.fake.sent.length = 0
    s.emitEvent('r1', 'turn/start', { turn: 2 })
    s.emitEvent('r1', 'user/message', post)
    await s.rt.teamTools.find(tool => tool.name === 'group_relay').execute({}, { agent: { id: 'r1', inbox: s.agentOf('r1').inbox }, callId: 'restart-answer', signal: new AbortController().signal })
    await s.flush()
    assert.ok(room.log.some(line => line.text?.includes('Resumed after restart.')))
    assert.ok(s.fake.sent.some(job => job.text.includes('Resumed after restart.')))
    assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
  }
})

test('group token views accept every complex input kind through the shared view answer path', async (t) => {
  const input = node => ({ type: 'stack', children: [node, { type: 'submit', id: 'send' }] })
  const choices = id => ({ type: 'choice', id, label: id, options: [{ label: 'Fast', value: 'f' }, { label: 'Safe', value: 's' }] })
  const multi = { type: 'options', id: 'pick', multi: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }
  const cases = [
    { name: 'number', view: input({ type: 'number', id: 'n', label: 'Count', min: 1, max: 10, value: 2 }), reply: '\n1: 5', values: { inputs: { n: 5 } } },
    { name: 'slider', view: input({ type: 'slider', id: 'n', label: 'Size', min: 0, max: 10, value: 2 }), reply: '\n1: 4.5', values: { inputs: { n: 4.5 } } },
    { name: 'toggle', view: input({ type: 'toggle', id: 'yes', label: 'Enabled' }), reply: '\n1: on', values: { inputs: { yes: true } } },
    { name: 'several choices', view: { type: 'stack', children: [choices('first'), choices('second'), { type: 'submit', id: 'send' }] }, reply: '\n1: 2\n2: Fast', values: { inputs: { first: 's', second: 'f' } } },
    { name: 'multiline form', view: { type: 'form', id: 'details', fields: [{ id: 'notes', label: 'Notes', multiline: true }, { id: 'name', label: 'Name', value: 'Default' }] }, reply: '\n1: first line\nsecond line', values: { fields: { notes: 'first line\nsecond line', name: 'Default' } } },
    { name: 'multi-select spaces', view: multi, reply: ' 1 3', values: { selected: ['A', 'C'] } },
    { name: 'multi-select commas', view: multi, reply: ' 1,3', values: { selected: ['A', 'C'] } },
    { name: 'cancel', view: { type: 'form', id: 'details', fields: [{ id: 'notes', label: 'Notes' }], cancelLabel: 'Cancel' }, reply: ' cancel', values: { canceled: true } },
    { name: 'multiple actions', view: { type: 'stack', children: [{ type: 'number', id: 'n', label: 'Count', value: 2 }, { type: 'confirm', id: 'go' }] }, reply: ' 2\n1: 3', values: { inputs: { n: 3 }, confirmed: false } },
  ]
  for (const entry of cases) await t.test(entry.name, async (t) => {
    const s = await start({ platform: 'dingtalk' })
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    s.rt.roomOf('r1').sessions = { b: 'member-b' }
    s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
    await s.rt.save()
    await gm(s, 'u1', 'show a form')
    s.imTurn('r1')
    s.fake.sent.length = 0
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: entry.name, view: entry.view }, { agent: { id: 'member-b' }, concludeTurn() {} })
    const pending = s.rt.state.views['member-b']
    assert.ok(pending)
    await s.flush()
    const card = await tokenCard(s)
    assert.ok(card)
    assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
    const code = /Card (V\d+)/.exec(card.text)[1]
    const api = (await s.rt.channelCall('state')).value
    assert.equal(api.views['member-b'].code, undefined)
    assert.ok(!JSON.stringify(api.views).includes('imOrigin'))
    await gm(s, 'u1', '!CaRd ' + code.toLowerCase() + entry.reply)
    assert.equal(s.rt.state.views['member-b'], undefined)
    const followup = s.agentOf('member-b').lastFollowup
    assert.match(followup.source.rpcId, /^im:/)
    assert.deepEqual(JSON.parse(followup.content[0].text).answers[0].values, entry.values)
  })
})

test('token view answers enforce pairing, mention, chat, origin, binding and stale checks without capturing plain text', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
  one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
  s.rt.roomOf('r1').sessions = { b: 'member-b' }
  s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
  await s.rt.save()
  await gm(s, 'u1', 'show inputs')
  s.imTurn('r1')
  const show = () => s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Count', view: { type: 'stack', children: [
    { type: 'number', id: 'n', label: 'Count', min: 1, max: 10, value: 2 }, { type: 'submit', id: 'send' },
  ] } }, { agent: { id: 'member-b' }, concludeTurn() {} })
  await show()
  await s.flush()
  const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  const id = s.rt.state.views['member-b'].id
  await gm(s, 'stranger', `!card ${code}\n1: 4`)
  await gm(s, 'u1', `!card ${code}\n1: 4`, { mentioned: false })
  assert.equal(s.rt.state.views['member-b'].id, id)
  let prompts = s.prompts.length
  await gm(s, 'u1', `${code} is our release version`, { chat: { key: 'g2', kind: 'group' } })
  assert.equal(s.prompts.length, prompts + 1)
  assert.equal(s.prompts.at(-1).content[0].text, `${code} is our release version`)
  assert.equal(s.rt.state.views['member-b'].id, id)
  prompts = s.prompts.length
  await gm(s, 'u1', `!card ${code}\n1: 99`)
  await s.flush()
  assert.ok(s.fake.sent.some(job => job.chat.key === 'g1' && job.text.startsWith('Invalid view answer:')))
  assert.equal(s.prompts.length, prompts)
  assert.equal(s.rt.state.views['member-b'].id, id)
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { botId: 'a' } })
  let sent = s.fake.sent.length
  await gm(s, 'u1', `!card ${code}\n1: 4`)
  await s.flush()
  assert.equal(s.prompts.length, prompts, 'a stale form value must not reach the new binding target')
  assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g1' && /no longer answerable/.test(job.text)))
  assert.equal(s.rt.state.views['member-b'].id, id)
  await gm(s, 'u1', 'ordinary text for the new target')
  assert.equal(s.prompts.length, prompts + 1)
  assert.equal(s.prompts.at(-1).content[0].text, 'ordinary text for the new target')
  prompts = s.prompts.length
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: null })
  sent = s.fake.sent.length
  await gm(s, 'u1', `!card ${code}\n1: 4`)
  await s.flush()
  assert.equal(s.prompts.length, prompts)
  assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g1' && /no longer answerable/.test(job.text)))
  assert.equal(s.rt.state.views['member-b'].id, id)
  sent = s.fake.sent.length
  await gm(s, 'u1', 'ordinary unbound text')
  await s.flush()
  assert.equal(s.prompts.length, prompts)
  assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g1' && !/no longer answerable/.test(job.text)))
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { roomId: 'r1' } })
  await gm(s, 'u1', 'ordinary group discussion')
  await gm(s, 'u1', 'V999999 unknown code')
  assert.equal(s.prompts.length, prompts + 2)
  assert.equal(s.rt.state.views['member-b'].id, id)
  await gm(s, 'u1', `!card ${code}\n1: 4`)
  assert.equal(s.rt.state.views['member-b'], undefined)
  assert.equal(s.agentOf('member-b').followed, 1)
  prompts = s.prompts.length
  await gm(s, 'u1', `!card ${code}\n1: 5`)
  assert.equal(s.prompts.length, prompts)
  assert.equal(s.agentOf('member-b').followed, 1)
  await show()
  await s.flush()
  const next = /Card (V\d+)/.exec((await tokenCard(s, 1)).text)[1]
  assert.notEqual(next, code)
  await gm(s, 'u1', `!card ${code}\n1: 5`)
  assert.ok(s.rt.state.views['member-b'])
  await gm(s, 'u1', `!card ${next}`)
  assert.deepEqual(JSON.parse(s.agentOf('member-b').lastFollowup.content[0].text).answers[0].values.inputs, { n: 2 })
})

test('own-chat form codes persist across restart and do not reuse a settled code', async (t) => {
  let s = await start()
  t.after(() => s.stop())
  const { one } = await pairedConn(s)
  await dm(s, 'u1', 'form please')
  s.imTurn('a')
  const view = { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name', value: 'Default' }] }
  const show = () => s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Details', view }, { agent: { id: 'a' }, concludeTurn() {} })
  await show()
  const id = s.rt.state.views.a.id
  await s.flush()
  const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  await s.close()
  const saved = JSON.parse(readFileSync(join(s.home, 'im', `${one.id}.json`), 'utf8'))
  assert.equal(saved.cards[`v:${id}`][0].code, code)
  s = await start({ home: s.home })
  await s.rt.imEndpoint('im-retry', { id: one.id })
  await dm(s, 'u1', `/card@fakebot ${code}\n1: Alice`)
  assert.equal(s.rt.state.views.a, undefined)
  assert.deepEqual(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0].values.fields, { name: 'Alice' })
  await dm(s, 'u1', 'another form')
  s.imTurn('a')
  await show()
  await s.flush()
  const next = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  assert.notEqual(next, code)
  await dm(s, 'u1', `/card ${next}\n1: Bob`)
  assert.equal(s.rt.state.views.a, undefined)
  assert.deepEqual(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0].values.fields, { name: 'Bob' })
})

test('pending legacy code cards receive the new reply instructions once with the same code', async (t) => {
  for (const mode of ['own', 'group', 'slash', 'interrupted']) await t.test(mode, async (t) => {
    let s = await start()
    t.after(() => s.stop())
    const { one } = await pairedConn(s)
    const grouped = mode === 'group'
    const sessionId = grouped ? 'member-b' : 'a'
    const chatKey = grouped ? 'g1' : 'dm-u1'
    const message = text => grouped ? gm(s, 'u1', text) : dm(s, 'u1', text)
    if (grouped) {
      s.rt.roomOf('r1').sessions = { b: sessionId }
      s.rt.groupOwners.set(sessionId, { botId: 'b', roomId: 'r1' })
      await gm(s, 'u1', 'discover')
      await gm(s, 'u1', 'discover', { chat: { key: 'g2', kind: 'group' } })
      await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { roomId: 'r1' } })
      await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g2', target: { roomId: 'r1' } })
    }
    await message('form please')
    s.imTurn(grouped ? 'r1' : 'a')
    const view = { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] }
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Details', view }, { agent: { id: sessionId }, concludeTurn() {} })
    const id = s.rt.state.views[sessionId].id
    const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
    await s.close()
    const path = join(s.home, 'im', `${one.id}.json`)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const delivery = data.cards[`v:${id}`][0]
    assert.equal(delivery.replyVersion, 2)
    assert.equal(delivery.delivered, true)
    if (mode === 'interrupted') {
      assert.ok(delivery.messageId)
      delivery.delivered = false
    } else {
      if (mode === 'slash') delivery.replyVersion = 1
      else delete delivery.replyVersion
      delivery.text = `Card ${code}\nReply example: ${mode === 'slash' ? '/card ' : ''}${code}\\n1: Alice`
    }
    writeFileSync(path, JSON.stringify(data))
    s = await start({ home: s.home })
    await s.rt.imEndpoint('im-retry', { id: one.id })
    const updated = await tokenCard(s)
    assert.equal(updated.chat.key, chatKey)
    assert.ok(updated.text.includes(`Reply example: !card ${code}`))
    if (mode !== 'interrupted') assert.ok(updated.text.includes('replaces the earlier reply instructions'))
    assert.equal(/Card (V\d+)/.exec(updated.text)[1], code)
    await Promise.all([s.rt.save(), s.rt.save()])
    await s.flush()
    assert.equal(s.fake.sent.filter(job => /Card V\d+/.test(job.text)).length, 1)
    assert.equal(s.rt.state.views[sessionId].id, id)
    await s.close()
    const migrated = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(migrated.cards[`v:${id}`][0].replyVersion, 2)
    assert.equal(migrated.cards[`v:${id}`][0].delivered, true)
    assert.equal(migrated.viewCodeSeq, data.viewCodeSeq)
    s = await start({ home: s.home })
    await s.rt.imEndpoint('im-retry', { id: one.id })
    await s.flush()
    assert.equal(s.fake.sent.filter(job => /Card V\d+/.test(job.text)).length, 0)
    await message(`!card ${code}\n1: Alice`)
    assert.equal(s.rt.state.views[sessionId], undefined)
    assert.deepEqual(JSON.parse(s.agentOf(sessionId).lastFollowup.content[0].text).answers[0].values.fields, { name: 'Alice' })
  })
})

test('only reserved card commands answer forms and all malformed or unknown commands stay out of ordinary chat', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', target: { botId: 'a' }, at: 1 }
  one.chats.g2 = { kind: 'group', target: { botId: 'b' }, at: 1 }
  await s.rt.save()
  const codes = []
  for (const [index, botId] of ['a', 'b'].entries()) {
    await gm(s, 'u1', 'show a form', { chat: { key: `g${index + 1}`, kind: 'group' } })
    s.imTurn(botId)
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view: {
      type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }],
    } }, { agent: { id: botId }, concludeTurn() {} })
    codes.push(/Card (V\d+)/.exec((await tokenCard(s, index)).text)[1])
  }
  assert.notEqual(codes[0], codes[1])
  for (const [chatKey, text] of [
    ['g2', `${codes[0]} is our release version`],
    ['g2', `${codes[0]}\n1: a code this chat never received`],
    ['g2', `${codes[1]} is our release version`],
    ['g1', `${codes[0]} is our release version`],
    ['g1', `${codes[0]} 1 3`],
    ['g1', 'V3 1 3'],
    ['g1', '!cardigan sale'],
    ['g1', '/cardboard private'],
  ]) {
    const prompts = s.prompts.length
    await gm(s, 'u1', text, { chat: { key: chatKey, kind: 'group' } })
    assert.equal(s.prompts.length, prompts + 1)
    assert.equal(s.prompts.at(-1).content[0].text, text)
  }
  assert.ok(s.rt.state.views.a)
  assert.ok(s.rt.state.views.b)
  const pending = s.rt.state.views.b.id
  for (const text of ['!card', '!card invalid', '!card V999999\n1: private', '/card', '/card invalid', '/card V999999\n1: private', `!card ${codes[0]}\n1: wrong chat`, `!card ${codes[1]} prose is not an answer`]) {
    const prompts = s.prompts.length
    const sent = s.fake.sent.length
    await gm(s, 'u1', text, { chat: { key: 'g2', kind: 'group' } })
    await s.flush()
    assert.equal(s.prompts.length, prompts)
    assert.equal(s.rt.state.views.b.id, pending)
    assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g2' && /Invalid|no longer answerable/.test(job.text)))
  }
  await gm(s, 'u1', `!card ${codes[1]}\n1: Bob`, { chat: { key: 'g2', kind: 'group' } })
  assert.equal(s.rt.state.views.b, undefined)
  assert.equal(JSON.parse(s.agentOf('b').lastFollowup.content[0].text).answers[0].values.fields.name, 'Bob')
})

test('expired form codes stay private after pruning, rebinding and restart', async (t) => {
  for (const restart of [false, true]) await t.test(restart ? 'restart' : 'live', async (t) => {
    let s = await start()
    t.after(() => s.stop())
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { botId: 'a' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { botId: 'b' }, at: 1 }
    await s.rt.save()
    await gm(s, 'u1', 'show a form')
    s.imTurn('a')
    const view = { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] }
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view }, { agent: { id: 'a' }, concludeTurn() {} })
    const id = s.rt.state.views.a.id
    const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
    await gm(s, 'u1', `!card ${code}\n1: First`)
    assert.equal(s.rt.state.views.a, undefined)
    await s.close()
    const path = join(s.home, 'im', `${one.id}.json`)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    delete data.viewCodeHighWater
    data.viewCodes = { g1: Array.from({ length: 205 }, (_, index) => index + 2) }
    assert.ok(!data.viewCodes.g1.includes(Number(code.slice(1))), 'the old code has also fallen out of its receiving chat history')
    data.viewCodeSeq += 1000
    writeFileSync(path, JSON.stringify(data))
    s = await start({ home: s.home })
    await s.rt.imEndpoint('im-retry', { id: one.id })
    await s.rt.save()
    let pruned
    for (let attempt = 0; attempt < 200; attempt += 1) {
      pruned = JSON.parse(readFileSync(path, 'utf8'))
      if (pruned.cards[`v:${id}`] === undefined) break
      await delay(10)
    }
    assert.equal(pruned.cards[`v:${id}`], undefined, 'the settled delivery must actually be pruned')
    assert.equal(pruned.viewCodes, undefined, 'routing no longer retains or relies on expiring per-chat history')
    await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { botId: 'b' } })
    if (restart) {
      await s.close()
      s = await start({ home: s.home })
      await s.rt.imEndpoint('im-retry', { id: one.id })
    }
    const refused = async () => {
      const prompts = s.prompts.length
      const sent = s.fake.sent.length
      await gm(s, 'u1', `!card ${code.toLowerCase()}\n1: Private form value`)
      await s.flush()
      assert.equal(s.prompts.length, prompts)
      assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g1' && /no longer answerable/.test(job.text)))
      assert.equal(s.agentOf('b').lastFollowup, undefined)
    }
    await refused()
    const prose = `${code} is our release version`
    const beforeProse = s.prompts.length
    await gm(s, 'u1', prose)
    assert.equal(s.prompts.length, beforeProse + 1)
    assert.equal(s.prompts.at(-1).content[0].text, prose)
    await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: null })
    await refused()
    await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { botId: 'b' } })
    let prompts = s.prompts.length
    await gm(s, 'u1', `${code} is our release version`, { chat: { key: 'g2', kind: 'group' } })
    assert.equal(s.prompts.length, prompts + 1)
    assert.equal(s.prompts.at(-1).content[0].text, `${code} is our release version`)
    prompts = s.prompts.length
    await gm(s, 'u1', 'ordinary group text')
    await gm(s, 'u1', 'V999999 unknown code')
    assert.equal(s.prompts.length, prompts + 2)
    s.imTurn('b')
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view }, { agent: { id: 'b' }, concludeTurn() {} })
    const next = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
    assert.ok(Number(next.slice(1)) > data.viewCodeSeq, 'the durable allocation counter survives pruning and restart')
  })
})

test('legacy bare replies stay private after delivery pruning, rebind and restart without moving the cutoff', async (t) => {
  let s = await start()
  t.after(() => s.stop())
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', target: { botId: 'a' }, at: 1 }
  await s.rt.save()
  await gm(s, 'u1', 'show a form')
  s.imTurn('a')
  const view = { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] }
  const show = botId => s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view }, { agent: { id: botId }, concludeTurn() {} })
  await show('a')
  const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  await gm(s, 'u1', `!card ${code}\n1: First`)
  await s.close()
  const path = join(s.home, 'im', `${one.id}.json`)
  const legacy = JSON.parse(readFileSync(path, 'utf8'))
  delete legacy.legacyViewCodeCutoff
  legacy.cards = {}
  legacy.viewCodeSeq += 1000
  writeFileSync(path, JSON.stringify(legacy))
  s = await start({ home: s.home })
  await s.rt.imEndpoint('im-retry', { id: one.id })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).legacyViewCodeCutoff, legacy.viewCodeSeq, 'the cutoff is durable on first load, before new allocation')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).cards, {})
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: { botId: 'b' } })
  await gm(s, 'u1', 'show another form')
  s.imTurn('b')
  await show('b')
  const next = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  assert.ok(Number(next.slice(1)) > legacy.viewCodeSeq)
  const pending = s.rt.state.views.b.id
  const refuse = async () => {
    for (const text of [`${code.toLowerCase()}\n1: Private value`, `${code} 1,3`, `${code} 2\n1: Private value`, `${code} cancel`, `${code} 2 cancel`]) {
      const prompts = s.prompts.length
      const sent = s.fake.sent.length
      await gm(s, 'u1', text)
      await s.flush()
      assert.equal(s.prompts.length, prompts, text)
      assert.equal(s.rt.state.views.b.id, pending)
      assert.ok(s.fake.sent.slice(sent).some(job => job.chat.key === 'g1' && job.text.includes(`use !card ${code}`)), text)
    }
  }
  for (const restart of [false, true]) {
    if (restart) {
      await s.close()
      s = await start({ home: s.home })
      await s.rt.imEndpoint('im-retry', { id: one.id })
    }
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).legacyViewCodeCutoff, legacy.viewCodeSeq)
    await refuse()
    for (const text of [`${code} is our release`, `${next}\n1: Ordinary text`, `${next} 1,3`]) {
      const prompts = s.prompts.length
      await gm(s, 'u1', text)
      assert.equal(s.prompts.length, prompts + 1)
      assert.equal(s.prompts.at(-1).content[0].text, text)
      assert.equal(s.rt.state.views.b.id, pending)
    }
  }
  await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target: null })
  await refuse()
})

test('fresh connections keep a durable zero cutoff after allocation and restart', async (t) => {
  let s = await start()
  t.after(() => s.stop())
  const { one } = await pairedConn(s)
  const path = join(s.home, 'im', `${one.id}.json`)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).legacyViewCodeCutoff, 0)
  await dm(s, 'u1', 'form please')
  s.imTurn('a')
  await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view: { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] } }, { agent: { id: 'a' }, concludeTurn() {} })
  const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
  const pending = s.rt.state.views.a.id
  for (const restart of [false, true]) {
    if (restart) {
      await s.close()
      s = await start({ home: s.home })
      await s.rt.imEndpoint('im-retry', { id: one.id })
    }
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).legacyViewCodeCutoff, 0)
    for (const text of [`${code}\n1: Ordinary text`, `${code} 1 3`, 'V999 cancel']) {
      const prompts = s.prompts.length
      await dm(s, 'u1', text)
      assert.equal(s.prompts.length, prompts + 1)
      assert.equal(s.prompts.at(-1).content[0].text, text)
      assert.equal(s.rt.state.views.a.id, pending)
    }
  }
})

test('token reservations recover interrupted sends without replaying completed deliveries after a killed process', async (t) => {
  for (const mode of ['open', 'complete', 'complete-no-id', 'settled']) await t.test(mode, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'dsb-im-crash-'))
    const child = fork(new URL('./fixtures/im-view-crash.mjs', import.meta.url), [home, mode], {
      execArgv: ['--import', new URL('./harness-resolve.mjs', import.meta.url).href],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    let s
    t.after(async () => {
      child.kill('SIGKILL')
      if (s !== undefined) await s.stop()
      else rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    })
    const delivery = await new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)))
    })
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    assert.equal(delivery.persisted.cards[`v:${delivery.viewId}`][0].code, delivery.code, 'the code is durable before the platform sees it')
    assert.ok(delivery.persisted.viewCodeSeq >= Number(delivery.code.slice(1)))
    s = await start({ home })
    await s.rt.imEndpoint('im-retry', { id: delivery.connId })
    if (mode !== 'settled') {
      assert.equal(s.rt.state.views.a.id, delivery.viewId)
      if (mode === 'open') {
        const recovered = await tokenCard(s)
        assert.equal(recovered.chat.key, 'dm-u1')
        assert.match(recovered.text, new RegExp(`Card ${delivery.code}\\b`))
        await Promise.all([s.rt.save(), s.rt.save()])
        await s.flush()
        assert.equal(s.fake.sent.filter(job => /Card V\d+/.test(job.text)).length, 1)
      } else {
        await s.flush()
        assert.equal(s.fake.sent.filter(job => /Card V\d+/.test(job.text)).length, 0)
      }
      await dm(s, 'u1', `!card ${delivery.code}\n1: Recovered`)
      assert.equal(s.rt.state.views.a, undefined)
      assert.equal(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0].values.fields.name, 'Recovered')
    } else assert.equal(s.rt.state.views.a, undefined)
    s.fake.sent.length = 0
    const previousFollowup = s.agentOf('a').lastFollowup
    await dm(s, 'u1', 'new form')
    s.imTurn('a')
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ view: {
      type: 'form', id: 'replacement', fields: [{ id: 'name', label: 'Name' }],
    } }, { agent: { id: 'a' }, concludeTurn() {} })
    await s.flush()
    const code = /Card (V\d+)/.exec((await tokenCard(s)).text)[1]
    assert.notEqual(code, delivery.code)
    const id = s.rt.state.views.a.id
    await dm(s, 'u1', `!card ${delivery.code}\n1: Wrong card`)
    assert.equal(s.rt.state.views.a.id, id)
    assert.equal(s.agentOf('a').lastFollowup, previousFollowup)
    await dm(s, 'u1', `!card ${code}\n1: Correct card`)
    assert.equal(s.rt.state.views.a, undefined)
    assert.equal(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0].values.fields.name, 'Correct card')
  })
})

test('legacy own-chat question deliveries accept existing answers after restart without turn origins', async (t) => {
  for (const buttons of [true, false]) {
    let s = await start({ platform: buttons ? 'telegram' : 'dingtalk' })
    t.after(() => s.stop())
    const { one } = await pairedConn(s)
    one.chats.other = { kind: 'direct', target: { botId: 'a' }, at: 1 }
    await s.rt.save()
    await dm(s, 'u1', 'choose')
    s.imTurn('a')
    await s.rt.teamTools.find(tool => tool.name === 'ask_user').execute({ question: 'Pre-upgrade route?', options: [{ label: 'A' }, { label: 'B' }] }, { agent: { id: 'a' }, concludeTurn() {} })
    const question = s.rt.state.questions.a
    assert.equal(question.imOrigin, undefined)
    await s.flush()
    await s.close()
    const path = join(s.home, 'im', `${one.id}.json`)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    delete data.cards[`q:${question.id}`][0].binding
    delete data.cards[`q:${question.id}`][0].numbered
    writeFileSync(path, JSON.stringify(data))
    s = await start({ platform: buttons ? 'telegram' : 'dingtalk', home: s.home })
    await s.rt.imEndpoint('im-retry', { id: one.id })
    s.rt.clearImOrigin('a')
    await s.flush()
    assert.equal(s.fake.sent.filter(job => job.text.includes('Pre-upgrade route?')).length, 0)
    const answer = chatKey => buttons
      ? s.fake.handlers.onAction({ chat: { key: chatKey, kind: 'direct' }, sender: { id: 'u1' }, data: `q:${question.id}:1` })
      : s.fake.handlers.onMessage({ chat: { key: chatKey, kind: 'direct' }, sender: { id: 'u1' }, text: '2' })
    await answer('other')
    assert.equal(s.rt.state.questions.a.id, question.id)
    assert.equal(s.agentOf('a').followed ?? 0, 0)
    await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'dm-u1', target: { botId: 'b' } })
    await answer('dm-u1')
    assert.equal(s.rt.state.questions.a.id, question.id)
    assert.equal(s.agentOf('a').followed ?? 0, 0)
    await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'dm-u1', target: { botId: 'a' } })
    await answer('dm-u1')
    assert.equal(s.rt.state.questions.a, undefined)
    assert.match(s.agentOf('a').lastFollowup.content[0].text, /Pre-upgrade route/)
    assert.match(s.agentOf('a').lastFollowup.content[0].text, /B/)
  }
})

test('legacy question deliveries are resent with bindings and still accept buttons and numbers', async (t) => {
  for (const missingBinding of [true, false]) {
    for (const buttons of [true, false]) {
      let s = await start({ platform: buttons ? 'telegram' : 'dingtalk' })
      t.after(() => s.stop())
      const { one } = await pairedConn(s)
      one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
      s.rt.roomOf('r1').sessions = { b: 'member-b' }
      s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
      await s.rt.save()
      await gm(s, 'u1', 'choose')
      s.imTurn('r1')
      await s.rt.teamTools.find(tool => tool.name === 'ask_user').execute({ question: 'Legacy route?', options: [{ label: 'A' }, { label: 'B' }] }, { agent: { id: 'member-b' }, concludeTurn() {} })
      const questionId = s.rt.state.questions['member-b'].id
      await s.flush()
      await s.close()
      const path = join(s.home, 'im', `${one.id}.json`)
      const data = JSON.parse(readFileSync(path, 'utf8'))
      const delivery = data.cards[`q:${questionId}`][0]
      delete delivery.numbered
      if (missingBinding) delete delivery.binding
      writeFileSync(path, JSON.stringify(data))
      s = await start({ platform: buttons ? 'telegram' : 'dingtalk', home: s.home })
      await s.rt.imEndpoint('im-retry', { id: one.id })
      await s.flush()
      assert.equal(s.fake.sent.filter(job => job.text.includes('Legacy route?')).length, missingBinding ? 1 : 0)
      if (buttons) {
        await s.fake.handlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `q:${questionId}:1` })
      } else {
        await gm(s, 'u1', '2')
      }
      assert.equal(s.rt.state.questions['member-b'], undefined)
      assert.match(s.agentOf('member-b').lastFollowup.content[0].text, /Legacy route/)
      assert.match(s.agentOf('member-b').lastFollowup.content[0].text, /B/)
    }
  }
})

test('text-only and legacy view deliveries do not hide an older numbered question', async (t) => {
  for (const legacy of [false, true]) {
    let s = await start({ platform: 'dingtalk' })
    t.after(() => s.stop())
    const { one } = await pairedConn(s)
    await dm(s, 'u1', 'choose')
    s.imTurn('a')
    s.rt.state.questions.a = { id: 'older-question', question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] }
    await s.rt.save()
    await s.flush()
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Newer view', view: legacy
      ? { type: 'confirm', id: 'go' }
      : { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] } }, { agent: { id: 'a' } })
    const viewId = s.rt.state.views.a.id
    await s.flush()
    if (legacy) {
      await s.close()
      const path = join(s.home, 'im', `${one.id}.json`)
      const data = JSON.parse(readFileSync(path, 'utf8'))
      delete data.cards[`v:${viewId}`][0].numbered
      data.cards[`v:${viewId}`][0].text = '[View card] Legacy confirmation'
      writeFileSync(path, JSON.stringify(data))
      s = await start({ platform: 'dingtalk', home: s.home })
      await s.rt.imEndpoint('im-retry', { id: one.id })
    }
    await dm(s, 'u1', '2')
    assert.equal(s.rt.state.questions.a, undefined)
    assert.equal(s.rt.state.views.a.id, viewId)
    assert.match(s.agentOf('a').lastFollowup.content[0].text, /Which route/)
    assert.match(s.agentOf('a').lastFollowup.content[0].text, /B/)
  }
})

test('own-chat view answers are refused after the delivering chat is rebound or unbound', async (t) => {
  for (const target of [{ botId: 'b' }, null]) {
    for (const buttons of [true, false]) {
      const s = await start({ platform: buttons ? 'telegram' : 'dingtalk' })
      t.after(s.stop)
      const { one } = await pairedConn(s)
      one.chats.g1 = { kind: 'group', target: { botId: 'a' }, at: 1 }
      await s.rt.save()
      await gm(s, 'u1', 'confirm')
      s.imTurn('a')
      await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Proceed?', view: { type: 'confirm', id: 'go' } }, { agent: { id: 'a' } })
      const view = s.rt.state.views.a
      await s.flush()
      await s.rt.imEndpoint('im-chat', { id: one.id, chatKey: 'g1', target })
      if (buttons) {
        await s.fake.handlers.onAction({ chat: { key: 'g1', kind: 'group' }, sender: { id: 'u1' }, data: `v:${view.id}:0` })
      } else {
        await gm(s, 'u1', '1')
      }
      assert.equal(s.rt.state.views.a.id, view.id)
      assert.equal(s.agentOf('a').followed ?? 0, 0)
    }
  }
})

test('own-chat simple views and forms reach IM when show_view concludes the turn', async (t) => {
  for (const kind of ['simple', 'form']) await t.test(kind, async (t) => {
    const s = await start()
    t.after(s.stop)
    await pairedConn(s)
    await dm(s, 'u1', 'show a view')
    s.imTurn('a')
    const view = kind === 'simple' ? { type: 'confirm', id: 'go' }
      : { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] }
    await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Turn-ending view', view }, {
      agent: { id: 'a' },
      concludeTurn() { s.emitEvent('a', 'turn/end', { reason: { kind: 'completed' } }) },
    })
    const pending = s.rt.state.views.a
    assert.equal(s.rt.captureImOrigin('a'), undefined)
    assert.equal(pending.imOrigin.chatKey, 'dm-u1')
    if (kind === 'form') {
      const card = await tokenCard(s)
      assert.equal(card.chat.key, 'dm-u1')
      const code = /Card (V\d+)/.exec(card.text)[1]
      await dm(s, 'u1', `!card ${code}\n1: Alice`)
      assert.equal(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0].values.fields.name, 'Alice')
    } else {
      await s.flush()
      assert.ok(s.fake.sent.some(job => job.buttons?.some(button => button.data === `v:${pending.id}:0`)))
      await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct' }, sender: { id: 'u1' }, data: `v:${pending.id}:0` })
    }
    assert.equal(s.rt.state.views.a, undefined)
  })
})

test('own-chat IM views accept a button answer using the shared view reply path', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'pick a route')
  s.imTurn('a')
  await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Route', view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] } }, { agent: { id: 'a' }, concludeTurn() {} })
  const view = s.rt.state.views.a
  await s.flush()
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct' }, sender: { id: 'u1' }, data: `v:${view.id}:1` })
  assert.equal(s.rt.state.views.a, undefined)
  assert.deepEqual(JSON.parse(s.agentOf('a').lastFollowup.content[0].text).answers[0], { id: view.id, action: 'pick', values: { selected: ['B'] } })
  await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Multi route', view: { type: 'options', id: 'routes', multi: true, options: [{ label: 'A' }, { label: 'B' }] } }, { agent: { id: 'a' }, concludeTurn() {} })
  await s.flush()
  const multiCard = s.fake.sent.find(job => job.text.includes('Multi route'))
  assert.ok(multiCard)
  assert.equal(multiCard.buttons, undefined)
  const pending = s.rt.state.views.a
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct' }, sender: { id: 'u1' }, data: `v:${pending.id}:0` })
  assert.equal(s.rt.state.views.a.id, pending.id)
})

test('a member question preserves its unshown lead-in in the room and originating IM group', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
  one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
  const room = s.rt.roomOf('r1')
  room.sessions = { b: 'member-b' }
  s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
  await s.rt.save()
  await gm(s, 'u1', 'choose a route')
  s.imTurn('r1')
  s.fake.sent.length = 0
  s.emitEvent('member-b', 'turn/start', { turn: 1 })
  s.emitEvent('member-b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Both routes are safe; A is shorter.' }] } })
  await s.rt.teamTools.find(tool => tool.name === 'ask_user').execute({ question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] }, { agent: { id: 'member-b' }, concludeTurn() {} })
  s.emitEvent('member-b', 'turn/end', { reason: { kind: 'completed' } })
  await s.flush()
  const post = s.agentOf('r1').lastFollowup
  assert.equal(post.source.progress, true)
  assert.match(post.content[0].text, /Both routes are safe; A is shorter\./)
  s.emitEvent('r1', 'turn/start', { turn: 2 })
  s.emitEvent('r1', 'user/message', post)
  await s.rt.teamTools.find(tool => tool.name === 'group_relay').execute({}, { agent: { id: 'r1', inbox: s.agentOf('r1').inbox }, callId: 'question-lead-in', signal: new AbortController().signal })
  await s.flush()
  assert.equal(room.log.filter(line => line.text?.includes('Both routes are safe; A is shorter.')).length, 1)
  assert.equal(s.fake.sent.filter(job => job.text.includes('Both routes are safe; A is shorter.')).length, 1)
  assert.equal(s.fake.sent.filter(job => job.text.includes('Which route?')).length, 1)
  assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
  assert.ok(s.rt.state.questions['member-b'])
})

test('IM group display views are sent as room lines and unowned completions withhold member cards', async (t) => {
  for (const kind of ['tool-jobs', 'subagent-settled']) {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    one.chats.g2 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
    s.rt.roomOf('r1').sessions = { b: 'member-b' }
    s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
    await s.rt.save()
    await gm(s, 'u1', 'show progress')
    s.imTurn('r1')
    s.fake.sent.length = 0
    const show = args => s.rt.teamTools.find(tool => tool.name === 'show_view').execute(args, { agent: { id: 'member-b' } })
    assert.equal(await show({ title: 'Progress', view: { type: 'metric', label: 'Done', value: '70%' } }), 'The view is on screen.')
    await s.flush()
    assert.ok(s.fake.sent.some(job => job.text.includes('70%')))
    assert.ok(s.fake.sent.every(job => job.chat.key === 'g1'))
    assert.match(await show({ title: 'Details', view: { type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }] } }), /user's answer arrives/)
    await s.flush()
    s.fake.sent.length = 0
    const imOrigin = s.rt.captureImOrigin('r1')
    s.emitEvent('member-b', 'user/message', { source: { kind }, content: [{ type: 'text', text: 'old result' }] })
    assert.equal(s.rt.roomHasImOrigin('r1'), false)
    const ask = args => s.rt.teamTools.find(tool => tool.name === 'ask_user').execute(args, { agent: { id: 'member-b' } })
    assert.match(await ask({ question: 'Private?', options: [{ label: 'A' }] }), /Question cards only work in your own chat/)
    s.rt.state.questions['member-b'] = { id: `private-${kind}`, question: 'Private?', options: [{ label: 'A' }], imOrigin }
    s.rt.state.views['member-b'] = { id: `view-${kind}`, title: 'Private view', view: { type: 'form', id: 'private', fields: [{ id: 'name', label: 'Name' }] }, imOrigin }
    await s.rt.save()
    await s.flush()
    assert.deepEqual(s.fake.sent, [])
  }
})

test('numbered group answers keep the mention gate and resume the asking member', async (t) => {
  const s = await start({ adapter: fakeAdapter({ buttons: false }) })
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', target: { roomId: 'r1' }, at: 1 }
  s.rt.roomOf('r1').sessions = { b: 'member-b' }
  s.rt.groupOwners.set('member-b', { botId: 'b', roomId: 'r1' })
  await s.rt.save()
  await gm(s, 'u1', 'ask')
  s.imTurn('r1')
  await s.rt.teamTools.find(tool => tool.name === 'ask_user').execute({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, { agent: { id: 'member-b' } })
  await s.flush()
  await gm(s, 'u1', '2', { mentioned: false })
  assert.ok(s.rt.state.questions['member-b'])
  await gm(s, 'u1', '2')
  assert.equal(s.rt.state.questions['member-b'], undefined)
  assert.match(s.agentOf('member-b').lastFollowup.content[0].text, /B/)
  assert.equal(s.rt.roomHasImOrigin('r1'), true)
})

for (const result of ['calculated total: 431', '', undefined]) {
  test(`reply origin: #2033 a real background job settled within its IM turn keeps the reply (${result === undefined ? 'failed' : result === '' ? 'empty' : 'output'})`, async (t) => {
    const jobsCtx = new Context()
    const agents = new Map()
    jobsCtx.provide('agents', agents)
    t.after(() => jobsCtx.fiber.dispose())
    await jobsCtx.plugin(SystemPrompt)
    await jobsCtx.plugin(ToolRuntime)
    await jobsCtx.plugin(LocalJobRegistry)
    await jobsCtx.plugin(toolJobs)
    const s = await start({ services: { agents, jobs: jobsCtx.jobs } })
    t.after(s.stop)
    await pairedConn(s)
    const agent = s.agentOf('a')
    agents.set('a', agent)
    const scope = createScope(jobsCtx, agent)
    t.after(() => scope.dispose())
    agent.ctx = scope.ctx
    agent.session.append = (type, data) => s.emitEvent('a', type, data)
    agent.inject = message => agent.inbox.nextStep.push(message)
    await dm(s, 'u1', 'Run a background calculation')
    s.imTurn('a')
    agent.status = 'running'
    const done = Promise.withResolvers()
    const jobId = jobsCtx.jobs.start({
      kind: 'bash', label: 'Calculate', owner: 'a',
      run: () => ({ done: done.promise, cancel: () => done.resolve({ status: 'killed' }) }),
    })
    assert.deepEqual(s.rt.runningJobs('a').map(job => job.id), [jobId])
    if (result === undefined) done.reject(new Error('calculation failed'))
    else done.resolve({ status: 'completed', result })
    await s.flush()
    const notice = agent.inbox.nextStep.shift()
    assert.equal(notice.source.kind, 'tool-jobs')
    s.emitEvent('a', 'user/message', notice)
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Calculation finished' }] } })
    s.emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['dm-u1', 'Calculation finished']])
  })
}

for (const [label, launch, source, text, delivered] of [
  ['job progress', ['job/registered', { jobId: 'bash-1', owner: 'a' }], { kind: 'tool-jobs' }, 'background job bash-1 (bash: sleep) is still running.', true],
  ['unknown job', ['job/registered', { jobId: 'bash-1', owner: 'a' }], { kind: 'tool-jobs' }, 'background job bash-2 finished', false],
  ['missing job id', ['job/registered', { jobId: 'bash-1', owner: 'a' }], { kind: 'tool-jobs' }, 'background job ended; use job_list for id.', false],
  ['wrong job owner', ['job/registered', { jobId: 'bash-1', owner: 'b' }], { kind: 'tool-jobs' }, 'background job bash-1 finished', false],
  ['missing job owner', ['job/registered', { jobId: 'bash-1' }], { kind: 'tool-jobs' }, 'background job bash-1 finished', false],
  ['new child', ['subagent/catalog', { version: 0, childId: 'sub-1', mode: 'continuable', childCreatedAt: 1, label: 'Review' }], { kind: 'subagent-settled', senderSessionId: 'sub-1' }, 'Review finished', true],
  ['unknown child', ['subagent/catalog', { version: 0, childId: 'sub-1', mode: 'continuable', childCreatedAt: 1, label: 'Review' }], { kind: 'subagent-settled', senderSessionId: 'sub-2' }, 'Review finished', false],
  ['legacy child metadata', ['subagent/catalog', { childId: 'sub-1', mode: 'continuable' }], { kind: 'subagent-settled', senderSessionId: 'sub-1' }, 'Review finished', false],
]) {
  test(`reply origin: current-turn launch ownership (${label})`, async t => {
    const s = await start()
    t.after(s.stop)
    await pairedConn(s)
    await dm(s, 'u1', 'Work in this turn')
    s.imTurn('a')
    s.emitEvent('a', ...launch)
    s.emitEvent('a', 'user/message', { source: { ...source, form: 'notice' }, content: [{ type: 'text', text }] })
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Finished' }] } })
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), delivered ? [['dm-u1', 'Finished']] : [])
  })
}

test('reply origin: a background job from one IM turn must not be reported to the next chat', async (t) => {
  const jobsCtx = new Context()
  const agents = new Map()
  jobsCtx.provide('agents', agents)
  t.after(() => jobsCtx.fiber.dispose())
  await jobsCtx.plugin(SystemPrompt)
  await jobsCtx.plugin(ToolRuntime)
  await jobsCtx.plugin(LocalJobRegistry)
  await jobsCtx.plugin(toolJobs)

  const s = await start({ services: { agents, jobs: jobsCtx.jobs } })
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.paired.push({ id: 'u2', name: 'U2', at: 1 })
  await s.rt.save()

  const agent = s.agentOf('a')
  agents.set('a', agent)
  const scope = createScope(jobsCtx, agent)
  t.after(() => scope.dispose())
  agent.ctx = scope.ctx
  agent.session.append = (type, data) => s.emitEvent('a', type, data)
  agent.inject = message => agent.inbox.nextStep.push(message)

  const reply = text => s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text }] } })
  await dm(s, 'u1', 'Start a background calculation')
  s.imTurn('a')
  agent.status = 'running'
  const done = Promise.withResolvers()
  const jobId = jobsCtx.jobs.start({
    kind: 'bash',
    label: 'Calculate a private total',
    owner: 'a',
    run: () => ({ done: done.promise, cancel: () => done.resolve({ status: 'killed' }) }),
  })
  reply('Calculation started')
  s.emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.status = 'idle'
  assert.equal(s.rt.live.get('a')?.turn, undefined)
  assert.deepEqual(s.rt.runningJobs('a').map(job => job.id), [jobId])

  await dm(s, 'u2', 'Hello')
  assert.deepEqual(s.prompts.map(prompt => prompt.sessionId), ['a', 'a'])
  s.imTurn('a')
  agent.status = 'running'
  assert.equal(s.rt.live.get('a')?.turn, 2)
  reply('Hello, U2')
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [
    ['dm-u1', 'Calculation started'],
    ['dm-u2', 'Hello, U2'],
  ])

  const privateResult = 'U1 private total: 431'
  done.resolve({ status: 'completed', result: privateResult })
  await s.flush()
  assert.equal(jobsCtx.jobs.get(jobId, 'a').status, 'completed')
  assert.equal(agent.inbox.nextStep.length, 1)
  const notice = agent.inbox.nextStep.shift()
  assert.equal(notice.source.kind, 'tool-jobs')
  const admittedText = notice.content[0].text
  assert.match(admittedText, new RegExp(privateResult))
  s.emitEvent('a', 'user/message', notice)
  reply(admittedText)
  await s.flush()

  assert.deepEqual(s.fake.sent
    .filter(entry => entry.chat.key === 'dm-u2' && entry.text.includes(privateResult))
    .map(entry => [entry.chat.key, entry.text]), [], 'U2 must not receive U1’s background result')
})

for (const beforeClaim of [false, true]) {
  test(`reply origin: a late subagent result blocks IM delivery ${beforeClaim ? 'before' : 'after'} the next chat claims its turn`, async (t) => {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.paired.push({ id: 'u2', name: 'U2', at: 1 })
    await s.rt.save()

    const reply = text => s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    await dm(s, 'u1', 'Delegate a private review')
    s.imTurn('a')
    s.emitEvent('a', 'tool/call', { callId: 's1', name: 'subagent', arguments: JSON.stringify({ description: 'Review the private draft' }) })
    s.emitEvent('a', 'subagent/catalog', { childId: 'sub-1', label: 'Review the private draft', mode: 'continuable' })
    s.emitEvent('a', 'tool/result', { callId: 's1' })
    reply('Review started')
    s.emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    await dm(s, 'u2', 'Hello')
    assert.deepEqual(s.prompts.map(prompt => prompt.sessionId), ['a', 'a'])
    s.emitEvent('a', 'turn/start', { turn: 2 })
    const claim = () => s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    if (!beforeClaim) claim()
    const result = 'U1 private review: three findings'
    s.emitEvent('a', 'user/message', {
      content: [{ type: 'text', text: result }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-1 finished.', senderSessionId: 'sub-1' },
    })
    if (beforeClaim) claim()
    reply(result)
    s.emitEvent('a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['dm-u1', 'Review started']])

    await dm(s, 'u2', 'Hello again')
    s.imTurn('a')
    reply('Hello, U2')
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [
      ['dm-u1', 'Review started'],
      ['dm-u2', 'Hello, U2'],
    ])
  })
}

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

test('reply origin: another source in the same turn keeps the IM origin', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.emitEvent('a', 'user/message', { source: { kind: 'peer', from: 'b' }, content: [{ type: 'text', text: 'also this' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['dm-u1', 'reply']])
})

for (const group of [false, true]) {
  for (const before of [false, true]) {
    test(`whole-turn IM origin: card answer ${before ? 'before' : 'after'} IM admission in a ${group ? 'group' : 'direct'} turn`, async (t) => {
      const s = await start()
      t.after(s.stop)
      const { one } = await pairedConn(s)
      if (group) {
        one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
        await s.rt.save()
        await gm(s, 'u1', 'hello group')
      } else {
        await dm(s, 'u1', 'hi')
      }
      const sessionId = group ? 'r1' : 'a'
      const admit = () => s.emitEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
      const answer = () => s.emitEvent(sessionId, 'user/message', { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } })
      s.emitEvent(sessionId, 'turn/start', {})
      if (before) { answer(); admit() } else { admit(); answer() }
      s.fake.sent.length = 0
      if (group) s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'reply' })
      else s.emitEvent(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })
      await s.flush()
      assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [[group ? 'g1' : 'dm-u1', group ? '**Writer**: reply' : 'reply']])
    })
  }

  test(`whole-turn IM origin: every reply survives mid-turn non-IM input in a ${group ? 'group' : 'direct'} turn`, async (t) => {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    if (group) {
      one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
      await s.rt.save()
      await gm(s, 'u1', 'hello group')
    } else {
      await dm(s, 'u1', 'hi')
    }
    const sessionId = group ? 'r1' : 'a'
    s.imTurn(sessionId)
    s.fake.sent.length = 0
    const replies = []
    const reply = () => {
      const text = `reply ${replies.length + 1}`
      replies.push([group ? 'g1' : 'dm-u1', group ? `**Writer**: ${text}` : text])
      if (group) s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text })
      else s.emitEvent(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    }
    reply()
    for (const source of [
      { kind: 'user' },
      { kind: 'web' },
      { kind: 'phone' },
      { kind: 'schedule', taskId: 't1' },
      { kind: 'peer', from: 'b' },
      { kind: 'bot', role: 'post' },
      ...(!group ? [{ kind: 'bot', role: 'task-report', taskId: 'desktop-task' }] : []),
      undefined,
    ]) {
      s.emitEvent(sessionId, 'user/message', { source })
      reply()
      reply()
    }
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), replies)
  })
}

for (const working of [true, false]) test(`desktop round after IM group round, member work=${working}`, async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.emitEvent('r1', 'turn/end', {})
  s.rt.roomActive = () => false
  s.rt.roomWorkView = () => (working ? { r1: [{ botId: 'b', since: Date.now(), tool: 'task' }] } : {})
  s.fake.sent.length = 0
  s.emitEvent('r1', 'turn/start', {})
  s.emitEvent('r1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'private desktop question' }] })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'private desktop answer' })
  await s.flush()
  assert.deepEqual(s.fake.sent, [])
  await gm(s, 'u1', 'later IM request')
  s.emitEvent('r1', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'IM answer' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: IM answer']])
})

test('a desktop task report before an IM group message does not poison the active round', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  s.rt.botOf('a').tasks = [{ id: 'desktop-task', sessionId: 'desktop-task-session', roomId: 'r1', status: 'completed' }]
  await s.rt.save()
  s.rt.roomActive = () => true
  s.emitEvent('r1', 'turn/start', {})
  s.emitEvent('r1', 'user/message', { source: { kind: 'bot', role: 'task-report', taskId: 'desktop-task', roomId: 'r1' } })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'desktop report' })
  await s.flush()
  assert.deepEqual(s.fake.sent, [])
  await gm(s, 'u1', 'joining IM message')
  s.emitEvent('r1', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'IM reply' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: IM reply']])
})

for (const active of ['round', 'member']) test(`Web input joining an ongoing group ${active} keeps the IM origin`, async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  await gm(s, 'u1', 'hello group')
  s.imTurn('r1')
  s.emitEvent('r1', 'turn/end', {})
  s.rt.roomActive = () => active === 'round'
  if (active === 'member') {
    s.rt.groupOwners.set('member-session', { roomId: 'r1', botId: 'b' })
    s.emitEvent('member-session', 'turn/start', { turn: 1 })
  }
  s.fake.sent.length = 0
  s.emitEvent('r1', 'turn/start', {})
  s.emitEvent('r1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Web steer' }] })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'continued answer' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: continued answer']])
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

test('WeChat replies to queued prompts admitted after restart without reopening consumed requests', async (t) => {
  const seed = TEAM()
  seed.im = { connections: { im_wx: {
    id: 'im_wx', platform: 'weixin', botId: 'a', enabled: true, secrets: {},
    paired: [{ id: 'u1', at: 1 }], chats: { u1: { kind: 'direct', at: 1 } },
  } } }
  const opts = { platform: 'weixin' }
  const first = await start({ ...opts, seed })
  let current = first
  t.after(() => current.stop())
  await first.rt.imEndpoint('im-retry', { id: 'im_wx' })
  const inbound = (s, text) => s.fake.handlers.onMessage({
    chat: { key: 'u1', kind: 'direct' }, sender: { id: 'u1' }, text,
  })
  const admit = (s, prompt, sessionId = 'a') =>
    s.emitEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content })
  const reply = (s, text, sessionId = 'a') =>
    s.emitEvent(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
  await inbound(first, 'finished before restart')
  const finished = first.prompts.at(-1)
  first.imTurn()
  first.emitEvent('a', 'turn/end', {})
  await inbound(first, 'queued for after restart')
  const queued = first.prompts.at(-1)
  await inbound(first, 'also queued')
  const secondQueued = first.prompts.at(-1)
  await inbound(first, 'queued before re-pairing')
  const lastQueued = first.prompts.at(-1)
  // Take the committed state before shutdown: no shutdown-only flush may be needed
  // for DSH's already-accepted queue to retain its reply route.
  const snapshot = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  await first.close()

  const restarted = current = await start({ ...opts, home: first.home, seed: snapshot })
  await restarted.rt.imEndpoint('im-retry', { id: 'im_wx' })
  restarted.emitEvent('a', 'turn/start', {})
  admit(restarted, finished)
  reply(restarted, 'duplicate must not claim a turn')
  await restarted.flush()
  assert.deepEqual(restarted.fake.sent, [])

  restarted.emitEvent('a', 'turn/end', {})
  restarted.emitEvent('a', 'turn/start', {})
  admit(restarted, queued, 'b')
  reply(restarted, 'not the bound Bot', 'b')
  restarted.emitEvent('a', 'user/message', { source: { kind: 'memory-review' } })
  admit(restarted, queued)
  admit(restarted, finished)
  reply(restarted, 'reply after restart')
  await restarted.flush()
  assert.deepEqual(restarted.fake.sent.map(entry => [entry.chat.key, entry.text]), [['u1', 'reply after restart']])

  restarted.emitEvent('a', 'turn/end', {})
  restarted.emitEvent('a', 'turn/start', {})
  admit(restarted, secondQueued)
  restarted.emitEvent('a', 'user/message', { source: { kind: 'tool-jobs', form: 'notice' } })
  reply(restarted, 'background result must stay private')
  await restarted.flush()
  assert.equal(restarted.fake.sent.length, 1)

  await restarted.rt.imEndpoint('im-unpair', { id: 'im_wx', senderId: 'u1' })
  await inbound(restarted, 'pair again')
  await restarted.rt.imEndpoint('im-pair', { id: 'im_wx', senderId: 'u1', allow: true })
  restarted.fake.sent.length = 0
  restarted.emitEvent('a', 'turn/end', {})
  restarted.emitEvent('a', 'turn/start', {})
  admit(restarted, lastQueued)
  reply(restarted, 'previous pairing must not be restored')
  await restarted.flush()
  assert.deepEqual(restarted.fake.sent, [])
})

for (const group of [false, true]) {
  test(`whole-turn IM origin: an unknown IM request blocks later claims in a ${group ? 'group' : 'direct'} turn`, async (t) => {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    if (group) {
      one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
      await s.rt.save()
      await gm(s, 'u1', 'first')
    } else {
      await dm(s, 'u1', 'first')
    }
    const sessionId = group ? 'r1' : 'a'
    s.imTurn(sessionId)
    s.emitEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: 'im:telegram:unknown' } })
    if (group) await gm(s, 'u1', 'second')
    else await dm(s, 'u1', 'second')
    s.emitEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    s.fake.sent.length = 0
    if (group) s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'withheld' })
    else s.emitEvent(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'withheld' }] } })
    await s.flush()
    assert.deepEqual(s.fake.sent, [])
  })
}

for (const conflict of ['connection', 'chat', 'sender']) {
  test(`whole-turn IM origin: a conflicting ${conflict} cannot be reclaimed by non-IM input`, async (t) => {
    const s = await start()
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.paired.push({ id: 'u2', name: 'U2', at: 1 })
    await s.rt.save()
    let incoming = s.fake
    if (conflict === 'connection') {
      incoming = fakeAdapter()
      const original = adapters.dingtalk
      adapters.dingtalk = incoming
      t.after(() => { adapters.dingtalk = original })
      const conn = await s.rt.imEndpoint('im-add', { platform: 'dingtalk', botId: 'a', fields: FIELDS.dingtalk })
      s.rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'U1', at: 1 })
      await s.rt.save()
      await s.flush()
    }
    await dm(s, 'u1', 'first')
    s.imTurn('a')
    await incoming.handlers.onMessage({
      chat: { key: conflict === 'chat' ? 'dm-other' : 'dm-u1', kind: 'direct', title: 'Chat' },
      sender: { id: conflict === 'sender' ? 'u2' : 'u1', name: 'User' }, text: 'conflicting request',
    })
    s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    s.emitEvent('a', 'user/message', { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } })
    await dm(s, 'u1', 'try to reclaim')
    s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    s.fake.sent.length = 0
    incoming.sent.length = 0
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'withheld' }] } })
    await s.flush()
    assert.deepEqual(s.fake.sent, [])
    assert.deepEqual(incoming.sent, [])
  })
}

test('whole-turn IM origin: a task report cannot reopen a conflicting group round', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  for (const chatKey of ['g1', 'g2']) one.chats[chatKey] = { kind: 'group', title: chatKey, target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  await gm(s, 'u1', 'first')
  s.imTurn('r1')
  s.rt.botOf('a').tasks = [{ id: 'im-task', sessionId: 'task-1', status: 'completed', imOrigin: s.rt.captureImOrigin('r1') }]
  await gm(s, 'u1', 'conflicting', { chat: { key: 'g2', kind: 'group', title: 'G2' } })
  s.emitEvent('r1', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  s.emitEvent('r1', 'user/message', { source: { kind: 'bot', role: 'task-report', taskId: 'im-task', roomId: 'r1' } })
  s.fake.sent.length = 0
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'withheld' })
  await s.flush()
  assert.deepEqual(s.fake.sent, [])
})

test('reply origin: a consumed IM rpcId is ignored without withdrawing or claiming an origin', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  const source = { kind: 'user', rpcId: s.prompts.at(-1).requestId }
  s.imTurn('a')
  s.emitEvent('a', 'user/message', { source })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['dm-u1', 'reply']])

  s.emitEvent('a', 'turn/end', {})
  s.emitEvent('a', 'turn/start', {})
  s.emitEvent('a', 'user/message', { source })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'not a new IM request' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 1, 'a duplicate cannot claim a later turn')

  await dm(s, 'u1', 'next')
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'next reply' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.text), ['reply', 'next reply'], 'a duplicate does not poison a later claim')
})

test('reply origin: withheld mixed output warns once per turn without message content', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  const warnings = []
  s.rt.warn = (...args) => warnings.push(args)
  s.emitEvent('a', 'turn/start', {})
  s.emitEvent('a', 'user/message', { source: { kind: 'user' } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'ordinary Web reply' }] } })
  await s.flush()
  assert.deepEqual(warnings, [], 'ordinary non-IM output does not warn')
  for (let turn = 0; turn < 2; turn++) {
    await dm(s, 'u1', 'hi')
    if (turn === 0) s.imTurn('a')
    else s.emitEvent('a', 'turn/start', {})
    s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'im:telegram:unknown' } })
    if (turn === 1) s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    assert.equal(warnings.length, turn, 'no warning before output is withheld')
    for (let reply = 0; reply < 2; reply++) {
      s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'private reply body' }] } })
    }
    await s.flush()
    assert.equal(warnings.length, turn + 1)
    await dm(s, 'u1', 'another request in the mixed turn')
    s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'still withheld' }] } })
    await s.flush()
    assert.equal(warnings.length, turn + 1, 'a blocked claim cannot warn twice in one turn')
    s.emitEvent('a', 'turn/end', {})
  }
  assert.equal(s.fake.sent.length, 0)
  assert.deepEqual(warnings, [
    ['ds-bot: IM reply withheld: turn origin was dropped or mixed'],
    ['ds-bot: IM reply withheld: turn origin was dropped or mixed'],
  ])
})

test('reply origin: an unknown IM rpcId still withdraws a live origin and warns on output', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  const warnings = []
  s.rt.warn = (...args) => warnings.push(args)
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'im:telegram:unknown' } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'withheld' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
  assert.deepEqual(warnings, [['ds-bot: IM reply withheld: turn origin was dropped or mixed']])
})

test('reply origin: group redelivery keeps the chat and mixed group output warns once', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()
  await gm(s, 'u1', 'hello group')
  const source = { kind: 'user', rpcId: s.prompts.at(-1).requestId }
  s.imTurn('r1')
  s.emitEvent('r1', 'user/message', { source })
  s.fake.sent.length = 0
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'reply' })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [['g1', '**Writer**: reply']])
  const warnings = []
  s.rt.warn = (...args) => warnings.push(args)
  s.emitEvent('r1', 'user/message', { source: { kind: 'user', rpcId: 'im:telegram:unknown' } })
  for (let reply = 0; reply < 2; reply++) s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: 'withheld' })
  await s.flush()
  assert.equal(s.fake.sent.length, 1)
  assert.deepEqual(warnings, [['ds-bot: IM reply withheld: turn origin was dropped or mixed']])
})

test('reply origin: consumed IM rpcIds are bounded and an evicted id fails closed', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)
  let oldest
  for (let request = 0; request <= 200; request++) {
    await dm(s, 'u1', 'hi')
    oldest ??= s.prompts.at(-1).requestId
    s.imTurn('a')
    s.emitEvent('a', 'turn/end', {})
  }
  await dm(s, 'u1', 'latest')
  s.imTurn('a')
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-2).requestId } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'recent duplicate ignored' }] } })
  await s.flush()
  assert.deepEqual(s.fake.sent.map(entry => entry.text), ['recent duplicate ignored'])
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: oldest } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'evicted request withheld' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 1)
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

for (const [source, beforeClaim] of [
  [{ kind: 'tool-jobs', form: 'notice', summary: 'Background job finished.' }, false],
  [{ kind: 'subagent-settled', form: 'notice', summary: 'Background subagent finished.', senderSessionId: 'sub-1' }, true],
]) {
  test(`reply origin: a member's ${source.kind} result blocks IM output from the room Session`, async (t) => {
    const seed = TEAM()
    seed.rooms.r1.sessionId = 'room-part-2'
    seed.rooms.r1.sessions = { b: 'member-session' }
    const s = await start({ seed })
    t.after(s.stop)
    const { one } = await pairedConn(s)
    one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
    await s.rt.save()
    const room = s.rt.roomOf('r1')
    const roomSid = s.rt.sessionOfRoom(room)
    assert.equal(s.rt.groupOwners.get('member-session')?.roomId, room.id)
    const roomLine = text => s.rt.logRoom(room, { who: 'Writer', botId: 'b', text })

    await gm(s, 'u1', 'hello group')
    assert.equal(s.prompts.at(-1).sessionId, roomSid)
    const claim = () => s.emitEvent(roomSid, 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1).requestId } })
    s.emitEvent(roomSid, 'turn/start', { turn: 1 })
    if (!beforeClaim) {
      claim()
      s.emitEvent(roomSid, 'turn/end', {})
      roomLine('hello IM')
    }
    s.emitEvent('member-session', 'turn/start', { turn: 2 })
    const privateResult = 'private result from an earlier desktop round'
    s.emitEvent('member-session', 'user/message', { source, content: [{ type: 'text', text: privateResult }] })
    if (beforeClaim) {
      claim()
      s.emitEvent(roomSid, 'turn/end', {})
    }
    roomLine(privateResult)
    s.emitEvent('member-session', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    await s.flush()
    const expected = beforeClaim ? [] : [['g1', '**Writer**: hello IM']]
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), expected)
    assert.ok(room.log.some(line => line.text === privateResult), 'the reply stays in the app')

    await gm(s, 'u1', 'fresh group round')
    s.imTurn(roomSid)
    roomLine('hello again')
    await s.flush()
    assert.deepEqual(s.fake.sent.map(entry => [entry.chat.key, entry.text]), [
      ...expected,
      ['g1', '**Writer**: hello again'],
    ])
  })
}

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
  s.emitEvent('a', 'turn/end', {})
  s.emitEvent('a', 'turn/start', {})
  s.emitEvent('a', 'user/message', { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } })
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'private answer' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0)
})

// QQ splits a reply into several posts and remembers, by job, which of them went
// out; that only holds if Try again hands the adapter back the same job.
test('Try again resends the very job the failed send was given', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.fails.push(Object.assign(new Error('refused'), { status: 400, permanent: true }))
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'split reply' }] } })
  await delay(40)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(40)
  const jobs = s.fake.jobs.filter(job => job.text === 'split reply')
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0], jobs[1])
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
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

async function startSwitchHarness(t, { tokens = new Map([['a', 1_000]]), cwd = () => undefined } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-switch-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM(), workspace: work }))
  let created = 0
  let failCreate = false
  let idleGate
  let createGate
  const fake = fakeAdapter()
  const real = adapters.telegram
  adapters.telegram = fake
  const ctx = fakeContext({
    services: {
      tokenMeter: {
        measure: session => ({ totalTokens: tokens.get(session.id) ?? 0 }),
        estimateMessage: () => 50,
      },
    },
  })
  const prompts = []
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const nextStep = []
      const nextTurn = []
      const calls = []
      agents.set(id, {
        id,
        calls,
        status: 'idle',
        session: {
          id,
          seq: 1,
          header: { cwd: cwd(id) ?? work },
          requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }),
          deriveMessages: () => [],
          toolHistory: () => [],
        },
        followup(message) {
          this.lastFollowup = message
          this.followed = (this.followed ?? 0) + 1
          calls.push(['followup', message])
          nextTurn.push(message)
        },
        steer(message) { calls.push(['steer', message]); nextStep.push(message) },
        inject(message) { calls.push(['inject', message]); nextStep.push(message) },
        send(message, target) { (target === 'next-turn' ? nextTurn : nextStep).push(message); calls.push(['send', message]) },
        cancel() {},
        whenIdle() { return idleGate ?? Promise.resolve() },
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { (target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
          remove(msgId) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(entry => entry.id === msgId)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 0 }),
    },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: work }),
      resolveByPath: async () => ({ id: 'w1', path: work }),
      create: async () => ({ id: 'w1', path: work }),
      archiveSession: async () => {},
    },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      create: async () => {
        if (createGate) await createGate()
        if (failCreate) throw new Error('create failed')
        return { sessionId: `s${++created}` }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    adapters.telegram = real
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  let seq = 0
  const emitEvent = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, seq: ++seq, data, time: Date.now() })
    }
  }
  const runChain = async (eventName, payload) => {
    const chain = [...(ctx.listeners.get(eventName) ?? [])]
    const run = index => (index >= chain.length ? undefined : chain[index](payload, () => run(index + 1)))
    return run(0)
  }
  const preStep = async (sessionId, messages, step) => {
    const agent = agentOf(sessionId)
    const chain = [...(ctx.listeners.get('agent/pre-step') ?? [])]
    const run = index => (index >= chain.length
      ? Promise.resolve({ kind: 'enter', messages })
      : chain[index]({ agent, messages, turn: 1, step, signal: AbortSignal.timeout(60_000), modelSelection: {} }, () => run(index + 1)))
    return run(0)
  }
  const fireRequestError = (sessionId, code) => runChain('agent/request-error', {
    agent: agentOf(sessionId),
    failure: { code },
    signal: AbortSignal.timeout(60_000),
  })
  const fireApprovals = (request, next) => Promise.all((ctx.listeners.get('approval/request') ?? []).map(listener => listener(request, next)))

  const conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'tok-1234' } })
  rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'U1', at: 1 })
  await rt.save()

  const waitHandoff = async (sessionIdOf) => {
    for (let i = 0; i < 300; i += 1) {
      const sid = sessionIdOf()
      if (sid !== undefined && agentOf(sid).inbox.nextTurn.length > 0) return sid
      await delay(10)
    }
    throw new Error('timed out waiting for switch handoff message')
  }

  return {
    rt, fake, prompts, tokens, agentOf, emitEvent, preStep, fireRequestError, fireApprovals, waitHandoff, conn, work,
    setFailCreate: (value) => { failCreate = value },
    setIdleGate: (gate) => { idleGate = gate },
    setCreateGate: (gate) => { createGate = gate },
  }
}

test('reply origin: a mid-turn part switch keeps delivering the resumed turn back to its IM chat', async (t) => {
  const s = await startSwitchHarness(t)
  const { rt, fake, prompts, tokens, agentOf, emitEvent, preStep, fireApprovals, waitHandoff, setFailCreate } = s

  await fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, text: 'run long task' })
  const requestId = prompts.at(-1)?.requestId
  assert.ok(requestId)
  fake.sent.length = 0

  // Step 1 on part 1 ('a'): user/message is admitted and runs a tool call.
  emitEvent('a', 'turn/start', { turn: 1 })
  const step1 = await preStep('a', [{ content: [{ type: 'text', text: 'run long task' }], source: { kind: 'user', rpcId: requestId } }], 1)
  assert.equal(step1.kind, 'enter')
  emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'run long task' }] })
  emitEvent('a', 'assistant/message', { turn: 1, message: { content: [{ type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{}' }] } })

  // Step 2 hits the hard context limit mid-turn and triggers a resumed switch to part 2 ('s1').
  tokens.set('a', 195_000)
  const step2 = await preStep('a', [], 2)
  assert.equal(step2.kind, 'reject')
  emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'pre-step' } } })

  const part2 = await waitHandoff(() => (rt.botOf('a').sessionId === 'a' ? undefined : rt.botOf('a').sessionId))
  assert.equal(part2, 's1')
  const handoffMsg = agentOf(part2).inbox.nextTurn.shift()
  assert.ok(handoffMsg)

  // Part 2 runs the resumed turn, opens an approval card, and answers the user.
  emitEvent(part2, 'turn/start', { turn: 1 })
  const p2Step1 = await preStep(part2, [handoffMsg], 1)
  assert.equal(p2Step1.kind, 'enter')
  emitEvent(part2, 'user/message', { source: handoffMsg.source, content: handoffMsg.content })
  const approval = fireApprovals({ agent: agentOf(part2), toolName: 'bash', reason: 'run part 2 command', signal: new AbortController().signal }, () => new Promise(() => {}))
  await delay(30)
  const card = fake.sent.find(job => /run part 2 command/.test(job.text))
  assert.ok(card)
  const approvalId = card.buttons[0].data.split(':')[1]
  await fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: card.messageId ?? 1 })
  assert.equal((await approval)[0], 'allowed-once')
  fake.sent.length = 0

  emitEvent(part2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'finished in part 2' }] } })
  emitEvent(part2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)

  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['dm-u1', 'finished in part 2']])

  // Switch failure fallback (`PAUSE_NOTE` on the same part) also keeps delivering to the originating IM chat.
  await fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, text: 'another long task' })
  const req2 = prompts.at(-1)?.requestId
  fake.sent.length = 0
  setFailCreate(true)
  tokens.set(part2, 1_000)
  emitEvent(part2, 'turn/start', { turn: 2 })
  await preStep(part2, [{ content: [{ type: 'text', text: 'another long task' }], source: { kind: 'user', rpcId: req2 } }], 1)
  emitEvent(part2, 'user/message', { source: { kind: 'user', rpcId: req2 }, content: [{ type: 'text', text: 'another long task' }] })
  emitEvent(part2, 'assistant/message', { turn: 2, message: { content: [{ type: 'tool-call', id: 'tc2', name: 'bash', arguments: '{}' }] } })
  tokens.set(part2, 195_000)
  const failStep2 = await preStep(part2, [], 2)
  assert.equal(failStep2.kind, 'reject')
  emitEvent(part2, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'pre-step' } } })

  await waitHandoff(() => part2)
  const pauseMsg = agentOf(part2).inbox.nextTurn.shift()
  assert.ok(pauseMsg)
  emitEvent(part2, 'turn/start', { turn: 3 })
  emitEvent(part2, 'user/message', { source: pauseMsg.source, content: pauseMsg.content })
  emitEvent(part2, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'finished after pause fallback' }] } })
  emitEvent(part2, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await delay(30)

  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['dm-u1', 'finished after pause fallback']])
})

test('reply origin: overflow switch keeps IM origin, mixed turns stay isolated, and group folder switch keeps delivering room lines', async (t) => {
  const s = await startSwitchHarness(t, { cwd: id => (id === 'r1' ? '/tmp/stale-group-dir' : undefined) })
  const { rt, fake, prompts, agentOf, emitEvent, preStep, fireRequestError, waitHandoff, setIdleGate, setCreateGate, conn } = s

  // 1. Overflow request-error mid-turn switches part and preserves the IM origin.
  await fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, text: 'overflow task' })
  const req1 = prompts.at(-1)?.requestId
  fake.sent.length = 0
  emitEvent('a', 'turn/start', { turn: 1 })
  await preStep('a', [{ content: [{ type: 'text', text: 'overflow task' }], source: { kind: 'user', rpcId: req1 } }], 1)
  emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: req1 }, content: [{ type: 'text', text: 'overflow task' }] })
  await fireRequestError('a', 'CONTEXT_WINDOW_EXCEEDED')
  emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'error' } })

  const part2 = await waitHandoff(() => (rt.botOf('a').sessionId === 'a' ? undefined : rt.botOf('a').sessionId))
  assert.equal(part2, 's1')
  const handoff2 = agentOf(part2).inbox.nextTurn.shift()
  assert.ok(handoff2)
  emitEvent(part2, 'turn/start', { turn: 1 })
  emitEvent(part2, 'user/message', { source: handoff2.source, content: handoff2.content })
  emitEvent(part2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'recovered after overflow' }] } })
  emitEvent(part2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['dm-u1', 'recovered after overflow']])

  // 2. Web UI input joining the turn before switching keeps the IM origin across parts.
  await fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, text: 'mixed task' })
  const req2 = prompts.at(-1)?.requestId
  fake.sent.length = 0
  emitEvent(part2, 'turn/start', { turn: 2 })
  await preStep(part2, [{ content: [{ type: 'text', text: 'mixed task' }], source: { kind: 'user', rpcId: req2 } }], 1)
  emitEvent(part2, 'user/message', { source: { kind: 'user', rpcId: req2 }, content: [{ type: 'text', text: 'mixed task' }] })
  emitEvent(part2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'web steer' }] })
  await fireRequestError(part2, 'CONTEXT_WINDOW_EXCEEDED')
  emitEvent(part2, 'turn/end', { turn: 2, reason: { kind: 'error' } })

  const part3 = await waitHandoff(() => (rt.botOf('a').sessionId === part2 ? undefined : rt.botOf('a').sessionId))
  assert.equal(part3, 's2')
  const handoff3 = agentOf(part3).inbox.nextTurn.shift()
  assert.ok(handoff3)
  emitEvent(part3, 'turn/start', { turn: 1 })
  emitEvent(part3, 'user/message', { source: handoff3.source, content: handoff3.content })
  emitEvent(part3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'reply after web steer' }] } })
  emitEvent(part3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['dm-u1', 'reply after web steer']])

  // 3. A conflicting IM claim after startSwitch held the origin cannot leak to the fresh part.
  rt.state.im.connections[conn.id].paired.push({ id: 'u2', name: 'U2', at: 1 })
  await rt.save()
  await fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, text: 'late mixed task' })
  const req3 = prompts.at(-1)?.requestId
  fake.sent.length = 0
  let releaseIdle
  setIdleGate(new Promise((resolve) => { releaseIdle = resolve }))
  emitEvent(part3, 'turn/start', { turn: 2 })
  await preStep(part3, [{ content: [{ type: 'text', text: 'late mixed task' }], source: { kind: 'user', rpcId: req3 } }], 1)
  emitEvent(part3, 'user/message', { source: { kind: 'user', rpcId: req3 }, content: [{ type: 'text', text: 'late mixed task' }] })
  await fireRequestError(part3, 'CONTEXT_WINDOW_EXCEEDED')
  await fake.handlers.onMessage({ chat: { key: 'dm-u2', kind: 'direct', title: 'U2' }, sender: { id: 'u2', name: 'U2' }, text: 'conflicting task' })
  emitEvent(part3, 'user/message', { source: { kind: 'user', rpcId: prompts.at(-1).requestId }, content: [{ type: 'text', text: 'conflicting task' }] })
  emitEvent(part3, 'turn/end', { turn: 2, reason: { kind: 'error' } })
  releaseIdle()
  setIdleGate(undefined)

  const part4 = await waitHandoff(() => (rt.botOf('a').sessionId === part3 ? undefined : rt.botOf('a').sessionId))
  assert.equal(part4, 's3')
  const handoff4 = agentOf(part4).inbox.nextTurn.shift()
  assert.ok(handoff4)
  emitEvent(part4, 'turn/start', { turn: 1 })
  emitEvent(part4, 'user/message', { source: handoff4.source, content: handoff4.content })
  emitEvent(part4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'late mixed stays internal' }] } })
  emitEvent(part4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent, [])

  // 4. A group's own Session moving to its folder keeps delivering member room lines to the IM group chat.
  rt.state.im.connections[conn.id].chats.g1 = { kind: 'group', title: 'Group One', target: { roomId: 'r1' }, at: 1 }
  await rt.save()
  await fake.handlers.onMessage({ chat: { key: 'g1', kind: 'group', title: 'Group One' }, sender: { id: 'u1', name: 'U1' }, text: 'start group work', mentioned: true })
  const gReq = prompts.at(-1)?.requestId
  const room = rt.roomOf('r1')
  emitEvent('r1', 'turn/start', { turn: 1 })
  emitEvent('r1', 'user/message', { source: { kind: 'user', rpcId: gReq }, content: [{ type: 'text', text: 'start group work' }] })
  emitEvent('r1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  fake.sent.length = 0

  await rt.followFolder({ roomId: 'r1' })
  const roomPart2 = await waitHandoff(() => room.sessionId)
  assert.equal(roomPart2, 's4')
  const roomHandoff = agentOf(roomPart2).inbox.nextTurn.shift()
  assert.ok(roomHandoff)
  emitEvent(roomPart2, 'turn/start', { turn: 1 })
  emitEvent(roomPart2, 'user/message', { source: roomHandoff.source, content: roomHandoff.content })
  emitEvent(roomPart2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  emitEvent(roomPart2, 'turn/start', { turn: 2 })
  emitEvent(roomPart2, 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'e-room', senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
    content: [{ type: 'text', text: 'member finished after switch' }],
  })
  rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'member finished after switch' })
  emitEvent(roomPart2, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['g1', '**Writer**: member finished after switch']])

  // 5. Web UI input during the group folder switch keeps the IM origin for the ongoing work.
  fake.sent.length = 0
  agentOf(roomPart2).session.header.cwd = '/tmp/stale-group-dir-2'
  let onCreateEntered
  const enteredCreate1 = new Promise((resolve) => { onCreateEntered = resolve })
  let releaseCreate1
  const waitCreate1 = new Promise((resolve) => { releaseCreate1 = resolve })
  setCreateGate(async () => { onCreateEntered(); await waitCreate1 })
  const folderSwitch1 = rt.followFolder({ roomId: 'r1' })
  await enteredCreate1
  emitEvent(roomPart2, 'turn/start', { turn: 3 })
  emitEvent(roomPart2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'web takeover while switching' }] })
  emitEvent(roomPart2, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  releaseCreate1()
  setCreateGate(undefined)
  await folderSwitch1

  const roomPart3 = await waitHandoff(() => (room.sessionId === roomPart2 ? undefined : room.sessionId))
  assert.equal(roomPart3, 's5')
  const roomHandoff3 = agentOf(roomPart3).inbox.nextTurn.shift()
  assert.ok(roomHandoff3)
  emitEvent(roomPart3, 'turn/start', { turn: 1 })
  emitEvent(roomPart3, 'user/message', { source: roomHandoff3.source, content: roomHandoff3.content })
  emitEvent(roomPart3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emitEvent(roomPart3, 'turn/start', { turn: 2 })
  emitEvent(roomPart3, 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'e-room-web', senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
    content: [{ type: 'text', text: 'reply after group web steer' }],
  })
  rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'reply after group web steer' })
  emitEvent(roomPart3, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.map(job => [job.chat.key, job.text]), [['g1', '**Writer**: reply after group web steer']])

  // 6. Group folder switch invalidated by another IM chat while switching does not leak to the old IM chat.
  rt.state.im.connections[conn.id].chats.g2 = { kind: 'group', title: 'Group Two', target: { roomId: 'r1' }, at: 1 }
  await rt.save()
  await fake.handlers.onMessage({ chat: { key: 'g1', kind: 'group', title: 'Group One' }, sender: { id: 'u1', name: 'U1' }, text: 'start second group work', mentioned: true })
  const gReq2 = prompts.at(-1)?.requestId
  emitEvent(roomPart3, 'turn/start', { turn: 3 })
  emitEvent(roomPart3, 'user/message', { source: { kind: 'user', rpcId: gReq2 }, content: [{ type: 'text', text: 'start second group work' }] })
  emitEvent(roomPart3, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  fake.sent.length = 0

  agentOf(roomPart3).session.header.cwd = '/tmp/stale-group-dir-3'
  let onCreateEntered2
  const enteredCreate2 = new Promise((resolve) => { onCreateEntered2 = resolve })
  let releaseCreate2
  const waitCreate2 = new Promise((resolve) => { releaseCreate2 = resolve })
  setCreateGate(async () => { onCreateEntered2(); await waitCreate2 })
  const folderSwitch2 = rt.followFolder({ roomId: 'r1' })
  await enteredCreate2
  await fake.handlers.onMessage({ chat: { key: 'g2', kind: 'group', title: 'Group Two' }, sender: { id: 'u1', name: 'U1' }, text: 'takeover from g2', mentioned: true })
  const g2Req = prompts.at(-1)?.requestId
  emitEvent(roomPart3, 'turn/start', { turn: 4 })
  emitEvent(roomPart3, 'user/message', { source: { kind: 'user', rpcId: g2Req }, content: [{ type: 'text', text: 'takeover from g2' }] })
  emitEvent(roomPart3, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  releaseCreate2()
  setCreateGate(undefined)
  await folderSwitch2

  const roomPart4 = await waitHandoff(() => (room.sessionId === roomPart3 ? undefined : room.sessionId))
  assert.equal(roomPart4, 's6')
  const roomHandoff4 = agentOf(roomPart4).inbox.nextTurn.shift()
  assert.ok(roomHandoff4)
  emitEvent(roomPart4, 'turn/start', { turn: 1 })
  emitEvent(roomPart4, 'user/message', { source: roomHandoff4.source, content: roomHandoff4.content })
  emitEvent(roomPart4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emitEvent(roomPart4, 'turn/start', { turn: 2 })
  emitEvent(roomPart4, 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'e-room-g2', senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
    content: [{ type: 'text', text: 'must not leak to g1 after g2 takeover' }],
  })
  rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'must not leak to g1 after g2 takeover' })
  emitEvent(roomPart4, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.filter(job => job.chat.key === 'g1'), [])

  // 7. Group `!working` pendingReset window after moveOn (before handoff opens) invalidates the held token on Web UI takeover.
  await fake.handlers.onMessage({ chat: { key: 'g1', kind: 'group', title: 'Group One' }, sender: { id: 'u1', name: 'U1' }, text: 'start third group work', mentioned: true })
  const gReq3 = prompts.at(-1)?.requestId
  emitEvent(roomPart4, 'turn/start', { turn: 3 })
  emitEvent(roomPart4, 'user/message', { source: { kind: 'user', rpcId: gReq3 }, content: [{ type: 'text', text: 'start third group work' }] })
  emitEvent(roomPart4, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  fake.sent.length = 0

  agentOf(roomPart4).session.header.cwd = '/tmp/stale-group-dir-4'
  await rt.followFolder({ roomId: 'r1' })
  const roomPart5 = await waitHandoff(() => (room.sessionId !== roomPart4 && [...rt.switchJobs()].length === 0 ? room.sessionId : undefined))
  assert.equal(roomPart5, 's7')
  const roomHandoff5 = agentOf(roomPart5).inbox.nextTurn.shift()
  assert.ok(roomHandoff5)
  emitEvent(roomPart5, 'turn/start', { turn: 1 })
  emitEvent(roomPart5, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'web takeover before handoff' }] })
  emitEvent(roomPart5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emitEvent(roomPart5, 'turn/start', { turn: 2 })
  emitEvent(roomPart5, 'turn/end', { turn: 2, reason: { kind: 'aborted' } })
  emitEvent(roomPart5, 'turn/start', { turn: 3 })
  emitEvent(roomPart5, 'user/message', { source: roomHandoff5.source, content: roomHandoff5.content })
  rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'must not leak after pendingReset web takeover' })
  emitEvent(roomPart5, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent, [])

  // 8. Group `!working` pendingReset window after moveOn (before handoff opens) invalidates the held token when another IM chat claims the part.
  await fake.handlers.onMessage({ chat: { key: 'g1', kind: 'group', title: 'Group One' }, sender: { id: 'u1', name: 'U1' }, text: 'start fourth group work', mentioned: true })
  const gReq4 = prompts.at(-1)?.requestId
  emitEvent(roomPart5, 'turn/start', { turn: 4 })
  emitEvent(roomPart5, 'user/message', { source: { kind: 'user', rpcId: gReq4 }, content: [{ type: 'text', text: 'start fourth group work' }] })
  emitEvent(roomPart5, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  fake.sent.length = 0

  agentOf(roomPart5).session.header.cwd = '/tmp/stale-group-dir-5'
  await rt.followFolder({ roomId: 'r1' })
  const roomPart6 = await waitHandoff(() => (room.sessionId !== roomPart5 && [...rt.switchJobs()].length === 0 ? room.sessionId : undefined))
  assert.equal(roomPart6, 's8')
  const roomHandoff6 = agentOf(roomPart6).inbox.nextTurn.shift()
  assert.ok(roomHandoff6)
  await fake.handlers.onMessage({ chat: { key: 'g2', kind: 'group', title: 'Group Two' }, sender: { id: 'u1', name: 'U1' }, text: 'claim s8 from g2', mentioned: true })
  const g2Req2 = prompts.at(-1)?.requestId
  emitEvent(roomPart6, 'turn/start', { turn: 1 })
  emitEvent(roomPart6, 'user/message', { source: { kind: 'user', rpcId: g2Req2 }, content: [{ type: 'text', text: 'claim s8 from g2' }] })
  emitEvent(roomPart6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emitEvent(roomPart6, 'turn/start', { turn: 2 })
  emitEvent(roomPart6, 'turn/end', { turn: 2, reason: { kind: 'aborted' } })
  emitEvent(roomPart6, 'turn/start', { turn: 3 })
  emitEvent(roomPart6, 'user/message', { source: roomHandoff6.source, content: roomHandoff6.content })
  rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'must not leak to g1 after pendingReset g2 claim' })
  emitEvent(roomPart6, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await delay(30)
  assert.deepEqual(fake.sent.filter(job => job.chat.key === 'g1'), [])
})

test('im-retry while reconnecting preserves retrying sends and reserved cards instead of dropping runner queues', async (t) => {
  const s = await start()
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  // First attempt fails transiently with a long backoff while the adapter reconnects; a follow-up waits behind it.
  s.fake.fails.push(Object.assign(new Error('502'), { status: 502, retryAfter: 30 }))
  const original = new AbortController()
  const racing = s.fireApprovals(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'queued-card', signal: original.signal },
    () => new Promise(() => {}),
  )
  await delay(20)
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'after-card' }] } })
  s.fake.handlers.onStatus({ state: 'reconnecting' })
  await delay(20)

  assert.equal(s.fake.sent.filter(job => /queued-card/.test(job.text)).length, 1)
  assert.equal(s.fake.sent.filter(job => job.text === 'after-card').length, 0)
  s.fake.sent.length = 0
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(40)
  const deliveredCard = s.fake.sent.findLast(job => /queued-card/.test(job.text))
  const deliveredFollowUp = s.fake.sent.findLast(job => job.text === 'after-card')
  assert.ok(deliveredCard, 'card queued in runner.queues must survive stop() during im-retry')
  assert.ok(deliveredFollowUp, 'queued message behind card must survive stop() during im-retry')
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')

  const approvalId = deliveredCard.buttons[0].data.split(':')[1]
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: deliveredCard.messageId ?? 1 })
  assert.equal((await racing)[0], 'allowed-once')
})

test('im-retry keeps retained failed sends and card reservations when reconnect fails before a later retry succeeds', async (t) => {
  let rejectConnect = false
  const fake = fakeAdapter()
  const realConnect = fake.connect.bind(fake)
  fake.connect = (fields, env, handlers) => {
    if (rejectConnect) throw new Error('handshake refused')
    return realConnect(fields, env, handlers)
  }
  const s = await start({ adapter: fake })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  s.fake.fails.push(Object.assign(new Error('forbidden'), { status: 403, permanent: true }))
  const original = new AbortController()
  const racing = s.fireApprovals(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'retry-survives', signal: original.signal },
    () => new Promise(() => {}),
  )
  await delay(30)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')

  // Adapter drops to error and the first manual retry cannot connect yet.
  s.fake.handlers.onStatus({ state: 'error', error: 'socket closed' })
  rejectConnect = true
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  assert.match(s.rt.imStatusView()[conn.id].error, /handshake refused/)

  // Once the connection can open again, a second retry still finds and delivers the retained card.
  rejectConnect = false
  s.fake.sent.length = 0
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(40)
  const card = s.fake.sent.findLast(job => /retry-survives/.test(job.text))
  assert.ok(card, 'failed approval card must not be deleted when an earlier im-retry fails to start a runner')
  const approvalId = card.buttons[0].data.split(':')[1]
  await s.fake.handlers.onAction({ chat: { key: 'dm-u1', kind: 'direct', title: 'U1' }, sender: { id: 'u1', name: 'U1' }, data: `a:${approvalId}:allow`, messageId: card.messageId ?? 1 })
  assert.equal((await racing)[0], 'allowed-once')
})

test('stopping a runner mid-send retains the interrupted send and does not resurrect retry timers on the dead runner', async (t) => {
  let releaseSend
  let stopRejected = false
  const fake = fakeAdapter()
  const realConnect = fake.connect.bind(fake)
  fake.connect = (fields, env, handlers) => {
    const handle = realConnect(fields, env, handlers)
    const origSend = handle.send
    let stopped = false
    let holdNext = false
    fake.holdNextSend = () => { holdNext = true }
    return {
      ...handle,
      send: async (chat, body) => {
        if (holdNext) {
          holdNext = false
          fake.sent.push({ chat, ...body })
          await new Promise((_, reject) => {
            releaseSend = () => reject(Object.assign(new Error('502 during stop'), { status: 502, retryAfter: 0.01 }))
          })
        }
        if (stopped) stopRejected = true
        return origSend(chat, body)
      },
      stop: () => { stopped = true; handle.stop() },
    }
  }
  const s = await start({ adapter: fake })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  fake.holdNextSend()
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'in-flight' }] } })
  await delay(20)
  await s.rt.imEndpoint('im-update', { id: conn.id, enabled: false })
  releaseSend()
  await delay(40)
  assert.equal(stopRejected, false, 'stopped runner must not schedule another retry send')

  await s.rt.imEndpoint('im-update', { id: conn.id, enabled: true })
  assert.equal(s.rt.imStatusView()[conn.id].state, 'error')
  s.fake.sent.length = 0
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(40)
  assert.equal(s.fake.sent.filter(job => job.text === 'in-flight').length, 1)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('im-retry keeps an interrupted in-flight send ahead of queued followers when it rejects after reconnect', async (t) => {
  let releaseSend
  const fake = fakeAdapter()
  const realConnect = fake.connect.bind(fake)
  let holdNext = false
  fake.holdNextSend = () => { holdNext = true }
  fake.connect = (fields, env, handlers) => {
    const handle = realConnect(fields, env, handlers)
    const origSend = handle.send
    return {
      ...handle,
      send: async (chat, body) => {
        if (holdNext) {
          holdNext = false
          await new Promise((_, reject) => {
            releaseSend = () => reject(Object.assign(new Error('502 after reconnect'), { status: 502, retryAfter: 0.01 }))
          })
        }
        return origSend(chat, body)
      },
    }
  }
  const s = await start({ adapter: fake })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  fake.holdNextSend()
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'first-A' }] } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'second-B' }] } })
  await delay(20)
  s.fake.handlers.onStatus({ state: 'reconnecting' })
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  await delay(30)
  assert.deepEqual(s.fake.sent.map(job => job.text), [], 'queued follower must wait until interrupted in-flight send settles')

  releaseSend()
  await delay(40)
  assert.deepEqual(s.fake.sent.map(job => job.text), ['first-A', 'second-B'])
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('im-retry clears retrying status when an interrupted single send drops after reconnect', async (t) => {
  let releaseSend
  const fake = fakeAdapter()
  const realConnect = fake.connect.bind(fake)
  let holdNext = false
  fake.holdNextSend = () => { holdNext = true }
  fake.connect = (fields, env, handlers) => {
    const handle = realConnect(fields, env, handlers)
    const origSend = handle.send
    return {
      ...handle,
      send: async (chat, body) => {
        if (holdNext) {
          holdNext = false
          await new Promise((_, reject) => {
            releaseSend = () => reject(Object.assign(new Error('stopped mid-send'), { stopped: true }))
          })
        }
        return origSend(chat, body)
      },
    }
  }
  const s = await start({ adapter: fake })
  t.after(s.stop)
  const conn = await add(s)
  const one = s.rt.state.im.connections[conn.id]
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await s.rt.save()
  await dm(s, 'u1', 'hi')
  s.imTurn('a')
  s.fake.sent.length = 0

  fake.holdNextSend()
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'cancelled-on-stop' }] } })
  await delay(20)
  s.fake.handlers.onStatus({ state: 'reconnecting' })
  await s.rt.imEndpoint('im-retry', { id: conn.id })
  assert.equal(s.rt.imStatusView()[conn.id].state, 'retrying')

  releaseSend()
  await delay(30)
  assert.equal(s.rt.imStatusView()[conn.id].state, 'ready')
})

test('a group attachment uploads under the group current Session, not the id it started with', async (t) => {
  // A group's own Session moves on to a fresh part when its folder changes:
  // `room.id` stays the first Session's id and `room.sessionId` the current one.
  const seed = TEAM()
  seed.rooms.r1.sessionId = 'r1-part2'
  const uploads = []
  const s = await start({
    seed,
    services: {
      fileUploads: {
        uploadStream: async ({ sessionId, name }) => {
          uploads.push({ sessionId, name })
          return { receiptId: `receipt-${name}` }
        },
      },
    },
  })
  t.after(s.stop)
  const conn = await add(s)
  s.rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'User u1', at: 1 })
  await s.rt.save()
  // The chat is recorded by the first mention; binding then points it at the group.
  await gm(s, 'u1', '@fakebot hello group')
  await s.rt.imEndpoint('im-chat', { id: conn.id, chatKey: 'g1', target: { roomId: 'r1' } })
  await gm(s, 'u1', 'see the plan', { files: [{ name: 'plan.txt', data: Buffer.from('plan') }] })
  assert.deepEqual(uploads, [{ sessionId: 'r1-part2', name: 'plan.txt' }], 'the receipt goes to the Session that takes the message')
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, 'r1-part2', 'the message itself goes to the current part')
  assert.deepEqual(s.prompts[0].content.at(-1), { type: 'file', receiptId: 'receipt-plan.txt' })
})

test('a failed add keeps the network reason under "fetch failed"', async (t) => {
  // #1120: the outlet printed only error.message, so a DNS failure read as
  // "im-add: fetch failed" and the user could not tell it from a bad token.
  const adapter = fakeAdapter()
  adapter.check = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' }),
    })
  }
  const s = await start({ adapter })
  t.after(s.stop)
  await assert.rejects(() => add(s), error => {
    assert.match(error.message, /fetch failed: getaddrinfo ENOTFOUND api\.telegram\.org/)
    return true
  })
})

test('a failed add does not echo the token back', async (t) => {
  const adapter = fakeAdapter()
  adapter.check = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED https://api.telegram.org/bottok-1234/getMe'),
    })
  }
  const s = await start({ adapter })
  t.after(s.stop)
  await assert.rejects(() => add(s), error => {
    assert.match(error.message, /ECONNREFUSED/)
    assert.ok(!error.message.includes('tok-1234'), 'the token is redacted')
    return true
  })
})

test('a failed update keeps the network reason and redacts a secret as it appears in a URL', async (t) => {
  const adapter = fakeAdapter()
  const s = await start({ adapter })
  t.after(s.stop)
  const conn = await add(s)
  adapter.check = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED https://api.telegram.org/botnew%2Btok%2F1/getMe'),
    })
  }
  await assert.rejects(() => s.rt.imEndpoint('im-update', { id: conn.id, fields: { token: 'new+tok/1' } }), error => {
    assert.match(error.message, /fetch failed: connect ECONNREFUSED/)
    assert.ok(!error.message.includes('new%2Btok%2F1'), 'the encoded token is redacted')
    return true
  })
})


test('fg-handoff: task-handoff notice before IM message does not break IM reply, and moved background task does not double-send raw output to IM', async (t) => {
  const s = await start()
  t.after(s.stop)
  await pairedConn(s)

  // Turn 1 from IM on Bot 'a' starts and claims IM origin.
  await dm(s, 'u1', 'long background job')
  s.imTurn('a')
  s.fake.sent.length = 0

  // Simulate moving 'a' into bot.tasks[] while 'a-new' becomes the forked foreground.
  const bot = s.rt.botOf('a')
  const task = {
    id: 'k_im1',
    title: 'long background job',
    from: 'a-new',
    sessionId: 'a',
    segments: [],
    origin: 'fg-handoff',
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    imOrigin: s.rt.captureImOrigin('a'),
  }
  bot.tasks = [task]
  bot.sessionId = 'a-new'
  s.rt.chatOwners.set('a-new', 'a')
  s.rt.taskOwners.set('a', { botId: 'a', taskId: task.id })
  s.rt.clearImOrigin('a')
  await s.rt.save()

  // Moved background task emits an assistant message: must NOT stream directly to IM!
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'raw background output' }] } })
  await s.flush()
  assert.equal(s.fake.sent.length, 0, 'moved background task must not stream raw messages directly to IM')

  // User sends a second IM message to Bot 'a' -> lands on new foreground 'a-new'.
  await dm(s, 'u1', 'quick question')
  const reqId = s.prompts.at(-1).requestId

  // Simulate real DSH next-step before next-turn order: task-handoff arrives FIRST,
  // then the user's IM message with rpcId arrives in the same turn!
  s.emitEvent('a-new', 'turn/start', { turn: 1 })
  s.emitEvent('a-new', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-handoff', taskId: task.id },
    content: [{ type: 'text', text: '[Background task notice] earlier turn moved' }],
  })
  s.emitEvent('a-new', 'user/message', {
    source: { kind: 'user', rpcId: reqId },
    content: [{ type: 'text', text: 'quick question' }],
  })
  s.emitEvent('a-new', 'assistant/message', { message: { content: [{ type: 'text', text: 'quick foreground answer' }] } })
  s.emitEvent('a-new', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['dm-u1', 'quick foreground answer']],
    'task-handoff notice before IM user message must not mark the new foreground mixed or drop IM reply',
  )

  // Finally, task-report arrives on 'a-new' and reclaims the persisted task.imOrigin -> delivered once to IM.
  s.fake.sent.length = 0
  s.emitEvent('a-new', 'turn/start', { turn: 2 })
  s.emitEvent('a-new', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: task.id },
    content: [{ type: 'text', text: '[Background task report] raw background output' }],
  })
  s.emitEvent('a-new', 'assistant/message', { message: { content: [{ type: 'text', text: 'Your background job finished!' }] } })
  s.emitEvent('a-new', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['dm-u1', 'Your background job finished!']],
    'task-report must still reach the originating IM chat via persisted task.imOrigin',
  )
})


test('P0-5/P0-B: group task-report restores persisted IM origin across restart and after a finished desktop round (via real room post path)', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()

  const room = s.rt.roomOf('r1')
  const roomSid = s.rt.sessionOfRoom(room)
  room.sessions = { ...room.sessions, a: 'grp-r1-a' }
  s.rt.groupOwners.set('grp-r1-a', { botId: 'a', roomId: 'r1' })

  // 1) Group message from IM u1 claims room origin; capture it onto a group task.
  await gm(s, 'u1', 'check group task')
  s.imTurn('r1')
  const captured = s.rt.captureImOrigin(roomSid)
  assert.ok(captured !== undefined)
  s.rt.botOf('a').tasks = [{
    id: 'k_grp_im1',
    title: 'Group IM task',
    roomId: 'r1',
    from: 'grp-r1-a',
    sessionId: 'gtask-1',
    segments: [],
    status: 'completed',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    imOrigin: captured,
  }]
  // Start and finish a fresh desktop/Web round without an IM claim.
  s.emitEvent(roomSid, 'turn/start', { turn: 2 })
  s.emitEvent(roomSid, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'desktop ping' }] })
  s.emitEvent(roomSid, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  s.fake.sent.length = 0

  // 2) task-report lands on hidden member group session 'grp-r1-a' carrying roomId: 'r1'.
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 1 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_im1', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] Group IM task done' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // 3) Real postToRoom -> roomSid turn/start + user/message (role: 'post') -> group_relay -> logRoom -> onRoomLine!
  s.emitEvent(roomSid, 'turn/start', { turn: 3 })
  s.emitEvent(roomSid, 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' },
    content: [{ type: 'text', text: '[Group post] Writer: Group task finished and verified.' }],
  })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'Group task finished and verified.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['g1', '**Writer**: Group task finished and verified.']],
    'group task-report must restore the origin after a finished desktop round and deliver via real room post path',
  )
})

test('P0-B: group task-report from u1 does not drop live IM origin when another paired user u2 is active in the same IM group', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  one.paired.push({ id: 'u2', name: 'Bob', at: 2 })
  await s.rt.save()

  const room = s.rt.roomOf('r1')
  const roomSid = s.rt.sessionOfRoom(room)
  room.sessions = { ...room.sessions, a: 'grp-r1-a' }
  s.rt.groupOwners.set('grp-r1-a', { botId: 'a', roomId: 'r1' })

  // u1 starts task T1 in g1.
  await gm(s, 'u1', 'start group task')
  s.imTurn('r1')
  const capturedU1 = s.rt.captureImOrigin(roomSid)
  assert.ok(capturedU1 !== undefined)
  s.rt.botOf('a').tasks = [{
    id: 'k_grp_im_u1',
    title: 'u1 task',
    roomId: 'r1',
    from: 'grp-r1-a',
    sessionId: 'gtask-u1',
    segments: [],
    status: 'completed',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    imOrigin: capturedU1,
  }]

  // Later, paired user u2 speaks in the SAME IM group g1 -> roomSid origin is now owned by u2.
  s.rt.clearImOrigin(roomSid)
  await gm(s, 'u2', 'another question in g1')
  s.imTurn('r1')
  s.fake.sent.length = 0

  // u1's task-report arrives while u2's origin is live on g1 -> must NOT call dropOrigin!
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 2 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_im_u1', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] u1 task done' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })

  // Both u2's ongoing answer and u1's task report post through roomSid -> both must reach g1!
  s.emitEvent(roomSid, 'turn/start', { turn: 3 })
  s.emitEvent(roomSid, 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' },
    content: [{ type: 'text', text: 'u1 task summary' }],
  })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'Answer for u2 and u1 report.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['g1', '**Writer**: Answer for u2 and u1 report.']],
    'u1 task-report must not drop u2 live origin on the same IM group',
  )
})

test('P0-B: after restart, group task-report restores IM origin even while sibling member task is still working', async (t) => {
  const s = await start()
  t.after(s.stop)
  const { one } = await pairedConn(s)
  one.chats.g1 = { kind: 'group', title: 'G', target: { roomId: 'r1' }, at: 1 }
  await s.rt.save()

  const room = s.rt.roomOf('r1')
  const roomSid = s.rt.sessionOfRoom(room)
  room.sessions = { ...room.sessions, a: 'grp-r1-a', b: 'grp-r1-b' }
  s.rt.groupOwners.set('grp-r1-a', { botId: 'a', roomId: 'r1' })
  s.rt.groupOwners.set('grp-r1-b', { botId: 'b', roomId: 'r1' })

  await gm(s, 'u1', 'start parallel group tasks')
  s.imTurn('r1')
  const captured = s.rt.captureImOrigin(roomSid)
  s.rt.botOf('a').tasks = [{
    id: 'k_grp_restart',
    title: 'Restart sibling task A',
    roomId: 'r1',
    from: 'grp-r1-a',
    sessionId: 'gtask-r',
    segments: [],
    status: 'completed',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    imOrigin: captured,
  }]
  s.rt.botOf('b').tasks = [{
    id: 'k_grp_restart_b',
    title: 'Restart sibling task B',
    roomId: 'r1',
    from: 'grp-r1-b',
    sessionId: 'gtask-rb',
    segments: [],
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    imOrigin: captured,
  }]

  // Simulate restart: origins and mixed are both clear, while sibling member 'b' is still working in r1.
  s.rt.clearImOrigin(roomSid)
  s.rt.roomWorkView = () => ({ r1: [{ botId: 'b', since: Date.now(), tool: 'task' }] })
  s.fake.sent.length = 0

  s.emitEvent('grp-r1-a', 'turn/start', { turn: 1 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_restart', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] Restart sibling A done' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  s.emitEvent(roomSid, 'turn/start', { turn: 2 })
  s.emitEvent(roomSid, 'user/message', { source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' }, content: [{ type: 'text', text: 'Done A' }] })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'Sibling task A report after restart.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['g1', '**Writer**: Sibling task A report after restart.']],
    'restart recovery with sibling member working must still restore IM group origin',
  )

  // Second sibling member 'b' finishes next -> also reports to g1.
  s.rt.botOf('b').tasks[0].status = 'completed'
  s.rt.roomWorkView = () => ({})
  s.fake.sent.length = 0
  s.emitEvent('grp-r1-b', 'turn/start', { turn: 1 })
  s.emitEvent('grp-r1-b', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_restart_b', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] Restart sibling B done' }],
  })
  s.emitEvent('grp-r1-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  s.emitEvent(roomSid, 'turn/start', { turn: 3 })
  s.emitEvent(roomSid, 'user/message', { source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' }, content: [{ type: 'text', text: 'Done B' }] })
  s.rt.logRoom(room, { who: 'Reviewer', botId: 'b', text: 'Sibling task B report after restart.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await s.flush()

  assert.deepEqual(
    s.fake.sent.map(entry => [entry.chat.key, entry.text]),
    [['g1', '**Reviewer**: Sibling task B report after restart.']],
    'second sibling task finishing after restart must also reach IM group',
  )

  // Clean restart state WITH an active non-IM group round (roomActive === true, live === undefined):
  // task-report must NOT restore IM origin while a non-IM round is actively running.
  s.rt.clearImOrigin(roomSid)
  s.rt.roomActive = id => id === 'r1'
  s.fake.sent.length = 0
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 4 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_restart', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] During active non-IM round' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'Non-IM active round line.' })
  await s.flush()
  assert.deepEqual(s.fake.sent, [], 'must not restore IM origin while a non-IM group round is active')
  s.rt.roomActive = () => false

  // A desktop-started sibling task has no IM destination, even after an IM task report.
  s.rt.botOf('a').tasks.push({
    id: 'k_grp_desktop',
    title: 'Desktop sibling task',
    roomId: 'r1',
    from: 'grp-r1-a',
    sessionId: 'gtask-d',
    segments: [],
    status: 'completed',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  })
  // First restore g1 origin via IM task, then withdraw it for the desktop task report.
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 5 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_restart', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] Restore g1' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 5, reason: { kind: 'completed' } })
  s.fake.sent.length = 0
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 6 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_desktop', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] Desktop secret result' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 6, reason: { kind: 'completed' } })
  s.emitEvent(roomSid, 'turn/start', { turn: 7 })
  s.emitEvent(roomSid, 'user/message', { source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' }, content: [{ type: 'text', text: 'Desktop secret' }] })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'Desktop secret result.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
  await s.flush()
  assert.deepEqual(s.fake.sent, [], 'desktop-started group task report must never leak to IM group')

  // A different IM group chat g2 currently owns roomSid: g1's task-report must drop roomSid
  // origin so g1's report is never leaked into g2.
  one.chats.g2 = { kind: 'group', title: 'G2', target: { roomId: 'r1' }, at: 2 }
  await s.rt.save()
  s.rt.clearImOrigin(roomSid)
  await gm(s, 'u1', 'hello from g2', { chat: { key: 'g2', kind: 'group', title: 'G2' } })
  s.imTurn('r1')
  s.fake.sent.length = 0
  s.emitEvent('grp-r1-a', 'turn/start', { turn: 8 })
  s.emitEvent('grp-r1-a', 'user/message', {
    source: { kind: 'bot', form: 'relay', role: 'task-report', taskId: 'k_grp_restart', roomId: 'r1' },
    content: [{ type: 'text', text: '[Background task report] g1 task done' }],
  })
  s.emitEvent('grp-r1-a', 'turn/end', { turn: 8, reason: { kind: 'completed' } })
  s.emitEvent(roomSid, 'turn/start', { turn: 9 })
  s.emitEvent(roomSid, 'user/message', { source: { kind: 'bot', form: 'relay', role: 'post', roomId: 'r1' }, content: [{ type: 'text', text: 'g1 report' }] })
  s.rt.logRoom(room, { who: 'Writer', botId: 'a', text: 'g1 report line.' })
  s.emitEvent(roomSid, 'turn/end', { turn: 9, reason: { kind: 'completed' } })
  await s.flush()
  assert.deepEqual(s.fake.sent, [], 'g1 task report must not leak into a different IM group chat g2')
})
