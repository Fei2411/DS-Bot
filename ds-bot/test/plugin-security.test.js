import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, defineBotPlugin } from '../index.js'
import { parsePluginRegistry } from '../src/host/plugins/catalog.js'
import { hashPluginTree, localPluginDirOf, ContentHashError, CONTENT_HASH_LIMITS } from '../src/host/plugins/content-hash.js'
import { consentFingerprint, evaluateConsent } from '../src/host/plugins/consent.js'
import { sanitizePluginEnv, isSafePluginEnvName } from '../src/host/plugins/env.js'
import { createKillListStore, evaluateKillEntry, validateKillListDocument } from '../src/host/plugins/kill-list.js'
import { normalizeExecution, validateExecutionCapabilities, tryNormalizeExecution, EXECUTION_TIERS } from '../src/host/plugins/tiers.js'
import { BROWSER_ALLOWED } from '../src/shared/browser-endpoints.js'
import { fakeContext } from './fake-ctx.js'

function startRuntime({ state, config = {}, services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-plugin-sec-'))
  if (state) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, {
    home,
    pluginFetch: config.pluginFetch ?? (async () => { throw new Error('offline in test') }),
    ...config,
  })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, stop, home }
}

// --- 1. Execution tiers ---

test('execution tier normalization defaults to trusted-worker and validates tier/capability boundaries', () => {
  // Legacy manifests without any declaration load exactly as before: full host trust.
  assert.deepEqual(normalizeExecution({}), {
    execution: 'trusted-worker',
    capabilities: ['entry', 'process', 'worker'],
    unknown: [],
  })
  assert.deepEqual(normalizeExecution({ execution: 'data' }), {
    execution: 'data',
    capabilities: [],
    unknown: [],
  })
  assert.deepEqual(normalizeExecution({ execution: 'declarative' }), {
    execution: 'declarative',
    capabilities: ['entry'],
    unknown: [],
  })
  assert.deepEqual(EXECUTION_TIERS, ['data', 'declarative', 'sandboxed-ui', 'trusted-worker'])

  // `data` cannot declare executable entry/process capabilities.
  assert.throws(() => validateExecutionCapabilities({ execution: 'data', capabilities: ['process'] }), /cannot declare/)
  assert.throws(() => validateExecutionCapabilities({ execution: 'data', capabilities: ['entry'] }), /cannot declare/)
  // `declarative` cannot spawn trusted workers.
  assert.throws(() => validateExecutionCapabilities({ execution: 'declarative', capabilities: ['process'] }), /cannot declare/)
  assert.throws(() => validateExecutionCapabilities({ execution: 'sandboxed-ui', capabilities: ['worker'] }), /cannot declare/)
  // `trusted-worker` may declare anything, including forward-compatible unknown capabilities.
  assert.deepEqual(
    validateExecutionCapabilities({ execution: 'trusted-worker', capabilities: ['process', 'gpu'] }).unknown,
    ['gpu'],
  )
  // Unknown capabilities are fail-closed below trusted-worker.
  assert.throws(() => validateExecutionCapabilities({ execution: 'declarative', capabilities: ['gpu'] }), /Unknown plugin capabilities/)
  assert.equal(tryNormalizeExecution({ execution: 'nonsense' }), null)
})

test('defineBotPlugin rejects confined execution tiers for native mounts', () => {
  assert.throws(() => defineBotPlugin({
    id: 'ext:fake-data',
    name: 'Fake Data',
    execution: 'data',
    mount() {},
  }), /trusted worker/)
  const desc = defineBotPlugin({ id: 'ext:ok', name: 'OK', mount() {} })
  assert.equal(desc.execution, 'trusted-worker')
  assert.deepEqual(desc.capabilities, ['entry', 'process', 'worker'])
})

