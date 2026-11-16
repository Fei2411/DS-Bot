// A bundle of the app installed into the profile's own dependencies shadows the bundled one:
// the engine mounts the profile's copy, so the running plugin stays at the version it was
// installed at and no app update reaches it (#1305). Detect that copy and, when the user
// agrees, take it out — the package and the dependency row.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

// The names of the app's own bundles that are in the profile's dependencies with a package on
// disk, as {name, version} (version from the shadowing copy). Bundles resolved from the
// installation are never shadowed, so a missing package dir means no shadow either.
export function shadowedBundles(profileDir, ownNames) {
  let manifest
  try { manifest = readJson(join(profileDir, 'package.json')) } catch { return [] }
  return Object.keys(manifest?.dependencies ?? {}).filter(name => ownNames.includes(name)
    && existsSync(join(profileDir, 'node_modules', name, 'package.json'))).map((name) => {
    let version = manifest.dependencies[name]
    try { version = readJson(join(profileDir, 'node_modules', name, 'package.json')).version ?? version } catch {}
    return { name, version }
  })
}

const fallbackDirs = (dir, name) => {
  const root = join(dir, '.dsh-module-fallback', 'node_modules')
  return existsSync(join(root, name)) ? [join(root, name)] : []
}

/**
 * Delete the profile's own copies of `names` and drop them from its dependencies. The package goes
 * first and a failure reaches the caller with that name's row still in the manifest, so that the copy is
 * still found on the next try. In the pnpm layout only the profile's link goes: the store entry behind it
 * can be linked from other packages, and the package manager prunes it when nothing is left.
 */
export async function removeShadowed(profileDir, names) {
  const file = join(profileDir, 'package.json')
  for (const name of names) {
    for (const dir of [join(profileDir, 'node_modules', name), ...fallbackDirs(profileDir, name)]) await rm(dir, { recursive: true, force: true })
    // Per name, so that a failure on a later one leaves no row behind for a package that is gone.
    const manifest = readJson(file)
    delete manifest.dependencies?.[name]
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
