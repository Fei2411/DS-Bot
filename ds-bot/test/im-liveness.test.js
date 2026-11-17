import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'
import { test } from 'node:test'
import dingtalk from '../src/host/im/platforms/dingtalk.js'
import feishu, { decodeFrame, encodeFrame } from '../src/host/im/platforms/feishu.js'

const FIELDS = { appId: 'fixture', appSecret: 'fixture', clientId: 'fixture', clientSecret: 'fixture' }
const adapters = { feishu, dingtalk }

function fixture(t, name, { autoOpen = true, constructFailures = 0, pauseHandshake = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const sockets = []
  const statuses = []
  const messages = []
  const calls = []
  let constructors = 0
  let releaseHandshake
  class Socket extends EventTarget {
    readyState = 0
    sent = []
    closed = 0
    constructor(url) {
      super()
      constructors += 1
      if (constructors <= constructFailures) throw new Error('fixture socket unavailable')
      this.url = url
      sockets.push(this)
      if (autoOpen) queueMicrotask(() => this.open())
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    send(data) {
      assert.equal(this.readyState, 1)
      this.sent.push(data)
    }
    close() {
      this.closed += 1
      this.readyState = 2
      // A broken path need not send a close event, even after close() is called.
    }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data })) }
  }
  const environment = {
    WebSocket: Socket, config: {},
    async fetch(url) {
      const path = new URL(url).pathname
      calls.push(path)
      if (path.includes('tenant_access_token')) return Response.json({ tenant_access_token: 'fixture-token', expire: 7200 })
      if (path === '/open-apis/bot/v3/info') return Response.json({ bot: { open_id: 'fixture-bot' } })
      if (path === '/gettoken') return Response.json({ errcode: 0, access_token: 'fixture-token', expires_in: 7200 })
      if (pauseHandshake) await new Promise(resolve => { releaseHandshake = resolve })
      if (name === 'feishu') return Response.json({
        code: 0, data: { URL: 'ws://fixture.invalid/feishu?service_id=100', ClientConfig: { PingInterval: 90 } },
      })
      return Response.json({ endpoint: 'ws://fixture.invalid/dingtalk', ticket: 'fixture' })
    },
    log: { warn() {} },
  }
  const handle = adapters[name].connect(FIELDS, environment, {
    onStatus: status => statuses.push(status),
    onMessage: async message => { messages.push(message) },
    onAction() {},
  })
  t.after(() => handle.stop())
  return {
    handle, sockets, statuses, messages, calls,
    constructors: () => constructors,
    release: () => releaseHandshake?.(),
    async advance(ms) { t.mock.timers.tick(ms); await flush() },
  }
}

const pong = (interval = 90) => encodeFrame({
  method: 0, service: 100, headers: [{ key: 'type', value: 'pong' }],
  payload: Buffer.from(JSON.stringify({ PingInterval: interval })),
})
const pingFrames = socket => socket.sent.map(decodeFrame).filter(frame => frame.method === 0 && frame.headers.some(h => h.key === 'type' && h.value === 'ping'))
const keepalive = () => JSON.stringify({ type: 'SYSTEM', headers: { topic: 'KEEPALIVE' }, data: '' })
const inbound = name => name === 'feishu' ? encodeFrame({
  method: 1, headers: [{ key: 'type', value: 'event' }],
  payload: Buffer.from(JSON.stringify({
    header: { event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: 'fixture-user' } }, message: { chat_type: 'p2p', chat_id: 'fixture-chat', message_type: 'text', content: '{"text":"hello"}' } },
  })),
}) : JSON.stringify({
  type: 'CALLBACK', headers: { messageId: 'fixture-message' },
  data: JSON.stringify({ conversationType: '1', senderStaffId: 'fixture-user', text: { content: 'hello' } }),
})

test('Feishu sends a control ping using the handshake service id and interval', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  const socket = fake.sockets[0]
  assert.equal(pingFrames(socket).length, 1)
  assert.equal(pingFrames(socket)[0].service, 100)
  socket.receive(pong())
  await fake.advance(89_999)
  assert.equal(pingFrames(socket).length, 1)
  await fake.advance(1)
  assert.equal(pingFrames(socket).length, 2)
  assert.equal(fake.sockets.length, 1)
})

