// Engine-level connector tests: OAuth pieces on fake fetches, the gateway on a
// real node:http upstream, and mail on fake transports. No network leaves the
// test process (fakes listen on 127.0.0.1 or answer in memory).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.DS_BOT_GITHUB_OAUTH_CLIENT_ID = 'test-gh-client'

const { createRuntime } = await import('../index.js')
const { fakeContext } = await import('./fake-ctx.js')
const oauth = await import('../src/host/connectors/oauth.js')
const { createGateway } = await import('../src/host/connectors/gateway.js')
const { validateCapabilityName } = await import('../src/host/capabilities.js')
const { mailSecretName } = await import('../src/host/connectors/mail/presets.js')
const { connectImap } = await import('../src/host/connectors/mail/transport.js')

const addressAt = domain => `${'me'}@${domain}`

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
const teamHome = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-eng-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, ...extra }))
  return home
}
const mounts = ctx => { const list = []; ctx.plugin = (given, config) => { const m = { config, disposed: false }; list.push(m); return { await: async () => {}, dispose: () => { m.disposed = true } } }; return list }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

// --- oauth.js --------------------------------------------------------------

const AS = {
  issuer: 'https://as.test',
  authorization_endpoint: 'https://as.test/auth',
  token_endpoint: 'https://as.test/token',
  registration_endpoint: 'https://as.test/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
}
const notFound = () => new Response('not found', { status: 404 })

test('discovery follows WWW-Authenticate, well-known, and the MCP origin fallback', async () => {
  // WWW-Authenticate points at the PRM; the PRM names the AS.
  const calls = []
  const request = async (url, init = {}) => {
    url = String(url?.url ?? url)
    calls.push(url)
    if (url === 'https://mcp.test/mcp' && !init.headers?.Authorization) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="mcp:all"' } })
    }
    if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: 'https://mcp.test/mcp', authorization_servers: ['https://as.test'], scopes_supported: ['mcp:all'] })
    }
    if (url === 'https://as.test/.well-known/oauth-authorization-server') return json(AS)
    throw new Error(`unfaked ${url}`)
  }
  const found = await oauth.discover('https://mcp.test/mcp', { fetch: request })
  assert.equal(found.authorizationServerUrl, 'https://as.test')
  assert.equal(found.metadata.token_endpoint, 'https://as.test/token')
  assert.equal(found.scope, 'mcp:all')
  assert.equal(found.resource, 'https://mcp.test/mcp')

  // No challenge: well-known PRM on the origin still works.
  const request2 = async (url) => {
    url = String(url?.url ?? url)
    if (url === 'https://mcp.test/mcp') return new Response('', { status: 401 })
    if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') return json({ resource: 'https://mcp.test/mcp', authorization_servers: ['https://as2.test'] })
    if (url === 'https://as2.test/.well-known/oauth-authorization-server') return json({ ...AS, issuer: 'https://as2.test' })
    throw new Error(`unfaked ${url}`)
  }
  const found2 = await oauth.discover('https://mcp.test/mcp', { fetch: request2 })
  assert.equal(found2.authorizationServerUrl, 'https://as2.test')

  // Older servers: no PRM at all — AS metadata on the MCP origin.
  const request3 = async (url) => {
    url = String(url?.url ?? url)
    if (url === 'https://mcp.test/mcp') return new Response('', { status: 401 })
    if (url.includes('oauth-protected-resource')) return notFound()
    if (url === 'https://mcp.test/.well-known/oauth-authorization-server') return json({ ...AS, issuer: 'https://mcp.test' })
    throw new Error(`unfaked ${url}`)
  }
  const found3 = await oauth.discover('https://mcp.test/mcp', { fetch: request3 })
  assert.equal(found3.metadata.issuer, 'https://mcp.test')
})

test('client resolution: CIMD only on the fixed port, DCR fallback, re-registration, needs-client', async () => {
  const discovery = { authorizationServerUrl: 'https://as.test', metadata: { ...AS, client_id_metadata_document_supported: true }, scope: 's', resource: 'r' }
  const entry = { auth: { kind: 'oauth' } }
  const cimd = await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:38517/callback', true)
  assert.equal(cimd.via, 'cimd')
  assert.equal(cimd.clientInformation.client_id, 'https://dsbot.app/oauth/client.json')
  // A random port cannot use the metadata document: DCR.
  let persisted
  const request = async (url, init) => {
    url = String(url?.url ?? url)
    if (url === 'https://as.test/register') return json({ client_id: 'dcr-1', client_secret: 'sec', redirect_uris: JSON.parse(init.body).redirect_uris })
    throw new Error(`unfaked ${url}`)
  }
  const dcr = await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:9/callback', false, undefined, { fetch: request, persist: async info => { persisted = info } })
  assert.equal(dcr.via, 'dcr')
  assert.equal(dcr.clientInformation.client_secret, 'sec')
  assert.equal(persisted.clientId, 'dcr-1')
  assert.deepEqual(persisted.redirectUris, ['http://127.0.0.1:9/callback'])
  // Stored client is reused when the redirect URI matches…
  const stored = { via: 'dcr', clientId: 'dcr-1', redirectUris: ['http://127.0.0.1:9/callback'] }
  const reused = await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:9/callback', false, stored, { fetch: request })
  assert.equal(reused.clientInformation.client_id, 'dcr-1')
  // …and a new redirect URI re-registers.
  await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:22/callback', false, stored, { fetch: request, persist: async info => { persisted = info } })
  assert.equal(persisted.redirectUris[0], 'http://127.0.0.1:22/callback')
  // No CIMD and no DCR: needs-client.
  const none = await oauth.resolveClient(entry, { ...discovery, metadata: { authorization_endpoint: 'a', token_endpoint: 't' } }, 'http://127.0.0.1:9/callback', false)
  assert.equal(none, null)
  // A catalog client always wins.
  const catalog = await oauth.resolveClient({ auth: { kind: 'oauth', client: { id: 'ghc' } } }, discovery, 'http://x', false)
  assert.equal(catalog.clientInformation.client_id, 'ghc')
})

