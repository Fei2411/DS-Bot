// A bundle of the app installed into the profile's own dependencies shadows the bundled one:
// the engine mounts the profile's copy, so the running plugin stays at the version it was
// installed at and no app update reaches it (#1305). Detect that copy and, when the user
// agrees, take it out — the dependency row and the package, in the plain and the pnpm layouts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const pnpmDirs = (dir, name) => {
  const store = join(dir, 'node_modules', '.pnpm')
  const flat = name.replace('/', '+')
  try {
    return readdirSync(store).filter(entry => entry === flat || entry.startsWith(`${flat}@`)).map(entry => join(store, entry))
  } catch { return [] }
}

const fallbackDirs = (dir, name) => {
  const root = join(dir, '.dsh-module-fallback', 'node_modules')
  return existsSync(join(root, name)) ? [join(root, name)] : []
}

/** Drop `names` from the profile's dependencies and delete their package copies. */
export async function removeShadowed(profileDir, names) {
  const file = join(profileDir, 'package.json')
  const manifest = readJson(file)
  for (const name of names) delete manifest.dependencies?.[name]
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of names) {
    const dirs = [join(profileDir, 'node_modules', name), ...pnpmDirs(profileDir, name), ...fallbackDirs(profileDir, name)]
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch((error) => { console.error(`DS Bot: removing the shadowing ${name} failed:`, error) })
  }
}
