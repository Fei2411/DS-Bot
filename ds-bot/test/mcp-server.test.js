import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { MCP_TOOLS, clientTools, closeServer, mcpHttpServer } from '../src/host/mcp-server.js'
import { remoteAccessError } from '../src/host/phone.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Scout', role: 'Researcher', instructions: '', createdAt: 2 },
    p3: { id: 'p3', sessionId: 'p3', name: 'Diary', role: 'Private', instructions: '', createdAt: 3, private: true },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function open(home) {
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home, github: false })
  const call = async (endpoint, payload) => (await (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json())
  return { ctx, call }
}

async function until(read, check) {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = await read()
    if (check(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

function rpc(url, token, message, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(message),
  })
}

test('MCP access is off until turned on, and a client token reaches only its own Bots', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-mcp-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/mcp`

  const first = await desk.call('state', {})
  assert.equal(first.value.mcp.on, false)
  assert.deepEqual(first.value.mcp.clients, [])
  assert.equal((await desk.call('mcp-set', { port: 80 })).error.code, 'bot/invalid')
  assert.equal((await desk.call('mcp-client-add', { name: ' ' })).error.code, 'bot/invalid')

  const added = await desk.call('mcp-client-add', { name: 'Claude Desktop' })
  const { token } = added.value
  assert.match(token, /^dsb_/)
  const client = added.value.clients[0]
  assert.deepEqual([client.name, client.bots, client.rooms], ['Claude Desktop', ['m1'], []])
  const saved = readFileSync(join(home, 'mcp.json'), 'utf8')
  assert.ok(!saved.includes(token), 'mcp.json keeps only the hash of the token')
  assert.equal((await desk.call('state', {})).value.mcp.token, undefined)

  await desk.call('mcp-set', { on: true, port })
  await until(async () => (await desk.call('state', {})).value.mcp, mcp => mcp.status === 'on')

  assert.equal((await rpc(url, undefined, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.equal((await rpc(url, 'dsb_wrong', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.equal((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405)
  assert.equal((await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)

  const init = await (await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json()
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(init.result.serverInfo.name, 'ds-bot')
  const listed = await (await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
  assert.deepEqual(listed.result.tools.map(tool => tool.name), MCP_TOOLS.map(tool => tool.name))

  const call = async (name, args = {}) => (await (await rpc(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json()).result
  const bots = await call('list_bots')
  assert.deepEqual(bots.structuredContent.bots.map(bot => [bot.id, bot.main]), [['m1', true]])
  const outside = await call('send_to_bot', { bot: 'Scout', text: 'hi' })
  assert.equal(outside.isError, true)
  assert.equal((await call('create_bot', { name: 'X' })).isError, true)

  const widened = await desk.call('mcp-client-update', { id: client.id, bots: ['m1', 'b2', 'p3', 'nobody'] })
  assert.deepEqual(widened.value.clients[0].bots, ['m1', 'b2'], 'private and unknown Bots are never in scope')
  assert.deepEqual((await call('list_bots')).structuredContent.bots.map(bot => bot.name), ['Chief', 'Scout'])
  assert.equal((await call('read_chat', { bot: 'Diary' })).isError, true)

  const bridge = spawn(process.execPath, [fileURLToPath(new URL('../bin/ds-bot-mcp.mjs', import.meta.url)), '--url', url], { env: { ...process.env, DSBOT_MCP_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => bridge.kill())
  const line = new Promise((resolve, reject) => {
    bridge.stdout.once('data', chunk => resolve(JSON.parse(String(chunk).split('\n')[0])))
    bridge.once('exit', code => reject(new Error(`ds-bot-mcp exited with ${code}`)))
  })
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_bots', arguments: {} } })}\n`)
  const bridged = await line
  assert.equal(bridged.id, 7)
  assert.deepEqual(bridged.result.structuredContent.bots.map(bot => bot.name), ['Chief', 'Scout'], 'the stdio bridge forwards to the same server')
  bridge.kill()

  await desk.call('mcp-client-remove', { id: client.id })
  assert.equal((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)

  await desk.call('mcp-set', { on: false })
  await assert.rejects(rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' }))
})

test('phones and browsers cannot manage MCP access', () => {
  assert.equal(remoteAccessError({ kind: 'phone' }, 'mcp-client-add').code, 'bot/refused')
  assert.equal(remoteAccessError({ kind: 'phone' }, 'mcp-set').code, 'bot/refused')
})

function fakeRuntime() {
  const state = {
    bots: structuredClone(TEAM.bots),
    rooms: { r1: { id: 'r1', name: 'Launch', members: ['m1', 'b2', 'p3'] } },
    questions: { b2: { question: 'Which market?' }, p3: { question: 'Secret?' } },
  }
  const sent = []
  const chats = { m1: [] }
  const roomChats = { r1: [] }
  const busy = new Set()
  const waiting = {}
  const reads = { count: 0 }
  const rt = {
    state,
    sent,
    chats,
    roomChats,
    busy,
    waiting,
    reads,
    waitingView: () => waiting,
    load: async () => {},
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    isMain: id => id === 'm1',
    selfOf: id => id,
    chatOf: id => `chat-${id}`,
    live: { get: sessionId => (busy.has(sessionId.replace('chat-', '')) ? { turn: 1 } : undefined) },
    sendUser: async (message) => { sent.push(message) },
    // Two items a page, newest first, like a long chat over several pages.
    chatPage: async (botId, cursor) => {
      reads.count += 1
      const all = chats[botId] ?? []
      const end = cursor?.end ?? all.length
      const start = Math.max(0, end - 2)
      return { sessionId: botId, items: all.slice(start, end), cursor: start > 0 ? { end: start } : null }
    },
    mobileEndpoint: async (endpoint, body) => ({ roomId: body.roomId, items: roomChats[body.roomId] ?? [], cursor: null, running: false }),
    approvalsView: () => [
      { id: 'a1', botId: 'm1', tool: 'bash', reason: 'Run the tests' },
      { id: 'a2', botId: 'p3', tool: 'bash', reason: 'private' },
      { id: 'a3', botId: 'b2', roomId: 'r1', tool: 'write', reason: 'Edit the plan' },
      { id: 'a4', botId: 'p3', roomId: 'r1', tool: 'write', reason: 'private in a group' },
    ],
  }
  return rt
}

test('a message from an MCP client says which client sent it', async () => {
  const rt = fakeRuntime()
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: ['m1'], rooms: ['r1'] })
  const sent = await call('send_to_bot', { bot: 'chief', text: 'Summarize the week' })
  assert.equal(sent.sent, true)
  assert.equal(rt.sent[0].sessionId, 'm1')
  assert.match(rt.sent[0].requestId, /^mcp:c1:/)
  assert.equal(rt.sent[0].content[0].text, '[Sent by the external agent "Cursor" through DS Bot MCP access]\nSummarize the week')
  await call('send_to_group', { group: 'Launch', text: '@Scout look' })
  assert.equal(rt.sent[1].sessionId, 'r1')
  await assert.rejects(call('send_to_bot', { bot: 'm1', text: '  ' }), /empty/)
  await assert.rejects(call('send_to_bot', { bot: 'b2', text: 'hi' }), /No Bot/)
  await assert.rejects(call('send_to_group', { group: 'r9', text: 'hi' }), /No group/)
  await assert.rejects(call('answer_question', {}), /Unknown tool/)
})

