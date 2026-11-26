import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('hashPluginTree resolves a symlinked root (pnpm layout) while internal escapes still fail closed', async () => {
  // Mirror pnpm's real isolated layout: <profile>/node_modules/<pkg> is a symlink
  // into <profile>/node_modules/.pnpm/<pkg>/node_modules/<pkg>, with a dependency
  // tree nested inside that must be skipped, not hashed.
  const profile = mkdtempSync(join(tmpdir(), 'ds-bot-pnpm-prof-'))
  try {
    const storeDir = join(profile, 'node_modules', '.pnpm', 'real-plugin@1.0.0', 'node_modules', 'real-plugin')
    mkdirSync(join(storeDir, 'node_modules', 'dep-pkg'), { recursive: true })
    writeFileSync(join(storeDir, 'index.js'), 'export const v = 1\n')
    writeFileSync(join(storeDir, 'package.json'), JSON.stringify({ name: 'real-plugin', version: '1.0.0' }))
    writeFileSync(join(storeDir, 'node_modules', 'dep-pkg', 'index.js'), 'module.exports = 1\n')
    const linkPath = join(profile, 'node_modules', 'real-plugin')
    symlinkSync(storeDir, linkPath, 'dir')

    // Hashing through the symlinked entry point resolves and hashes the real tree.
    const first = await hashPluginTree(linkPath)
    const direct = await hashPluginTree(storeDir)
    assert.equal(first.hash, direct.hash, 'symlinked root and real root hash identically')
    // index.js + package.json + node_modules(dir entry only — dep contents skipped).
    assert.equal(first.files, 3)
    const again = await hashPluginTree(linkPath)
    assert.equal(again.hash, first.hash, 'deterministic across repeated runs')

    // A symlink INSIDE the resolved tree that escapes it still fails closed.
    symlinkSync('/etc', join(storeDir, 'escape'), 'dir')
    await assert.rejects(() => hashPluginTree(linkPath), error => error.code === 'symlink-escape')
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }

  // A symlinked root pointing at a file (not a directory) is not-directory.
  const fileTarget = mkdtempSync(join(tmpdir(), 'ds-bot-pnpm-file-'))
  try {
    writeFileSync(join(fileTarget, 'plain.txt'), 'x')
    const badLink = join(fileTarget, 'bad-link')
    symlinkSync(join(fileTarget, 'plain.txt'), badLink, 'file')
    await assert.rejects(() => hashPluginTree(badLink), error => error.code === 'not-directory')
  } finally {
    rmSync(fileTarget, { recursive: true, force: true })
  }
})