test('parsePluginRegistry normalizes execution tiers and drops invalid tier declarations', () => {
  const parsed = parsePluginRegistry({
    schemaVersion: 1,
    plugins: [
      {
        id: 'mcp:remote-notes',
        name: 'Remote Notes',
        kind: 'mcp',
        execution: 'declarative',
        capabilities: ['entry'],
        install: { mcp: { transport: 'streamable-http', url: 'https://notes.example.com/mcp' } },
      },
      {
        id: 'mcp:evil-tier',
        name: 'Evil Tier',
        kind: 'mcp',
        execution: 'data',
        capabilities: ['process'],
        install: { mcp: { transport: 'streamable-http', url: 'https://evil.example.com/mcp' } },
      },
      { id: 'dsh:legacy', name: 'Legacy', kind: 'dsh', install: { packageName: 'legacy', spec: 'legacy' } },
    ],
  })
  const notes = parsed.plugins.find(p => p.id === 'mcp:remote-notes')
  assert.equal(notes.execution, 'declarative')
  assert.deepEqual(notes.capabilities, ['entry'])
  // Invalid tier/capability combination drops the whole entry rather than trusting it.
  assert.equal(parsed.plugins.some(p => p.id === 'mcp:evil-tier'), false)
  // Legacy entries without any declaration default to trusted-worker.
  assert.equal(parsed.plugins.find(p => p.id === 'dsh:legacy').execution, 'trusted-worker')
})

// --- 2. Content hash ---

