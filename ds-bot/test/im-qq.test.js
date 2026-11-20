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
  const media = {}
  const packets = []
  const http = createServer((req, res) => {
    if (req.method === 'GET' && media[req.url] !== undefined) {
      const entry = media[req.url]
      res.writeHead(entry.status ?? 200, entry.headers ?? { 'content-type': 'application/octet-stream' })
      res.end(entry.body ?? Buffer.alloc(0))
      return
    }
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
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers })
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
    calls, replies, media, packets,
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
  assert.ok(await until(() => fake.packets.filter(packet => packet.op === 1).length === 1), 'server heartbeat request gets an op-1 reply')
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
  // The reply is a markdown message; QQ renders it instead of showing the markers.
  assert.equal(posts[0].params.msg_type, 2)
  assert.deepEqual(posts[0].params.markdown, { content: 'one' })
  assert.equal(posts[0].params.msg_id, 'm1')
  assert.equal(posts[0].params.msg_seq, 1)
  assert.equal(posts[1].params.msg_seq, 2)
  // A refusal outside the reply window is a permanent error with the reason.
  fake.replies['/v2/users/u1/messages'] = { error: 304027, message: 'reply time out' }
  await assert.rejects(() => handle.send({ key: 'u1', kind: 'direct' }, { text: 'late' }), error => error.permanent === true && /reply/.test(error.message))
})

test('2xx business refusals reject permanently with the QQ trace id', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: msg => messages.push(msg), onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hi', author: { user_openid: 'u1' } } })
  await until(() => messages.length === 1)
  for (const status of [200, 202]) {
    for (const field of ['err_code', 'code']) {
      await t.test(`${status} with ${field}`, async () => {
        fake.replies['/v2/users/u1/messages'] = {
          status,
          headers: { 'X-Tps-trace-ID': 'header-trace' },
          result: { [field]: 40034005, message: '回复消息msg_id已过期', ...(field === 'err_code' ? { trace_id: 'body-trace' } : {}) },
        }
        await assert.rejects(handle.send({ key: 'u1', kind: 'direct' }, { text: 'late' }), error => {
          assert.equal(error.permanent, true)
          assert.equal(error.bizCode, 40034005)
          assert.match(error.message, /回复消息msg_id已过期/)
          assert.ok(error.message.includes(field === 'err_code' ? 'body-trace' : 'header-trace'))
          return true
        })
      })
    }
  }
})

test('zero business codes and pending audits count as sent', async (t) => {
  const fake = await fakeQq()
  const handle = qq.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  for (const field of ['err_code', 'code']) {
    for (const code of [0, 304023, 304024]) {
      fake.replies['/v2/groups/g1/messages'] = { status: code === 0 ? 200 : 202, result: { [field]: code, id: 'accepted' } }
      assert.deepEqual(await handle.send({ key: 'g1', kind: 'group' }, { text: 'hello' }), { messageId: 'accepted' })
    }
  }
  assert.equal(fake.calls.filter(call => call.path === '/v2/groups/g1/messages').length, 6)
})

test('send converts tables and local images before the markdown message', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hi', author: { user_openid: 'u1' } } })
  await until(() => messages.length === 1)
  await handle.send({ key: 'u1', kind: 'direct' }, {
    text: '## 标题\n\n| 项 | 值 |\n| --- | --- |\n| A | 1 |\n\n![图](/tmp/a.png)',
  })
  const post = fake.calls.filter(call => call.path === '/v2/users/u1/messages').at(-1)
  assert.equal(post.params.msg_type, 2)
  assert.equal(post.params.markdown.content, '## 标题\n\n- 项：A；值：1\n\n［图片：图］')
})