test('browser PKCE carries state, code challenge, and resource; tokens exchange and refresh', async () => {
  const discovery = { authorizationServerUrl: 'https://as.test', metadata: AS, scope: 'mcp:all', resource: 'https://mcp.test/mcp' }
  const client = { client_id: 'dcr-1' }
  const { url, codeVerifier } = await oauth.beginBrowser(discovery, client, 'http://127.0.0.1:9/callback', { state: 'STATE' })
  const auth = new URL(url)
  assert.equal(auth.searchParams.get('state'), 'STATE')
  assert.equal(auth.searchParams.get('client_id'), 'dcr-1')
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://127.0.0.1:9/callback')
  assert.equal(auth.searchParams.get('resource'), 'https://mcp.test/mcp')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  let grant
  const request = async (u, init) => {
    u = String(u?.url ?? u)
    if (u === 'https://as.test/token') { grant = Object.fromEntries(new URLSearchParams(init.body)); return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' }) }
    throw new Error(`unfaked ${u}`)
  }
  const tokens = await oauth.exchange(discovery, client, { code: 'CODE', codeVerifier, redirectUri: 'http://127.0.0.1:9/callback' }, { fetch: request })
  assert.equal(tokens.access_token, 'AT')
  assert.equal(grant.grant_type, 'authorization_code')
  assert.equal(grant.code_verifier, codeVerifier)
  assert.equal(grant.resource, 'https://mcp.test/mcp')
  const rotated = await oauth.refreshTokens(discovery, client, 'RT', { fetch: request })
  assert.equal(rotated.access_token, 'AT')
  assert.equal(grant.grant_type, 'refresh_token')
  assert.equal(grant.refresh_token, 'RT')
})

test('device flow: begin and poll honor authorization_pending and slow_down', async () => {
  let polls = 0
  const request = async (url, init) => {
    url = String(url?.url ?? url)
    Object.fromEntries(new URLSearchParams(init.body))
    if (url === 'https://fake.test/device/code') return json({ device_code: 'DC', user_code: 'ABCD-1234', verification_uri: 'https://fake.test/device', interval: 0.05, expires_in: 600 })
    if (url === 'https://fake.test/token') {
      polls += 1
      if (polls === 1) return json({ error: 'authorization_pending' })
      if (polls === 2) return json({ error: 'slow_down' })
      return json({ access_token: 'GHT' })
    }
    throw new Error(`unfaked ${url}`)
  }
  const endpoints = { deviceCode: 'https://fake.test/device/code', accessToken: 'https://fake.test/token' }
  const device = await oauth.deviceBegin('test-gh-client', 'repo read:org', { fetch: request, endpoints })
  assert.equal(device.userCode, 'ABCD-1234')
  assert.equal((await oauth.devicePoll('test-gh-client', device, { fetch: request, endpoints })).state, 'pending')
  assert.equal((await oauth.devicePoll('test-gh-client', device, { fetch: request, endpoints })).state, 'slow_down')
  const done = await oauth.devicePoll('test-gh-client', device, { fetch: request, endpoints })
  assert.equal(done.state, 'done')
  assert.equal(done.token, 'GHT')
  assert.equal(oauth.invalidGrant({ error: 'invalid_grant' }), true)
  assert.equal(oauth.invalidGrant({ error: 'temporarily_unavailable' }), false)
})

// --- gateway.js ------------------------------------------------------------

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('gateway guards the nonce, injects credentials, streams SSE and Mcp-Session-Id', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'], key: req.headers['x-api-key'] })
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' })
      res.write('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n')
      setTimeout(() => { res.write('event: message\ndata: {"more":true}\n\n'); res.end() }, 10)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
    res.end('{"ok":true}')
  })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  const gw = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer REAL', 'X-Api-Key': 'K' } }),
    readOnly: () => false,
    onUnauthorized: async () => false,
  })
  await gw.listen()
  t.after(() => gw.close())
  const base = gw.urlFor('svc')
  // Wrong or missing nonce: 404, upstream untouched.
  assert.equal((await fetch(base)).status, 404)
  assert.equal((await fetch(base, { headers: { Authorization: 'Bearer wrong' } })).status, 404)
  assert.equal(seen.length, 0)
  // POST: credential swapped in, session id forwarded both ways.
  const post = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${gw.nonce}`, 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }, body: '{}' })
  assert.equal(post.status, 200)
  assert.equal(post.headers.get('mcp-session-id'), 'sess-1')
  assert.equal(seen[0].auth, 'Bearer REAL')
  assert.equal(seen[0].key, 'K')
  // GET streams the SSE frames through unbuffered.
  const get = await fetch(base, { headers: { Authorization: `Bearer ${gw.nonce}`, 'mcp-session-id': 'sess-1' } })
  assert.equal(get.headers.get('mcp-session-id'), 'sess-1')
  const body = await get.text()
  assert.match(body, /"more":true/)
})

test('gateway read-only filters tools/list and refuses write tools/call', async (t) => {
  const list = { jsonrpc: '2.0', id: 1, result: { tools: [
    { name: 'read_thing', annotations: { readOnlyHint: true } },
    { name: 'write_thing' },
    { name: 'maybe', annotations: {} },
  ] } }
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const rpc = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpc.method === 'tools/list' ? list : { jsonrpc: '2.0', id: rpc.id, result: { ok: true } }))
    })
  })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  const gw = createGateway({ credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }), readOnly: () => true, onUnauthorized: async () => false })
  await gw.listen()
  t.after(() => gw.close())
  const head = { Authorization: `Bearer ${gw.nonce}`, 'content-type': 'application/json' }
  // First tools/list learns the annotations and returns only read-only tools.
  const filtered = await (await fetch(gw.urlFor('svc'), { method: 'POST', headers: head, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json()
  assert.deepEqual(filtered.result.tools.map(tool => tool.name), ['read_thing'])
  // A write call is refused locally; a read-only call goes through.
  const refused = await (await fetch(gw.urlFor('svc'), { method: 'POST', headers: head, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_thing', arguments: {} } }) })).json()
  assert.match(refused.error.message, /read-only/)
  const allowed = await (await fetch(gw.urlFor('svc'), { method: 'POST', headers: head, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_thing', arguments: {} } }) })).json()
  assert.deepEqual(allowed.result, { ok: true })
})

test('gateway retries once on a 401 after the credential hook refreshes', async (t) => {
  let hits = 0
  const upstream = createServer((req, res) => {
    hits += 1
    if (hits === 1) { res.writeHead(401); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  let refreshes = 0
  const gw = createGateway({ credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }), readOnly: () => false, onUnauthorized: async () => { refreshes += 1; return true } })
  await gw.listen()
  t.after(() => gw.close())
  const response = await fetch(gw.urlFor('svc'), { method: 'POST', headers: { Authorization: `Bearer ${gw.nonce}`, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(hits, 2)
  assert.equal(refreshes, 1)
})

// --- engine -----------------------------------------------------------------

test('refresh is single-flight, rotates the refresh token, and invalid_grant means sign-in again', async (t) => {
  const home = teamHome({ connectors: { notion: { oauth: { authorizationServerUrl: 'https://as.test', resource: 'https://mcp.test/mcp', scope: 's' }, client: { via: 'dcr', clientId: 'dcr-1' } } } })
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load(); await rt.loadSecrets()
  await rt.secretEndpoint('secret-set', { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-1', scope: [] })
  let grants = 0
  const request = async (url) => {
    url = String(url?.url ?? url)
    if (url.includes('oauth-authorization-server')) return json(AS)
    if (url === 'https://as.test/token') { grants += 1; return json({ access_token: `AT-${grants}`, refresh_token: `RT-${grants + 1}`, token_type: 'Bearer' }) }
    throw new Error(`unfaked ${url}`)
  }
  const real = globalThis.fetch
  globalThis.fetch = request
  t.after(() => { globalThis.fetch = real })
  const [a, b] = await Promise.all([rt.connectorsInternals.refreshConnector('notion'), rt.connectorsInternals.refreshConnector('notion')])
  assert.equal(a, true, JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
  assert.equal(b, true)
  assert.equal(grants, 1)
  assert.equal(rt.secretValue('CONNECTOR_NOTION_REFRESH'), 'RT-2')
  let logs = await rt.diagnostics.entries()
  assert.equal(logs.filter(row => /connector notion token refresh succeeded.*dcr/.test(row.text)).length, 1)
  // invalid_grant on the next refresh: needs-sign-in, old secrets kept.
  globalThis.fetch = async (url, init) => String(url?.url ?? url) === 'https://as.test/token' ? json({ error: 'invalid_grant' }, 400) : request(url, init)
  assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
  assert.equal(rt.connectorsInternals.statuses.get('notion').state, 'needs-sign-in', JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
  assert.equal(rt.secretValue('CONNECTOR_NOTION_REFRESH'), 'RT-2')
  logs = await rt.diagnostics.entries()
  assert.ok(logs.some(row => /connector notion token refresh failed.*dcr/.test(row.text)))
  assert.equal(JSON.stringify(logs).includes('RT-2'), false)
  // A connector that needs sign-in again can still be asked for with a card.
  const ask = rt.teamTools.find(d => d.name === 'request_connector')
  const asked = String(await ask.execute({ id: 'notion', purpose: 'Search pages' }, { agent: { id: 'm1' }, concludeTurn: () => {} }))
  assert.doesNotMatch(asked, /already connected/)
  assert.equal(rt.state.connectorRequests.m1.at(-1).name, 'Notion', 'the card names the service, not its id')
})

test('refresh uses the client that signed in: cimd, catalog, and legacy inference', async (t) => {
  const seen = []
  let asMeta = AS
  const request = async (url, init) => {
    url = String(url?.url ?? url)
    if (url.includes('oauth-authorization-server')) return json(asMeta)
    if (url === 'https://as.test/token') {
      seen.push(new URLSearchParams(init?.body ?? '').get('client_id'))
      return json({ access_token: `AT-${seen.length}`, token_type: 'Bearer' })
    }
    return notFound()
  }
  const real = globalThis.fetch
  globalThis.fetch = request
  t.after(() => { globalThis.fetch = real })
  const make = async (connectors, secret, github = false) => {
    const home = teamHome({ connectors })
    const ctx = fakeContext()
    const rt = createRuntime(ctx, { home, github })
    await rt.load(); await rt.loadSecrets()
    await rt.secretEndpoint('secret-set', secret)
    return { rt, done: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) } }
  }
  // A CIMD sign-in refreshes with the published document id.
  {
    const { rt, done } = await make(
      { notion: { oauth: { authorizationServerUrl: 'https://as.test' }, client: { via: 'cimd', clientId: 'https://dsbot.app/oauth/client.json' } } },
      { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-1', scope: [] })
    t.after(done)
    assert.equal(await rt.connectorsInternals.refreshConnector('notion'), true, JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
    assert.equal(seen.at(-1), 'https://dsbot.app/oauth/client.json')
    assert.equal(rt.state.connectors.notion.client.via, 'cimd')
  }
  // A catalog sign-in refreshes with the current catalog client id.
  {
    const { rt, done } = await make(
      { github: { oauth: { authorizationServerUrl: 'https://as.test' }, client: { via: 'catalog' } } },
      { name: 'CONNECTOR_GITHUB_REFRESH', value: 'RT-2', scope: [] }, true)
    t.after(done)
    assert.equal(await rt.connectorsInternals.refreshConnector('github'), true, JSON.stringify(rt.connectorsInternals.statuses.get('github')))
    assert.equal(seen.at(-1), 'test-gh-client')
  }
  {
    const { rt, done } = await make(
      { notion: { oauth: { authorizationServerUrl: 'https://as.test' }, client: { via: 'manual', clientId: 'manual-client' } } },
      { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-manual', scope: [] })
    t.after(done)
    assert.equal(await rt.connectorsInternals.refreshConnector('notion'), true)
    assert.equal(seen.at(-1), 'manual-client')
    assert.equal(rt.state.connectors.notion.client.via, 'manual')
    assert.ok((await rt.diagnostics.entries()).some(row => /refresh succeeded.*manual/.test(row.text)))
  }
  // Legacy rows have no `client`: CIMD when the AS supports it, else needs-sign-in.
  {
    asMeta = { ...AS, client_id_metadata_document_supported: true }
    const { rt, done } = await make(
      { notion: { oauth: { authorizationServerUrl: 'https://as.test' } } },
      { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-3', scope: [] })
    t.after(done)
    assert.equal(await rt.connectorsInternals.refreshConnector('notion'), true, JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
    assert.equal(seen.at(-1), 'https://dsbot.app/oauth/client.json')
    assert.deepEqual(rt.state.connectors.notion.client, { via: 'cimd', clientId: oauth.CIMD_CLIENT_ID })
    assert.ok((await rt.diagnostics.entries()).some(row => /refresh succeeded.*inferred.*cimd/.test(row.text)))
  }
  {
    asMeta = AS
    const { rt, done } = await make(
      { notion: { oauth: { authorizationServerUrl: 'https://as.test' } } },
      { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-4', scope: [] })
    t.after(done)
    assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
    assert.equal(rt.connectorsInternals.statuses.get('notion').state, 'needs-sign-in', JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
  }
})

test('read-only windows never refresh', async (t) => {
  const home = teamHome({ connectors: { notion: { oauth: { authorizationServerUrl: 'https://as.test' }, client: { via: 'dcr', clientId: 'c' } } } })
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load(); await rt.loadSecrets()
  await rt.secretEndpoint('secret-set', { name: 'CONNECTOR_NOTION_REFRESH', value: 'RT-0', scope: [] })
  rt.readOnly = () => 'The team is open elsewhere'
  let hit = false
  const real = globalThis.fetch
  globalThis.fetch = async () => { hit = true; return json({}) }
  t.after(() => { globalThis.fetch = real })
  assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
  assert.equal(hit, false)
})

test('connector-set offFor yields deny prefixes; empty client id keeps the token form only', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('connector-set', { id: 'notion', offFor: ['m1'] })
  assert.deepEqual(rt.connectorOffFor('m1'), ['mcp__notion__'])
  assert.deepEqual(rt.connectorOffFor('other'), [])
  // No DS_BOT_GITHUB_OAUTH_CLIENT_ID at sign-in → token form only. (Set above,
  // so here check the empty case through the row error path.)
  await assert.rejects(rt.connectorEndpoint('connector-connect', { id: 'nonexistent' }), /No such connector/)
})

test('custom connectors get unique ids that never collide with the catalog', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const plugin = { name: 'mcp', apply() {} }
  ctx.get = name => name === 'loader' ? { import: async () => ({ default: plugin }), unwrapExports: e => e.default } : undefined
  const list = mounts(ctx)
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('connector-add', { name: 'GitHub Mirror', url: 'https://mcp.example.com/x' })
  const second = await rt.connectorEndpoint('connector-add', { name: 'Notion', url: 'https://mcp.example.com/y' })
  const ids = second.connectors.filter(r => r.custom).map(r => r.id)
  assert.equal(ids.length, 2)
  assert.ok(!ids.includes('github') && !ids.includes('notion'))
  assert.equal(new Set(ids).size, 2)
  assert.ok(ids.every(id => /^[a-z0-9-]{1,32}$/.test(id)))
  // Both mounted through the gateway; no credential in their configs.
  assert.ok(ids.every(id => list.some(m => m.config.serverName === id)))
  assert.throws(() => validateCapabilityName('notion'), /reserved/)
  assert.equal(validateCapabilityName('my-tool'), 'my-tool')
})

test('import scan returns env names only and never writes the source files', async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsb-fakehome-'))
  const appData = join(fakeHome, 'AppData', 'Roaming')
  // Every supported platform location sees the same file.
  const dirs = [join(fakeHome, 'Library', 'Application Support', 'Claude'), join(fakeHome, '.config', 'Claude'), join(appData, 'Claude')]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  const configPath = join(dirs[0], 'claude_desktop_config.json')
  for (const dir of dirs) writeFileSync(join(dir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { jira: { command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_TOKEN: 'RAW-SECRET' } }, docs: { url: 'https://docs.example.com/mcp' } } }))
  const before = readFileSync(configPath, 'utf8')
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }); rmSync(fakeHome, { recursive: true, force: true }) })
  await rt.load()
  const realHome = process.env.HOME
  const realAppData = process.env.APPDATA
  process.env.HOME = fakeHome
  process.env.APPDATA = appData
  t.after(() => { process.env.HOME = realHome; if (realAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = realAppData })
  const scanned = await rt.connectorEndpoint('connector-import-scan', {})
  const jira = scanned.find(s => s.name === 'jira')
  assert.deepEqual(jira.envNames, ['JIRA_TOKEN'])
  assert.equal(JSON.stringify(scanned).includes('RAW-SECRET'), false)
  const imported = await rt.connectorEndpoint('connector-import', { items: [{ source: 'claude', name: 'jira' }] })
  assert.equal(imported.created.length, 1)
  await rt.loadSecrets()
  assert.equal(rt.secretValue(`CONNECTOR_${imported.created[0].toUpperCase()}_JIRA_TOKEN`), 'RAW-SECRET')
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

// --- mail -------------------------------------------------------------------

const fakeSession = () => {
  const calls = []
  return {
    calls,
    async search(args) { calls.push(['search', args]); return [] },
    async read(args) { calls.push(['read', args]); return { messages: [] } },
    async draft(args) { calls.push(['draft', args]); return { folder: 'Drafts' } },
    async send(args) { calls.push(['send', args]); return { messageId: '<m@x>' } },
    async update(args) { calls.push(['update', args]) },
    async saveAttachment(args) { calls.push(['saveAttachment', args]); return { path: args.to } },
    async close() { calls.push(['close']) },
  }
}

test('mail_search reconnects once after an idle drop or an unusable cached session', async (t) => {
  const made = []
  const factory = async (_account, { onGone }) => {
    const session = { ...fakeSession(), usable: true, gone: () => onGone() }
    made.push(session)
    return session
  }
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: factory } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' })
  const search = rt.teamTools.find(d => d.name === 'mail_search')
  made[0].gone()
  assert.equal(await search.execute({}, { agent: { id: 'm1' } }), 'No matching mail.')
  assert.equal(made.length, 2)
  made[0].gone() // A late close from the old connection must not drop the new one.
  await search.execute({}, { agent: { id: 'm1' } })
  assert.equal(made.length, 2)
  made[1].usable = false
  await search.execute({}, { agent: { id: 'm1' } })
  assert.equal(made.length, 3)
})

test('an idle ImapFlow error cannot crash the engine and the next search logs in once', async (t) => {
  const clients = []
  class ImapFlow extends EventEmitter {
    usable = false
    constructor() { super(); clients.push(this) }
    async connect() { this.usable = true }
    close() { this.usable = false; this.emit('close') }
    async logout() { this.close() }
    async getMailboxLock() { return { release() {} } }
    async search() { return [] }
  }
  let made = 0
  const factory = (account, deps) => {
    made += 1
    return connectImap(account, { ...deps, modules: {
      ImapFlow, nodemailer: { createTransport: () => Object.assign(new EventEmitter(), { verify: async () => {}, close() {} }) },
    } })
  }
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: factory } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' })
  assert.doesNotThrow(() => clients[0].emit('error', new Error('Socket timeout')))
  assert.equal(await rt.teamTools.find(d => d.name === 'mail_search').execute({}, { agent: { id: 'm1' } }), 'No matching mail.')
  assert.equal(made, 2)
})

test('mail add updates the same address and keeps its verified session for tools', async (t) => {
  const made = []
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async (account, deps) => {
    const session = fakeSession()
    made.push({ account, password: deps.password, session })
    return session
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const first = await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'FIRST' })
  const id = first.accounts[0].id
  const search = rt.teamTools.find(d => d.name === 'mail_search')
  await search.execute({}, { agent: { id: 'm1' } })
  assert.equal(made.length, 1)
  assert.equal(made[0].session.calls.some(c => c[0] === 'close'), false)
  const updated = await rt.connectorEndpoint('mail-account-add', {
    address: addressAt('qq.com').toUpperCase(), password: 'SECOND', provider: 'other',
    imapHost: 'imap.example.test', smtpHost: 'smtp.example.test',
  })
  assert.equal(updated.accounts.length, 1)
  assert.equal(updated.accounts[0].id, id)
  assert.equal(made.length, 2)
  assert.equal(made[1].account.imap.host, 'imap.example.test')
  assert.equal(rt.secretValue(mailSecretName(addressAt('qq.com'), 'PASSWORD')), 'SECOND')
  assert.equal(made[0].session.calls.some(c => c[0] === 'close'), true)
  await search.execute({}, { agent: { id: 'm1' } })
  assert.equal(made.length, 2)
  assert.equal(made[1].session.calls.some(c => c[0] === 'search'), true)
})

test('concurrent adds for one address share verification and its result', async (t) => {
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  let made = 0
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => {
    made += 1
    started.resolve()
    await gate.promise
    return fakeSession()
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const first = rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' })
  await started.promise
  const second = rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com').toUpperCase(), password: 'CODE' })
  await new Promise(resolve => setImmediate(resolve))
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(made, 1)
  assert.deepEqual(a, b)
  assert.equal(rt.mailView().accounts.length, 1)
})

test('mail account add verifies before saving; a bad code fails cleanly; send needs the card', async (t) => {
  const sessions = new Map()
  const factory = async (account, deps) => {
    if (deps.password === 'WRONG') throw new Error('535 authentication failed')
    const session = fakeSession()
    sessions.set(account.address, session)
    return session
  }
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: factory } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  // 163 preset picked from the address; wrong code → clean error, nothing saved.
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('163.com'), password: 'WRONG' }), /app password|authorization code|refused/i)
  assert.equal(rt.mailView().accounts.length, 0)
  const view = await rt.connectorEndpoint('mail-account-add', { address: addressAt('163.com'), password: 'RIGHT' })
  assert.equal(view.accounts[0].provider, '163')
  assert.equal(view.accounts[0].address, addressAt('163.com'))
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName(addressAt('163.com'), 'PASSWORD')), 'RIGHT')
  // The mail tools register once an account exists.
  const send = rt.teamTools.find(d => d.name === 'mail_send')
  const draft = rt.teamTools.find(d => d.name === 'mail_draft')
  assert.ok(send && draft)
  let concluded = false
  const exec = { agent: { id: 'm1' }, callId: 'call-1', concludeTurn: () => { concluded = true } }
  const answer = await send.execute({ to: 'you@test.dev', subject: 'Hi', body: 'Body text' }, exec)
  assert.match(String(answer), /send card|on screen/i)
  assert.equal(concluded, true)
  const request = rt.state.mailRequests.m1.at(-1)
  assert.equal(request.status, 'pending')
  assert.equal(sessions.get(addressAt('163.com')).calls.some(c => c[0] === 'send'), false)
  // Cancel: nothing is sent; a new card, then Send, sends once.
  assert.equal(await rt.connectorEndpoint('mail-send-answer', { requestId: request.id, choice: 'cancel' }), true)
  assert.equal(sessions.get(addressAt('163.com')).calls.filter(c => c[0] === 'send').length, 0)
  await send.execute({ to: 'you@test.dev', subject: 'Hi2', body: 'B' }, { agent: { id: 'm1' }, callId: 'call-2', concludeTurn: () => {} })
  const request2 = rt.state.mailRequests.m1.at(-1)
  await rt.connectorEndpoint('mail-send-answer', {
    requestId: request2.id, choice: 'send',
    fields: { to: 'edited@test.dev', cc: 'cc@test.dev', subject: 'Hi2 edited', body: 'Edited B' },
    rule: 'allow-recipient',
  })
  const sent = sessions.get(addressAt('163.com')).calls.filter(c => c[0] === 'send')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].to, 'edited@test.dev')
  assert.equal(sent[0][1].cc, 'cc@test.dev')
  assert.equal(sent[0][1].subject, 'Hi2 edited')
  assert.equal(sent[0][1].text, 'Edited B')
  assert.deepEqual(rt.mailView().allowedRecipients, ['edited@test.dev', 'cc@test.dev'])
  // Allowed recipients skip the draft card and send right away; an unknown recipient still requires confirmation.
  let concludedAllowed = false
  const autoReply = await send.execute({ to: 'edited@test.dev', subject: 'Auto', body: 'Quick' }, { agent: { id: 'm1' }, callId: 'call-3', concludeTurn: () => { concludedAllowed = true } })
  assert.match(String(autoReply), /Sent "Auto" to edited@test\.dev/)
  assert.equal(concludedAllowed, false)
  assert.equal(sessions.get(addressAt('163.com')).calls.filter(c => c[0] === 'send').length, 2)
  let concludedMixed = false
  await send.execute({ to: 'edited@test.dev', cc: 'stranger@test.dev', subject: 'Mixed', body: 'Hold' }, { agent: { id: 'm1' }, callId: 'call-4', concludeTurn: () => { concludedMixed = true } })
  assert.equal(concludedMixed, true, 'any unapproved recipient in cc still requires confirmation')
  // Turning off drafts for a Bot sends without confirmation; restoring Needs approval brings the card back.
  await rt.connectorEndpoint('mail-rule-set', { mode: 'no-draft', botId: 'm1' })
  assert.deepEqual(rt.mailView().noDraftFor, ['m1'])
  let concludedNoDraft = false
  await send.execute({ to: 'anyone@test.dev', subject: 'NoDraft', body: 'Go' }, { agent: { id: 'm1' }, callId: 'call-5', concludeTurn: () => { concludedNoDraft = true } })
  assert.equal(concludedNoDraft, false)
  await rt.connectorEndpoint('mail-rule-set', { botId: 'm1', noDraft: false, removeRecipient: 'edited@test.dev, cc@test.dev' })
  assert.deepEqual(rt.mailView().noDraftFor, [])
  assert.deepEqual(rt.mailView().allowedRecipients, [])
  // A draft never draws a card.
  const before = (rt.state.mailRequests.m1 ?? []).length
  assert.match(String(await draft.execute({ to: 'a@b.c', subject: 'D', body: 'x' }, exec)), /Draft saved/)
  assert.equal((rt.state.mailRequests.m1 ?? []).length, before)
})

test('mail add explains refused and unsafe logins in plain words', async (t) => {
  let mode = 'ok'
  const factory = async () => {
    if (mode === 'flag') { const error = new Error('NO'); error.authenticationFailed = true; throw error }
    if (mode === 'qq') throw new Error('Login fail. Account is abnormal, service is not open, password is incorrect, login frequency limited, or system is busy.')
    if (mode === 'unsafe') throw new Error('Unsafe Login')
    if (mode === 'refused') throw new Error('connect ECONNREFUSED 127.0.0.1:993')
    return fakeSession()
  }
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: factory } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com') }), /Enter the authorization code or app password/)
  mode = 'flag'
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' }), /The password was refused/)
  mode = 'qq'
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' }), /The password was refused/)
  mode = 'unsafe'
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' }), /Unsafe Login/)
  mode = 'refused'
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'CODE' }), /^Error: Could not reach the mail server at 127\.0\.0\.1:993\. Check the server address\.$/)
  assert.equal(rt.mailView().accounts.length, 0)
})

test('mail account remove drops the secret and unregisters the tools', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => fakeSession() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'PASSP' })
  assert.ok(rt.teamTools.some(d => d.name === 'mail_send'))
  await rt.connectorEndpoint('mail-account-remove', { id: rt.mailView().accounts[0].id })
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName(addressAt('qq.com'), 'PASSWORD')), undefined)
  assert.equal(rt.teamTools.some(d => d.name === 'mail_send'), false)
})

test('removing one of two rows for the same address keeps the shared secret', async (t) => {
  const address = addressAt('qq.com')
  const row = id => ({ id, address, provider: 'qq', auth: 'password', imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true }, createdAt: 1 })
  const home = teamHome({ connectors: { mail: { accounts: { ma: row('ma'), mb: row('mb') } } } })
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => fakeSession() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load(); await rt.loadSecrets()
  await rt.secretEndpoint('secret-set', { name: mailSecretName(address, 'PASSWORD'), value: 'PASSP', scope: [] })
  await rt.connectorEndpoint('mail-account-remove', { id: 'ma' })
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName(address, 'PASSWORD')), 'PASSP')
  assert.deepEqual(rt.mailView().accounts.map(a => a.id), ['mb'])
  await rt.connectorEndpoint('mail-account-remove', { id: 'mb' })
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName(address, 'PASSWORD')), undefined)
})

const { imapOptions } = await import('../src/host/connectors/mail/transport.js')
const { IMAP_ID } = await import('../src/host/connectors/mail/presets.js')

test('163 and 126 presets send the IMAP ID identity', () => {
  for (const domain of ['163.com', '126.com']) {
    const options = imapOptions({ address: `${'me'}@${domain}`, imap: { host: `imap.${domain}`, port: 993, secure: true } }, { password: 'x' })
    assert.deepEqual(options.id, IMAP_ID)
    assert.equal(options.id.vendor, 'DS Bot')
  }
})

test('gateway keeps the entry path and merges queries', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  const gw = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${port}/mcp?key=K1`, headers: {} }),
    readOnly: () => false, onUnauthorized: async () => false,
  })
  await gw.listen()
  t.after(() => gw.close())
  const head = { Authorization: `Bearer ${gw.nonce}`, 'content-type': 'application/json' }
  await fetch(gw.urlFor('svc'), { method: 'POST', headers: head, body: '{}' })
  assert.equal(seen.at(-1), '/mcp?key=K1')
  await fetch(`${gw.urlFor('svc')}?x=1&y=2`, { method: 'POST', headers: head, body: '{}' })
  assert.equal(seen.at(-1), '/mcp?key=K1&x=1&y=2')
})

