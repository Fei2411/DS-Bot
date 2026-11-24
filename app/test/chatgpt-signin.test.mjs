import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ChatGPTSignInError, createChatGPTSignIn } from '../src/chatgpt-signin.mjs'
import { createChatGPTStore } from '../src/chatgpt-store.mjs'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const encryptionKey = randomBytes(32)
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(text) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decryptString(buffer) {
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, buffer.subarray(0, 12))
    cipher.setAuthTag(buffer.subarray(12, 28))
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8')
  },
}
const typed = (state, code) => error => {
  assert.ok(error instanceof ChatGPTSignInError)
  assert.equal(error.state, state)
  if (code) assert.equal(error.code, code)
  assert.doesNotMatch(error.message + error.stack, /synthetic-(access|refresh|code)|eyJ/u)
  return true
}

test('state changes are published without credentials, including sign-in and sign-out', async t => {
  const changes = []
  const f = await fixture(t, { client: { onChange: status => changes.push(status) } })
  await f.login()
  await f.client.signOut()
  assert.deepEqual(changes.map(status => status.state), ['signing-in', 'connected', 'signed-out'])
  assert.doesNotMatch(JSON.stringify(changes), /synthetic-(access|refresh|code)|eyJ/u)
})

async function fixture(t, options = {}) {
  const userData = await fs.mkdtemp(join(tmpdir(), 'ds-bot-chatgpt-'))
  const forms = []
  const requests = []
  let authorization
  let clock = Date.now()
  let refreshCount = 0
  const behavior = { ...options }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const form = new URLSearchParams(Buffer.concat(chunks).toString())
    forms.push({ path: req.url, form })
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/discovery') return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` })
    if (req.url === '/jwks') return send({ keys: [jwk] })
    if (req.url === '/token') {
      const refreshing = form.get('grant_type') === 'refresh_token'
      if (refreshing) {
        refreshCount++
        if (behavior.refreshStatus) return send({ error: behavior.refreshError ?? 'server_error' }, behavior.refreshStatus)
        if (behavior.refreshDelay) await new Promise(resolve => setTimeout(resolve, behavior.refreshDelay))
      }
      const seconds = clock / 1000
      const claims = { iss: base, aud: 'issued-client', sub: 'synthetic-account', email: 'person@example.test', name: 'Test Person',
        exp: seconds + 3600, iat: seconds, nonce: authorization?.searchParams.get('nonce'), ...behavior.claims }
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...behavior.jwtHeader })).toString('base64url')
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
      const idToken = `${header}.${payload}.${behavior.badSignature ? Buffer.alloc(256).toString('base64url') : signature}`
      return send({ access_token: refreshing ? 'synthetic-access-rotated' : 'synthetic-access', refresh_token: refreshing ? 'synthetic-refresh-rotated' : 'synthetic-refresh',
        token_type: 'Bearer', expires_in: 3600, scope: behavior.scope ?? scope, ...(!refreshing ? { id_token: idToken } : {}), ...behavior.tokens })
    }
    if (req.url === '/revoke') { res.writeHead(behavior.revokeStatus ?? 200); res.end(); return }
    if (req.url === '/models') {
      if (behavior.modelsStatus) return send({ error: 'server_error' }, behavior.modelsStatus)
      assert.equal(req.headers.authorization, `Bearer ${refreshCount ? 'synthetic-access-rotated' : 'synthetic-access'}`)
      return send({ models: behavior.models ?? [{ slug: 'z-model', display_name: 'Z', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }, { slug: 'a-model', display_name: 'A', visibility: 'list' }] })
    }
    send({}, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(userData, { recursive: true, force: true }) })
  const clientOptions = { userData, safeStorage, platform: 'darwin', discoveryUrl: `${base}/discovery`, endpoints: { models_endpoint: `${base}/models` },
    now: () => clock, fetch: async (url, init) => {
      requests.push({ url, init })
      assert.equal(init.redirect, 'manual')
      if (behavior.networkError && url.endsWith('/token')) throw new Error('synthetic-refresh must not leak')
      if (behavior.redirect && url.endsWith(behavior.redirect)) return new Response(null, { status: 302, headers: { location: `${base}/leak` } })
      return fetch(url, init)
    }, ...options.client }
  const client = await createChatGPTSignIn(clientOptions)
  const callbackUrl = (url, overrides = {}) => {
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state'),
      ...(!url.searchParams.has('agent_name_hint') ? {} : { client_id: 'issued-client' }), ...overrides }).toString()
    return callback
  }
  const login = (overrides = {}, signinOptions = {}) => client.signIn({ ...signinOptions, openExternal: async value => {
    authorization = new URL(value)
    await fetch(callbackUrl(authorization, overrides))
  } })
  const stored = async () => JSON.parse(safeStorage.decryptString(await fs.readFile(join(userData, 'chatgpt-signin.enc'))))
  return { client, login, stored, userData, behavior, forms, requests, clientOptions, callbackUrl,
    captureAuthorization: value => { authorization = new URL(value); return authorization },
    get authorization() { return authorization }, get refreshCount() { return refreshCount }, advance: ms => { clock += ms } }
}

