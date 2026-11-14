import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import qq from '../src/host/im/platforms/qq.js'
import { fakeWsServer } from './fake-ws.js'

// A fake QQ open platform: /app/getAppAccessToken issues a token, /gateway the
// fake socket URL, C2C and group @ events come from the test, and sends record
// their msg_id/msg_seq.
async function fakeQq() {
  const calls = []
  const replies = {}
  const packets = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      const call = { method: req.method, path: req.url, params, auth: req.headers.authorization }
      calls.push(call)
      let answer = replies[req.url]
      if (answer === undefined && req.url === '/app/getAppAccessToken') answer = { result: { access_token: 'qqtok', expires_in: 7200 } }
      if (answer === undefined && req.url === '/gateway') answer = { result: { url: wss.url } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: { id: '900' } }
      if (answer.error) {
        res.writeHead(answer.status ?? 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: answer.error, message: answer.message ?? 'refused' }))
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
        if (packet.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', user: { id: '81', username: 'fakebot' } } }))
        if (packet.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 9, d: {} }))
        if (packet.op === 1) ws.send(JSON.stringify({ op: 11, d: null }))
      })
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}`,
    calls, replies, packets,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api, token: fake.api },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-qq]', ...args) },
})
const FIELDS = { appId: '1020', appSecret: 'sekret' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('check gets an app access token and names the account', async () => {
  const fake = await fakeQq()
  const { account } = await qq.check(FIELDS, env(fake))
  assert.equal(account.id, '1020')
  const token = fake.calls.find(call => call.path === '/app/getAppAccessToken')
  assert.equal(token.params.appId, '1020')
  assert.equal(token.params.clientSecret, 'sekret')
  await fake.close()
})

test('C2C is direct, a group @ is a mention, heartbeats are answered', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hello', author: { user_openid: 'u1' } } })
  fake.push(ws, { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: { id: 'm2', content: 'ping', group_openid: 'g1', author: { member_openid: 'u2' } } })
  await until(() => messages.length === 2)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[0].chat.key, 'u1')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].chat.key, 'g1')
  assert.equal(messages[1].mentioned, true)
  // A heartbeat request from the server gets an op-1 reply.
  fake.push(ws, { op: 1, d: null })
  await until(() => fake.packets.filter(packet => packet.op === 1).length === 2)
})

test('send replies passively with msg_id and a climbing msg_seq; a refusal is permanent', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hi', author: { user_openid: 'u1' } } })
  await until(() => messages.length === 1)
  await handle.send({ key: 'u1', kind: 'direct' }, { text: 'one' })
  await handle.send({ key: 'u1', kind: 'direct' }, { text: 'two' })
  const posts = fake.calls.filter(call => call.path === '/v2/users/u1/messages')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].params.msg_id, 'm1')
  assert.equal(posts[0].params.msg_seq, 1)
  assert.equal(posts[1].params.msg_seq, 2)
  // A refusal outside the reply window is a permanent error with the reason.
  fake.replies['/v2/users/u1/messages'] = { error: 304023, message: 'reply time out' }
  await assert.rejects(() => handle.send({ key: 'u1', kind: 'direct' }, { text: 'late' }), error => error.permanent === true && /reply/.test(error.message))
})

test('a dropped socket reconnects and resumes', async (t) => {
  const fake = await fakeQq()
  const statuses = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => statuses.some(status => status.state === 'ready'))
  ws.close()
  await until(() => fake.sockets.length === 2)
  await until(() => fake.packets.some(packet => packet.op === 6))
})

test('a network failure at start is retried until the platform answers (#1119)', async (t) => {
  const fake = await fakeQq()
  const statuses = []
  const base = env(fake)
  let down = true
  const fetch = async (...args) => {
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = qq.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 120)
  assert.ok(fake.calls.some(call => call.path === '/app/getAppAccessToken'))
  assert.equal(fake.sockets.length, 1)
})

test('a gateway failure after the token is accepted is retried (#1119)', async (t) => {
  const fake = await fakeQq()
  const statuses = []
  const base = env(fake)
  let down = true
  let gateways = 0
  const fetch = async (url, ...rest) => {
    if (String(url).endsWith('/gateway')) {
      gateways += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = qq.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  // The token was accepted before the handshake, so this is the gateway path and
  // not a second token failure.
  assert.equal(fake.calls.filter(call => call.path === '/app/getAppAccessToken').length, 1)
  assert.equal(fake.sockets.length, 0)
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 120)
  assert.ok(ready !== undefined, 'the connection became ready after the retry')
  assert.equal(gateways, 2)
  assert.equal(fake.sockets.length, 1, 'the retry opened one socket, not one per attempt')
})

test('a 200 gateway with no url is a permanent refusal, not a retry loop (#1119)', async (t) => {
  const fake = await fakeQq()
  fake.replies['/gateway'] = { result: { message: 'no gateway for this app' } }
  const statuses = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const stopped = await until(() => statuses.find(status => status.state === 'error'))
  assert.match(stopped.error, /no gateway for this app/)
  await new Promise(done => setTimeout(done, 400))
  assert.equal(fake.calls.filter(call => call.path === '/gateway').length, 1, 'the refusal is not retried')
  assert.equal(statuses.filter(status => status.state === 'retrying').length, 0)
  assert.equal(fake.sockets.length, 0)
})

test('a socket that cannot be built at the handshake is retried (#1119)', async (t) => {
  const fake = await fakeQq()
  const statuses = []
  const base = env(fake)
  let failures = 1
  const WebSocket = function (...args) {
    if (failures > 0) { failures -= 1; throw new TypeError('socket unavailable') }
    return new base.WebSocket(...args)
  }
  const handle = qq.connect(FIELDS, { ...base, WebSocket }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /could not open a socket/)
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 120)
  assert.ok(ready !== undefined, 'the connection became ready after a new socket')
  assert.equal(fake.sockets.length, 1)
})
