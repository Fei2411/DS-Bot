import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  // state.json stores ${DSH_SECRET_...}, never plaintext or stale handle.
  const stateRaw = readFileSync(join(bench.home, 'state.json'), 'utf8')
  assert.equal(stateRaw.includes(secret), false)
  assert.equal(stateRaw.includes(handle), false)
  const savedItem = (await bench.view()).capabilities.find(c => c.name === 'my-mcp')
  assert.match(savedItem.headers.Authorization, /^Bearer \$\{DSH_SECRET_CAP_MY_MCP_AUTHORIZATION_[A-F0-9]{8}\}$/)

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
  assert.equal(dirname(filePath), join(bench.home, 'secret-files', 'b2'))
  assert.equal(readFileSync(filePath, 'utf8'), secret1)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(bench.home, 'secret-files')).mode & 0o777, 0o700)
    assert.equal(statSync(join(bench.home, 'secret-files', 'b2')).mode & 0o777, 0o700)
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
  assert.deepEqual(readdirSync(join(bench.home, 'secret-files', 'b2')).filter(f => f.endsWith('.partial')), [])

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
  assert.match(headerVal, /^Token \$\{DSH_SECRET_CAP_DOTTED_MCP_X_API_KEY_V1_[A-F0-9]{8}\}$/)
  const secretName = headerVal.slice('Token ${DSH_SECRET_'.length, -1)
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
  assert.match(capA.url, /^https:\/\/a\.test\/mcp\?k=\$\{DSH_SECRET_CAP_CONC_A_URL_[A-F0-9]{8}\}$/)
  assert.match(capB.url, /^https:\/\/b\.test\/mcp\?k=\$\{DSH_SECRET_CAP_CONC_B_URL_[A-F0-9]{8}\}$/)
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

test('HTTP connector and mail endpoints reject secret-ref handles without trusting body.botId and leave owner handles intact', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-conn-refs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    mail: {
      connect: async () => ({ usable: true, close: async () => {} }),
    },
  })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()

  const secret = fresh()
  const ref = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'http-reject', field: 'KEY', value: secret })
  const refFile = join(home, 'secret-refs', `${ref.slice('secret-ref:'.length)}.json`)
  assert.equal(existsSync(refFile), true)

  // Every HTTP connector/mail endpoint must reject secret-ref handles (with or without forged body.botId)
  // and must NEVER consume or delete the owner's handle on disk.
  for (const [endpoint, body] of [
    ['connector-connect', { id: 'amap', secretRef: ref, botId: 'b2' }],
    ['connector-connect', { id: 'amap', key: ref }],
    ['connector-connect', { id: 'amap', key: `Bearer ${ref}`, botId: 'b2' }],
    ['connector-client', { id: 'notion', clientId: 'cid', secretRef: ref, botId: 'b2' }],
    ['connector-client', { id: 'notion', clientId: 'cid', clientSecret: ref }],
    ['connector-add', { name: 'http-ref', url: 'https://dual.example/mcp', headers: { Authorization: `Bearer ${ref}` }, botId: 'b2' }],
    ['connector-add', { name: 'http-url-ref', url: `https://dual.example/mcp?k=${ref}` }],
    ['connector-add', { name: 'stdio-ref', command: 'node', args: ['--token', ref], env: { K: 'v' }, botId: 'b2' }],
    ['connector-add', { name: 'stdio-env-ref', command: 'node', args: [], env: { API_KEY: ref } }],
    ['mail-account-add', { address: 'user@custom.example', provider: 'other', secretRef: ref, imapHost: 'imap.custom.example', smtpHost: 'smtp.custom.example', botId: 'b2' }],
    ['mail-account-add', { address: 'user@custom.example', provider: 'other', password: ref, imapHost: 'imap.custom.example', smtpHost: 'smtp.custom.example' }],
  ]) {
    await assert.rejects(
      () => rt.connectorEndpoint(endpoint, body),
      /Bot host tools/i,
      `${endpoint} must reject secret-ref handles`,
    )
    assert.equal(existsSync(refFile), true, `${endpoint} must not consume or delete the ref file`)
  }
  assert.equal(CONNECTOR_IDS.has('http-ref'), false)
  assert.equal(CONNECTOR_IDS.has('stdio-ref'), false)

  // Owner Bot can still consume the intact handle via the trusted host tool path (`save_capability`).
  const saved = await rt.capabilitySave({
    name: 'trusted-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://trusted.example/mcp',
    headers: { Authorization: `Bearer ${ref}` },
  }, { botId: 'b2' })
  assert.match(saved.headers.Authorization, /^Bearer \$\{DSH_SECRET_CAP_TRUSTED_MCP_AUTHORIZATION_[A-F0-9]{8}\}$/)
  assert.equal(existsSync(refFile), false)
})