test('first registration persists encrypted credentials, PKCE, account, scopes and host before opening browser', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.client.status(), { state: 'signed-out' })
  await f.login()
  const params = f.authorization.searchParams
  assert.equal(params.get('client_id'), 'dynamic_agent_client')
  assert.equal(params.get('agent_name_hint'), 'DS Bot')
  assert.equal(params.get('resource'), 'https://api.openai.com/v1')
  assert.equal(params.get('scope'), scope)
  assert.equal(params.get('code_challenge_method'), 'S256')
  const form = f.forms.find(x => x.path === '/token').form
  assert.equal(form.get('client_id'), 'issued-client')
  assert.equal(form.get('code'), 'synthetic-code')
  assert.equal(form.get('redirect_uri'), params.get('redirect_uri'))
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), params.get('code_challenge'))
  assert.equal(form.has('client_secret'), false)
  const stored = await f.stored()
  assert.equal(stored.hostId, params.get('ext_agent_host_id'))
  assert.equal(stored.clientId, 'issued-client')
  assert.deepEqual(f.client.status(), { state: 'connected', account: { email: 'person@example.test', name: 'Test Person' }, planUsage: true, expiresAt: stored.tokens.expiresAt })
  assert.equal(await f.client.getAccessToken(), 'synthetic-access')
  const disk = await fs.readFile(join(f.userData, 'chatgpt-signin.enc'))
  assert.equal(disk.includes(Buffer.from('synthetic-access')), false)
  if (process.platform !== 'win32') assert.equal((await fs.stat(join(f.userData, 'chatgpt-signin.enc'))).mode & 0o777, 0o600)
  assert.ok(f.requests.every(x => !x.url.includes('synthetic-')))
})

test('reauthentication reuses issued client, host and login hints across restarts and adds consent only on request', async t => {
  const f = await fixture(t)
  await f.login()
  const first = await f.stored()
  await f.login({}, { consent: true })
  const params = f.authorization.searchParams
  assert.equal(params.get('client_id'), first.clientId)
  assert.equal(params.get('ext_agent_host_id'), first.hostId)
  assert.equal(params.get('id_token_hint'), first.tokens.idToken)
  assert.equal(params.get('login_hint'), 'person@example.test')
  assert.equal(params.has('agent_name_hint'), false)
  assert.equal(params.get('prompt'), 'consent')
  const restarted = await createChatGPTSignIn(f.clientOptions)
  assert.equal(await restarted.getAccessToken(), 'synthetic-access')
})

test('mismatched state fails without exchanging a code', async t => {
  const f = await fixture(t)
  await assert.rejects(f.login({ state: 'wrong' }), typed('signed-out', 'invalid-callback'))
  assert.equal(f.forms.some(x => x.path === '/token'), false)
})

test('new registration requires an issued client ID and a denied grant never exchanges a code', async t => {
  for (const overrides of [{ client_id: '' }, { client_id: 'dynamic_agent_client' }, { error: 'access_denied' }]) {
    const f = await fixture(t)
    await assert.rejects(f.login(overrides), error => error instanceof ChatGPTSignInError)
    assert.equal(f.forms.some(x => x.path === '/token'), false)
    assert.equal((await f.stored()).tokens, undefined)
  }
})