test('hashPluginTree is deterministic, content-sensitive and structure-sensitive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tree-'))
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a.js'), 'export const x = 1\n')
    writeFileSync(join(dir, 'sub', 'b.js'), 'export const y = 2\n')
    const first = await hashPluginTree(dir)
    const again = await hashPluginTree(dir)
    assert.equal(first.hash, again.hash)
    assert.equal(first.files, 3)
    assert.match(first.hash, /^[0-9a-f]{64}$/)

    writeFileSync(join(dir, 'a.js'), 'export const x = 2\n')
    const changed = await hashPluginTree(dir)
    assert.notEqual(changed.hash, first.hash)

    // Same bytes at a different path hash differently: structure is part of the content.
    const other = mkdtempSync(join(tmpdir(), 'ds-bot-tree-b-'))
    try {
      mkdirSync(join(other, 'sub'))
      writeFileSync(join(other, 'a.js'), 'export const x = 2\n')
      writeFileSync(join(other, 'sub', 'c.js'), 'export const y = 2\n')
      const otherHash = await hashPluginTree(other)
      assert.notEqual(otherHash.hash, changed.hash)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hashPluginTree rejects escaping symlinks and caps file count and bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tree-esc-'))
  try {
    writeFileSync(join(dir, 'real.txt'), 'hi')
    // A symlink pointing outside the tree is rejected even when dangling.
    symlinkSync('/etc', join(dir, 'escape'), 'dir')
    await assert.rejects(() => hashPluginTree(dir), error => error instanceof ContentHashError && error.code === 'symlink-escape')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // Relative escape chains are rejected as well.
  const rel = mkdtempSync(join(tmpdir(), 'ds-bot-tree-rel-'))
  try {
    writeFileSync(join(rel, 'real.txt'), 'hi')
    symlinkSync('../../outside', join(rel, 'rel-escape'), 'file')
    await assert.rejects(() => hashPluginTree(rel), error => error.code === 'symlink-escape')
  } finally {
    rmSync(rel, { recursive: true, force: true })
  }

  // Symlinks that stay inside the tree are hashed as link text, never followed.
  const inner = mkdtempSync(join(tmpdir(), 'ds-bot-tree-in-'))
  try {
    writeFileSync(join(inner, 'target.txt'), 'content')
    symlinkSync('target.txt', join(inner, 'inside-link'), 'file')
    const result = await hashPluginTree(inner)
    assert.match(result.hash, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(inner, { recursive: true, force: true })
  }

  // File-count cap stops zip-bomb-shaped trees before unbounded work.
  const many = mkdtempSync(join(tmpdir(), 'ds-bot-tree-many-'))
  try {
    for (let i = 0; i < 5; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x')
    await assert.rejects(() => hashPluginTree(many, { maxFiles: 3 }), error => error.code === 'too-many-files')
    // Byte cap stops large trees.
    writeFileSync(join(many, 'big.bin'), Buffer.alloc(1024))
    await assert.rejects(() => hashPluginTree(many, { maxBytes: 100 }), error => error.code === 'too-large')
    assert.equal(CONTENT_HASH_LIMITS.maxFiles, 2000)
    assert.equal(CONTENT_HASH_LIMITS.maxBytes, 50 * 1024 * 1024)
  } finally {
    rmSync(many, { recursive: true, force: true })
  }
})

test('localPluginDirOf resolves only local path specs', () => {
  assert.equal(localPluginDirOf('/abs/path/plugin'), '/abs/path/plugin')
  assert.equal(localPluginDirOf('file:/abs/path/plugin'), '/abs/path/plugin')
  assert.equal(localPluginDirOf('link:/abs/path/plugin'), '/abs/path/plugin')
  assert.equal(localPluginDirOf('some-npm-package'), null)
  assert.equal(localPluginDirOf('github:org/repo'), null)
  assert.equal(localPluginDirOf('https://example.com/x.tgz'), null)
  assert.equal(localPluginDirOf('relative/path'), null)
  assert.equal(localPluginDirOf(''), null)
})

// --- 3. Consent fingerprint ---

test('consentFingerprint is deterministic and binds capabilities, tier, entry, content hash, and placement', () => {
  const base = {
    kind: 'mcp',
    execution: 'trusted-worker',
    capabilities: ['entry', 'process'],
    entry: 'notes-bin',
    entryArgs: ['--serve'],
    envKeys: ['MODE'],
    slot: null,
    version: null,
    contentHash: null,
    replaces: [],
  }
  const first = consentFingerprint(base)
  // Key order and list order of order-insensitive inputs never change the fingerprint.
  assert.equal(consentFingerprint({ ...base, capabilities: ['process', 'entry'], envKeys: ['MODE'] }), first)
  assert.match(first, /^[0-9a-f]{64}$/)

  // Every bound input invalidates the fingerprint when it changes.
  for (const mutation of [
    { execution: 'sandboxed-ui', capabilities: ['entry'] },
    { capabilities: ['entry'] },
    { entry: 'other-bin' },
    { entryArgs: ['--serve', '--evil'] },
    { envKeys: ['MODE', 'API_KEY'] },
    { slot: 'browser' },
    { version: '2.0.0' },
    { contentHash: 'a'.repeat(64) },
    { replaces: ['other-plugin'] },
  ]) {
    assert.notEqual(consentFingerprint({ ...base, ...mutation }), first, `mutation ${JSON.stringify(mutation)} must change the fingerprint`)
  }
  // argv order is significant.
  assert.notEqual(consentFingerprint({ ...base, entryArgs: ['--x', '--y'] }), consentFingerprint({ ...base, entryArgs: ['--y', '--x'] }))
})

test('evaluateConsent distinguishes baseline, granted, and consent-required states', () => {
  const fp = consentFingerprint({ execution: 'trusted-worker', capabilities: [], entry: 'x' })
  assert.equal(evaluateConsent(undefined, fp).state, 'baseline')
  assert.equal(evaluateConsent(null, fp).state, 'baseline')
  assert.equal(evaluateConsent({ fingerprint: fp, grantedAt: '2026-01-01T00:00:00Z' }, fp).state, 'granted')
  assert.equal(evaluateConsent({ fingerprint: '0'.repeat(64) }, fp).state, 'required')
})

// --- 4. Child-process env allowlist ---

test('sanitizePluginEnv strips host secrets, keeps safe runtime vars, and applies declared env verbatim', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\cmd.exe',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    HTTPS_PROXY: 'http://proxy.corp:8080',
    DEEPSEEK_API_KEY: 'sk-secret-value-here',
    OPENAI_API_KEY: 'sk-other',
    ANTHROPIC_API_KEY: 'sk-ant',
    GITHUB_TOKEN: 'ghp_token',
    GH_TOKEN: 'ghp_other',
    DSH_SECRET_MCP_TOKEN: 'super-secret',
    DSH_HOME: '/home/user/.dsh',
    DS_BOT_SECRETS_PASSPHRASE: 'passphrase',
    NPM_TOKEN: 'npm-token',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CUSTOM_PASSWORD: 'pw',
    LD_PRELOAD: '/evil.so',
    DS_BOT_PACKAGE_MANAGER: '{"command":"x"}',
  }
  const clean = sanitizePluginEnv(base, { PLUGIN_MODE: 'fast', CUSTOM_PASSWORD: 'explicitly-declared' })
  assert.equal(clean.PATH, '/usr/bin:/bin')
  assert.equal(clean.HOME, '/home/user')
  assert.equal(clean.LANG, 'en_US.UTF-8')
  assert.equal(clean.HTTPS_PROXY, 'http://proxy.corp:8080')
  // Host secrets never cross implicitly.
  for (const leaked of [
    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
    'DSH_SECRET_MCP_TOKEN', 'DSH_HOME', 'DS_BOT_SECRETS_PASSPHRASE', 'NPM_TOKEN',
    'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_PASSWORD', 'LD_PRELOAD', 'DS_BOT_PACKAGE_MANAGER',
  ]) {
    if (leaked === 'CUSTOM_PASSWORD') continue
    assert.equal(clean[leaked], undefined, `${leaked} must not survive the allowlist`)
  }
  // Declared plugin env applies verbatim, even overriding a sensitive-looking name,
  // because manifest validation already forced secret material into $DSH_SECRET_* references.
  assert.equal(clean.PLUGIN_MODE, 'fast')
  assert.equal(clean.CUSTOM_PASSWORD, 'explicitly-declared')
  assert.equal(isSafePluginEnvName('PATH'), true)
  assert.equal(isSafePluginEnvName('DEEPSEEK_API_KEY'), false)
})

