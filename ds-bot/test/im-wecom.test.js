import assert from 'node:assert/strict'
import { test } from 'node:test'
import wecom from '../src/host/im/platforms/wecom.js'
import { fakeWsServer } from './fake-ws.js'

// A fake WeCom stream: aibot_subscribe gets an errcode 0 reply, callbacks get
// pushed frames, aibot_send_msg answers through pending req_ids.
async function fakeWecom() {
  const packets = []
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        packets.push(packet)
        if (packet.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 0, errmsg: 'ok' }))
        }
        if (packet.cmd === 'aibot_send_msg') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 0, errmsg: 'ok', body: { msgid: 'w1' } }))
        }
      })
    },
  })
  return {
    url: `${wss.url}/wss`,
    packets,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => wss.close(),
  }
}

const env = (fake) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { gateway: fake.url.replace('/wss', '') },
  runtime: { get: () => ({}), set: () => {} },
  log: { warn: (...args) => console.error('[im-wecom]', ...args) },
})
const FIELDS = { botId: 'bot-1', secret: 'sec-1' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('check subscribes over a throwaway socket: success returns the account, failure throws the reason', async () => {
  const fake = await fakeWecom()
  const { account } = await wecom.check(FIELDS, env(fake))
  assert.deepEqual(account, { id: 'bot-1', name: 'bot-1' })
  assert.ok(fake.packets.some(packet => packet.cmd === 'aibot_subscribe' && packet.body.secret === 'sec-1'))
  await fake.close()
  const refused = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        if (packet.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 60111, errmsg: 'invalid bot' }))
        }
      })
    },
  })
  await assert.rejects(
    () => wecom.check(FIELDS, {
      fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
      config: { gateway: refused.url.replace('/wss', '') }, runtime: { get: () => ({}), set: () => {} },
    }),
    /invalid bot/,
  )
  refused.close()
})

test('the socket subscribes with the bot id and secret and goes ready', async (t) => {
  const fake = await fakeWecom()
  const statuses = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.packets.some(packet => packet.cmd === 'aibot_subscribe'))
  const subscribe = fake.packets.find(packet => packet.cmd === 'aibot_subscribe')
  assert.equal(subscribe.body.bot_id, 'bot-1')
  assert.equal(subscribe.body.secret, 'sec-1')
  await until(() => statuses.some(status => status.state === 'ready'))
})

test('a single chat is direct, a template-card event reports the action', async (t) => {
  const fake = await fakeWecom()
  const messages = []
  const actions = []
  const handle = wecom.connect(FIELDS, env(fake), {
    onMessage: async msg => { messages.push(msg) },
    onAction: async action => { actions.push(action) },
    onStatus: () => {},
  })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.cmd === 'aibot_subscribe'))
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-1' }, body: { msgid: 'm1', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, text: { content: 'hello' } } })
  fake.push(ws, { cmd: 'aibot_event_callback', headers: { req_id: 'req-2' }, body: { msgid: 'm2', chattype: 'single', from: { userid: 'u1' }, event: { event_type: 'template_card_event', template_card_event: { event_key: 'q:q1:0', userid: 'u1' } } } })
  await until(() => messages.length === 1 && actions.length === 1)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[0].chat.key, 'u1')
  assert.equal(actions[0].data, 'q:q1:0')
})

test('a send replies through the callback req_id, and after that window aibot_send_msg', async (t) => {
  const fake = await fakeWecom()
  const messages = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-9' }, body: { msgid: 'm1', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, text: { content: 'hi' } } })
  await until(() => messages.length === 1)
  await handle.send({ key: 'u1', kind: 'direct' }, { text: 'answer' })
  await until(() => fake.packets.some(packet => packet.cmd === 'aibot_respond_msg'))
  const respond = fake.packets.find(packet => packet.cmd === 'aibot_respond_msg')
  assert.ok(respond, 'responded through the callback')
  assert.equal(respond.headers.req_id, 'req-9')
  assert.equal(respond.body.msgtype, 'markdown')
})

test('a dropped socket reconnects and subscribes again', async (t) => {
  const fake = await fakeWecom()
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  ws.close()
  await until(() => fake.sockets.length === 2)
  await until(() => fake.packets.filter(packet => packet.cmd === 'aibot_subscribe').length === 2)
})
