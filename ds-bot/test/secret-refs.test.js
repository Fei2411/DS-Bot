import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { CONNECTOR_IDS } from '../src/host/capabilities.js'
import { createSecretRefs, SECRET_REF_PATTERN } from '../src/host/secret-refs.js'
import { decryptSecrets, isEncryptedSecretsFile } from '../src/host/secrets-crypto.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `t-${randomBytes(12).toString('hex')}`

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
    c3: { id: 'c3', sessionId: 'c3', name: 'Coder', role: 'Coder', instructions: '', createdAt: 3 },
  },
  rooms: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
}

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-secret-refs-')) } = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const contributors = []
  const shellEnv = {
    register(contributor) {
      const entry = { ...contributor, live: true }
      contributors.push(entry)
      return () => { entry.live = false }
    },
  }
  const ctx = fakeContext({ services: { shellEnv } })
  const listeners = {}
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    ;(listeners[name] ??= []).push(listener)
    return on(name, listener, options)
  }
  const delivered = []
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => delivered.push({ sessionId, text: message.content[0].text, source: message.source }) } }),
  }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, agentId, extra = {}) => {
    let concluded = false
    const exec = { agent: { id: agentId }, callId: `call-${agentId}-${name}`, concludeTurn: () => { concluded = true }, ...extra }
    return rt.teamTools.find(d => d.name === name).execute(args, exec).then(text => ({ text, concluded }))
  }
  const view = async () => {
    const result = await call('state', {})
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const env = (agentId, command = '') => contributors.filter(entry => entry.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: { command } }) ?? {}
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, call, tool, view, env, listeners, delivered, contributors, stop }
}

test('secret-ref handles are deterministic HMACs with 0700/0600 permissions, strict bot isolation, and one-time consume', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-refs-unit-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let clock = 1_700_000_000_000
  const refs = createSecretRefs({ home, now: () => clock })
  t.after(() => refs.dispose())

  const val = fresh()
  const ref1 = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r1', field: 'API_KEY', value: val })
  assert.match(ref1, SECRET_REF_PATTERN)

  // Deterministic for same inputs & salt.
  const ref1Again = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r1', field: 'API_KEY', value: val })
  assert.equal(ref1Again, ref1)

  // Different bot or field produces a distinct handle.
  const refOtherBot = await refs.issueRef({ botId: 'c3', sessionId: 's1', requestId: 'r1', field: 'API_KEY', value: val })
  assert.notEqual(refOtherBot, ref1)
  const refOtherField = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r1', field: 'OTHER', value: val })
  assert.notEqual(refOtherField, ref1)

  if (process.platform !== 'win32') {
    assert.equal(statSync(refs.refsDir).mode & 0o777, 0o700)
    assert.equal(statSync(join(refs.refsDir, '.salt')).mode & 0o777, 0o600)
    const hex = ref1.slice('secret-ref:'.length)
    assert.equal(statSync(join(refs.refsDir, `${hex}.json`)).mode & 0o777, 0o600)
  }

  // Cross-bot consume is strictly rejected AND preserves the owner's handle.
  await assert.rejects(() => refs.consumeRef(ref1, { botId: 'c3' }), err => err.code === 'SECRET_REF_FORBIDDEN')
  assert.equal(await refs.consumeRef(ref1, { botId: 'b2' }), val)

  // Second consume fails — handle was deleted before returning plaintext.
  await assert.rejects(() => refs.consumeRef(ref1, { botId: 'b2' }), err => err.code === 'SECRET_REF_NOT_FOUND')

  // Invalid format rejected.
  await assert.rejects(() => refs.consumeRef('secret-ref:not-hex', { botId: 'b2' }), err => err.code === 'SECRET_REF_INVALID')

  // Expired ref is deleted and throws SECRET_REF_EXPIRED.
  const shortRef = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r-exp', field: 'K', value: val, ttlMs: 1000 })
  clock += 5000
  await assert.rejects(() => refs.consumeRef(shortRef, { botId: 'b2' }), err => err.code === 'SECRET_REF_EXPIRED')
  const expHex = shortRef.slice('secret-ref:'.length)
  assert.equal(existsSync(join(refs.refsDir, `${expHex}.json`)), false)
})

