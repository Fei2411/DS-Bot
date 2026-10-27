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

async function computer(handle: Handler = async (method, params) => ({ method, params })) {
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
