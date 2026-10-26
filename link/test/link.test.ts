import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CONTROL_FRAME_BYTES,
  NoiseIkSession,
  RpcClient,
  SecureMessageCodec,
  SecureTransport,
  createControlFrame,
  createMessage,
  createNoisePrologue,
  decodeControlFrame,
  decodeMessage,
  encodeControlFrame,
  encodeMessage,
  fromBase64Url,
  generateKeyPair,
  identityFingerprint,
  toBase64Url,
  type RpcRequestPayload,
  type SecureHandshakeTransport,
  type TransportStats,
} from '../src/index.ts'

const CONNECTION = 'conn-1'
const HOST = 'host-1'
const PHONE = 'phone-1'

test('base64url round trip and key pair', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes)
  assert.doesNotMatch(toBase64Url(bytes), /[+/=]/)
  const pair = generateKeyPair()
  assert.equal(fromBase64Url(pair.privateKey).byteLength, 32)
  assert.equal(fromBase64Url(pair.publicKey).byteLength, 32)
  assert.deepEqual(generateKeyPair(fromBase64Url(pair.privateKey)), pair)
  assert.match(identityFingerprint(pair.publicKey), /^[0-9A-F]{12}$/)
  assert.throws(() => generateKeyPair(new Uint8Array(31)))
})

test('Noise IK handshake encrypts both ways', () => {
  const { phone, host } = sessions()
  host.readHandshake(phone.writeHandshake())
  phone.readHandshake(host.writeHandshake())
  assert.ok(phone.complete && host.complete)
  const message = new TextEncoder().encode('hello')
  assert.deepEqual(host.decrypt(phone.encrypt(message)), message)
  assert.deepEqual(phone.decrypt(host.encrypt(message)), message)
})

test('Noise rejects a host key that is not the paired key', () => {
  const phoneKeys = generateKeyPair()
  const hostKeys = generateKeyPair()
  const otherKeys = generateKeyPair()
  const prologue = createNoisePrologue(CONNECTION, HOST, PHONE)
  const phone = new NoiseIkSession({ role: 'initiator', localPrivateKey: phoneKeys.privateKey, localPublicKey: phoneKeys.publicKey, remotePublicKey: hostKeys.publicKey, prologue })
  const host = new NoiseIkSession({ role: 'responder', localPrivateKey: hostKeys.privateKey, localPublicKey: hostKeys.publicKey, remotePublicKey: otherKeys.publicKey, prologue })
  assert.throws(() => host.readHandshake(phone.writeHandshake()), { code: 'PEER_IDENTITY_MISMATCH' })
})

test('Noise rejects messages out of order and before the handshake ends', () => {
  const { phone, host } = sessions()
  assert.throws(() => phone.readHandshake(new Uint8Array(48)), { code: 'NOISE_HANDSHAKE_ORDER' })
  assert.throws(() => host.writeHandshake(), { code: 'NOISE_HANDSHAKE_ORDER' })
  assert.throws(() => phone.encrypt(new Uint8Array(1)), { code: 'NOISE_NOT_READY' })
})

test('a different connection id breaks the handshake', () => {
  const { phone, host } = sessions(createNoisePrologue('conn-2', HOST, PHONE))
  assert.throws(() => host.readHandshake(phone.writeHandshake()))
})

test('secure codec splits and joins a large message', () => {
  const codec = new SecureMessageCodec()
  const message = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251)
  const frames = codec.encode(message)
  assert.equal(frames.length, 5)
  const joined = frames.map(frame => codec.decode(frame))
  assert.deepEqual(joined.slice(0, -1), [undefined, undefined, undefined, undefined])
  assert.deepEqual(joined.at(-1), message)
  assert.throws(() => new SecureMessageCodec().decode(frames[1]!))
})

test('control frames enforce size limits', () => {
  const frame = createControlFrame('ping', { pad: 'x'.repeat(MAX_CONTROL_FRAME_BYTES) })
  assert.throws(() => encodeControlFrame(frame), /Control frame exceeds/)
  const small = createControlFrame('ping', {})
  assert.deepEqual(decodeControlFrame(encodeControlFrame(small)), small)
  assert.throws(() => encodeControlFrame(small, { maxControlFrameBytes: 10 }))
  assert.throws(() => decodeControlFrame(JSON.stringify({ ...small, type: 'signal.offer' })))
})

