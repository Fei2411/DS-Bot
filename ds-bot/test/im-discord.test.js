import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import discord from '../src/host/im/platforms/discord.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Discord: REST answers from `replies`, the gateway sends an op-10 hello
// and READY on identify, and lets the test push dispatch packets.
async function fakeDiscord() {
  const calls = []
  const replies = {}
  const packets = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      const call = { method: req.method, path: req.url, params }
      calls.push(call)
      let answer = replies[req.url]
      if (answer === undefined && req.url === '/api/v10/users/@me') answer = { result: { id: '81', username: 'fakebot', bot: true } }
      if (answer === undefined && req.url === '/api/v10/gateway/bot') answer = { result: { url: wss.url } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: { id: '900' } }
      if (answer.error) {
        res.writeHead(answer.error, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: answer.description ?? 'failed', retry_after: answer.retry_after }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.result))
    })
  })
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        packets.push(packet)
        if (packet.op === 2) {
          ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', resume_gateway_url: wss.url, user: { id: '81', username: 'fakebot' } } }))
        }
        if (packet.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 9, d: {} }))
        if (packet.op === 1) ws.send(JSON.stringify({ op: 11, d: null }))
      })
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}/api/v10`,
    gateway: wss.url,
    calls, replies, packets,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api, gateway: fake.gateway },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-discord]', ...args) },
})

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('check validates the bot token and names the account', async () => {
  const fake = await fakeDiscord()
  const { account } = await discord.check({ token: 'tok' }, env(fake))
  assert.deepEqual(account, { id: '81', name: '@fakebot' })
  assert.ok(fake.calls.some(call => call.path === '/api/v10/users/@me'))
  await fake.close()
})

test('a DM is direct, a guild message is a mention when the bot is in mentions', async (t) => {
  const fake = await fakeDiscord()
  const messages = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: async (msg) => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '10', channel_id: 'dm1', content: 'hello', author: { id: 'u1', username: 'Fei' } } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: '11', channel_id: 'g1', guild_id: 'w1', content: 'hey <@81> ping', author: { id: 'u2', username: 'Yan' }, mentions: [{ id: '81' }] } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: '12', channel_id: 'g1', guild_id: 'w1', content: 'noise', author: { id: 'u2', username: 'Yan' }, mentions: [] } })
  await until(() => messages.length === 3)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[1].text, 'hey  ping')
  assert.equal(messages[2].mentioned, false)
})

test('a component press is deferred and reports the action', async (t) => {
  const fake = await fakeDiscord()
  const actions = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: async (action) => { actions.push(action) }, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'INTERACTION_CREATE', s: 2, d: { type: 3, id: 'i1', token: 'it', channel_id: 'dm1', user: { id: 'u1', username: 'Fei' }, data: { custom_id: 'q:q1:0' }, message: { id: '77' } } })
  await until(() => actions.length === 1)
  assert.equal(actions[0].data, 'q:q1:0')
  assert.ok(fake.calls.some(call => /interactions\/i1\/it\/callback/.test(call.path) && call.params.type === 6))
})

test('send chunks long text, buttons go on the last chunk, edit patches', async (t) => {
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const { messageId } = await handle.send({ key: 'dm1', kind: 'direct' }, { text: 'x'.repeat(4500), buttons: [{ data: 'q:q1:0', label: 'yes' }, { data: 'q:q1:1', label: 'no' }] })
  const posts = fake.calls.filter(call => /messages$/.test(call.path) && call.method === 'POST')
  assert.equal(posts.length, 3)
  assert.ok(posts.every(call => call.params.content.length <= 2000))
  assert.equal(posts[0].params.components.length, 0)
  assert.equal(posts[2].params.components[0].components.length, 2)
  assert.equal(messageId, '900')
  await handle.edit({ key: 'dm1', kind: 'direct' }, '55', { text: 'done', buttons: [] })
  assert.ok(fake.calls.some(call => call.method === 'PATCH' && /messages\/55$/.test(call.path)))
})

test('a dropped socket reconnects and resumes the session', async (t) => {
  const fake = await fakeDiscord()
  const statuses = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => statuses.some(status => status.state === 'ready'))
  ws.close()
  await until(() => fake.sockets.length === 2)
  await until(() => fake.packets.some(packet => packet.op === 6))
  assert.ok(statuses.some(status => status.state === 'connecting'))
})
