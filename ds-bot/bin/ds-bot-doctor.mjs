#!/usr/bin/env node
// ds-bot-doctor: diagnose a DSH home whose profiles pin official DSH runtime packages
// at a version the running DSH does not satisfy. A pinned copy shadows the new
// installation's module, DSH disables the rows whose versions do not match its
// runtime, and plugins that inject their services — the Bot team's
// sessionController and workspaceRegistry — stay pending. That is the startup failure
// behind issue #1449.
//
// This is a repair tool the user runs by hand; nothing invokes it automatically.
//   npx ds-bot doctor          report the stale pins
//   npx ds-bot doctor --fix    remove them and reconcile each profile with pnpm
//
// A pin that the running DSH satisfies (an exact version, or a range such as
// ^0.2.2-rc.2) is kept, and only DSH's own runtime/bundle packages are considered:
// other official packages may be pinned by other plugins on purpose. Sessions,
// settings, credentials and dsh.profile.bundles are not touched, so the chats
// written before the upgrade stay readable.
//
// Only the profiles' manifests are read. An older copy that another plugin's dependency
// tree hoisted into the profile is not detected, so a clean report says how to look for
// one with pnpm why; removing that copy would break the plugin that carries it.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'
import { findExecutable, launchOf } from '../src/host/local-agents/discover.js'

const run = (file, args, options) => {
  const launch = launchOf(findExecutable(file) ?? file, args)
  return spawnSync(launch.file, launch.args, { ...options, ...launch.options })
}

const OFFICIAL = /^@deepseek-ai\/dsh(?:-|$)/
// Pure client UI libraries and protocol/utility packages that third-party plugins may pin
// as library dependencies without providing DSH host/agent plugins. Every other official
// `@deepseek-ai/dsh*` package (bundles, runtime services, tools such as dsh-tool-subagent)
// is checked against the running DSH version so an outdated profile copy cannot shadow it.
const CLIENT_UI = /^@deepseek-ai\/dsh-(?:experimental-)?client-ui-/
const UTIL_LIB = /^@deepseek-ai\/dsh-util-/
const NON_PLUGIN_LIBS = new Set([
  'dsh-atomic-write', 'dsh-chunked-list', 'dsh-client-locale', 'dsh-client-resources',
  'dsh-client-shortcuts', 'dsh-client-store', 'dsh-cmdline', 'dsh-deque', 'dsh-error',
  'dsh-home-paths', 'dsh-hook-protocol', 'dsh-official-bundles', 'dsh-package-manifest',
  'dsh-sdk-protocol', 'dsh-typert-protocol',
].map(name => `@deepseek-ai/${name}`))
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/** Profile directories under a DSH home that carry a manifest. */
export function profileDirs(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(profiles, entry.name, 'package.json')))
    .map(entry => join(profiles, entry.name))
    .sort()
}

const inScope = (name, bundles) => bundles.has(name) || (!CLIENT_UI.test(name) && !UTIL_LIB.test(name) && !NON_PLUGIN_LIBS.has(name))

/**
 * Official runtime/bundle/plugin packages a manifest pins at a version the running DSH does
 * not satisfy. A spec the running version satisfies is kept even when it is written as a
 * range; a tag, `file:` or `workspace:` spec is not a version and is kept too.
 */
export function stalePins(manifest, dshVersion) {
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  const seen = new Set()
  const stale = []
  for (const field of DEP_FIELDS) {
    const section = typeof manifest?.[field] === 'object' && manifest[field] !== null ? manifest[field] : {}
    for (const [name, spec] of Object.entries(section)) {
      if (seen.has(name) || !OFFICIAL.test(name) || typeof spec !== 'string') continue
      if (!inScope(name, bundles)) continue
      if (semver.validRange(spec) === null) continue
      if (!semver.satisfies(dshVersion, spec, { includePrerelease: true })) {
        seen.add(name)
        stale.push({ name, spec, inBundles: bundles.has(name), ...(field === 'dependencies' ? {} : { field }) })
      }
    }
  }
  return stale
}

