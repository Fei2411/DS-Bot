import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { WebSocket as WsClient } from 'ws'
import {
  DeviceRegistry,
  HostLink,
  PROTOCOL_VERSION,
  RelayTransport,
  RpcClient,
  SecureTransport,
  createControlFrame,
  deviceIdFor,
  generateKeyPair,
  pairingUri,
  parsePairingUri,
  randomToken,
  type HandshakeHello,
  type HostRequest,
  type KeyPair,
} from '../src/index.ts'
import { startRelayServer } from '../server/server.ts'

const server = await startRelayServer()
after(() => server.close())

type Handler = (method: string, params: unknown, request: HostRequest) => Promise<unknown>

function identity(keys: KeyPair = generateKeyPair()) {
  return { deviceId: deviceIdFor(keys.publicKey), ...keys }
}

async function computer(handle: Handler = async (method, params) => ({ method, params }), onReadyCount?: (count: number) => void) {
  const self = identity()
  const registry = new DeviceRegistry()
  let calls = 0
  const host = new HostLink({
    url: server.url,
    identity: self,
    accessToken: randomToken(),
    name: 'Desk',
    admits: (deviceId, key) => registry.admits(deviceId, key),
    authorize: (deviceId, key, hello) => registry.authorize(deviceId, key, hello),
    handle: (method, params, request) => { calls += 1; return handle(method, params, request) },
    onReadyCount,
    retryMs: [50, 200],
  })
  host.start()
  after(() => host.stop())
  await host.waitOnline()
  return { host, self, registry, calls: () => calls }
}

function phone(host: { deviceId: string; publicKey: string }, hello: HandshakeHello = {}, self = identity(), token = randomToken()) {
  const relay = new RelayTransport(server.url, {
    deviceId: self.deviceId,
    identityKey: self.publicKey,
    accessToken: token,
    targetDeviceId: host.deviceId,
  })
  const secure = new SecureTransport(relay, self, { deviceId: host.deviceId, identityKey: host.publicKey }, { hello, handshakeTimeoutMs: 2_000 })
  const client = new RpcClient(secure, 5_000)
  after(() => client.close())
  return { client, secure, self, token }
}

test('a phone pairs with the QR code, calls the computer, and comes back without the code', async () => {
  const desk = await computer()
  const { code } = desk.registry.openPairing()
  const offer = parsePairingUri(pairingUri({ server: server.url, hostDeviceId: desk.self.deviceId, hostKey: desk.self.publicKey, code, name: 'Desk' }))
  const first = phone({ deviceId: offer.hostDeviceId, publicKey: offer.hostKey }, { pairingCode: offer.code, name: 'Phone' })
  await first.client.connect()
  assert.equal(first.secure.hostHello()?.name, 'Desk')
  assert.deepEqual(await first.client.rpc('bot.call', { endpoint: 'state' }), { method: 'bot.call', params: { endpoint: 'state' } })
  const big = 'z'.repeat(300_000)
  assert.deepEqual(await first.client.rpc('bot.call', { big }), { method: 'bot.call', params: { big } })
  assert.deepEqual(desk.registry.list().map(device => [device.deviceId, device.name]), [[first.self.deviceId, 'Phone']])
  assert.equal(desk.registry.pairingOpen(), false)
  await first.client.close()

  const again = phone(desk.self, {}, first.self, first.token)
  await again.client.connect()
  assert.deepEqual(await again.client.rpc('ping', null), { method: 'ping', params: null })
  assert.equal(desk.calls(), 3)
})

test('an unpaired phone is refused', async () => {
  const desk = await computer()
  await assert.rejects(phone(desk.self).client.connect(), { code: 'NOT_PAIRED' })
  desk.registry.openPairing()
  await assert.rejects(phone(desk.self, { pairingCode: 'wrong' }).client.connect(), { code: 'NOT_PAIRED' })
  await assert.rejects(phone(desk.self).client.connect(), { code: 'NOT_PAIRED' })
  assert.equal(desk.registry.list().length, 0)
  assert.equal(desk.calls(), 0)
})

test('a pairing code works once', async () => {
  const desk = await computer()
  const { code } = desk.registry.openPairing()
  await phone(desk.self, { pairingCode: code }).client.connect()
  await assert.rejects(phone(desk.self, { pairingCode: code }).client.connect(), { code: 'NOT_PAIRED' })
  assert.equal(desk.registry.list().length, 1)
})

test('a phone given the wrong computer key cannot connect', async () => {
  const desk = await computer()
  const { code } = desk.registry.openPairing()
  const fake = { deviceId: desk.self.deviceId, publicKey: generateKeyPair().publicKey }
  await assert.rejects(phone(fake, { pairingCode: code }).client.connect())
  assert.equal(desk.registry.list().length, 0)
  assert.equal(desk.calls(), 0)
})

