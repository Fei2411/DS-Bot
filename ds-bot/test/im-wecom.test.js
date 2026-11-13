import assert from 'node:assert/strict'
import { test } from 'node:test'
import wecom from '../src/host/im/platforms/wecom.js'
import { fakeWsServer } from './fake-ws.js'

// A fake WeCom stream: aibot_subscribe gets an errcode 0 reply, callbacks get
// pushed frames, aibot_send_msg answers through pending req_ids. Like the real
// gateway it only takes the root path and matches Connection / Upgrade in their
// exact case, so a lowercase handshake gets a 404.
async function fakeWecom({ rejectStatus, subscribeReply } = {}) {
  const packets = []
  const upgrades = []
  const wss = await fakeWsServer({
    checkUpgrade(req) {
      const pairs = []
      for (let at = 0; at < req.rawHeaders.length; at += 2) pairs.push([req.rawHeaders[at], req.rawHeaders[at + 1]])
      const header = name => pairs.filter(([key]) => key === name).map(([, value]) => value).join(',')
      upgrades.push({ url: req.url, header })
      // The real gateway answers 403 outside the root path.
      if (req.url !== '/') return 403
      if (rejectStatus !== undefined) return rejectStatus
      return header('Connection') === 'Upgrade' && header('Upgrade') === 'websocket' ? undefined : 404
    },
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        packets.push(packet)
        if (packet.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, ...(subscribeReply ?? { errcode: 0, errmsg: 'ok' }) }))
        }
        if (packet.cmd === 'aibot_send_msg') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 0, errmsg: 'ok', body: { msgid: 'w1' } }))
        }
      })
    },
  })
  return {
    url: wss.url,
    upgrades,
    packets,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => wss.close(),
  }
}

const env = (fake) => ({
  fetch: globalThis.fetch,
  config: { gateway: fake.url },
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

test('check opens the gateway root with one standard upgrade handshake', async () => {
  const fake = await fakeWecom()
  const { account } = await wecom.check(FIELDS, env(fake))
  assert.deepEqual(account, { id: 'bot-1', name: 'bot-1' })
  assert.equal(fake.upgrades.length, 1)
  assert.equal(fake.upgrades[0].url, '/')
  assert.equal(fake.upgrades[0].header('Connection'), 'Upgrade')
  assert.equal(fake.upgrades[0].header('Upgrade'), 'websocket')
  assert.ok(fake.packets.some(packet => packet.cmd === 'aibot_subscribe' && packet.body.secret === 'sec-1'))
  await fake.close()
})

test('check reports the gateway status when the handshake is refused', async () => {
  const fake = await fakeWecom({ rejectStatus: 403 })
  await assert.rejects(() => wecom.check(FIELDS, env(fake)), /403/)
  await fake.close()
})

test('check reports the business reason when the subscription is refused', async () => {
  const fake = await fakeWecom({ subscribeReply: { errcode: 60111, errmsg: 'invalid bot' } })
  await assert.rejects(() => wecom.check(FIELDS, env(fake)), /invalid bot/)
  await fake.close()
})

test('connect opens the gateway root with one standard upgrade handshake and goes ready', async (t) => {
  const fake = await fakeWecom()
  const statuses = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'ready'))
  assert.equal(fake.upgrades.length, 1)
  assert.equal(fake.upgrades[0].url, '/')
  assert.equal(fake.upgrades[0].header('Connection'), 'Upgrade')
  assert.equal(fake.upgrades[0].header('Upgrade'), 'websocket')
  const subscribe = fake.packets.find(packet => packet.cmd === 'aibot_subscribe')
  assert.equal(subscribe.body.bot_id, 'bot-1')
  assert.equal(subscribe.body.secret, 'sec-1')
})

test('connect reports the gateway status when the handshake is refused', async (t) => {
  const fake = await fakeWecom({ rejectStatus: 403 })
  const statuses = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error' && /403/.test(status.error)))
})

test('connect reports the business reason when the subscription is refused', async (t) => {
  const fake = await fakeWecom({ subscribeReply: { errcode: 60111, errmsg: 'invalid bot' } })
  const statuses = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error' && status.error === 'invalid bot'))
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

// A file message carries no filename: it arrives on content-disposition, and the
// encrypted body is AES-256-CBC padded to a 32-byte block, not Node's default 16.
test('a file message arrives as bytes with the name from content-disposition', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const plain = Buffer.from('hello 文件内容')
  const pad = 32 - (plain.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()])

  const fake = await fakeWecom()
  const messages = []
  const mediaEnv = {
    ...env(fake),
    fetch: async () => ({
      ok: true,
      headers: { get: name => (name.toLowerCase() === 'content-disposition' ? `attachment; filename*=UTF-8''${encodeURIComponent('季度报告.pdf')}` : null) },
      arrayBuffer: async () => encrypted,
    }),
  }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-f' }, body: { msgid: 'm-f', msgtype: 'file', chattype: 'single', from: { userid: 'u1' }, file: { url: 'https://cdn.invalid/f', aeskey: key.toString('base64') } } })
  const delivered = await until(() => messages.find(msg => msg.files?.length === 1))
  assert.ok(delivered, 'the file reached onMessage')
  assert.equal(delivered.files[0].name, '季度报告.pdf')
  assert.equal(delivered.files[0].data.toString(), plain.toString())
})

test('a video message arrives as a file, and a text message still carries none', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.alloc(32, 1)), cipher.final()])

  const fake = await fakeWecom()
  const messages = []
  const mediaEnv = { ...env(fake), fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => encrypted }) }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-v' }, body: { msgid: 'm-v', msgtype: 'video', chattype: 'single', from: { userid: 'u1' }, video: { url: 'https://cdn.invalid/v', aeskey: key.toString('base64') } } })
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-t' }, body: { msgid: 'm-t', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, text: { content: 'hi' } } })
  await until(() => messages.length === 2)
  // A video has no name to find, so the message id stands in for one. Neither
  // frame waits on the other, so the two are picked by id rather than by order.
  const video = messages.find(msg => msg.messageId === 'm-v')
  const plainText = messages.find(msg => msg.messageId === 'm-t')
  assert.equal(video.files.length, 1)
  assert.equal(video.files[0].name, 'wecom-m-v')
  assert.equal(plainText.files.length, 0)
})