test('consumeRef throws SECRET_REF_CONSUME_FAILED and never returns plaintext if unlink fails', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-refs-fail-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const refs = createSecretRefs({
    home,
    fsOps: {
      unlink: async () => {
        const err = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      },
    },
  })
  t.after(() => refs.dispose())

  const secret = fresh()
  const ref = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r1', field: 'TOKEN', value: secret })
  await assert.rejects(
    () => refs.consumeRef(ref, { botId: 'b2' }),
    err => err.code === 'SECRET_REF_CONSUME_FAILED' && !err.message.includes(secret),
  )
})

test('sweepExpiredRefs and sweepExpiredFiles clean up stale handles, temp files, and partial files', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-refs-sweep-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let clock = 1_700_000_000_000
  const refs = createSecretRefs({ home, now: () => clock })
  t.after(() => refs.dispose())

  const oldRef = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'old', field: 'A', value: fresh(), ttlMs: 1000 })
  const freshRef = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'new', field: 'B', value: fresh(), ttlMs: 100_000 })
  const written = await refs.writeSecretFile({ botId: 'b2', sessionId: 's1', name: 'TEMP', value: fresh() })

  // Age the temp file and orphan .partial past their expiry thresholds.
  const pastFile = new Date(clock - 100_000)
  utimesSync(written.filePath, pastFile, pastFile)
  const partialPath = join(refs.filesDir, 'orphan.partial')
  writeFileSync(partialPath, 'x')
  const pastPartial = new Date(clock - 10 * 60_000)
  utimesSync(partialPath, pastPartial, pastPartial)

  clock += 5000
  const removedRefs = await refs.sweepExpiredRefs()
  assert.equal(removedRefs, 1)
  assert.equal(existsSync(join(refs.refsDir, `${oldRef.slice(11)}.json`)), false)
  assert.equal(existsSync(join(refs.refsDir, `${freshRef.slice(11)}.json`)), true)
  assert.equal(existsSync(join(refs.refsDir, '.salt')), true)

  const removedFiles = await refs.sweepExpiredFiles({ maxAgeMs: 10_000 })
  assert.equal(removedFiles, 2)
  assert.equal(existsSync(written.filePath), false)
  assert.equal(existsSync(partialPath), false)
})

test('encrypted store encrypts secret-ref files on disk with domain-separated AAD', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const pass = 'correct horse battery staple'
  assert.equal((await bench.call('secret-encrypt', { passphrase: pass })).ok, true)

  const secret = fresh()
  const ref = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'req-enc', field: 'TOKEN', value: secret })
  const filePath = join(bench.home, 'secret-refs', `${ref.slice('secret-ref:'.length)}.json`)
  const raw = readFileSync(filePath, 'utf8')
  assert.equal(raw.includes(secret), false, 'plaintext must not sit on disk when store is encrypted')
  const envelope = JSON.parse(raw)
  assert.equal(isEncryptedSecretsFile(envelope), true)
  // Cannot be substituted into secrets.json due to domain-separated AAD.
  assert.throws(() => decryptSecrets(envelope, pass))

  assert.equal(await bench.rt.secrets.consumeRef(ref, { botId: 'b2' }), secret)
})

test('request_secret delivery=ref issues a one-time handle consumed by save_capability without leaking plaintext', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const secret = fresh()

  const asked = await bench.tool('request_secret', { name: 'MCP_KEY', purpose: 'Auth header', delivery: 'ref' }, 'b2')
  assert.equal(asked.concluded, true)
  const [req] = (await bench.view()).secretRequests.b2
  assert.equal(req.delivery, 'ref')
  assert.equal(req.kind, 'fill')

  const submitted = await bench.call('secret-set', { requestId: req.id, value: secret })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.value.delivery, 'ref')
  assert.equal(JSON.stringify(submitted).includes(secret), false)

  // Not saved into long-term secrets.json!
  const team = await bench.view()
  assert.equal(team.secrets.length, 0)
  assert.equal(existsSync(join(bench.home, 'secrets.json')), false)

  const note = bench.delivered.at(-1).text
  assert.equal(note.includes(secret), false)
  const match = note.match(/secret-ref:[0-9a-f]{32}/)
  assert.ok(match, `expected secret-ref handle in note: ${note}`)
  const handle = match[0]

  // Another Bot cannot consume b2's handle via save_capability.
  const stolen = await bench.tool('save_capability', {
    name: 'stolen-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
    headers: { Authorization: `Bearer ${handle}` },
  }, 'c3')
  assert.match(stolen.text, /another Bot/i)

  // Owner Bot consumes the handle via save_capability.
  const savedCap = await bench.tool('save_capability', {
    name: 'my-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
    headers: { Authorization: `Bearer ${handle}` },
  }, 'b2')
  assert.match(savedCap.text, /Saved my-mcp/)

  // state.json stores $DSH_SECRET_..., never plaintext or stale handle.
  const stateRaw = readFileSync(join(bench.home, 'state.json'), 'utf8')
  assert.equal(stateRaw.includes(secret), false)
  assert.equal(stateRaw.includes(handle), false)
  const savedItem = (await bench.view()).capabilities.find(c => c.name === 'my-mcp')
  assert.match(savedItem.headers.Authorization, /^Bearer \$DSH_SECRET_CAP_MY_MCP_AUTHORIZATION_[A-F0-9]{8}$/)

  // Consumed handle cannot be reused.
  await assert.rejects(() => bench.rt.secrets.consumeRef(handle, { botId: 'b2' }), err => err.code === 'SECRET_REF_NOT_FOUND')
})