test('group members never include private Bots, and waiting cards stay in scope', async () => {
  const rt = fakeRuntime()
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: ['m1', 'p3'], rooms: ['r1'] })
  assert.deepEqual((await call('list_groups')).groups, [{ id: 'r1', name: 'Launch', members: ['Chief', 'Scout'] }])
  assert.deepEqual((await call('list_bots')).bots.map(bot => bot.id), ['m1'])
  const { waiting } = await call('list_waiting')
  assert.deepEqual(waiting.map(entry => entry.reason ?? entry.question), ['Run the tests', 'Edit the plan'])
})

test('wait_for_reply returns the replies after the send once the Bot is idle', async () => {
  const rt = fakeRuntime()
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: ['m1'], rooms: [] }, { pollMs: 10 })
  rt.chats.m1.push({ kind: 'bot', text: 'old', time: 100 }, { kind: 'user', text: 'question', time: 200 })
  rt.busy.add('m1')
  setTimeout(() => {
    rt.chats.m1.push({ kind: 'bot', text: 'Here is the summary', name: 'Chief', time: 300 }, { kind: 'tool', time: 301 })
    rt.busy.delete('m1')
  }, 50)
  const reply = await call('wait_for_reply', { bot: 'm1', after: 150, timeoutSeconds: 5 })
  assert.equal(reply.done, true)
  assert.deepEqual(reply.messages, [{ kind: 'bot', from: 'Chief', text: 'Here is the summary', time: 300 }])
  assert.equal(reply.after, 300)

  rt.busy.add('m1')
  const timedOut = await call('wait_for_reply', { bot: 'm1', after: 300, timeoutSeconds: 1 })
  assert.deepEqual([timedOut.done, timedOut.working, timedOut.messages, timedOut.after], [false, true, [], 300])
  await assert.rejects(call('wait_for_reply', { bot: 'm1', group: 'r1' }), /not both/)
})

test('wait_for_reply reads back over older pages and stops when the client loses access', async () => {
  const rt = fakeRuntime()
  let client = { id: 'c1', name: 'Cursor', bots: ['m1'], rooms: [] }
  const call = clientTools(rt, client, { pollMs: 10, current: () => client })
  rt.chats.m1.push({ kind: 'user', text: 'question', time: 100 }, { kind: 'bot', text: 'one', time: 200 }, { kind: 'bot', text: 'two', time: 300 }, { kind: 'bot', text: 'three', time: 400 })
  const reply = await call('wait_for_reply', { bot: 'm1', after: 150, timeoutSeconds: 5 })
  assert.deepEqual(reply.messages.map(item => item.text), ['one', 'two', 'three'], 'replies on an older page are not skipped')

  rt.busy.add('m1')
  const waiting = call('wait_for_reply', { bot: 'm1', after: 400, timeoutSeconds: 5 })
  setTimeout(() => { client = undefined }, 30)
  await assert.rejects(waiting, /removed/)
  client = { id: 'c1', name: 'Cursor', bots: ['m1'], rooms: [] }
  const narrowed = call('wait_for_reply', { bot: 'm1', after: 400, timeoutSeconds: 5 })
  setTimeout(() => { client = { ...client, bots: [] } }, 30)
  await assert.rejects(narrowed, /No Bot "m1"/)
})

