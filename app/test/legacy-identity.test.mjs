import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { parse } from 'yaml'
import { UUID } from 'builder-util-runtime'
import { APP_ID, configureIdentity, LEGACY_ARTIFACT_PREFIX, LEGACY_PRODUCT_NAME } from '../src/legacy.mjs'

function fixture({ saved = [], packaged = true } = {}) {
  const app = new EventEmitter()
  const appData = join(tmpdir(), 'dsbot-identity-fixture')
  const current = join(appData, 'DS Bot')
  const legacy = join(appData, LEGACY_PRODUCT_NAME)
  const paths = { appData, userData: current }
  const names = []
  Object.assign(app, {
    isPackaged: packaged,
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value },
    setName: name => names.push(name),
    setAppUserModelId: id => { app.id = id },
  })
  const exists = path => saved.includes(path)
  return { app, paths, names, current, legacy, exists }
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: an existing installation keeps its shell data and encryption identity`, () => {
    const f = fixture()
    let created
    const options = { env: {}, platform, mkdir: path => { created = path }, exists: path => path === f.legacy }
    assert.deepEqual(configureIdentity(f.app, options), { userData: f.legacy, legacy: true })
    assert.equal(f.paths.sessionData, f.legacy)
    assert.equal(created, f.legacy)
    if (platform === 'win32') {
      assert.equal(f.app.id, APP_ID)
      assert.deepEqual(f.names, [])
    } else {
      assert.deepEqual(f.names, [LEGACY_PRODUCT_NAME])
      f.app.emit('ready')
      assert.deepEqual(f.names, [LEGACY_PRODUCT_NAME, 'DS Bot'])
    }
  })
}

test('a fresh installation uses the new shell directory', () => {
  const f = fixture()
  assert.deepEqual(configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: f.exists }), { userData: f.current, legacy: false })
  assert.deepEqual(f.names, [])
})

test('an already configured new installation wins when both directories exist', () => {
  const f = fixture()
  const existing = [f.legacy, join(f.current, 'locations.json')]
  assert.equal(configureIdentity(f.app, { env: {}, mkdir: () => {}, exists: path => existing.includes(path) }).userData, f.current)
})

test('an explicit shell directory never probes installed user data', () => {
  const f = fixture()
  const explicit = join(tmpdir(), 'dsbot-custom-shell')
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_SHELL_DATA: explicit }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, explicit)
  assert.equal(f.paths.sessionData, explicit)
})

test('an isolated data run never probes an installed application', () => {
  const f = fixture({ packaged: false })
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_HOME: '/tmp/dsbot-test-data' }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, f.current)
})

test('a source installation also keeps its existing shell data', () => {
  const f = fixture({ packaged: false })
  assert.equal(configureIdentity(f.app, { env: {}, mkdir: () => {}, exists: path => path === f.legacy }).userData, f.legacy)
})

for (const suffix of ['mac-arm64.zip', 'mac-x64.zip', 'linux-amd64.deb']) {
  test(`old update clients receive the identical DS Bot payload: ${suffix}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dsbot-release-alias-'))
    try {
      const source = join(root, `DS-Bot-1.2.3-${suffix}`)
      const payload = Buffer.from('new DS Bot package')
      writeFileSync(source, payload)
      const result = spawnSync(process.execPath, ['scripts/legacy-release-assets.mjs', source], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      const alias = join(root, `${LEGACY_ARTIFACT_PREFIX}-1.2.3-${suffix}`)
      assert.deepEqual(readFileSync(alias), payload)
      assert.equal(existsSync(source), true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}


test('renaming the Windows application preserves the published installer GUID', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const published = UUID.v5('io.github.fei2411.deepseekbot', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
  assert.equal(config.appId, APP_ID)
  assert.equal(config.nsis.guid, published)
})
