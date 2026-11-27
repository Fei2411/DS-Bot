import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const REAL_SCANNER = join(REPO, 'scripts', 'scan.mjs')
const roots = []
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

// Assemble a synthetic GitHub-style token at runtime so no token-shaped literal appears in
// tracked source files, and avoid words in scan.mjs's PLACEHOLDER filter.
function syntheticToken() {
  return ['gh', 'p_'].join('') + '7K9mN2pQ4rS6tU8vW0xY1zA3bC5dE7fG9hJ1'
}

// Minimal valid repository tree accepted by scripts/scan.mjs's structural checks.
function writeMinimalRepo(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'ds-bot'), { recursive: true })
  copyFileSync(REAL_SCANNER, join(dir, 'scripts', 'scan.mjs'))
  writeFileSync(join(dir, 'LICENSE'), 'Apache-2.0\n')
  writeFileSync(join(dir, 'ds-bot', 'LICENSE'), 'Apache-2.0\n')
  writeFileSync(join(dir, 'ds-bot', 'package.json'), JSON.stringify({
    name: 'ds-bot',
    files: ['LICENSE'],
    repository: 'https://github.com/Fei-Craft/DS-Bot',
    homepage: 'https://github.com/Fei-Craft/DS-Bot',
    bugs: 'https://github.com/Fei-Craft/DS-Bot/issues',
  }, null, 2))
  for (const name of ['README.md', 'README.zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md', '.gitignore']) {
    writeFileSync(join(dir, name), name === '.gitignore' ? '.scan-extra\n' : `# ${name}\n`)
  }
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout
}

function initMinimalGitRepo() {
  const work = tempDir('ds-bot-scan-repo-')
  const repo = join(work, 'repo')
  const gitDir = join(work, 'repo.git')
  mkdirSync(repo, { recursive: true })
  // Separate git-dir keeps `.git/` out of `repo/` so scanning `repo` directly only sees
  // tracked/working files (just like a worktree).
  git(repo, ['init', '--separate-git-dir', gitDir])
  writeMinimalRepo(repo)
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=Scan Test', '-c', 'user.email=scan@example.test', 'commit', '-m', 'init'])
  return { work, repo }
}

function runScan(scannerPath, targetDir) {
  const outDir = tempDir('ds-bot-scan-out-')
  const jsonPath = join(outDir, 'findings.json')
  const res = spawnSync(process.execPath, [scannerPath, targetDir, '--json', jsonPath], {
    encoding: 'utf8',
    env: { ...process.env, SCAN_EXTRA_PATTERNS: '' },
  })
  const findings = JSON.parse(readFileSync(jsonPath, 'utf8'))
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, findings }
}

function mustFixIds(findings, file) {
  return findings.filter(f => f.level === 'must fix' && (file === undefined || f.file === file)).map(f => f.id)
}

function exportHead(repo, dest) {
  mkdirSync(dest, { recursive: true })
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: repo, maxBuffer: 20 * 1024 * 1024 })
  assert.equal(archive.status, 0, archive.stderr?.toString('utf8'))
  // Use `-xf -` with `cwd` rather than `-C <path>` so Windows tar never treats drive letters as remote hosts.
  const untar = spawnSync('tar', ['-xf', '-'], { cwd: dest, input: archive.stdout })
  assert.equal(untar.status, 0, untar.stderr?.toString('utf8'))
}

test('scan.mjs passes on a clean archive and allows an exact copy of the checkout untracked .scan-extra', () => {
  const { work, repo } = initMinimalGitRepo()
  const exported = join(work, 'clean-export')
  exportHead(repo, exported)

  const clean = runScan(join(repo, 'scripts', 'scan.mjs'), exported)
  assert.equal(clean.status, 0, clean.stdout)
  assert.deepEqual(mustFixIds(clean.findings), [])

  // Local clean-export workflow: untracked root .scan-extra copied verbatim into export.
  const localPattern = 'PrivateMarkerForScanTestOnly\n'
  writeFileSync(join(repo, '.scan-extra'), localPattern)
  writeFileSync(join(exported, '.scan-extra'), localPattern)
  const withCopy = runScan(join(repo, 'scripts', 'scan.mjs'), exported)
  assert.equal(withCopy.status, 0, withCopy.stdout)
  assert.deepEqual(mustFixIds(withCopy.findings), [])

  // Scanning the checkout root directly also accepts its own untracked root .scan-extra.
  const rootRes = runScan(join(repo, 'scripts', 'scan.mjs'), repo)
  assert.deepEqual(mustFixIds(rootRes.findings, '.scan-extra'), [])
})

