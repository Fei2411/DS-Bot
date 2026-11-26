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
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', harnessDir, '--legacy-peer-deps=false', '--package-lock-only', '--ignore-scripts', '--no-fund', '--no-audit', ...args], { stdio: 'inherit' })
  return result.status === 0
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

const direct = new Set(Object.keys(pkg.dependencies ?? {}))
const appPkg = readJson(join(repo, 'app', 'package.json'))
const sameDsh = appPkg.dependencies?.['@deepseek-ai/dsh'] === pkg.dependencies['@deepseek-ai/dsh']
// DSH-owned packages belong to the requested release. Pin them to the app only when the
// app is on that same release; forcing an older app pin onto a newer harness makes npm
// reject the direct dependency. Direct dependencies are never overridden.
const canPin = name => !direct.has(name) && (sameDsh || !name.startsWith('@deepseek-ai/'))

// First resolve the dependency graph of the requested DSH release, then pin every
// shared package that the app lock has at one unambiguous version. The second resolve
// writes those choices into the lock; the overrides themselves stay out of package.json,
// because they describe today's app lock, not a requirement of the harness.
if (!npm([])) process.exit(1)
const first = compare()
const pins = first.missing.filter(canPin)
if (pins.length > 0) {
  pkg.overrides = Object.fromEntries(pins.map(name => [name, [...first.app.get(name)][0]]))
  writeJson(packageFile, pkg)
  let ok = false
  try {
    ok = npm([])
  } finally {
    // A failed resolve must not leave today's app pins in the harness manifest.
    delete pkg.overrides
    writeJson(packageFile, pkg)
  }
  if (!ok) process.exit(1)
}

const final = compare()
const unaligned = final.missing.filter(canPin)
if (unaligned.length > 0) {
  console.error(`harness lock could not align these packages with app/package-lock.json: ${unaligned.join(', ')}`)
  process.exit(1)
}
console.log(`harness lock: ${final.same}/${final.overlap} shared packages match the desktop app lock${final.multi.length > 0 ? ` (${final.multi.length} names have several app versions and are left to npm)` : ''}`)