test('loadOrCreateSalt recovers from 0-byte and truncated .salt files via atomic replacement', async (t) => {
  for (const [label, bytes] of [['zero-byte', Buffer.alloc(0)], ['truncated', Buffer.from('short-salt')]]) {
    const home = mkdtempSync(join(tmpdir(), `dsb-salt-${label}-`))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const refsDir = join(home, 'secret-refs')
    mkdirSync(refsDir, { recursive: true, mode: 0o700 })
    const saltPath = join(refsDir, '.salt')
    writeFileSync(saltPath, bytes)

    const warnings = []
    const refs = createSecretRefs({ home, warn: (...args) => warnings.push(args) })
    t.after(() => refs.dispose())

    const secret = fresh()
    const ref = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'r1', field: 'KEY', value: secret })
    assert.match(ref, SECRET_REF_PATTERN)
    assert.equal(readFileSync(saltPath).length, 32, `${label} .salt must be replaced with 32 bytes`)
    if (process.platform !== 'win32') {
      assert.equal(statSync(saltPath).mode & 0o777, 0o600)
    }
    assert.ok(warnings.length >= 1, `${label} .salt recovery must emit a warning`)
    assert.equal(await refs.consumeRef(ref, { botId: 'b2' }), secret)
  }
})

test('host restart restores unexpired delivery=file redactions and sweep removes expired entries from memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-restart-redaction-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const activeSecret = fresh()
  const expiredSecret = fresh()
  const nonSfSecret = fresh()

  // First runtime writes a delivery=file secret, plus an expired sf- file and a non-sf file.
  const run1 = start({ home })
  const saved = await run1.tool('request_secret', { name: 'DEPLOY_KEY', purpose: 'temp', delivery: 'file', value: activeSecret }, 'b2')
  const match = saved.text.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(match)
  const activePath = match[1]
  const expiredPath = join(home, 'secret-files', `sf-old_key-${'a'.repeat(32)}.secret`)
  writeFileSync(expiredPath, expiredSecret)
  const oldTime = new Date(Date.now() - 48 * 3_600_000)
  utimesSync(expiredPath, oldTime, oldTime)
  const unrelatedPath = join(home, 'secret-files', 'notes.txt')
  writeFileSync(unrelatedPath, nonSfSecret)
  await run1.ctx.dispose()

  // Second runtime starts on the SAME home directory (simulating host restart).
  const run2 = start({ home })
  t.after(async () => { await run2.ctx.dispose() })
  await run2.rt.load()
  await run2.rt.loadSecrets()

  // Unexpired sf-*.secret is restored into redactor (both direct redactSecrets and tools/execute).
  assert.equal(run2.rt.redactSecrets(`leak=${activeSecret}`), 'leak=[secret:DEPLOY_KEY]')
  const execute = run2.listeners['tools/execute'].filter(listener => listener.name !== 'listOwnSchedules' && listener.name !== 'computerTrack').at(-1)
  const toolRes = await execute({ name: 'bash', agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
    isError: false,
    value: { stdout: `out=${activeSecret}` },
  }))
  assert.equal(toolRes.value.stdout, 'out=[secret:DEPLOY_KEY]')

  // Expired sf-*.secret was cleaned and is NOT registered; unrelated file is untouched & not registered.
  assert.equal(existsSync(expiredPath), false)
  assert.equal(run2.rt.redactSecrets(expiredSecret), expiredSecret)
  assert.equal(existsSync(unrelatedPath), true)
  assert.equal(run2.rt.redactSecrets(nonSfSecret), nonSfSecret)

  // Aging the surviving file and running sweepExpiredFiles deletes both the disk file and its in-memory redaction.
  const aged = new Date(Date.now() - 60_000)
  utimesSync(activePath, aged, aged)
  const removed = await run2.rt.secrets.sweepExpiredFiles({ maxAgeMs: 10_000 })
  assert.equal(removed, 1)
  assert.equal(existsSync(activePath), false)
  assert.equal(run2.rt.redactSecrets(`after=${activeSecret}`), `after=${activeSecret}`)
})

