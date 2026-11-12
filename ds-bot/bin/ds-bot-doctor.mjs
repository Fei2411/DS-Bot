#!/usr/bin/env node
// ds-bot-doctor: repair a DSH home whose profiles pin official DSH packages at a
// version other than the one now running. A pinned copy shadows the new
// installation's module, DSH disables the rows whose versions do not match its
// runtime, and plugins that inject their services — the Bot team's
// sessionController and workspaceRegistry — stay pending. That is the startup
// failure behind issue #1449.
//
//   npx ds-bot doctor          report the stale pins
//   npx ds-bot doctor --fix    remove them from the profile manifests
//
// Only the dependency entries that name a different DSH version are removed.
// Sessions, settings, credentials and dsh.profile.bundles are not touched, so
// the chats written before the upgrade stay readable.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const OFFICIAL = /^@deepseek-ai\/dsh(?:-|$)/
const RUNNING = /^\d/

/** Profile directories under a DSH home that carry a manifest. */
export function profileDirs(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(profiles, entry.name, 'package.json')))
    .map(entry => join(profiles, entry.name))
    .sort()
}

/** Official DSH packages a manifest pins at another version than the running DSH. */
export function stalePins(manifest, dshVersion) {
  const dependencies = typeof manifest?.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  return Object.entries(dependencies)
    .filter(([name, spec]) => OFFICIAL.test(name) && typeof spec === 'string' && spec !== dshVersion)
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

/** Remove the stale pins from the planned profiles; returns what changed. */
export function repair(plan) {
  const changed = []
  for (const entry of plan) {
    if (entry.error !== undefined || entry.stale.length === 0) continue
    for (const pin of entry.stale) delete entry.manifest.dependencies[pin.name]
    writeFileSync(join(entry.dir, 'package.json'), `${JSON.stringify(entry.manifest, null, 2)}\n`)
    changed.push({ dir: entry.dir, removed: entry.stale.map(pin => `${pin.name}@${pin.spec}`) })
  }
  return changed
}

function runningVersion() {
  try {
    const result = spawnSync(process.env.DSH_BIN ?? 'dsh', ['--version'], { encoding: 'utf8' })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\s+/)[0]
    return result.status === 0 && RUNNING.test(text) ? text : undefined
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
  if (dshVersion === undefined) {
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
    console.log(`ds-bot doctor: no profile pins an official DSH package at another version than ${dshVersion}.`)
    return broken.length > 0 ? 2 : 0
  }
  if (!fix) {
    console.log('\nRe-run with --fix to remove them. Sessions, settings and credentials are not touched.')
    return 1
  }
  for (const change of repair(found)) console.log(`ds-bot doctor: removed ${change.removed.join(', ')} from ${change.dir}`)
  console.log('Restart DSH. The Bot team reads the chats written before the upgrade from the same DSH home.')
  return broken.length > 0 ? 2 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv))
}
