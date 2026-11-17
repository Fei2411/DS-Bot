import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../index.js'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair, parsePairingUri, randomToken } from '../link.js'
import { startRelayServer } from '../../link/server/server.ts'
import { fakeContext } from './fake-ctx.js'
import { BROWSER_GATED, DEFAULT_SERVER, install as installPhone } from '../src/host/phone.js'

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

function open(home) {
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home, github: false })
  const call = async (endpoint, payload) => (await (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json())
  return { ctx, call }
}

async function until(read, check) {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = await read()
    if (check(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

function phone(offer, hello, keys = generateKeyPair(), token = randomToken()) {
  const self = { deviceId: deviceIdFor(keys.publicKey), ...keys }
  const relay = new RelayTransport(offer.server, { deviceId: self.deviceId, identityKey: self.publicKey, accessToken: token, targetDeviceId: offer.hostDeviceId })
  const secure = new SecureTransport(relay, self, { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }, { hello, handshakeTimeoutMs: 2_000 })
  const client = new RpcClient(secure, 5_000)
  after(() => client.close())
  return { client, keys, token }
}

test('a phone pairs with the QR code and calls the same endpoints as the window', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-phone-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  let desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const first = await desk.call('state', {})
  assert.deepEqual(first.value.phone, { server: DEFAULT_SERVER, on: false, status: 'off', phones: [], pairing: null })
  assert.equal((await desk.call('phone-set', { server: 'http://relay.test' })).error.code, 'bot/invalid')
  assert.equal((await desk.call('phone-pair', {})).ok, false)

  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'phone.json')).mode & 0o777, 0o600)

  const paired = await desk.call('phone-pair', {})
  const offer = parsePairingUri(paired.value.pairing.uri)
  assert.notEqual(parsePairingUri(paired.value.pairing.browserUri).code, offer.code)
  const link = phone(offer, { pairingCode: offer.code, name: 'Pixel' })
  await link.client.connect()
  const state = await link.client.rpc('bot', { endpoint: 'state', payload: {} })
  assert.equal(state.ok, true)
  assert.deepEqual(state.value.bots.map(bot => bot.name), ['Chief'])
  const refused = await link.client.rpc('bot', { endpoint: 'phone-pair', payload: {} })
  assert.equal(refused.error.code, 'bot/refused')

  const listed = (await desk.call('state', {})).value.phone
  assert.equal(listed.pairing, null)
  assert.deepEqual(listed.phones.map(entry => [entry.name, entry.connected]), [['Pixel', true]])
  assert.equal(listed.phones[0].kind, 'phone')
  await link.client.close()

  // The computer keeps its identity across restarts, so the phone comes back without a code.
  await desk.ctx.dispose()
  desk = open(home)
  await until(() => desk.call('state', {}), next => next.value.phone.status === 'online')
  const again = phone(offer, {}, link.keys, link.token)
  await again.client.connect()
  assert.equal((await again.client.rpc('bot', { endpoint: 'state', payload: {} })).ok, true)

  const closed = new Promise(resolve => again.client.onClose(resolve))
  const removed = await desk.call('phone-remove', { id: listed.phones[0].id })
  assert.deepEqual(removed.value.phones, [])
  await closed
  await assert.rejects(phone(offer, {}, link.keys, link.token).client.connect(), { code: 'NOT_PAIRED' })

  await desk.call('phone-set', { on: false })
  assert.equal((await desk.call('state', {})).value.phone.status, 'off')
})

test('a browser pairs with its own code and is listed by authenticated kind', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-browser-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')
  const paired = await desk.call('phone-pair', {})
  const offer = parsePairingUri(paired.value.pairing.browserUri)
  const link = phone(offer, { pairingCode: offer.code, name: 'iPhone' })
  await link.client.connect()
  const listed = (await desk.call('state', {})).value.phone
  assert.equal(listed.pairing, null)
  assert.equal(listed.phones[0].kind, 'browser')
  assert.equal(listed.phones[0].name, 'iPhone')
  assert.equal((await link.client.rpc('bot', { endpoint: 'state' })).ok, true)
  await link.client.close()
})