test('request_secret delivery=file writes 0600 temp file, supports pasted secrets, and redacts stdout leaks', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const secret1 = fresh()
  const secret2 = fresh()

  // 1. Card flow with delivery=file.
  const asked = await bench.tool('request_secret', { name: 'DEPLOY_TOKEN', purpose: 'CLI auth', delivery: 'file' }, 'b2')
  assert.equal(asked.concluded, true)
  const [req] = (await bench.view()).secretRequests.b2
  assert.equal(req.delivery, 'file')

  const submitted = await bench.call('secret-set', { requestId: req.id, value: secret1 })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.value.delivery, 'file')
  assert.ok(Number.isFinite(submitted.value.expiresAt))
  assert.equal(JSON.stringify(submitted).includes(secret1), false)

  const note = bench.delivered.at(-1).text
  assert.equal(note.includes(secret1), false)
  const pathMatch = note.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(pathMatch, `expected temp file path in note: ${note}`)
  const filePath = pathMatch[1]
  assert.equal(readFileSync(filePath, 'utf8'), secret1)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(bench.home, 'secret-files')).mode & 0o777, 0o700)
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
  assert.deepEqual(readdirSync(join(bench.home, 'secret-files')).filter(f => f.endsWith('.partial')), [])

  // Redactor immediately covers temp file plaintext even though secrets.json is empty!
  assert.equal(bench.rt.redactSecrets(`leaked ${secret1}`), 'leaked [secret:DEPLOY_TOKEN]')

  // 2. Pasted secret saved directly to 0600 file via delivery='file' + value.
  const pasted = await bench.tool('request_secret', { name: 'PASTED_KEY', purpose: 'User pasted key', delivery: 'file', value: secret2 }, 'b2')
  assert.equal(pasted.concluded, false)
  assert.equal(pasted.text.includes(secret2), false)
  const pastedMatch = pasted.text.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(pastedMatch)
  assert.equal(readFileSync(pastedMatch[1], 'utf8'), secret2)
  assert.equal(bench.rt.redactSecrets(`echo ${secret2}`), 'echo [secret:PASTED_KEY]')
})

test('optional Shell File Mode exposes $DSH_SECRET_FILE_<NAME> pointing to a 0600 file and cleans up on switch back', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const secret = `multi-${fresh()}\nline2-${fresh()}`
  assert.equal((await bench.call('secret-set', { name: 'SSH_CERT', value: secret, scope: 'all' })).ok, true)

  // Default mode: $DSH_SECRET_SSH_CERT
  assert.deepEqual(bench.env('b2'), { DSH_SECRET_SSH_CERT: secret })

  // Switch to file mode via set-prefs.
  const switched = await bench.call('set-prefs', { secretShellMode: 'file' })
  assert.equal(switched.ok, true)
  assert.equal(switched.value.secretShellMode, 'file')

  const fileEnv = bench.env('b2', 'cat "$DSH_SECRET_FILE_SSH_CERT"')
  assert.equal(fileEnv.DSH_SECRET_SSH_CERT, undefined)
  assert.equal(typeof fileEnv.DSH_SECRET_FILE_SSH_CERT, 'string')
  const filePath = fileEnv.DSH_SECRET_FILE_SSH_CERT
  assert.equal(readFileSync(filePath, 'utf8'), secret)
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }

  // Real subprocess reads the file path from $DSH_SECRET_FILE_SSH_CERT.
  const child = spawnSync(process.execPath, ['-e', 'const fs=require("fs"); process.stdout.write(fs.readFileSync(process.env.DSH_SECRET_FILE_SSH_CERT,"utf8"))'], {
    env: { ...process.env, ...fileEnv },
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, secret)

  // Switch back to env mode cleans up the managed shell file and restores $DSH_SECRET_*.
  assert.equal((await bench.call('set-prefs', { secretShellMode: 'env' })).ok, true)
  assert.equal(existsSync(filePath), false)
  assert.deepEqual(bench.env('b2'), { DSH_SECRET_SSH_CERT: secret })
})

