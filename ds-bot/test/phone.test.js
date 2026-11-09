import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../index.js'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair, parsePairingUri, randomToken } from '../link.js'
import { startRelayServer } from '../../link/server/server.ts'
import { fakeContext } from './fake-ctx.js'
import { DEFAULT_SERVER } from '../src/host/phone.js'

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
