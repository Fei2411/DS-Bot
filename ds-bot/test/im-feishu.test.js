import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import feishu, { decodeFrame, encodeFrame } from '../src/host/im/platforms/feishu.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Feishu: OpenAPI answers the tenant token, bot info and message calls;
// the endpoint hands back the fake socket and the test pushes protobuf frames.
async function fakeFeishu() {
  const calls = []
  const frames = []
  const replies = {}
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization })
      let answer = replies[req.url]
      if (answer === undefined && req.url === '/open-apis/auth/v3/tenant_access_token/internal') answer = { result: { tenant_access_token: 'fs-tok', expire: 7200 } }
      if (answer === undefined && req.url === '/open-apis/bot/v3/info') answer = { result: { code: 0, bot: { open_id: 'ou_bot', app_name: 'fakebot' } } }
      if (answer === undefined && req.url === '/open-apis/bot/v2/endpoint') answer = { result: { code: 0, data: { URL: wss.url } } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: { code: 0, data: { message_id: 'om_x' } } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.result))
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
    calls, replies, frames,
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

test('check asks for a tenant token and names the bot', async () => {
  const fake = await fakeFeishu()
  const { account } = await feishu.check(FIELDS, env(fake))
  assert.equal(account.id, 'ou_bot')
  assert.equal(account.name, 'fakebot')
  const token = fake.calls.find(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(token.params.app_id, 'cli_a1')
  await fake.close()
})

test('a ping gets a pong, a p2p is direct, a group counts only with a mention, data frames are ACKed', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/open-apis/bot/v2/endpoint'))
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

test('a dropped socket reconnects through a fresh endpoint', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  ws.close()
  await until(() => fake.sockets.length === 2)
  assert.ok(fake.calls.filter(call => call.path === '/open-apis/bot/v2/endpoint').length >= 2)
})
