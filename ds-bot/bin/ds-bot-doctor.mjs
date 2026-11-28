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
//   npx ds-bot doctor --fix    remove stale pins that have a built-in replacement in the running DSH and reconcile each profile with pnpm
//
// A pin that the running DSH satisfies (an exact version, or a range such as
// ^0.2.2-rc.2) is kept. Only official packages confirmed to have a built-in replacement
// in the running DSH installation (or known retired bundles) are auto-removed by --fix;
// profile-only official packages (such as native Computer Use drivers not shipped by DSH)
// are reported separately so the user can upgrade them instead of losing their only copy.
// Sessions, settings, credentials and dsh.profile.bundles are not touched, so the chats
// written before the upgrade stay readable.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'
import { findExecutable, launchOf } from '../src/host/local-agents/discover.js'

const run = (file, args, options) => {
  const launch = launchOf(findExecutable(file) ?? file, args)
  return spawnSync(launch.file, launch.args, { ...options, ...launch.options })
}

const OFFICIAL = /^@deepseek-ai\/dsh(?:-|$)/
// Pure client UI libraries and protocol/utility packages that third-party plugins may pin
// as library dependencies without providing DSH host/agent plugins.
const CLIENT_UI = /^@deepseek-ai\/dsh-(?:experimental-)?client-ui-/
const UTIL_LIB = /^@deepseek-ai\/dsh-util-/
const NON_PLUGIN_LIBS = new Set([
  'dsh-atomic-write', 'dsh-chunked-list', 'dsh-client-locale', 'dsh-client-resources',
  'dsh-client-shortcuts', 'dsh-client-store', 'dsh-cmdline', 'dsh-deque', 'dsh-error',
  'dsh-home-paths', 'dsh-hook-protocol', 'dsh-official-bundles', 'dsh-package-manifest',
  'dsh-sdk-protocol', 'dsh-typert-protocol',
].map(name => `@deepseek-ai/${name}`))

// Retired official bundles that an earlier DSH release shipped and the installation no longer carries.
export const KNOWN_RETIRED_BUNDLES = new Set([
  '@deepseek-ai/dsh-experimental-schedule-bundle',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
])