test('a platform that refuses markdown gets the same reply as plain text', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hi', author: { user_openid: 'u1' } } })
  await until(() => messages.length === 1)
  fake.replies['/v2/users/u1/messages'] = (params) => (params.msg_type === 2
    ? { result: { err_code: 40034090, message: 'markdown not allowed' } }
    : { result: { id: '930' } })
  await handle.send({ key: 'u1', kind: 'direct' }, { text: '**加粗**与 `代码`' })
  const posts = fake.calls.filter(call => call.path === '/v2/users/u1/messages')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].params.msg_type, 2)
  assert.equal(posts[1].params.msg_type, 0)
  assert.equal(posts[1].params.content, '加粗与 代码')
})

test('a retried reply resends only the chunks QQ did not take', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm1', content: 'hi', author: { user_openid: 'u1' } } })
  await until(() => messages.length === 1)
  let refuse = true
  fake.replies['/v2/users/u1/messages'] = (params) => {
    if (params.markdown.content.startsWith('b') && refuse) {
      refuse = false
      return { error: 22009, message: 'msg limit exceed' }
    }
    return { result: { id: `id-${params.msg_seq}` } }
  }
  // The IM queue keeps the failed job and Try again hands the same one back.
  const job = { text: `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}\n\n${'c'.repeat(1500)}` }
  await assert.rejects(() => handle.send({ key: 'u1', kind: 'direct' }, job))
  const sent = await handle.send({ key: 'u1', kind: 'direct' }, job)
  const posts = fake.calls.filter(call => call.path === '/v2/users/u1/messages').map(call => call.params.markdown.content[0])
  assert.deepEqual(posts, ['a', 'b', 'b', 'c'], 'the delivered first chunk is not posted again')
  assert.equal(sent.messageId, 'id-4')
  // A finished job starts over if it is ever sent again.
  await handle.send({ key: 'u1', kind: 'direct' }, job)
  assert.equal(fake.calls.filter(call => call.path === '/v2/users/u1/messages').length, 7)
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

test('a voice message arrives as the platform ASR text (#1824)', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  // A QQ voice message carries no content: only an attachment with the
  // platform's own transcription.
  fake.push(ws, {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: {
      id: 'm1',
      content: '',
      author: { user_openid: 'u1' },
      attachments: [
        { content_type: 'voice', url: 'https://multimedia.nt.qq.com.cn/x.amr', asr_refer_text: '明天下午三点开会', voice_wav_url: 'https://multimedia.nt.qq.com.cn/x.wav' },
      ],
    },
  })
  await until(() => messages.length === 1)
  assert.equal(messages.length, 1, 'the voice message reached the bot')
  assert.equal(messages[0].text, '明天下午三点开会')
})

test('a voice attachment without ASR text leaves the text empty', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: { id: 'm1', content: '', author: { user_openid: 'u1' }, attachments: [{ content_type: 'voice', url: 'https://x.amr' }] },
  })
  // The event still reaches the handler so the core can answer "no text":
  // dropping it silently is what the bug report is about.
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, '')
})

test('a caption on a voice message wins over the ASR text', async (t) => {
  const fake = await fakeQq()
  const messages = []
  const handle = qq.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: {
      id: 'm1',
      content: '听一下这个',
      author: { user_openid: 'u1' },
      attachments: [{ content_type: 'voice', url: 'https://x.amr', asr_refer_text: '明天下午三点开会' }],
    },
  })
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, '听一下这个')
})

