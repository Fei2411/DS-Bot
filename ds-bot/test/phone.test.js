import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../index.js'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair, parsePairingUri, randomToken } from '../link.js'
import { startRelayServer } from '../../link/server/server.ts'
import { fakeContext } from './fake-ctx.js'
import { BROWSER_ALLOWED, DEFAULT_SERVER, install as installPhone, remoteAccessError } from '../src/host/phone.js'
import { COMPUTER_ONLY_ENDPOINTS, COMPUTER_ONLY_PREFIXES, TEAM_COMPUTER_PREFIX_EXCEPTIONS, TEAM_ENDPOINTS, isClassifiedEndpoint, isComputerOnlyEndpoint, isTeamEndpoint } from '../src/shared/remote-endpoints.js'

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
  ctx.workspaceRegistry = { get: () => undefined, list: () => [] }
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
  assert.equal(offer.device, undefined)
  assert.equal(parsePairingUri(paired.value.pairing.browserUri).device, 'browser')
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
  const view = { type: 'text', let: { pairing: 'ready', phone: { pairing: 'application data' } }, value: '$pairing' }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, views: { m1: { id: 'view-1', callId: 'call-1', callSessionId: 'm1', title: 'Status', view, askedAt: 1 } } }))
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
    assert.ok(Object.hasOwn(desktop, 'api'))
    assert.deepEqual(desktop.phone.pairing, opened)
    for (const uri of [opened.uri, opened.browserUri]) assert.ok(parsePairingUri(uri).code)
    const answers = [
      await link.client.rpc('bot', { endpoint: 'state', payload: {} }),
      await link.client.rpc('bot', { endpoint: 'state', payload: { since: before.revision, live: before.liveKey } }),
      await link.client.rpc('bot', { endpoint: 'update-bot', payload: { id: 'm1', color: kind === 'browser' ? '#112233' : '#334455' }, state: { since: before.revision } }),
    ]
    assert.equal(answers[1].value.unchanged, true)
    assert.equal(answers[2].state.revision, before.revision + 1)
    assert.deepEqual(answers[0].value.views.m1.view, view)
    assert.deepEqual(answers[2].state.views.m1.view, view)
    for (const answer of answers) {
      assert.equal(answer.ok, true)
      const view = answer.state ?? answer.value
      assert.equal(Object.hasOwn(view, 'api'), false)
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

test('the host enforces a default-deny browser allowlist across every channel route, and fails closed on unknown devices', async t => {
  const channelSrc = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const computerSrc = readFileSync(new URL('../src/host/computer/index.js', import.meta.url), 'utf8')
  const workspaceSrc = readFileSync(new URL('../src/host/workspace-panel.js', import.meta.url), 'utf8')
  const engineSrc = readFileSync(new URL('../src/host/engine-settings.js', import.meta.url), 'utf8')
  const pluginsSrc = readFileSync(new URL('../src/host/plugins/index.js', import.meta.url), 'utf8')
  const sessionSrc = readFileSync(new URL('../src/host/session-follow.js', import.meta.url), 'utf8')
  const connectorsSrc = readFileSync(new URL('../src/host/connectors/index.js', import.meta.url), 'utf8')
  const gatedSrc = readFileSync(new URL('../../mobile/src/team/gated.ts', import.meta.url), 'utf8')
  const channelRoutes = new Set([...channelSrc.matchAll(/case\s+'([^']+)':/g)].map(match => match[1]))
  const computerRoutes = [...computerSrc.matchAll(/case\s+'([^']+)':/g)].map(match => `computer-${match[1]}`)
  const workspaceBody = workspaceSrc.slice(workspaceSrc.indexOf('async function workspaceEndpoint'), workspaceSrc.indexOf('async function terminalEndpoint'))
  const terminalBody = workspaceSrc.slice(workspaceSrc.indexOf('async function terminalEndpoint'), workspaceSrc.indexOf('async function terminalDispose'))
  const workspaceRoutes = [...workspaceBody.matchAll(/name === '([^']+)'/g)].map(match => `workspace-${match[1]}`)
  const terminalRoutes = [...terminalBody.matchAll(/name === '([^']+)'/g)].map(match => `terminal-${match[1]}`)
  const engineRoutes = [...engineSrc.matchAll(/case\s+'([^']+)':/g)].map(match => `engine-${match[1]}`)
  const pluginRoutes = [...pluginsSrc.matchAll(/case\s+'([^']+)':/g)].map(match => `plugins-${match[1]}`)
  const sessionRoutes = [...sessionSrc.matchAll(/name !== '([^']+)'/g)].map(match => `session-${match[1]}`)
  const connectorRoutes = [...connectorsSrc.matchAll(/async '([^']+)'\(/g)].map(match => match[1])
  const gatedRoutes = new Set([...gatedSrc.matchAll(/'([^']+)'/g)].map(match => match[1]))
  const allHostRoutes = new Set([...channelRoutes, ...computerRoutes, ...workspaceRoutes, ...terminalRoutes, ...engineRoutes, ...pluginRoutes, ...sessionRoutes, ...connectorRoutes])

  // Every host endpoint is explicitly classified. A new endpoint fails here until a
  // maintainer decides whether it acts on the team or on this computer.
  for (const endpoint of allHostRoutes) {
    assert.equal(isClassifiedEndpoint(endpoint), true, `${endpoint} is not classified in shared/remote-endpoints.js`)
    assert.equal(TEAM_ENDPOINTS.has(endpoint) && COMPUTER_ONLY_ENDPOINTS.has(endpoint), false, `${endpoint} is classified twice`)
  }
  for (const endpoint of TEAM_ENDPOINTS) {
    if (COMPUTER_ONLY_PREFIXES.some(prefix => endpoint.startsWith(prefix))) {
      assert.equal(TEAM_COMPUTER_PREFIX_EXCEPTIONS.has(endpoint), true, `${endpoint} matches a computer-only prefix without being a named exception`)
      assert.equal(isComputerOnlyEndpoint(endpoint), false, `${endpoint} is a named team exception`)
    }
  }
  assert.equal(isComputerOnlyEndpoint('computer-not-an-endpoint'), true, 'an accidental computer-* team entry must still fail closed')
  TEAM_ENDPOINTS.add('computer-not-an-endpoint')
  assert.equal(isComputerOnlyEndpoint('computer-not-an-endpoint'), true, 'computer-* prefix wins over the team set outside named exceptions')
  TEAM_ENDPOINTS.delete('computer-not-an-endpoint')
  for (const endpoint of BROWSER_ALLOWED) assert.equal(isTeamEndpoint(endpoint), true, `browser endpoint ${endpoint} is not a team endpoint`)
  for (const endpoint of TEAM_ENDPOINTS) assert.equal(allHostRoutes.has(endpoint) || endpoint === 'hello' || endpoint === 'notices' || endpoint === 'push-register' || endpoint === 'push-unregister', true, `team endpoint ${endpoint} is not a real host route`)

  // Every allowlisted endpoint must be a real host route and strictly disjoint from GATED.
  for (const endpoint of BROWSER_ALLOWED) {
    assert.equal(channelRoutes.has(endpoint), true, `allowlisted route ${endpoint} missing from channel.js`)
    assert.equal(gatedRoutes.has(endpoint), false, `gated route ${endpoint} must never be in BROWSER_ALLOWED`)
  }
  // High-risk RCE, vault, provider, IM, mail, local-agent, computer-use, and unknown routes must be denied to browsers.
  const mustDenyBrowser = [
    ...gatedRoutes,
    'connector-add', 'connector-remove', 'connector-set', 'connector-import', 'connector-import-scan', 'connector-cancel',
    'secret-encrypt', 'secret-decrypt', 'secret-unlock', 'secret-store',
    'provider-models', 'provider-models-save',
    'im-add', 'im-update', 'im-remove', 'im-pair', 'im-unpair', 'im-chat', 'im-retry', 'im-login-start', 'im-login-wait',
    'local-agents', 'local-agent-models', 'local-agent-refresh', 'local-agent-add', 'local-agent-update', 'local-agent-remove',
    'mail-account-add', 'mail-account-remove', 'mail-rule-set', 'mail-send-answer', 'mail-sign-in-code',
    ...computerRoutes,
    'future-unlisted-endpoint',
  ]
  for (const endpoint of mustDenyBrowser) {
    assert.equal(BROWSER_ALLOWED.has(endpoint), false, `${endpoint} must not be in BROWSER_ALLOWED`)
  }
  // Fail-closed checks when device lookup returns undefined or an unexpected kind.
  assert.deepEqual(remoteAccessError(undefined, 'state'), { code: 'bot/refused', message: 'This device is not paired', details: {} })
  assert.deepEqual(remoteAccessError(undefined, 'connector-add'), { code: 'bot/refused', message: 'This device is not paired', details: {} })
  assert.deepEqual(remoteAccessError({ deviceId: 'x', kind: 'unknown' }, 'connector-add'), { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} })
  assert.deepEqual(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'phone-pair'), { code: 'bot/refused', message: 'Phones are paired and removed on the computer', details: {} })
  assert.deepEqual(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'api-set'), { code: 'bot/refused', message: 'External API settings and tokens are managed on the computer', details: {} })
  assert.deepEqual(remoteAccessError({ deviceId: 'x', kind: 'browser' }, 'api-token-create'), { code: 'bot/refused', message: 'External API settings and tokens are managed on the computer', details: {} })
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'connector-add'), undefined)
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'session-page').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'folder-pick').message, 'Folders are chosen in a window on the computer')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'computer-open-settings').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'computer-shot').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'browser-wait').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'chatgpt-sign-in').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'computer-stop'), undefined)
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'computer-app-answer'), undefined)
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'browser' }, 'computer-app-answer').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'connector-import-scan').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'connector-import').code, 'bot/refused')
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'future-unlisted-endpoint').code, 'bot/refused')
  assert.equal(BROWSER_ALLOWED.has('session-page'), false)
  assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, 'job-list').message, 'Background jobs are available on the computer')
  for (const localOnly of ['job-list', 'job-read', 'job-kill', 'workspace-list', 'workspace-read', 'workspace-changes', 'terminal-open', 'engine-settings-list', 'engine-settings-mutate', 'engine-account-state', 'speech-catalog', 'speech-configure', 'speech-prepare', 'speech-cancel', 'speech-transcribe', 'telemetry-status', 'telemetry-update', 'telemetry-reset-id', 'telemetry-clear-log', 'telemetry-client-error']) {
    assert.equal(remoteAccessError({ deviceId: 'x', kind: 'phone' }, localOnly).code, 'bot/refused')
    assert.equal(remoteAccessError({ deviceId: 'x', kind: 'browser' }, localOnly).code, 'bot/refused')
    assert.equal(BROWSER_ALLOWED.has(localOnly), false)
  }

  const home = mkdtempSync(join(tmpdir(), 'dsb-gated-'))
  const ctx = fakeContext()
  const rt = { home, ctx, state: { revision: 0 }, load: async () => {}, readOnly: () => undefined, feedTap: () => () => {}, agentOf: id => (id === 'agent-s1' ? { id: 'a1' } : undefined) }
  installPhone(rt)
  const served = []
  rt.phoneServe(async endpoint => { served.push(endpoint); return { ok: true, value: endpoint } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.phoneEndpoint('phone-set', { server: server.url, on: true })
  await until(async () => rt.phoneView(), view => view.status === 'online')

  const deniedEndpoints = [...allHostRoutes].filter(endpoint => !endpoint.startsWith('phone-') && !endpoint.startsWith('api-') && !endpoint.startsWith('speech-') && !endpoint.startsWith('telemetry-') && !BROWSER_ALLOWED.has(endpoint))
  deniedEndpoints.push('future-unlisted-endpoint')
  for (const kind of ['browser', 'phone']) {
    const view = await rt.phoneEndpoint('phone-pair', {})
    const offer = parsePairingUri(kind === 'browser' ? view.pairing.browserUri : view.pairing.uri)
    const link = phone(offer, { pairingCode: offer.code, name: kind === 'browser' ? 'iPhone' : 'Web browser' })
    await link.client.connect()
    for (const endpoint of deniedEndpoints) {
      const payload = endpoint === 'connector-add' ? { name: 'pwn', command: 'id', args: [] } : {}
      const answer = await link.client.rpc('bot', { endpoint, payload })
      if (kind === 'browser') {
        const legacyComputerMessage = endpoint.startsWith('phone-') || endpoint.startsWith('session-') || endpoint.startsWith('api-')
        if (!legacyComputerMessage) assert.deepEqual(answer, { ok: false, error: { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} } }, endpoint)
        else assert.equal(answer.ok, false, endpoint)
      } else if (isTeamEndpoint(endpoint)) assert.deepEqual(answer, { ok: true, value: endpoint }, endpoint)
      else assert.equal(answer.ok, false, endpoint)
    }
    // DSH Agent chats are phone-only, and so is their media.
    for (const endpoint of ['image', 'file-download', 'markdown-image']) {
      const answer = await link.client.rpc('bot', { endpoint, payload: { sessionId: 'agent-s1' } })
      if (kind === 'browser') assert.deepEqual(answer, { ok: false, error: { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} } }, endpoint)
      else assert.deepEqual(answer, { ok: true, value: endpoint }, endpoint)
    }
    // Subagent image reads via `parent` are computer-only (prevents paired-browser Classic Agent bypass).
    const subImgAnswer = await link.client.rpc('bot', { endpoint: 'image', payload: { sessionId: 'sub-child-1', parent: 'agent-s1', attachmentId: 'att-1' } })
    assert.equal(subImgAnswer.ok, false)
    assert.equal(subImgAnswer.error.code, 'bot/refused')
    for (const endpoint of ['state', 'send', 'chat', 'secret-cancel', 'connector-request-cancel']) {
      assert.equal((await link.client.rpc('bot', { endpoint })).ok, true, `${kind} should reach ${endpoint}`)
    }
    await link.client.close()
  }
  const browserServed = served.slice(0, 5)
  assert.deepEqual(browserServed, ['state', 'send', 'chat', 'secret-cancel', 'connector-request-cancel'])
})