test('MCP stdio runtime config passes manifest env through and sanitizes the runner layer', async (t) => {
  const mountedConfigs = []
  const fakeLoader = { async import() { return { apply() {} } } }
  const { ctx, rt, call, stop } = startRuntime({
    services: { loader: fakeLoader },
    config: {
      // Only the desktop package-manager runner exists here, so resolution takes that path.
      mcpCommandProbe: bin => bin === '/app/runner',
      mcpPackageManager: { command: '/app/runner', args: [], env: { ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: 'must-not-cross' } },
    },
  })
  t.after(stop)
  ctx.plugin = (_plugin, cfg) => {
    mountedConfigs.push(cfg)
    return { async await() {}, async dispose() {} }
  }
  await rt.load()

  const saved = await call('plugins-custom-save', {
    kind: 'mcp',
    name: 'Env MCP',
    transport: 'stdio',
    packageSpec: 'env-mcp@latest',
    args: [],
    env: { PLUGIN_TOKEN: '$DSH_SECRET_X', MODE: 'prod' },
  })
  assert.equal(saved.ok, true)
  rt.secretValue = () => 'resolved-secret'
  await call('plugins-retry', {})
  assert.ok(mountedConfigs.length > 0)
  const env = mountedConfigs[0].env
  // Declared values (secret reference expanded) pass through verbatim.
  assert.equal(env.PLUGIN_TOKEN, 'resolved-secret')
  assert.equal(env.MODE, 'prod')
  // The runner's own required runtime flag survives the allowlist.
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  // Host credential material in the runner layer never crosses into the child.
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
})

// --- 5. Kill list ---