test('C2C and group messages download image and file attachments with magic-byte MIME detection (#1090)', async (t) => {
  const fake = await fakeQq()
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const pdfBytes = Buffer.from('%PDF-1.4\nhello')
  fake.media['/img.bin'] = { headers: { 'content-type': 'image/jpeg' }, body: pngBytes }
  fake.media['/doc.pdf'] = { headers: { 'content-type': 'application/pdf' }, body: pdfBytes }
  fake.media['/huge.png'] = { headers: { 'content-type': 'image/png', 'content-length': String(30 * 1024 * 1024) }, body: pngBytes }
  const messages = []
  const base = env(fake)
  // Map protocol-relative //cdn.qq.test/img.bin onto the local fake HTTP server so we test real // normalization.
  const fetch = (url, ...rest) => base.fetch(String(url).replace('https://cdn.qq.test', fake.api), ...rest)
  const handle = qq.connect(FIELDS, { ...base, fetch }, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: {
      id: 'm-img',
      content: '看看这张图',
      author: { user_openid: 'u1' },
      attachments: [
        { content_type: 'image/jpeg', filename: 'photo.jpg', url: '//cdn.qq.test/img.bin' },
        { content_type: 'image/png', filename: 'huge.png', url: `${fake.api}/huge.png` },
        { content_type: 'application/pdf', filename: 'report.pdf', url: `${fake.api}/doc.pdf` },
      ],
    },
  })
  fake.push(ws, {
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    s: 3,
    d: {
      id: 'm-grp',
      content: '',
      group_openid: 'g1',
      author: { member_openid: 'u2' },
      attachments: [
        { content_type: 'image/png', filename: 'shot.png', url: `${fake.api}/img.bin` },
      ],
    },
  })
  await until(() => messages.length === 2)
  const dm = messages.find(item => item.messageId === 'm-img')
  const grp = messages.find(item => item.messageId === 'm-grp')
  assert.ok(dm && grp)
  assert.equal(dm.text, '看看这张图')
  assert.equal(dm.images.length, 1, 'oversized image skipped, valid PNG kept')
  assert.equal(dm.images[0].mediaType, 'image/png', 'magic bytes override mislabelled image/jpeg')
  assert.equal(dm.images[0].data, pngBytes.toString('base64'))
  assert.equal(dm.files.length, 1)
  assert.equal(dm.files[0].name, 'report.pdf')
  assert.deepEqual(dm.files[0].data, pdfBytes)
  assert.equal(grp.chat.kind, 'group')
  assert.equal(grp.images.length, 1)
  assert.equal(grp.images[0].mediaType, 'image/png')
})

test('QQ degrades unsupported BMP to files, keeps text on 500 download, and preserves same-chat order (#1090)', async (t) => {
  const fake = await fakeQq()
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
  const bmpBytes = Buffer.from([0x42, 0x4d, 0x10, 0x00, 0x00, 0x00])
  fake.media['/slow.png'] = { headers: { 'content-type': 'image/png' }, body: pngBytes }
  fake.media['/old.bmp'] = { headers: { 'content-type': 'image/bmp' }, body: bmpBytes }
  fake.media['/broken.png'] = { status: 500, headers: { 'content-type': 'text/plain' }, body: Buffer.from('err') }
  const base = env(fake)
  const fetch = async (url, init) => {
    if (String(url).endsWith('/slow.png')) await new Promise(resolve => setTimeout(resolve, 60))
    return base.fetch(url, init)
  }
  const messages = []
  const handle = qq.connect(FIELDS, { ...base, fetch }, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, {
    op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
    d: {
      id: 'm1', content: '第一条带图', author: { user_openid: 'u1' },
      attachments: [
        { content_type: 'image/png', filename: 'slow.png', url: `${fake.api}/slow.png` },
        { content_type: 'image/bmp', filename: 'old.bmp', url: `${fake.api}/old.bmp` },
        { content_type: 'image/png', filename: 'broken.png', url: `${fake.api}/broken.png` },
      ],
    },
  })
  fake.push(ws, {
    op: 0, t: 'C2C_MESSAGE_CREATE', s: 3,
    d: { id: 'm2', content: '第二条追问', author: { user_openid: 'u1' } },
  })
  await until(() => messages.length === 2)
  assert.deepEqual(messages.map(m => m.messageId), ['m1', 'm2'], 'slow image still lands before follow-up text in the same chat')
  assert.equal(messages[0].text, '第一条带图')
  assert.equal(messages[0].images.length, 1)
  assert.equal(messages[0].images[0].mediaType, 'image/png')
  assert.equal(messages[0].files.length, 1, 'unsupported BMP degrades to files instead of breaking DSH admission')
  assert.equal(messages[0].files[0].name, 'old.bmp')
})
