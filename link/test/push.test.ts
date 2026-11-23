import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import {
  DeviceRegistry,
  HostLink,
  PROTOCOL_VERSION,
  createControlFrame,
  deviceIdFor,
  generateKeyPair,
  isPublicIpAddress,
  isUrgentNoticeKind,
  isValidPushEndpoint,
  isValidPushToken,
  openPushEnvelope,
  parsePushEnvelope,
  randomToken,
  sealPushEnvelope,
  toBase64Url,
} from '../src/index.ts'
import { createFcmForwarder } from '../server/push.ts'
import { startRelayServer } from '../server/server.ts'

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
  // Ciphertext must not leak plaintext metadata.
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

  // Wrong recipient key fails AEAD authentication.
  assert.throws(() => openPushEnvelope(otherPhone.privateKey, otherPhone.publicKey, host.publicKey, envelope))
  // Swapped hostDeviceId fails host identity verification.
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, h: 'd-forged' }))
  // Bit flip in header (version byte) or ciphertext fails AEAD verification.
  const flippedTail = `${envelope.p.slice(0, -1)}${envelope.p.endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, p: flippedTail }))
  const flippedHead = `${envelope.p.startsWith('A') ? 'B' : 'A'}${envelope.p.slice(1)}`
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, host.publicKey, { ...envelope, p: flippedHead }))
  // Low-order / all-zero X25519 key is rejected.
  const zeroKey = toBase64Url(new Uint8Array(32))
  assert.throws(() => sealPushEnvelope(host.privateKey, host.publicKey, zeroKey, payload))
  // Oversized plaintext or invalid notice seq is rejected.
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

test('push endpoint, IP, token, and urgency validators enforce SSRF and format boundaries', () => {
  assert.equal(isValidPushEndpoint('https://ntfy.sh/up-abc123'), true)
  assert.equal(isValidPushEndpoint('https://1.1.1.1/push'), true)
  assert.equal(isValidPushEndpoint('https://[2606:4700:4700::1111]/push'), true)
  assert.equal(isValidPushEndpoint('http://ntfy.sh/up-abc123'), false)
  assert.equal(isValidPushEndpoint('https://user:pass@ntfy.sh/up'), false)
  assert.equal(isValidPushEndpoint('javascript:alert(1)'), false)
  // SSRF targets must be blocked on https://
  assert.equal(isValidPushEndpoint('https://localhost/up'), false)
  assert.equal(isValidPushEndpoint('https://foo.local/up'), false)
  assert.equal(isValidPushEndpoint('https://intranet/up'), false)
  assert.equal(isValidPushEndpoint('https://127.0.0.1/up'), false)
  assert.equal(isValidPushEndpoint('https://10.0.0.1/up'), false)
  assert.equal(isValidPushEndpoint('https://172.16.5.4/up'), false)
  assert.equal(isValidPushEndpoint('https://192.168.1.1/up'), false)
  assert.equal(isValidPushEndpoint('https://169.254.169.254/latest/meta-data'), false)
  assert.equal(isValidPushEndpoint('https://100.64.0.1/up'), false)
  assert.equal(isValidPushEndpoint('https://[::1]/up'), false)
  assert.equal(isValidPushEndpoint('https://[fc00::1]/up'), false)
  assert.equal(isValidPushEndpoint('https://[fe80::1]/up'), false)
  assert.equal(isValidPushEndpoint('https://[::ffff:127.0.0.1]/up'), false)
  assert.equal(isValidPushEndpoint('https://[::ffff:192.168.1.10]/up'), false)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up'), false)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up', { allowLoopbackHttp: true }), true)
  assert.equal(isValidPushEndpoint('http://example.com/up', { allowLoopbackHttp: true }), false)

  assert.equal(isPublicIpAddress('8.8.8.8'), true)
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('192.168.0.1'), false)
  assert.equal(isPublicIpAddress('::ffff:10.0.0.2'), false)
  assert.equal(isPublicIpAddress('fe80::1'), false)
  assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true)

  assert.equal(isValidPushToken('fcm-token_123:ABC'), true)
  assert.equal(isValidPushToken(''), false)
  assert.equal(isValidPushToken('has space'), false)
  assert.equal(isValidPushToken('a'.repeat(600)), false)

  assert.equal(isUrgentNoticeKind('approval'), true)
  assert.equal(isUrgentNoticeKind('question'), true)
  assert.equal(isUrgentNoticeKind('secret'), true)
  assert.equal(isUrgentNoticeKind('handoff'), true)
  assert.equal(isUrgentNoticeKind('message'), false)
  assert.equal(isUrgentNoticeKind('group'), false)
})

test('DeviceRegistry stores push subscriptions for phones only and drops them on revoke', () => {
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

  assert.equal(registry.setPush(deviceIdFor(phone.publicKey), { kind: 'fcm', token: 'tok', updatedAt: 20 }), true)
  assert.equal(registry.revoke(deviceIdFor(phone.publicKey)), true)
  assert.equal(registry.list().length, 1)
})

test('Relay Server negotiates push.fcm, enforces allowlist, role/header validation, and rate limits', async () => {
  const received: unknown[] = []
  let nextResult: { ok: boolean; gone?: boolean; code?: string } = { ok: true }
  const hostKeys = generateKeyPair()
  const hostId = deviceIdFor(hostKeys.publicKey)
  const otherHostKeys = generateKeyPair()
  const otherHostId = deviceIdFor(otherHostKeys.publicKey)
  const phoneKeys = generateKeyPair()
  const phoneId = deviceIdFor(phoneKeys.publicKey)

  const relay = await startRelayServer({
    maxPushesPerHour: 2,
    allowedPushHosts: [hostId],
    pushForwarder: async (request) => {
      received.push(request)
      return nextResult
    },
  })
  const host = new HostLink({
    url: relay.url,
    identity: { deviceId: hostId, ...hostKeys },
    accessToken: randomToken(),
    admits: () => false,
    authorize: () => false,
    handle: async () => null,
  })
  const otherHost = new HostLink({
    url: relay.url,
    identity: { deviceId: otherHostId, ...otherHostKeys },
    accessToken: randomToken(),
    admits: () => false,
    authorize: () => false,
    handle: async () => null,
  })
  try {
    host.start()
    otherHost.start()
    await Promise.all([host.waitOnline(), otherHost.waitOnline()])
    assert.ok(host.capabilities().includes('push.fcm'))
    assert.equal(otherHost.capabilities().includes('push.fcm'), false)

    const envelope = sealPushEnvelope(hostKeys.privateKey, hostKeys.publicKey, phoneKeys.publicKey, {
      notice: { seq: 1, kind: 'question', botId: 'b1', name: 'Chief', text: 'Proceed?', time: 1 },
    })

    // Non-allowlisted host is rejected cleanly.
    const denied = await otherHost.sendPush({
      targetDeviceId: phoneId,
      kind: 'fcm',
      token: 'tok-1',
      urgency: 'high',
      envelope: sealPushEnvelope(otherHostKeys.privateKey, otherHostKeys.publicKey, phoneKeys.publicKey, {
        notice: { seq: 1, kind: 'question', botId: 'b1', name: 'Chief', text: 'No', time: 1 },
      }),
    })
    assert.deepEqual(denied, { ok: false, code: 'UNSUPPORTED' })

    const first = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'high', envelope })
    assert.deepEqual(first, { ok: true })
    assert.equal(received.length, 1)

    nextResult = { ok: false, gone: true, code: 'UNREGISTERED' }
    const second = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'normal', envelope })
    assert.deepEqual(second, { ok: false, gone: true, code: 'UNREGISTERED' })

    const third = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'normal', envelope })
    assert.deepEqual(third, { ok: false, code: 'RATE_LIMITED' })

    // Raw client socket attempting push.notify or host forging envelope.h must be rejected with INVALID_MESSAGE.
    const clientWs = new WebSocket(relay.url)
    await new Promise<void>(resolve => clientWs.once('open', () => resolve()))
    const messages: string[] = []
    clientWs.on('message', raw => messages.push(raw.toString()))
    clientWs.send(JSON.stringify(createControlFrame('hello', {
      role: 'client',
      deviceId: phoneId,
      identityKey: phoneKeys.publicKey,
      accessToken: randomToken(),
      protocols: [PROTOCOL_VERSION],
      capabilities: ['transport.relay'],
    })))
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    clientWs.send(JSON.stringify(createControlFrame('push.notify', {
      requestId: 'r-bad',
      targetDeviceId: phoneId,
      kind: 'fcm',
      token: 'tok-1',
      urgency: 'high',
      envelope: { v: 1, h: phoneId, p: envelope.p },
    })))
    await new Promise<void>(resolve => clientWs.once('close', () => resolve()))
    assert.ok(messages.some(m => m.includes('INVALID_MESSAGE')))
  } finally {
    await host.stop()
    await otherHost.stop()
    await relay.close()
  }
})

test('HostLink.sendPush returns UNSUPPORTED when Relay Server has no push forwarder', async () => {
  const relay = await startRelayServer()
  const hostKeys = generateKeyPair()
  const hostId = deviceIdFor(hostKeys.publicKey)
  const phoneKeys = generateKeyPair()
  const host = new HostLink({
    url: relay.url,
    identity: { deviceId: hostId, ...hostKeys },
    accessToken: randomToken(),
    admits: () => false,
    authorize: () => false,
    handle: async () => null,
  })
  try {
    host.start()
    await host.waitOnline()
    assert.equal(host.capabilities().includes('push.fcm'), false)
    const envelope = sealPushEnvelope(hostKeys.privateKey, hostKeys.publicKey, phoneKeys.publicKey, {
      notice: { seq: 1, kind: 'message', botId: 'b1', name: 'Chief', text: 'Done', time: 1 },
    })
    const res = await host.sendPush({ targetDeviceId: deviceIdFor(phoneKeys.publicKey), kind: 'fcm', token: 'tok', urgency: 'normal', envelope })
    assert.deepEqual(res, { ok: false, code: 'UNSUPPORTED' })
  } finally {
    await host.stop()
    await relay.close()
  }
})

test('createFcmForwarder exchanges signed JWT, refreshes on 401, and distinguishes UNREGISTERED from generic 404', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  let authCalls = 0
  let sendCalls = 0
  const sentBodies: unknown[] = []
  const queue: Array<{ status: number; body: string }> = [
    { status: 200, body: '{}' },
    { status: 401, body: '{"error":{"status":"UNAUTHENTICATED"}}' },
    { status: 200, body: '{}' },
    { status: 404, body: '{"error":{"status":"NOT_FOUND","message":"Project not found"}}' },
    { status: 404, body: JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) },
  ]
  const forward = createFcmForwarder({
    project_id: 'demo-proj',
    client_email: 'push@demo-proj.iam.gserviceaccount.com',
    private_key: pem,
    token_uri: 'https://oauth.test/token',
  }, {
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => {
      const target = String(url)
      if (target === 'https://oauth.test/token') {
        authCalls += 1
        return new Response(JSON.stringify({ access_token: `access-${authCalls}`, expires_in: 3600 }), { status: 200 })
      }
      sendCalls += 1
      assert.equal(target, 'https://fcm.googleapis.com/v1/projects/demo-proj/messages:send')
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')))
      const next = queue.shift() ?? { status: 200, body: '{}' }
      return new Response(next.body, { status: next.status })
    },
  })

  const req = {
    requestId: 'r1',
    targetDeviceId: 'd-phone',
    kind: 'fcm' as const,
    token: 'fcm-tok',
    urgency: 'high' as const,
    envelope: { v: 1 as const, h: 'd-host', p: 'sealed-bytes' },
  }

  const ok = await forward(req)
  assert.deepEqual(ok, { ok: true })
  assert.equal(authCalls, 1)
  assert.deepEqual(sentBodies[0], {
    message: {
      token: 'fcm-tok',
      data: { v: '1', h: 'd-host', p: 'sealed-bytes' },
      android: { priority: 'HIGH', ttl: '86400s' },
    },
  })

  // 401 invalidates cached token and retries once cleanly.
  const recovered = await forward({ ...req, requestId: 'r2' })
  assert.deepEqual(recovered, { ok: true })
  assert.equal(authCalls, 2)
  assert.equal(sendCalls, 3)

  // Bare 404 without UNREGISTERED must NOT wipe the phone token.
  const generic404 = await forward({ ...req, requestId: 'r3' })
  assert.deepEqual(generic404, { ok: false, gone: false, code: 'HTTP_404' })

  // Explicit UNREGISTERED marks token as gone.
  const gone = await forward({ ...req, requestId: 'r4', urgency: 'normal' })
  assert.deepEqual(gone, { ok: false, gone: true, code: 'UNREGISTERED' })
  assert.equal(authCalls, 2)
})
