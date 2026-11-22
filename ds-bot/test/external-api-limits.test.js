import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createApiAuth, normalizeConfig } from '../src/host/api/auth.js'
import { createApiRoutes, UPLOAD_BODY_LIMIT } from '../src/host/api/routes.js'

function authHarness(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-limits-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const auth = createApiAuth({ home, botOf: () => undefined, roomOf: () => undefined })
  const created = auth.createToken({ name: 'Limited', targetScope: 'all_public' })
  const req = (token = created.token, address = '127.0.0.1') => ({
    headers: { host: 'localhost', authorization: `Bearer ${token}` }, url: '/v1/health',
    socket: { remoteAddress: address },
  })
  return { auth, created, req, home }
}

test('default token limits are finite, apply to old tokens, and can be raised', async t => {
  assert.equal(normalizeConfig({}).rateLimitPerMin, 120)
  assert.equal(normalizeConfig({}).maxConcurrentRuns, 4)
  assert.equal(normalizeConfig({ rateLimitPerMin: null, maxConcurrentRuns: null }).maxConcurrentRuns, 4)
  const { auth, created, req } = authHarness(t)
  assert.equal(created.meta.rateLimitPerMin, 120)
  assert.equal(created.meta.maxConcurrentRuns, 4)
  auth.updateToken(created.meta.keyId, { rateLimitPerMin: null, maxConcurrentRuns: null })
  const { token: principal } = await auth.authenticate(req())
  assert.equal(principal.rateLimitPerMin, 120)
  const slots = Array.from({ length: 4 }, () => auth.acquireRunSlot(principal))
  assert.ok(slots.every(slot => slot.ok))
  assert.equal(auth.acquireRunSlot(principal).status, 429)
  slots[0].release()
  const next = auth.acquireRunSlot(principal)
  assert.equal(next.ok, true)
  next.release()
  for (const slot of slots) slot.release()
  for (let i = 0; i < 120; i += 1) assert.equal(auth.checkRateLimit(principal).ok, true)
  assert.equal(auth.checkRateLimit(principal).status, 429)
  auth.updateToken(created.meta.keyId, { rateLimitPerMin: 240, maxConcurrentRuns: 8 })
  const raised = await auth.authenticate(req())
  assert.equal(raised.token.rateLimitPerMin, 240)
  assert.equal(raised.token.maxConcurrentRuns, 8)
  auth.updateConfig({ rateLimitPerMin: 300, maxConcurrentRuns: 12 })
  assert.equal(auth.createToken({ name: 'Configured' }).meta.maxConcurrentRuns, 12)
})

test('verification is asynchronous, cached briefly, and invalidated by token changes', async t => {
  const { auth, created, req, home } = authHarness(t)
  let derivations = 0
  const hook = createHook({ init: (_id, type) => { if (type === 'SCRYPTREQUEST') derivations += 1 } })
  hook.enable()
  t.after(() => hook.disable())
  let ticked = false
  setImmediate(() => { ticked = true })
  assert.equal((await auth.authenticate(req())).ok, true)
  assert.equal(ticked, true, 'scrypt yields to the event loop')
  assert.equal(derivations, 1)
  assert.equal((await auth.authenticate(req())).ok, true)
  assert.equal(derivations, 1, 'successful verification is cached')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(30_001)
  assert.equal((await auth.authenticate(req())).ok, true)
  assert.equal(derivations, 2, 'cache expires')
  auth.updateToken(created.meta.keyId, { paused: true })
  assert.equal((await auth.authenticate(req())).status, 403)
  auth.updateToken(created.meta.keyId, { paused: false, name: 'Changed' })
  assert.equal((await auth.authenticate(req())).token.name, 'Changed')
  assert.equal(derivations, 4, 'pause and token changes invalidate cache')
  const path = join(home, 'api-tokens.json')
  const entries = JSON.parse(readFileSync(path, 'utf8'))
  entries[0].hash = '0'.repeat(64)
  writeFileSync(path, JSON.stringify(entries))
  assert.equal((await auth.authenticate(req())).status, 401, 'external hash changes invalidate cache')
  assert.equal(derivations, 5)
  auth.revokeToken(created.meta.keyId)
  assert.equal((await auth.authenticate(req())).status, 401)
})

