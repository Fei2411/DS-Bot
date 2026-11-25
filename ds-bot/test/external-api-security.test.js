import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { request } from 'node:http'
import { createRuntime } from '../index.js'
import { isLoopbackHost } from '../src/host/api/auth.js'
import { homeLock } from '../src/host/home-lock.js'
import { fakeContext } from './fake-ctx.js'

function startHost(home, state) {
  if (state) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  ctx.workspaceRegistry = { get: () => undefined, list: () => [] }
  ctx.sessions = { flush: async () => {}, rename: async () => {} }
  ctx.sessionController = {
    resolveAgent: async sid => ({ agent: { id: sid, session: { id: sid, header: { cwd: home }, snapshotEvents: () => [] }, followup() {}, cancel() {} } }),
    page: async () => ({ records: [], hasMore: false }),
    prompt: async ({ requestId, sessionId, content }) => {
      const ev = { type: 'user/message', seq: 1, time: Date.now(), data: { content, source: { kind: 'user', rpcId: requestId } } }
      for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, ev)
      setTimeout(() => {
        for (const listener of ctx.listeners.get('session/event') ?? []) {
          listener({ id: sessionId }, { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 1 } })
          listener({ id: sessionId }, { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'SENSITIVE_REPLY_BODY' }] } } })
          listener({ id: sessionId }, { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
        }
      }, 10)
    },
  }
  const rt = createRuntime(ctx, { home })
  return { ctx, rt }
}