test('Feishu accepts pong interval updates without timing out a healthy idle connection', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  const socket = fake.sockets[0]
  socket.receive(pong(120))
  for (let index = 0; index < 8; index += 1) {
    await fake.advance(119_999)
    assert.equal(fake.sockets.length, 1)
    assert.equal(pingFrames(socket).length, index + 1)
    await fake.advance(1)
    assert.equal(pingFrames(socket).length, index + 2)
    socket.receive(pong(120))
  }
  assert.equal(socket.closed, 0)
  assert.equal(fake.statuses.at(-1).state, 'ready')
})

test('Feishu reconnects when its ping receives no frame', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  const first = fake.sockets[0]
  await fake.advance(30_001)
  assert.equal(first.closed, 1)
  assert.ok(fake.statuses.some(status => status.state === 'retrying' && /heartbeat/i.test(status.error)))
  await fake.advance(250)
  assert.equal(fake.sockets.length, 2)
  assert.equal(fake.statuses.at(-1).state, 'ready')
})

test('frequent Feishu pings do not postpone the timeout for a lost reply', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  fake.sockets[0].receive(pong(1))
  await fake.advance(1000)
  await fake.advance(30_001)
  assert.equal(fake.sockets[0].closed, 1)
  await fake.advance(250)
  assert.equal(fake.sockets.length, 2)
})

test('Feishu ignores invalid pong configuration and keeps the negotiated interval', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  const socket = fake.sockets[0]
  for (const payload of ['null', 'not json', '{"PingInterval":0}', '{"PingInterval":-1}', '{"PingInterval":"invalid"}']) {
    socket.receive(encodeFrame({ method: 0, headers: [{ key: 'type', value: 'pong' }], payload: Buffer.from(payload) }))
  }
  await fake.advance(89_999)
  assert.equal(pingFrames(socket).length, 1)
  assert.equal(socket.closed, 0)
  await fake.advance(1)
  assert.equal(pingFrames(socket).length, 2)
})

test('a Feishu event also proves liveness until the next scheduled ping', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  await fake.advance(10_000)
  fake.sockets[0].receive(inbound('feishu'))
  await fake.advance(60_000)
  assert.equal(fake.messages.length, 1)
  assert.equal(fake.sockets.length, 1)
  assert.equal(fake.sockets[0].closed, 0)
})

test('DingTalk reconnects after ten minutes without any inbound frame', async (t) => {
  const fake = fixture(t, 'dingtalk')
  await flush()
  await fake.advance(600_001)
  assert.equal(fake.sockets[0].closed, 1)
  assert.ok(fake.statuses.some(status => status.state === 'retrying' && /no frames|idle|silent/i.test(status.error)))
  await fake.advance(250)
  assert.equal(fake.sockets.length, 2)
})

test('DingTalk SYSTEM frames renew the idle deadline without requiring chat traffic', async (t) => {
  const fake = fixture(t, 'dingtalk')
  await flush()
  for (let index = 0; index < 4; index += 1) {
    await fake.advance(540_000)
    fake.sockets[0].receive(keepalive())
  }
  assert.equal(fake.sockets.length, 1)
  assert.equal(fake.sockets[0].closed, 0)
  assert.equal(fake.statuses.at(-1).state, 'ready')
})

test('DingTalk echoes SYSTEM ping data and headers back to the platform', async (t) => {
  const fake = fixture(t, 'dingtalk')
  await flush()
  const headers = { topic: 'ping', messageId: 'fixture-ping', connectionId: 'fixture-connection' }
  const data = '{"opaque":"fixture"}'
  fake.sockets[0].receive(JSON.stringify({ type: 'SYSTEM', headers, data }))
  const reply = JSON.parse(fake.sockets[0].sent.at(-1))
  assert.equal(reply.code, 200)
  assert.deepEqual(reply.headers, headers)
  assert.equal(reply.data, data)
})

test('DingTalk acknowledges a requested disconnect and reconnects without waiting for close', async (t) => {
  const fake = fixture(t, 'dingtalk')
  await flush()
  const first = fake.sockets[0]
  first.receive(JSON.stringify({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'fixture-disconnect' }, data: '' }))
  assert.equal(JSON.parse(first.sent.at(-1)).headers.messageId, 'fixture-disconnect')
  assert.equal(first.closed, 1)
  await fake.advance(250)
  assert.equal(fake.sockets.length, 2)
})

