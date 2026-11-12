import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { planRepair, repair, stalePins } from '../bin/ds-bot-doctor.mjs'

// #1449: after a DSH upgrade a profile whose manifest pins official DSH packages at
// another version keeps its own old copies; DSH disables the rows they provide and the
// Bot team's sessionController/workspaceRegistry never appear. The doctor names those
// stale pins and removes only them, leaving chats, settings and credentials alone.

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ds-bot-doctor.mjs')
const RUNNING = '0.2.2-rc.2'

function homeWith(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-doctor-'))
  for (const [name, manifest] of Object.entries(profiles)) {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return home
}

const manifest = (dependencies, bundles = []) => ({
  name: 'dsh-profile-web',
  private: true,
  dependencies,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } },
})

test('a profile that pins official DSH packages at another version is named', () => {
  const stale = stalePins(manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5', 'left-pad': '1.3.0' }), RUNNING)
  assert.deepEqual(stale.map(pin => [pin.name, pin.spec, pin.inBundles]), [['@deepseek-ai/dsh-web-app', '0.2.1-rc.5', true]])
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': RUNNING }), RUNNING), [])
})

test('the doctor reads every profile and survives one it cannot parse', () => {
  const home = homeWith({
    web: manifest({ '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }),
    clean: manifest({ '@deepseek-ai/dsh-web-app': RUNNING }),
  })
  mkdirSync(join(home, 'profiles', 'broken'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'broken', 'package.json'), '{not json')
  const plan = planRepair({ home, dshVersion: RUNNING })
  const readable = Object.fromEntries(plan.filter(entry => entry.error === undefined).map(entry => [basename(entry.dir), entry.stale.length]))
  assert.deepEqual(readable, { clean: 0, web: 1 })
  assert.equal(plan.filter(entry => entry.error !== undefined).length, 1)
})

test('a repair removes only the stale pins and keeps the rest of the manifest', () => {
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }) })
  const changed = repair(planRepair({ home, dshVersion: RUNNING }))
  assert.deepEqual(changed.map(entry => entry.removed), [['@deepseek-ai/dsh-web-app@0.2.1-rc.5']])
  const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved.dependencies), ['ds-bot'])
  assert.deepEqual(saved.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

test('the command reports a stale pin and --fix clears it', () => {
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }) })
  const run = (...args) => spawnSync(process.execPath, [DOCTOR, 'doctor', '--home', home, '--dsh-version', RUNNING, ...args], { encoding: 'utf8' })
  const check = run()
  assert.equal(check.status, 1)
  assert.match(check.stdout, /@deepseek-ai\/dsh-web-app@0\.2\.1-rc\.5/)
  assert.match(check.stdout, /running DSH is 0\.2\.2-rc\.2/)
  assert.match(check.stdout, /--fix/)
  const fixed = run('--fix')
  assert.equal(fixed.status, 0)
  const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved.dependencies), ['ds-bot'])
  rmSync(home, { recursive: true, force: true })
})
