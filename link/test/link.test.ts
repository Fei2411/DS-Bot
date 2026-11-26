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

test('base64url handles large payloads, sliced subarrays, and non-Buffer fallback identically', () => {
  const backing = Uint8Array.from({ length: 120_000 }, (_, index) => (index * 37) & 0xff)
  const slice = backing.subarray(17, 100_017)
  const nodeEncoded = toBase64Url(slice)
  const nodeDecoded = fromBase64Url(nodeEncoded)
  assert.equal(Object.getPrototypeOf(nodeDecoded), Uint8Array.prototype)
  assert.deepEqual(nodeDecoded, slice)

  const savedBuffer = globalThis.Buffer
  try {
    // Exercise the chunked non-Node fallback path.
    // @ts-expect-error simulate non-Node runtime without Buffer
    globalThis.Buffer = undefined
    const fallbackEncoded = toBase64Url(slice)
    assert.equal(fallbackEncoded, nodeEncoded)
    const fallbackDecoded = fromBase64Url(fallbackEncoded)
    assert.deepEqual(fallbackDecoded, slice)
  } finally {
    globalThis.Buffer = savedBuffer
  }
})

test('secure codec evicts abandoned incomplete fragment assemblies after TTL', () => {
  let clock = 1_000
  const encoder = new SecureMessageCodec()
  const decoder = new SecureMessageCodec({ assemblyTtlMs: 5_000, now: () => clock })
  const payload = Uint8Array.from({ length: 120_000 }, (_, i) => i & 0xff)

  // Fill all 8 in-flight slots with incomplete (first-fragment-only) messages.
  for (let i = 0; i < 8; i += 1) {
    const frames = encoder.encode(payload)
    assert.equal(decoder.decode(frames[0]!), undefined)
  }
  // A 9th concurrent incomplete message fails while the 8 slots are still fresh.
  const overflow = encoder.encode(payload)
  assert.throws(() => decoder.decode(overflow[0]!), /sequence is invalid/)

  // Once TTL elapses, abandoned assemblies are swept and new fragmented messages decode cleanly.
  clock += 5_001
  const fresh = encoder.encode(payload)
  const parts = fresh.map(frame => decoder.decode(frame))
  assert.deepEqual(parts.at(-1), payload)
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

test('fromBase64Url rejects malformed characters/lengths and does not pin Buffer slabs for small keys', () => {
  assert.throws(() => fromBase64Url('!!!invalid!!!'), /Invalid base64url/)
  assert.throws(() => fromBase64Url('a'), /Invalid base64url/)
  assert.throws(() => fromBase64Url('a='), /Invalid base64url/)
  assert.throws(() => fromBase64Url('abcd=='), /Invalid base64url/)
  assert.throws(() => fromBase64Url('ab=c'), /Invalid base64url/)
  const pair = generateKeyPair()
  const raw = fromBase64Url(pair.publicKey)
  assert.equal(raw.byteLength, 32)
  assert.equal(raw.buffer.byteLength, 32, 'small decoded keys must not retain Node 8KB Buffer pool slab')
  assert.equal(toBase64Url(raw), pair.publicKey)
})