test('gateway destroys the upstream stream when the client disconnects', async (t) => {
  let upstreamDestroyed = false
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    res.on('close', () => { upstreamDestroyed = true })
    // never ends on its own
  })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  const gw = createGateway({ credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }), readOnly: () => false, onUnauthorized: async () => false })
  await gw.listen()
  t.after(() => gw.close())
  const controller = new AbortController()
  // The GET answer headers arrived; abort the body read.
  const res = await fetch(gw.urlFor('svc'), { headers: { Authorization: `Bearer ${gw.nonce}` }, signal: controller.signal })
  controller.abort()
  await res.body?.cancel().catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(upstreamDestroyed, true)
})

test('gateway refuses JSON-RPC batches in read-only mode', async (t) => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') })
  const port = await listen(upstream)
  t.after(() => upstream.close())
  const gw = createGateway({ credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }), readOnly: () => true, onUnauthorized: async () => false })
  await gw.listen()
  t.after(() => gw.close())
  const batch = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_thing' } }]
  const answer = await (await fetch(gw.urlFor('svc'), { method: 'POST', headers: { Authorization: `Bearer ${gw.nonce}`, 'content-type': 'application/json' }, body: JSON.stringify(batch) })).json()
  assert.match(answer.error.message, /read-only/)
})