test('Shell File Mode immediately unlinks stale files on value change, scope revoke, secret delete, and bot delete', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const v1 = fresh()
  const v2 = fresh()
  const sharedVal = fresh()

  assert.equal((await bench.call('set-prefs', { secretShellMode: 'file' })).ok, true)
  assert.equal((await bench.call('secret-set', { name: 'SCOPED_KEY', value: v1, scope: ['b2', 'c3'] })).ok, true)
  assert.equal((await bench.call('secret-set', { name: 'SHARED_KEY', value: sharedVal, scope: 'all' })).ok, true)

  const b2Env1 = bench.env('b2')
  const c3Env1 = bench.env('c3')
  const b2ScopedPath1 = b2Env1.DSH_SECRET_FILE_SCOPED_KEY
  const c3ScopedPath1 = c3Env1.DSH_SECRET_FILE_SCOPED_KEY
  const b2SharedPath = b2Env1.DSH_SECRET_FILE_SHARED_KEY
  const c3SharedPath = c3Env1.DSH_SECRET_FILE_SHARED_KEY
  for (const p of [b2ScopedPath1, c3ScopedPath1, b2SharedPath, c3SharedPath]) {
    assert.equal(existsSync(p), true)
    assert.equal(bench.rt.secrets.activeShellFilePaths().has(p), true)
  }

  // 1. Value update immediately unlinks old files and issues a fresh content-hashed path.
  assert.equal((await bench.call('secret-set', { name: 'SCOPED_KEY', value: v2 })).ok, true)
  assert.equal(existsSync(b2ScopedPath1), false)
  assert.equal(existsSync(c3ScopedPath1), false)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(b2ScopedPath1), false)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(c3ScopedPath1), false)
  const b2ScopedPath2 = bench.env('b2').DSH_SECRET_FILE_SCOPED_KEY
  const c3ScopedPath2 = bench.env('c3').DSH_SECRET_FILE_SCOPED_KEY
  assert.notEqual(b2ScopedPath2, b2ScopedPath1)
  assert.equal(readFileSync(b2ScopedPath2, 'utf8'), v2)
  assert.equal(readFileSync(c3ScopedPath2, 'utf8'), v2)

  // 2. Scope revocation immediately unlinks c3's file while keeping b2's intact.
  assert.equal((await bench.call('secret-update', { name: 'SCOPED_KEY', scope: ['b2'] })).ok, true)
  assert.equal(existsSync(c3ScopedPath2), false)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(c3ScopedPath2), false)
  assert.equal(existsSync(b2ScopedPath2), true)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(b2ScopedPath2), true)

  // 3. Secret deletion immediately unlinks b2's file.
  assert.equal((await bench.call('secret-delete', { name: 'SCOPED_KEY' })).ok, true)
  assert.equal(existsSync(b2ScopedPath2), false)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(b2ScopedPath2), false)

  // 4. Bot deletion immediately unlinks c3's scope='all' shell file while keeping b2's intact.
  assert.equal((await bench.call('delete-bot', { id: 'c3' })).ok, true)
  assert.equal(existsSync(c3SharedPath), false)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(c3SharedPath), false)
  assert.equal(existsSync(b2SharedPath), true)
  assert.equal(bench.rt.secrets.activeShellFilePaths().has(b2SharedPath), true)
})