test('a call in progress is stopped when the phone goes away, and not answered twice', async () => {
  let aborted: Promise<void> | undefined
  const desk = await computer(async (_method, _params, request) => {
    aborted = new Promise(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    await aborted
    return 'late'
  })
  const { code } = desk.registry.openPairing()
  const link = phone(desk.self, { pairingCode: code })
  await link.client.connect()
  const pending = link.client.rpc('bot.call', { endpoint: 'send' })
  while (aborted === undefined) await new Promise(resolve => setTimeout(resolve, 10))
  await link.client.close()
  await assert.rejects(pending, { code: 'CLIENT_CLOSED' })
  await aborted
  assert.equal(desk.calls(), 1)
})

test('a removed phone is cut off and cannot come back', async () => {
  const desk = await computer()
  const { code } = desk.registry.openPairing()
  const link = phone(desk.self, { pairingCode: code })
  await link.client.connect()
  const closed = new Promise<void>(resolve => link.client.onClose(resolve))
  desk.registry.revoke(link.self.deviceId)
  desk.host.disconnect(link.self.deviceId)
  await closed
  await assert.rejects(phone(desk.self, {}, link.self, link.token).client.connect(), { code: 'NOT_PAIRED' })
  desk.registry.openPairing()
  await assert.rejects(phone(desk.self, {}, link.self, link.token).client.connect(), { code: 'NOT_PAIRED' })
})

test('the Server says when the computer is offline', async () => {
  const offline = identity()
  await assert.rejects(phone(offline).client.connect(), { code: 'HOST_OFFLINE' })
})

test('the Server refuses a device id that is not its key, or a second token for one id', async () => {
  const self = identity()
  const token = randomToken()
  assert.equal(await hello({ ...self, deviceId: identity().deviceId }, token), 'AUTH_INVALID')
  assert.equal(await hello(self, token), 'hello.ack')
  assert.equal(await hello(self, randomToken()), 'AUTH_INVALID')
  assert.equal(await hello(self, token), 'hello.ack')
})

test('pairing codes that were changed are refused', () => {
  const desk = identity()
  const uri = pairingUri({ server: 'wss://link.example', hostDeviceId: desk.deviceId, hostKey: desk.publicKey, code: 'abc', name: 'Desk' })
  assert.equal(parsePairingUri(uri).code, 'abc')
  assert.throws(() => parsePairingUri(uri.replace(desk.publicKey, generateKeyPair().publicKey)), /does not match/)
  assert.throws(() => parsePairingUri(uri.replace('wss%3A', 'http%3A')), /invalid Server/)
  assert.throws(() => parsePairingUri('https://example.com/pair?v=1'), /not a DS Bot pairing code/)
})

async function hello(self: { deviceId: string; publicKey: string }, accessToken: string): Promise<string> {
  const ws = new WsClient(server.url)
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify(createControlFrame('hello', {
      role: 'client',
      deviceId: self.deviceId,
      identityKey: self.publicKey,
      accessToken,
      protocols: [PROTOCOL_VERSION],
      capabilities: ['transport.relay'],
    })))
    const reply = JSON.parse(String(await new Promise(resolve => ws.once('message', resolve)))) as { type: string; payload: { code?: string } }
    return reply.type === 'error' ? reply.payload.code ?? 'error' : reply.type
  } finally {
    ws.close()
  }
}

test('the ready count fires when a phone joins and leaves', async () => {
  const counts: number[] = []
  const desk = await computer(async (method, params) => ({ method, params }), count => counts.push(count))
  const { code } = desk.registry.openPairing()
  const offer = parsePairingUri(pairingUri({ server: server.url, hostDeviceId: desk.self.deviceId, hostKey: desk.self.publicKey, code, name: 'Desk' }))
  const link = phone({ deviceId: offer.hostDeviceId, publicKey: offer.hostKey }, { pairingCode: offer.code })
  await link.client.connect()
  assert.deepEqual(counts, [1])
  assert.deepEqual(desk.host.connectedDevices(), [link.self.deviceId])
  await link.client.close()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(counts, [1, 0])
  assert.deepEqual(desk.host.connectedDevices(), [])
})

class FakeSocket {
  readyState = 0
  sent: unknown[] = []
  binaryType = ''
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onclose?: () => void
  send(data: unknown) { this.sent.push(data) }
  close() { this.readyState = 3 }
}

test('events from a stale relay socket are ignored', async () => {
  const opts = { deviceId: 'd-phone', identityKey: 'k', accessToken: 't', targetDeviceId: 'd-host' }
  const first = new FakeSocket()
  const transport = new RelayTransport('ws://unused', { ...opts, handshakeTimeoutMs: 20, createSocket: () => first as unknown as WebSocket })
  // The handshake times out while CONNECTING; the socket may still open later.
  await assert.rejects(transport.connect(), { code: 'SERVER_UNREACHABLE' })
  first.readyState = 1
  assert.doesNotThrow(() => first.onopen?.())
  assert.equal(first.sent.length, 0)

  const sockets: FakeSocket[] = []
  const again = new RelayTransport('ws://unused', { ...opts, handshakeTimeoutMs: 20, createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket } })
  void again.connect().catch(() => {})
  void again.close()
  void again.connect().catch(() => {})
  const [old, current] = sockets
  assert.doesNotThrow(() => old.onclose?.())
  old.readyState = 1
  assert.doesNotThrow(() => old.onopen?.())
  assert.equal(old.sent.length, 0)
  current.readyState = 1
  current.onopen?.()
  assert.equal(current.sent.length, 1)
})