test('validateKillListDocument enforces schema, monotonic-ready timestamps, and far-future rejection', () => {
  const now = Date.parse('2026-01-15T12:00:00Z')
  const doc = validateKillListDocument({
    schemaVersion: 1,
    issuedAt: '2026-01-15T11:00:00Z',
    entries: [
      { id: 'dsh:evil-plugin', versions: '<2.0.0', reason: 'Remote code execution vulnerability' },
      { id: 'mcp:bad-server', contentHashes: ['a'.repeat(64)] },
      { id: 'dsh:kill-everything' },
      { id: 'dsh:evil-plugin', versions: '<2.0.0' }, // duplicate id is dropped
      { id: '!!invalid!!' },
    ],
  }, { now: () => now })
  assert.equal(doc.entries.length, 3)
  assert.equal(doc.entries[0].reason, 'Remote code execution vulnerability')

  assert.throws(() => validateKillListDocument({ schemaVersion: 2, issuedAt: '2026-01-15T11:00:00Z', entries: [] }, { now: () => now }), /schemaVersion/)
  assert.throws(() => validateKillListDocument({ schemaVersion: 1, entries: [] }, { now: () => now }), /issuedAt/)
  assert.throws(() => validateKillListDocument({ schemaVersion: 1, issuedAt: 'not-a-date', entries: [] }, { now: () => now }), /valid timestamp/)
  // Far-future issuedAt is an anti-rollback attack on the future and rejected.
  assert.throws(() => validateKillListDocument({ schemaVersion: 1, issuedAt: '2026-01-17T12:00:01Z', entries: [] }, { now: () => now }), /far in the future/)
})

test('evaluateKillEntry matches by id, version range, and content hash', () => {
  const list = validateKillListDocument({
    schemaVersion: 1,
    issuedAt: '2026-01-15T11:00:00Z',
    entries: [
      { id: 'dsh:evil-plugin', versions: '>=1.0.0 <2.0.0', reason: 'rce' },
      { id: 'mcp:bad-server', contentHashes: ['b'.repeat(64)] },
      { id: 'dsh:nuclear' },
    ],
  }, { now: () => Date.parse('2026-01-15T12:00:00Z') })

  assert.equal(evaluateKillEntry(list, { id: 'dsh:evil-plugin', version: '1.5.0' })?.reason, 'rce')
  assert.equal(evaluateKillEntry(list, { id: 'dsh:evil-plugin', version: '2.0.0' }), null)
  // Unknown versions do not match semver ranges (and do not blanket-kill either).
  assert.equal(evaluateKillEntry(list, { id: 'dsh:evil-plugin' }), null)
  // Content hash matches exactly regardless of version.
  assert.equal(evaluateKillEntry(list, { id: 'mcp:bad-server', contentHash: 'b'.repeat(64) })?.id, 'mcp:bad-server')
  assert.equal(evaluateKillEntry(list, { id: 'mcp:bad-server', contentHash: 'c'.repeat(64) }), null)
  // Hash-only entries do not match by version.
  assert.equal(evaluateKillEntry(list, { id: 'mcp:bad-server', version: '9.9.9' }), null)
  // Entry with neither versions nor hashes kills every install of the id.
  assert.equal(evaluateKillEntry(list, { id: 'dsh:nuclear', version: '1.0.0' })?.id, 'dsh:nuclear')
  assert.equal(evaluateKillEntry(list, { id: 'dsh:other', version: '1.0.0' }), null)
})

