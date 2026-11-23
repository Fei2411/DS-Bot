import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import {
  DeviceRegistry,
  HostLink,
  deviceIdFor,
  generateKeyPair,
  isUrgentNoticeKind,
  isValidPushEndpoint,
  isValidPushToken,
  openPushEnvelope,
  parsePushEnvelope,
  randomToken,
  sealPushEnvelope,
} from '../src/index.ts'
import { createFcmForwarder } from '../server/push.ts'
import { startRelayServer } from '../server/server.ts'

test('sealPushEnvelope and openPushEnvelope encrypt end-to-end and reject tampering', () => {
  const host = generateKeyPair()
  const hostId = deviceIdFor(host.publicKey)
  const phone = generateKeyPair()
  const otherPhone = generateKeyPair()
  const payload = {
    hostName: 'Studio Mac',
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

  const envelope = sealPushEnvelope(phone.publicKey, hostId, payload)
  assert.equal(envelope.v, 1)
  assert.equal(envelope.h, hostId)
  // Ciphertext must not leak plaintext metadata.
  assert.equal(envelope.p.includes('Chief'), false)
  assert.equal(envelope.p.includes('Studio'), false)
  assert.equal(envelope.p.includes('run_shell_command'), false)

  const parsed = parsePushEnvelope(new TextEncoder().encode(JSON.stringify(envelope)))
  assert.deepEqual(parsed, envelope)

  const opened = openPushEnvelope(phone.privateKey, phone.publicKey, envelope)
  assert.equal(opened.hostDeviceId, hostId)
  assert.deepEqual(opened.payload, payload)

  // Wrong recipient key fails AEAD authentication.
  assert.throws(() => openPushEnvelope(otherPhone.privateKey, otherPhone.publicKey, envelope))
  // Swapped hostDeviceId fails AAD / HKDF verification.
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, { ...envelope, h: 'd-forged' }))
  // Bit flip in ciphertext fails AEAD verification.
  const flipped = `${envelope.p.slice(0, -1)}${envelope.p.endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => openPushEnvelope(phone.privateKey, phone.publicKey, { ...envelope, p: flipped }))
})

test('push endpoint, token, and urgency validators enforce boundaries', () => {
  assert.equal(isValidPushEndpoint('https://ntfy.sh/up-abc123'), true)
  assert.equal(isValidPushEndpoint('http://ntfy.sh/up-abc123'), false)
  assert.equal(isValidPushEndpoint('https://user:pass@ntfy.sh/up'), false)
  assert.equal(isValidPushEndpoint('javascript:alert(1)'), false)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up'), false)
  assert.equal(isValidPushEndpoint('http://127.0.0.1:9999/up', { allowLoopbackHttp: true }), true)
  assert.equal(isValidPushEndpoint('http://example.com/up', { allowLoopbackHttp: true }), false)

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

test('Relay Server negotiates push.fcm, forwards sealed pushes, enforces limits, and reports gone tokens', async () => {
  const received: unknown[] = []
  let nextResult: { ok: boolean; gone?: boolean; code?: string } = { ok: true }
  const relay = await startRelayServer({
    maxPushesPerHour: 2,
    pushForwarder: async (request) => {
      received.push(request)
      return nextResult
    },
  })
  const hostKeys = generateKeyPair()
  const hostId = deviceIdFor(hostKeys.publicKey)
  const phoneKeys = generateKeyPair()
  const phoneId = deviceIdFor(phoneKeys.publicKey)
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
    assert.ok(host.capabilities().includes('push.fcm'))
    const envelope = sealPushEnvelope(phoneKeys.publicKey, hostId, {
      notice: { seq: 1, kind: 'question', botId: 'b1', name: 'Chief', text: 'Proceed?', time: 1 },
    })

    const first = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'high', envelope })
    assert.deepEqual(first, { ok: true })
    assert.equal(received.length, 1)

    nextResult = { ok: false, gone: true, code: 'UNREGISTERED' }
    const second = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'normal', envelope })
    assert.deepEqual(second, { ok: false, gone: true, code: 'UNREGISTERED' })

    const third = await host.sendPush({ targetDeviceId: phoneId, kind: 'fcm', token: 'tok-1', urgency: 'normal', envelope })
    assert.deepEqual(third, { ok: false, code: 'RATE_LIMITED' })
  } finally {
    await host.stop()
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
    const envelope = sealPushEnvelope(phoneKeys.publicKey, hostId, {
      notice: { seq: 1, kind: 'message', botId: 'b1', name: 'Chief', text: 'Done', time: 1 },
    })
    const res = await host.sendPush({ targetDeviceId: deviceIdFor(phoneKeys.publicKey), kind: 'fcm', token: 'tok', urgency: 'normal', envelope })
    assert.deepEqual(res, { ok: false, code: 'UNSUPPORTED' })
  } finally {
    await host.stop()
    await relay.close()
  }
})

test('createFcmForwarder exchanges signed JWT, caches token, sends data-only payload, and detects UNREGISTERED', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  let authCalls = 0
  let sendCalls = 0
  const sentBodies: unknown[] = []
  let sendStatus = 200
  let sendBody = '{}'
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
        return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), { status: 200 })
      }
      sendCalls += 1
      assert.equal(target, 'https://fcm.googleapis.com/v1/projects/demo-proj/messages:send')
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer access-1')
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(sendBody, { status: sendStatus })
    },
  })

  const ok = await forward({
    requestId: 'r1',
    targetDeviceId: 'd-phone',
    kind: 'fcm',
    token: 'fcm-tok',
    urgency: 'high',
    envelope: { v: 1, h: 'd-host', p: 'sealed-bytes' },
  })
  assert.deepEqual(ok, { ok: true })
  assert.equal(authCalls, 1)
  assert.equal(sendCalls, 1)
  assert.deepEqual(sentBodies[0], {
    message: {
      token: 'fcm-tok',
      data: { v: '1', h: 'd-host', p: 'sealed-bytes' },
      android: { priority: 'HIGH', ttl: '86400s' },
    },
  })

  sendStatus = 404
  sendBody = JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
  const gone = await forward({
    requestId: 'r2',
    targetDeviceId: 'd-phone',
    kind: 'fcm',
    token: 'fcm-tok',
    urgency: 'normal',
    envelope: { v: 1, h: 'd-host', p: 'sealed-bytes' },
  })
  assert.deepEqual(gone, { ok: false, gone: true, code: 'UNREGISTERED' })
  // OAuth token was cached and reused across both FCM sends.
  assert.equal(authCalls, 1)
  assert.equal(sendCalls, 2)
})