test('capabilities narrow secret-ref scanning by transport and dropOrphanCapabilities deletes ownedSecrets on bot deletion', async (t) => {
  const bench = start()
  t.after(bench.stop)

  // 1. stdio transport must NOT scan/consume secret-ref handles in ignored url/headers fields.
  const unusedHttpRef = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'tr-1', field: 'H', value: fresh() })
  const stdioEnvVal = fresh()
  const stdioEnvRef = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'tr-2', field: 'E', value: stdioEnvVal })
  const stdioCap = await bench.rt.capabilitySave({
    name: 'stdio-scoped',
    kind: 'mcp',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: stdioEnvRef },
    headers: { Ignored: `Bearer ${unusedHttpRef}` },
  }, { botId: 'b2' })
  assert.equal(stdioCap.approved, false)
  assert.equal(stdioCap.ownedSecrets.length, 1)
  // unusedHttpRef must STILL exist unconsumed on disk!
  assert.equal(existsSync(join(bench.home, 'secret-refs', `${unusedHttpRef.slice('secret-ref:'.length)}.json`)), true)

  // 2. streamable-http transport must NOT scan/consume secret-ref handles in ignored args/env fields.
  const unusedStdioRef = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'tr-3', field: 'A', value: fresh() })
  const httpCap = await bench.rt.capabilitySave({
    name: 'http-scoped',
    kind: 'mcp',
    transport: 'streamable-http',
    url: 'https://scoped.example/mcp',
    headers: { Authorization: `Bearer ${unusedHttpRef}` },
    args: [unusedStdioRef],
    env: { IGNORED: unusedStdioRef },
  }, { botId: 'b2' })
  assert.equal(httpCap.ownedSecrets.length, 1)
  assert.equal(existsSync(join(bench.home, 'secret-refs', `${unusedStdioRef.slice('secret-ref:'.length)}.json`)), true)

  // 3. Deleting the Bot that created & attached an unapproved local stdio MCP drops both the capability AND its ownedSecrets.
  await bench.rt.changeCapabilityAttachment('attach', { name: 'stdio-scoped' }, 'b2')
  const ownedSecretName = stdioCap.ownedSecrets[0]
  assert.ok(bench.rt.secretsView().some(s => s.name === ownedSecretName))
  const deleted = await bench.call('delete-bot', { id: 'b2' })
  assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
  assert.equal((await bench.view()).capabilities.find(c => c.name === 'stdio-scoped'), undefined)
  assert.equal(bench.rt.secretsView().find(s => s.name === ownedSecretName), undefined, 'orphan stdio MCP ownedSecrets must be deleted with the Bot')
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

  const outsideDir = join(home, 'outside-dir')
  mkdirSync(outsideDir, { recursive: true })
  const outsideNested = join(outsideDir, `sf-escape-${'b'.repeat(32)}.secret`)
  writeFileSync(outsideNested, 'must-stay-intact-dir')
  utimesSync(outsideNested, old, old)

  const refLink = join(refs.refsDir, 'deadbeef.json')
  const fileLink = join(refs.filesDir, 'sf-link.secret')
  const dirLink = join(refs.filesDir, 'linked-bot')
  symlinkSync(outsideFile, refLink)
  symlinkSync(outsideFile, fileLink)
  symlinkSync(outsideDir, dirLink)

  await refs.restoreSecretFiles({ maxAgeMs: 1 })
  await refs.sweepExpiredRefs({ maxAgeMs: 1 })
  await refs.sweepExpiredFiles({ maxAgeMs: 1 })
  assert.equal(existsSync(outsideFile), true)
  assert.equal(readFileSync(outsideFile, 'utf8'), 'must-stay-intact')
  assert.equal(existsSync(outsideNested), true)
  assert.equal(readFileSync(outsideNested, 'utf8'), 'must-stay-intact-dir')
})

