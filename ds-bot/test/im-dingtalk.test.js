import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import dingtalk from '../src/host/im/platforms/dingtalk.js'
import { fakeWsServer } from './fake-ws.js'

// A fake DingTalk: gettoken and the gateway REST on HTTP, the stream socket
// carries SYSTEM pings and CALLBACK frames which must be ACKed.
async function fakeDingtalk() {
  const calls = []
  const packets = []
  const acks = []
  const replies = {}
  const media = {}
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
      calls.push({ method: req.method, path: req.url, params })
      if (req.url.startsWith('/gettoken')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, access_token: 'dt-tok', expires_in: 7200 }))
        return
      }
      if (req.url === '/v1.0/gateway/connections/open') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ endpoint: wss.url.replace('ws://', 'http://').replace(/:\d+$/, ''), ticket: 'tk1', endpoint: `${wss.url}` }))
        return
      }
      if (req.url.startsWith('/webhook/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, processQueryKey: 'q1' }))
        return
      }
      const answer = replies[req.url] ?? { result: { processQueryKey: 'q2' } }
      const resolved = typeof answer === 'function' ? answer(params) : answer
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(resolved.result))
    })
  })
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        packets.push(packet)
        if (packet.code === 200) acks.push(packet.headers?.messageId)
      })
      ws.send(JSON.stringify({ specVersion: '1.0', type: 'SYSTEM', headers: { appType: 'STREAM', clientId: 'cli-1', messageId: 'sys1', time: '1' }, data: 'ping' }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}`,
    webhook: `http://127.0.0.1:${http.address().port}/webhook/s1`,
    calls, packets, acks, replies, media,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api, gateway: fake.api, oapi: fake.api },
  runtime: { get: () => ({}), set: () => {} },
  log: { warn: (...args) => console.error('[im-dingtalk]', ...args) },
})
const FIELDS = { clientId: 'cli-1', clientSecret: 'sec-1' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

const callback = (d, id = 'cb1') => ({ specVersion: '1.0', type: 'CALLBACK', headers: { appType: 'STREAM', clientId: 'cli-1', messageId: id, time: '1' }, data: JSON.stringify(d) })

test('check gets an app token', async () => {
  const fake = await fakeDingtalk()
  const { account } = await dingtalk.check(FIELDS, env(fake))
  assert.equal(account.id, 'cli-1')
  assert.ok(fake.calls.some(call => call.path.startsWith('/gettoken')))
  await fake.close()
})

test('system pings get a pong, a single chat and an @ group message land, every frame is ACKed', async (t) => {
  const fake = await fakeDingtalk()
  const messages = []
  const handle = dingtalk.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/v1.0/gateway/connections/open'))
  // The ping sent on connect gets a pong ACK.
  await until(() => fake.acks.includes('sys1'))
  fake.push(ws, callback({ conversationType: '1', senderStaffId: 'u1', senderNick: 'Fei', text: { content: 'hello' }, msgtype: 'text', msgId: 'm1', sessionWebhook: fake.webhook }, 'cb1'))
  fake.push(ws, callback({ conversationType: '2', conversationId: 'g1', senderStaffId: 'u2', text: { content: 'ping' }, msgtype: 'text', msgId: 'm2', isInAtList: true }, 'cb2'))
  fake.push(ws, callback({ conversationType: '2', conversationId: 'g1', senderStaffId: 'u2', text: { content: 'noise' }, msgtype: 'text', msgId: 'm3', isInAtList: false }, 'cb3'))
  await until(() => messages.length === 3 && fake.acks.length === 4)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[2].mentioned, false)
})