/**
 * Official DSH plugin/runtime packages installed under the profile's `node_modules/@deepseek-ai/`
 * at a version the running DSH does not satisfy, even when not pinned in `package.json`
 * (for example hoisted by another plugin or left behind by an earlier install).
 */
export function staleInstalled(dir, manifest, dshVersion, pinnedNames = new Set()) {
  const scopeDir = join(dir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) return []
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  let entries
  try { entries = readdirSync(scopeDir, { withFileTypes: true }) } catch { return [] }
  const hoisted = []
  for (const entry of entries) {
    const name = `@deepseek-ai/${entry.name}`
    if (pinnedNames.has(name) || !OFFICIAL.test(name) || !inScope(name, bundles)) continue
    const pkgPath = join(scopeDir, entry.name, 'package.json')
    if (!existsSync(pkgPath)) continue
    let version
    try { version = JSON.parse(readFileSync(pkgPath, 'utf8'))?.version } catch { continue }
    if (typeof version !== 'string' || semver.valid(version) === null) continue
    if (!semver.satisfies(dshVersion, version, { includePrerelease: true })) {
      hoisted.push({ name, version, inBundles: bundles.has(name) })
    }
  }
  return hoisted.sort((a, b) => a.name.localeCompare(b.name))
}

/** What a repair run would do, without writing anything. */
export function planRepair({ home, dshVersion }) {
  return profileDirs(home).map(dir => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      return { dir, error: error?.message ?? String(error), stale: [], hoisted: [] }
    }
    const stale = stalePins(manifest, dshVersion)
    const hoisted = staleInstalled(dir, manifest, dshVersion, new Set(stale.map(pin => pin.name)))
    return { dir, manifest, stale, hoisted }
  })
}

/**
 * Remove the stale pins and reconcile each changed profile's installed tree, so a
 * restart uses the running DSH's own modules without a separate manual install.
 * Returns what changed, whether the reconcile worked, and the command to run by hand
 * when it did not.
 */