test('failed-auth attempts are bounded before scrypt and isolated per remote address', async t => {
  const { auth, created, req } = authHarness(t)
  let derivations = 0
  const hook = createHook({ init: (_id, type) => { if (type === 'SCRYPTREQUEST') derivations += 1 } })
  hook.enable()
  t.after(() => hook.disable())
  const wrong = `${created.token.slice(0, created.token.lastIndexOf('_') + 1)}wrong`
  const attempts = await Promise.all(Array.from({ length: 11 }, () => auth.authenticate(req(wrong, 'attacker'))))
  assert.equal(attempts.filter(result => result.status === 429).length, 1)
  assert.equal(derivations, 10)
  const count = derivations
  const denied = await auth.authenticate(req(created.token, 'attacker'))
  assert.equal(denied.status, 429)
  assert.ok(denied.details.retryAfterMs > 0)
  assert.equal(derivations, count)
  assert.equal((await auth.authenticate(req(created.token, 'other'))).ok, true)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(60_001)
  assert.equal((await auth.authenticate(req(created.token, 'attacker'))).ok, true)
})

test('unauthenticated browser traffic never consumes the failed-secret budget', async t => {
  const { auth, created, req } = authHarness(t)
  for (let i = 0; i < 20; i += 1) {
    for (const token of ['', 'garbage', 'dsb_', 'dsb_live_no-secret', 'dsb_live_id_', 'dsb_live_missing_secret']) {
      assert.equal((await auth.authenticate(req(token))).status, 401)
    }
    const missing = req()
    delete missing.headers.authorization
    assert.equal((await auth.authenticate(missing)).status, 401)
    const origin = req()
    origin.headers.origin = 'https://attacker.example'
    assert.equal((await auth.authenticate(origin)).status, 403)
    const host = req()
    host.headers.host = '127.attacker.example'
    assert.equal((await auth.authenticate(host)).status, 403)
  }
  assert.equal((await auth.authenticate(req(created.token))).ok, true)
})

test('a full failed-auth address table evicts its oldest entry', async t => {
  const { auth, created, req, home } = authHarness(t)
  const path = join(home, 'api-tokens.json')
  const tokens = JSON.parse(readFileSync(path, 'utf8'))
  tokens.push({ keyId: 'legacy', hashAlgo: 'sha256-raw', hash: createHash('sha256').update('dsb_correct').digest('hex'), scopes: ['read'] })
  writeFileSync(path, JSON.stringify(tokens))
  for (let i = 0; i < 1024; i += 1) {
    assert.equal((await auth.authenticate(req('dsb_unknown', `address-${i}`))).status, 401)
  }
  assert.equal((await auth.authenticate(req(created.token, 'new-address'))).ok, true)
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await auth.authenticate(req('dsb_unknown', 'address-0'))).status, 401)
  }
  assert.equal((await auth.authenticate(req(created.token, 'address-0'))).status, 429)
})

test('legacy raw sha256 tokens still verify asynchronously', async t => {
  const { auth, home, req } = authHarness(t)
  const token = 'dsb_legacy_test'
  writeFileSync(join(home, 'api-tokens.json'), JSON.stringify([{
    keyId: 'legacy', hashAlgo: 'sha256-raw',
    hash: createHash('sha256').update(token).digest('hex'), scopes: ['read'],
  }]))
  assert.equal((await auth.authenticate(req(token))).ok, true)
  assert.equal((await auth.authenticate(req(token))).ok, true)
})

test('staged uploads enforce per-token count and byte budgets', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-uploads-'))
  const routes = createApiRoutes({ home, ctx: {}, state: {} }, { auth: {}, runs: {}, sseClients: new Set() })
  t.after(() => { routes.dispose(); rmSync(home, { recursive: true, force: true }) })
  const upload = async (keyId, bytes) => {
    const req = Readable.from([bytes])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/octet-stream' }
    const res = { writeHead(status) { this.status = status }, end() {} }
    await routes.handleV1(req, res, new URL('http://localhost/v1/uploads'), { keyId, hasScope: () => true }, {})
    return res.status
  }
  await assert.rejects(() => upload('empty', Buffer.alloc(0)), error => error.status === 400)
  for (let i = 0; i < 20; i += 1) assert.equal(await upload('count', Buffer.from('x')), 201)
  await assert.rejects(() => upload('count', Buffer.from('x')), error => error.status === 429)
  const chunk = Buffer.alloc(UPLOAD_BODY_LIMIT)
  for (let i = 0; i < 4; i += 1) assert.equal(await upload('bytes', chunk), 201)
  await assert.rejects(() => upload('bytes', Buffer.from('x')), error => error.status === 413)
  assert.equal(await upload('separate', Buffer.from('x')), 201)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(30 * 60_000 + 1)
  assert.equal(await upload('count', Buffer.from('x')), 201)
  assert.equal(await upload('bytes', Buffer.from('x')), 201)
})
