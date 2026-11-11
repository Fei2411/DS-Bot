import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('removal drops the dependency row and the package, including the pnpm layout', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  plant(dir, 'other-plugin', '1.0.0')
  const flat = join(dir, 'node_modules', '.pnpm', 'ds-bot@0.2.7', 'node_modules', 'ds-bot')
  mkdirSync(flat, { recursive: true })
  writeFileSync(join(flat, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7' }))
  writeFileSync(join(dir, 'node_modules', 'ds-bot'), 'link')
  await removeShadowed(dir, ['ds-bot'])
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'other-plugin': '1.0.0' })
  assert.equal(existsSync(join(dir, 'node_modules', 'ds-bot')), false)
  assert.equal(existsSync(join(dir, 'node_modules', '.pnpm', 'ds-bot@0.2.7')), false)
  assert.equal(existsSync(join(dir, 'node_modules', 'other-plugin')), true)
})