test('a group in scope never shows what its private members said', async () => {
  const rt = fakeRuntime()
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: [], rooms: ['r1'] }, { pollMs: 10 })
  rt.roomChats.r1.push(
    { kind: 'user', text: 'plan?', time: 100 },
    { kind: 'bot', botId: 'b2', name: 'Scout', text: 'Here is the plan', time: 200 },
    { kind: 'bot', botId: 'p3', name: 'Diary', text: 'my secret', time: 300 },
  )
  assert.deepEqual((await call('read_chat', { group: 'Launch' })).messages.map(item => item.text), ['plan?', 'Here is the plan'])
  assert.deepEqual((await call('wait_for_reply', { group: 'r1', after: 150, timeoutSeconds: 2 })).messages.map(item => item.from), ['Scout'])
})

test('a name finds the Bot in scope even when another Bot has the same name', async () => {
  const rt = fakeRuntime()
  rt.state.bots.x4 = { id: 'x4', sessionId: 'x4', name: 'Scout', createdAt: 0 }
  rt.state.bots.n5 = { id: 'n5', sessionId: 'n5', createdAt: 0 }
  const bots = rt.state.bots
  rt.state.bots = { n5: bots.n5, x4: bots.x4, ...bots }
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: ['b2'], rooms: [] })
  await call('send_to_bot', { bot: 'scout', text: 'hi' })
  assert.equal(rt.sent[0].sessionId, 'b2')
  await assert.rejects(call('send_to_bot', { bot: 'nobody', text: 'hi' }), /No Bot "nobody"/)
})

test('wait_for_reply keeps waiting while the Bot waits for work it handed on, and reads old pages only at the ends', async () => {
  const rt = fakeRuntime()
  const call = clientTools(rt, { id: 'c1', name: 'Cursor', bots: ['m1'], rooms: [] }, { pollMs: 20 })
  for (let index = 0; index < 10; index += 1) rt.chats.m1.push({ kind: 'bot', text: `old ${index}`, time: 10 + index })
  rt.chats.m1.push({ kind: 'bot', text: 'On it, asking Scout', time: 200 })
  rt.waiting.m1 = { bots: ['b2'], rooms: [], for: [], waits: [] }
  const before = rt.reads.count
  const pending = await call('wait_for_reply', { bot: 'm1', after: 0, timeoutSeconds: 1 })
  assert.equal(pending.done, false, 'handed-on work still counts as working')
  assert.equal(pending.messages.length, 11)
  assert.ok(rt.reads.count - before < 100, `read ${rt.reads.count - before} pages`)

  setTimeout(() => {
    delete rt.waiting.m1
    rt.chats.m1.push({ kind: 'bot', text: 'Scout says yes', time: 300 })
  }, 50)
  const reply = await call('wait_for_reply', { bot: 'm1', after: 200, timeoutSeconds: 5 })
  assert.deepEqual([reply.done, reply.messages.map(item => item.text)], [true, ['Scout says yes']])
})

test('turning MCP access off does not wait for an open wait_for_reply', async () => {
  let release
  const server = mcpHttpServer({
    authorize: token => (token === 'ok' ? { id: 'c1' } : undefined),
    callFor: () => () => new Promise((resolve) => { release = resolve }),
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  const open = rpc(url, 'ok', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_reply', arguments: {} } })
  await until(async () => release, Boolean)
  const started = Date.now()
  await closeServer(server)
  assert.ok(Date.now() - started < 1000, 'closed at once')
  await assert.rejects(open)
  release({})
})

test('a bad entry in mcp.json does not lock out the other clients, and last use is saved', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-mcp-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const port = await freePort()
  const token = 'dsb_test'
  const hash = createHash('sha256').update(token).digest('hex')
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    on: true,
    port,
    clients: [{ id: 'bad', name: 'Bad', hash: 'abc', bots: [], rooms: [] }, { id: 'ok', name: 'Script', hash, bots: ['m1'], rooms: [] }],
  }))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await until(async () => (await desk.call('state', {})).value.mcp, mcp => mcp.status === 'on')
  const url = `http://127.0.0.1:${port}/mcp`
  assert.equal((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200)
  assert.equal((await rpc(url, 'dsb_other', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  const lastUsed = () => JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).clients.find(client => client.id === 'ok').lastUsedAt
  assert.ok(Number.isFinite(lastUsed()))
  // Requests 30 s apart: the one 70 s after the first save is saved again.
  const realNow = Date.now
  let offset = 0
  t.mock.method(Date, 'now', () => realNow() + offset)
  offset = 30_000
  await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'ping' })
  offset = 70_000
  const before = realNow() + offset
  await rpc(url, token, { jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.ok(lastUsed() >= before)
})