test('Feishu preserves already acknowledged fragments when a message continues after reconnect', async (t) => {
  const fake = fixture(t, 'feishu')
  await flush()
  const frame = decodeFrame(inbound('feishu'))
  const middle = Math.floor(frame.payload.length / 2)
  const part = seq => encodeFrame({
    ...frame,
    headers: [...frame.headers, { key: 'message_id', value: 'fixture-split' }, { key: 'sum', value: '2' }, { key: 'seq', value: String(seq) }],
    payload: seq === 1 ? frame.payload.subarray(0, middle) : frame.payload.subarray(middle),
  })
  fake.sockets[0].receive(part(1))
  fake.sockets[0].dispatchEvent(new Event('close'))
  await fake.advance(250)
  fake.sockets[1].receive(part(2))
  await flush()
  assert.equal(fake.messages.length, 1)
})

for (const name of Object.keys(adapters)) {
  test(`${name} recovers from error without close and ignores all stale socket events`, async (t) => {
    const fake = fixture(t, name)
    await flush()
    const first = fake.sockets[0]
    first.dispatchEvent(new Event('error'))
    first.dispatchEvent(new Event('close'))
    first.dispatchEvent(new Event('error'))
    assert.equal(first.closed, 1)
    assert.equal(fake.statuses.filter(status => status.state === 'retrying').length, 1)
    await fake.advance(250)
    assert.equal(fake.sockets.length, 2)
    const statusCount = fake.statuses.length
    first.open()
    first.receive(inbound(name))
    first.dispatchEvent(new Event('close'))
    await fake.advance(2_001)
    assert.equal(fake.messages.length, 0)
    assert.equal(fake.statuses.length, statusCount)
    assert.equal(fake.sockets.length, 2)
    fake.sockets[1].receive(inbound(name))
    await flush()
    assert.equal(fake.messages.length, 1)
    assert.equal(fake.messages[0].text, 'hello')
  })

  test(`${name} backs off repeated socket failures even when HTTP handshakes succeed`, async (t) => {
    const fake = fixture(t, name, { constructFailures: 3 })
    await flush()
    assert.equal(fake.constructors(), 1)
    await fake.advance(250)
    assert.equal(fake.constructors(), 2)
    await fake.advance(499)
    assert.equal(fake.constructors(), 2)
    await fake.advance(1)
    assert.equal(fake.constructors(), 3)
    await fake.advance(999)
    assert.equal(fake.constructors(), 3)
    await fake.advance(1)
    assert.equal(fake.constructors(), 4)
    assert.equal(fake.sockets.length, 1)
    assert.equal(fake.statuses.at(-1).state, 'ready')
  })

  test(`${name} retries a socket that never opens`, async (t) => {
    const fake = fixture(t, name, { autoOpen: false })
    await flush()
    await fake.advance(30_001)
    assert.equal(fake.sockets[0].closed, 1)
    assert.ok(fake.statuses.some(status => status.state === 'retrying' && /timed out/i.test(status.error)))
    await fake.advance(250)
    assert.equal(fake.sockets.length, 2)
  })

  test(`${name} cannot open a socket after stop during an HTTP handshake`, async (t) => {
    const fake = fixture(t, name, { pauseHandshake: true })
    await flush()
    fake.handle.stop()
    fake.release()
    await flush()
    assert.equal(fake.sockets.length, 0)
    assert.equal(fake.statuses.some(status => status.state === 'ready'), false)
  })

  test(`${name} stop clears liveness and reconnect timers`, async (t) => {
    const fake = fixture(t, name)
    await flush()
    const socket = fake.sockets[0]
    fake.handle.stop()
    const sent = socket.sent.length
    const statuses = fake.statuses.length
    const requests = fake.calls.length
    socket.open()
    socket.dispatchEvent(new Event('error'))
    socket.dispatchEvent(new Event('close'))
    socket.receive(inbound(name))
    await fake.advance(3_600_000)
    assert.equal(socket.sent.length, sent)
    assert.equal(fake.statuses.length, statuses)
    assert.equal(fake.calls.length, requests)
    assert.equal(fake.sockets.length, 1)
    assert.equal(fake.messages.length, 0)
  })

  test(`${name} stop cancels an already scheduled reconnect`, async (t) => {
    const fake = fixture(t, name)
    await flush()
    fake.sockets[0].dispatchEvent(new Event('close'))
    fake.handle.stop()
    const requests = fake.calls.length
    await fake.advance(60_000)
    assert.equal(fake.calls.length, requests)
    assert.equal(fake.sockets.length, 1)
  })
}