test('save_capability secret-ref uses host-only scope [], validates before consuming, sanitizes names, mounts cleanly, and avoids regex races', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-cap-refs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const mountedConfigs = []
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const contributors = []
  const shellEnv = {
    register(contributor) {
      const entry = { ...contributor, live: true }
      contributors.push(entry)
      return () => { entry.live = false }
    },
  }
  const ctx = fakeContext({ services: { shellEnv, loader } })
  ctx.sessionController = { resolveAgent: async id => ({ agent: { session: { id }, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const envOf = (agentId) => contributors.filter(e => e.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: {} }) ?? {}

  // 1. Validation failure BEFORE consuming preserves the one-time ref unconsumed & creates 0 orphan secrets.
  const secret1 = fresh()
  const ref1 = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'r-val', field: 'KEY', value: secret1 })
  await assert.rejects(
    () => rt.capabilitySave({
      name: 'bad-url-mcp',
      kind: 'mcp',
      transport: 'streamable-http',
      url: 'not-a-valid-url',
      headers: { Authorization: `Bearer ${ref1}` },
    }, { botId: 'b2' }),
    /valid HTTP or HTTPS URL/i,
  )
  await assert.rejects(
    () => rt.capabilitySave({
      name: 'bad-cmd-mcp',
      kind: 'mcp',
      transport: 'stdio',
      command: '',
      env: { API_KEY: ref1 },
    }, { botId: 'b2' }),
    /command/i,
  )
  assert.equal(rt.secretsView().length, 0, 'failed validation must leave zero orphan secrets')

  // 2. Dotted/colon header names sanitize cleanly, secret is stored with scope: [] (never in Bot shell env!),
  //    and MCP mounting resolves the capability-owned secret while rejecting theft by another capability.
  const saved = await rt.capabilitySave({
    name: 'dotted-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
    headers: { 'X-Api.Key:v1': `Token ${ref1}` },
  }, { botId: 'b2' })
  const headerVal = saved.headers['X-Api.Key:v1']
  assert.match(headerVal, /^Token \$DSH_SECRET_CAP_DOTTED_MCP_X_API_KEY_V1_[A-F0-9]{8}$/)
  const secretName = headerVal.slice('Token $DSH_SECRET_'.length)
  const storedSecret = rt.secretsView().find(s => s.name === secretName)
  assert.deepEqual(storedSecret.scope, [], 'capability ref secret must have host-only scope []')
  assert.deepEqual(envOf('b2'), {}, 'Bot shell env must NEVER receive capability ref secret')

  // Mount dotted-mcp on b2's agent — capability-owned scope: [] secret MUST still resolve for its own MCP!
  const disposers = []
  const agent = {
    id: 'b2',
    session: { id: 'b2' },
    ctx: {
      extend(meta) { return Object.assign(Object.create(this), meta) },
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      tools: { register: () => () => {} },
      plugin(_plugin, config) {
        mountedConfigs.push(config)
        return { await: async () => {}, dispose: () => {} }
      },
    },
  }
  await rt.changeCapabilityAttachment('attach', { name: 'dotted-mcp' }, 'b2')
  ctx.emit('agent/created', { agent })
  await rt.reconcileCapabilities()
  const mounted = mountedConfigs.find(c => c?.serverName === 'dotted-mcp')
  assert.ok(mounted, 'dotted-mcp must mount cleanly with its owned host-only secret')
  assert.equal(mounted.headers['X-Api.Key:v1'], `Token ${secret1}`)

  // Another capability referencing $DSH_SECRET_<secretName> MUST NOT be allowed to read dotted-mcp's secret!
  await rt.capabilitySave({
    name: 'thief-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://evil.test/mcp',
    headers: { Stolen: `$DSH_SECRET_${secretName}` },
  }, { botId: 'b2' })
  await rt.changeCapabilityAttachment('attach', { name: 'thief-mcp' }, 'b2')
  await rt.reconcileCapabilities()
  assert.equal(mountedConfigs.find(c => c?.serverName === 'thief-mcp'), undefined)
  assert.equal(rt.capabilityStatusesView().b2['thief-mcp'].state, 'error')

  // Deleting dotted-mcp cleans up its owned secret.
  await rt.capabilityDelete('dotted-mcp', { botId: 'b2' })
  assert.equal(rt.secretsView().find(s => s.name === secretName), undefined)

  // 3. Concurrent save_capability calls with secret-ref: in URL both consume cleanly (no /g regex race).
  const sA = fresh()
  const sB = fresh()
  const refA = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'conc-a', field: 'U', value: sA })
  const refB = await rt.secrets.issueRef({ botId: 'c3', sessionId: 'c3', requestId: 'conc-b', field: 'U', value: sB })
  const [capA, capB] = await Promise.all([
    rt.capabilitySave({ name: 'conc-a', kind: 'mcp', transport: 'streamable-http', url: `https://a.test/mcp?k=${refA}` }, { botId: 'b2' }),
    rt.capabilitySave({ name: 'conc-b', kind: 'mcp', transport: 'streamable-http', url: `https://b.test/mcp?k=${refB}` }, { botId: 'c3' }),
  ])
  assert.match(capA.url, /^https:\/\/a\.test\/mcp\?k=\$DSH_SECRET_CAP_CONC_A_URL_[A-F0-9]{8}$/)
  assert.match(capB.url, /^https:\/\/b\.test\/mcp\?k=\$DSH_SECRET_CAP_CONC_B_URL_[A-F0-9]{8}$/)
})

