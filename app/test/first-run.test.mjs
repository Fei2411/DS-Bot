import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
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