// Fallback allowlist of always-bundled core DSH runtime, bundle, and built-in plugin packages
// used only when the running DSH installation cannot be located on disk (for example when
// `--dsh-version` is passed offline without `dsh` in PATH). Profile-only / platform-specific
// packages (such as native Computer Use drivers or on-demand subagent bundles) are never listed here.
const KNOWN_BUNDLED = new Set([
  'dsh', 'dsh-acp', 'dsh-acp-app', 'dsh-action-cards', 'dsh-agent', 'dsh-agent-default-model',
  'dsh-agent-instructions', 'dsh-agent-loop', 'dsh-agent-preset', 'dsh-agent-preset-registry',
  'dsh-agent-team', 'dsh-agent-tool-presentation', 'dsh-api-gateway', 'dsh-api-job-controller',
  'dsh-api-remote-access', 'dsh-api-remotes', 'dsh-api-session-controller',
  'dsh-api-settings-controller', 'dsh-api-terminal-controller', 'dsh-api-workspace-controller',
  'dsh-api-workspace-files', 'dsh-app-boot', 'dsh-attachment', 'dsh-attachment-local',
  'dsh-authorization', 'dsh-base', 'dsh-bash-local', 'dsh-bash-sandbox', 'dsh-client-connection',
  'dsh-command-compact', 'dsh-command-goal', 'dsh-compaction-basic',
  'dsh-compaction-tool-result-pruner', 'dsh-cordis-client-runner', 'dsh-cordis-host-runner',
  'dsh-fs-local', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-harness-dev-context', 'dsh-headless',
  'dsh-hmr', 'dsh-host-frontend-static', 'dsh-host-plugin-inventory', 'dsh-host-webserver',
  'dsh-jobs-local', 'dsh-llm', 'dsh-mcp-client', 'dsh-persona', 'dsh-plan-mode',
  'dsh-plugin-manager', 'dsh-schedule', 'dsh-scope', 'dsh-sdk-app', 'dsh-sdk-minimal',
  'dsh-session', 'dsh-shell-env', 'dsh-subagent', 'dsh-subagent-fork-in-process',
  'dsh-subagent-spawn-in-process', 'dsh-tool-cordis', 'dsh-tool-schedule', 'dsh-tool-subagent',
  'dsh-tool-subagent-control', 'dsh-tool-todo', 'dsh-tool-web', 'dsh-tools', 'dsh-typert-registry',
  'dsh-web', 'dsh-web-app', 'dsh-web-deepseek-api', 'dsh-web-fetch-http', 'dsh-web-frontend',
  'dsh-web-search-deepseek', 'dsh-workflow', 'dsh-workflow-ptc', 'dsh-working-directory',
  'dsh-workspace', 'dsh-workspace-changes',
].map(name => `@deepseek-ai/${name}`))

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const packageDirFromAnchor = (anchorPath, name) => {
  let dir = dirname(anchorPath)
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Walk a DSH installation's dependency graph from its `package.json` (`installAnchor`) and
 * collect every installed official `@deepseek-ai/dsh*` package present in that installation.
 * Returns `undefined` when `installAnchor` cannot be read.
 */
export function bundledDshPackages(installAnchor) {
  let rootAnchor
  let rootManifest
  try {
    rootAnchor = realpathSync(installAnchor)
    rootManifest = readJson(rootAnchor)
  } catch {
    return undefined
  }
  const official = new Set()
  if (typeof rootManifest?.name === 'string' && OFFICIAL.test(rootManifest.name)) {
    official.add(rootManifest.name)
  }
  const visited = new Set()
  const queue = [{ anchor: rootAnchor, manifest: rootManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const deps = new Set([
      ...Object.keys(next.manifest?.dependencies ?? {}),
      ...Object.keys(next.manifest?.optionalDependencies ?? {}),
      ...Object.keys(next.manifest?.peerDependencies ?? {}),
    ])
    for (const dep of deps) {
      if (visited.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      if (dir === undefined) continue
      visited.add(dep)
      let manifestPath
      let manifest
      try {
        manifestPath = join(realpathSync(dir), 'package.json')
        manifest = readJson(manifestPath)
      } catch {
        continue
      }
      if (OFFICIAL.test(dep)) official.add(dep)
      queue.push({ anchor: manifestPath, manifest })
    }
  }
  return official
}

function resolveInstallAnchorCandidate(candidate) {
  if (!candidate) return undefined
  try {
    const stat = statSync(candidate)
    if (stat.isFile()) return candidate
  } catch {
    return undefined
  }
  for (const rel of ['package.json', join('node_modules', '@deepseek-ai', 'dsh', 'package.json'), join('apps', 'cli', 'package.json')]) {
    const file = join(candidate, rel)
    if (existsSync(file)) return file
  }
  return undefined
}

function walkUpToDshPackage(startPath) {
  let dir = dirname(startPath)
  while (true) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        const pkg = readJson(file)
        if (pkg?.name === '@deepseek-ai/dsh') return file
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Locate the running `@deepseek-ai/dsh` installation's `package.json` from an explicit
 * `dshInstall` path, `DSH_HARNESS`, or the `dsh` executable in PATH. Auto-discovered
 * installations are accepted only when their version matches `dshVersion` (if provided).
 */
export function findDshInstallAnchor({ bin = process.env.DSH_BIN ?? 'dsh', dshInstall, dshVersion } = {}) {
  if (dshInstall !== undefined) return resolveInstallAnchorCandidate(dshInstall)
  const checkVersion = (anchor) => {
    if (anchor === undefined) return undefined
    if (dshVersion === undefined) return anchor
    try {
      const pkg = readJson(anchor)
      return pkg?.version === dshVersion ? anchor : undefined
    } catch {
      return undefined
    }
  }
  if (process.env.DSH_HARNESS) {
    const fromHarness = checkVersion(resolveInstallAnchorCandidate(process.env.DSH_HARNESS))
    if (fromHarness !== undefined) return fromHarness
  }
  const found = findExecutable(bin)
  if (!found) return undefined
  try {
    const real = realpathSync(found)
    const direct = checkVersion(walkUpToDshPackage(real))
    if (direct !== undefined) return direct
    // Windows npm/pnpm shims (.cmd/.ps1) live beside node_modules/@deepseek-ai/dsh or point to it.
    const sibling = checkVersion(join(dirname(real), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    if (sibling !== undefined) return sibling
    if (/\.(?:cmd|bat|ps1)$/iu.test(real)) {
      const shim = readFileSync(real, 'utf8')
      const match = /([^\s"'`]*@deepseek-ai[\\/]+dsh)[\\/]+/iu.exec(shim)
      if (match) {
        const target = checkVersion(join(resolve(dirname(real), match[1].replace(/^%dp0%[\\/]?/iu, '')), 'package.json'))
        if (target !== undefined) return target
      }
    }
  } catch {}
  return undefined
}

const normalizePackageSet = (value) => {
  if (value === undefined) return undefined
  if (value instanceof Map) return new Set(value.keys())
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value)
  if (typeof value === 'object' && value !== null) return new Set(Object.keys(value))
  return undefined
}

/** Profile directories under a DSH home that carry a manifest. */
export function profileDirs(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(profiles, entry.name, 'package.json')))
    .map(entry => join(profiles, entry.name))
    .sort()
}

const inPluginScope = (name, bundles) => bundles.has(name) || (!CLIENT_UI.test(name) && !UTIL_LIB.test(name) && !NON_PLUGIN_LIBS.has(name))

const hasBuiltInReplacement = (name, bundledPackages, retiredBundles) => retiredBundles.has(name)
  || (bundledPackages !== undefined ? bundledPackages.has(name) : KNOWN_BUNDLED.has(name))

/**
 * Inspect every dependency section (`dependencies`, `optionalDependencies`, `peerDependencies`)
 * for official `@deepseek-ai/dsh*` packages pinned at a version the running DSH does not satisfy.
 *
 * Returns `{ stale, profileOnly }`:
 * - `stale`: declarations for packages confirmed to have a built-in replacement in the running
 *   DSH installation (or known retired bundles). Safe to auto-remove with `--fix`. Every stale
 *   declaration across every dependency section is included while compatible declarations stay intact.
 * - `profileOnly`: declarations for official DSH packages with no built-in replacement in the
 *   running DSH (e.g. native Computer Use drivers or on-demand bundles). Never auto-deleted;
 *   reported separately so the user can upgrade them instead of losing their only copy.
 */
export function classifyStalePins(manifest, dshVersion, { bundledPackages, retiredBundles = KNOWN_RETIRED_BUNDLES } = {}) {
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  const bundled = normalizePackageSet(bundledPackages)
  const retired = normalizePackageSet(retiredBundles) ?? KNOWN_RETIRED_BUNDLES
  const stale = []
  const profileOnly = []
  for (const field of DEP_FIELDS) {
    const section = typeof manifest?.[field] === 'object' && manifest[field] !== null ? manifest[field] : {}
    for (const [name, spec] of Object.entries(section)) {
      if (!OFFICIAL.test(name) || typeof spec !== 'string') continue
      if (!inPluginScope(name, bundles)) continue
      if (semver.validRange(spec) === null) continue
      if (!semver.satisfies(dshVersion, spec, { includePrerelease: true })) {
        const pin = { name, spec, inBundles: bundles.has(name), ...(field === 'dependencies' ? {} : { field }) }
        if (hasBuiltInReplacement(name, bundled, retired)) stale.push(pin)
        else profileOnly.push(pin)
      }
    }
  }
  return { stale, profileOnly }
}

/**
 * Official runtime/bundle/plugin packages a manifest pins at a version the running DSH does
 * not satisfy AND that have a built-in replacement (or are retired bundles) so they are safe
 * to remove. A spec the running version satisfies is kept even when written as a range;
 * a tag, `file:` or `workspace:` spec is not a version and is kept too.
 */
export function stalePins(manifest, dshVersion, options = {}) {
  return classifyStalePins(manifest, dshVersion, options).stale
}

function scanInstalledOfficial(dir, manifest, dshVersion, pinnedNames = new Set(), { bundledPackages, retiredBundles = KNOWN_RETIRED_BUNDLES } = {}) {
  const scopeDir = join(dir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) return { hoisted: [], profileOnlyInstalled: [] }
  const bundles = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  const bundled = normalizePackageSet(bundledPackages)
  const retired = normalizePackageSet(retiredBundles) ?? KNOWN_RETIRED_BUNDLES
  let entries
  try { entries = readdirSync(scopeDir, { withFileTypes: true }) } catch { return { hoisted: [], profileOnlyInstalled: [] } }
  const hoisted = []
  const profileOnlyInstalled = []
  for (const entry of entries) {
    const name = `@deepseek-ai/${entry.name}`
    if (pinnedNames.has(name) || !OFFICIAL.test(name) || !inPluginScope(name, bundles)) continue
    const pkgPath = join(scopeDir, entry.name, 'package.json')
    if (!existsSync(pkgPath)) continue
    let version
    try { version = JSON.parse(readFileSync(pkgPath, 'utf8'))?.version } catch { continue }
    if (typeof version !== 'string' || semver.valid(version) === null) continue
    if (!semver.satisfies(dshVersion, version, { includePrerelease: true })) {
      const record = { name, version, inBundles: bundles.has(name) }
      if (hasBuiltInReplacement(name, bundled, retired)) hoisted.push(record)
      else profileOnlyInstalled.push({ name, spec: version, inBundles: bundles.has(name), hoisted: true })
    }
  }
  return {
    hoisted: hoisted.sort((a, b) => a.name.localeCompare(b.name)),
    profileOnlyInstalled: profileOnlyInstalled.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * Official DSH plugin/runtime packages installed under the profile's `node_modules/@deepseek-ai/`
 * at a version the running DSH does not satisfy that shadow a built-in package in the running DSH,
 * even when not pinned in `package.json` (for example hoisted by another plugin or left behind).
 */
export function staleInstalled(dir, manifest, dshVersion, pinnedNames = new Set(), options = {}) {
  return scanInstalledOfficial(dir, manifest, dshVersion, pinnedNames, options).hoisted
}

/** What a repair run would do, without writing anything. */
export function planRepair({ home, dshVersion, bundledPackages, retiredBundles, dshInstall }) {
  let resolvedBundled = normalizePackageSet(bundledPackages)
  if (resolvedBundled === undefined) {
    const anchor = findDshInstallAnchor({ dshInstall, dshVersion })
    if (anchor !== undefined) resolvedBundled = bundledDshPackages(anchor)
  }
  const scope = { bundledPackages: resolvedBundled, ...(retiredBundles === undefined ? {} : { retiredBundles }) }
  return profileDirs(home).map(dir => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      return { dir, error: error?.message ?? String(error), stale: [], profileOnly: [], hoisted: [] }
    }
    const { stale, profileOnly } = classifyStalePins(manifest, dshVersion, scope)
    const pinnedNames = new Set([...stale.map(pin => pin.name), ...profileOnly.map(pin => pin.name)])
    const { hoisted, profileOnlyInstalled } = scanInstalledOfficial(dir, manifest, dshVersion, pinnedNames, scope)
    return { dir, manifest, stale, profileOnly: [...profileOnly, ...profileOnlyInstalled], hoisted }
  })
}

/**
 * Remove only the confirmed-bundled stale pins (never profile-only packages) and reconcile
 * each changed profile's installed tree, so a restart uses the running DSH's own modules
 * without a separate manual install. Returns what changed, whether the reconcile worked,
 * and the command to run by hand when it did not.
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
    const removed = entry.stale.map(pin => (pin.field ? `${pin.name}@${pin.spec} (${pin.field})` : `${pin.name}@${pin.spec}`))
    changed.push({ dir: entry.dir, removed, installed, command, ...(failure === undefined ? {} : { failure }) })
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
    console.error('usage: npx ds-bot doctor [--fix] [--home <DSH_HOME>] [--dsh-version <version>] [--dsh-install <path>]')
    return 2
  }
  const fix = args.includes('--fix')
  const homeArg = args.indexOf('--home')
  const versionArg = args.indexOf('--dsh-version')
  const installArg = args.indexOf('--dsh-install')
  if ((homeArg >= 0 && args[homeArg + 1] === undefined)
    || (versionArg >= 0 && args[versionArg + 1] === undefined)
    || (installArg >= 0 && args[installArg + 1] === undefined)) {
    console.error('ds-bot doctor: --home, --dsh-version and --dsh-install need a value.')
    return 2
  }
  const home = homeArg >= 0 ? args[homeArg + 1] : (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const dshVersion = versionArg >= 0 ? args[versionArg + 1] : runningVersion()
  const dshInstall = installArg >= 0 ? args[installArg + 1] : undefined
  if (dshVersion === undefined || semver.valid(dshVersion) === null) {
    console.error('ds-bot doctor: cannot read the DSH version. Pass --dsh-version <version>.')
    return 2
  }
  const plan = planRepair({ home, dshVersion, dshInstall })
  const broken = plan.filter(entry => entry.error !== undefined)
  for (const entry of broken) console.error(`ds-bot doctor: cannot read ${entry.dir}/package.json: ${entry.error}`)
  const found = plan.filter(entry => entry.stale.length > 0)
  const profileOnlyEntries = plan.filter(entry => entry.profileOnly.length > 0)
  const hoistedEntries = plan.filter(entry => entry.hoisted.length > 0)
  for (const entry of plan.filter(entry => entry.stale.length > 0 || entry.profileOnly.length > 0 || entry.hoisted.length > 0)) {
    console.log(`${entry.dir}:`)
    for (const pin of entry.stale) {
      const section = pin.field ? ` (${pin.field})` : ''
      const where = pin.inBundles ? ' (also in dsh.profile.bundles)' : ''
      console.log(`  ${pin.name}@${pin.spec}${section}${where} — running DSH is ${dshVersion}`)
    }
    for (const pin of entry.profileOnly) {
      const section = pin.hoisted ? 'hoisted in node_modules; ' : (pin.field ? `${pin.field}; ` : '')
      console.log(`  ${pin.name}@${pin.spec} (${section}profile-only, not bundled in running DSH) — running DSH is ${dshVersion}`)
    }
    for (const copy of entry.hoisted) {
      console.log(`  ${copy.name}@${copy.version} (hoisted in node_modules) — running DSH is ${dshVersion}`)
    }
  }
  if (found.length === 0 && profileOnlyEntries.length === 0 && hoistedEntries.length === 0) {
    console.log(`ds-bot doctor: no profile pins an official DSH package at a version the running DSH does not satisfy (${dshVersion}).`)
    console.log('If DSH still does not start, another plugin\'s dependencies may have hoisted an older copy of a DSH package into the profile. Find it there with: pnpm why @deepseek-ai/<package>')
    return broken.length > 0 ? 2 : 0
  }
  if (found.length === 0) {
    if (profileOnlyEntries.length > 0) {
      console.log('\nProfile-only official packages are not bundled by the running DSH, so --fix will not delete them.')
      console.log(`Upgrade them inside the profile directory (for example \`pnpm add <package>@${dshVersion}\`) instead of removing your only copy.`)
    }
    if (hoistedEntries.length > 0) {
      console.log('\nThese hoisted copies are not pinned in package.json (they were hoisted by another plugin or left from an earlier install).')
      console.log('Inspect what brings each one in with `pnpm why <package>` inside the profile directory before removing it.')
    }
    return broken.length > 0 ? 2 : 1
  }
  if (!fix) {
    console.log('\nRe-run with --fix to remove stale pins shadowed over the running DSH. Sessions, settings and credentials are not touched.')
    if (profileOnlyEntries.length > 0) {
      console.log(`Profile-only packages listed above are kept by --fix; upgrade them instead (for example \`pnpm add <package>@${dshVersion}\`).`)
    }
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
  const anchor = findDshInstallAnchor({ dshInstall, dshVersion })
  const bundledPackages = anchor !== undefined ? bundledDshPackages(anchor) : undefined
  const remainingHoisted = plan.flatMap(entry => (entry.error !== undefined ? [] : staleInstalled(entry.dir, entry.manifest, dshVersion, new Set(entry.profileOnly.map(p => p.name)), { bundledPackages }).map(copy => ({ dir: entry.dir, copy }))))
  if (profileOnlyEntries.length > 0) {
    console.log('Profile-only official packages were kept because the running DSH does not bundle replacements:')
    for (const entry of profileOnlyEntries) {
      for (const pin of entry.profileOnly) {
        console.log(`  ${entry.dir}: ${pin.name}@${pin.spec} — upgrade with \`pnpm add ${pin.name}@${dshVersion}\``)
      }
    }
  }
  if (remainingHoisted.length > 0) {
    console.log('Some hoisted official DSH copies still remain in node_modules:')
    for (const { dir, copy } of remainingHoisted) {
      console.log(`  ${dir}: ${copy.name}@${copy.version} — check with \`pnpm why ${copy.name}\``)
    }
  }
  console.log('Restart DSH. The Bot team reads the chats written before the upgrade from the same DSH home.')
  return broken.length > 0 ? 2 : ((remainingHoisted.length > 0 || profileOnlyEntries.length > 0) ? 1 : 0)
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