test('delivery=file preserves exact bytes including trailing newline for OpenSSH private keys on both card and direct-paste paths', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const beginLine = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
  const endLine = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
  const sshKeyCard = `${beginLine}\n  ${fresh()}\n${fresh()}\n${endLine}\n`
  const sshKeyPaste = `${beginLine}\n${fresh()}\n${fresh()}\n${endLine}\n`

  // 1. SecretCard delivery='file' path preserves trailing '\n' and leading/internal whitespace verbatim.
  const asked = await bench.tool('request_secret', { name: 'SSH_KEY_CARD', purpose: 'SSH deploy', delivery: 'file' }, 'b2')
  assert.equal(asked.concluded, true)
  const [req] = (await bench.view()).secretRequests.b2
  const submitted = await bench.call('secret-set', { requestId: req.id, value: sshKeyCard })
  assert.equal(submitted.ok, true, JSON.stringify(submitted.error))
  const cardNote = bench.delivered.at(-1).text
  const cardMatch = cardNote.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(cardMatch)
  assert.equal(readFileSync(cardMatch[1], 'utf8'), sshKeyCard)
  assert.equal(Buffer.compare(readFileSync(cardMatch[1]), Buffer.from(sshKeyCard, 'utf8')), 0)
  // Both exact (with trailing \n) and command-substitution trimmed forms are redacted.
  assert.equal(bench.rt.redactSecrets(`raw=${sshKeyCard}`), 'raw=[secret:SSH_KEY_CARD]')
  assert.equal(bench.rt.redactSecrets(`sub=${sshKeyCard.trim()}`), 'sub=[secret:SSH_KEY_CARD]')

  // 2. Direct paste delivery='file' + value path preserves trailing '\n' verbatim.
  const pasted = await bench.tool('request_secret', { name: 'SSH_KEY_PASTE', purpose: 'SSH deploy', delivery: 'file', value: sshKeyPaste }, 'b2')
  const pasteMatch = pasted.text.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(pasteMatch)
  assert.equal(readFileSync(pasteMatch[1], 'utf8'), sshKeyPaste)
  assert.equal(Buffer.compare(readFileSync(pasteMatch[1]), Buffer.from(sshKeyPaste, 'utf8')), 0)
  assert.equal(bench.rt.redactSecrets(`sub=${sshKeyPaste.trim()}`), 'sub=[secret:SSH_KEY_PASTE]')

  // 3. Multiline file secret with leading whitespace AND trailing `\n`: exact value,
  //    POSIX `$(cat "$file")` trailing-newline-stripped form, and trimmed form all redact cleanly.
  const leadingKey = `  lead-${fresh()}\n  mid-${fresh()}\n\n`
  const leadingRes = await bench.tool('request_secret', { name: 'LEADING_KEY', purpose: 'Indented key', delivery: 'file', value: leadingKey }, 'b2')
  const leadingMatch = leadingRes.text.match(/private temporary file \(0600\): ([^\s]+) \(expires/)
  assert.ok(leadingMatch)
  assert.equal(readFileSync(leadingMatch[1], 'utf8'), leadingKey)
  assert.equal(bench.rt.redactSecrets(`raw=${leadingKey}`), 'raw=[secret:LEADING_KEY]')
  assert.equal(bench.rt.redactSecrets(`sub=${leadingKey.replace(/\n+$/, '')}`), 'sub=[secret:LEADING_KEY]')
  assert.equal(bench.rt.redactSecrets(`trim=${leadingKey.trim()}`), 'trim=[secret:LEADING_KEY]')

  // 4. Rejects whitespace-only and null bytes on delivery='file'.
  const blankRes = await bench.tool('request_secret', { name: 'BLANK_KEY', purpose: 'bad', delivery: 'file', value: '   \n\t  ' }, 'b2')
  assert.match(blankRes.text, /Type the key first/i)
  const nullRes = await bench.tool('request_secret', { name: 'NULL_KEY', purpose: 'bad', delivery: 'file', value: 'abcd\0efgh\n' }, 'b2')
  assert.match(nullRes.text, /null bytes/i)
})