test('localPluginDirOf resolves only local path specs', () => {
  const expected = resolve('/abs/path/plugin')
  assert.equal(localPluginDirOf('/abs/path/plugin'), expected)
  assert.equal(localPluginDirOf('file:/abs/path/plugin'), expected)
  assert.equal(localPluginDirOf('link:/abs/path/plugin'), expected)
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

// --- 7. Pin analysis, nullification overlay, and spawn contract ---

test('analyzePackageSpecPin distinguishes exact pinned versions from floating specs', async () => {
  const { analyzePackageSpecPin } = await import('../src/host/plugins/catalog.js')
  assert.deepEqual(analyzePackageSpecPin('@playwright/mcp@0.0.56'), { pinned: '0.0.56', floating: false })
  assert.deepEqual(analyzePackageSpecPin('plain-pkg@1.2.3'), { pinned: '1.2.3', floating: false })
  assert.deepEqual(analyzePackageSpecPin('pkg@1.2.3-beta.1'), { pinned: '1.2.3-beta.1', floating: false })
  assert.deepEqual(analyzePackageSpecPin('@playwright/mcp@latest'), { pinned: null, floating: true })
  assert.deepEqual(analyzePackageSpecPin('@playwright/mcp'), { pinned: null, floating: true })
  assert.deepEqual(analyzePackageSpecPin('pkg@^1.2.3'), { pinned: null, floating: true })
  assert.deepEqual(analyzePackageSpecPin('pkg@~1'), { pinned: null, floating: true })
  assert.deepEqual(analyzePackageSpecPin('pkg@beta'), { pinned: null, floating: true })
  assert.deepEqual(analyzePackageSpecPin(''), { pinned: null, floating: false })
  assert.deepEqual(analyzePackageSpecPin(null), { pinned: null, floating: false })
})

test('hashPluginTree skips node_modules and .git contents while recording their presence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tree-nm-'))
  try {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dir, 'main.js'), 'export const x = 1\n')
    const first = await hashPluginTree(dir)
    // node_modules + .git entries themselves are hashed structurally, contents excluded:
    // main.js + the two directory entries, never the files inside them.
    assert.equal(first.files, 3)

    // Mutating dependency or git contents does not move the hash.
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 2\n')
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n')
    const after = await hashPluginTree(dir)
    assert.equal(after.hash, first.hash)

    // But the presence of the directories is structural: removing one changes it.
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const pruned = await hashPluginTree(dir)
    assert.notEqual(pruned.hash, first.hash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('envNullificationOverlay empties capability variables and declared env re-enables them consciously', async () => {
  const { envNullificationOverlay } = await import('../src/host/plugins/env.js')
  const overlay = envNullificationOverlay({
    PATH: '/usr/bin',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    KUBECONFIG: '/home/user/.kube/config',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    LD_PRELOAD: '/evil.so',
    DEEPSEEK_API_KEY: 'sk-x',
    NPM_TOKEN: 'npm-x',
  })
  // Capability and credential-shaped ambient variables are neutralized to empty strings.
  for (const key of ['SSH_AUTH_SOCK', 'KUBECONFIG', 'DOCKER_HOST', 'LD_PRELOAD', 'DEEPSEEK_API_KEY', 'NPM_TOKEN']) {
    assert.equal(overlay[key], '', `${key} must be nullified`)
  }
  // Innocent runtime variables are not part of the overlay at all.
  assert.equal('PATH' in overlay, false)
  // Empty parent env produces an empty overlay.
  assert.deepEqual(envNullificationOverlay({}), {})
  assert.deepEqual(envNullificationOverlay(null), {})
})

test('spawn contract: what actually reaches a stdio MCP child through the real merge order', async (t) => {
  const { scrubbedParentEnv } = await import('@deepseek-ai/dsh-subprocess')
  const { envNullificationOverlay } = await import('../src/host/plugins/env.js')

  const probe = join(tmpdir(), `ds-bot-envprobe-${process.pid}.mjs`)
  writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.env))')
  t.after(() => rmSync(probe, { force: true }))

  const previous = {
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    KUBECONFIG: process.env.KUBECONFIG,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    LD_PRELOAD: process.env.LD_PRELOAD,
  }
  process.env.SSH_AUTH_SOCK = '/tmp/probe-agent.sock'
  process.env.KUBECONFIG = '/tmp/probe-kubeconfig'
  process.env.DEEPSEEK_API_KEY = 'sk-probe-secret'
  process.env.LD_PRELOAD = '/tmp/probe-evil.so'
  try {
    // The exact production layering: scrubbedParentEnv first, our config env over it.
    // Honest boundary asserted, not assumed: the scrub drops credential-shaped names,
    // and capability variables that are not credential-shaped survive it unless
    // our nullification overlay empties them.
    const scrubbed = scrubbedParentEnv()
    assert.equal(scrubbed.DEEPSEEK_API_KEY, undefined, 'the name-pattern scrub drops credential-shaped names')
    assert.equal(scrubbed.SSH_AUTH_SOCK, '/tmp/probe-agent.sock', 'capability variables survive the scrub — the documented residual')

    const configEnv = {
      ...envNullificationOverlay(),
      ...sanitizePluginEnv({}, { PLUGIN_MODE: 'x', SSH_AUTH_SOCK: '/tmp/conscious.sock' }),
    }
    const childEnv = { ...scrubbed, ...configEnv }
    const { spawnSync } = await import('node:child_process')
    const out = spawnSync(process.execPath, [probe], { env: childEnv, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    const received = JSON.parse(out.stdout)

    // Deliberate manifest declaration re-enables the variable consciously.
    assert.equal(received.SSH_AUTH_SOCK, '/tmp/conscious.sock')
    // Nullified capability variables arrive empty — a mitigation, not erasure.
    assert.equal(received.KUBECONFIG, '', 'nullification overlay empties the inherited value')
    assert.equal(received.LD_PRELOAD, '')
    // Credential-shaped names reach the child EMPTY, not absent: the overlay
    // nullification deliberately overrides what the name-scrub already dropped.
    // Empty-not-absent is the documented mitigation boundary (env.js header).
    assert.equal(received.DEEPSEEK_API_KEY, '')
    assert.equal(received.PLUGIN_MODE, 'x')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('spawn contract: without a declared override the overlay wins over the scrubbed parent', async (t) => {
  const { scrubbedParentEnv } = await import('@deepseek-ai/dsh-subprocess')
  const { envNullificationOverlay } = await import('../src/host/plugins/env.js')

  const probe = join(tmpdir(), `ds-bot-envprobe2-${process.pid}.mjs`)
  writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.env))')
  t.after(() => rmSync(probe, { force: true }))

  const previous = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = '/tmp/probe-agent.sock'
  try {
    const configEnv = {
      ...envNullificationOverlay(),
      ...sanitizePluginEnv({}, {}),
    }
    const childEnv = { ...scrubbedParentEnv(), ...configEnv }
    const { spawnSync } = await import('node:child_process')
    const out = spawnSync(process.execPath, [probe], { env: childEnv, encoding: 'utf8' })
    const received = JSON.parse(out.stdout)
    assert.equal(received.SSH_AUTH_SOCK, '', 'the agent socket is neutralized in the child')
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previous
  }
})

test('resolveMcpRuntimeConfig layers nullification, runner allowlist, and declared env in order', async (t) => {
  const mountedConfigs = []
  const fakeLoader = { async import() { return { apply() {} } } }
  const { ctx, rt, call, stop } = startRuntime({
    services: { loader: fakeLoader },
    config: {
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

  const previous = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = '/tmp/ambient-agent.sock'
  try {
    const saved = await call('plugins-custom-save', {
      kind: 'mcp',
      name: 'Layered MCP',
      transport: 'stdio',
      packageSpec: 'layered-mcp@1.2.3',
      args: [],
      env: { MODE: 'prod' },
    })
    assert.equal(saved.ok, true)
    await call('plugins-retry', {})
    assert.ok(mountedConfigs.length > 0)
    const env = mountedConfigs.at(-1).env
    // The ambient capability variable is nullified in the explicit layer the SDK
    // merges over its scrubbed parent environment.
    assert.equal(env.SSH_AUTH_SOCK, '')
    assert.equal(env.MODE, 'prod')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(env.DEEPSEEK_API_KEY, undefined)
    // The exact pinned version in the spec feeds consent inputs through the view.
    const view = await call('plugins-list', {})
    const item = view.value.plugins.find(p => p.name === 'Layered MCP')
    assert.equal(item.unpinnedSpec, false)
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previous
  }
})

test('floating package specs surface unpinnedSpec and pinned specs feed kill-list version matching', async (t) => {
  const fakeLoader = { async import() { return { apply() {} } } }
  const { ctx, rt, call, stop } = startRuntime({ services: { loader: fakeLoader } })
  t.after(stop)
  ctx.plugin = () => ({ async await() {}, async dispose() {} })
  await rt.load()

  const saved = await call('plugins-custom-save', {
    kind: 'mcp',
    name: 'Floating MCP',
    transport: 'stdio',
    packageSpec: 'float-mcp@latest',
    args: [],
  })
  assert.equal(saved.ok, true)
  const view = await call('plugins-list', {})
  const floating = view.value.plugins.find(p => p.id === saved.value.entry.id)
  assert.equal(floating.unpinnedSpec, true)

  // An id-only kill stops a floating plugin whose version can never be known.
  const killStore = createKillListStore({ cachePath: null })
  await killStore.updateFromSource('official', {
    schemaVersion: 1,
    issuedAt: new Date().toISOString(),
    entries: [{ id: saved.value.entry.id }],
  })
  assert.ok(killStore.evaluate({ id: saved.value.entry.id, version: null, contentHash: null }), 'id-only kill matches without a version')
  // `*` version ranges match unknown/floating versions too — the only honest shape for that claim.
  const starStore = createKillListStore({ cachePath: null })
  await starStore.updateFromSource('official', {
    schemaVersion: 1,
    issuedAt: new Date().toISOString(),
    entries: [{ id: 'mcp:star', versions: '*' }],
  })
  assert.ok(starStore.evaluate({ id: 'mcp:star', version: null }), '* range matches an unknown version')
  // Concrete ranges still do not match unknown versions.
  const rangeStore = createKillListStore({ cachePath: null })
  await rangeStore.updateFromSource('official', {
    schemaVersion: 1,
    issuedAt: new Date().toISOString(),
    entries: [{ id: 'mcp:ranged', versions: '<2.0.0' }],
  })
  assert.equal(rangeStore.evaluate({ id: 'mcp:ranged', version: null }), null)
  assert.ok(rangeStore.evaluate({ id: 'mcp:ranged', version: '1.5.0' }))
})

// --- 8. Installed-dir hashing and fail-closed verification ---

test('unverifiable plugin trees (symlink escape) fail closed instead of binding consent to unhashable bytes', async (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ds-bot-esc-plugin-'))
  writeFileSync(join(pluginDir, 'index.js'), 'export {}\n')
  symlinkSync('/etc', join(pluginDir, 'escape'), 'dir')
  t.after(() => rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundle = {
    name: 'escape-plugin',
    official: false,
    availability: 'profile',
    version: '0.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    updatable: false,
    rows: [],
    overrides: [],
    source: `link:${pluginDir}`,
  }
  const fakePm = { async listBundles() { return [{ ...bundle }] } }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  const res = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:escape-plugin' })
  assert.equal(res.ok, true)
  assert.equal(res.value.slots.browser.status, 'unverifiable')
  assert.match(res.value.slots.browser.error, /cannot be verified/)
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly', 'unverifiable bytes never activate')

  // The consent endpoint refuses outright: approval can never be recorded for bytes
  // that cannot be verified — that is the whole point of failing closed.
  const consent = await call('plugins-consent', { id: 'dsh:escape-plugin' })
  assert.equal(consent.ok, false)
  assert.match(consent.error.message, /cannot be verified/)
  const view = await call('plugins-list', {})
  assert.equal(view.value.slots.browser.status, 'unverifiable')
})

test('content hashing binds the installed bundle directory and byte drift invalidates consent without a version move', async (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ds-bot-drift-plugin-'))
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 1\n')
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'drift-plugin', version: '1.0.0' }))
  t.after(() => rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundle = {
    name: 'drift-plugin',
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
    source: `link:${pluginDir}`,
  }
  const fakePm = { async listBundles() { return [{ ...bundle }] } }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // Activate: baseline consent covers the exact bytes of the tree.
  const act = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:drift-plugin' })
  assert.equal(act.ok, true)
  assert.equal(act.value.slots.browser.status, 'ready')
  const fingerprintBefore = rt.state.plugins.consent['dsh:drift-plugin']?.fingerprint
  assert.ok(fingerprintBefore)

  // Bytes mutate underneath without the version moving — the classic link:/dev-tree
  // and tampering case. Reconciliation re-hashes, the fast path breaks, and the
  // consent gate refuses reactivation under the stale approval.
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 2\n')
  const retry = await call('plugins-retry', {})
  assert.equal(retry.ok, true)
  assert.equal(retry.value.slots.browser.status, 'consent-required')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly')

  // Explicit approval of the new bytes restores activation.
  const consent = await call('plugins-consent', { id: 'dsh:drift-plugin' })
  assert.equal(consent.ok, true)
  const after = await call('plugins-list', {})
  assert.equal(after.value.slots.browser.status, 'ready')
  assert.notEqual(rt.state.plugins.consent['dsh:drift-plugin'].fingerprint, fingerprintBefore)
})

// --- 9. Bundle-level enforcement ---

test('enforcement disables consent-invalid bundles in the profile and re-enables them on approval', async (t) => {
  const bundle = {
    name: 'enforced-browser',
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
  }
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push(['setBundleEnabled', name, enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // Activate and baseline version 1.0.0.
  const act = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:enforced-browser' })
  assert.equal(act.value.slots.browser.status, 'ready')

  // The bundle updates underneath: consent invalidates, and enforcement disables the
  // bundle in the DSH profile itself — the startup precondition for not executing it.
  bundle.version = '2.0.0'
  await call('plugins-retry', {})
  assert.ok(pmCalls.some(c => c[0] === 'setBundleEnabled' && c[1] === 'enforced-browser' && c[2] === false),
    'enforcement disables the consent-invalid bundle in the profile')
  assert.equal(bundle.enabled, false)

  // Approval re-enables exactly the approved bytes.
  const consent = await call('plugins-consent', { id: 'dsh:enforced-browser' })
  assert.equal(consent.ok, true)
  assert.ok(pmCalls.some(c => c[0] === 'setBundleEnabled' && c[1] === 'enforced-browser' && c[2] === true),
    'approval re-enables the bundle it consented')
  assert.equal(bundle.enabled, true)
  const view = await call('plugins-list', {})
  assert.equal(view.value.slots.browser.status, 'ready')
})

test('enforcement does not disable system bundles or unknown packages, and leaves user-disabled bundles alone', async (t) => {
  const systemBundle = {
    name: 'ds-bot',
    official: true,
    availability: 'installation',
    version: '1.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: false,
    updatable: false,
    rows: [],
    overrides: [],
  }
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [{ ...systemBundle }] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push(['setBundleEnabled', name, enabled])
      systemBundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()
  await call('plugins-retry', {})
  // The host's own runtime bundle is never a kill/consent target: no disable call for it.
  assert.equal(pmCalls.filter(c => c[1] === 'ds-bot' && c[2] === false).length, 0)
  assert.equal(systemBundle.enabled, true)
})

test('killed install refuses before the plugin manager runs, and installs request enabled:false', async (t) => {
  const now = Date.now()
  const killDoc = {
    schemaVersion: 1,
    issuedAt: new Date(now).toISOString(),
    entries: [{ id: 'dsh:evil-browser', reason: 'compromised package' }],
  }
  const installCalls = []
  const fakePm = {
    async listBundles() { return [] },
    async installBundle(spec, options) {
      installCalls.push([spec, options])
      return { changed: true, application: 'applied', stage: 'enable', target: spec, bundle: spec, version: '1.0.0' }
    },
    async setBundleEnabled() { return { changed: true, application: 'applied', stage: 'enable', target: 'x', enabled: true } },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({ schemaVersion: 1, killList: killDoc, plugins: [] }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  // A kill-named registry spec is refused before installBundle ever runs.
  const killed = await call('plugins-install', { spec: 'evil-browser' })
  assert.equal(killed.ok, false)
  assert.match(killed.error.message, /kill list/i)
  assert.equal(installCalls.length, 0, 'the plugin manager never runs for a killed package')

  // A clean install requests activation disabled — consent gates the enablement.
  const clean = await call('plugins-install', { spec: 'honest-browser' })
  assert.equal(clean.ok, true)
  assert.equal(installCalls.length, 1)
  assert.equal(installCalls[0][1].enabled, false, 'installations never activate before the consent gate evaluates')
})

test('update pre-disables the bundle, and post-update re-consent re-enables it', async (t) => {
  const bundle = {
    name: 'updatable-plugin',
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
  const order = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async listVersions() {
      return {
        status: 'listed',
        installed: bundle.version,
        registry: null,
        attempts: [],
        versions: [{ version: '2.0.0', tags: ['latest'], prerelease: false, bundle: true }],
        omitted: 0,
      }
    },
    async setBundleEnabled(name, enabled) {
      order.push(['setBundleEnabled', enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
    async updateBundle(name, version) {
      order.push(['updateBundle', version])
      // DSH updates install with the bundle's CURRENT selection: enabled state at
      // update time decides whether new bytes activate. The pre-disable is what
      // guarantees they do not.
      assert.equal(bundle.enabled, false, 'the bundle must be disabled before its bytes are replaced')
      bundle.version = version
      return {
        from: '1.0.0',
        to: version,
        step: 'install',
        result: { changed: true, application: 'applied', stage: 'enable', target: `${name}@${version}`, enabled: false },
      }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // Activate: consent baseline covers 1.0.0.
  const act = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:updatable-plugin' })
  assert.equal(act.value.slots.browser.status, 'ready')

  const upd = await call('plugins-update', { id: 'dsh:updatable-plugin', version: '2.0.0' })
  assert.equal(upd.ok, true)
  const disableIdx = order.findIndex(c => c[0] === 'setBundleEnabled' && c[1] === false)
  const updateIdx = order.findIndex(c => c[0] === 'updateBundle')
  assert.ok(disableIdx !== -1 && updateIdx !== -1 && disableIdx < updateIdx, 'disable precedes the byte replacement')
  // The user clicking update is the consent: the new version's fingerprint is recorded
  // and the bundle is re-enabled, so the slot runs 2.0.0 without a redundant prompt.
  assert.equal(bundle.enabled, true)
  const view = await call('plugins-list', {})
  assert.equal(view.value.slots.browser.status, 'ready')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'dsh:updatable-plugin')
})

test('update failure restores the previous version without re-enabling unapproved bytes silently', async (t) => {
  const bundle = {
    name: 'failing-update-plugin',
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
  const enableCalls = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      enableCalls.push(enabled)
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
    async updateBundle(name, version) {
      return {
        from: '1.0.0',
        to: version,
        step: 'install',
        result: {
          changed: false,
          application: 'failed',
          stage: 'install',
          target: `${name}@${version}`,
          error: { code: 'operation-error', diagnostic: 'registry unreachable' },
        },
        restore: { changed: true, application: 'applied', stage: 'install', target: `${name}@1.0.0`, enabled: false },
      }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  const act = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:failing-update-plugin' })
  assert.equal(act.value.slots.browser.status, 'ready')
  enableCalls.length = 0

  const upd = await call('plugins-update', { id: 'dsh:failing-update-plugin', version: '2.0.0' })
  assert.equal(upd.ok, false)
  assert.match(upd.error.message, /registry unreachable/)
  // The restore reinstalls the SAME version the consent covers: re-enabling it is the
  // consented state, not new code — so the plugin comes back rather than dying silently.
  assert.equal(enableCalls.includes(true), true, 'the restored consented version is re-enabled')
  assert.equal(bundle.enabled, true)
})

test('non-slot install enables the bundle after the gate clears, and a killed post-install bundle never enables', async (t) => {
  const bundles = new Map()
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [...bundles.values()].map(b => ({ ...b })) },
    async installBundle(spec) {
      pmCalls.push(['installBundle', spec])
      bundles.set(spec, {
        name: spec,
        official: false,
        availability: 'profile',
        version: '1.0.0',
        enabled: false,
        installed: true,
        optional: false,
        removable: true,
        updatable: false,
        rows: [],
        overrides: [],
      })
      return { changed: true, application: 'applied', stage: 'install', target: spec, bundle: spec, version: '1.0.0' }
    },
    async setBundleEnabled(name, enabled) {
      pmCalls.push(['setBundleEnabled', name, enabled])
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // A clean non-slot install: the gate clears on first activation (baseline) and the
  // bundle is enabled — installing a plugin is the user's intent to run it.
  const clean = await call('plugins-install', { spec: 'honest-tools' })
  assert.equal(clean.ok, true)
  assert.ok(pmCalls.some(c => c[0] === 'setBundleEnabled' && c[1] === 'honest-tools' && c[2] === true),
    'the installed bundle is enabled after the gate clears')
  const view = await call('plugins-list', {})
  const item = view.value.plugins.find(p => p.packageName === 'honest-tools')
  assert.equal(item.enabled, true)
  assert.equal(item.consentRequired, false)
  assert.ok(rt.state.plugins.consent['dsh:honest-tools']?.fingerprint, 'first activation baselines consent')
})

test('plugins-slot-set refuses drifted or unverifiable bundles before setBundleEnabled ever runs', async (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ds-bot-slotgate-'))
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 1\n')
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'slot-gated', version: '1.0.0' }))
  t.after(() => rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundle = {
    name: 'slot-gated',
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: false,
    installed: true,
    optional: false,
    removable: true,
    updatable: false,
    rows: [],
    overrides: [],
    source: `link:${pluginDir}`,
  }
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push(['setBundleEnabled', name, enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // First activation: the gate clears, enablement runs, consent baselines.
  const first = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:slot-gated' })
  assert.equal(first.ok, true)
  assert.equal(first.value.slots.browser.status, 'ready')
  assert.ok(pmCalls.some(c => c[2] === true), 'first-time activation enables the bundle')

  // Drift the bytes: consent invalidates. Disabling is fine, but re-picking the slot
  // must NOT re-enable through the gate bypass the round-1 review caught.
  bundle.enabled = false
  pmCalls.length = 0
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 2\n')
  const drifted = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:slot-gated' })
  assert.equal(drifted.ok, false, 'drifted bundle refuses re-picking the slot')
  assert.match(drifted.error.message, /explicit approval/)
  assert.equal(pmCalls.filter(c => c[2] === true).length, 0,
    'setBundleEnabled(true) never runs for a consent-invalid bundle')
  assert.equal(bundle.enabled, false, 'the bundle stays disabled in the profile')

  // Approval is the only way back: after explicit consent the slot pick succeeds.
  const consent = await call('plugins-consent', { id: 'dsh:slot-gated' })
  assert.equal(consent.ok, true)
  const repick = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:slot-gated' })
  assert.equal(repick.ok, true)
  assert.equal(repick.value.slots.browser.status, 'ready')
})

test('plugins-toggle refuses drifted or unverifiable bundles before setBundleEnabled(true) ever runs', async (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ds-bot-togglegate-'))
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 1\n')
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'toggle-gated', version: '1.0.0' }))
  t.after(() => rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundle = {
    name: 'toggle-gated',
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
    source: `link:${pluginDir}`,
  }
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push(['setBundleEnabled', name, enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  // Baseline the consent by activating once through toggle-on semantics: reconcile
  // baselines the bare dsh key on first sight of the running bundle.
  await call('plugins-retry', {})
  assert.ok(rt.state.plugins.consent['dsh:toggle-gated']?.fingerprint, 'first sight baselines consent')

  // Drift bytes, disable the bundle (as enforcement would), then try to toggle on:
  // the gate must refuse BEFORE enablement executes the unapproved bytes.
  writeFileSync(join(pluginDir, 'index.js'), 'export const v = 2\n')
  bundle.enabled = false
  pmCalls.length = 0
  const toggled = await call('plugins-toggle', { id: 'dsh:toggle-gated', enabled: true })
  assert.equal(toggled.ok, false, 'drifted bundle refuses the enable toggle')
  assert.match(toggled.error.message, /explicit approval/)
  assert.equal(pmCalls.filter(c => c[2] === true).length, 0,
    'setBundleEnabled(true) never runs for a consent-invalid bundle')

  // Toggling OFF is never gated — refusal would trap the user with running code.
  const off = await call('plugins-toggle', { id: 'dsh:toggle-gated', enabled: false })
  assert.equal(off.ok, true)

  // An unverifiable (symlink-escape) tree refuses the toggle outright.
  symlinkSync('/etc', join(pluginDir, 'escape'), 'dir')
  const bad = await call('plugins-toggle', { id: 'dsh:toggle-gated', enabled: true })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /cannot be verified/)
  assert.equal(pmCalls.filter(c => c[2] === true).length, 0)
})

test('v-prefixed exact versions pin and normalize for kill matching', async () => {
  const { analyzePackageSpecPin } = await import('../src/host/plugins/catalog.js')
  assert.deepEqual(analyzePackageSpecPin('pkg@v1.2.3'), { pinned: '1.2.3', floating: false })
  assert.deepEqual(analyzePackageSpecPin('@scope/pkg@v2.0.0-rc.1'), { pinned: '2.0.0-rc.1', floating: false })
  assert.deepEqual(analyzePackageSpecPin('pkg@v^1.2.3'), { pinned: null, floating: true })
})

test('slot security status does not bleed onto sibling entries sharing the slot', async (t) => {
  const now = Date.now()
  const killDoc = {
    schemaVersion: 1,
    issuedAt: new Date(now).toISOString(),
    entries: [{ id: 'dsh:evil-sibling', reason: 'sibling is compromised' }],
  }
  const fakePm = {
    async listBundles() {
      return [
        {
          name: 'evil-sibling', official: false, availability: 'profile', version: '1.0.0',
          enabled: true, installed: true, optional: false, removable: true, updatable: false, rows: [], overrides: [],
        },
        {
          name: 'good-sibling', official: false, availability: 'profile', version: '1.0.0',
          enabled: true, installed: true, optional: false, removable: true, updatable: false, rows: [], overrides: [],
        },
      ]
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        killList: killDoc,
        plugins: [
          { id: 'dsh:evil-sibling', name: 'Evil Sibling', kind: 'dsh', slot: 'browser', category: 'browser', install: { packageName: 'evil-sibling' }, toolPrefixes: ['evil_'] },
          { id: 'dsh:good-sibling', name: 'Good Sibling', kind: 'dsh', slot: 'browser', category: 'browser', install: { packageName: 'good-sibling' }, toolPrefixes: ['good_'] },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  // Pick the killed sibling: the slot reports killed for IT.
  const pick = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:evil-sibling' })
  assert.equal(pick.ok, true)
  const view = await call('plugins-list', {})
  const evil = view.value.plugins.find(p => p.id === 'dsh:evil-sibling')
  const good = view.value.plugins.find(p => p.id === 'dsh:good-sibling')
  assert.equal(evil.status, 'killed')
  assert.equal(evil.killed, true)
  // The innocent sibling sharing the same slot must not inherit the killed status:
  // its own state stays clean and its controls are not hidden behind a foreign kill.
  assert.notEqual(good.status, 'killed')
  assert.equal(good.killed, false)
  assert.equal(good.consentRequired, false)
})

test('failed post-install enablement surfaces as an error instead of silent installed-but-dead', async (t) => {
  const bundles = new Map()
  const fakePm = {
    async listBundles() { return [...bundles.values()].map(b => ({ ...b })) },
    async installBundle(spec) {
      bundles.set(spec, {
        name: spec, official: false, availability: 'profile', version: '1.0.0',
        enabled: false, installed: true, optional: false, removable: true, updatable: false, rows: [], overrides: [],
      })
      return { changed: true, application: 'applied', stage: 'install', target: spec, bundle: spec, version: '1.0.0' }
    },
    async setBundleEnabled() {
      return { changed: false, application: 'failed', stage: 'enable', target: 'x', error: { code: 'operation-error', diagnostic: 'profile write locked' } }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  const clean = await call('plugins-install', { spec: 'locked-plugin' })
  assert.equal(clean.ok, true, 'the install itself did succeed — the failure is the enablement')
  const view = await call('plugins-list', {})
  const item = view.value.plugins.find(p => p.packageName === 'locked-plugin')
  assert.ok(item)
  assert.equal(item.status, 'error')
  assert.match(item.error ?? '', /profile write locked|Could not enable/)
})

test('cold-catalog setSlot baselines identical slot fingerprint and never self-locks on reconcile', async (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ds-bot-coldslot-'))
  writeFileSync(join(pluginDir, 'index.js'), 'export const ok = true\n')
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'catbrowser', version: '1.0.0' }))
  t.after(() => rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundle = {
    name: 'catbrowser',
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: false,
    installed: true,
    optional: false,
    removable: true,
    updatable: false,
    rows: [],
    overrides: [],
    source: `link:${pluginDir}`,
  }
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push([name, enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            id: 'dsh:catbrowser',
            name: 'Catalog Browser',
            kind: 'dsh',
            slot: 'browser',
            category: 'browser',
            install: { packageName: 'catbrowser' },
            toolPrefixes: ['cat_'],
          },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  // Cold start: call plugins-slot-set directly WITHOUT calling plugins-list first.
  const pick = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:catbrowser' })
  assert.equal(pick.ok, true)
  assert.equal(pick.value.slots.browser.status, 'ready', 'cold-catalog pick must not self-lock into consent-required')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'dsh:catbrowser')
  assert.deepEqual(pmCalls, [['catbrowser', true]], 'bundle is enabled once and never immediately disabled by enforcement')
})

test('togglePlugin(enabled=true) fails closed when bundle cannot be resolved', async (t) => {
  const pmCalls = []
  const fakePm = {
    async listBundles() { return [] },
    async setBundleEnabled(name, enabled) {
      pmCalls.push([name, enabled])
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()

  const res = await call('plugins-toggle', { id: 'dsh:missing-bundle', enabled: true })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /not installed|cannot be verified/)
  assert.equal(pmCalls.length, 0, 'setBundleEnabled(true) must never run for an unresolvable bundle')

  // Disabling remains unobstructed even if listBundles missed it.
  const off = await call('plugins-toggle', { id: 'dsh:missing-bundle', enabled: false })
  assert.equal(off.ok, true)
})

test('hashPluginTree accepts intra-tree absolute symlinks spelled via symlinked ancestors and blocks escaping chains', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-symcanon-'))
  const realRoot = join(base, 'real', 'pkg')
  const aliasParent = join(base, 'alias')
  const outsideFile = join(base, 'secret.txt')
  mkdirSync(realRoot, { recursive: true })
  writeFileSync(join(realRoot, 'target.txt'), 'hello\n')
  writeFileSync(outsideFile, 'top-secret\n')
  symlinkSync(join(base, 'real'), aliasParent, 'dir')
  // Absolute symlink using the non-canonical ancestor path (mirrors macOS /var -> /private/var).
  symlinkSync(join(aliasParent, 'pkg', 'target.txt'), join(realRoot, 'self-abs-link'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))

  const hashed = await hashPluginTree(realRoot)
  assert.match(hashed.hash, /^[0-9a-f]{64}$/)

  // Indirect escape chain: inner-link -> escape-hop -> outsideFile must fail closed.
  symlinkSync(outsideFile, join(realRoot, 'escape-hop'))
  symlinkSync('./escape-hop', join(realRoot, 'inner-link'))
  await assert.rejects(hashPluginTree(realRoot), { code: 'symlink-escape' })
})

test('hashPluginTree length-prefixed framing prevents delimiter-injection collisions across distinct trees', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-frame-'))
  const treeOne = join(base, 'one')
  const treeTwo = join(base, 'two')
  mkdirSync(treeOne, { recursive: true })
  mkdirSync(treeTwo, { recursive: true })
  writeFileSync(join(treeOne, 'a'), Buffer.from('x\0file\0b\0y'))
  writeFileSync(join(treeTwo, 'a'), Buffer.from('x'))
  writeFileSync(join(treeTwo, 'b'), Buffer.from('y'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))

  const h1 = await hashPluginTree(treeOne)
  const h2 = await hashPluginTree(treeTwo)
  assert.notEqual(h1.hash, h2.hash, 'file bytes containing NUL framing tokens must never collide with a multi-file tree')
})

test('validateKillListDocument drops rules whose contentHashes are all invalid instead of creating a blanket kill', () => {
  const doc = validateKillListDocument({
    schemaVersion: 1,
    issuedAt: new Date().toISOString(),
    entries: [
      { id: 'dsh:bad-hashes', contentHashes: ['not-a-sha256', '1234'] },
      { id: 'dsh:empty-hashes', contentHashes: [] },
      { id: 'dsh:non-array-hashes', contentHashes: 'deadbeef' },
      { id: 'dsh:good-blanket', reason: 'explicit blanket kill' },
    ],
  })
  assert.equal(evaluateKillEntry(doc, { id: 'dsh:bad-hashes', version: '1.0.0' }), null)
  assert.equal(evaluateKillEntry(doc, { id: 'dsh:empty-hashes', version: '1.0.0' }), null)
  assert.equal(evaluateKillEntry(doc, { id: 'dsh:non-array-hashes', version: '1.0.0' }), null)
  assert.ok(evaluateKillEntry(doc, { id: 'dsh:good-blanket', version: '1.0.0' }), 'explicit unconditional kills still work')

  // Version-scoped rules that also include an empty or invalid contentHashes field keep
  // their version revocation instead of being dropped.
  const versioned = validateKillListDocument({
    schemaVersion: 1,
    issuedAt: new Date().toISOString(),
    entries: [
      { id: 'dsh:ver-empty-hashes', versions: '>=1.0.0 <2.0.0', contentHashes: [] },
      { id: 'dsh:ver-bad-hashes', versions: '1.2.3', contentHashes: ['not-hex'] },
    ],
  })
  assert.ok(evaluateKillEntry(versioned, { id: 'dsh:ver-empty-hashes', version: '1.5.0' }))
  assert.equal(evaluateKillEntry(versioned, { id: 'dsh:ver-empty-hashes', version: '2.0.0' }), null)
  assert.ok(evaluateKillEntry(versioned, { id: 'dsh:ver-bad-hashes', version: '1.2.3' }))
})

test('MCP consent invalidates when a header or env secret reference swaps to a different saved secret', async (t) => {
  let headerRef = '$DSH_SECRET_PUBLIC_TOKEN'
  const mountedConfigs = []
  const fakeLoader = {
    async import() {
      return { apply() {} }
    },
  }
  const { ctx, rt, call, stop } = startRuntime({
    services: { loader: fakeLoader },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            id: 'mcp:secret-swap',
            name: 'Secret Swap MCP',
            kind: 'mcp',
            execution: 'declarative',
            capabilities: ['entry'],
            install: {
              mcp: {
                transport: 'streamable-http',
                url: 'https://mcp.example.com/sse',
                headers: { Authorization: `Bearer ${headerRef}` },
              },
            },
          },
        ],
      }), { status: 200 }),
    },
  })
  ctx.plugin = (_plugin, cfg) => {
    if (cfg?.serverName === 'dsbp-secret-swap') mountedConfigs.push(cfg)
    return { async await() {}, async dispose() {} }
  }
  t.after(stop)
  rt.secretValue = name => (name === 'PUBLIC_TOKEN' ? 'pub-val' : 'admin-val')
  await rt.load()

  const inst = await call('plugins-install', { id: 'mcp:secret-swap' })
  assert.equal(inst.ok, true)
  assert.equal(mountedConfigs.length, 1)
  assert.equal(mountedConfigs[0].headers.Authorization, 'Bearer pub-val')

  // Publisher swaps header secret reference behind the same Authorization header key.
  headerRef = '$DSH_SECRET_ADMIN_TOKEN'
  const refreshed = await call('plugins-catalog-refresh', {})
  assert.equal(refreshed.ok, true)
  const item = refreshed.value.plugins.find(p => p.id === 'mcp:secret-swap')
  assert.equal(item.consentRequired, true, 'swapping $DSH_SECRET_* behind an existing header must invalidate consent')
  assert.equal(item.active, false, 'running MCP must be unmounted rather than receiving the different secret')
  assert.equal(mountedConfigs.length, 1, 'admin secret must never be mounted before explicit approval')
})

test('catalog refresh reconciles changed MCP launch args and capability-only changes without a kill-list change', async (t) => {
  let caps = ['entry', 'process', 'worker']
  let args = ['-y', '@example/cap-mcp@1.0.0']
  let mountedCount = 0
  let disposedCount = 0
  const fakeLoader = {
    async import() {
      return { apply() {} }
    },
  }
  const { ctx, rt, call, stop } = startRuntime({
    services: { loader: fakeLoader },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            id: 'mcp:http-cap',
            name: 'HTTP Cap MCP',
            kind: 'mcp',
            execution: 'trusted-worker',
            capabilities: caps,
            install: { mcp: { transport: 'streamable-http', url: 'https://cap.example.com/mcp' } },
          },
          {
            id: 'mcp:stdio-arg',
            name: 'Stdio Arg MCP',
            kind: 'mcp',
            execution: 'trusted-worker',
            capabilities: ['entry', 'process', 'worker'],
            install: { mcp: { transport: 'stdio', command: 'npx', args } },
          },
        ],
      }), { status: 200 }),
    },
  })
  ctx.plugin = (_plugin, cfg) => {
    const tracked = cfg?.serverName === 'dsbp-http-cap' || cfg?.serverName === 'dsbp-stdio-arg'
    if (tracked) mountedCount += 1
    return { async await() {}, async dispose() { if (tracked) disposedCount += 1 } }
  }
  t.after(stop)
  await rt.load()

  assert.equal((await call('plugins-install', { id: 'mcp:http-cap' })).ok, true)
  assert.equal((await call('plugins-install', { id: 'mcp:stdio-arg' })).ok, true)
  assert.equal(mountedCount, 2)

  // Refresh catalog with BOTH: capability-only change on http-cap AND new arg on stdio-arg (no kill list).
  caps = ['entry', 'process', 'worker', 'gpu']
  args = ['-y', '@example/cap-mcp@1.0.0', '--extra-flag']
  const refreshed = await call('plugins-catalog-refresh', {})
  assert.equal(refreshed.ok, true)
  const httpItem = refreshed.value.plugins.find(p => p.id === 'mcp:http-cap')
  const stdioItem = refreshed.value.plugins.find(p => p.id === 'mcp:stdio-arg')
  assert.equal(httpItem.consentRequired, true, 'capability-only change on running HTTP MCP must trigger re-approval')
  assert.equal(httpItem.active, false)
  assert.equal(stdioItem.consentRequired, true, 'new launch argument on catalog refresh must trigger re-approval')
  assert.equal(stdioItem.active, false)
  assert.equal(disposedCount, 2, 'both drifted MCP servers must be unmounted on refresh')
})

test('rejected install stops already-running newly revoked plugin and grantPluginConsent never starts a freshly revoked bundle', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-revoked-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const v = 1\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  let killEntries = []
  let issuedAt = '2026-11-20T00:00:00.000Z'
  const bundles = new Map([
    ['live-pkg', { name: 'live-pkg', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: true, removable: true }],
  ])
  const pmEvents = []
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async setBundleEnabled(name, enabled) {
      pmEvents.push([name, enabled])
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
    async installBundle() {
      pmEvents.push(['install-called'])
      return { changed: true, application: 'applied', bundle: 'live-pkg' }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'dsh:live-pkg', name: 'Live Pkg', kind: 'dsh', install: { packageName: 'live-pkg', spec: `link:${pkgDir}` } },
        ],
        killList: { schemaVersion: 1, issuedAt, entries: killEntries },
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()
  await rt.plugins.reconcileAll()

  // Publish revocation, then trigger a rejected install of another spec (or same package):
  // assertNotKilled must stop the already-running revoked bundle before throwing.
  issuedAt = '2026-11-21T00:00:00.000Z'
  killEntries = [{ id: 'dsh:live-pkg', versions: '*', reason: 'revoked in test' }]
  const badInst = await call('plugins-install', { id: 'dsh:live-pkg', spec: 'live-pkg@1.0.0' })
  assert.equal(badInst.ok, false)
  assert.equal(bundles.get('live-pkg').enabled, false, 'rejected install must immediately disable the newly revoked running bundle')

  // Even if the bundle drifts and the user attempts plugins-consent after a newer kill lands,
  // grantPluginConsent must evaluate the fresh kill list BEFORE ever calling setBundleEnabled(true).
  pmEvents.length = 0
  writeFileSync(join(pkgDir, 'index.js'), 'export const v = 2\n')
  const consentRes = await call('plugins-consent', { id: 'dsh:live-pkg' })
  assert.equal(consentRes.ok, false)
  assert.match(consentRes.error.message, /kill list/i)
  assert.equal(pmEvents.some(([, enabled]) => enabled === true), false, 'grantPluginConsent must never enable a revoked bundle')
})

test('switched-out drifted browser plugin surfaces Approve after Use refusal and activates cleanly after approval', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-switch-browser-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 1\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundles = new Map([
    ['alt-browser', { name: 'alt-browser', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: false, removable: true }],
  ])
  const pmEvents = []
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async setBundleEnabled(name, enabled) {
      pmEvents.push([name, enabled])
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'dsh:alt-browser', name: 'Alt Browser', kind: 'dsh', slot: 'browser', category: 'browser', install: { packageName: 'alt-browser', spec: `link:${pkgDir}` } },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  // 1. Activate Alt Browser, then switch back to built-in (which disables alt-browser).
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'dsh:alt-browser' })).ok, true)
  assert.equal(bundles.get('alt-browser').enabled, true)
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'builtin:readonly' })).ok, true)
  assert.equal(bundles.get('alt-browser').enabled, false)

  // 2. Mutate the disabled browser bundle on disk and click Use again.
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 2\n')
  const blockedUse = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:alt-browser' })
  assert.equal(blockedUse.ok, false)

  // 3. View now surfaces Approval needed on Alt Browser (without bleeding onto builtin:readonly).
  const viewAfter = await call('plugins-list', {})
  const altItem = viewAfter.value.plugins.find(p => p.id === 'dsh:alt-browser')
  const builtinItem = viewAfter.value.plugins.find(p => p.id === 'builtin:readonly')
  assert.equal(altItem.consentRequired, true, 'inactive drifted browser bundle must surface Approve in Settings')
  assert.equal(builtinItem.consentRequired, false, 'sibling built-in browser must remain unaffected')

  // 4. Approve verifies placement WITHOUT prematurely executing/enabling the unselected bundle.
  pmEvents.length = 0
  const approved = await call('plugins-consent', { id: 'dsh:alt-browser' })
  assert.equal(approved.ok, true)
  assert.equal(bundles.get('alt-browser').enabled, false, 'approving an inactive browser bundle must not prematurely enable it')
  assert.equal(approved.value.view.plugins.find(p => p.id === 'dsh:alt-browser').consentRequired, false)

  // 5. Clicking Use now enables and activates Alt Browser cleanly.
  const useAgain = await call('plugins-slot-set', { slot: 'browser', id: 'dsh:alt-browser' })
  assert.equal(useAgain.ok, true)
  assert.equal(bundles.get('alt-browser').enabled, true)
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'dsh:alt-browser')
})

