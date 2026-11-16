import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { planRepair, repair, stalePins } from '../bin/ds-bot-doctor.mjs'

// #1449: after a DSH upgrade a profile whose manifest pins official DSH runtime
// packages at a version the running DSH does not satisfy keeps its own old copies; DSH
// disables the rows they provide and the Bot team's sessionController/workspaceRegistry
// never appear. The doctor names those pins, removes only the incompatible ones, and
// reconciles the profile so a restart needs no separate manual install.

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ds-bot-doctor.mjs')
const RUNNING = '0.2.2-rc.2'
const FAKE_PNPM = 'true'

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
const names = stale => stale.map(pin => `${pin.name}@${pin.spec}`)

test('a pin the running DSH satisfies is kept, an incompatible one is named', () => {
  assert.deepEqual(names(stalePins(manifest({
    'ds-bot': '0.3.2',
    '@deepseek-ai/dsh-web-app': '0.2.1-rc.5',
    'left-pad': '1.3.0',
  }), RUNNING)), ['@deepseek-ai/dsh-web-app@0.2.1-rc.5'])
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': RUNNING }), RUNNING), [])
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': '^0.2.2-rc.2' }), RUNNING), [])
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': '^0.2.1-rc.5' }), RUNNING), [])
  assert.deepEqual(names(stalePins(manifest({ '@deepseek-ai/dsh-web-app': '^0.1.0' }), RUNNING)), ['@deepseek-ai/dsh-web-app@^0.1.0'])
})

test('only DSH runtime and mounted bundles are touched', () => {
  // A client library a plugin pins on purpose is not a service provider.
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-client-ui-primitives': '0.2.1-rc.5' }), RUNNING), [])
  // A core service package matters even when it is not itself a bundle.
  assert.deepEqual(names(stalePins(manifest({ '@deepseek-ai/dsh-api-session-controller': '0.2.1-rc.5' }), RUNNING)),
    ['@deepseek-ai/dsh-api-session-controller@0.2.1-rc.5'])
  // A tag or a file/workspace spec is not a version to judge.
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': 'latest' }), RUNNING), [])
  assert.deepEqual(stalePins(manifest({ '@deepseek-ai/dsh-web-app': 'workspace:*' }), RUNNING), [])
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

test('a repair removes only the stale pins and reconciles the profile', () => {
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }) })
  const changed = repair(planRepair({ home, dshVersion: RUNNING }), { pnpm: FAKE_PNPM })
  assert.deepEqual(changed.map(entry => [entry.removed, entry.installed]), [[['@deepseek-ai/dsh-web-app@0.2.1-rc.5'], true]])
  const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved.dependencies), ['ds-bot'])
  assert.deepEqual(saved.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

test('the command reports a stale pin, --fix reconciles it, and a failed install names the command', () => {
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }) })
  const run = (env, ...args) => spawnSync(process.execPath, [DOCTOR, 'doctor', '--home', home, '--dsh-version', RUNNING, ...args], { encoding: 'utf8', env: { ...process.env, DSH_PNPM: env } })
  const check = run(FAKE_PNPM)
  assert.equal(check.status, 1)
  assert.match(check.stdout, /@deepseek-ai\/dsh-web-app@0\.2\.1-rc\.5/)
  assert.match(check.stdout, /running DSH is 0\.2\.2-rc\.2/)
  assert.match(check.stdout, /--fix/)
  assert.doesNotMatch(check.stdout, /pnpm why/)
  const fixed = run(FAKE_PNPM, '--fix')
  assert.equal(fixed.status, 0)
  assert.match(fixed.stdout, /reconciled with pnpm/)
  const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved.dependencies), ['ds-bot'])
  // A pnpm that is not there leaves the edit in place but tells the user the command.
  const again = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5' }) })
  const failed = spawnSync(process.execPath, [DOCTOR, 'doctor', '--home', again, '--dsh-version', RUNNING, '--fix'], { encoding: 'utf8', env: { ...process.env, DSH_PNPM: '/nonexistent/pnpm' } })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /pnpm install/)
  rmSync(home, { recursive: true, force: true })
  rmSync(again, { recursive: true, force: true })
})

test('a clean report says how to find an older copy another plugin hoisted in', () => {
  // The manifest is clean but node_modules can still hold a stale copy as a transitive
  // dependency; the doctor does not read those, so a clean report must not read as "all
  // clear" - it names pnpm why and never claims the copy was removed.
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': RUNNING }) })
  const check = spawnSync(process.execPath, [DOCTOR, 'doctor', '--home', home, '--dsh-version', RUNNING], { encoding: 'utf8' })
  assert.equal(check.status, 0)
  assert.match(check.stdout, /no profile pins an official DSH package/)
  assert.match(check.stdout, /pnpm why @deepseek-ai\/<package>/)
  assert.doesNotMatch(check.stdout, /removed /)
  rmSync(home, { recursive: true, force: true })
})


test('an invalid explicit DSH version cannot remove pins during repair', () => {
  const home = homeWith({ web: manifest({ '@deepseek-ai/dsh-web-app': RUNNING }) })
  try {
    const file = join(home, 'profiles', 'web', 'package.json')
    const before = readFileSync(file, 'utf8')
    const result = spawnSync(process.execPath, [DOCTOR, '--home', home, '--dsh-version', 'typo', '--fix'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the command runs when npm links the bin with a symlink', { skip: process.platform === 'win32' }, () => {
  // Unix npm puts a symlink in node_modules/.bin; the kernel then runs the script with
  // argv[1] naming the link while the module resolves to the file it points at. On
  // Windows npm writes a .cmd shim instead, which passes the script path directly.
  const home = homeWith({ web: manifest({ 'ds-bot': '0.3.2', '@deepseek-ai/dsh-web-app': RUNNING }) })
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-doctor-bin-'))
  const link = join(dir, 'ds-bot-doctor')
  symlinkSync(DOCTOR, link)
  try {
    const check = spawnSync(process.execPath, [link, 'doctor', '--home', home, '--dsh-version', RUNNING], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /no profile pins an official DSH package/)
    // A linked call with no argument prints the usage instead of exiting 0 in silence.
    const usage = spawnSync(process.execPath, [link], { encoding: 'utf8' })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /usage: npx ds-bot doctor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
