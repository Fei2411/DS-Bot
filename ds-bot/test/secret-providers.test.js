import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createOnePasswordDriver, isOnePasswordReference, validateOnePasswordConfig } from '../src/host/secret-providers/onepassword.js'
import { createProviderRegistry } from '../src/host/secret-providers/registry.js'
import { createSecretResolver } from '../src/host/secret-providers/resolver.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `opval-${randomBytes(10).toString('hex')}`

// Creates a real executable fake `op` CLI backed by Node so tests exercise real
// `child_process.spawn` (shell: false), template file I/O, stdout parsing, fallback,
// timeout/SIGTERM handling, and call counting without requiring a real 1Password CLI.
function createFakeOpBinary(dir, { values = {}, failInject = false, failRead = false, hangMs = 0 } = {}) {
  const statePath = join(dir, 'op-state.json')
  const logPath = join(dir, 'op-calls.jsonl')
  writeFileSync(statePath, JSON.stringify({ values, failInject, failRead, hangMs }))
  const scriptPath = join(dir, process.platform === 'win32' ? 'fake-op.cmd' : 'fake-op')
  const jsPath = join(dir, 'fake-op.mjs')
  writeFileSync(jsPath, `
import { appendFileSync, readFileSync } from 'node:fs'

const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, pid: process.pid }) + '\\n')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (state.hangMs > 0) await delay(state.hangMs)

// Parse flags before subcommand
let i = 0
while (i < args.length && args[i].startsWith('--')) i += 1
const cmd = args[i]

if (cmd === 'inject') {
  if (state.failInject) {
    process.stderr.write('inject failed: simulated error\\n')
    process.exit(1)
  }
  const idx = args.indexOf('-i')
  const tplPath = idx >= 0 ? args[idx + 1] : null
  if (!tplPath) { process.stderr.write('missing -i\\n'); process.exit(2) }
  const tpl = readFileSync(tplPath, 'utf8')
  const out = tpl.replace(/\\{\\{\\s*(op:\\/\\/[^\\s}]+)\\s*\\}\\}/g, (_m, ref) => {
    if (!(ref in state.values)) {
      process.stderr.write('item not found: ' + ref + '\\n')
      process.exit(1)
    }
    return state.values[ref]
  })
  process.stdout.write(out)
  process.exit(0)
}

if (cmd === 'read') {
  if (state.failRead) {
    process.stderr.write('read failed: biometric canceled\\n')
    process.exit(1)
  }
  const ref = args.at(-1)
  if (!(ref in state.values)) {
    process.stderr.write('item not found: ' + ref + '\\n')
    process.exit(1)
  }
  process.stdout.write(state.values[ref])
  process.exit(0)
}

process.stderr.write('unknown command: ' + cmd + '\\n')
process.exit(2)
`)
  if (process.platform === 'win32') {
    writeFileSync(scriptPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`)
  } else {
    writeFileSync(scriptPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`)
    chmodSync(scriptPath, 0o755)
  }
  const readCalls = () => {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  const setState = (patch) => {
    const cur = JSON.parse(readFileSync(statePath, 'utf8'))
    writeFileSync(statePath, JSON.stringify({ ...cur, ...patch }))
  }
  return { bin: scriptPath, readCalls, setState }
}

test('1Password reference and account validation strictly rejects unsafe inputs', () => {
  assert.equal(isOnePasswordReference('op://Private/GitHub/token'), true)
  assert.equal(isOnePasswordReference('op://Dev-Vault/My.App_1/Section+A/api_key'), true)
  for (const bad of [
    '',
    'https://example.com',
    'op://vault/item',
    'op://vault/item/field with space',
    'op://vault/item/field;rm',
    'op://vault/item/$(whoami)',
    'op://vault/../item/field',
    'op://vault/item/field\nline2',
    'op://vault/item/a/b/c',
    'op://vault/item/`id`',
  ]) {
    assert.equal(isOnePasswordReference(bad), false, `expected invalid: ${bad}`)
  }

  assert.deepEqual(validateOnePasswordConfig(undefined), { account: '' })
  assert.deepEqual(validateOnePasswordConfig({ account: 'my.1password.com' }), { account: 'my.1password.com' })
  assert.throws(() => validateOnePasswordConfig({ account: '--evil' }))
  assert.throws(() => validateOnePasswordConfig({ account: 'acct;whoami' }))
})

test('1Password driver batches references in a single `op --cache=false inject -i` call, preserves multiline values, and cleans up template', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-batch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const v1 = fresh()
  const v2 = `-----BEGIN KEY-----\n${fresh()}\n  line2\n-----END KEY-----`
  const fakeOp = createFakeOpBinary(dir, {
    values: {
      'op://Vault/ItemA/token': v1,
      'op://Vault/ItemB/Section/cert': v2,
    },
  })
  const tplDir = mkdtempSync(join(dir, 'tpl-'))
  const driver = createOnePasswordDriver({ bin: fakeOp.bin, tempDir: tplDir })

  const out = await driver.readBatch(
    { account: 'team.1password.com' },
    ['op://Vault/ItemA/token', 'op://Vault/ItemB/Section/cert', 'op://Vault/ItemA/token'],
  )
  assert.equal(out.get('op://Vault/ItemA/token'), v1)
  assert.equal(out.get('op://Vault/ItemB/Section/cert'), v2)

  // Single subprocess invocation with --cache=false and --account=...
  const calls = fakeOp.readCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0], '--cache=false')
  assert.equal(calls[0].args[1], '--account=team.1password.com')
  assert.equal(calls[0].args[2], 'inject')
  assert.equal(calls[0].args[3], '-i')

  // Temp template file was unlinked in finally.
  assert.deepEqual(readdirSync(tplDir), [])
})

