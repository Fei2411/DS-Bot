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
  const resources = {}
  const tokens = []
  let tokenValidUntil = 0
  let tokenReplyDelay = 0
  let failResources = false
  // The resource endpoint sends the file itself, not a JSON envelope.
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // A tenant token also dies when its two hours are up, like the real one.
  const authorized = (req) => req.headers.authorization === `Bearer ${tokens.at(-1)}` && Date.now() < tokenValidUntil
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
        tokenValidUntil = Date.now() + 7_200_000
        setTimeout(() => json(res, { code: 0, tenant_access_token: token, expire: 7200 }), tokenReplyDelay)
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
      if (req.url.startsWith('/open-apis/im/v1/messages/') && req.url.includes('/resources/')) {
        if (failResources || !authorized(req)) { res.writeHead(401); res.end(); return }
        const parsed = new URL(req.url, 'http://127.0.0.1')
        const kind = parsed.searchParams.get('type')
        if (kind !== 'image' && kind !== 'file') {
          json(res, { code: 230001, msg: 'invalid resource type' })
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(resources[req.url] ?? imageBytes)
        return
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        if (!authorized(req)) { refused(res); return }
        if (params.msg_type === 'interactive') {
          const card = JSON.parse(params.content || '{}')
          if (card.schema === '2.0') {
            const elements = card.body?.elements ?? []
            const badAction = elements.find(el => el?.tag === 'action')
            const badButton = elements.some(el => el?.tag === 'column_set' && (el.columns ?? []).some(col => (col.elements ?? []).some(btn => btn?.tag === 'button' && (btn.value !== undefined || !Array.isArray(btn.behaviors)))))
            if (badAction !== undefined || badButton) {
              json(res, { code: 200861, msg: 'cards of schema V2 no longer support this capability' })
              return
            }
          }
        }
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
    calls, replies, resources, frames, tokens, imageBytes,
    sockets: wss.sockets,
    failDownloads: () => { failResources = true },
    slowTokens: (ms) => { tokenReplyDelay = ms },
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

for (const [mediaType, bytes] of [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ['image/gif', Buffer.from('GIF89a')],
  ['image/webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP')],
]) {
  test(`an inbound ${mediaType} keeps its bytes and declares their format`, async (t) => {
    const fake = await fakeFeishu()
    const messages = []
    fake.resources['/open-apis/im/v1/messages/om_image/resources/img_1?type=image'] = bytes
    const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
    t.after(() => { handle.stop(); fake.close() })
    const ws = await until(() => fake.sockets[0])
    fake.push(ws, fake.dataFrame('event', message({
      chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_image',
      message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }),
    })))
    await until(() => messages.length === 1)
    assert.deepEqual(messages[0].images, [{ mediaType, data: bytes.toString('base64') }])
  })
}

test('an unrecognized image is diagnosed instead of being declared as PNG', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const warnings = []
  fake.resources['/open-apis/im/v1/messages/om_image/resources/img_1?type=image'] = Buffer.from('not an image')
  const environment = { ...env(fake), log: { warn: (...args) => warnings.push(args.join(' ')) } }
  const handle = feishu.connect(FIELDS, environment, { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_image',
    message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }),
  })))
  await until(() => warnings.length > 0 || messages.length > 0)
  assert.equal(messages.length, 0)
  assert.match(warnings.join('\n'), /unsupported image format/i)
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
  assert.equal(card.schema, '2.0')
  assert.ok(!card.body.elements.some(el => el.tag === 'action'), 'schema 2.0 must not use action container')
  const row = card.body.elements.at(-1)
  assert.equal(row.tag, 'column_set')
  assert.equal(row.flex_mode, 'flow')
  assert.equal(row.horizontal_spacing, '8px')
  assert.equal(row.columns[0].tag, 'column')
  assert.equal(row.columns[0].width, 'auto')
  const btn = row.columns[0].elements[0]
  assert.equal(btn.tag, 'button')
  assert.equal(btn.value, undefined)
  assert.deepEqual(btn.behaviors, [{ type: 'callback', value: { v: 'q:q1:0' } }])
  assert.equal(messageId, 'om_x')
  await handle.edit({ key: 'oc_1', kind: 'direct' }, 'om_9', { text: 'done', buttons: [] })
  const patch = fake.calls.find(call => call.method === 'PATCH' && call.path === '/open-apis/im/v1/messages/om_9')
  assert.ok(patch, 'message PATCH called')
  const patchedCard = JSON.parse(patch.params.content)
  assert.equal(patchedCard.schema, '2.0')
  assert.equal(patchedCard.body.elements.length, 1)
})