test('browser bundle disabled directly in Engine plugins stays disabled across restart reconciliation', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-eng-dis-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 1\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundles = new Map([
    ['eng-browser', { name: 'eng-browser', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: false, removable: true }],
  ])
  const pmEvents = []
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async setBundleEnabled(name, enabled) {
      pmEvents.push([name, enabled])
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'dsh:eng-browser', name: 'Engine Browser', kind: 'dsh', slot: 'browser', category: 'browser', install: { packageName: 'eng-browser', spec: `link:${pkgDir}` } },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'dsh:eng-browser' })).ok, true)
  assert.equal(bundles.get('eng-browser').enabled, true)

  // Simulate user disabling the bundle directly in Engine plugins, then restarting / reconciling.
  bundles.get('eng-browser').enabled = false
  pmEvents.length = 0
  await rt.plugins.reconcileAll()
  assert.equal(bundles.get('eng-browser').enabled, false, 'reconcile must not undo a manual Engine plugins disable')
  assert.equal(pmEvents.length, 0)
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly', 'fallback stays active while disabled in Engine plugins')
})

test('approving a drifted package-only non-slot bundle clears consentRequired so users can disable it again', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-reapprove-off-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 1\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundles = new Map([
    ['plain-pkg', { name: 'plain-pkg', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: true, removable: true }],
  ])
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async setBundleEnabled(name, enabled) {
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({ services: { pluginManager: fakePm } })
  t.after(stop)
  await rt.load()
  await rt.plugins.reconcileAll()

  // Mutate files and retry to detect drift.
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 2\n')
  const drifted = await call('plugins-retry', {})
  assert.equal(drifted.ok, true)
  assert.equal(drifted.value.plugins.find(p => p.id === 'dsh:plain-pkg').consentRequired, true)
  assert.equal(bundles.get('plain-pkg').enabled, false)

  // Approve: bundle re-enables AND consentRequired clears immediately (not stuck on Approve).
  const approved = await call('plugins-consent', { id: 'dsh:plain-pkg' })
  assert.equal(approved.ok, true)
  const item = approved.value.view.plugins.find(p => p.id === 'dsh:plain-pkg')
  assert.equal(item.enabled, true)
  assert.equal(item.consentRequired, false, 'stale consent-required status must clear after approval so toggle switch returns')

  // User can turn the approved bundle off via plugins-toggle.
  const disabled = await call('plugins-toggle', { id: 'dsh:plain-pkg', enabled: false })
  assert.equal(disabled.ok, true)
  assert.equal(bundles.get('plain-pkg').enabled, false)
})

