import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  return { bin: process.execPath, binArgs: [jsPath], scriptPath, readCalls, setState }
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
  const driver = createOnePasswordDriver({ bin: fakeOp.bin, binArgs: fakeOp.binArgs, tempDir: tplDir })

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
  const driver = createOnePasswordDriver({ bin: fakeOp.bin, binArgs: fakeOp.binArgs, tempDir: dir })
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
  let binArgs = []
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
    binArgs = fakeOp.binArgs
    countCalls = () => fakeOp.readCalls().length
  }
  const driver = createOnePasswordDriver({ bin, binArgs, timeoutMs: process.platform === 'win32' ? 3500 : 2500, tempDir: dir })
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
  const registry = createProviderRegistry([createOnePasswordDriver({ bin: fakeOp.bin, binArgs: fakeOp.binArgs, tempDir: dir })])
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
      b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', model: 'local-codex-cli/default', instructions: '', createdAt: 2 },
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
    secretProviders: { onepassword: { bin: fakeOp.bin, binArgs: fakeOp.binArgs } },
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

  // Calling pure host built-in or non-shell tools must NOT trigger `op` (0 spawns, no Touch ID prompt),
  // while still redacting already-known secrets!
  const execute = listeners['tools/execute'].filter(listener => listener.name !== 'listOwnSchedules' && listener.name !== 'computerTrack').at(-1)
  for (const toolName of ['list_secrets', 'request_secret', 'ask_user', 'show_view', 'read_own_chat', 'read_group_chat', 'save_capability', 'read_file']) {
    const builtinRes = await execute({ name: toolName, agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
      isError: false,
      value: { text: `vault=${vaultVal}` },
    }))
    assert.equal(builtinRes.value.text, 'vault=[secret:VAULT_KEY]')
  }
  assert.equal(fakeOp.readCalls().length, 0, 'non-shell host built-in tools must spawn op 0 times')

  // Executing a shell tool (`bash`) for b2 triggers 1 batched `op inject` using private `<home>/secret-files` tempDir AND rebuilds redactor!
  const res = await execute({ name: 'bash', agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
    isError: false,
    value: { stdout: `vault=${vaultVal} ext=${extVal}` },
    content: [{ type: 'text', text: `ext=${extVal}` }],
  }))
  const calls = fakeOp.readCalls()
  assert.equal(calls.length, 1)
  const tplIdx = calls[0].args.indexOf('-i')
  assert.ok(tplIdx >= 0)
  const tplPath = calls[0].args[tplIdx + 1]
  const privateDir = join(home, 'secret-files')
  const opTempDir = join(privateDir, '_op')
  assert.equal(tplPath.startsWith(opTempDir), true, `inject template must live in private ${opTempDir}, got ${tplPath}`)
  assert.equal(existsSync(tplPath), false, 'inject template must be unlinked after op inject')
  if (process.platform !== 'win32') {
    assert.equal(statSync(privateDir).mode & 0o777, 0o700)
    assert.equal(statSync(opTempDir).mode & 0o777, 0o700)
  }
  assert.equal(res.value.stdout, 'vault=[secret:VAULT_KEY] ext=[secret:OP_TOKEN]')
  assert.equal(res.content[0].text, 'ext=[secret:OP_TOKEN]')

  // Shell env now has both VAULT_KEY and resolved OP_TOKEN for b2, and only VAULT_KEY for m1.
  assert.deepEqual(env('b2'), { DSH_SECRET_VAULT_KEY: vaultVal, DSH_SECRET_OP_TOKEN: extVal })
  assert.deepEqual(env('m1'), { DSH_SECRET_VAULT_KEY: vaultVal })

  await t.test('a Codex launch resolves only its authorized external references on a cold cache', async (t) => {
    assert.equal((await call('secret-refresh-external', {})).ok, true)
    assert.equal(rt.secretValue('OP_TOKEN'), undefined)
    await rt.load()
    const provider = 'local-codex-cli'
    const { adapter } = ctx.adapters.find(entry => entry.routes.includes(provider))
    const spawn = t.mock.method(adapter.deps, 'spawnEngine', () => ({}))
    const launch = sessionId => adapter.liveFor({ sessionId, provider, model: 'default' }, 'workspace-write')
    await launch('m1')
    assert.equal(spawn.mock.calls[0].arguments[2].env?.DSH_SECRET_OP_TOKEN, undefined)
    assert.equal(fakeOp.readCalls().length, 1, 'no lookup for the denied Bot')
    await launch('b2')
    assert.equal(spawn.mock.calls[1].arguments[2].env?.DSH_SECRET_OP_TOKEN === extVal, true)
    assert.equal(fakeOp.readCalls().length, 2, 'authorized Codex launch read the reference once')
  })

  // Invalid 1Password account in set-prefs returns bot/invalid (parameter error).
  const badPrefs = await call('set-prefs', { secretProviders: { onepassword: { account: '--evil' } } })
  assert.equal(badPrefs.ok, false)
  assert.equal(badPrefs.error.code, 'bot/invalid')

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

