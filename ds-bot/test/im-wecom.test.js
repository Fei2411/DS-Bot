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

test('a voice message forwards its transcription as the text', async (t) => {
  const fake = await fakeWecom()
  const messages = []
  const handle = wecom.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-voice' }, body: { msgid: 'm-voice', msgtype: 'voice', chattype: 'single', from: { userid: 'u1' }, voice: { content: '发个文件给我' } } })
  const delivered = await until(() => messages.find(msg => msg.messageId === 'm-voice'))
  assert.equal(delivered.text, '发个文件给我')
  assert.equal(delivered.files.length, 0)
})

// A PNG of every 32-byte length residue decrypts to real PNG bytes, and its media
// type comes from the bytes: the callback never says which format it is. Padding
// lengths 17-32 are the ones Node's 16-byte unpad would have refused.
test('a decrypted PNG is declared image/png across every padding length', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const fake = await fakeWecom()
  const messages = []
  // Send every residue on one connection, then check each PNG landed as image/png.
  const pngs = []
  for (let pad = 1; pad <= 32; pad += 1) {
    // Pad length `pad` in 1..32, with the filler making the total a whole number
    // of 32-byte blocks, the way the protocol always is.
    const filler = (32 - ((8 + pad) % 32)) % 32
    const body = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(filler), Buffer.alloc(pad, pad)])
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    cipher.setAutoPadding(false)
    // What arrives is the message without its padding, not the padded buffer.
    pngs.push({ id: `m-png-${pad}`, encrypted: Buffer.concat([cipher.update(body), cipher.final()]), plain: body.subarray(0, body.length - pad) })
  }
  let current
  const mediaEnv = { ...env(fake), fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => current }) }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  for (const png of pngs) {
    current = png.encrypted
    fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: `req-${png.id}` }, body: { msgid: png.id, msgtype: 'image', chattype: 'single', from: { userid: 'u1' }, image: { url: `https://cdn.invalid/${png.id}`, aeskey: key.toString('base64') } } })
    const arrived = await until(() => messages.find(msg => msg.messageId === png.id))
    assert.ok(arrived, `${png.id} arrived`)
    assert.equal(arrived.images.length, 1, `${png.id} kept its image`)
    assert.equal(arrived.images[0].mediaType, 'image/png', `${png.id} declared as PNG`)
    assert.equal(arrived.images[0].data, png.plain.toString('base64'), `${png.id} decrypted intact`)
  }
})

test('a JPEG keeps image/jpeg, and unknown bytes fall back on the name', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const fake = await fakeWecom()
  const messages = []
  const encrypt = (plain) => {
    const pad = 32 - (plain.length % 32)
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()])
  }
  const jpeg = encrypt(Buffer.concat([Buffer.from('ffd8ff', 'hex'), randomBytes(40)]))
  const odd = encrypt(Buffer.from('not an image at all, but named webp', 'utf8'))
  let current = jpeg
  const mediaEnv = {
    ...env(fake),
    fetch: async () => ({
      ok: true,
      headers: { get: name => (name.toLowerCase() === 'content-disposition' && current === odd ? 'attachment; filename="picture.webp"' : null) },
      arrayBuffer: async () => current,
    }),
  }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-j' }, body: { msgid: 'm-jpeg', msgtype: 'image', chattype: 'single', from: { userid: 'u1' }, image: { url: 'https://cdn.invalid/j', aeskey: key.toString('base64') } } })
  const jpg = await until(() => messages.find(msg => msg.messageId === 'm-jpeg'))
  assert.equal(jpg.images[0].mediaType, 'image/jpeg')
  current = odd
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-o' }, body: { msgid: 'm-odd', msgtype: 'image', chattype: 'single', from: { userid: 'u1' }, image: { url: 'https://cdn.invalid/o', aeskey: key.toString('base64') } } })
  const unknown = await until(() => messages.find(msg => msg.messageId === 'm-odd'))
  assert.equal(unknown.images[0].mediaType, 'image/webp')
})

