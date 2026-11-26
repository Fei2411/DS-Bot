import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BaseTransport,
  DeviceRegistry,
  RpcClient,
  deviceIdFor,
  generateKeyPair,
  isPublicIpAddress,
  isUrgentNoticeKind,
  isValidPushEndpoint,
  openPushEnvelope,
  parsePushEnvelope,
  sealPushEnvelope,
  toBase64Url,
} from '../src/index.ts'

test('sealPushEnvelope and openPushEnvelope authenticate host sender and reject forgery/tampering', () => {
  const host = generateKeyPair()
  const forgedHost = generateKeyPair()
  const hostId = deviceIdFor(host.publicKey)
  const phone = generateKeyPair()
  const otherPhone = generateKeyPair()
  const payload = {
    hostName: 'Studio Mac',
    boot: 'boot-1',
    notice: {
      seq: 42,
      kind: 'approval',
      botId: 'bot-1',
      name: 'Chief',
      sessionId: 'sess-1',
      text: 'run_shell_command',
      time: 1794500000000,
    },
  }

  const envelope = sealPushEnvelope(host.privateKey, host.publicKey, phone.publicKey, payload)
  assert.equal(envelope.v, 1)
  assert.equal(envelope.h, hostId)
  assert.equal(envelope.p.includes('Chief'), false)
  assert.equal(envelope.p.includes('Studio'), false)
  assert.equal(envelope.p.includes('run_shell_command'), false)

  const parsed = parsePushEnvelope(new TextEncoder().encode(JSON.stringify(envelope)))
  assert.deepEqual(parsed, envelope)

  const opened = openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, envelope)
  assert.equal(opened.hostDeviceId, hostId)
  assert.deepEqual(opened.payload, payload)

  // Attacker with phone public key and hostDeviceId but NOT host private key cannot forge an envelope.
  const attackerEnvelope = sealPushEnvelope(forgedHost.privateKey, forgedHost.publicKey, phone.publicKey, payload)
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, attackerEnvelope))
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...attackerEnvelope, h: hostId }))

  // Wrong recipient key, swapped host id, or tampered header/ciphertext all fail verification.
  assert.throws(() => openPushEnvelope(otherPhone.privateKey, otherPhone.publicKey, host.publicKey, envelope))
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, h: 'd-forged' }))
  const flippedTail = `${envelope.p.slice(0, -1)}${envelope.p.endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, p: flippedTail }))
  const flippedHead = `${envelope.p.startsWith('A') ? 'B' : 'A'}${envelope.p.slice(1)}`
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, p: flippedHead }))

  // Low-order key, oversized plaintext, and invalid notice sequence numbers are rejected.
  const zeroKey = toBase64Url(new Uint8Array(32))
  assert.throws(() => sealPushEnvelope(host.privateKey, host.publicKey, zeroKey, payload))
  assert.throws(() => sealPushEnvelope(host.privateKey, host.publicKey, phone.publicKey, {
    notice: { ...payload.notice, text: 'x'.repeat(3000) },
  }))
  const badSeqEnvelope = sealPushEnvelope(host.privateKey, host.publicKey, phone.publicKey, {
    notice: { ...payload.notice, seq: -5 },
  })
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, badSeqEnvelope))
  const unsafeSeqEnvelope = sealPushEnvelope(host.privateKey, host.publicKey, phone.publicKey, {
    notice: { ...payload.notice, seq: Number.MAX_SAFE_INTEGER + 10 },
  })
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, unsafeSeqEnvelope))
})

test('push endpoint, RFC 6890 IP, and urgency validators enforce SSRF boundaries', () => {
  assert.equal(isValidPushEndpoint('https://ntfy.sh/up-abc123'), true)
  assert.equal(isValidPushEndpoint('https://1.1.1.1/push'), true)
  assert.equal(isValidPushEndpoint('https://[2606:4700:4700::1111]/push'), true)
  assert.equal(isValidPushEndpoint('http://ntfy.sh/up-abc123'), false)
  assert.equal(isValidPushEndpoint('https://user:pass@ntfy.sh/up'), false)
  assert.equal(isValidPushEndpoint('javascript:alert(1)'), false)

  // Private, loopback, link-local, CGNAT, and RFC 6890 embedded-IPv4/special IPv6 targets must be blocked.
  for (const blocked of [
    'https://localhost/up',
    'https://foo.local/up',
    'https://intranet/up',
    'https://127.0.0.1/up',
    'https://0177.0.0.1/up',
    'https://10.0.0.1/up',
    'https://172.16.5.4/up',
    'https://192.168.1.1/up',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/up',
    'https://[::]/up',
    'https://[::1]/up',
    'https://[::127.0.0.1]/up',
    'https://[::10.0.0.1]/up',
    'https://[2002:7f00:0001::]/up',
    'https://[2001::1]/up',
    'https://[2001:2::1]/up',
    'https://[2001:10::1]/up',
    'https://[2001:20::1]/up',
    'https://[fc00::1]/up',
    'https://[fe80::1]/up',
    'https://[::ffff:127.0.0.1]/up',
    'https://[::ffff:7f00:1]/up',
    'https://[::ffff:192.168.1.10]/up',
    'https://[64:ff9b::10.0.0.1]/up',
    'https://[64:ff9b:1:0a00:1:0:808:808]/up',
    'https://[64:ff9b:1::8.8.8.8]/up',
  ]) {
    assert.equal(isValidPushEndpoint(blocked), false, `expected SSRF reject for ${blocked}`)
  }
  assert.equal(isValidPushEndpoint('https://[64:ff9b::8.8.8.8]/up'), true)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up'), false)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up', { allowLoopbackHttp: true }), true)
  assert.equal(isValidPushEndpoint('http://example.com/up', { allowLoopbackHttp: true }), false)

  assert.equal(isPublicIpAddress('8.8.8.8'), true)
  assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true)
  assert.equal(isPublicIpAddress('64:ff9b::8.8.8.8'), true)
  assert.equal(isPublicIpAddress('64:ff9b::10.0.0.1'), false)
  assert.equal(isPublicIpAddress('64:ff9b:1:0a00:1:0:808:808'), false)
  assert.equal(isPublicIpAddress('64:ff9b:1::8.8.8.8'), false)
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('192.168.0.1'), false)
  assert.equal(isPublicIpAddress('::127.0.0.1'), false)
  assert.equal(isPublicIpAddress('2002:7f00:0001::'), false)
  assert.equal(isPublicIpAddress('2001::1'), false)
  assert.equal(isPublicIpAddress('::ffff:10.0.0.2'), false)
  assert.equal(isPublicIpAddress('fe80::1'), false)

  assert.equal(isUrgentNoticeKind('approval'), true)
  assert.equal(isUrgentNoticeKind('question'), true)
  assert.equal(isUrgentNoticeKind('secret'), true)
  assert.equal(isUrgentNoticeKind('handoff'), true)
  assert.equal(isUrgentNoticeKind('message'), false)
  assert.equal(isUrgentNoticeKind('group'), false)
})

test('DeviceRegistry stores UnifiedPush subscriptions for phones only and drops them on revoke', () => {
  const phone = generateKeyPair()
  const browser = generateKeyPair()
  let saved: unknown[] = []
  const registry = new DeviceRegistry([
    { deviceId: deviceIdFor(phone.publicKey), identityKey: phone.publicKey, name: 'Phone', pairedAt: 1, kind: 'phone' },
    { deviceId: deviceIdFor(browser.publicKey), identityKey: browser.publicKey, name: 'Browser', pairedAt: 2, kind: 'browser' },
  ], devices => { saved = devices })

  assert.equal(registry.setPush(deviceIdFor(browser.publicKey), { kind: 'unifiedpush', endpoint: 'https://ntfy.sh/x', updatedAt: 10 }), false)
  assert.equal(registry.setPush(deviceIdFor(phone.publicKey), { kind: 'unifiedpush', endpoint: 'https://ntfy.sh/x', updatedAt: 10 }), true)
  assert.equal(saved.length, 2)
  assert.equal(registry.list()[0].push?.endpoint, 'https://ntfy.sh/x')

  assert.equal(registry.setPush(deviceIdFor(phone.publicKey), undefined), true)
  assert.equal(registry.list()[0].push, undefined)

  assert.equal(registry.setPush(deviceIdFor(phone.publicKey), { kind: 'unifiedpush', endpoint: 'https://ntfy.sh/y', updatedAt: 20 }), true)
  assert.equal(registry.revoke(deviceIdFor(phone.publicKey)), true)
  assert.equal(registry.list().length, 1)
})

test('RpcClient.onClose immediately notifies handlers registered after the transport already closed', async () => {
  class FakeTransport extends BaseTransport {
    private connected = false
    async connect(): Promise<void> { this.connected = true }
    async send(): Promise<void> {}
    async close(): Promise<void> { this.connected = false; this.emitClose() }
    getStats() { return { mode: 'Disconnected' as const, connected: this.connected, bytesSent: 0, bytesReceived: 0 } }
    dropNow() { this.connected = false; this.emitClose() }
  }
  const transport = new FakeTransport()
  const client = new RpcClient(transport)
  await client.connect()
  transport.dropNow()

  // Registering onClose AFTER transport already closed must still fire via microtask.
  let lateFired = 0
  client.onClose(() => { lateFired += 1 })
  // Unsubscribing synchronously before microtask runs must suppress delivery.
  let unsubscribedFired = 0
  const off = client.onClose(() => { unsubscribedFired += 1 })
  off()

  await new Promise<void>(resolve => queueMicrotask(resolve))
  assert.equal(lateFired, 1)
  assert.equal(unsubscribedFired, 0)
})