test('remote state and live polls never disclose pairing offers, including attached state', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-private-pairing-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')
  for (const kind of ['browser', 'phone']) {
    const paired = await desk.call('phone-pair', {})
    const offer = parsePairingUri(kind === 'browser' ? paired.value.pairing.browserUri : paired.value.pairing.uri)
    const link = phone(offer, { pairingCode: offer.code })
    await link.client.connect()
    const before = (await link.client.rpc('bot', { endpoint: 'state', payload: {} })).value
    const opened = (await desk.call('phone-pair', {})).value.pairing
    const desktop = (await desk.call('state', {})).value
    assert.deepEqual(desktop.phone.pairing, opened)
    for (const uri of [opened.uri, opened.browserUri]) assert.ok(parsePairingUri(uri).code)
    const answers = [
      await link.client.rpc('bot', { endpoint: 'state', payload: {} }),
      await link.client.rpc('bot', { endpoint: 'state', payload: { since: before.revision, live: before.liveKey } }),
      await link.client.rpc('bot', { endpoint: 'update-bot', payload: { id: 'm1', color: kind === 'browser' ? '#112233' : '#334455' }, state: { since: before.revision } }),
    ]
    assert.equal(answers[1].value.unchanged, true)
    assert.equal(answers[2].state.revision, before.revision + 1)
    for (const answer of answers) {
      assert.equal(answer.ok, true)
      const view = answer.state ?? answer.value
      assert.ok(view.phone)
      assert.equal(Object.hasOwn(view.phone, 'pairing'), false)
      for (const uri of [opened.uri, opened.browserUri]) {
        assert.equal(JSON.stringify(answer).includes(uri), false)
        assert.equal(JSON.stringify(answer).includes(parsePairingUri(uri).code), false)
      }
    }
    assert.deepEqual((await desk.call('state', {})).value.phone.pairing, opened)
    await link.client.close()
  }
})

test('the host refuses every gated endpoint for browsers, but still serves phones', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-gated-'))
  const ctx = fakeContext()
  const rt = { home, ctx, state: { revision: 0 }, load: async () => {}, readOnly: () => undefined, feedTap: () => () => {} }
  installPhone(rt)
  const served = []
  rt.phoneServe(async endpoint => { served.push(endpoint); return { ok: true, value: endpoint } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.phoneEndpoint('phone-set', { server: server.url, on: true })
  await until(async () => rt.phoneView(), view => view.status === 'online')
  for (const kind of ['browser', 'phone']) {
    const view = await rt.phoneEndpoint('phone-pair', {})
    const offer = parsePairingUri(kind === 'browser' ? view.pairing.browserUri : view.pairing.uri)
    const link = phone(offer, { pairingCode: offer.code, name: kind === 'browser' ? 'iPhone' : 'Web browser' })
    await link.client.connect()
    for (const endpoint of BROWSER_GATED) {
      const answer = await link.client.rpc('bot', { endpoint })
      if (kind === 'browser') assert.deepEqual(answer, { ok: false, error: { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} } })
      else assert.deepEqual(answer, { ok: true, value: endpoint })
    }
    assert.equal((await link.client.rpc('bot', { endpoint: 'state' })).ok, true)
    await link.client.close()
  }
  assert.deepEqual(served, ['state', ...BROWSER_GATED, 'state'])
})