export function repair(plan, { pnpm = process.env.DSH_PNPM ?? 'pnpm' } = {}) {
  const changed = []
  for (const entry of plan) {
    if (entry.error !== undefined || entry.stale.length === 0) continue
    for (const pin of entry.stale) delete entry.manifest[pin.field ?? 'dependencies']?.[pin.name]
    writeFileSync(join(entry.dir, 'package.json'), `${JSON.stringify(entry.manifest, null, 2)}\n`)
    const command = `cd ${entry.dir} && ${pnpm} install`
    let installed = false
    let failure
    try {
      const result = run(pnpm, ['install', '--prefer-offline', '--config.strictDepBuilds=false'], { cwd: entry.dir, encoding: 'utf8' })
      installed = result.status === 0
      if (!installed) failure = `${result.error?.message ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n')
    } catch (error) {
      failure = error?.message ?? String(error)
    }
    changed.push({ dir: entry.dir, removed: entry.stale.map(pin => `${pin.name}@${pin.spec}`), installed, command, ...(failure === undefined ? {} : { failure }) })
  }
  return changed
}

function runningVersion() {
  try {
    const result = run(process.env.DSH_BIN ?? 'dsh', ['--version'], { encoding: 'utf8' })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\s+/)[0]
    return result.status === 0 && semver.valid(text) !== null ? text : undefined
  } catch {
    return undefined
  }
}

function main(argv) {
  const [command, ...args] = argv.slice(2)
  if (command !== 'doctor') {
    console.error('usage: npx ds-bot doctor [--fix] [--home <DSH_HOME>] [--dsh-version <version>]')
    return 2
  }
  const fix = args.includes('--fix')
  const homeArg = args.indexOf('--home')
  const versionArg = args.indexOf('--dsh-version')
  if ((homeArg >= 0 && args[homeArg + 1] === undefined) || (versionArg >= 0 && args[versionArg + 1] === undefined)) {
    console.error('ds-bot doctor: --home and --dsh-version need a value.')
    return 2
  }
  const home = homeArg >= 0 ? args[homeArg + 1] : (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const dshVersion = versionArg >= 0 ? args[versionArg + 1] : runningVersion()
  if (dshVersion === undefined || semver.valid(dshVersion) === null) {
    console.error('ds-bot doctor: cannot read the DSH version. Pass --dsh-version <version>.')
    return 2
  }
  const plan = planRepair({ home, dshVersion })
  const broken = plan.filter(entry => entry.error !== undefined)
  for (const entry of broken) console.error(`ds-bot doctor: cannot read ${entry.dir}/package.json: ${entry.error}`)
  const found = plan.filter(entry => entry.stale.length > 0)
  const hoistedOnly = plan.filter(entry => entry.stale.length === 0 && entry.hoisted.length > 0)
  for (const entry of plan.filter(entry => entry.stale.length > 0 || entry.hoisted.length > 0)) {
    console.log(`${entry.dir}:`)
    for (const pin of entry.stale) {
      const where = pin.inBundles ? ' (also in dsh.profile.bundles)' : ''
      console.log(`  ${pin.name}@${pin.spec}${where} — running DSH is ${dshVersion}`)
    }
    for (const copy of entry.hoisted) {
      console.log(`  ${copy.name}@${copy.version} (hoisted in node_modules) — running DSH is ${dshVersion}`)
    }
  }
  if (found.length === 0 && hoistedOnly.length === 0) {
    console.log(`ds-bot doctor: no profile pins an official DSH package at a version the running DSH does not satisfy (${dshVersion}).`)
    console.log('If DSH still does not start, another plugin\'s dependencies may have hoisted an older copy of a DSH package into the profile. Find it there with: pnpm why @deepseek-ai/<package>')
    return broken.length > 0 ? 2 : 0
  }
  if (found.length === 0) {
    console.log('\nThese copies are not pinned in package.json (they were hoisted by another plugin or left from an earlier install).')
    console.log('Inspect what brings each one in with `pnpm why <package>` inside the profile directory before removing it.')
    return broken.length > 0 ? 2 : 1
  }
  if (!fix) {
    console.log('\nRe-run with --fix to remove them. Sessions, settings and credentials are not touched.')
    return 1
  }
  let installFailed = false
  for (const change of repair(found)) {
    console.log(`ds-bot doctor: removed ${change.removed.join(', ')} from ${change.dir}`)
    if (change.installed) {
      console.log('  profile packages reconciled with pnpm.')
    } else {
      installFailed = true
      console.error(`  could not reconcile the profile's packages${change.failure === undefined ? '' : `:\n${change.failure}`}`)
      console.error(`  run this, then restart DSH: ${change.command}`)
    }
  }
  if (installFailed) return 1
  const remainingHoisted = plan.flatMap(entry => staleInstalled(entry.dir, entry.manifest, dshVersion).map(copy => ({ dir: entry.dir, copy })))
  if (remainingHoisted.length > 0) {
    console.log('Some hoisted official DSH copies still remain in node_modules:')
    for (const { dir, copy } of remainingHoisted) {
      console.log(`  ${dir}: ${copy.name}@${copy.version} — check with \`pnpm why ${copy.name}\``)
    }
  }
  console.log('Restart DSH. The Bot team reads the chats written before the upgrade from the same DSH home.')
  return broken.length > 0 ? 2 : (remainingHoisted.length > 0 ? 1 : 0)
}

// npm links a bin with a symlink on Unix (and a shim on Windows): argv[1] can name the
// link while import.meta.url names the file it points at. Compare the real paths, or an
// `npx ds-bot doctor` call would find no entry point and exit 0 without doing anything.
function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (invokedDirectly()) {
  process.exit(main(process.argv))
}