test('save_capability atomically consumes multiple secret-ref handles so partial failure keeps valid handles intact for retry', async (t) => {
  const bench = start()
  t.after(bench.stop)

  const val1 = fresh()
  const val2 = fresh()
  const validRef1 = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'atomic-1', field: 'PRIMARY', value: val1 })
  const expiredRef = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'atomic-exp', field: 'SECONDARY', value: fresh(), ttlMs: 1 })
  await new Promise(resolve => setTimeout(resolve, 15))
  const otherBotRef = await bench.rt.secrets.issueRef({ botId: 'c3', sessionId: 'c3', requestId: 'atomic-other', field: 'OTHER', value: fresh() })
  const validRef1Path = join(bench.home, 'secret-refs', `${validRef1.slice('secret-ref:'.length)}.json`)
  assert.equal(existsSync(validRef1Path), true)

  // Attempt 1: validRef1 + expiredRef -> fails, validRef1 MUST stay untouched on disk and 0 secrets created!
  await assert.rejects(
    () => bench.rt.capabilitySave({
      name: 'multi-ref-mcp',
      kind: 'mcp',
      transport: 'streamable-http',
      url: 'https://multi.example/mcp',
      headers: {
        'X-Primary': `Bearer ${validRef1}`,
        'X-Secondary': `Bearer ${expiredRef}`,
      },
    }, { botId: 'b2' }),
    err => err.code === 'SECRET_REF_EXPIRED',
  )
  assert.equal(existsSync(validRef1Path), true, 'valid first handle must NOT be deleted when second handle is expired')
  assert.equal(bench.rt.secretsView().length, 0)

  // Attempt 2: validRef1 + otherBotRef -> fails, validRef1 STILL untouched on disk!
  await assert.rejects(
    () => bench.rt.capabilitySave({
      name: 'multi-ref-mcp',
      kind: 'mcp',
      transport: 'streamable-http',
      url: 'https://multi.example/mcp',
      headers: {
        'X-Primary': `Bearer ${validRef1}`,
        'X-Secondary': `Bearer ${otherBotRef}`,
      },
    }, { botId: 'b2' }),
    err => err.code === 'SECRET_REF_FORBIDDEN',
  )
  assert.equal(existsSync(validRef1Path), true, 'valid first handle must NOT be deleted when second handle belongs to another Bot')
  assert.equal(bench.rt.secretsView().length, 0)

  // Attempt 3: replace bad second handle with fresh validRef2 (and reuse validRef1 in two fields) -> succeeds!
  const validRef2 = await bench.rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'atomic-2', field: 'SECONDARY', value: val2 })
  const saved = await bench.rt.capabilitySave({
    name: 'multi-ref-mcp',
    kind: 'mcp',
    transport: 'streamable-http',
    url: `https://multi.example/mcp?p=${validRef1}`,
    headers: {
      'X-Primary': `Bearer ${validRef1}`,
      'X-Secondary': `Bearer ${validRef2}`,
    },
  }, { botId: 'b2' })
  assert.equal(existsSync(validRef1Path), false)
  assert.equal(existsSync(join(bench.home, 'secret-refs', `${validRef2.slice('secret-ref:'.length)}.json`)), false)
  assert.equal(saved.ownedSecrets.length, 2, 'duplicate occurrences of validRef1 should share one owned secret')
  assert.equal(bench.rt.secretValue(saved.ownedSecrets[0]), val1)
  assert.equal(bench.rt.secretValue(saved.ownedSecrets[1]), val2)
})