test('kill list store enforces per-source anti-rollback, survives offline, and stays monotonic', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-killstore-'))
  try {
    const cachePath = join(home, 'plugin-kill-list.json')
    const now = Date.parse('2026-01-15T12:00:00Z')
    const store = createKillListStore({ cachePath, now: () => now })

    const older = { schemaVersion: 1, issuedAt: '2026-01-15T10:00:00Z', entries: [{ id: 'dsh:evil', reason: 'v1' }] }
    const newer = { schemaVersion: 1, issuedAt: '2026-01-15T11:00:00Z', entries: [{ id: 'dsh:evil', reason: 'v2' }] }

    // Missing cache: evaluates to nothing, never blocks offline startup.
    assert.equal(store.evaluate({ id: 'dsh:evil' }), null)

    assert.equal((await store.updateFromSource('official', newer)).applied, true)
    assert.equal(store.evaluate({ id: 'dsh:evil' })?.reason, 'v2')

    // Anti-rollback: a replayed older document is ignored.
    const rollback = await store.updateFromSource('official', older)
    assert.equal(rollback.applied, false)
    assert.equal(rollback.reason, 'stale')
    assert.equal(store.evaluate({ id: 'dsh:evil' })?.reason, 'v2')

    // A second independent source adds entries; neither can un-kill the other.
    const other = { schemaVersion: 1, issuedAt: '2026-01-15T10:30:00Z', entries: [{ id: 'mcp:other-evil' }] }
    await store.updateFromSource('third', other)
    assert.equal(store.evaluate({ id: 'mcp:other-evil' })?.id, 'mcp:other-evil')

    // Persistence: a fresh store over the same cache path evaluates offline.
    const cold = createKillListStore({ cachePath, now: () => now })
    assert.equal(cold.evaluate({ id: 'dsh:evil' }), null)
    await cold.load()
    assert.equal(cold.evaluate({ id: 'dsh:evil' })?.reason, 'v2')
    assert.equal(cold.evaluate({ id: 'mcp:other-evil' })?.id, 'mcp:other-evil')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('kill list embedded in the registry document reaches the store through the catalog', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-killreg-'))
  try {
    const killDoc = {
      schemaVersion: 1,
      issuedAt: new Date().toISOString(),
      entries: [{ id: 'dsh:pwned', reason: 'compromised' }],
    }
    const manager = (await import('../src/host/plugins/catalog.js')).createCatalogManager({
      cachePath: join(home, 'cache.json'),
      fetchImpl: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        killList: killDoc,
        plugins: [],
      }), { status: 200 }),
    })
    const snap = await manager.load({ force: true })
    assert.equal(snap.killLists.length, 1)
    assert.equal(snap.killLists[0].sourceId, 'official')
    assert.equal(snap.killLists[0].killList.entries[0].id, 'dsh:pwned')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- 6. End-to-end runtime integration ---

test('killed plugins refuse activation with explicit reason and fall back safely', async (t) => {
  const now = Date.now()
  const killDoc = {
    schemaVersion: 1,
    issuedAt: new Date(now).toISOString(),
    entries: [{ id: 'dsh:dsh-ego-browser', reason: 'Critical vulnerability in browser automation' }],
  }
  const fakePm = {
    async listBundles() {
      return [{
        name: 'dsh-ego-browser',
        official: false,
        availability: 'profile',
        version: '1.0.0',
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        updatable: false,
        rows: [],
        overrides: [],
      }]
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({ schemaVersion: 1, killList: killDoc, plugins: [] }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  const res = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:dsh-ego-browser' })
  assert.equal(res.ok, true)
  assert.equal(res.value.slots.browser.status, 'killed')
  assert.match(res.value.slots.browser.error, /kill list/i)
  assert.match(res.value.slots.browser.error, /Critical vulnerability/)
  // The slot falls back to the safe built-in instead of running the killed plugin.
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly')

  // The killed plugin is visibly marked in the unified view.
  const list = await call('plugins-list', {})
  const ego = list.value.plugins.find(p => p.id === 'dsh:dsh-ego-browser')
  assert.equal(ego.killed, true)
  assert.equal(ego.status, 'killed')

  // The circuit breaker also stops an already-running plugin when a fresh kill
  // arrives with the next catalog refresh — the live distribution path end to end.
  const mutableKillDoc = { schemaVersion: 1, issuedAt: new Date(now - 60_000).toISOString(), entries: [] }
  const fakeLoader = { async import() { return { apply() {} } } }
  const ctx2 = fakeContext({ services: { loader: fakeLoader } })
  ctx2.plugin = () => ({ async await() {}, async dispose() {} })
  const home2 = mkdtempSync(join(tmpdir(), 'ds-bot-killrun-'))
  t.after(async () => {
    await ctx2.dispose()
    rmSync(home2, { recursive: true, force: true, maxRetries: 5 })
  })
  let route2
  const register2 = ctx2.connection.fetch.register
  ctx2.connection.fetch.register = (options) => {
    route2 = options
    return register2(options)
  }
  const rt2 = createRuntime(ctx2, {
    home: home2,
    pluginFetch: async () => new Response(JSON.stringify({ schemaVersion: 1, killList: mutableKillDoc, plugins: [] }), { status: 200 }),
  })
  await rt2.load()
  let disposedLive = false
  rt2.plugins.registerNative(defineBotPlugin({
    id: 'ext:killable',
    name: 'Killable',
    category: 'tools',
    toolPrefixes: ['killable_'],
    mount() { return { dispose() { disposedLive = true } } },
  }))
  await rt2.reconcilePlugins()
  assert.ok(rt2.plugins.getActiveMount('plugin:ext:killable'), 'plugin runs before the kill arrives')

  // A newer kill list lands in the registry; the next forced refresh applies it.
  mutableKillDoc.issuedAt = new Date(now).toISOString()
  mutableKillDoc.entries = [{ id: 'ext:killable', reason: 'bad actor' }]
  const refreshed = await route2.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'plugins-catalog-refresh', payload: {} }),
  })).then(response => response.json())
  assert.equal(refreshed.ok, true)
  assert.equal(rt2.plugins.getActiveMount('plugin:ext:killable'), null, 'running plugin is unmounted by the fresh kill')
  assert.equal(disposedLive, true, 'the live mount is disposed')
  const liveItem = refreshed.value.plugins.find(p => p.id === 'ext:killable')
  assert.equal(liveItem.status, 'killed')

  // A fully offline restart over the same home still refuses activation: the cached
  // kill list alone is enough, no network involved.
  await ctx2.dispose()
  let mountedAfterRestart = false
  const ctx3 = fakeContext({ services: { loader: fakeLoader } })
  ctx3.plugin = () => ({ async await() {}, async dispose() {} })
  const rt3 = createRuntime(ctx3, {
    home: home2,
    pluginFetch: async () => { throw new Error('offline') },
  })
  t.after(() => ctx3.dispose())
  await rt3.load()
  rt3.plugins.registerNative(defineBotPlugin({
    id: 'ext:killable',
    name: 'Killable',
    category: 'tools',
    toolPrefixes: ['killable_'],
    mount() { mountedAfterRestart = true; return { dispose() {} } },
  }))
  await rt3.reconcilePlugins()
  assert.equal(rt3.plugins.getActiveMount('plugin:ext:killable'), null)
  assert.equal(mountedAfterRestart, false, 'the killed plugin must never mount in the new runtime')
  const view = await rt3.pluginEndpoint('list', {})
  const item = view.plugins.find(p => p.id === 'ext:killable')
  assert.equal(item.status, 'killed')
})