test('an empty session cannot expose a token, refresh, or list models', async t => {
  const f = await fixture(t)
  await assert.rejects(f.client.getAccessToken(), typed('signed-out'))
  await assert.rejects(f.client.listModels(), typed('signed-out'))
  await assert.rejects(f.client.refresh(), typed('needs-sign-in'))
  assert.deepEqual(await fs.readdir(f.userData), [])
})

test('callback rejects wrong Host, path and method, then accepts a valid callback only once', async t => {
  const f = await fixture(t)
  await f.client.signIn({ openExternal: async value => {
    const url = f.captureAuthorization(value)
    const callback = f.callbackUrl(url)
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(callback, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(status, 400)
    assert.equal((await fetch(callback, { method: 'POST' })).status, 400)
    const wrongPath = new URL(callback); wrongPath.pathname = '/callback'
    assert.equal((await fetch(wrongPath)).status, 400)
    assert.equal((await fetch(callback)).status, 200)
    assert.equal((await fetch(callback)).status, 400)
  } })
})

for (const [name, options] of [
  ['nonce mismatch', { claims: { nonce: 'wrong' } }], ['bad signature', { badSignature: true }],
  ['wrong issuer', { claims: { iss: 'https://wrong.example' } }], ['wrong audience', { claims: { aud: 'wrong' } }],
  ['expired ID token', { claims: { exp: 1 } }], ['future issuance', { claims: { iat: Date.now() / 1000 + 600 } }],
  ['wrong algorithm', { jwtHeader: { alg: 'HS256' } }],
]) test(`rejects ${name}`, async t => {
  const f = await fixture(t, options)
  await assert.rejects(f.login(), typed('needs-sign-in', 'invalid-identity'))
  assert.equal((await f.stored()).tokens, undefined)
})

test('missing plan scope connects identity but blocks plan access', async t => {
  const f = await fixture(t, { scope: 'openid profile email' })
  assert.equal((await f.login()).state, 'plan-usage-off')
  await assert.rejects(f.client.getAccessToken(), typed('plan-usage-off', 'plan-usage-required'))
})

test('reauthentication rejects a different account or client without replacing the saved credentials', async t => {
  const f = await fixture(t)
  await f.login()
  const first = await f.stored()
  f.behavior.claims = { sub: 'other-account' }
  await assert.rejects(f.login(), typed('needs-sign-in', 'invalid-identity'))
  assert.deepEqual(await f.stored(), first)
  await assert.rejects(f.client.getAccessToken(), typed('needs-sign-in'))
  f.behavior.claims = {}
  await assert.rejects(f.login({ client_id: 'other-client' }), typed('needs-sign-in', 'invalid-client'))
})

test('refresh rotates atomically before use, coalesces concurrent callers, and refreshes within five minutes', async t => {
  const f = await fixture(t, { refreshDelay: 10 })
  await f.login()
  f.advance(56 * 60_000)
  const tokens = await Promise.all(Array.from({ length: 8 }, () => f.client.getAccessToken()))
  assert.deepEqual(tokens, Array(8).fill('synthetic-access-rotated'))
  assert.equal(f.refreshCount, 1)
  assert.equal((await f.stored()).tokens.refreshToken, 'synthetic-refresh-rotated')
  const form = f.forms.filter(x => x.path === '/token').at(-1).form
  assert.equal(form.get('refresh_token'), 'synthetic-refresh')
  assert.equal(form.get('resource'), 'https://api.openai.com/v1')
  assert.equal(form.get('client_id'), 'issued-client')
  assert.equal(form.has('scope'), false)
  assert.equal((await f.client.refresh()).state, 'connected')
  assert.equal(f.refreshCount, 2)
})

for (const error of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
  test(`terminal refresh error ${error} clears only tokens`, async t => {
    const f = await fixture(t)
    await f.login()
    const first = await f.stored()
    f.behavior.refreshStatus = 400; f.behavior.refreshError = error
    await assert.rejects(f.client.refresh(), typed('needs-sign-in', 'refresh-rejected'))
    const stored = await f.stored()
    assert.equal(stored.tokens, undefined)
    assert.equal(stored.clientId, first.clientId)
    assert.equal(stored.hostId, first.hostId)
    assert.equal(stored.subject, first.subject)
    assert.equal(f.client.status().state, 'needs-sign-in')
    assert.equal((await createChatGPTSignIn(f.clientOptions)).status().state, 'needs-sign-in')
  })
}

for (const kind of ['server', 'network', 'redirect']) test(`${kind} refresh failure preserves credentials and sanitizes errors`, async t => {
  const f = await fixture(t)
  await f.login()
  const first = await f.stored()
  if (kind === 'server') f.behavior.refreshStatus = 503
  if (kind === 'network') f.behavior.networkError = true
  if (kind === 'redirect') f.behavior.redirect = '/token'
  await assert.rejects(f.client.refresh(), typed('temporarily-unavailable'))
  assert.deepEqual(await f.stored(), first)
  assert.equal(f.client.status().state, 'temporarily-unavailable')
  assert.equal(f.requests.some(x => x.url.endsWith('/leak')), false)
})

test('lists only visible models in server order and handles an empty list', async t => {
  const f = await fixture(t)
  await f.login()
  assert.deepEqual(await f.client.listModels(), [{ id: 'z-model', name: 'Z' }, { id: 'a-model', name: 'A' }])
  f.behavior.models = []
  assert.deepEqual(await f.client.listModels(), [])
  f.behavior.redirect = '/models'
  await assert.rejects(f.client.listModels(), typed('temporarily-unavailable', 'redirect-refused'))
})

for (const operation of ['token', 'models', 'empty models']) test(`successful ${operation} restores connected status after a temporary failure without refreshing`, async t => {
  const changes = []
  const f = await fixture(t, { client: { onChange: status => changes.push(status.state) } })
  await f.login()
  const first = await f.stored()
  f.behavior.modelsStatus = 503
  await assert.rejects(f.client.listModels(), typed('temporarily-unavailable'))
  assert.equal(f.client.status().state, 'temporarily-unavailable')
  f.behavior.modelsStatus = undefined
  if (operation === 'empty models') f.behavior.models = []
  if (operation === 'token') assert.equal(await f.client.getAccessToken(), first.tokens.accessToken)
  else assert.equal((await f.client.listModels()).length, operation === 'empty models' ? 0 : 2)
  assert.equal(f.client.status().state, 'connected')
  assert.deepEqual(changes.slice(-2), ['temporarily-unavailable', 'connected'])
  assert.equal(f.refreshCount, 0)
  assert.deepEqual(await f.stored(), first)
})

test('recovering token access restores plan-usage-off without granting inference permission', async t => {
  const f = await fixture(t, { scope: 'openid profile email offline_access resource.invoke' })
  await f.login()
  f.behavior.refreshStatus = 503
  await assert.rejects(f.client.refresh(), typed('temporarily-unavailable'))
  await assert.rejects(f.client.getAccessToken(), typed('plan-usage-off', 'plan-usage-required'))
  assert.equal(f.client.status().state, 'plan-usage-off')
})

for (const unavailable of [{ isEncryptionAvailable: () => false }, { getSelectedStorageBackend: () => 'basic_text' }]) {
  test('unsupported secure storage performs no filesystem writes or network calls', async () => {
    const client = await createChatGPTSignIn({ userData: '/unused', safeStorage: { ...safeStorage, ...unavailable }, platform: 'linux',
      fs: new Proxy({}, { get() { assert.fail('filesystem must not be accessed') } }), fetch: () => assert.fail('network must not be accessed') })
    assert.deepEqual(client.status(), { state: 'unsupported' })
    await assert.rejects(client.signIn({ openExternal: () => assert.fail('browser must not open') }), typed('unsupported'))
    await assert.rejects(client.getAccessToken(), typed('unsupported'))
  })
}

for (const revokeStatus of [200, 503]) test(`signOut clears local tokens and reports revocation HTTP ${revokeStatus}`, async t => {
  const f = await fixture(t, { revokeStatus })
  await f.login()
  const first = await f.stored()
  const result = await f.client.signOut()
  assert.equal(result.remoteRevocationConfirmed, revokeStatus === 200)
  assert.equal(result.state, 'signed-out')
  const stored = await f.stored()
  assert.equal(stored.tokens, undefined)
  assert.equal(stored.clientId, first.clientId)
  assert.equal(stored.hostId, first.hostId)
  const form = f.forms.find(x => x.path === '/revoke').form
  assert.equal(form.get('token'), 'synthetic-refresh')
  assert.equal(form.get('token_type_hint'), 'refresh_token')
  assert.equal(form.get('client_id'), 'issued-client')
  await f.login()
  assert.equal(f.authorization.searchParams.has('id_token_hint'), false)
})

test('cancellation and timeout close callback listener without exchanging a code', async t => {
  for (const abort of [true, false]) {
    const f = await fixture(t, { client: { timeoutMs: abort ? 300_000 : 200 } })
    const controller = new AbortController()
    let callback
    await assert.rejects(f.client.signIn({ signal: controller.signal, openExternal: value => {
      callback = new URL(value).searchParams.get('redirect_uri')
      assert.equal(f.client.status().state, 'signing-in')
      if (abort) controller.abort(new Error('synthetic-refresh must not leak'))
    } }), typed('signed-out', 'sign-in-cancelled'))
    await assert.rejects(fetch(callback))
    assert.equal(f.forms.some(x => x.path === '/token'), false)
  }
})

test('atomic store failure preserves previous ciphertext and removes temporary files', async t => {
  const f = await fixture(t)
  await f.login()
  const first = await f.stored()
  const failingFs = { ...fs, rename: async () => { throw new Error('synthetic-refresh must not leak') } }
  const store = createChatGPTStore({ userData: f.userData, safeStorage, fs: failingFs })
  await assert.rejects(store.write({ ...first, tokens: {} }), { message: 'ChatGPT credentials could not be stored or read securely.' })
  assert.deepEqual(await f.stored(), first)
  assert.deepEqual(await fs.readdir(f.userData), ['chatgpt-signin.enc'])
})

test('failed refresh persistence never returns the replacement access token', async t => {
  const f = await fixture(t)
  await f.login()
  const failing = await createChatGPTSignIn({ ...f.clientOptions, fs: { ...fs, rename: async () => { throw new Error('disk unavailable') } } })
  f.advance(56 * 60_000)
  await assert.rejects(failing.getAccessToken(), typed('temporarily-unavailable', 'secure-storage-failed'))
  await assert.rejects(failing.getAccessToken(), typed('temporarily-unavailable', 'secure-storage-failed'))
  await assert.rejects(failing.refresh(), typed('temporarily-unavailable', 'secure-storage-failed'))
  assert.equal(f.refreshCount, 1)
  assert.equal((await f.stored()).tokens.accessToken, 'synthetic-access')
})

test('malformed refresh response is a typed failure and preserves the last saved token set', async t => {
  const f = await fixture(t)
  await f.login()
  const first = await f.stored()
  f.behavior.tokens = { token_type: 123 }
  await assert.rejects(f.client.refresh(), typed('temporarily-unavailable', 'invalid-token-response'))
  assert.deepEqual(await f.stored(), first)
})

test('corrupt encrypted storage fails closed without overwriting it', async t => {
  const f = await fixture(t)
  const file = join(f.userData, 'chatgpt-signin.enc')
  const corrupt = Buffer.from('not an encrypted record')
  await fs.writeFile(file, corrupt)
  const client = await createChatGPTSignIn(f.clientOptions)
  assert.equal(client.status().state, 'temporarily-unavailable')
  await assert.rejects(client.signIn({ openExternal: () => assert.fail('must not open browser') }), typed('temporarily-unavailable', 'secure-storage-failed'))
  assert.deepEqual(await fs.readFile(file), corrupt)
})