test('reconcile() does not settle or mutate pending ref/file cards when a same-named vault secret changes', async (t) => {
  const bench = start()
  t.after(bench.stop)

  await bench.tool('request_secret', { name: 'SHARED_TOKEN', purpose: 'one-time ref', delivery: 'ref' }, 'b2')
  await bench.tool('request_secret', { name: 'SHARED_TOKEN', purpose: 'temp file', delivery: 'file' }, 'c3')
  const before = await bench.view()
  const refReq = before.secretRequests.b2[0]
  const fileReq = before.secretRequests.c3[0]
  assert.equal(refReq.status, 'pending')
  assert.equal(refReq.kind, 'fill')
  assert.equal(fileReq.status, 'pending')
  assert.equal(fileReq.kind, 'fill')

  const deliveredBefore = bench.delivered.length
  // Save vault secret with same name (scope: 'all'), update scope, and delete it.
  assert.equal((await bench.call('secret-set', { name: 'SHARED_TOKEN', value: fresh(), scope: 'all' })).ok, true)
  assert.equal((await bench.call('secret-update', { name: 'SHARED_TOKEN', scope: ['m1'] })).ok, true)
  assert.equal((await bench.call('secret-delete', { name: 'SHARED_TOKEN' })).ok, true)

  const after = await bench.view()
  assert.equal(after.secretRequests.b2[0].status, 'pending')
  assert.equal(after.secretRequests.b2[0].kind, 'fill')
  assert.equal(after.secretRequests.c3[0].status, 'pending')
  assert.equal(after.secretRequests.c3[0].kind, 'fill')
  assert.equal(bench.delivered.length, deliveredBefore, 'vault changes must not send notes for pending ref/file cards')

  // secret-allow must reject non-vault requests.
  assert.equal((await bench.call('secret-allow', { requestId: refReq.id })).ok, false)

  // Both cards still answer cleanly through their intended delivery modes.
  const refVal = fresh()
  const fileVal = fresh()
  assert.equal((await bench.call('secret-set', { requestId: refReq.id, value: refVal })).value.delivery, 'ref')
  assert.equal((await bench.call('secret-set', { requestId: fileReq.id, value: fileVal })).value.delivery, 'file')
})

test('in-flight secret-ref files stay valid across secret-encrypt, secret-decrypt, and passphrase rotation', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const pass1 = 'first horse battery staple'
  const pass2 = 'second horse battery staple'

  // 1. Issue ref in plaintext mode, then encrypt the store -> ref file becomes encrypted & still consumes cleanly.
  const s1 = fresh()
  const ref1 = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'pre-enc', field: 'K', value: s1 })
  const ref1Path = join(bench.home, 'secret-refs', `${ref1.slice('secret-ref:'.length)}.json`)
  assert.equal(readFileSync(ref1Path, 'utf8').includes(s1), true)

  assert.equal((await bench.call('secret-encrypt', { passphrase: pass1 })).ok, true)
  const encRaw = readFileSync(ref1Path, 'utf8')
  assert.equal(encRaw.includes(s1), false, 'secret-encrypt must encrypt existing plaintext ref files on disk')
  assert.equal(isEncryptedSecretsFile(JSON.parse(encRaw)), true)
  assert.equal(await bench.rt.secrets.consumeRef(ref1, { botId: 'b2' }), s1)

  // 2. Issue ref in encrypted mode, rotate passphrase via rekeyRefs, then decrypt store -> still consumes cleanly.
  const s2 = fresh()
  const ref2 = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'pre-dec', field: 'K', value: s2 })
  const ref2Path = join(bench.home, 'secret-refs', `${ref2.slice('secret-ref:'.length)}.json`)
  assert.equal(isEncryptedSecretsFile(JSON.parse(readFileSync(ref2Path, 'utf8'))), true)

  assert.equal((await bench.call('secret-decrypt', { passphrase: pass1 })).ok, true)
  const decRaw = readFileSync(ref2Path, 'utf8')
  assert.equal(isEncryptedSecretsFile(JSON.parse(decRaw)), false, 'secret-decrypt must decrypt existing encrypted ref files')
  assert.equal(await bench.rt.secrets.consumeRef(ref2, { botId: 'b2' }), s2)

  // 3. Direct passphrase rotation (pass1 -> pass2) on createSecretRefs.
  const rotHome = mkdtempSync(join(tmpdir(), 'dsb-refs-rotate-'))
  t.after(() => rmSync(rotHome, { recursive: true, force: true }))
  let curPass = pass1
  const refs = createSecretRefs({
    home: rotHome,
    getEncryption: () => ({ mode: 'encrypted', locked: false, passphrase: curPass }),
  })
  t.after(() => refs.dispose())
  const s3 = fresh()
  const ref3 = await refs.issueRef({ botId: 'b2', sessionId: 's', requestId: 'rot', field: 'K', value: s3 })
  await refs.rekeyRefs({ fromPassphrase: pass1, toPassphrase: pass2 })
  curPass = pass2
  assert.equal(await refs.consumeRef(ref3, { botId: 'b2' }), s3)
})