test('1Password driver falls back to individual `op --cache=false read --no-newline` when inject fails', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-fallback-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const v1 = fresh()
  const v2 = fresh()
  const fakeOp = createFakeOpBinary(dir, {
    failInject: true,
    values: {
      'op://Vault/One/secret': v1,
      'op://Vault/Two/secret': v2,
    },
  })
  const driver = createOnePasswordDriver({ bin: fakeOp.bin, tempDir: dir })
  const out = await driver.readBatch({}, ['op://Vault/One/secret', 'op://Vault/Two/secret'])
  assert.equal(out.get('op://Vault/One/secret'), v1)
  assert.equal(out.get('op://Vault/Two/secret'), v2)

  const calls = fakeOp.readCalls()
  assert.equal(calls.length, 3)
  assert.equal(calls[0].args[1], 'inject')
  assert.deepEqual(calls[1].args, ['--cache=false', 'read', '--no-newline', 'op://Vault/One/secret'])
  assert.deepEqual(calls[2].args, ['--cache=false', 'read', '--no-newline', 'op://Vault/Two/secret'])
})

test('1Password driver enforces timeout and kills hung child process cleanly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-timeout-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Use a fast-starting shell script on POSIX so parallel test CPU load cannot delay
  // process boot past the short timeout window.
  let bin
  let countCalls
  if (process.platform !== 'win32') {
    const logPath = join(dir, 'hang-calls.log')
    bin = join(dir, 'hang-op')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec sleep 30\n`)
    chmodSync(bin, 0o755)
    countCalls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  } else {
    const fakeOp = createFakeOpBinary(dir, {
      hangMs: 30_000,
      values: { 'op://Vault/Item/key': fresh() },
    })
    bin = fakeOp.bin
    countCalls = () => fakeOp.readCalls().length
  }
  const driver = createOnePasswordDriver({ bin, timeoutMs: 1500, tempDir: dir })
  const started = Date.now()
  await assert.rejects(
    () => driver.readBatch({}, ['op://Vault/Item/key']),
    err => err.code === 'ETIMEDOUT',
  )
  assert.ok(Date.now() - started < 10_000, 'timeout should abort promptly without waiting for child')
  // Only one attempt — does not spawn fallback after timeout.
  assert.equal(countCalls(), 1)
})

test('SecretResolver caches hits lock-free, deduplicates concurrent misses, caches errors, and supports invalidate()', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-resolver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const v1 = fresh()
  const v2 = fresh()
  const fakeOp = createFakeOpBinary(dir, {
    values: { 'op://Vault/App/key': v1 },
  })
  const registry = createProviderRegistry([createOnePasswordDriver({ bin: fakeOp.bin, tempDir: dir })])
  const resolver = createSecretResolver({ registry })

  // Concurrent misses deduplicate into a single subprocess call.
  const item = { providerId: 'onepassword', config: {}, reference: 'op://Vault/App/key' }
  const [r1, r2] = await Promise.all([resolver.resolve([item]), resolver.resolve([item])])
  assert.equal(r1.get(item.reference).value, v1)
  assert.equal(r2.get(item.reference).value, v1)
  assert.equal(fakeOp.readCalls().length, 1)

  // Cache hit returns immediately without spawning `op`.
  const r3 = await resolver.resolve([item])
  assert.equal(r3.get(item.reference).value, v1)
  assert.equal(fakeOp.readCalls().length, 1)

  // Manual invalidate clears cache and re-fetches updated value.
  fakeOp.setState({ values: { 'op://Vault/App/key': v2 } })
  resolver.invalidate('onepassword')
  const r4 = await resolver.resolve([item])
  assert.equal(r4.get(item.reference).value, v2)
  assert.equal(fakeOp.readCalls().length, 2)

  // Failure is cached so repeated tool calls do not re-trigger OS biometric prompts.
  fakeOp.setState({ failInject: true, failRead: true })
  resolver.invalidate()
  const bad1 = await resolver.resolve([item])
  assert.equal(bad1.get(item.reference).ok, false)
  const callsAfterFail = fakeOp.readCalls().length
  const bad2 = await resolver.resolve([item])
  assert.equal(bad2.get(item.reference).ok, false)
  assert.equal(fakeOp.readCalls().length, callsAfterFail, 'cached error must not re-spawn op')

  // Invalidate allows recovery once 1Password is unlocked again.
  fakeOp.setState({ failInject: false, failRead: false, values: { 'op://Vault/App/key': v1 } })
  resolver.invalidate()
  const recovered = await resolver.resolve([item])
  assert.equal(recovered.get(item.reference).ok, true)
  assert.equal(recovered.get(item.reference).value, v1)
})

test('readSecretsSync stays synchronous with mixed vault + external entries, and tools/execute resolves on-demand & rebuilds redactor', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-host-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const vaultVal = fresh()
  const extVal = fresh()
  const fakeOp = createFakeOpBinary(dir, {
    values: { 'op://Prod/API/token': extVal },
  })
  const home = join(dir, 'home')
  writeFileSync(join(dir, 'state.json'), '') // unused
  const TEAM = {
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Main', instructions: '', createdAt: 1 },
      b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
  }
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
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }

  // Pre-populate mixed vault + external secrets.json BEFORE starting runtime.
  const fs = await import('node:fs')
  fs.mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [
      { name: 'VAULT_KEY', value: vaultVal, purpose: 'local', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 },
      { name: 'OP_TOKEN', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/API/token', purpose: 'prod', scope: ['b2'], requestedBy: null, createdAt: 2, updatedAt: 2 },
    ],
  }))

  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    secretProviders: { onepassword: { bin: fakeOp.bin, tempDir: dir } },
  })
  t.after(async () => { await ctx.dispose() })

  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const env = (agentId) => contributors.filter(entry => entry.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: {} }) ?? {}

  // Synchronous startup: VAULT_KEY is immediately available, OP_TOKEN did NOT spawn `op` on boot!
  assert.deepEqual(env('b2'), { DSH_SECRET_VAULT_KEY: vaultVal })
  assert.equal(fakeOp.readCalls().length, 0, 'readSecretsSync must never spawn op on startup')

  // secrets.json holds zero plaintext for OP_TOKEN.
  const disk = readFileSync(join(home, 'secrets.json'), 'utf8')
  assert.equal(disk.includes(extVal), false)

  // Executing a tool for b2 triggers on-demand external resolution AND rebuilds redactor!
  const execute = listeners['tools/execute'].filter(listener => listener.name !== 'listOwnSchedules' && listener.name !== 'computerTrack').at(-1)
  const res = await execute({ agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
    isError: false,
    value: { stdout: `vault=${vaultVal} ext=${extVal}` },
    content: [{ type: 'text', text: `ext=${extVal}` }],
  }))
  assert.equal(fakeOp.readCalls().length, 1)
  assert.equal(res.value.stdout, 'vault=[secret:VAULT_KEY] ext=[secret:OP_TOKEN]')
  assert.equal(res.content[0].text, 'ext=[secret:OP_TOKEN]')

  // Shell env now has both VAULT_KEY and resolved OP_TOKEN for b2, and only VAULT_KEY for m1.
  assert.deepEqual(env('b2'), { DSH_SECRET_VAULT_KEY: vaultVal, DSH_SECRET_OP_TOKEN: extVal })
  assert.deepEqual(env('m1'), { DSH_SECRET_VAULT_KEY: vaultVal })

  // Adding a new external secret via secret-set stores only the reference on disk.
  const added = await call('secret-set', { name: 'NEW_OP', reference: 'op://Prod/API/token', purpose: 'via UI', scope: 'all' })
  assert.equal(added.ok, true, JSON.stringify(added.error))
  assert.equal(added.value.kind, 'external')
  assert.equal(added.value.reference, 'op://Prod/API/token')
  const updatedDisk = readFileSync(join(home, 'secrets.json'), 'utf8')
  assert.equal(updatedDisk.includes(extVal), false)

  // Refresh endpoint clears cache.
  const refreshed = await call('secret-refresh-external', {})
  assert.equal(refreshed.ok, true)
  assert.equal(rt.secretValue('OP_TOKEN'), undefined)
})