test('loopback hosts require literal addresses and malformed Host headers return 400', async t => {
  const accepted = ['127.0.0.1:17830', '127.42.0.2', 'localhost:17830', '[::1]:17830', '::1', 'LOCALHOST']
  const rejected = ['127.attacker.example', '127.0.0.1.evil.com', 'localhost.evil', '127.999.1.1', '127.1', '[::1]evil', '[::1]:bad', 'localhost:65536', 'localhost@evil.com', '192.168.1.1', '0.0.0.0', '']
  for (const host of accepted) assert.equal(isLoopbackHost(host), true, host)
  for (const host of rejected) assert.equal(isLoopbackHost(host), false, host)
  const home = mkdtempSync(join(tmpdir(), 'dsb-apihost-'))
  const { ctx, rt } = startHost(home, {
    version: 1, mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', createdAt: 1 } },
    rooms: {}, exchanges: [], exchangeTurns: {}, revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  assert.equal(view.lanExposed, false)
  const { token } = await rt.apiEndpoint('api-token-create', { name: 'Host guard', scopes: ['read'], targetScope: 'all_public' })
  const statusForHost = host => new Promise((resolve, reject) => {
    const req = request(`${view.baseUrl}/v1/health`, { headers: { Host: host, Authorization: `Bearer ${token}` } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  for (const host of ['127.attacker.example', '127.0.0.1.evil.com', 'localhost.evil']) {
    assert.equal(await statusForHost(host), 403, host)
  }
  for (const host of ['[::1', 'localhost:bad', '[::1]:999999']) {
    assert.equal(await statusForHost(host), 400, host)
  }
  for (const host of ['127.0.0.1:17830', 'localhost:17830', '[::1]:17830']) {
    assert.equal(await statusForHost(host), 200, host)
  }
})

test('failed HTTP authentication returns Retry-After after ten attempts', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-auth-limit-'))
  const { ctx, rt } = startHost(home)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await rt.apiEndpoint('api-token-create', { name: 'Auth limit', scopes: ['read'], targetScope: 'all_public' })
  const headers = { Authorization: `Bearer ${token}` }
  const health = headers => new Promise((resolve, reject) => {
    const req = request(`${view.baseUrl}/v1/health`, { headers }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
  for (let i = 0; i < 12; i += 1) {
    for (const rejectedHeaders of [{}, { ...headers, Origin: 'https://attacker.example' }, { ...headers, Host: '127.attacker.example' }]) {
      const response = await health(rejectedHeaders)
      assert.ok([401, 403].includes(response.status), `status=${response.status} rejected headers=${Object.keys(rejectedHeaders).join(',')}`)
    }
  }
  const valid = await health(headers)
  assert.equal(valid.status, 200)
  const wrong = { Authorization: `Bearer ${token.slice(0, token.lastIndexOf('_') + 1)}wrong` }
  for (let i = 0; i < 10; i += 1) {
    const response = await health(wrong)
    assert.equal(response.status, 401)
  }
  const response = await health(wrong)
  assert.equal(response.status, 429)
  assert.ok(Number(response.headers['retry-after']) > 0)
})

test('default off, auth rejections, query token rejection, DNS rebinding, and rate limits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apisec-'))
  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()

  // Default OFF: no endpoint file, status off
  assert.equal(rt.apiView().status, 'off')
  assert.equal(existsSync(join(home, 'api-endpoint.json')), false)

  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  assert.equal(view.status, 'running')

  const { token, meta } = await rt.apiEndpoint('api-token-create', {
    name: 'Scoped',
    scopes: ['read', 'message'],
    targetScope: 'all_public',
    rateLimitPerMin: 3,
  })

  // No token -> 401
  assert.equal((await fetch(`${view.baseUrl}/v1/bots`)).status, 401)
  // Wrong token -> 401
  assert.equal((await fetch(`${view.baseUrl}/v1/bots`, { headers: { Authorization: 'Bearer dsb_live_deadbeef_wrong' } })).status, 401)
  // Token in URL query -> 401 even if header is valid
  assert.equal((await fetch(`${view.baseUrl}/v1/bots?token=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
  // Browser Origin header -> 403
  assert.equal((await fetch(`${view.baseUrl}/v1/bots`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403)
  // Non-loopback Host header (DNS rebinding) -> 403 via raw node:http request
  const { request } = await import('node:http')
  const rebindStatus = await new Promise((resolve, reject) => {
    const req = request(`${view.baseUrl}/v1/bots`, { headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rebindStatus, 403)

  // Rate limit: 3 allowed, 4th returns 429 with retry-after
  assert.equal((await fetch(`${view.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
  assert.equal((await fetch(`${view.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'SUPER_SECRET_USER_PROMPT', wait: 5 }),
  })).status, 200)
  const limited = await fetch(`${view.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)

  // Audit log stores metadata only — never token secret, request body, or reply text
  const auditRaw = readFileSync(join(home, 'api-audit.jsonl'), 'utf8')
  assert.ok(auditRaw.includes(meta.keyId))
  assert.equal(auditRaw.includes(token), false)
  assert.equal(auditRaw.includes('SUPER_SECRET_USER_PROMPT'), false)
  assert.equal(auditRaw.includes('SENSITIVE_REPLY_BODY'), false)

  // Token file stores hash only — never plaintext secret
  const tokensRaw = readFileSync(join(home, 'api-tokens.json'), 'utf8')
  assert.equal(tokensRaw.includes(token), false)

  // Pause & revoke enforcement
  await rt.apiEndpoint('api-token-update', { keyId: meta.keyId, paused: true })
  assert.equal((await fetch(`${view.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 403)
  await rt.apiEndpoint('api-token-revoke', { keyId: meta.keyId })
  assert.equal((await fetch(`${view.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
})

test('private Bot hard isolation, dynamic privacy flip revocation, and privacy.js protection of api-tokens.json', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apipriv-'))
  const privDir = join(home, 'priv-bot')
  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 },
      b2: { id: 'b2', name: 'Worker', role: 'Dev', createdAt: 2 },
      bp: { id: 'bp', name: 'Vault', role: 'Private', private: true, workDir: privDir, createdAt: 3 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })

  // all_public token never sees private Bot and receives 404 by ID (does not leak existence)
  const { token: pubToken } = await rt.apiEndpoint('api-token-create', {
    name: 'PublicAll',
    scopes: ['read', 'message'],
    targetScope: 'all_public',
  })
  const list = await fetch(`${view.baseUrl}/v1/bots`, { headers: { Authorization: `Bearer ${pubToken}` } }).then(r => r.json())
  assert.deepEqual(list.bots.map(b => b.id).sort(), ['b1', 'b2'])
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/bp`, { headers: { Authorization: `Bearer ${pubToken}` } })).status, 404)
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/bp/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pubToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'ping' }),
  })).status, 404)

  // Dynamically turning b2 private immediately revokes access for existing all_public token
  rt.state.bots.b2.private = true
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/b2`, { headers: { Authorization: `Bearer ${pubToken}` } })).status, 404)

  // Explicit confirmation is required to authorize a private Bot
  await assert.rejects(
    () => rt.apiEndpoint('api-token-create', { name: 'BadPriv', scopes: ['read'], privateBotIds: ['bp'], confirmPrivate: false }),
    /explicit confirmation/i,
  )
  const { token: privToken } = await rt.apiEndpoint('api-token-create', {
    name: 'ConfirmedPriv',
    scopes: ['read'],
    targetScope: 'selected',
    privateBotIds: ['bp'],
    confirmPrivate: true,
  })
  const privGet = await fetch(`${view.baseUrl}/v1/bots/bp`, { headers: { Authorization: `Bearer ${privToken}` } })
  assert.equal(privGet.status, 200)

  // privacy.js blocks a Bot's file/shell tools from reading api-tokens.json even if no private Bot exists
  delete rt.state.bots.bp
  rt.state.bots.b2.private = false
  const execHook = ctx.listeners.get('tools/execute')[0]
  for (const file of ['api-endpoint.json', 'api-config.json', 'api-runs.json', 'api-future.json', 'mcp.json']) {
    for (const name of ['read', 'write']) {
      await assert.rejects(() => execHook({
        name, agent: { id: 'b1', session: { id: 'b1', header: { cwd: home } } },
        arguments: { file_path: join(home, file) },
      }, () => assert.fail('protected operation ran')), /API token/i)
    }
  }
  for (const name of ['glob', 'grep']) {
    for (const path of [home, join(home, '..'), join(home, 'api-endpoint.json')]) {
      await assert.rejects(() => execHook({
        name, agent: { id: 'b1', session: { id: 'b1', header: { cwd: home } } },
        arguments: { path, pattern: '*' },
      }, () => assert.fail('protected search ran')), /API token/i)
    }
  }
  await assert.rejects(
    () => execHook({
      name: 'read',
      agent: { id: 'b1', session: { id: 'b1', header: { cwd: home } } },
      arguments: { file_path: join(home, 'api-tokens.json') },
    }, () => 'should-not-run'),
    /API token/i,
  )
  await assert.rejects(
    () => execHook({
      name: 'bash',
      agent: { id: 'b1', session: { id: 'b1', header: { cwd: home } } },
      arguments: { command: 'cat api-tokens.json' },
    }, () => 'should-not-run'),
    /API token/i,
  )
})

test('read-only host does not bind port and starts automatically upon taking over state.lock', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apilock-'))
  writeFileSync(join(home, 'api-config.json'), JSON.stringify({ enabled: true, host: '127.0.0.1', port: 0 }))
  const otherLock = homeLock(join(home, 'state.lock'), { pid: process.ppid, host: 'other-host.local', isAlive: () => true })
  assert.equal(otherLock.claim(), undefined)

  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => {
    otherLock.release()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await rt.apiReconcile()

  // While another host holds the lock, this window is read-only and must not bind
  assert.equal(rt.apiView().status, 'readonly')
  assert.equal(rt.apiView().baseUrl, null)
  assert.equal(existsSync(join(home, 'api-endpoint.json')), false)

  // Release the other host's lock and refresh -> this host takes over and binds automatically
  otherLock.release()
  await rt.refresh()
  await rt.apiReconcile()
  assert.equal(rt.apiView().status, 'running')
  assert.ok(rt.apiView().baseUrl.startsWith('http://127.0.0.1:'))
})

test('API turns do not leak to IM outbound and tag apiVia instead of imVia', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apiim-'))
  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await rt.apiEndpoint('api-token-create', {
    name: 'Claude Code',
    scopes: ['read', 'message'],
    targetScope: 'all_public',
  })

  const res = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Run local check', wait: 5 }),
  })
  assert.equal(res.status, 200)
  // apiVia records the token name for chat badge rendering; imVia stays empty.
  assert.deepEqual(rt.imViaView(), {})
  assert.equal(rt.apiViaView().b1?.[1], 'Claude Code')
})

test('API group runs queue behind existing IM work without clearing its origin', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-group-origin-'))
  const { ctx, rt } = startHost(home, {
    version: 1, mainBotIds: ['b1'], bots: { b1: { id: 'b1', name: 'Chief', createdAt: 1 } },
    rooms: { r1: { id: 'r1', name: 'Group', members: ['b1'], sessionId: 'r1' } },
    exchanges: [], exchangeTurns: {}, revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  let busy = true
  let cleared = 0
  let prompted = 0
  rt.roomActive = () => busy
  rt.clearImOrigin = () => { assert.equal(busy, false); cleared += 1 }
  const prompt = ctx.sessionController.prompt
  ctx.sessionController.prompt = async args => { prompted += 1; return prompt(args) }
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await rt.apiEndpoint('api-token-create', { name: 'Group API', scopes: ['read', 'message'], targetScope: 'all_public' })
  const response = await fetch(`${view.baseUrl}/v1/groups/r1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'API-only group turn', wait: 0 }),
  })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).status, 'queued')
  assert.equal(cleared, 0)
  assert.equal(prompted, 0)
  const cancelled = await fetch(`${view.baseUrl}/v1/groups/r1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Cancel queued API work', wait: 0 }),
  }).then(result => result.json())
  rt.stopRoomWork = () => assert.fail('queued cancellation must not stop the IM round')
  assert.equal((await fetch(`${view.baseUrl}/v1/runs/${cancelled.runId}/cancel`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  })).status, 200)
  busy = false
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(cleared, 1)
  assert.equal(prompted, 1)
})

test('persisted in-flight Runs settle cleanly as stopped on host restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apirestart-'))
  writeFileSync(join(home, 'api-runs.json'), JSON.stringify({
    version: 1,
    runs: [{
      runId: 'run_old123',
      tokenId: 'k1',
      tokenName: 'Old',
      target: { kind: 'bot', id: 'b1', name: 'Chief' },
      mode: 'chat',
      status: 'running',
      createdAtMs: Date.now() - 5000,
      startedAtMs: Date.now() - 4000,
      finishedAtMs: null,
      sessionId: 'b1',
      partId: 'b1',
      output: { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
      usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
      error: null,
    }],
    idempotency: [],
  }))
  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  const view = await rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await rt.apiEndpoint('api-token-create', { name: 'Check', scopes: ['read'], targetScope: 'all_public' })

  const oldRun = await fetch(`${view.baseUrl}/v1/runs/run_old123`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
  assert.equal(oldRun.status, 'stopped')
  assert.equal(oldRun.error.code, 'api/host-restarted')
})

test('legacy v0.3.9 mcp.json migrates seamlessly into api-config/api-tokens and keeps old tokens working', async (t) => {
  const { createHash } = await import('node:crypto')
  const home = mkdtempSync(join(tmpdir(), 'dsb-mcpmig-'))
  const legacyToken = 'dsb_legacyTokenSecretValueForMigrationTest123456'
  const legacyHash = createHash('sha256').update(legacyToken).digest('hex')
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    on: true,
    port: 0, // ephemeral when migrating? note: >=1024 kept, <1024 falls back to default, so pick a free high port via 19876
    clients: [
      { id: 'c-1111', name: 'Claude Desktop', hash: legacyHash, bots: ['b1', 'bp'], rooms: [], createdAt: 1000 },
    ],
  }))
  // Pick a guaranteed free high port >= 1024 to test exact port preservation during migration
  const { createServer } = await import('node:net')
  const freePort = await new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    on: true,
    port: freePort,
    clients: [
      { id: 'c-1111', name: 'Claude Desktop', hash: legacyHash, bots: ['b1', 'bp'], rooms: [], createdAt: 1000 },
    ],
  }))

  const { ctx, rt } = startHost(home, {
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 },
      bp: { id: 'bp', name: 'PrivateVault', role: 'Secret', private: true, workDir: join(home, 'pv'), createdAt: 2 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.apiReconcile()

  const view = rt.apiView()
  assert.equal(view.status, 'running')
  assert.equal(view.boundPort, freePort)
  assert.equal(view.tokens.length, 1)
  assert.equal(view.tokens[0].name, 'Claude Desktop')
  assert.deepEqual(view.tokens[0].scopes, ['read', 'message'])
  assert.equal(view.openaiCompat, false)
  // Private Bot must be stripped during migration
  assert.deepEqual(view.tokens[0].botIds, ['b1'])
  assert.deepEqual(view.tokens[0].privateBotIds, [])

  // Legacy dsb_ token authenticates on both /mcp and /v1/bots without rotating
  const mcpRes = await fetch(`${view.baseUrl}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsbot_list_bots', arguments: {} } }),
  }).then(r => r.json())
  assert.deepEqual(mcpRes.result.structuredContent.bots.map(b => b.id), ['b1'])
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/bp`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status, 404)
  const headers = { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' }
  const mcp = async (name, args = {}) => fetch(`${view.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  }).then(response => response.json())
  const sent = (await mcp('send_to_bot', { bot: 'b1', text: 'Legacy message' })).result.structuredContent
  assert.equal(sent.sent, true)
  assert.equal(typeof sent.after, 'number')
  const waited = (await mcp('wait_for_reply', { bot: 'b1', after: sent.after, timeout: 0 })).result.structuredContent
  assert.equal(waited.runId, sent.runId)
  assert.equal(typeof waited.done, 'boolean')
  assert.equal(Array.isArray(waited.messages), true)
  assert.equal((await mcp('wait_for_reply', { bot: 'b1', after: -1, timeout: 0 })).result.isError, true)
  assert.equal((await mcp('send_to_bot', { bot: 'bp', text: 'Forbidden' })).result.isError, true)
  for (const name of ['dsbot_read_memory', 'dsbot_respond_run']) {
    assert.equal((await mcp(name, { kind: 'bot', id: 'b1', runId: sent.runId, actionId: 'missing' })).result.isError, true)
  }
  assert.equal((await fetch(`${view.baseUrl}/v1/bots/b1/memory`, { headers })).status, 403)
  assert.equal((await fetch(`${view.baseUrl}/v1/runs/${sent.runId}/respond`, {
    method: 'POST', headers, body: JSON.stringify({ actionId: 'missing', answer: 'no' }),
  })).status, 403)
  assert.equal((await fetch(`${view.baseUrl}/compat/openai/v1/models`, { headers })).status, 404)
})