test('startup drains all async effects with zero op spawns when no connector or MCP references external secrets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-boot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const vA = fresh()
  const vB = fresh()
  const fakeOp = createFakeOpBinary(dir, {
    values: {
      'op://Prod/A/token': vA,
      'op://Prod/B/token': vB,
    },
  })
  const home = join(dir, 'home')
  const fs = await import('node:fs')
  fs.mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Main', instructions: '', capabilities: ['plain-mcp'], createdAt: 1 },
    },
    capabilities: {
      items: {
        'plain-mcp': { name: 'plain-mcp', kind: 'mcp', transport: 'streamable-http', url: 'https://plain.example/mcp', headers: {}, approved: true, createdAt: 1, updatedAt: 1 },
        'uses-a': { name: 'uses-a', kind: 'mcp', transport: 'streamable-http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_OP_A' }, approved: true, createdAt: 1, updatedAt: 1 },
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
  }))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [
      { name: 'OP_A', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/A/token', purpose: 'A', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 },
      { name: 'OP_B', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/B/token', purpose: 'B', scope: 'all', requestedBy: null, createdAt: 2, updatedAt: 2 },
    ],
  }))

  const mountedConfigs = []
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const agent = {
    id: 'm1',
    session: { id: 'm1' },
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
  ctx.sessionController = { resolveAgent: async () => ({ agent }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    secretProviders: { onepassword: { bin: fakeOp.bin, binArgs: fakeOp.binArgs, tempDir: dir } },
  })
  t.after(async () => { await ctx.dispose() })

  // Drain all startup ctx.effect async chains (connectors sync, capabilities startup, secret loading).
  await rt.load()
  await rt.loadSecrets()
  await rt.reconcileCapabilities()
  await new Promise(resolve => setTimeout(resolve, 100))

  // Zero `op` spawns on boot even with external secrets in secrets.json AND a mounted MCP without secret refs!
  assert.equal(fakeOp.readCalls().length, 0, 'startup must spawn op 0 times when no connector/MCP references external secrets')
  assert.ok(mountedConfigs.find(c => c?.serverName === 'plain-mcp'))

  // Attaching an MCP that references ONLY $DSH_SECRET_OP_A resolves ONLY OP_A (never OP_B)!
  await rt.changeCapabilityAttachment('attach', { name: 'uses-a' }, 'm1')
  await rt.reconcileCapabilities()
  assert.equal(fakeOp.readCalls().length, 1)
  assert.equal(rt.secretValue('OP_A'), vA)
  assert.equal(rt.secretValue('OP_B'), undefined, 'unreferenced OP_B must remain uncached/unresolved')
  assert.equal(mountedConfigs.find(c => c?.serverName === 'uses-a')?.headers?.Authorization, `Bearer ${vA}`)

  // Targeted invalidation in secret-set: updating OP_B must NOT invalidate cached OP_A!
  await rt.secretEndpoint('secret-set', { name: 'OP_B', reference: 'op://Prod/B/token', scope: 'all' })
  assert.equal(rt.secretValue('OP_A'), vA, 'secret-set on OP_B must not wipe cached OP_A')
})

