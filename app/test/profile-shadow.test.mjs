import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeShadowed, shadowedBundles } from '../src/profile-shadow.mjs'

const OWN = ['@deepseek-ai/dsh-base', 'ds-bot']

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-shadow-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}

const plant = (dir, name, version) => {
  const pkg = join(dir, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version }))
}

const profile = (dir, deps) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'ds-bot-profile', dependencies: deps }, null, 2)}\n`)

test('a profile-installed bundle is detected with its own version', (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(dir, 'other-plugin', '1.0.0')
  assert.deepEqual(shadowedBundles(dir, OWN), [{ name: 'ds-bot', version: '0.2.7' }])
})

test('no manifest, missing package and foreign dependencies are not shadows', (t) => {
  const dir = folder(t)
  assert.deepEqual(shadowedBundles(dir, OWN), [])
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  // Declared but not on disk: nothing resolves from it.
  assert.deepEqual(shadowedBundles(dir, OWN), [])
  plant(dir, 'other-plugin', '1.0.0')
  assert.deepEqual(shadowedBundles(dir, OWN), [])
})

test('removal drops the dependency row and the profile link, and leaves the pnpm store alone', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  plant(dir, 'other-plugin', '1.0.0')
  const store = join(dir, 'node_modules', '.pnpm', 'ds-bot@0.2.7', 'node_modules', 'ds-bot')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7' }))
  symlinkSync(store, join(dir, 'node_modules', 'ds-bot'), 'junction')
  assert.equal(shadowedBundles(dir, OWN).length, 1)
  await removeShadowed(dir, ['ds-bot'])
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'other-plugin': '1.0.0' })
  assert.equal(existsSync(join(dir, 'node_modules', 'ds-bot')), false)
  // Another package may still link into the store entry.
  assert.equal(existsSync(join(store, 'package.json')), true)
  assert.equal(existsSync(join(dir, 'node_modules', 'other-plugin')), true)
  assert.deepEqual(shadowedBundles(dir, OWN), [])
})

test('a plain copy and the engine fallback copy are removed', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(join(dir, '.dsh-module-fallback'), 'ds-bot', '0.2.7')
  await removeShadowed(dir, ['ds-bot'])
  assert.equal(existsSync(join(dir, 'node_modules', 'ds-bot')), false)
  assert.equal(existsSync(join(dir, '.dsh-module-fallback', 'node_modules', 'ds-bot')), false)
})

test('a failed removal throws and keeps the dependency row, so the copy is found again', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7' })
  plant(dir, 'ds-bot', '0.2.7')
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('read-only folders do not block removal here'); return }
  // A file inside a read-only folder cannot be unlinked.
  const pkg = join(dir, 'node_modules', 'ds-bot')
  chmodSync(pkg, 0o555)
  try { await assert.rejects(removeShadowed(dir, ['ds-bot'])) } finally { chmodSync(pkg, 0o755) }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'ds-bot': '0.2.7' })
  assert.equal(shadowedBundles(dir, OWN).length, 1)
})

test('a failure on a later name keeps only the rows of the packages that are still there', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('read-only folders do not block removal here'); return }
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', '@deepseek-ai/dsh-base': '1.0.0' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(dir, '@deepseek-ai/dsh-base', '1.0.0')
  const stuck = join(dir, 'node_modules', '@deepseek-ai', 'dsh-base')
  chmodSync(stuck, 0o555)
  try { await assert.rejects(removeShadowed(dir, ['ds-bot', '@deepseek-ai/dsh-base'])) } finally { chmodSync(stuck, 0o755) }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh-base': '1.0.0' })
  assert.deepEqual(shadowedBundles(dir, OWN).map(entry => entry.name), ['@deepseek-ai/dsh-base'])
})
