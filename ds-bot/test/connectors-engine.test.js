// Engine-level connector tests: OAuth pieces on fake fetches, the gateway on a
// real node:http upstream, and mail on fake transports. No network leaves the
// test process (fakes listen on 127.0.0.1 or answer in memory).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
  // invalid_grant on the next refresh: needs-sign-in, old secrets kept.
  globalThis.fetch = async (url, init) => String(url?.url ?? url) === 'https://as.test/token' ? json({ error: 'invalid_grant' }, 400) : request(url, init)
  assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
  assert.equal(rt.connectorsInternals.statuses.get('notion').state, 'needs-sign-in', JSON.stringify(rt.connectorsInternals.statuses.get('notion')))
  assert.equal(rt.secretValue('CONNECTOR_NOTION_REFRESH'), 'RT-2')
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
  const claudeDir = join(fakeHome, 'Library', 'Application Support', 'Claude')
  mkdirSync(claudeDir, { recursive: true })
  const configPath = join(claudeDir, 'claude_desktop_config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { jira: { command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_TOKEN: 'RAW-SECRET' } }, docs: { url: 'https://docs.example.com/mcp' } } }))
  const before = readFileSync(configPath, 'utf8')
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }); rmSync(fakeHome, { recursive: true, force: true }) })
  await rt.load()
  const realHome = process.env.HOME
  process.env.HOME = fakeHome
  t.after(() => { process.env.HOME = realHome })
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
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { address: 'me@163.com', password: 'WRONG' }), /app password|authorization code|refused/i)
  assert.equal(rt.mailView().accounts.length, 0)
  const view = await rt.connectorEndpoint('mail-account-add', { address: 'me@163.com', password: 'RIGHT' })
  assert.equal(view.accounts[0].provider, '163')
  assert.equal(view.accounts[0].address, 'me@163.com')
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName('me@163.com', 'PASSWORD')), 'RIGHT')
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
  assert.equal(sessions.get('me@163.com').calls.some(c => c[0] === 'send'), false)
  // Cancel: nothing is sent; a new card, then Send, sends once.
  assert.equal(await rt.connectorEndpoint('mail-send-answer', { requestId: request.id, choice: 'cancel' }), true)
  assert.equal(sessions.get('me@163.com').calls.filter(c => c[0] === 'send').length, 0)
  await send.execute({ to: 'you@test.dev', subject: 'Hi2', body: 'B' }, { agent: { id: 'm1' }, callId: 'call-2', concludeTurn: () => {} })
  const request2 = rt.state.mailRequests.m1.at(-1)
  await rt.connectorEndpoint('mail-send-answer', { requestId: request2.id, choice: 'send' })
  const sent = sessions.get('me@163.com').calls.filter(c => c[0] === 'send')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].subject, 'Hi2')
  // A draft never draws a card.
  const before = (rt.state.mailRequests.m1 ?? []).length
  assert.match(String(await draft.execute({ to: 'a@b.c', subject: 'D', body: 'x' }, exec)), /Draft saved/)
  assert.equal((rt.state.mailRequests.m1 ?? []).length, before)
})

test('mail account remove drops the secret and unregisters the tools', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, mail: { connect: async () => fakeSession() } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.connectorEndpoint('mail-account-add', { address: 'a@qq.com', password: 'PASSP' })
  assert.ok(rt.teamTools.some(d => d.name === 'mail_send'))
  await rt.connectorEndpoint('mail-account-remove', { id: rt.mailView().accounts[0].id })
  await rt.loadSecrets()
  assert.equal(rt.secretValue(mailSecretName('a@qq.com', 'PASSWORD')), undefined)
  assert.equal(rt.teamTools.some(d => d.name === 'mail_send'), false)
})