test('send drops blank lines at the start and end of the text', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  await handle.send({ key: 'oc_1', kind: 'direct' }, { text: '\n\nfirst\n\nsecond\n\n' })
  const posts = fake.calls.filter(call => call.path.startsWith('/open-apis/im/v1/messages?'))
  assert.equal(posts.length, 1)
  assert.equal(posts[0].params.msg_type, 'text')
  assert.equal(JSON.parse(posts[0].params.content).text, 'first\n\nsecond')
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

test('an inbound image refreshes an expired tenant token before download', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const image = (id) => fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: id, message_type: 'image',
    content: JSON.stringify({ image_key: `key_${id}` }),
  }), { messageId: id })
  fake.push(ws, image('om_1'))
  await until(() => messages.length === 1)
  assert.equal(messages[0].images[0].data, fake.imageBytes.toString('base64'))
  // Two hours later the cached token is dead: the download has to renew it.
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  fake.push(ws, image('om_2'))
  await until(() => messages.length === 2)
  assert.equal(messages[1].images.length, 1)
  assert.equal(messages[1].images[0].data, fake.imageBytes.toString('base64'))
  assert.equal(fake.tokens.length, 2, 'the expired token was renewed once')
  const download = fake.calls.findLast(call => call.path.includes('/resources/'))
  assert.equal(download.auth, `Bearer ${fake.tokens[1]}`)
})

test('a failed image download warns instead of staying silent', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const warns = []
  const log = { warn: (...args) => warns.push(args.join(' ')) }
  const handle = feishu.connect(FIELDS, { ...env(fake), log }, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.failDownloads()
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: 'image',
    content: JSON.stringify({ image_key: 'key_1' }),
  }), { messageId: 'fm1' }))
  await until(() => warns.length === 1)
  assert.match(warns[0], /om_1/)
  await until(() => messages.length === 1)
  assert.equal(messages[0].images.length, 0, 'the message still arrives, without the image')
})

// #1417: the send path classified 5xx as retryable but carried no status, so the
// queue could not tell a broken tunnel from a network blip and retried forever.
test('a 5xx answer is retryable and carries its status; a 4xx answer is permanent', async () => {
  const responding = (status, body) => async (url) => (url.endsWith('/tenant_access_token/internal')
    ? { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tok', expire: 7200 }) }
    : { ok: false, status, json: async () => body })
  await assert.rejects(feishu.check(FIELDS, { fetch: responding(502, { msg: 'bad gateway' }), config: { api: 'https://open.feishu.cn' } }), (error) => {
    assert.equal(error.status, 502)
    assert.notEqual(error.permanent, true, 'a 5xx must stay retryable')
    return true
  })
  await assert.rejects(feishu.check(FIELDS, { fetch: responding(403, { msg: 'forbidden' }), config: { api: 'https://open.feishu.cn' } }), (error) => {
    assert.equal(error.status, 403)
    assert.equal(error.permanent, true, 'a 4xx is not retried')
    return true
  })
})

test('images arriving together after expiry share one token refresh', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  // Slow token replies make a second refresh overtake the first download
  // deterministically; the fake only accepts its newest token.
  fake.slowTokens(50)
  const image = (id) => fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: id, message_type: 'image',
    content: JSON.stringify({ image_key: `key_${id}` }),
  }), { messageId: id })
  fake.push(ws, image('om_1'))
  fake.push(ws, image('om_2'))
  await until(() => messages.length === 2)
  assert.equal(fake.tokens.length, 2, 'two expired downloads share the one refresh')
  assert.equal(messages[0].images.length, 1)
  assert.equal(messages[1].images.length, 1)
})

