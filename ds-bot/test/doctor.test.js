import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundledDshPackages, classifyStalePins, planRepair, repair, stalePins } from '../bin/ds-bot-doctor.mjs'

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

test('catches stale official DSH tool plugins like dsh-tool-subagent and hoisted node_modules copies', () => {
  assert.deepEqual(
    names(stalePins(manifest({
      '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.4',
      '@deepseek-ai/dsh-schedule': '0.2.1-rc.4',
      '@deepseek-ai/dsh-client-ui-primitives': '0.2.1-rc.4',
      '@deepseek-ai/dsh-util-time': '0.2.1-rc.4',
    }), RUNNING)),
    ['@deepseek-ai/dsh-tool-subagent@0.2.1-rc.4', '@deepseek-ai/dsh-schedule@0.2.1-rc.4'],
  )

  const home = homeWith({ 'ds-bot': manifest({ 'ds-bot': '0.4.1' }) })
  const hoistedDir = join(home, 'profiles', 'ds-bot', 'node_modules', '@deepseek-ai', 'dsh-tool-subagent')
  mkdirSync(hoistedDir, { recursive: true })
  writeFileSync(join(hoistedDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.1-rc.4' }))
  try {
    const plan = planRepair({ home, dshVersion: RUNNING })
    assert.equal(plan[0].stale.length, 0)
    assert.deepEqual(plan[0].hoisted, [{ name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.1-rc.4', inBundles: false }])

    const check = spawnSync(process.execPath, [DOCTOR, 'doctor', '--home', home, '--dsh-version', RUNNING], { encoding: 'utf8' })
    assert.equal(check.status, 1)
    assert.match(check.stdout, /@deepseek-ai\/dsh-tool-subagent@0\.2\.1-rc\.4 \(hoisted in node_modules\)/)
    assert.match(check.stdout, /pnpm why/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('does not auto-delete profile-only official packages such as native Computer Use drivers, and reports them separately', () => {
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'ds-bot': '0.4.1',
      'my-custom-plugin': '1.2.3',
      '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.4',
      '@deepseek-ai/dsh-cua-native': '0.2.1-rc.4',
      '@deepseek-ai/dsh-experimental-cua-windows': '0.2.1-rc.4',
      '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native': '0.2.1-rc.4',
      '@deepseek-ai/dsh-experimental-schedule-bundle': '0.2.1-rc.4',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-cua-native'] } },
  }

  // With an explicit bundled set from a running DSH installation (confirming dsh-tool-subagent is built-in,
  // while native CUA drivers are profile-only, and retired schedule-bundle is retired):
  const bundled = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tool-subagent'])
  const classified = classifyStalePins(pkg, RUNNING, { bundledPackages: bundled })
  assert.deepEqual(names(classified.stale), [
    '@deepseek-ai/dsh-tool-subagent@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-schedule-bundle@0.2.1-rc.4',
  ])
  assert.deepEqual(names(classified.profileOnly), [
    '@deepseek-ai/dsh-cua-native@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-cua-windows@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.4',
  ])

  // Without a DSH install on disk (fallback allowlist), profile-only native CUA drivers are STILL protected:
  const fallback = classifyStalePins(pkg, RUNNING)
  assert.deepEqual(names(fallback.stale), [
    '@deepseek-ai/dsh-tool-subagent@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-schedule-bundle@0.2.1-rc.4',
  ])
  assert.deepEqual(names(fallback.profileOnly), [
    '@deepseek-ai/dsh-cua-native@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-cua-windows@0.2.1-rc.4',
    '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.4',
  ])

  // End-to-end `doctor --fix` removes confirmed built-in / retired stale pins but NEVER deletes
  // profile-only native CUA drivers or custom plugins, and reports upgrade instructions instead.
  const home = homeWith({ web: pkg })
  const dshInstallDir = mkdtempSync(join(tmpdir(), 'ds-bot-doctor-dsh-'))
  try {
    mkdirSync(join(dshInstallDir, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent'), { recursive: true })
    writeFileSync(join(dshInstallDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: RUNNING,
      dependencies: { '@deepseek-ai/dsh-tool-subagent': RUNNING },
    }))
    writeFileSync(join(dshInstallDir, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tool-subagent',
      version: RUNNING,
    }))
    assert.deepEqual([...bundledDshPackages(join(dshInstallDir, 'package.json'))].sort(), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tool-subagent'])

    const fixed = spawnSync(
      process.execPath,
      [DOCTOR, 'doctor', '--home', home, '--dsh-version', RUNNING, '--dsh-install', dshInstallDir, '--fix'],
      { encoding: 'utf8', env: { ...process.env, DSH_PNPM: FAKE_PNPM } },
    )
    assert.equal(fixed.status, 1, 'remaining profile-only stale packages require manual upgrade so exit status stays 1')
    assert.match(fixed.stdout, /removed @deepseek-ai\/dsh-tool-subagent@0\.2\.1-rc\.4, @deepseek-ai\/dsh-experimental-schedule-bundle@0\.2\.1-rc\.4/)
    assert.match(fixed.stdout, /@deepseek-ai\/dsh-cua-native@0\.2\.1-rc\.4.*profile-only/)
    assert.match(fixed.stdout, /pnpm add @deepseek-ai\/dsh-cua-native@0\.2\.2-rc\.2/)
    const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.equal(saved.dependencies['@deepseek-ai/dsh-tool-subagent'], undefined)
    assert.equal(saved.dependencies['@deepseek-ai/dsh-experimental-schedule-bundle'], undefined)
    assert.equal(saved.dependencies['@deepseek-ai/dsh-cua-native'], '0.2.1-rc.4')
    assert.equal(saved.dependencies['@deepseek-ai/dsh-experimental-cua-windows'], '0.2.1-rc.4')
    assert.equal(saved.dependencies['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'], '0.2.1-rc.4')
    assert.equal(saved.dependencies['my-custom-plugin'], '1.2.3')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dshInstallDir, { recursive: true, force: true })
  }
})

test('removes duplicate stale pins across dependencies and optionalDependencies while keeping compatible peerDependencies intact', () => {
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'ds-bot': '0.4.1',
      '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.4',
      '@deepseek-ai/dsh-schedule': RUNNING,
    },
    optionalDependencies: {
      '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.3',
      '@deepseek-ai/dsh-schedule': '0.2.1-rc.4',
      'custom-optional': '2.0.0',
    },
    peerDependencies: {
      '@deepseek-ai/dsh-tool-subagent': `^${RUNNING}`,
      '@deepseek-ai/dsh-web-app': '0.2.1-rc.2',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  const home = homeWith({ web: pkg })
  try {
    const plan = planRepair({ home, dshVersion: RUNNING })
    assert.deepEqual(
      plan[0].stale.map(pin => [pin.field ?? 'dependencies', pin.name, pin.spec]),
      [
        ['dependencies', '@deepseek-ai/dsh-tool-subagent', '0.2.1-rc.4'],
        ['optionalDependencies', '@deepseek-ai/dsh-tool-subagent', '0.2.1-rc.3'],
        ['optionalDependencies', '@deepseek-ai/dsh-schedule', '0.2.1-rc.4'],
        ['peerDependencies', '@deepseek-ai/dsh-web-app', '0.2.1-rc.2'],
      ],
    )
    const changed = repair(plan, { pnpm: FAKE_PNPM })
    assert.equal(changed.length, 1)
    assert.equal(changed[0].installed, true)
    const saved = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.deepEqual(saved.dependencies, { 'ds-bot': '0.4.1', '@deepseek-ai/dsh-schedule': RUNNING })
    assert.deepEqual(saved.optionalDependencies, { 'custom-optional': '2.0.0' })
    assert.deepEqual(saved.peerDependencies, { '@deepseek-ai/dsh-tool-subagent': `^${RUNNING}` })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