test('RPC call over the secure transport reaches the host and returns', async () => {
  const link = loopback()
  const client = new RpcClient(link.phoneTransport)
  await client.connect()
  assert.deepEqual(await client.rpc('bot', { op: 'state' }), { echo: { op: 'state' } })
  const big = 'y'.repeat(120_000)
  assert.deepEqual(await client.rpc('bot', { big }), { echo: { big } })
  assert.equal(link.hostCalls(), 2)
  await client.close()
})

test('a call that times out is not sent again', async () => {
  const link = loopback({ answer: false })
  const client = new RpcClient(link.phoneTransport, 50)
  await client.connect()
  await assert.rejects(client.rpc('bot', { op: 'send' }), { code: 'RPC_TIMEOUT' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(link.hostCalls(), 1)
  await client.close()
})

test('a host without the paired key cannot finish the handshake', async () => {
  const link = loopback({ hostKeys: generateKeyPair() })
  await assert.rejects(new RpcClient(link.phoneTransport).connect())
  assert.equal(link.hostCalls(), 0)
})

function sessions(hostPrologue = createNoisePrologue(CONNECTION, HOST, PHONE)) {
  const phoneKeys = generateKeyPair()
  const hostKeys = generateKeyPair()
  return {
    phone: new NoiseIkSession({ role: 'initiator', localPrivateKey: phoneKeys.privateKey, localPublicKey: phoneKeys.publicKey, remotePublicKey: hostKeys.publicKey, prologue: createNoisePrologue(CONNECTION, HOST, PHONE) }),
    host: new NoiseIkSession({ role: 'responder', localPrivateKey: hostKeys.privateKey, localPublicKey: hostKeys.publicKey, remotePublicKey: phoneKeys.publicKey, prologue: hostPrologue }),
  }
}

/** A carrier that hands frames straight to an in-test host, like the Relay would. */
function loopback(options: { answer?: boolean; hostKeys?: ReturnType<typeof generateKeyPair> } = {}) {
  const phoneKeys = generateKeyPair()
  const pairedHostKeys = generateKeyPair()
  const hostKeys = options.hostKeys ?? pairedHostKeys
  const host = new NoiseIkSession({ role: 'responder', localPrivateKey: hostKeys.privateKey, localPublicKey: hostKeys.publicKey, remotePublicKey: phoneKeys.publicKey, prologue: createNoisePrologue(CONNECTION, HOST, PHONE) })
  const hostIn = new SecureMessageCodec()
  const hostOut = new SecureMessageCodec()
  const toPhone = new Set<(data: Uint8Array) => void>()
  const handshakeToPhone = new Set<(step: number, data: Uint8Array) => void>()
  let calls = 0

  const carrier: SecureHandshakeTransport = {
    async connect() {},
    async close() {},
    getStats(): TransportStats { return { mode: 'Relay', connected: true, bytesSent: 0, bytesReceived: 0 } },
    connectionInfo: () => ({ connectionId: CONNECTION, localDeviceId: PHONE, remoteDeviceId: HOST }),
    onMessage(cb) { toPhone.add(cb); return () => toPhone.delete(cb) },
    onHandshake(cb) { handshakeToPhone.add(cb); return () => handshakeToPhone.delete(cb) },
    async sendHandshake(step, data) {
      assert.equal(step, 1)
      host.readHandshake(data)
      const reply = host.writeHandshake()
      queueMicrotask(() => { for (const cb of handshakeToPhone) cb(2, reply) })
    },
    async send(data) {
      const plain = hostIn.decode(host.decrypt(data))
      if (plain === undefined) return
      const request = decodeMessage(plain)
      calls += 1
      if (options.answer === false) return
      const params = (request.payload as RpcRequestPayload).params
      const reply = encodeMessage(createMessage('rpc.response', { requestId: request.id, result: { echo: params } }))
      for (const frame of hostOut.encode(reply)) {
        const encrypted = host.encrypt(frame)
        queueMicrotask(() => { for (const cb of toPhone) cb(encrypted) })
      }
    },
  }
  return {
    phoneTransport: new SecureTransport(carrier, { deviceId: PHONE, ...phoneKeys }, { deviceId: HOST, identityKey: pairedHostKeys.publicKey }),
    hostCalls: () => calls,
  }
}