test('a ready connection the Server ends with an error still reports the close', async () => {
  const socket = new FakeSocket()
  const transport = new RelayTransport('ws://unused', { deviceId: 'd-phone', identityKey: 'k', accessToken: 't', targetDeviceId: 'd-host', createSocket: () => socket as unknown as WebSocket })
  const frame = (type: string, payload: unknown) => socket.onmessage?.({ data: JSON.stringify(createControlFrame(type as never, payload)) })
  const ready = transport.connect()
  socket.readyState = 1
  socket.onopen?.()
  frame('hello.ack', { protocol: PROTOCOL_VERSION, capabilities: ['transport.relay'] })
  frame('connect.accepted', { connectionId: 'c-1' })
  await ready
  let closes = 0
  transport.onClose(() => { closes += 1 })
  frame('error', { code: 'HOST_OFFLINE', message: 'gone' })
  socket.onclose?.()
  assert.equal(closes, 1)
  assert.equal(transport.closeReason?.message, 'gone')
})

test('a silent ready socket is probed, then reported once when it stays dead', async () => {
  const sockets: FakeSocket[] = []
  const transport = new RelayTransport('ws://unused', {
    deviceId: 'd-phone', identityKey: 'k', accessToken: 't', targetDeviceId: 'd-host',
    watchdogIntervalMs: 10, watchdogSilenceMs: 30, probeTimeoutMs: 40,
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket },
  })
  const closed = new Promise<Error | undefined>(resolve => transport.onClose(() => resolve(transport.closeReason)))
  void transport.connect().catch(() => {})
  const socket = sockets[0]
  // Become ready the way the real handshake does.
  socket.readyState = 1
  socket.onopen?.()
  ;(transport as unknown as { connectionId?: string }).connectionId = 'conn-1'
  ;(transport as unknown as { finishConnection(): void }).finishConnection()
  await new Promise(r => setTimeout(r, 45))
  assert.equal(socket.sent.length, 2, 'hello then a watchdog ping')
  const reason = await Promise.race([closed, new Promise(r => setTimeout(() => r('timeout'), 400))])
  assert.ok(reason instanceof Error, 'close reported within the probe window')
  assert.equal((reason as Error & { code?: string }).code, 'SERVER_UNREACHABLE')
  socket.onclose?.()
  assert.equal(socket.readyState, 3)
})

test('a pong after the probe keeps the link alive', async () => {
  const sockets: FakeSocket[] = []
  const transport = new RelayTransport('ws://unused', {
    deviceId: 'd-phone', identityKey: 'k', accessToken: 't', targetDeviceId: 'd-host',
    watchdogIntervalMs: 10, watchdogSilenceMs: 30, probeTimeoutMs: 60,
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket },
  })
  let closes = 0
  transport.onClose(() => { closes += 1 })
  void transport.connect().catch(() => {})
  const socket = sockets[0]
  socket.readyState = 1
  socket.onopen?.()
  ;(transport as unknown as { connectionId?: string }).connectionId = 'conn-1'
  ;(transport as unknown as { finishConnection(): void }).finishConnection()
  await new Promise(r => setTimeout(r, 45))
  assert.equal(socket.sent.length, 2)
  socket.onmessage?.({ data: JSON.stringify(createControlFrame('pong', { nonce: 1 })) })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(closes, 0, 'a heard frame after the probe keeps the socket')
  assert.equal(socket.sent.length, 2, 'probe clears after the answer')
  void transport.close()
})

test('probe() sends a ping at once', async () => {
  const sockets: FakeSocket[] = []
  const transport = new RelayTransport('ws://unused', {
    deviceId: 'd-phone', identityKey: 'k', accessToken: 't', targetDeviceId: 'd-host',
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket },
  })
  void transport.connect().catch(() => {})
  const socket = sockets[0]
  socket.readyState = 1
  socket.onopen?.()
  ;(transport as unknown as { connectionId?: string }).connectionId = 'conn-1'
  ;(transport as unknown as { finishConnection(): void }).finishConnection()
  transport.probe()
  assert.equal(socket.sent.length, 2, 'hello then the probed ping')
  transport.probe()
  assert.equal(socket.sent.length, 2, 'no second ping while one is pending')
  void transport.close()
})

test('the computer stops while its socket is still connecting', async () => {
  const self = identity()
  const registry = new DeviceRegistry()
  const host = new HostLink({
    url: 'ws://unused',
    identity: self,
    accessToken: randomToken(),
    name: 'Desk',
    admits: (deviceId, key) => registry.admits(deviceId, key),
    authorize: (deviceId, key, hello) => registry.authorize(deviceId, key, hello),
    handle: async () => null,
    // A socket that never reports its close.
    createSocket: () => new FakeSocket() as unknown as WebSocket,
  })
  host.start()
  await new Promise(resolve => setTimeout(resolve, 10))
  const stopped = await Promise.race([host.stop().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1_000))])
  assert.equal(stopped, true)
})