test('SecretResolver isolates per-caller AbortSignal from shared single-flight batches', async () => {
  let batchStarts = 0
  let batchAborted = false
  let releaseDriver
  const driver = {
    kind: 'mock',
    label: 'Mock',
    isReference: ref => ref.startsWith('mock://'),
    validateConfig: () => ({}),
    readBatch: (_cfg, refs, signal) => new Promise((resolve, reject) => {
      batchStarts += 1
      const onAbort = () => {
        batchAborted = true
        reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      releaseDriver = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(new Map(refs.map(r => [r, `val-${r}`])))
      }
    }),
  }
  const resolver = createSecretResolver({ registry: createProviderRegistry([driver]) })
  const item = { providerId: 'mock', config: {}, reference: 'mock://shared/token' }

  // 1. Caller A aborts while Caller B is still waiting -> only Caller A rejects; Caller B gets shared result!
  const acA = new AbortController()
  const acB = new AbortController()
  const pA = resolver.resolve([item], { signal: acA.signal })
  const pB = resolver.resolve([item], { signal: acB.signal })
  await new Promise(resolve => setImmediate(resolve))
  acA.abort()
  await assert.rejects(() => pA, err => err.code === 'ABORT_ERR')
  assert.equal(batchAborted, false, 'underlying readBatch must NOT abort while Caller B is still waiting')
  releaseDriver()
  const resB = await pB
  assert.equal(resB.get(item.reference).ok, true)
  assert.equal(resB.get(item.reference).value, 'val-mock://shared/token')
  assert.equal(batchStarts, 1)

  // 2. When ALL waiting callers abort, underlying driver.readBatch IS aborted and error is NOT cached!
  const item2 = { providerId: 'mock', config: {}, reference: 'mock://all-abort/token' }
  const ac1 = new AbortController()
  const ac2 = new AbortController()
  const p1 = resolver.resolve([item2], { signal: ac1.signal })
  const p2 = resolver.resolve([item2], { signal: ac2.signal })
  await new Promise(resolve => setImmediate(resolve))
  ac1.abort()
  await assert.rejects(() => p1, err => err.code === 'ABORT_ERR')
  assert.equal(batchAborted, false)
  ac2.abort()
  await assert.rejects(() => p2, err => err.code === 'ABORT_ERR')
  assert.equal(batchAborted, true, 'underlying readBatch MUST abort once all callers abort')
  assert.equal(resolver.getCached('mock', {}, item2.reference), undefined, 'aborted batch must not be cached')
})

test('1Password fallback isolates per-ref errors so one missing ref does not poison valid refs in the same batch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-partial-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const goodVal = fresh()
  const fakeOp = createFakeOpBinary(dir, {
    values: {
      'op://Vault/Good/secret': goodVal,
      // op://Vault/Missing/secret intentionally omitted so inject fails and fallback runs per-ref!
    },
  })
  const registry = createProviderRegistry([createOnePasswordDriver({ bin: fakeOp.bin, binArgs: fakeOp.binArgs, tempDir: dir })])
  const resolver = createSecretResolver({ registry })

  const items = [
    { providerId: 'onepassword', config: {}, reference: 'op://Vault/Missing/secret' },
    { providerId: 'onepassword', config: {}, reference: 'op://Vault/Good/secret' },
  ]
  const out = await resolver.resolve(items)
  assert.equal(out.get('op://Vault/Good/secret').ok, true)
  assert.equal(out.get('op://Vault/Good/secret').value, goodVal)
  assert.equal(out.get('op://Vault/Missing/secret').ok, false)

  // Subsequent lookup hits cache cleanly for BOTH without spawning op again.
  const callsAfter = fakeOp.readCalls().length
  const cachedGood = resolver.getCached('onepassword', {}, 'op://Vault/Good/secret')
  const cachedBad = resolver.getCached('onepassword', {}, 'op://Vault/Missing/secret')
  assert.equal(cachedGood.ok, true)
  assert.equal(cachedGood.value, goodVal)
  assert.equal(cachedBad.ok, false)
  await resolver.resolve(items)
  assert.equal(fakeOp.readCalls().length, callsAfter)
})

test('1Password driver safely unwraps Windows .cmd shims without spawn EINVAL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-shim-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const v1 = fresh()
  const fakeOp = createFakeOpBinary(dir, { values: { 'op://Vault/Shim/key': v1 } })
  // Exercises scriptPath directly: POSIX executable shell script on Unix, .cmd shim via launchOf on Windows.
  const driver = createOnePasswordDriver({ bin: fakeOp.scriptPath, tempDir: dir })
  const out = await driver.readBatch({}, ['op://Vault/Shim/key'])
  assert.equal(out.get('op://Vault/Shim/key'), v1)
})