test('the link strips pairing offers from feed events without changing the desktop payload', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-private-feed-'))
  const ctx = fakeContext()
  let tap
  const rt = { home, ctx, state: { revision: 0 }, load: async () => {}, readOnly: () => undefined, feedTap: listener => { tap = listener; return () => { tap = undefined } } }
  installPhone(rt)
  rt.phoneServe(async () => ({ ok: true, value: null }))
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.phoneEndpoint('phone-set', { server: server.url, on: true })
  await until(async () => rt.phoneView(), view => view.status === 'online')
  for (const kind of ['browser', 'phone']) {
    const paired = await rt.phoneEndpoint('phone-pair', {})
    const offer = parsePairingUri(kind === 'browser' ? paired.pairing.browserUri : paired.pairing.uri)
    const link = phone(offer, { pairingCode: offer.code })
    await link.client.connect()
    await until(async () => tap, callback => typeof callback === 'function')
    const desktop = await rt.phoneEndpoint('phone-pair', {})
    const data = { phone: desktop, nested: [{ phone: desktop }], empty: null }
    const events = []
    const off = link.client.onEvent(event => events.push(event))
    tap('live', data)
    const event = await until(async () => events[0], Boolean)
    off()
    assert.equal(event.event, 'live')
    const { pairing, ...remote } = desktop
    assert.deepEqual(event.data, { phone: remote, nested: [{ phone: remote }], empty: null })
    assert.ok(data.phone.pairing.uri)
    assert.ok(data.phone.pairing.browserUri)
    for (const uri of [pairing.uri, pairing.browserUri]) assert.equal(JSON.stringify(event).includes(parsePairingUri(uri).code), false)
    await link.client.close()
  }
})

test('a phone write that moved the team carries the new state in its reply', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-phone-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  await desk.call('phone-set', { server: server.url, on: true })
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')
  const paired = await desk.call('phone-pair', {})
  const offer = parsePairingUri(paired.value.pairing.uri)
  const link = phone(offer, { pairingCode: offer.code, name: 'Pixel' })
  await link.client.connect()

  const before = (await link.client.rpc('bot', { endpoint: 'state', payload: {} })).value.revision

  // The write reply doubles as the `state` answer the phone would have asked for.
  const written = await link.client.rpc('bot', { endpoint: 'update-bot', payload: { id: 'm1', color: '#112233' }, state: { since: before, avatars: 'ref' } })
  assert.equal(written.ok, true)
  assert.equal(written.state.revision, before + 1)
  assert.equal(written.state.bots.find(bot => bot.id === 'm1').color, '#112233')

  // A read with `state` attached carries none: the revision never moved.
  const read = await link.client.rpc('bot', { endpoint: 'models', payload: {}, state: { since: before } })
  assert.equal(read.ok, true)
  assert.equal(read.state, undefined)

  // A rejected write stays a failure and carries no state.
  const failed = await link.client.rpc('bot', { endpoint: 'update-bot', payload: { id: 'ghost', color: '#112233' }, state: { since: before } })
  assert.equal(failed.ok, false)
  assert.equal(failed.state, undefined)

  await link.client.close()
})

test('a bare Server host means the link path; a dead Server shows why', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-phone-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const desk = open(home)
  t.after(async () => { await desk.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  // Bare host: the link path is implied.
  const bare = server.url.replace(/\/v1\/link$/, '')
  await desk.call('phone-set', { server: bare, on: true })
  assert.equal((await desk.call('state', {})).value.phone.server, server.url)
  await until(() => desk.call('state', {}), state => state.value.phone.status === 'online')

  // An explicit path is kept as typed. The dead Server is a closed local port, so the
  // refusal is immediate wherever the test runs (a public name may hang on DNS or TCP).
  await desk.call('phone-set', { server: 'ws://127.0.0.1:1/some-path' })
  assert.equal((await desk.call('state', {})).value.phone.server, 'ws://127.0.0.1:1/some-path')
  const state = await until(() => desk.call('state', {}), next => next.value.phone.status === 'offline')
  assert.equal(typeof state.value.phone.error, 'string')

  // Turned off and cleared, the address falls back to the DS Bot relay (off, so nothing dials it).
  await desk.call('phone-set', { on: false })
  await desk.call('phone-set', { server: '' })
  assert.equal((await desk.call('state', {})).value.phone.server, DEFAULT_SERVER)
})