test('a browser device may stop a Bot background task, as it may stop a chat', () => {
  for (const endpoint of ['stop-chat', 'stop-room-work', 'bot-stop-task']) {
    assert.equal(remoteAccessError({ deviceId: 'x', kind: 'browser' }, endpoint), undefined, endpoint)
  }
})

test('the link strips pairing offers from feed events without changing the desktop payload', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-private-feed-'))
  const ctx = fakeContext()
  let tap
  const rt = { home, ctx, state: { revision: 0 }, load: async () => {}, readOnly: () => undefined, feedTap: listener => { tap = listener; return () => { tap = undefined } } }
  installPhone(rt)
  const application = { pairing: 'user value', phone: { pairing: 'not a phone view' }, view: { let: { pairing: 'ready' } } }
  rt.phoneServe(async () => ({ ok: true, value: application }))
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
    const data = { phone: desktop, views: { m1: application }, empty: null }
    const events = []
    const off = link.client.onEvent(event => events.push(event))
    tap('live', data)
    const event = await until(async () => events[0], Boolean)
    assert.equal(event.event, 'live')
    const { pairing, ...remote } = desktop
    assert.deepEqual(event.data, { ...data, phone: remote })
    assert.ok(data.phone.pairing.uri)
    assert.ok(data.phone.pairing.browserUri)
    for (const uri of [pairing.uri, pairing.browserUri]) assert.equal(JSON.stringify(event).includes(parsePairingUri(uri).code), false)
    // Terminal output and exit events are computer-local only and must never cross the link.
    tap('terminal', { id: 't1', chunk: 'secret-shell-output\n' })
    tap('terminal-exit', { id: 't1', code: 0 })
    tap('message', application)
    const message = await until(async () => events[1], Boolean)
    assert.deepEqual(message, { event: 'message', data: application })
    assert.equal(events.some(e => e.event === 'terminal' || e.event === 'terminal-exit'), false)
    off()
    assert.deepEqual(await link.client.rpc('bot', { endpoint: 'chat' }), { ok: true, value: application })
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

  // Phone link refuses plugins-* and speech-* endpoints and strips `data` from `folders`.
  const pluginDenied = await link.client.rpc('bot', { endpoint: 'plugins-install', payload: { id: 'x' } })
  assert.equal(pluginDenied.ok, false)
  assert.equal(pluginDenied.error.code, 'bot/refused')
  for (const speechEndpoint of ['speech-catalog', 'speech-configure', 'speech-prepare', 'speech-cancel', 'speech-transcribe']) {
    const speechDenied = await link.client.rpc('bot', { endpoint: speechEndpoint, payload: {} })
    assert.equal(speechDenied.ok, false, `${speechEndpoint} must be refused over phone link`)
    assert.equal(speechDenied.error.code, 'bot/refused')
  }
  const localFolders = await desk.call('folders', {})
  assert.equal(typeof localFolders.value.data, 'string')
  const remoteFolders = await link.client.rpc('bot', { endpoint: 'folders', payload: {} })
  assert.equal(remoteFolders.ok, true)
  assert.equal('data' in remoteFolders.value, false, 'paired phone must not see protected data path')

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

test('paired browsers cannot see or answer Classic Agent approvals in state, live events, or approval-answer, while paired phones can', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-browser-approvals-'))
  const ctx = fakeContext()
  let tap
  const botApproval = { id: 'appr-bot', sessionId: 'm1', botId: 'm1', tool: 'write', reason: 'Bot write', answerable: true, alwaysAllow: { kind: 'extra-dir', dirs: ['/tmp/ext'], scope: 'bot' } }
  const agentApproval = { id: 'appr-agent', sessionId: 'agent-s1', tool: 'write', reason: 'Classic write', answerable: true, alwaysAllow: { kind: 'extra-dir', dirs: ['/tmp/ext'], scope: 'bot' } }
  const approvals = [botApproval, agentApproval]
  const answered = []
  const rt = {
    home,
    ctx,
    state: { revision: 1 },
    load: async () => {},
    readOnly: () => undefined,
    feedTap: (listener) => { tap = listener; return () => { tap = undefined } },
    agentOf: id => (id === 'agent-s1' ? { id: 'a1' } : undefined),
    approvalsView: () => approvals,
    approvalById: id => approvals.find(entry => entry.id === id),
  }
  installPhone(rt)
  rt.phoneServe(async (endpoint, payload) => {
    if (endpoint === 'state') return { ok: true, value: { revision: 1, work: { approvals } } }
    if (endpoint === 'approval-answer') {
      answered.push(payload)
      return { ok: true, value: true }
    }
    return { ok: true, value: null }
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.phoneEndpoint('phone-set', { server: server.url, on: true })
  await until(async () => rt.phoneView(), view => view.status === 'online')

  const pair1 = await rt.phoneEndpoint('phone-pair', {})
  const browserLink = phone(parsePairingUri(pair1.pairing.browserUri), { pairingCode: parsePairingUri(pair1.pairing.browserUri).code, name: 'Chrome' })
  await browserLink.client.connect()

  const pair2 = await rt.phoneEndpoint('phone-pair', {})
  const phoneLink = phone(parsePairingUri(pair2.pairing.uri), { pairingCode: parsePairingUri(pair2.pairing.uri).code, name: 'Pixel' })
  await phoneLink.client.connect()

  await until(async () => tap, callback => typeof callback === 'function')

  // `state` strips Classic Agent approvals for browser, keeps them for phone, and strips `alwaysAllow` for ALL remote devices.
  const browserState = await browserLink.client.rpc('bot', { endpoint: 'state', payload: {} })
  assert.deepEqual(browserState.value.work.approvals.map(a => a.id), ['appr-bot'])
  assert.equal(browserState.value.work.approvals[0].alwaysAllow, undefined)
  const phoneState = await phoneLink.client.rpc('bot', { endpoint: 'state', payload: {} })
  assert.deepEqual(phoneState.value.work.approvals.map(a => a.id), ['appr-bot', 'appr-agent'])
  assert.equal(phoneState.value.work.approvals.every(a => a.alwaysAllow === undefined), true)

  // `live` feed events also filter per device and strip `alwaysAllow` for all remote devices.
  const browserEvents = []
  const phoneEvents = []
  const offBrowser = browserLink.client.onEvent(e => browserEvents.push(e))
  const offPhone = phoneLink.client.onEvent(e => phoneEvents.push(e))
  tap('live', { work: { approvals } })
  const bEvt = await until(async () => browserEvents.find(e => e.event === 'live'), Boolean)
  const pEvt = await until(async () => phoneEvents.find(e => e.event === 'live'), Boolean)
  offBrowser()
  offPhone()
  assert.deepEqual(bEvt.data.work.approvals.map(a => a.id), ['appr-bot'])
  assert.equal(bEvt.data.work.approvals[0].alwaysAllow, undefined)
  assert.deepEqual(pEvt.data.work.approvals.map(a => a.id), ['appr-bot', 'appr-agent'])
  assert.equal(pEvt.data.work.approvals.every(a => a.alwaysAllow === undefined), true)

  // Both paired browsers AND paired phones are refused `choice: 'always'` (Always allow is computer-only).
  const browserAlways = await browserLink.client.rpc('bot', { endpoint: 'approval-answer', payload: { id: 'appr-bot', choice: 'always' } })
  assert.equal(browserAlways.ok, false)
  assert.equal(browserAlways.error.code, 'bot/refused')
  const phoneAlways = await phoneLink.client.rpc('bot', { endpoint: 'approval-answer', payload: { id: 'appr-bot', choice: 'always' } })
  assert.equal(phoneAlways.ok, false)
  assert.equal(phoneAlways.error.code, 'bot/refused')
  assert.equal(answered.length, 0)

  // Browser is refused when trying to answer a Classic Agent approval, but may still answer a Bot approval.
  const denied = await browserLink.client.rpc('bot', { endpoint: 'approval-answer', payload: { id: 'appr-agent', choice: 'allow' } })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'bot/refused')
  assert.equal(answered.length, 0)

  const allowedBot = await browserLink.client.rpc('bot', { endpoint: 'approval-answer', payload: { id: 'appr-bot', choice: 'allow' } })
  assert.equal(allowedBot.ok, true)
  const allowedAgentOnPhone = await phoneLink.client.rpc('bot', { endpoint: 'approval-answer', payload: { id: 'appr-agent', choice: 'allow' } })
  assert.equal(allowedAgentOnPhone.ok, true)
  assert.deepEqual(answered.map(entry => entry.id), ['appr-bot', 'appr-agent'])

  await browserLink.client.close()
  await phoneLink.client.close()
})