test('post rich-text flattens paragraphs and sniffs embedded image formats (#1658)', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const webp = Buffer.from('RIFF\x04\x00\x00\x00WEBP')
  fake.resources['/open-apis/im/v1/messages/om_post1/resources/img_j?type=image'] = jpeg
  fake.resources['/open-apis/im/v1/messages/om_post2/resources/img_w?type=image'] = webp
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_post1', message_type: 'post',
    content: JSON.stringify({
      title: 'Release notes',
      content: [
        [{ tag: 'text', text: '1. See ' }, { tag: 'a', text: 'docs', href: 'https://example.com' }],
        [{ tag: 'at', user_id: 'ou_alice', user_name: 'Alice' }, { tag: 'emotion', emoji_type: 'THUMBSUP' }],
        [{ tag: 'code_block', language: 'js', text: 'console.log(1)' }],
        [{ tag: 'img', image_key: 'img_j' }],
      ],
    }),
  }), { messageId: 'fm_post1' }))
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_post2', message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: '图文',
        content: [
          [{ tag: 'text', text: '第二条' }, { tag: 'img', image_key: 'img_w' }],
        ],
      },
    }),
  }), { messageId: 'fm_post2' }))
  await until(() => messages.length === 2)
  const post1 = messages.find(m => m.messageId === 'om_post1')
  const post2 = messages.find(m => m.messageId === 'om_post2')
  assert.match(post1.text, /^Release notes\n1\. See docs \(https:\/\/example\.com\)/)
  assert.match(post1.text, /@Alice\[THUMBSUP\]/)
  assert.match(post1.text, /```js\nconsole\.log\(1\)\n```/)
  assert.deepEqual(post1.images, [{ mediaType: 'image/jpeg', data: jpeg.toString('base64') }])
  assert.equal(post2.text, '图文\n第二条')
  assert.deepEqual(post2.images, [{ mediaType: 'image/webp', data: webp.toString('base64') }])
})

test('file, audio, and media messages download attachments into files (#1658)', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const pdf = Buffer.from('%PDF-1.4\nhello')
  const opus = Buffer.from('OggS-audio-bytes')
  const mp4 = Buffer.from('ftypmp42-video-bytes')
  fake.resources['/open-apis/im/v1/messages/om_file/resources/fk_pdf?type=file'] = pdf
  fake.resources['/open-apis/im/v1/messages/om_audio/resources/fk_aud?type=file'] = opus
  fake.resources['/open-apis/im/v1/messages/om_media/resources/fk_vid?type=file'] = mp4
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_file', message_type: 'file',
    content: JSON.stringify({ file_key: 'fk_pdf', file_name: 'report.pdf' }),
  }), { messageId: 'fm_file' }))
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_audio', message_type: 'audio',
    content: JSON.stringify({ file_key: 'fk_aud', duration: 3000 }),
  }), { messageId: 'fm_audio' }))
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_media', message_type: 'media',
    content: JSON.stringify({ file_key: 'fk_vid', file_name: 'clip.mp4' }),
  }), { messageId: 'fm_media' }))
  await until(() => messages.length === 3)
  const fileMsg = messages.find(m => m.messageId === 'om_file')
  const audioMsg = messages.find(m => m.messageId === 'om_audio')
  const mediaMsg = messages.find(m => m.messageId === 'om_media')
  assert.equal(fileMsg.files.length, 1)
  assert.equal(fileMsg.files[0].name, 'report.pdf')
  assert.deepEqual(Buffer.from(fileMsg.files[0].data), pdf)
  assert.equal(audioMsg.files.length, 1)
  assert.equal(audioMsg.files[0].name, 'voice-om_audio.opus')
  assert.deepEqual(Buffer.from(audioMsg.files[0].data), opus)
  assert.equal(mediaMsg.files.length, 1)
  assert.equal(mediaMsg.files[0].name, 'clip.mp4')
  assert.deepEqual(Buffer.from(mediaMsg.files[0].data), mp4)
})

test('non-text message types surface notes instead of silent drop, system is ignored (#1658)', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const kinds = ['sticker', 'merge_forward', 'share_chat', 'share_user', 'location', 'todo', 'share_calendar_event']
  for (const [idx, kind] of kinds.entries()) {
    fake.push(ws, fake.dataFrame('event', message({
      chat_type: 'p2p', chat_id: 'oc_1', message_id: `om_k${idx}`, message_type: kind,
      content: JSON.stringify(kind === 'location' ? { name: 'HQ' } : {}),
    }), { messageId: `fm_k${idx}` }))
  }
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_sys', message_type: 'system',
    content: JSON.stringify({ template: 'join' }),
  }), { messageId: 'fm_sys' }))
  await until(() => messages.length === kinds.length)
  for (const [idx, kind] of kinds.entries()) {
    const found = messages.find(m => m.messageId === `om_k${idx}`)
    assert.ok(found?.text.length > 0, `message_type ${kind} must emit non-empty note`)
  }
  assert.match(messages.find(m => m.messageId === 'om_k4').text, /HQ/)
  // Wait briefly to confirm system message did not produce an extra onMessage call.
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(messages.length, kinds.length)
})

