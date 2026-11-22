import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
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