test('invalidateExternal keeps redacting previously resolved external values in tool results and LLM requests before and after rotation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-retired-redact-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const oldToken = `old-${fresh()}`
  const newToken = `new-${fresh()}`
  const fakeOp = createFakeOpBinary(dir, {
    values: { 'op://Prod/API/token': oldToken },
  })
  const home = join(dir, 'home')
  const fs = await import('node:fs')
  fs.mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
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
  }))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [
      { name: 'OP_TOKEN', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/API/token', purpose: 'prod', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 },
    ],
  }))

  const ctx = fakeContext()
  const listeners = {}
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    ;(listeners[name] ??= []).push(listener)
    return on(name, listener, options)
  }
  const streamed = []
  ctx.llm.stream = (options) => {
    streamed.push(options)
    return (async function* () {})()
  }
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    secretProviders: { onepassword: { bin: fakeOp.bin, binArgs: fakeOp.binArgs } },
  })
  t.after(async () => { await ctx.dispose() })

  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const execute = listeners['tools/execute'].filter(l => l.name !== 'listOwnSchedules' && l.name !== 'computerTrack').at(-1)
  // The usage meter registers after the secrets listener.
  const streamHook = listeners['llm/stream'].at(-2)

  // 1. Initial resolution caches oldToken and redacts it.
  await rt.resolveExternalForBot('b2')
  assert.equal(rt.secretValue('OP_TOKEN'), oldToken)
  assert.equal(rt.redactSecrets(`v=${oldToken}`), 'v=[secret:OP_TOKEN]')

  // 2. Rotate upstream 1Password secret and call invalidateExternal() (BEFORE re-resolving newToken).
  fakeOp.setState({ values: { 'op://Prod/API/token': newToken } })
  assert.equal((await call('secret-refresh-external', {})).ok, true)
  assert.equal(rt.secretValue('OP_TOKEN'), undefined)

  // Running subprocess still holding oldToken MUST still be redacted in both tool results and LLM requests!
  const midToolRes = await execute({ name: 'read_file', agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
    isError: false,
    value: { stdout: `stale=${oldToken}` },
  }))
  assert.equal(midToolRes.value.stdout, 'stale=[secret:OP_TOKEN]')

  streamed.length = 0
  streamHook({ messages: [{ role: 'user', content: `leaked ${oldToken}` }], system: `sys ${oldToken}` }, () => 'pass')
  assert.equal(streamed.length, 1)
  assert.equal(streamed[0].messages[0].content, 'leaked [secret:OP_TOKEN]')
  assert.equal(streamed[0].system, 'sys [secret:OP_TOKEN]')

  // 3. Re-resolving fetches newToken, and BOTH oldToken AND newToken are redacted!
  await rt.resolveExternalForBot('b2')
  assert.equal(rt.secretValue('OP_TOKEN'), newToken)
  const postToolRes = await execute({ name: 'read_file', agent: { id: 'b2', session: { header: { id: 'b2' } } } }, async () => ({
    isError: false,
    value: { stdout: `old=${oldToken} new=${newToken}` },
  }))
  assert.equal(postToolRes.value.stdout, 'old=[secret:OP_TOKEN] new=[secret:OP_TOKEN]')

  streamed.length = 0
  streamHook({ messages: [{ role: 'user', content: `${oldToken} and ${newToken}` }] }, () => 'pass')
  assert.equal(streamed.length, 1)
  assert.equal(streamed[0].messages[0].content, '[secret:OP_TOKEN] and [secret:OP_TOKEN]')

  // 4. Deleting the external secret also preserves process-lifetime redaction for already-injected values.
  assert.equal((await call('secret-delete', { name: 'OP_TOKEN' })).ok, true)
  assert.equal(rt.redactSecrets(`${oldToken} ${newToken}`), '[secret:OP_TOKEN] [secret:OP_TOKEN]')
  // Nothing persisted to secrets.json.
  const disk = readFileSync(join(home, 'secrets.json'), 'utf8')
  assert.equal(disk.includes(oldToken), false)
  assert.equal(disk.includes(newToken), false)
})