test('changed MCP config invalidates consent, blocks reactivation, and explicit consent restores it', async (t) => {
  const fakeLoader = { async import() { return { apply() {} } } }
  const { ctx, rt, call, stop } = startRuntime({ services: { loader: fakeLoader } })
  t.after(stop)
  const mountedConfigs = []
  ctx.plugin = (_plugin, cfg) => {
    mountedConfigs.push(cfg)
    return { async await() {}, async dispose() {} }
  }
  await rt.load()

  // Install a custom MCP and let it activate: first activation records the consent baseline.
  const saved = await call('plugins-custom-save', {
    kind: 'mcp',
    name: 'Consent MCP',
    transport: 'stdio',
    command: 'consent-bin',
    args: ['--serve'],
  })
  assert.equal(saved.ok, true)
  const id = saved.value.entry.id
  assert.ok(mountedConfigs.length >= 1)
  assert.ok(rt.state.plugins.consent[id]?.fingerprint, 'first activation records the baseline fingerprint')

  // The same config re-activating (e.g. after restart reconcile) stays granted.
  await call('plugins-retry', {})
  let view = await call('plugins-list', {})
  let item = view.value.plugins.find(p => p.id === id)
  assert.equal(item.consentRequired, false)
  assert.equal(item.status, 'ready')

  // The manifest changes underneath the approval (registry/custom update): the fingerprint
  // drifts, prior consent is invalidated, and the plugin must not silently run upgraded input.
  const stored = rt.state.plugins.custom[id]
  stored.install.mcp.args = ['--serve', '--remote-control']
  await rt.save()
  await call('plugins-retry', {})
  view = await call('plugins-list', {})
  item = view.value.plugins.find(p => p.id === id)
  assert.equal(item.status, 'consent-required')
  assert.equal(item.consentRequired, true)
  assert.match(item.error, /explicit approval/)
  assert.equal(rt.plugins.getActiveMount(`plugin:${id}`), null, 'changed plugin must not run under stale consent')

  // Explicit consent through the endpoint re-approves exactly the current fingerprint.
  const consent = await call('plugins-consent', { id })
  assert.equal(consent.ok, true)
  assert.equal(consent.value.granted, true)
  const viewAfter = await call('plugins-list', {})
  const itemAfter = viewAfter.value.plugins.find(p => p.id === id)
  assert.equal(itemAfter.consentRequired, false)
  assert.equal(itemAfter.status, 'ready')
  assert.ok(rt.plugins.getActiveMount(`plugin:${id}`), 'plugin runs again after explicit approval')
})

