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
// DSH's runtime and bundle packages. A profile copy of one of these is what the
// loader can resolve against the running DSH; other official packages (client
// libraries such as dsh-client-ui-primitives) are not this tool's business.
const CORE = new Set([
  'dsh-base', 'dsh-web', 'dsh-web-app', 'dsh-acp-app', 'dsh-headless', 'dsh-sdk-app', 'dsh-sdk-minimal',
  'dsh-llm', 'dsh-tools', 'dsh-scope', 'dsh-session', 'dsh-shell-env', 'dsh-workspace',
  'dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-client-connection',
  'dsh-cordis-host-runner', 'dsh-tool-cordis', 'dsh-harness-dev-context', 'dsh-workspace-changes',
  'dsh-api-remotes', 'dsh-agent-preset', 'dsh-agent-preset-registry',
].map(name => `@deepseek-ai/${name}`))

/** Profile directories under a DSH home that carry a manifest. */
export function profileDirs(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(profiles, entry.name, 'package.json')))
    .map(entry => join(profiles, entry.name))
    .sort()
}

const inScope = (name, bundles) => bundles.has(name) || CORE.has(name)

/**
 * Official runtime/bundle packages a manifest pins at a version the running DSH does
 * not satisfy. A spec the running version satisfies is kept even when it is written
 * as a range; a tag, `file:` or `workspace:` spec is not a version and is kept too.
 */
export function stalePins(manifest, dshVersion) {
  const dependencies = typeof manifest?.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  return Object.entries(dependencies)
    .filter(([name, spec]) => {
      if (!OFFICIAL.test(name) || typeof spec !== 'string') return false
      if (!inScope(name, bundles)) return false
      if (semver.validRange(spec) === null) return false
      return !semver.satisfies(dshVersion, spec, { includePrerelease: true })
    })
    .map(([name, spec]) => ({ name, spec, inBundles: bundles.has(name) }))
}

/** What a repair run would do, without writing anything. */
export function planRepair({ home, dshVersion }) {
  return profileDirs(home).map(dir => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      return { dir, error: error?.message ?? String(error), stale: [] }
    }
    return { dir, manifest, stale: stalePins(manifest, dshVersion) }
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
    for (const pin of entry.stale) delete entry.manifest.dependencies[pin.name]
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
  for (const entry of found) {
    console.log(`${entry.dir}:`)
    for (const pin of entry.stale) {
      const where = pin.inBundles ? ' (also in dsh.profile.bundles)' : ''
      console.log(`  ${pin.name}@${pin.spec}${where} — running DSH is ${dshVersion}`)
    }
  }
  if (found.length === 0) {
    console.log(`ds-bot doctor: no profile pins an official DSH package at a version the running DSH does not satisfy (${dshVersion}).`)
    console.log('If DSH still does not start, another plugin\'s dependencies may have hoisted an older copy of a DSH package into the profile. Find it there with: pnpm why @deepseek-ai/<package>')
    return broken.length > 0 ? 2 : 0
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
  console.log('Restart DSH. The Bot team reads the chats written before the upgrade from the same DSH home.')
  return broken.length > 0 ? 2 : 0
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
