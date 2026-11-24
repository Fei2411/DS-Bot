import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
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