test('deleting or rebinding one external alias key keeps sibling alias cache and Shell File Mode file intact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-op-shared-ref-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sharedVal = `shared-${fresh()}`
  const fakeOp = createFakeOpBinary(dir, {
    values: { 'op://Prod/Deploy/token': sharedVal },
  })
  const home = join(dir, 'home')
  const fs = await import('node:fs')
  fs.mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
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
    prefs: { secretShellMode: 'file' },
  }))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [
      { name: 'DEPLOY_TOKEN', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/Deploy/token', purpose: 'deploy', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 },
      { name: 'CI_TOKEN', kind: 'external', providerId: 'onepassword', reference: 'op://Prod/Deploy/token', purpose: 'ci', scope: 'all', requestedBy: null, createdAt: 2, updatedAt: 2 },
    ],
  }))

  const contributors = []
  const shellEnv = {
    register(contributor) {
      const entry = { ...contributor, live: true }
      contributors.push(entry)
      return () => { entry.live = false }
    },
  }
  const ctx = fakeContext({ services: { shellEnv } })
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup: () => {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    secretProviders: { onepassword: { bin: fakeOp.bin, binArgs: fakeOp.binArgs } },
  })
  t.after(async () => { await ctx.dispose() })

  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const env = (agentId) => contributors.filter(entry => entry.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: {} }) ?? {}

  // Resolve both aliases once (1 op call) and materialize both Shell File Mode files for b2.
  await rt.resolveExternalForBot('b2')
  assert.equal(fakeOp.readCalls().length, 1)
  assert.equal(rt.secretValue('DEPLOY_TOKEN'), sharedVal)
  assert.equal(rt.secretValue('CI_TOKEN'), sharedVal)

  const envBefore = env('b2')
  const deployFile = envBefore.DSH_SECRET_FILE_DEPLOY_TOKEN
  const ciFile = envBefore.DSH_SECRET_FILE_CI_TOKEN
  assert.ok(deployFile && existsSync(deployFile))
  assert.ok(ciFile && existsSync(ciFile))
  assert.notEqual(deployFile, ciFile)
  assert.equal(readFileSync(deployFile, 'utf8'), sharedVal)
  assert.equal(readFileSync(ciFile, 'utf8'), sharedVal)

  // Deleting DEPLOY_TOKEN unlinks DEPLOY_TOKEN's file, keeps CI_TOKEN's cache & file intact, and never re-spawns op!
  assert.equal((await call('secret-delete', { name: 'DEPLOY_TOKEN' })).ok, true)
  assert.equal(existsSync(deployFile), false, 'deleted alias shell file must be removed')
  assert.equal(rt.secrets.activeShellFilePaths().has(deployFile), false)
  assert.equal(rt.secretValue('CI_TOKEN'), sharedVal, 'surviving alias must keep its cached value')
  assert.equal(existsSync(ciFile), true, 'surviving alias shell file must stay on disk')
  assert.equal(rt.secrets.activeShellFilePaths().has(ciFile), true)

  const envAfterDelete = env('b2')
  assert.equal(envAfterDelete.DSH_SECRET_FILE_DEPLOY_TOKEN, undefined)
  assert.equal(envAfterDelete.DSH_SECRET_FILE_CI_TOKEN, ciFile, 'surviving alias shell file path must stay unchanged')
  await rt.resolveExternalForBot('b2')
  assert.equal(fakeOp.readCalls().length, 1, 'deleting one alias must not trigger op re-fetch for surviving alias')

  // Adding a third alias pointing to the same ref reuses cache without disrupting CI_TOKEN's file.
  assert.equal((await call('secret-set', { name: 'THIRD_TOKEN', reference: 'op://Prod/Deploy/token', scope: 'all' })).ok, true)
  assert.equal(rt.secretValue('CI_TOKEN'), sharedVal)
  assert.equal(rt.secretValue('THIRD_TOKEN'), sharedVal)
  assert.equal(existsSync(ciFile), true)
  assert.equal(env('b2').DSH_SECRET_FILE_CI_TOKEN, ciFile)

  // Replacing THIRD_TOKEN with a local vault value also leaves CI_TOKEN's cache & file intact.
  assert.equal((await call('secret-set', { name: 'THIRD_TOKEN', value: `local-${fresh()}`, scope: 'all' })).ok, true)
  assert.equal(rt.secretValue('CI_TOKEN'), sharedVal)
  assert.equal(existsSync(ciFile), true)
  assert.equal(fakeOp.readCalls().length, 1)

  // Deleting the last remaining alias (CI_TOKEN) unlinks its file, clears cache, and keeps process redaction.
  assert.equal((await call('secret-delete', { name: 'CI_TOKEN' })).ok, true)
  assert.equal(existsSync(ciFile), false)
  assert.equal(rt.secretValue('CI_TOKEN'), undefined)
  assert.equal(rt.redactSecrets(`leaked=${sharedVal}`), 'leaked=[secret:CI_TOKEN]')
})