// The cap has to bite before the body is in memory, or it guards nothing. A body
// that reports how much was pulled proves the transfer stops early, and that a
// declared length settles it before any chunk is read at all.
test('an oversized file stops downloading early instead of buffering first', async (t) => {
  // Only the key is used: the body is never decrypted, because it is refused first.
  const { randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const fake = await fakeWecom()
  const messages = []
  const warnings = []

  // 4 MB chunks: the 100 MB cap must be crossed after ~26 of them, not all 200.
  const CHUNK = 4 * 1024 * 1024
  const TOTAL = 200 * CHUNK
  let pulled = 0
  let cancelled = false
  const streamedBody = () => ({
    getReader: () => ({
      read: async () => {
        if (pulled >= TOTAL) return { done: true, value: undefined }
        pulled += CHUNK
        return { done: false, value: new Uint8Array(CHUNK) }
      },
      cancel: async () => { cancelled = true },
    }),
  })

  const mediaEnv = {
    ...env(fake),
    log: { warn: (...args) => warnings.push(args.join(' ')) },
    fetch: async () => ({ ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? null : null) }, body: streamedBody(), arrayBuffer: async () => { throw new Error('the whole body must not be read') } }),
  }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-big' }, body: { msgid: 'm-big', msgtype: 'file', chattype: 'single', from: { userid: 'u1' }, file: { url: 'https://cdn.invalid/big', aeskey: key.toString('base64') } } })
  const delivered = await until(() => messages.find(msg => msg.messageId === 'm-big'))
  assert.ok(delivered, 'the frame still reached onMessage')
  assert.equal(delivered.files.length, 0, 'the oversized file was not attached')
  assert.ok(pulled <= 27 * CHUNK, `stopped near the cap, pulled ${pulled / CHUNK} of ${TOTAL / CHUNK} chunks`)
  assert.ok(cancelled, 'the transfer was cancelled rather than drained')
  assert.ok(warnings.some(w => w.includes('over the')), 'the skip was logged')

  // A declared length larger than the cap decides it before the first read.
  pulled = 0
  mediaEnv.fetch = async () => ({
    ok: true,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(TOTAL) : null) },
    body: streamedBody(),
    arrayBuffer: async () => { throw new Error('the whole body must not be read') },
  })
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-huge' }, body: { msgid: 'm-huge', msgtype: 'video', chattype: 'single', from: { userid: 'u1' }, video: { url: 'https://cdn.invalid/huge', aeskey: key.toString('base64') } } })
  const huge = await until(() => messages.find(msg => msg.messageId === 'm-huge'))
  assert.equal(huge.files.length, 0)
  assert.equal(pulled, 0, 'content-length settled it without reading a byte')
})

test('a body with no stream is still capped after it is read whole', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const fake = await fakeWecom()
  const messages = []
  const over = Buffer.alloc(101 * 1024 * 1024)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const padded = Buffer.alloc(over.length + (32 - (over.length % 32)), 32)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  const mediaEnv = { ...env(fake), fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => encrypted }) }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-nostream' }, body: { msgid: 'm-nostream', msgtype: 'file', chattype: 'single', from: { userid: 'u1' }, file: { url: 'https://cdn.invalid/ns', aeskey: key.toString('base64') } } })
  const delivered = await until(() => messages.find(msg => msg.messageId === 'm-nostream'))
  assert.equal(delivered.files.length, 0, 'the no-stream fallback still refused it')
})

// A mixed message carries its words as items, and they are the instruction: a
// picture without its caption loses the request, and a text-only one would arrive
// empty and be dropped entirely.
test('a mixed message keeps its text items along with its images', async (t) => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(20)])
  const pad = 32 - (png.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(pad, pad)])), cipher.final()])
  const fake = await fakeWecom()
  const messages = []
  const mediaEnv = { ...env(fake), fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => encrypted }) }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])

  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-mix' }, body: { msgid: 'm-mix', msgtype: 'mixed', chattype: 'single', from: { userid: 'u1' }, mixed: { msg_item: [{ msgtype: 'text', text: { content: 'Summarize this chart' } }, { msgtype: 'image', image: { url: 'https://cdn.invalid/i', aeskey: key.toString('base64') } }, { msgtype: 'text', text: { content: 'in two lines' } }] } } })
  const delivered = await until(() => messages.find(msg => msg.messageId === 'm-mix'))
  assert.equal(delivered.text, 'Summarize this chart\nin two lines')
  assert.equal(delivered.images.length, 1)

  // A mixed message of text alone must still arrive rather than be dropped.
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-mixtext' }, body: { msgid: 'm-mixtext', msgtype: 'mixed', chattype: 'single', from: { userid: 'u1' }, mixed: { msg_item: [{ msgtype: 'text', text: { content: 'just words' } }] } } })
  const textOnly = await until(() => messages.find(msg => msg.messageId === 'm-mixtext'))
  assert.equal(textOnly.text, 'just words')
  assert.equal(textOnly.images.length, 0)
})

// A declared oversized length must stop the transfer, not leave it downloading.
test('a declared oversized length cancels the response body', async (t) => {
  const { randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  const fake = await fakeWecom()
  const messages = []
  let cancelled = false
  const mediaEnv = {
    ...env(fake),
    fetch: async () => ({
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(400 * 1024 * 1024) : null) },
      body: { cancel: async () => { cancelled = true }, getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }),
  }
  const handle = wecom.connect(FIELDS, mediaEnv, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { cmd: 'aibot_msg_callback', headers: { req_id: 'req-cxl' }, body: { msgid: 'm-cxl', msgtype: 'file', chattype: 'single', from: { userid: 'u1' }, file: { url: 'https://cdn.invalid/cxl', aeskey: key.toString('base64') } } })
  const delivered = await until(() => messages.find(msg => msg.messageId === 'm-cxl'))
  assert.equal(delivered.files.length, 0)
  assert.ok(cancelled, 'the rejected transfer was cancelled rather than left open')
})