test('consent endpoint refuses killed or unresolvable plugins and stays host-only', async (t) => {
  const { rt, call, stop } = startRuntime()
  t.after(stop)
  await rt.load()

  const missing = await call('plugins-consent', { id: 'dsh:no-such-plugin' })
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /not installed or loaded/)

  // Built-in plugins are trusted by default: consenting them is a harmless no-op.
  const builtin = await call('plugins-consent', { id: 'builtin:readonly' })
  assert.equal(builtin.ok, true)
  assert.equal(builtin.value.granted, true)

  // Remote/browser clients must never reach the consent mutation.
  assert.equal(BROWSER_ALLOWED.has('plugins-consent'), false)
  assert.equal(BROWSER_ALLOWED.has('plugins-custom-save'), false)
})

test('dsh bundle version drift breaks the fast path and invalidates consent', async (t) => {
  const bundle = {
    name: 'drifting-browser',
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    updatable: true,
    rows: [],
    overrides: [],
  }
  const fakePm = { async listBundles() { return [{ ...bundle }] } }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // Activate the bundle in the browser slot: baseline consent covers version 1.0.0.
  const act = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:drifting-browser' })
  assert.equal(act.ok, true)
  assert.equal(act.value.slots.browser.status, 'ready')
  assert.ok(rt.state.plugins.consent['dsh:drifting-browser']?.fingerprint)

  // The package updates underneath (HMR swap or restart after update): the fast path
  // must break and the consent gate must refuse reactivation under stale approval.
  bundle.version = '2.0.0'
  const retry = await call('plugins-retry', {})
  assert.equal(retry.ok, true)
  assert.equal(retry.value.slots.browser.status, 'consent-required')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly', 'falls back instead of running upgraded code')
  const item = retry.value.plugins.find(p => p.id === 'dsh:drifting-browser')
  assert.equal(item.consentRequired, true)

  // Explicit approval of exactly the new version restores activation.
  const consent = await call('plugins-consent', { id: 'dsh:drifting-browser' })
  assert.equal(consent.ok, true)
  const after = await call('plugins-list', {})
  assert.equal(after.value.slots.browser.status, 'ready')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'dsh:drifting-browser')
})

test('plugins view exposes execution tiers and defaults legacy entries to trusted-worker', async (t) => {
  const { rt, call, stop } = startRuntime()
  t.after(stop)
  await rt.load()

  const list = await call('plugins-list', {})
  assert.equal(list.ok, true)
  const readonly = list.value.plugins.find(p => p.id === 'builtin:readonly')
  assert.equal(readonly.execution, 'trusted-worker')
  assert.equal(readonly.consentRequired, false)
  const pw = list.value.plugins.find(p => p.id === 'mcp:playwright-mcp')
  assert.equal(pw.execution, 'trusted-worker')
  assert.deepEqual(pw.capabilities ?? undefined, undefined) // view exposes tier only; capabilities stay in fingerprints
})