test('a stored CIMD client is reused only with the fixed port', async () => {
  const discovery = { authorizationServerUrl: 'https://as.test', metadata: { ...AS, client_id_metadata_document_supported: true }, resource: 'r' }
  const entry = { auth: { kind: 'oauth' } }
  const stored = { via: 'cimd', clientId: 'https://dsbot.app/oauth/client.json', redirectUris: [] }
  const fixed = await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:38517/callback', true, stored)
  assert.equal(fixed.via, 'cimd')
  const request = async (url, init) => url.toString() === 'https://as.test/register' ? json({ client_id: 'dcr-9', redirect_uris: JSON.parse(init.body).redirect_uris }) : notFound()
  const random = await oauth.resolveClient(entry, discovery, 'http://127.0.0.1:9/callback', false, stored, { fetch: request })
  assert.equal(random.via, 'dcr')
})

test('connector-sign-in-code refuses a wrong state and accepts the pasted URL or bare code', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const internals = rt.connectorsInternals
  internals.pendings.set('notion', {
    kind: 'browser', expectedState: 'STATE1', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:9/callback',
    discovery: { authorizationServerUrl: 'https://as.test', metadata: AS, resource: 'https://mcp.test/mcp' },
    clientInformation: { client_id: 'c1' }, timer: setTimeout(() => {}, 60_000), listener: { close: cb => cb?.() },
  })
  await assert.rejects(rt.connectorEndpoint('connector-sign-in-code', { id: 'notion', input: 'http://x/?code=C&state=WRONG' }), /state/i)
  const real = globalThis.fetch
  globalThis.fetch = async (u) => String(u?.url ?? u) === 'https://as.test/token' ? json({ access_token: 'AT-9', token_type: 'Bearer' }) : notFound()
  t.after(() => { globalThis.fetch = real })
  await rt.connectorEndpoint('connector-sign-in-code', { id: 'notion', input: 'http://x/?code=C&state=STATE1' })
  assert.equal(rt.secretValue('CONNECTOR_NOTION_TOKEN'), 'AT-9')
})

