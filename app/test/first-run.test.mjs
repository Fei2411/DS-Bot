import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { configureIdentity, LEGACY_PRODUCT_NAME } from '../src/legacy.mjs'
import { paths } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const { chooseLocations, saveLocations } = await import('../src/first-run.mjs')
const file = join(paths.userData, 'locations.json')
const defaults = { dataDir: join(paths.root, '.ds-bot'), workspace: join(paths.root, 'DS Bot') }

delete process.env.DS_BOT_HOME
process.env.HOME = paths.root
process.env.USERPROFILE = paths.root
process.env.DSH_HOME = join(paths.root, 'dsh')

test('startup keeps valid saved locations', () => {
  const saved = { dataDir: join(paths.root, 'data'), workspace: join(paths.root, 'workspace'), freeAtStart: 100 }
  writeFileSync(file, JSON.stringify(saved))
  assert.deepEqual(chooseLocations(), saved)
})

for (const [name, contents] of [
  ['invalid JSON', '{"dataDir":'],
  ['an empty file', ''],
  ['a missing dataDir', '{}'],
  ['a non-string dataDir', '{"dataDir":42}'],
  ['an empty dataDir', '{"dataDir":""}'],
  ['a null value', 'null'],
]) {
  test(`startup falls back to default locations for ${name}`, (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    writeFileSync(file, contents)
    assert.deepEqual(chooseLocations(), defaults)
    const { dataDir, workspace } = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual({ dataDir, workspace }, defaults)
    assert.equal(warn.mock.callCount(), 1)
  })
}

test('an unreadable locations file is not treated as corrupt or replaced', (t) => {
  rmSync(file, { force: true })
  mkdirSync(file)
  t.after(() => { rmSync(file, { recursive: true }) })
  const warn = t.mock.method(console, 'warn', () => {})

  assert.throws(() => chooseLocations(), { code: 'EISDIR' })
  assert.throws(() => saveLocations(defaults), { code: 'EISDIR' })
  assert.equal(statSync(file).isDirectory(), true)
  assert.equal(existsSync(`${file}.tmp`), false)
  assert.equal(warn.mock.callCount(), 0)
})

test('recovery preserves the original bytes and writes default locations', (t) => {
  const corrupt = Buffer.from('{"dataDir":"custom",\r\n"workspace":"work",\r\n"freeAtStart":')
  const backup = `${file}.corrupt-201`
  t.mock.method(Date, 'now', () => 201)
  t.mock.method(console, 'warn', () => {})
  writeFileSync(file, corrupt)

  assert.deepEqual(chooseLocations(), defaults)
  assert.deepEqual(readFileSync(backup), corrupt)
  const { dataDir, workspace } = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual({ dataDir, workspace }, defaults)
})

test('a failed defaults write keeps the original in place and the next startup can retry', (t) => {
  const corrupt = Buffer.from('{"dataDir":"custom",\r\n"workspace":"work",\r\n"freeAtStart":')
  const backup = `${file}.corrupt-202`
  const temporary = `${file}.tmp`
  t.mock.method(Date, 'now', () => 202)
  t.mock.method(console, 'warn', () => {})
  mkdirSync(temporary)
  t.after(() => { rmSync(temporary, { force: true, recursive: true }) })
  writeFileSync(file, corrupt)

  assert.throws(() => saveLocations(defaults), { path: temporary })
  assert.deepEqual(readFileSync(file), corrupt)
  assert.equal(existsSync(backup), false)

  rmSync(temporary, { recursive: true })
  assert.deepEqual(chooseLocations(), defaults)
  assert.deepEqual(readFileSync(backup), corrupt)
  assert.equal(existsSync(`${backup}-1`), false)
})

test('a failed replacement keeps the current shell profile selected', (t) => {
  const corrupt = Buffer.from('{"dataDir":"custom",\r\n"workspace":"work",\r\n"freeAtStart":')
  const backup = `${file}.corrupt-203`
  const temporary = `${file}.tmp`
  const failed = Object.assign(new Error('replacement failed'), { code: 'ENOENT' })
  t.mock.method(Date, 'now', () => 203)
  t.mock.method(console, 'warn', () => {})
  mkdirSync(join(paths.root, LEGACY_PRODUCT_NAME))
  writeFileSync(file, corrupt)
  const original = statSync(file, { bigint: true })
  const renameFile = fs.renameSync
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === temporary && to === file) throw failed
    renameFile(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { rename.mock.restore(); syncBuiltinESMExports() })

  assert.throws(() => saveLocations(defaults), error => error === failed)
  const identity = configureIdentity({
    getPath: name => name === 'userData' ? paths.userData : paths.root,
    setPath() {},
    setName() {},
    once() {},
  }, { env: {}, platform: 'linux' })
  assert.deepEqual(identity, { userData: paths.userData, legacy: false })
  assert.deepEqual(readFileSync(file), corrupt)
  assert.deepEqual(readFileSync(backup), corrupt)
  assert.equal(statSync(backup, { bigint: true }).ino, original.ino)
  assert.equal(existsSync(temporary), false)
})

for (const [code, timestamp] of [['EPERM', 204], ['EISDIR', 205]]) {
  test(`recovery uses an exclusive copy when link fails with ${code}`, (t) => {
    const backup = `${file}.corrupt-${timestamp}`
    const temporary = `${file}.tmp`
    const corrupt = '{"dataDir":'
    const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    t.mock.method(Date, 'now', () => timestamp)
    t.mock.method(console, 'warn', () => {})
    const link = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('links unsupported'), { code }) })
    const copyFile = fs.copyFileSync
    const copy = t.mock.method(fs, 'copyFileSync', (from, to, flags) => {
      assert.equal(flags, fs.constants.COPYFILE_EXCL)
      if (to === `${backup}-1`) {
        writeFileSync(to, 'partial', { flag: 'wx' })
        throw full
      }
      copyFile(from, to, flags)
    })
    syncBuiltinESMExports()
    t.after(() => { link.mock.restore(); copy.mock.restore(); syncBuiltinESMExports() })

    writeFileSync(file, corrupt)
    assert.deepEqual(chooseLocations(), defaults)
    assert.equal(readFileSync(backup, 'utf8'), corrupt)
    writeFileSync(file, 'null')
    assert.throws(() => saveLocations(defaults), error => error === full)
    assert.equal(readFileSync(file, 'utf8'), 'null')
    assert.equal(readFileSync(backup, 'utf8'), corrupt)
    assert.equal(existsSync(`${backup}-1`), false)
    assert.equal(existsSync(temporary), false)
  })
}