test('send replies through the sessionWebhook when live, else the robot API with msgParam as a JSON string', async (t) => {
  const fake = await fakeDingtalk()
  const messages = []
  const handle = dingtalk.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, callback({ conversationType: '1', senderStaffId: 'u1', text: { content: 'hi' }, msgtype: 'text', msgId: 'm1', sessionWebhook: fake.webhook }, 'cb1'))
  await until(() => messages.length === 1)
  await handle.send({ key: 'u1', kind: 'direct' }, { text: 'answer' })
  assert.ok(fake.calls.some(call => call.path.startsWith('/webhook/')), 'replied through the sessionWebhook')
  // A chat without a webhook goes through batchSend.
  await handle.send({ key: 'u9', kind: 'direct' }, { text: 'push' })
  assert.ok(fake.calls.some(call => call.path === '/v1.0/robot/oToMessages/batchSend'), 'robot batchSend used')
  const post = fake.calls.find(call => call.path === '/v1.0/robot/oToMessages/batchSend')
  assert.equal(post.params.msgKey, 'sampleMarkdown')
  assert.deepEqual(post.params.userIds, ['u9'])
  assert.equal(typeof post.params.msgParam, 'string')
  assert.deepEqual(JSON.parse(post.params.msgParam), { title: 'push', text: 'push' })
  // A group without a sessionWebhook goes through groupMessages/send.
  await handle.send({ key: 'g1', kind: 'group' }, { text: 'group push' })
  const group = fake.calls.find(call => call.path === '/v1.0/robot/groupMessages/send')
  assert.equal(group.params.openConversationId, 'g1')
  assert.equal(group.params.msgKey, 'sampleMarkdown')
  assert.equal(typeof group.params.msgParam, 'string')
  assert.deepEqual(JSON.parse(group.params.msgParam), { title: 'group push', text: 'group push' })
})

test('a dropped socket reconnects', async (t) => {
  const fake = await fakeDingtalk()
  const handle = dingtalk.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  ws.close()
  await until(() => fake.sockets.length === 2)
  assert.ok(fake.calls.filter(call => call.path === '/v1.0/gateway/connections/open').length >= 2)
})

test('a network failure at start is retried until the platform answers (#1119)', async (t) => {
  const fake = await fakeDingtalk()
  const statuses = []
  const base = env(fake)
  let down = true
  const fetch = async (...args) => {
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = dingtalk.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 160)
  assert.ok(fake.calls.some(call => call.path.startsWith('/gettoken')))
  assert.ok(fake.calls.some(call => call.path === '/v1.0/gateway/connections/open'))
  assert.equal(fake.sockets.length, 1)
})

test('a connections/open failure after the token is accepted is retried (#1119)', async (t) => {
  const fake = await fakeDingtalk()
  const statuses = []
  const base = env(fake)
  let down = true
  let opens = 0
  const fetch = async (url, ...rest) => {
    if (String(url).endsWith('/v1.0/gateway/connections/open')) {
      opens += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = dingtalk.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  // The token was accepted first, so this covers the handshake and not a second
  // token failure.
  assert.equal(fake.calls.filter(call => call.path.startsWith('/gettoken')).length, 1)
  assert.equal(fake.sockets.length, 0)
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after the retry')
  assert.equal(opens, 2)
  assert.equal(fake.sockets.length, 1, 'the retry opened one socket, not one per attempt')
})

test('a socket that cannot be built at the handshake is retried (#1119)', async (t) => {
  const fake = await fakeDingtalk()
  const statuses = []
  const base = env(fake)
  let failures = 1
  const WebSocket = function (...args) {
    if (failures > 0) { failures -= 1; throw new TypeError('socket unavailable') }
    return new base.WebSocket(...args)
  }
  const handle = dingtalk.connect(FIELDS, { ...base, WebSocket }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /could not open a socket/)
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after a new socket')
  assert.equal(fake.sockets.length, 1)
})

test('picture, file and richText callbacks download media via robot/messageFiles/download', async (t) => {
  const fake = await fakeDingtalk()
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03])
  const docBytes = Buffer.from('quarterly notes')
  fake.media['/dl/pic1'] = { headers: { 'content-type': 'application/octet-stream' }, body: pngBytes }
  fake.media['/dl/file1'] = { headers: { 'content-type': 'text/plain' }, body: docBytes }
  fake.replies['/v1.0/robot/messageFiles/download'] = (params) => ({
    result: { downloadUrl: `${fake.api}/dl/${params.downloadCode}` },
  })
  const messages = []
  const handle = dingtalk.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.acks.includes('sys1'))
  fake.push(ws, callback({
    conversationType: '1', senderStaffId: 'u1', senderNick: 'Fei', msgtype: 'picture', msgId: 'm-pic',
    content: { downloadCode: 'pic1' }, robotCode: 'bot-code-1',
  }, 'cb-pic'))
  fake.push(ws, callback({
    conversationType: '1', senderStaffId: 'u1', senderNick: 'Fei', msgtype: 'file', msgId: 'm-file',
    content: { downloadCode: 'file1', fileName: 'notes.txt' },
  }, 'cb-file'))
  fake.push(ws, callback({
    conversationType: '2', conversationId: 'g1', senderStaffId: 'u2', senderNick: 'Kai', msgtype: 'richText', msgId: 'm-rich', isInAtList: true,
    content: { richText: [{ text: '看下这张截图' }, { type: 'picture', downloadCode: 'pic1' }] },
  }, 'cb-rich'))
  await until(() => messages.length === 3)
  assert.ok(fake.acks.includes('cb-pic') && fake.acks.includes('cb-file') && fake.acks.includes('cb-rich'))
  const u1Msgs = messages.filter(item => item.chat.key === 'u1')
  assert.deepEqual(u1Msgs.map(item => item.messageId), ['m-pic', 'm-file'], 'same-chat media callbacks preserve order')
  const pic = u1Msgs[0]
  const file = u1Msgs[1]
  const rich = messages.find(item => item.messageId === 'm-rich')
  assert.ok(rich)
  const dlCalls = fake.calls.filter(call => call.path === '/v1.0/robot/messageFiles/download')
  assert.ok(dlCalls.some(call => call.params.downloadCode === 'pic1' && call.params.robotCode === 'bot-code-1'))
  assert.equal(pic.images.length, 1)
  assert.equal(pic.images[0].mediaType, 'image/png')
  assert.equal(pic.images[0].data, pngBytes.toString('base64'))
  assert.equal(file.files.length, 1)
  assert.equal(file.files[0].name, 'notes.txt')
  assert.deepEqual(file.files[0].data, docBytes)
  assert.equal(rich.text, '看下这张截图')
  assert.equal(rich.images.length, 1)
  assert.equal(rich.images[0].mediaType, 'image/png')
})

