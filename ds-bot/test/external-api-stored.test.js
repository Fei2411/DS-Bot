import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApiAuth, normalizeConfig } from '../src/host/api/auth.js'

test('OpenAI compatibility requires explicit opt-in', () => {
  for (const raw of [undefined, {}, { openaiCompat: false }, { openaiCompat: 'true' }]) {
    assert.equal(normalizeConfig(raw).openaiCompat, false)
  }
  assert.equal(normalizeConfig({ openaiCompat: true }).openaiCompat, true)
})

test('stored hosts require valid IP literals and persisted LAN confirmation', t => {
  for (const host of ['127.0.0.1', '127.42.0.2', 'localhost', '::1']) {
    assert.equal(normalizeConfig({ host }).host, host)
  }
  for (const host of ['127.attacker.example', 'localhost.evil', '127.0.0.1:17830', '[::1]', 'bad host', '', '0.0.0.0', '192.168.1.2', '::']) {
    assert.equal(normalizeConfig({ host }).host, '127.0.0.1')
  }
  assert.equal(normalizeConfig({ host: 'evil.example', confirmLan: true }).host, '127.0.0.1')
  assert.equal(normalizeConfig({ host: '0.0.0.0', confirmLan: true }).host, '0.0.0.0')
  assert.equal(normalizeConfig({ host: '::', confirmLan: true }).host, '::')
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-config-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'api-config.json'), JSON.stringify({ host: '0.0.0.0' }))
  const auth = createApiAuth({ home })
  assert.equal(auth.getConfig().host, '127.0.0.1')
  auth.updateConfig({ host: '192.168.1.2', confirmLan: true })
  auth.reloadConfig()
  assert.equal(auth.getConfig().host, '192.168.1.2')
  assert.equal(JSON.parse(readFileSync(join(home, 'api-config.json'))).confirmLan, true)
  auth.updateConfig({ host: 'localhost' })
  auth.reloadConfig()
  assert.equal(auth.getConfig().confirmLan, false)
})

test('stored token target lists fail closed and ignore non-string entries', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-targets-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const auth = createApiAuth({
    home, botOf: id => ({ id }), roomOf: id => ({ id }),
  })
  const secret = 'dsb_stored_test'
  const base = {
    keyId: 'stored', hashAlgo: 'sha256-raw',
    hash: createHash('sha256').update(secret).digest('hex'), scopes: ['read'],
  }
  const req = { url: '/', headers: { host: 'localhost', authorization: `Bearer ${secret}` }, socket: { remoteAddress: 'local' } }
  const principalFor = async patch => {
    writeFileSync(join(home, 'api-tokens.json'), JSON.stringify([{ ...base, ...patch }]))
    const result = await auth.authenticate(req)
    assert.equal(result.ok, true)
    return result.token
  }
  const missing = await principalFor({})
  assert.equal(missing.targetScope, 'selected')
  assert.equal(missing.canAccessBot('b1'), false)
  assert.equal(missing.canAccessRoom('r1'), false)
  const selected = await principalFor({
    botIds: ['b1', 42, null, {}], roomIds: ['r1', 42], privateBotIds: [42],
    allowedTargets: [null, {}, 42, 'bot:b2', 'room:r2'],
  })
  for (const id of ['b1', 'b2']) assert.equal(selected.canAccessBot(id), true)
  for (const id of ['r1', 'r2']) assert.equal(selected.canAccessRoom(id), true)
  assert.equal(selected.canAccessBot('42'), false)
  assert.equal(selected.canAccessRoom('42'), false)
  assert.equal((await principalFor({ targetScope: 'all_public' })).canAccessBot('other'), true)
})