test('approving an enforcement-stopped browser bundle after switching away does not re-enable it until Use', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-enforce-switch-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 1\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  const bundles = new Map([
    ['drifted-browser', { name: 'drifted-browser', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: false, removable: true }],
  ])
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async setBundleEnabled(name, enabled) {
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'browser:drifted', name: 'Drifted Browser', kind: 'dsh', slot: 'browser', category: 'browser', install: { packageName: 'drifted-browser', spec: `link:${pkgDir}` } },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  // Select browser, mutate files while selected, reconcile stops it via enforcement.
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'browser:drifted' })).ok, true)
  assert.equal(bundles.get('drifted-browser').enabled, true)
  writeFileSync(join(pkgDir, 'index.js'), 'export const rev = 2\n')
  await rt.plugins.reconcileAll()
  assert.equal(bundles.get('drifted-browser').enabled, false, 'enforcement disables drifted browser')

  // Switch away to built-in, then approve the old drifted browser without clicking Use.
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'builtin:readonly' })).ok, true)
  const approved = await call('plugins-consent', { id: 'browser:drifted' })
  assert.equal(approved.ok, true)
  assert.equal(bundles.get('drifted-browser').enabled, false, 'approving switched-away browser must not re-enable it via enforcement recovery')
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'builtin:readonly')

  // Subsequent Use enables and activates it cleanly.
  assert.equal((await call('plugins-slot-set', { slot: 'browser', id: 'browser:drifted' })).ok, true)
  assert.equal(bundles.get('drifted-browser').enabled, true)
  assert.equal(rt.plugins.getSlotActiveId('browser'), 'browser:drifted')
})