test('connectors and mail consume secret-ref end-to-end, disambiguate multiple refs, validate first, and enforce Bot isolation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-conn-refs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const mailLogins = []
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    mail: {
      connect: async (account, { password }) => {
        mailLogins.push({ address: account.address, password })
        return { usable: true, close: async () => {} }
      },
    },
  })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()

  // 1. connector-add HTTP with TWO distinct secret-ref: handles in ONE header.
  const u1 = fresh()
  const p1 = fresh()
  const rUser = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'c1', field: 'U', value: u1 })
  const rPass = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'c2', field: 'P', value: p1 })

  // Validation failure (insecure URL) must NOT consume refs or pollute CONNECTOR_IDS.
  await assert.rejects(
    () => rt.connectorEndpoint('connector-add', {
      name: 'bad-http-conn',
      url: 'http://insecure.example/mcp',
      headers: { Authorization: `Basic ${rUser}:${rPass}` },
      botId: 'b2',
    }),
    /https:\/\//,
  )
  assert.equal(CONNECTOR_IDS.has('bad-http-conn'), false)

  // Mid-way failure (rUser valid, second ref belongs to another Bot) must roll back rUser's secret and NOT add to CONNECTOR_IDS.
  const otherRef = await rt.secrets.issueRef({ botId: 'c3', sessionId: 'c3', requestId: 'c-other', field: 'X', value: fresh() })
  const tempRef = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'c-tmp', field: 'T', value: fresh() })
  await assert.rejects(
    () => rt.connectorEndpoint('connector-add', {
      name: 'rollback-conn',
      url: 'https://good.example/mcp',
      headers: { Authorization: `Basic ${tempRef}:${otherRef}` },
      botId: 'b2',
    }),
    /another Bot/i,
  )
  assert.equal(CONNECTOR_IDS.has('rollback-conn'), false)
  assert.equal(rt.secretsView().filter(s => s.name.includes('ROLLBACK_CONN')).length, 0)

  // Valid connector-add with TWO distinct refs in ONE header: both stored separately and resolved in upstreamOf!
  await rt.connectorEndpoint('connector-add', {
    name: 'dual-auth',
    url: 'https://dual.example/mcp',
    headers: { Authorization: `Basic ${rUser}:${rPass}` },
    botId: 'b2',
  })
  const upstream = rt.connectorsInternals.upstreamOf('dual-auth')
  assert.equal(upstream.headers.Authorization, `Basic ${u1}:${p1}`)
  assert.equal(CONNECTOR_IDS.has('dual-auth'), true)

  // 2. connector-add stdio scans args AND env.
  const argVal = fresh()
  const envVal = fresh()
  const rArg = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 's-arg', field: 'A', value: argVal })
  const rEnv = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 's-env', field: 'E', value: envVal })
  await rt.connectorEndpoint('connector-add', {
    name: 'stdio-ref',
    command: 'node',
    args: ['--token', rArg],
    env: { API_KEY: rEnv },
    botId: 'b2',
  })
  const savedCustom = rt.state.connectors['stdio-ref'].custom
  assert.match(savedCustom.args[1], /^\$DSH_SECRET_CONNECTOR_STDIO_REF_ARG_1_[A-F0-9]{8}$/)
  assert.match(savedCustom.env.API_KEY, /^\$DSH_SECRET_CONNECTOR_STDIO_REF_ENV_API_KEY_[A-F0-9]{8}$/)
  assert.equal(rt.secretValue(savedCustom.args[1].slice('$DSH_SECRET_'.length)), argVal)
  assert.equal(rt.secretValue(savedCustom.env.API_KEY.slice('$DSH_SECRET_'.length)), envVal)

  // 3. connector-connect (key auth) with secretRef and cross-Bot rejection.
  const amapKey = fresh()
  const rAmap = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'amap-1', field: 'KEY', value: amapKey })
  await assert.rejects(
    () => rt.connectorEndpoint('connector-connect', { id: 'amap', secretRef: rAmap, botId: 'c3' }),
    /another Bot/i,
  )
  await rt.connectorEndpoint('connector-connect', { id: 'amap', secretRef: rAmap, botId: 'b2' })
  assert.equal(rt.secretValue('CONNECTOR_AMAP_KEY'), amapKey)

  // 4. mail-account-add validates IMAP/SMTP hosts BEFORE consuming ref, supports isSecretRef(body.password), and enforces Bot isolation.
  const mailPw = fresh()
  const rMail = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'mail-1', field: 'PW', value: mailPw })
  await assert.rejects(
    () => rt.connectorEndpoint('mail-account-add', {
      address: 'user@custom.example',
      provider: 'other',
      password: rMail,
      imapHost: '',
      smtpHost: '',
      botId: 'b2',
    }),
    /IMAP and SMTP/,
  )
  // Cross-Bot rejected while preserving ref for b2.
  await assert.rejects(
    () => rt.connectorEndpoint('mail-account-add', {
      address: 'user@custom.example',
      provider: 'other',
      password: rMail,
      imapHost: 'imap.custom.example',
      smtpHost: 'smtp.custom.example',
      botId: 'c3',
    }),
    /another Bot/i,
  )
  // Owner Bot consumes via body.password containing secret-ref:.
  await rt.connectorEndpoint('mail-account-add', {
    address: 'user@custom.example',
    provider: 'other',
    password: rMail,
    imapHost: 'imap.custom.example',
    smtpHost: 'smtp.custom.example',
    botId: 'b2',
  })
  assert.deepEqual(mailLogins, [{ address: 'user@custom.example', password: mailPw }])
})