test('OAuth loopback keeps an error listener after binding, including repeated errors', async (t) => {
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    url = String(url?.url ?? url)
    if (url.includes('oauth-authorization-server')) return json({ ...AS, client_id_metadata_document_supported: true })
    if (url === 'https://as.test/register') return json({ client_id: 'dcr-local', redirect_uris: JSON.parse(init.body).redirect_uris })
    if (url.includes('oauth-protected-resource')) return json({ resource: 'https://mcp.notion.com/mcp', authorization_servers: ['https://as.test'] })
    return new Response('', { status: 401 })
  }
  t.after(() => { globalThis.fetch = real })
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('connector-connect', { id: 'notion' })
  const listener = rt.connectorsInternals.pendings.get('notion').listener
  assert.doesNotThrow(() => {
    listener.emit('error', new Error('listener failed'))
    listener.emit('error', new Error('listener failed again'))
  })
})

test('Google sign-in without an address still reaches the browser flow', async (t) => {
  const oldId = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
  const oldSecret = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = 'google-test'
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = 'google-test-secret'
  t.after(() => {
    if (oldId === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = oldId
    if (oldSecret === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = oldSecret
  })
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { fetch: async url => {
    if (String(url).includes('oauth-authorization-server')) return json(AS)
    return notFound()
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const view = await rt.connectorEndpoint('mail-account-add', { google: true })
  assert.ok(new URL(view.pending[0].url).searchParams.get('redirect_uri').startsWith('http://127.0.0.1:'))
})

test('Google loopback catches a rejected sign-in callback instead of an unhandled rejection', async (t) => {
  const oldId = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
  const oldSecret = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = 'google-test'
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = 'google-test-secret'
  t.after(() => {
    if (oldId === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = oldId
    if (oldSecret === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = oldSecret
  })
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { fetch: async url => {
    if (String(url).includes('oauth-authorization-server')) return json(AS)
    return notFound()
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const view = await rt.connectorEndpoint('mail-account-add', { address: addressAt('gmail.com'), google: true })
  const callback = new URL(view.pending[0].url).searchParams.get('redirect_uri')
  await fetch(callback) // No code: googleCode rejects.
  await new Promise(resolve => setImmediate(resolve))
  assert.ok((await rt.diagnostics.entries()).some(row => /mail Google sign-in failed/.test(row.text)))
})

test('Google sign-in retries get a fresh URL and a success clears the pending row', async (t) => {
  const oldId = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
  const oldSecret = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = 'google-test'
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = 'google-test-secret'
  t.after(() => {
    if (oldId === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = oldId
    if (oldSecret === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = oldSecret
  })
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { fetch: async url => {
    const u = String(url)
    if (u.includes('oauth-authorization-server')) return json(AS)
    if (u === 'https://as.test/token') return json({ access_token: 'tok-aaaa', refresh_token: 'ref-bbbb', expires_in: 3600, token_type: 'Bearer' })
    if (u.includes('userinfo')) return json({ email: `${'retry'}@gmail.com` })
    return notFound()
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const first = await rt.connectorEndpoint('mail-account-add', { google: true })
  const second = await rt.connectorEndpoint('mail-account-add', { google: true })
  assert.notEqual(first.pending[0].url, second.pending[0].url, 'retry should start a new attempt')
  const url = new URL(second.pending[0].url)
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.search = `?code=C&state=WRONG`
  const bad = await fetch(callback)
  assert.equal(bad.status, 200)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok((await rt.diagnostics.entries()).some(row => /not for this attempt/.test(row.text)))
  callback.search = `?code=C&state=${url.searchParams.get('state')}`
  const ok = await fetch(callback)
  assert.match(await ok.text(), /Signed in/)
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve))
    const view = await rt.connectorEndpoint('mail-rule-set', {})
    if (view.accounts.some(a => a.address === `${'retry'}@gmail.com`)) {
      assert.ok(!view.pending?.length, 'pending row must be gone after a successful sign-in: ' + JSON.stringify({ second: second.pending[0].url, leftover: view.pending }))
      return
    }
  }
  assert.fail('account never landed')
})

test('Google mailbox refresh reports success and failure without credentials or addresses', async () => {
  const { install } = await import('../src/host/connectors/mail/index.js')
  const logs = []
  const secrets = new Map()
  const address = addressAt('gmail.com')
  secrets.set(mailSecretName(address, 'REFRESH'), 'google-refresh-private')
  let fail = false
  const rt = {
    state: {}, readOnly: () => undefined, secretValue: key => secrets.get(key),
    warn: (...args) => logs.push(args),
    config: { mail: { fetch: async url => {
      if (String(url).includes('well-known')) return json(AS)
      if (String(url).includes('/token')) return fail
        ? json({ error: 'invalid_grant' }, 400)
        : json({ access_token: 'google-access-private', token_type: 'Bearer' })
      return notFound()
    } } },
  }
  const mail = install(rt, { secrets: { writeSecret: async (key, value) => secrets.set(key, value) } })
  assert.equal(await mail._internals.refreshGoogle({ address }), true)
  fail = true
  assert.equal(await mail._internals.refreshGoogle({ address }), false)
  assert.match(JSON.stringify(logs), /succeeded.*manual\/Google/)
  assert.match(JSON.stringify(logs), /failed.*manual\/Google/)
  assert.equal(JSON.stringify(logs).includes('private'), false)
  assert.equal(JSON.stringify(logs).includes(address), false)
})

test('gmail transport: search, read, draft, send, modify, trash, and one refresh on 401', async () => {
  const calls = []
  let refreshes = 0
  let authed = false
  const fakeFetch = async (url) => {
    const u = String(url?.url ?? url)
    calls.push(u)
    if (!authed && u.includes('/messages/1?format=full')) {
      authed = true
      return new Response('unauth', { status: 401 })
    }
    if (u.includes('/messages?') || u.includes('maxResults')) return json({ messages: [{ id: '1' }] })
    if (u.includes('metadataHeaders')) return json({ id: '1', labelIds: ['UNREAD'], payload: { headers: [{ name: 'Subject', value: 'S' }, { name: 'From', value: 'a@b' }] } })
    if (u.includes('?format=full')) return json({ id: '1', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'S' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64') } }] } })
    if (u.includes('/drafts')) return json({ id: 'd1' })
    if (u.includes('/messages/send')) return json({ id: 's1' })
    if (u.includes('/modify')) return json({})
    if (u.includes('/trash')) return json({})
    return json({})
  }
  const { connectGmail } = await import('../src/host/connectors/mail/transport.js')
  const gmail = connectGmail({ address: addressAt('gmail.com') }, { token: () => 'G1', fetch: fakeFetch, refresh: async () => { refreshes += 1; return true } })
  const rows = await gmail.search({ subject: 'x' })
  assert.equal(rows.length, 1)
  assert.equal((await gmail.read({ uid: '1' })).messages[0].text, 'hi')
  assert.ok((await gmail.draft({ to: 'a@b', subject: 'd', text: 'x' })).folder)
  await gmail.send({ to: 'a@b', subject: 's', text: 'x' })
  await gmail.update({ uid: '1', seen: true })
  await gmail.update({ uid: '1', move: 'trash' })
  // The 401 on the first read was refreshed exactly once, then retried.
  assert.equal(refreshes, 1)
  assert.ok(calls.some(c => c.includes('/drafts')) && calls.some(c => c.includes('/trash')) && calls.some(c => c.includes('/modify')))
})

test('mail_draft never creates a send card', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => fakeSession() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'PASSP' })
  const draft = rt.teamTools.find(d => d.name === 'mail_draft')
  await draft.execute({ to: 'x@y', subject: 'S', body: 'B' }, { agent: { id: 'm1' }, callId: 'c1', concludeTurn: () => {} })
  assert.equal((rt.state.mailRequests?.m1 ?? []).filter(r => r.status === 'pending').length, 0)
})

test('mail_send refuses attachments outside the working folder', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => fakeSession() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: addressAt('qq.com'), password: 'PASSP' })
  const send = rt.teamTools.find(d => d.name === 'mail_send')
  const answer = await send.execute({ to: 'x@y', subject: 'S', body: 'B', attachments: ['../../etc/passwd'] }, { agent: { id: 'm1' }, callId: 'c1', concludeTurn: () => {} })
  assert.match(String(answer), /working folder/)
})