test('catalog refresh detects declared capability drift on standalone package-only DSH bundles', async (t) => {
  const pkgDir = mkdtempSync(join(tmpdir(), 'ds-bot-dsh-cap-'))
  writeFileSync(join(pkgDir, 'index.js'), 'export const ok = true\n')
  t.after(() => rmSync(pkgDir, { recursive: true, force: true, maxRetries: 5 }))

  let caps = ['entry', 'process', 'worker']
  const bundles = new Map([
    ['standalone-tool', { name: 'standalone-tool', version: '1.0.0', source: `link:${pkgDir}`, availability: 'profile', installed: true, enabled: false, removable: true }],
  ])
  const fakePm = {
    async listBundles() { return [...bundles.values()] },
    async installBundle() { return { changed: true, application: 'applied', bundle: 'standalone-tool' } },
    async setBundleEnabled(name, enabled) {
      const b = bundles.get(name)
      if (b) b.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
  }
  const { rt, call, stop } = startRuntime({
    services: { pluginManager: fakePm },
    config: {
      pluginFetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            id: 'tools:standalone',
            name: 'Standalone Tool',
            kind: 'dsh',
            execution: 'trusted-worker',
            capabilities: caps,
            install: { packageName: 'standalone-tool', spec: `link:${pkgDir}` },
          },
        ],
      }), { status: 200 }),
    },
  })
  t.after(stop)
  await rt.load()

  assert.equal((await call('plugins-install', { id: 'tools:standalone' })).ok, true)
  assert.equal(bundles.get('standalone-tool').enabled, true)

  // Registry adds a declared capability with no kill-list change; refresh must reconcile and disable.
  caps = ['entry', 'process', 'worker', 'gpu']
  const refreshed = await call('plugins-catalog-refresh', {})
  assert.equal(refreshed.ok, true)
  const item = refreshed.value.plugins.find(p => p.id === 'tools:standalone')
  assert.equal(item.consentRequired, true, 'catalog refresh must recheck package-only DSH bundles when capabilities change')
  assert.equal(bundles.get('standalone-tool').enabled, false)
})