test('DingTalk degrades unsupported BMP, preserves same-chat order, and stop aborts in-flight download', async (t) => {
  const fake = await fakeDingtalk()
  const bmpBytes = Buffer.from([0x42, 0x4d, 0x10, 0x00, 0x00, 0x00])
  fake.media['/dl/bmp1'] = { headers: { 'content-type': 'image/bmp' }, body: bmpBytes }
  fake.replies['/v1.0/robot/messageFiles/download'] = (params) => ({
    result: { downloadUrl: `${fake.api}/dl/${params.downloadCode}` },
  })
  let holdAbort = false
  const base = env(fake)
  const fetch = async (url, init) => {
    if (String(url).endsWith('/dl/bmp1')) await new Promise(resolve => setTimeout(resolve, 60))
    if (String(url).endsWith('/v1.0/robot/messageFiles/download') && String(init?.body ?? '').includes('hang1')) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          holdAbort = true
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
    return base.fetch(url, init)
  }
  const messages = []
  const handle = dingtalk.connect(FIELDS, { ...base, fetch }, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.acks.includes('sys1'))
  fake.push(ws, callback({
    conversationType: '1', senderStaffId: 'u1', senderNick: 'Fei', msgtype: 'picture', msgId: 'm-bmp',
    content: { downloadCode: 'bmp1' },
  }, 'cb-bmp'))
  fake.push(ws, callback({
    conversationType: '1', senderStaffId: 'u1', senderNick: 'Fei', msgtype: 'text', msgId: 'm-txt',
    text: { content: '帮看这张图' },
  }, 'cb-txt'))
  await until(() => messages.length === 2)
  assert.deepEqual(messages.map(m => m.messageId), ['m-bmp', 'm-txt'])
  assert.equal(messages[0].images.length, 0)
  assert.equal(messages[0].files.length, 1)
  assert.deepEqual(messages[0].files[0].data, bmpBytes)

  // A hung downloadCode lookup is aborted promptly by stop().
  fake.push(ws, callback({
    conversationType: '1', senderStaffId: 'u2', senderNick: 'Kai', msgtype: 'picture', msgId: 'm-hang',
    content: { downloadCode: 'hang1' },
  }, 'cb-hang'))
  await until(() => fake.acks.includes('cb-hang'))
  await new Promise(resolve => setTimeout(resolve, 30))
  handle.stop()
  await until(() => holdAbort)
  assert.equal(holdAbort, true)
})
