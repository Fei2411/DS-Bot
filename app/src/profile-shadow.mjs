// A bundle or official DSH package installed into the profile's own node_modules shadows the
// copy that ships with the app: DSH's profile resolver prefers profile-local packages over the
// installation layer, so the running plugin stays pinned at an older version and DSH disables
// incompatible rows (such as tool-subagent after an app upgrade, #1305). Detect those copies
// and, when the user agrees, take them out — both the package directory and any manifest row.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const OFFICIAL_DSH = /^@deepseek-ai\/dsh(?:-|$)/
const MANIFEST_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const DEFAULT_MAX_DISPLAYED_NAMES = 3

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const declaredSpec = (manifest, name) => {
  for (const field of MANIFEST_DEP_FIELDS) {
    const value = manifest?.[field]?.[name]
    if (typeof value === 'string') return value
  }
  return undefined
}

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
 * Walk the app's installation dependency graph from `installAnchor` (app/package.json) and
 * collect every installed official `@deepseek-ai/dsh*` package with its bundled version.
 * Used to detect stale profile-local copies that shadow the app's bundled runtime or plugins.
 */
export function bundledOfficialPackages(installAnchor) {
  const official = new Map()
  let rootManifest
  let rootAnchor
  try {
    rootAnchor = realpathSync(installAnchor)
    rootManifest = readJson(rootAnchor)
  } catch {
    return official
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
      if (OFFICIAL_DSH.test(dep) && typeof manifest?.version === 'string') {
        official.set(dep, manifest.version)
      }
      queue.push({ anchor: manifestPath, manifest })
    }
  }
  return official
}

const packageRoots = profileDir => [
  join(profileDir, 'node_modules'),
  join(profileDir, '.dsh-module-fallback', 'node_modules'),
]

const installedCopy = (profileDir, name, manifest) => {
  for (const root of packageRoots(profileDir)) {
    const file = join(root, name, 'package.json')
    if (!existsSync(file)) continue
    let pkgManifest
    let version = declaredSpec(manifest, name) ?? 'unknown'
    try {
      pkgManifest = readJson(file)
      if (typeof pkgManifest?.version === 'string' && pkgManifest.version !== '') version = pkgManifest.version
    } catch {}
    return { manifest: pkgManifest, version }
  }
  return undefined
}

const installedOfficialNames = (profileDir) => {
  const found = new Set()
  for (const root of packageRoots(profileDir)) {
    const scopeDir = join(root, '@deepseek-ai')
    if (!existsSync(scopeDir)) continue
    let entries
    try { entries = readdirSync(scopeDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const name = `@deepseek-ai/${entry.name}`
      if (!OFFICIAL_DSH.test(name)) continue
      if (existsSync(join(scopeDir, entry.name, 'package.json'))) found.add(name)
    }
  }
  return [...found].sort()
}

const isIncompatibleWithRuntime = (pkgManifest, runtimeVersion) => {
  if (pkgManifest === undefined || typeof runtimeVersion !== 'string' || runtimeVersion === '') return false
  try {
    return evaluatePluginCompatibility(pkgManifest, {}, runtimeVersion) !== undefined
  } catch {
    return true
  }
}

/**
 * Packages installed in the profile that shadow the app's bundled copies, as `{ name, version }`.
 * - Any `ownNames` (the app's bundles) or `retiredNames` (retired app bundles) present on disk
 *   under the profile's `node_modules` (or fallback dir) is always reported, regardless of version.
 * - Any official `@deepseek-ai/dsh*` package also shipped by the app (`bundledOfficial`) whose
 *   profile-local copy has a different version or is incompatible with `runtimeVersion` is reported
 *   even when it is hoisted without a row in `package.json`.
 */
export function shadowedBundles(profileDir, ownNames, { retiredNames = [], bundledOfficial, runtimeVersion } = {}) {
  let manifest
  try { manifest = readJson(join(profileDir, 'package.json')) } catch {}
  const officialMap = bundledOfficial instanceof Map
    ? bundledOfficial
    : (bundledOfficial && typeof bundledOfficial === 'object' ? new Map(Object.entries(bundledOfficial)) : undefined)

  const seen = new Set()
  const result = []
  const add = (name, version) => {
    if (seen.has(name)) return
    seen.add(name)
    result.push({ name, version })
  }

  for (const name of [...ownNames, ...retiredNames]) {
    const copy = installedCopy(profileDir, name, manifest)
    if (copy !== undefined) add(name, copy.version)
  }

  if (officialMap !== undefined && officialMap.size > 0) {
    const candidates = new Set(installedOfficialNames(profileDir))
    for (const field of MANIFEST_DEP_FIELDS) {
      for (const name of Object.keys(manifest?.[field] ?? {})) {
        if (OFFICIAL_DSH.test(name)) candidates.add(name)
      }
    }
    for (const name of [...candidates].sort()) {
      if (seen.has(name) || !officialMap.has(name)) continue
      const copy = installedCopy(profileDir, name, manifest)
      if (copy === undefined) continue
      const bundledVersion = officialMap.get(name)
      if (copy.version !== bundledVersion || isIncompatibleWithRuntime(copy.manifest, runtimeVersion)) {
        add(name, copy.version)
      }
    }
  }

  return result
}

/** Format shadowed package entries concisely for the startup card while keeping short lists intact. */
export function formatShadowedNames(shadowed, maxShown = DEFAULT_MAX_DISPLAYED_NAMES) {
  const labels = shadowed.map(({ name, version }) => `${name} ${version}`)
  if (labels.length <= maxShown) return labels.join(', ')
  return `${labels.slice(0, maxShown).join(', ')} (+${labels.length - maxShown})`
}

const fallbackDirs = (dir, name) => {
  const root = join(dir, '.dsh-module-fallback', 'node_modules')
  return existsSync(join(root, name)) ? [join(root, name)] : []
}

/**
 * Delete the profile's own copies of `names` and drop them from its manifest dependency sections.
 * The package directory goes first so a failure reaches the caller with that name's row still
 * intact and the copy is still detected on the next attempt. In the pnpm layout only the
 * profile's link goes: the store entry behind it can be linked from other packages, and the
 * package manager prunes it when nothing is left.
 */
export async function removeShadowed(profileDir, names) {
  const file = join(profileDir, 'package.json')
  for (const name of names) {
    for (const dir of [join(profileDir, 'node_modules', name), ...fallbackDirs(profileDir, name)]) {
      await rm(dir, { recursive: true, force: true })
    }
    if (!existsSync(file)) continue
    // Per name, so that a failure on a later one leaves no row behind for a package that is gone.
    const manifest = readJson(file)
    let changed = false
    for (const field of MANIFEST_DEP_FIELDS) {
      if (manifest?.[field] && Object.hasOwn(manifest[field], name)) {
        delete manifest[field][name]
        changed = true
      }
    }
    if (changed) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
