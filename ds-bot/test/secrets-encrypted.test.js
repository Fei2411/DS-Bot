import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { decryptSecrets, encryptSecrets, isEncryptedSecretsFile, PASSPHRASE_ENV, PASSPHRASE_FILE_ENV } from '../src/host/secrets-crypto.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const PASS = 'correct horse battery staple'
const fresh = () => `t-${randomBytes(12).toString('hex')}`

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-enc-')) } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const view = async () => {
    const result = await call('state', {})
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, rt, call, view, stop }
}

async function withEnv(vars, run) {
  const saved = {}
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const rawSecrets = home => JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))
const rawText = home => readFileSync(join(home, 'secrets.json'), 'utf8')

test('the envelope hides the values, round-trips, and rejects a wrong passphrase or tampering', () => {
  const payload = { version: 1, secrets: [{ name: 'DEMO_TOKEN', value: fresh(), purpose: '中文用途', scope: 'all' }] }
  const envelope = encryptSecrets(payload, PASS)
  assert.equal(envelope.version, 2)
  assert.equal(envelope.encrypted, true)
  assert.ok(isEncryptedSecretsFile(envelope))
  const text = JSON.stringify(envelope)
  assert.equal(text.includes(payload.secrets[0].value), false)
  assert.equal(text.includes('DEMO_TOKEN'), false)
  assert.deepEqual(decryptSecrets(envelope, PASS), payload)

  assert.throws(() => decryptSecrets(envelope, 'wrong passphrase'), error => error.code === 'secrets/passphrase')
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -8)}AAAA` }
  assert.throws(() => decryptSecrets(tampered, PASS), error => error.code === 'secrets/passphrase')
  const noTag = { ...envelope, tag: Buffer.alloc(0).toString('base64') }
  assert.throws(() => decryptSecrets(noTag, PASS), error => error.code === 'secrets/format')
  // A file asking for an absurd key cost is refused instead of wedging startup.
  const costly = { ...envelope, kdf: { ...envelope.kdf, N: 1 << 22 } }
  assert.throws(() => decryptSecrets(costly, PASS), error => error.code === 'secrets/format')
  assert.throws(() => encryptSecrets(payload, 'short'))
})

test('plaintext is still the default, and encrypting rewrites the same file as a locked envelope', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-enc-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const first = start({ home })
  const secret = fresh()
  const saved = await first.call('secret-set', { name: 'DEMO_TOKEN', value: secret })
  assert.equal(saved.ok, true)
  assert.equal((await first.view()).secretStore.mode, 'plaintext')
  assert.equal(rawSecrets(home).secrets[0].value, secret)

  const short = await first.call('secret-encrypt', { passphrase: 'short' })
  assert.equal(short.ok, false)
  assert.match(short.error.message, /at least 8/)
  const turned = await first.call('secret-encrypt', { passphrase: PASS })
  assert.equal(turned.ok, true, JSON.stringify(turned.error))
  assert.deepEqual(turned.value, { mode: 'encrypted', locked: false, source: 'user' })
  // The same file is now an envelope: no key name, no value, no purpose in the clear.
  const envelope = rawSecrets(home)
  assert.equal(envelope.version, 2)
  assert.equal(envelope.encrypted, true)
  assert.equal(rawText(home).includes(secret), false)
  assert.equal(rawText(home).includes('DEMO_TOKEN'), false)
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8').includes(PASS), false)
  assert.equal(first.rt.secretValue('DEMO_TOKEN'), secret)
  assert.deepEqual((await first.view()).secrets.map(entry => entry.name), ['DEMO_TOKEN'])
  await first.stop({ keep: true })
})

test('a restart with no passphrase stays locked with a clear state, and the unlocked restart sees the keys', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-enc-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const secret = fresh()
  const first = start({ home })
  await first.call('secret-set', { name: 'DEMO_TOKEN', value: secret })
  assert.equal((await first.call('secret-encrypt', { passphrase: PASS })).ok, true)
  await first.stop({ keep: true })

  // No passphrase anywhere: locked, empty list, and writes are refused with the way out.
  const locked = await withEnv({ [PASSPHRASE_ENV]: undefined, [PASSPHRASE_FILE_ENV]: undefined }, async () => {
    const host = start({ home })
    const view = await host.view()
    assert.deepEqual(view.secretStore, { mode: 'encrypted', locked: true, source: null, reason: 'missing-passphrase' })
    assert.deepEqual(view.secrets, [])
    assert.equal(host.rt.secretValue('DEMO_TOKEN'), undefined)
    const refused = await host.call('secret-set', { name: 'DEMO_TOKEN', value: fresh() })
    assert.equal(refused.ok, false)
    assert.match(refused.error.message, /locked/)
    const wrong = await host.call('secret-unlock', { passphrase: 'not the passphrase' })
    assert.equal(wrong.ok, false)
    assert.match(wrong.error.message, /passphrase|unlock/i)
    return host
  })

  // The same process can unlock with the typed passphrase; the file is unchanged.
  const unlocked = await locked.call('secret-unlock', { passphrase: PASS })
  assert.equal(unlocked.ok, true, JSON.stringify(unlocked.error))
  assert.deepEqual(unlocked.value, { mode: 'encrypted', locked: false, source: 'user' })
  assert.equal(locked.rt.secretValue('DEMO_TOKEN'), secret)
  assert.deepEqual((await locked.view()).secrets.map(entry => entry.name), ['DEMO_TOKEN'])
  await locked.stop({ keep: true })

  // An unattended start takes it from the environment and says it did.
  const envHost = await withEnv({ [PASSPHRASE_ENV]: PASS }, async () => {
    const host = start({ home })
    const view = await host.view()
    assert.deepEqual(view.secretStore, { mode: 'encrypted', locked: false, source: 'env' })
    assert.equal(host.rt.secretValue('DEMO_TOKEN'), secret)
    return host
  })
  await envHost.stop({ keep: true })

  // A wrong environment passphrase locks it and says which source failed.
  const wrongHost = await withEnv({ [PASSPHRASE_ENV]: 'wrong passphrase' }, async () => {
    const host = start({ home })
    const view = await host.view()
    assert.equal(view.secretStore.locked, true)
    assert.equal(view.secretStore.reason, 'wrong-passphrase')
    return host
  })
  await wrongHost.stop({ keep: true })

  // A passphrase file works the same way and reports its source.
  const passFile = join(home, 'passphrase.txt')
  writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 })
  const fileHost = await withEnv({ [PASSPHRASE_ENV]: undefined, [PASSPHRASE_FILE_ENV]: passFile }, async () => {
    const host = start({ home })
    assert.equal((await host.view()).secretStore.source, 'file')
    assert.equal(host.rt.secretValue('DEMO_TOKEN'), secret)
    return host
  })
  await fileHost.stop({ keep: true })

  // An unreadable passphrase file keeps the store locked and names the source.
  const brokenSource = await withEnv({ [PASSPHRASE_ENV]: undefined, [PASSPHRASE_FILE_ENV]: join(home, 'missing.txt') }, async () => {
    const host = start({ home })
    assert.deepEqual((await host.view()).secretStore, { mode: 'encrypted', locked: true, source: null, reason: 'passphrase-source' })
    return host
  })
  await brokenSource.stop({ keep: true })
})

test('turning encryption off writes the plaintext file back, without losing a key', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-enc-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const secret = fresh()
  const first = start({ home })
  await first.call('secret-set', { name: 'DEMO_TOKEN', value: secret, purpose: 'p' })
  await first.call('secret-encrypt', { passphrase: PASS })
  const refused = await first.call('secret-decrypt', { passphrase: 'wrong passphrase' })
  assert.equal(refused.ok, false)
  assert.equal((await first.view()).secretStore.mode, 'encrypted')
  assert.equal(first.rt.secretValue('DEMO_TOKEN'), secret)

  const off = await first.call('secret-decrypt', { passphrase: PASS })
  assert.equal(off.ok, true, JSON.stringify(off.error))
  assert.deepEqual(off.value, { mode: 'plaintext', locked: false, source: null })
  const plain = rawSecrets(home)
  assert.equal(plain.version, 1)
  assert.equal(plain.secrets[0].value, secret)
  assert.equal(rawText(home).includes('encrypted'), false)
  await first.stop({ keep: true })

  // The rollback survives a restart with no passphrase at all.
  const plainHost = await withEnv({ [PASSPHRASE_ENV]: undefined, [PASSPHRASE_FILE_ENV]: undefined }, async () => {
    const host = start({ home })
    assert.equal((await host.view()).secretStore.mode, 'plaintext')
    assert.equal(host.rt.secretValue('DEMO_TOKEN'), secret)
    return host
  })
  await plainHost.stop({ keep: true })
})

test('a locked store can be rolled back with its passphrase', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-enc-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const secret = fresh()
  const first = start({ home })
  await first.call('secret-set', { name: 'DEMO_TOKEN', value: secret })
  await first.call('secret-encrypt', { passphrase: PASS })
  await first.stop({ keep: true })

  const host = await withEnv({ [PASSPHRASE_ENV]: undefined, [PASSPHRASE_FILE_ENV]: undefined }, async () => start({ home }))
  assert.equal((await host.view()).secretStore.locked, true)
  const off = await host.call('secret-decrypt', { passphrase: PASS })
  assert.equal(off.ok, true, JSON.stringify(off.error))
  assert.equal(rawSecrets(home).secrets[0].value, secret)
  assert.equal(host.rt.secretValue('DEMO_TOKEN'), secret)
  await host.stop({ keep: true })
})


test('decrypt and set serialize whole mutations without restoring an older token', async () => {
  const host = start()
  try {
    assert.equal((await host.call('secret-set', { name: 'DEMO_TOKEN', value: 'old-test-value', scope: 'all' })).ok, true)
    assert.equal((await host.call('secret-encrypt', { passphrase: PASS })).ok, true)
    const results = await Promise.all([
      host.call('secret-decrypt', { passphrase: PASS }),
      host.call('secret-set', { name: 'DEMO_TOKEN', value: 'new-test-value', scope: 'all' }),
    ])
    assert.ok(results.every(r => r.ok), JSON.stringify(results))
    assert.equal(rawSecrets(host.home).secrets.find(s => s.name === 'DEMO_TOKEN').value, 'new-test-value')
  } finally { await host.stop() }
})

test('an unsupported encrypted envelope stays locked and cannot be overwritten as plaintext', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-future-secrets-'))
  const envelope = { ...encryptSecrets({ version: 1, secrets: [] }, PASS), version: 999 }
  writeFileSync(join(home, 'secrets.json'), JSON.stringify(envelope))
  const host = start({ home })
  try {
    assert.equal((await host.view()).secretStore.locked, true)
    assert.equal((await host.call('secret-set', { name: 'DEMO_TOKEN', value: 'new-test-value' })).ok, false)
    assert.deepEqual(rawSecrets(home), envelope)
  } finally { await host.stop() }
})


test('a reading window can unlock locally and incremental polls include the unlocked metadata', async () => {
  const owner = start()
  let reader
  try {
    await owner.call('secret-set', { name: 'DEMO_TOKEN', value: 'test-secret-value' })
    await owner.call('secret-encrypt', { passphrase: PASS })
    await owner.stop({ keep: true })
    writeFileSync(join(owner.home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-process' }))
    reader = start({ home: owner.home })
    const before = await reader.view()
    assert.equal(before.secretStore.locked, true)
    assert.ok(reader.rt.readOnly())
    const disk = rawText(owner.home)
    assert.equal((await reader.call('secret-unlock', { passphrase: PASS })).ok, true)
    const poll = await reader.call('state', { since: before.revision, live: before.liveKey })
    assert.equal(poll.ok, true)
    assert.equal(poll.value.unchanged, true)
    assert.equal(poll.value.secretStore.locked, false)
    assert.ok(poll.value.secrets.some(item => item.name === 'DEMO_TOKEN'))
    assert.equal(rawText(owner.home), disk)
    assert.equal((await reader.call('secret-set', { name: 'OTHER_TOKEN', value: 'test-other-value' })).error.code, 'bot/read-only')
  } finally {
    if (reader) await reader.stop({ keep: true })
    await owner.stop()
  }
})
