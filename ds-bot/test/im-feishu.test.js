import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import feishu, { decodeFrame, encodeFrame } from '../src/host/im/platforms/feishu.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Feishu that answers only the calls the real service answers, with the
// real shapes: the tenant token is a string, /callback/ws/endpoint needs the
// Bearer token and the uppercase AppID/AppSecret body, and anything else is a
// 404. A regression to the old path, a token object or lowercase fields fails
// here instead of passing against a permissive mock.
async function fakeFeishu() {
  const calls = []
  const frames = []
  const replies = {}
  const tokens = []
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const authorized = (req) => req.headers.authorization === `Bearer ${tokens.at(-1)}`
  const refused = (res) => json(res, { code: 99991668, msg: 'user access token not support' })
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization })
      const override = replies[req.url]
      if (override !== undefined) { json(res, override.result); return }
      if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        if (params.app_id !== 'cli_a1' || params.app_secret !== 'sec') { json(res, { code: 10003, msg: 'invalid param' }); return }
        const token = `fs-tok-${tokens.length + 1}`
        tokens.push(token)
        json(res, { code: 0, tenant_access_token: token, expire: 7200 })
        return
      }
      if (req.url === '/open-apis/bot/v3/info') {
        if (!authorized(req)) { refused(res); return }
        json(res, { code: 0, bot: { open_id: 'ou_bot', app_name: 'fakebot' } })
        return
      }
      if (req.method === 'POST' && req.url === '/callback/ws/endpoint') {
        if (!authorized(req)) { refused(res); return }
        const uppercase = params.AppID === 'cli_a1' && params.AppSecret === 'sec'
          && params.appId === undefined && params.appSecret === undefined
        if (!uppercase) { json(res, { code: 10003, msg: 'invalid param' }); return }
        json(res, { code: 0, msg: 'success', data: { URL: wss.url, ClientConfig: { PingInterval: 90, ReconnectInterval: 90 } } })
        return
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        if (!authorized(req)) { refused(res); return }
        json(res, { code: 0, data: { message_id: 'om_x' } })
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('404 page not found')
    })
  })
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const frame = decodeFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'))
        frames.push({ ws, frame })
      })
      ws.send(encodeFrame({ SeqID: 1, LogID: 2, service: 100, method: 0, headers: [{ key: 'type', value: 'ping' }], payload: Buffer.from('ping') }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}`,
    calls, replies, frames, tokens,
    sockets: wss.sockets,
    push: (ws, frame) => ws.send(encodeFrame(frame)),
    dataFrame: (type, payload, extra = {}) => ({
      SeqID: 9, LogID: 9, service: 100, method: 1,
      headers: [{ key: 'type', value: type }, { key: 'message_id', value: extra.messageId ?? 'fm1' }, ...(extra.headers ?? [])],
      payload: Buffer.from(JSON.stringify(payload)),
    }),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api },
  runtime: { get: () => ({}), set: () => {} },
  log: { warn: (...args) => console.error('[im-feishu]', ...args) },
})
const FIELDS = { appId: 'cli_a1', appSecret: 'sec' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

const message = (body) => ({
  header: { event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_u1' } },
    message: body,
  },
})

test('check asks for a tenant token and names the bot with it', async () => {
  const fake = await fakeFeishu()
  const { account } = await feishu.check(FIELDS, env(fake))
  assert.equal(account.id, 'ou_bot')
  assert.equal(account.name, 'fakebot')
  const token = fake.calls.find(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(token.params.app_id, 'cli_a1')
  // The Bearer token is the token string, not the tenantToken() result object.
  const info = fake.calls.find(call => call.path === '/open-apis/bot/v3/info')
  assert.equal(info.auth, `Bearer ${fake.tokens[0]}`)
  await fake.close()
})

test('the fake refuses the old path, an object token and lowercase fields', async (t) => {
  const fake = await fakeFeishu()
  t.after(() => fake.close())
  const answer = await fetch(`${fake.api}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: 'cli_a1', app_secret: 'sec' }),
  })
  const { tenant_access_token: token } = await answer.json()
  const post = async (path, body, auth) => {
    const response = await fetch(`${fake.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth === undefined ? {} : { authorization: auth }) },
      body: JSON.stringify(body),
    })
    return { response, body: await response.json().catch(() => undefined) }
  }
  const oldPath = await post('/open-apis/bot/v2/endpoint', { AppID: 'cli_a1', AppSecret: 'sec' }, `Bearer ${token}`)
  assert.equal(oldPath.response.status, 404)
  const objectToken = await post('/callback/ws/endpoint', { AppID: 'cli_a1', AppSecret: 'sec' }, 'Bearer [object Object]')
  assert.equal(objectToken.body.code, 99991668)
  const lowercase = await post('/callback/ws/endpoint', { appId: 'cli_a1', appSecret: 'sec' }, `Bearer ${token}`)
  assert.equal(lowercase.body.code, 10003)
})

test('a ping gets a pong, a p2p is direct, a group counts only with a mention, data frames are ACKed', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const endpoint = await until(() => fake.calls.find(call => call.path === '/callback/ws/endpoint'))
  assert.equal(endpoint.auth, `Bearer ${fake.tokens[0]}`)
  assert.deepEqual(endpoint.params, { AppID: 'cli_a1', AppSecret: 'sec' })
  // The ping sent on connect gets a pong back.
  await until(() => fake.frames.some(({ frame }) => frame.method === 0 && frame.headers.some(h => h.key === 'type' && h.value === 'pong')))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) }), { messageId: 'fm1' }))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_2', message_type: 'text', content: JSON.stringify({ text: '@_user_1 ping' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] }), { messageId: 'fm2' }))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_3', message_type: 'text', content: JSON.stringify({ text: 'noise' }), mentions: [] }), { messageId: 'fm3' }))
  await until(() => messages.length === 3)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[1].text, 'ping')
  assert.equal(messages[2].mentioned, false)
  // Each data frame was ACKed back with the {"code":200} payload.
  await until(() => fake.frames.filter(({ frame }) => frame.method === 1 && frame.headers.some(h => h.key === 'biz_rt')).length === 3)
})

test('a card action reports the button data', async (t) => {
  const fake = await fakeFeishu()
  const actions = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: async action => { actions.push(action) }, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.sockets.length === 1)
  fake.push(ws, fake.dataFrame('card', {
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { v: 'q:q1:0' } }, operator: { open_id: 'ou_u1' }, context: { open_chat_id: 'oc_1' }, message_id: 'om_9' },
  }, { messageId: 'fm9' }))
  await until(() => actions.length === 1)
  assert.equal(actions[0].data, 'q:q1:0')
  assert.equal(actions[0].messageId, 'om_9')
})

test('send posts text and an interactive card, edit patches the message', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  const { messageId } = await handle.send({ key: 'oc_1', kind: 'direct' }, { text: 'hello', buttons: [{ data: 'q:q1:0', label: 'yes' }] })
  const post = fake.calls.find(call => call.path.startsWith('/open-apis/im/v1/messages?'))
  assert.ok(post, 'messages POST called')
  assert.equal(post.params.receive_id, 'oc_1')
  assert.equal(post.params.msg_type, 'interactive')
  const card = JSON.parse(post.params.content)
  const action = card.body.elements.at(-1)
  assert.equal(action.tag, 'action')
  assert.equal(action.actions[0].value.v, 'q:q1:0')
  assert.equal(messageId, 'om_x')
  await handle.edit({ key: 'oc_1', kind: 'direct' }, 'om_9', { text: 'done', buttons: [] })
  const patch = fake.calls.find(call => call.method === 'PATCH' && call.path === '/open-apis/im/v1/messages/om_9')
  assert.ok(patch, 'message PATCH called')
})

test('a dropped socket reconnects through a fresh endpoint and a renewed token', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.calls.filter(call => call.path === '/callback/ws/endpoint').length === 1)
  // Move the clock past the token's expiry, so the next handshake has to renew it.
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  ws.close()
  const endpoint = await until(() => fake.calls.filter(call => call.path === '/callback/ws/endpoint')[1], 160)
  assert.ok(endpoint, 'handshake after the reconnect')
  assert.equal(fake.tokens.length, 2)
  assert.equal(endpoint.auth, `Bearer ${fake.tokens[1]}`)
})

test('a refused handshake reports the code and the message', async (t) => {
  const fake = await fakeFeishu()
  fake.replies['/callback/ws/endpoint'] = { result: { code: 10003, msg: 'invalid param' } }
  const statuses = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  const error = await until(() => statuses.find(status => status.state === 'error'))
  assert.ok(error, 'an error status')
  assert.match(error.error, /invalid param/)
  assert.match(error.error, /10003/)
})

test('a network failure at start is retried until the platform answers (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let down = true
  const fetch = async (...args) => {
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = feishu.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 160)
  assert.ok(fake.calls.some(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal'))
  assert.equal(fake.sockets.length, 1)
})

test('a ws endpoint failure after the token is accepted is retried (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let down = true
  let handshakes = 0
  const fetch = async (url, ...rest) => {
    if (String(url).endsWith('/callback/ws/endpoint')) {
      handshakes += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = feishu.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  // The token and bot identity were accepted first, so this covers the websocket
  // handshake and not a second token failure.
  assert.equal(fake.calls.filter(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal').length, 1)
  assert.ok(fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  assert.equal(fake.sockets.length, 0)
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after the retry')
  assert.equal(handshakes, 2)
  assert.equal(fake.sockets.length, 1, 'the retry opened one socket, not one per attempt')
})

test('a socket that cannot be built at the handshake is retried (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let failures = 1
  const WebSocket = function (...args) {
    if (failures > 0) { failures -= 1; throw new TypeError('socket unavailable') }
    return new base.WebSocket(...args)
  }
  const handle = feishu.connect(FIELDS, { ...base, WebSocket }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /could not open a socket/)
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after a new socket')
  assert.equal(fake.sockets.length, 1)
})