test('save_capability braced ${DSH_SECRET_<NAME>} placeholders stay unambiguous next to uppercase/underscore suffixes across save, mount, and edit', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-braced-refs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const mountedConfigs = []
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  ctx.sessionController = { resolveAgent: async id => ({ agent: { session: { id }, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const sArg = fresh()
  const sEnv = fresh()
  const sUrl = fresh()
  const sHdr = fresh()
  const refArg = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'br-1', field: 'ARG', value: sArg })
  const refEnv = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'br-2', field: 'ENV', value: sEnv })
  const refUrl = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'br-3', field: 'URL', value: sUrl })
  const refHdr = await rt.secrets.issueRef({ botId: 'b2', sessionId: 'b2', requestId: 'br-4', field: 'HDR', value: sHdr })

  // Save stdio MCP with adjacent `_US` suffixes in both args and env.
  const stdioSaved = await rt.capabilitySave({
    name: 'suffix-stdio',
    kind: 'mcp',
    transport: 'stdio',
    command: 'node',
    args: [`${refArg}_US`],
    env: { REGION_KEY: `${refEnv}_US` },
  }, { botId: 'b2' })
  assert.match(stdioSaved.args[0], /^\$\{DSH_SECRET_CAP_SUFFIX_STDIO_ARG_0_[A-F0-9]{8}\}_US$/)
  assert.match(stdioSaved.env.REGION_KEY, /^\$\{DSH_SECRET_CAP_SUFFIX_STDIO_REGION_KEY_[A-F0-9]{8}\}_US$/)
  await rt.capabilityEndpoint('capability-approve', { name: 'suffix-stdio' })

  // Save streamable-http MCP with adjacent `_US` suffixes in both url and headers.
  const httpSaved = await rt.capabilitySave({
    name: 'suffix-http',
    kind: 'mcp',
    transport: 'streamable-http',
    url: `https://suffix.example/mcp?k=${refUrl}_US`,
    headers: { 'X-Region-Token': `${refHdr}_US` },
  }, { botId: 'b2' })
  assert.match(httpSaved.url, /^https:\/\/suffix\.example\/mcp\?k=\$\{DSH_SECRET_CAP_SUFFIX_HTTP_URL_[A-F0-9]{8}\}_US$/)
  assert.match(httpSaved.headers['X-Region-Token'], /^\$\{DSH_SECRET_CAP_SUFFIX_HTTP_X_REGION_TOKEN_[A-F0-9]{8}\}_US$/)

  const agent = {
    id: 'b2',
    session: { id: 'b2' },
    ctx: {
      extend(meta) { return Object.assign(Object.create(this), meta) },
      effect() {},
      tools: { register: () => () => {} },
      plugin(_plugin, config) {
        mountedConfigs.push(config)
        return { await: async () => {}, dispose: () => {} }
      },
    },
  }
  await rt.changeCapabilityAttachment('attach', { name: 'suffix-stdio' }, 'b2')
  await rt.changeCapabilityAttachment('attach', { name: 'suffix-http' }, 'b2')
  ctx.emit('agent/created', { agent })
  await rt.reconcileCapabilities()

  const mountedStdio = mountedConfigs.find(c => c?.serverName === 'suffix-stdio')
  const mountedHttp = mountedConfigs.find(c => c?.serverName === 'suffix-http')
  assert.ok(mountedStdio, 'suffix-stdio must mount cleanly')
  assert.ok(mountedHttp, 'suffix-http must mount cleanly')
  assert.equal(mountedStdio.args[0], `${sArg}_US`)
  assert.equal(mountedStdio.env.REGION_KEY, `${sEnv}_US`)
  assert.equal(mountedHttp.url, `https://suffix.example/mcp?k=${encodeURIComponent(sUrl)}_US`)
  assert.equal(mountedHttp.headers['X-Region-Token'], `${sHdr}_US`)

  // Editing suffix-http preserves ownedSecrets (referencedSecretNames parses braced placeholders without swallowing _US).
  const editedHttp = await rt.capabilitySave({
    name: 'suffix-http',
    kind: 'mcp',
    description: 'Updated description',
    transport: 'streamable-http',
    url: httpSaved.url,
    headers: httpSaved.headers,
  }, { botId: 'b2' })
  assert.deepEqual(editedHttp.ownedSecrets, httpSaved.ownedSecrets)
  for (const name of httpSaved.ownedSecrets) {
    assert.ok(rt.secretsView().some(s => s.name === name), `owned secret ${name} must survive edit`)
  }
})