test('group @ check requires botOpenId and preserves other @mentions (#1658)', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  // Mentioning another user as @_user_1 must NOT trigger the bot, and keeps @ZhangSan.
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_g1', message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 can you check this?' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_zhangsan' }, name: 'ZhangSan' }],
  }), { messageId: 'fm_g1' }))
  // Mentioning both the bot (@_user_2) and another user (@_user_1) strips only the bot mention.
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_g2', message_type: 'text',
    content: JSON.stringify({ text: '@_user_2 please ask @_user_1 for details' }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_zhangsan' }, name: 'ZhangSan' },
      { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'fakebot' },
    ],
  }), { messageId: 'fm_g2' }))
  // Group post mentioning the bot and another user strips the bot @ and preserves @ZhangSan.
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_g3', message_type: 'post',
    content: JSON.stringify({
      content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'fakebot' },
        { tag: 'text', text: ' check with ' },
        { tag: 'at', user_id: 'ou_zhangsan', user_name: 'ZhangSan' },
      ]],
    }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'fakebot' },
      { key: '@_user_2', id: { open_id: 'ou_zhangsan' }, name: 'ZhangSan' },
    ],
  }), { messageId: 'fm_g3' }))
  await until(() => messages.length === 3)
  const g1 = messages.find(m => m.messageId === 'om_g1')
  const g2 = messages.find(m => m.messageId === 'om_g2')
  const g3 = messages.find(m => m.messageId === 'om_g3')
  assert.equal(g1.mentioned, false)
  assert.equal(g1.text, '@ZhangSan can you check this?')
  assert.equal(g2.mentioned, true)
  assert.equal(g2.text, 'please ask @ZhangSan for details')
  assert.equal(g3.mentioned, true)
  assert.equal(g3.text, 'check with @ZhangSan')
})

test('group @ check does not fall back to @_user_1 when botOpenId is unavailable (#1658)', async (t) => {
  const fake = await fakeFeishu()
  fake.replies['/open-apis/bot/v3/info'] = { result: { code: 99991663, msg: 'unavailable' } }
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_g4', message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 hello' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone' }, name: 'Someone' }],
  }), { messageId: 'fm_g4' }))
  await until(() => messages.length === 1)
  assert.equal(messages[0].mentioned, false)
  assert.equal(messages[0].text, '@Someone hello')
})

test('post skips an unreadable embedded image without dropping text and supports media filename fallback (#1658)', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const warnings = []
  const gif = Buffer.from('GIF89a\x01\x00')
  const mp4 = Buffer.from('ftypmp42')
  fake.resources['/open-apis/im/v1/messages/om_post_mix/resources/img_gif?type=image'] = gif
  fake.resources['/open-apis/im/v1/messages/om_post_mix/resources/img_bad?type=image'] = Buffer.from('not-an-image')
  fake.resources['/open-apis/im/v1/messages/om_media_noname/resources/fk_v2?type=file'] = mp4
  const log = { warn: (...args) => warnings.push(args.join(' ')) }
  const handle = feishu.connect(FIELDS, { ...env(fake), log }, { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_post_mix', message_type: 'post',
    content: JSON.stringify({
      content: [[{ tag: 'text', text: 'keep this text' }, { tag: 'img', image_key: 'img_gif' }, { tag: 'img', image_key: 'img_bad' }]],
    }),
  }), { messageId: 'fm_pmix' }))
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_media_noname', message_type: 'media',
    content: JSON.stringify({ file_key: 'fk_v2' }),
  }), { messageId: 'fm_mnn' }))
  await until(() => messages.length === 2)
  const postMix = messages.find(m => m.messageId === 'om_post_mix')
  const mediaNoName = messages.find(m => m.messageId === 'om_media_noname')
  assert.equal(postMix.text, 'keep this text')
  assert.deepEqual(postMix.images, [{ mediaType: 'image/gif', data: gif.toString('base64') }])
  assert.ok(warnings.some(w => /om_post_mix/.test(w)), 'unsupported post image logged a warning')
  assert.equal(mediaNoName.files[0].name, 'video-om_media_noname.mp4')
  assert.deepEqual(Buffer.from(mediaNoName.files[0].data), mp4)
})