test('scan.mjs fails closed on a rogue .scan-extra outside a checkout and scans its contents', () => {
  const { work, repo } = initMinimalGitRepo()
  const exported = join(work, 'rogue-outside')
  writeMinimalRepo(exported)
  writeFileSync(join(repo, '.scan-extra'), 'BenignLocalPattern\n')
  writeFileSync(join(exported, '.scan-extra'), `${syntheticToken()}\n`)

  const res = runScan(join(repo, 'scripts', 'scan.mjs'), exported)
  assert.equal(res.status, 1)
  const ids = mustFixIds(res.findings, '.scan-extra')
  assert.ok(ids.includes('forbidden-file'), `expected forbidden-file, got ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('secret-github'), `expected TEXT_RULES to scan rogue .scan-extra, got ${JSON.stringify(ids)}`)
})

test('scan.mjs fails closed on a committed .scan-extra exported into a nested checkout subdirectory', () => {
  const { repo } = initMinimalGitRepo()
  writeFileSync(join(repo, '.scan-extra'), `${syntheticToken()}\n`)
  git(repo, ['add', '-f', '.scan-extra'])
  git(repo, ['-c', 'user.name=Scan Test', '-c', 'user.email=scan@example.test', 'commit', '-m', 'commit forbidden scan-extra'])

  // Export HEAD into a subdirectory nested inside the checkout itself (e.g. build/tree).
  const nested = join(repo, 'build', 'tree')
  exportHead(repo, nested)

  // Scanning the nested export must NOT treat git ls-files on the subdirectory as authoritative.
  const nestedRes = runScan(join(repo, 'scripts', 'scan.mjs'), nested)
  assert.equal(nestedRes.status, 1)
  const nestedIds = mustFixIds(nestedRes.findings, '.scan-extra')
  assert.ok(nestedIds.includes('forbidden-file'), `expected forbidden-file, got ${JSON.stringify(nestedIds)}`)
  assert.ok(nestedIds.includes('secret-github'), `expected secret-github from committed .scan-extra, got ${JSON.stringify(nestedIds)}`)

  // Scanning the repo root directly must also catch the committed .scan-extra.
  const rootRes = runScan(join(repo, 'scripts', 'scan.mjs'), repo)
  assert.equal(rootRes.status, 1)
  const rootIds = mustFixIds(rootRes.findings, '.scan-extra')
  assert.ok(rootIds.includes('forbidden-file'), `expected forbidden-file at root, got ${JSON.stringify(rootIds)}`)
  assert.ok(rootIds.includes('secret-github'), `expected secret-github at root, got ${JSON.stringify(rootIds)}`)
})

test('scan.mjs fails closed on a rogue .scan-extra in a nested checkout subdirectory', () => {
  const { repo } = initMinimalGitRepo()
  // Enclosing checkout has a clean untracked .scan-extra (or none), while a nested
  // subdirectory holds an arbitrary rogue .scan-extra with a synthetic secret.
  writeFileSync(join(repo, '.scan-extra'), 'BenignLocalPattern\n')
  const nested = join(repo, 'build', 'nested-rogue')
  writeMinimalRepo(nested)
  writeFileSync(join(nested, '.scan-extra'), `${syntheticToken()}\n`)

  const res = runScan(join(repo, 'scripts', 'scan.mjs'), nested)
  assert.equal(res.status, 1)
  const ids = mustFixIds(res.findings, '.scan-extra')
  assert.ok(ids.includes('forbidden-file'), `expected forbidden-file, got ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('secret-github'), `expected secret-github from rogue nested .scan-extra, got ${JSON.stringify(ids)}`)

  // Also ensure a nested sub/.scan-extra inside an export is always forbidden and scanned.
  const withSub = join(repo, 'build', 'with-sub')
  writeMinimalRepo(withSub)
  mkdirSync(join(withSub, 'sub'), { recursive: true })
  writeFileSync(join(withSub, 'sub', '.scan-extra'), `${syntheticToken()}\n`)
  const subRes = runScan(join(repo, 'scripts', 'scan.mjs'), withSub)
  assert.equal(subRes.status, 1)
  const subIds = mustFixIds(subRes.findings, 'sub/.scan-extra')
  assert.ok(subIds.includes('forbidden-file'), `expected forbidden-file for sub/.scan-extra, got ${JSON.stringify(subIds)}`)
  assert.ok(subIds.includes('secret-github'), `expected secret-github for sub/.scan-extra, got ${JSON.stringify(subIds)}`)
})
