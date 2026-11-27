import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createRuntime } from '../index.js'
import { resolveVerifiedPushAddresses } from '../src/host/phone.js'
import {
  RelayTransport,
  RpcClient,
  SecureTransport,
  deviceIdFor,
  generateKeyPair,
  openPushEnvelope,
  parsePairingUri,
  parsePushEnvelope,
  randomToken,
} from '../link.js'
import { startRelayServer } from '../../link/server/server.ts'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const server = await startRelayServer()
after(() => server.close())

function openHost(home, { allowLoopbackHttp = false } = {}) {
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home, github: false })
  if (allowLoopbackHttp) rt.pushAllowLoopbackHttp = true
  const call = async (endpoint, payload) => (await (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json())
  return { ctx, rt, call }
}

async function until(read, check) {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = await read()
    if (check(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

function createPhone(offer, hello, keys = generateKeyPair(), token = randomToken()) {
  const self = { deviceId: deviceIdFor(keys.publicKey), ...keys }
  const relay = new RelayTransport(offer.server, {
    deviceId: self.deviceId,
    identityKey: self.publicKey,
    accessToken: token,
    targetDeviceId: offer.hostDeviceId,
  })
  const secure = new SecureTransport(relay, self, { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }, { hello, handshakeTimeoutMs: 2_000 })
  const client = new RpcClient(secure, 5_000)
  return { client, keys, token, deviceId: self.deviceId }
}

test('resolveVerifiedPushAddresses keeps all public dual-stack records and rejects any private DNS answer', async () => {
  const dual = await resolveVerifiedPushAddresses('ntfy.sh', async () => [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ])
  assert.deepEqual(dual, [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ])

  // Split-horizon / DNS rebinding returning any private IP alongside a public IP must be rejected.
  await assert.rejects(
    resolveVerifiedPushAddresses('rebind.example', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]),
    /non-public/i,
  )
  await assert.rejects(
    resolveVerifiedPushAddresses('v6compat.example', async () => [
      { address: '::127.0.0.1', family: 6 },
    ]),
    /non-public/i,
  )
})

test('offline phone receives host-authenticated E2E sealed UnifiedPush notices and auto-clears on 410 Gone', async (t) => {
  const received = []
  let nextStatus = 201
  const pushServer = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        urgency: req.headers.urgency,
        ttl: req.headers.ttl,
        body: Buffer.concat(chunks),
      })
      res.writeHead(nextStatus).end()
    })
  })
  await new Promise(resolve => pushServer.listen(0, '127.0.0.1', resolve))
  const pushPort = pushServer.address().port
  const endpoint = `http://127.0.0.1:${pushPort}/up-token-1`
  t.after(() => new Promise(resolve => pushServer.close(resolve)))

  const home = mkdtempSync(join(tmpdir(), 'dsb-push-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = openHost(home, { allowLoopbackHttp: true })
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')

  const paired = await desk.call('phone-pair', {})
  const offer = parsePairingUri(paired.value.pairing.uri)
  const link = createPhone(offer, { pairingCode: offer.code, name: 'Android' })
  t.after(() => link.client.close())
  await link.client.connect()

  // Hello advertises push-register capability.
  const hello = await link.client.rpc('bot', { endpoint: 'hello', payload: {} })
  assert.equal(hello.ok, true)
  assert.ok(hello.value.capabilities.includes('push-register'))

  // Unsupported push kind and SSRF endpoints are rejected.
  const badKind = await link.client.rpc('bot', { endpoint: 'push-register', payload: { kind: 'fcm', token: 'tok' } })
  assert.equal(badKind.ok, false)
  assert.equal(badKind.error.code, 'bot/invalid')

  for (const badEndpoint of [
    'http://evil.example/up',
    'https://127.0.0.1/up',
    'https://localhost/up',
    'https://192.168.1.5/up',
    'https://169.254.169.254/latest/meta-data',
    'https://[::127.0.0.1]/up',
    'https://[2002:7f00:0001::]/up',
    'https://[fc00::1]/up',
    'https://printer.local/up',
  ]) {
    const bad = await link.client.rpc('bot', { endpoint: 'push-register', payload: { kind: 'unifiedpush', endpoint: badEndpoint } })
    assert.equal(bad.ok, false, `expected reject for ${badEndpoint}`)
    assert.equal(bad.error.code, 'bot/invalid')
  }

  // Register valid UnifiedPush endpoint, verify push-unregister removes it, then re-register.
  const reg0 = await link.client.rpc('bot', { endpoint: 'push-register', payload: { kind: 'unifiedpush', endpoint } })
  assert.equal(reg0.ok, true)
  assert.deepEqual(reg0.value, { registered: true, kind: 'unifiedpush' })
  const unreg = await link.client.rpc('bot', { endpoint: 'push-unregister', payload: {} })
  assert.equal(unreg.ok, true)
  assert.equal((await desk.call('state', {})).value.phone.phones[0].push, undefined)

  const reg = await link.client.rpc('bot', { endpoint: 'push-register', payload: { kind: 'unifiedpush', endpoint } })
  assert.equal(reg.ok, true)

  // Phone view reports push kind without disclosing the private endpoint URL.
  const view = (await desk.call('state', {})).value.phone
  assert.deepEqual(view.phones[0].push, { kind: 'unifiedpush' })
  assert.equal(JSON.stringify(view).includes('up-token-1'), false)

  // While phone is connected, notices travel over live tunnel, NOT offline push.
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'approval', sessionId: 'm1', text: 'run_shell_command' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(received.length, 0)

  // Disconnect phone; offline notices now trigger authenticated E2E sealed pushes.
  await link.client.close()
  await until(() => desk.call('state', {}), state => state.value.phone.phones[0].connected === false)

  // Inbox items reach the phone as notices (inbox.js → mobile.js); the push path is the same for each.
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'approval', sessionId: 'm1', text: 'write_file' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'secret', sessionId: 'm1', text: 'GITHUB_TOKEN' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'connector', sessionId: 'm1', text: 'Gmail' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'learning', sessionId: 'm1', text: 'skills/deploy/SKILL.md' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'mail', sessionId: 'm1', text: 'Ship notes' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'computer', sessionId: 'm1', text: 'Notes' })
  desk.rt.addNotice({ name: 'Ops', kind: 'paused', roomId: 'r-ops', title: 'Ops', text: '' })
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'message', sessionId: 'm1', text: '很长的回复内容'.repeat(200) })

  await until(() => received.length, count => count >= 8)
  assert.equal(received[0].urgency, 'high')
  assert.equal(received[1].urgency, 'high')
  assert.equal(received[2].urgency, 'high')
  assert.equal(received[3].urgency, 'high')
  assert.equal(received[4].urgency, 'high')
  assert.equal(received[5].urgency, 'high')
  assert.equal(received[6].urgency, 'high')
  assert.equal(received[7].urgency, 'normal')

  const decoded = received.map((req) => {
    assert.equal(req.body.toString('utf8').includes('write_file'), false)
    assert.equal(req.body.toString('utf8').includes('GITHUB_TOKEN'), false)
    assert.equal(req.body.toString('utf8').includes('Gmail'), false)
    const env = parsePushEnvelope(req.body)
    assert.ok(env)
    return openPushEnvelope(link.keys.privateKey, link.keys.publicKey, offer.hostKey, env)
  })
  assert.deepEqual(decoded.map(d => d.payload.notice.kind), ['approval', 'secret', 'connector', 'learning', 'mail', 'computer', 'paused', 'message'])
  assert.equal(decoded[0].payload.notice.text, 'write_file')
  assert.equal(decoded[1].payload.notice.text, 'GITHUB_TOKEN')
  assert.equal(decoded[2].payload.notice.text, 'Gmail')
  assert.equal(decoded[3].payload.notice.text, 'skills/deploy/SKILL.md')
  assert.equal(decoded[4].payload.notice.text, 'Ship notes')
  assert.equal(decoded[5].payload.notice.text, 'Notes')
  assert.equal(decoded[6].payload.notice.roomId, 'r-ops')
  assert.equal(decoded[6].payload.notice.botId, undefined)
  // Long UTF-8 notice text was trimmed safely to stay within push byte budget.
  assert.ok(Buffer.byteLength(decoded[7].payload.notice.text, 'utf8') <= 600)

  // 410 Gone automatically clears the stale push subscription.
  nextStatus = 410
  desk.rt.addNotice({ botId: 'm1', name: 'Chief', kind: 'question', sessionId: 'm1', text: 'Ship v0.4.0?' })
  await until(() => desk.call('state', {}), state => state.value.phone.phones[0].push === undefined)
})

test('browser client cannot register push subscriptions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-push-browser-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = openHost(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')

  const paired = await desk.call('phone-pair', {})
  const offer = parsePairingUri(paired.value.pairing.browserUri)
  const browser = createPhone(offer, { pairingCode: offer.code, name: 'Chrome' })
  t.after(() => browser.client.close())
  await browser.client.connect()

  const refused = await browser.client.rpc('bot', {
    endpoint: 'push-register',
    payload: { kind: 'unifiedpush', endpoint: 'https://ntfy.sh/up-browser' },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/refused')
})