test('ephemeral redactor keeps multiple concurrent delivery=file secrets with the same key name redacted', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const s1 = fresh()
  const s2 = fresh()

  const r1 = await bench.tool('request_secret', { name: 'DEPLOY_TOKEN', purpose: 'first', delivery: 'file', value: s1 }, 'b2')
  const r2 = await bench.tool('request_secret', { name: 'DEPLOY_TOKEN', purpose: 'second', delivery: 'file', value: s2 }, 'c3')
  assert.equal(r1.text.includes(s1), false)
  assert.equal(r2.text.includes(s2), false)

  // BOTH secrets sharing the same key name must stay redacted concurrently!
  assert.equal(
    bench.rt.redactSecrets(`first=${s1} second=${s2}`),
    'first=[secret:DEPLOY_TOKEN] second=[secret:DEPLOY_TOKEN]',
  )
})

test('sweepExpiredRefs and sweepExpiredFiles use lstat and do not dereference symlinks', async (t) => {
  if (process.platform === 'win32') return
  const home = mkdtempSync(join(tmpdir(), 'dsb-refs-symlink-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const outsideFile = join(home, 'outside-target.txt')
  writeFileSync(outsideFile, 'must-stay-intact')
  const old = new Date(Date.now() - 48 * 3_600_000)
  utimesSync(outsideFile, old, old)

  const refs = createSecretRefs({ home })
  t.after(() => refs.dispose())
  // Ensure dirs exist
  await refs.issueRef({ botId: 'b2', sessionId: 's', requestId: 'init', field: 'K', value: fresh() })
  await refs.writeSecretFile({ botId: 'b2', sessionId: 's', name: 'INIT', value: fresh() })

  const refLink = join(refs.refsDir, 'deadbeef.json')
  const fileLink = join(refs.filesDir, 'sf-link.secret')
  symlinkSync(outsideFile, refLink)
  symlinkSync(outsideFile, fileLink)

  await refs.sweepExpiredRefs({ maxAgeMs: 1 })
  await refs.sweepExpiredFiles({ maxAgeMs: 1 })
  assert.equal(existsSync(outsideFile), true)
  assert.equal(readFileSync(outsideFile, 'utf8'), 'must-stay-intact')
})