test('consumeRefs uses two-phase reversible staging so a mid-batch rename failure restores earlier handles for retry', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-refs-batch-rollback-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let clock = 1_700_000_000_000
  let failOnStageIndex = 1
  let stageCalls = 0
  const refs = createSecretRefs({
    home,
    now: () => clock,
    fsOps: {
      rename: async (from, to) => {
        // Only count forward staging renames (`*.json` -> `*.json.consuming-*`).
        if (to.includes('.consuming-')) {
          const callIndex = stageCalls
          stageCalls += 1
          if (callIndex === failOnStageIndex) {
            const err = new Error('resource busy or locked')
            err.code = 'EBUSY'
            throw err
          }
        }
        return rename(from, to)
      },
    },
  })
  t.after(() => refs.dispose())

  const s1 = fresh()
  const s2 = fresh()
  const ref1 = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'batch-1', field: 'FIRST', value: s1 })
  const ref2 = await refs.issueRef({ botId: 'b2', sessionId: 's1', requestId: 'batch-2', field: 'SECOND', value: s2 })
  const path1 = join(refs.refsDir, `${ref1.slice('secret-ref:'.length)}.json`)
  const path2 = join(refs.refsDir, `${ref2.slice('secret-ref:'.length)}.json`)

  // Inject EBUSY on staging the 2nd handle: batch fails, 1st handle is rolled back intact, 0 consuming files left.
  await assert.rejects(
    () => refs.consumeRefs([ref1, ref2], { botId: 'b2' }),
    err => err.code === 'SECRET_REF_CONSUME_FAILED' && !err.message.includes(s1) && !err.message.includes(s2),
  )
  assert.equal(existsSync(path1), true, 'first handle must be restored intact on disk after mid-batch failure')
  assert.equal(existsSync(path2), true, 'second handle must remain intact on disk')
  assert.deepEqual(readdirSync(refs.refsDir).filter(name => name.includes('.consuming-')), [])

  // Clear the injected failure and retry the entire batch -> succeeds and removes both handles!
  failOnStageIndex = -1
  const consumed = await refs.consumeRefs([ref1, ref2], { botId: 'b2' })
  assert.equal(consumed.get(ref1), s1)
  assert.equal(consumed.get(ref2), s2)
  assert.equal(existsSync(path1), false)
  assert.equal(existsSync(path2), false)
  assert.deepEqual(readdirSync(refs.refsDir).filter(name => name.includes('.consuming-')), [])

  // Crash-orphaned aged `.consuming-*` files are cleaned up by sweepExpiredRefs, while fresh ones stay.
  const staleConsuming = join(refs.refsDir, `${'a'.repeat(32)}.json.consuming-999-abcdef012345`)
  const freshConsuming = join(refs.refsDir, `${'b'.repeat(32)}.json.consuming-999-fedcba543210`)
  writeFileSync(staleConsuming, '{}')
  writeFileSync(freshConsuming, '{}')
  const oldTime = new Date(clock - 10 * 60_000)
  const freshTime = new Date(clock)
  utimesSync(staleConsuming, oldTime, oldTime)
  utimesSync(freshConsuming, freshTime, freshTime)
  const swept = await refs.sweepExpiredRefs()
  assert.equal(swept, 1)
  assert.equal(existsSync(staleConsuming), false)
  assert.equal(existsSync(freshConsuming), true)

  // Enabling encryption via rekeyRefs removes leftover `.consuming-*` files so no plaintext lingers.
  await refs.rekeyRefs({ fromPassphrase: null, toPassphrase: 'encrypt-pass-123' })
  assert.equal(existsSync(freshConsuming), false, 'rekeyRefs must remove leftover staged consuming files')
})
