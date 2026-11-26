// Resolve the DSH test harness lock against the same dependency versions the desktop
// app ships where both locks contain the package. Usage:
//   node scripts/update-harness-lock.mjs [dsh-version]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const repo = join(root, '..')
const harnessDir = join(root, 'dev', 'harness')
const packageFile = join(harnessDir, 'package.json')
const lockFile = join(harnessDir, 'package-lock.json')
const appLockFile = join(repo, 'app', 'package-lock.json')
const version = process.argv[2]

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function versionsByName(lock) {
  const out = new Map()
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/')) continue
    const parts = path.split('node_modules/').at(-1).split('/')
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!out.has(name)) out.set(name, new Set())
    out.get(name).add(meta.version)
  }
  return out
}

function npm(args) {
  const result = spawnSync('npm', ['install', '--prefix', harnessDir, '--legacy-peer-deps=false', '--package-lock-only', '--ignore-scripts', '--no-fund', '--no-audit', ...args], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function compare() {
  const app = versionsByName(readJson(appLockFile))
  const harness = versionsByName(readJson(lockFile))
  const missing = []
  const multi = []
  let overlap = 0
  let same = 0
  for (const [name, harnessVersions] of harness) {
    const appVersions = app.get(name)
    if (appVersions === undefined) continue
    overlap += 1
    if ([...harnessVersions].some(one => appVersions.has(one))) same += 1
    else if (appVersions.size === 1) missing.push(name)
    else multi.push(name)
  }
  return { app, harness, missing, multi, overlap, same }
}

const pkg = readJson(packageFile)
if (version !== undefined) {
  pkg.dependencies['@deepseek-ai/dsh'] = version
  pkg.dependencies['@deepseek-ai/dsh-agent-loop-testkit'] = version
}
delete pkg.overrides
writeJson(packageFile, pkg)

// First resolve the dependency graph of the requested DSH release, then pin every
// shared package that the app lock has at one unambiguous version. The second resolve
// writes those choices into the lock; the overrides themselves stay out of package.json,
// because they describe today's app lock, not a requirement of the harness.
npm([])
const first = compare()
if (first.missing.length > 0) {
  pkg.overrides = Object.fromEntries(first.missing.map(name => [name, [...first.app.get(name)][0]]))
  writeJson(packageFile, pkg)
  npm([])
  delete pkg.overrides
  writeJson(packageFile, pkg)
}

const final = compare()
if (final.missing.length > 0) {
  console.error(`harness lock could not align these packages with app/package-lock.json: ${final.missing.join(', ')}`)
  process.exit(1)
}
console.log(`harness lock: ${final.same}/${final.overlap} shared packages match the desktop app lock${final.multi.length > 0 ? ` (${final.multi.length} names have several app versions and are left to npm)` : ''}`)
