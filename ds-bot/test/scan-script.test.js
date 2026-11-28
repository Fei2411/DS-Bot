import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function runScan(scannerPath, targetDir, extraEnv = {}) {
  const outDir = tempDir('ds-bot-scan-out-')
  const jsonPath = join(outDir, 'findings.json')
  const res = spawnSync(process.execPath, [scannerPath, targetDir, '--json', jsonPath], {
    encoding: 'utf8',
    env: { ...process.env, SCAN_EXTRA_PATTERNS: '', ...extraEnv },
  })
  const findings = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : []
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

test('scan.mjs redacts extra-pattern matches across all rules and staged .scan-extra in stdout and JSON reports', () => {
  const { repo } = initMinimalGitRepo()
  const marker = 'PrivateScanMarkerAlpha99'
  const shortMarker = 'Xy9zK'
  const placeholderWordMarker = 'PrivateTestMockMarker88'
  const boundaryMarker = 'BoundaryMarkerZ77Q'
  const privateEmail = ['priv99acct', 'gmail.com'].join('@')
  const privatePath = ['', 'Users', 'privacct99', 'work'].join('/')
  const draftTag = ['DRAFT', 'for'].join(' ')
  const scanExtraBody = [
    marker,
    shortMarker,
    placeholderWordMarker,
    boundaryMarker,
    privateEmail,
    privatePath,
  ].join('\n') + '\n'
  writeFileSync(join(repo, '.scan-extra'), scanExtraBody)
  // Include cross-rule same-line triggers (draft-marker next to markers, plus a marker straddling the +40 snippet edge).
  writeFileSync(join(repo, 'notes.txt'), [
    `${draftTag} ${marker} and ${shortMarker} and ${placeholderWordMarker}`,
    `${draftTag} ${'a'.repeat(35)}${boundaryMarker}`,
  ].join('\n') + '\n')

  const assertNoPrivateLeak = (res, context) => {
    const combined = `${res.stdout}\n${JSON.stringify(res.findings)}`
    for (const sensitive of [marker, shortMarker, placeholderWordMarker, boundaryMarker, 'BoundaryMarker', privateEmail, privatePath, 'privacct99']) {
      assert.ok(!combined.includes(sensitive), `${context}: report must never echo "${sensitive}"`)
    }
  }

  // 1. Untracked .scan-extra + leaking file: catches extra-pattern (including short & placeholder-word markers)
  //    and cross-rule draft-marker, while redacting every marker from both stdout and JSON.
  const leaked = runScan(join(repo, 'scripts', 'scan.mjs'), repo)
  assert.equal(leaked.status, 1)
  const noteFindings = leaked.findings.filter(f => f.level === 'must fix' && f.file === 'notes.txt')
  const noteIds = noteFindings.map(f => f.id)
  assert.ok(noteIds.includes('draft-marker'), `expected draft-marker on notes.txt, got ${JSON.stringify(noteIds)}`)
  assert.equal(noteIds.filter(id => id === 'extra-pattern').length, 4, `expected all 4 extra-pattern markers to match, got ${JSON.stringify(noteIds)}`)
  assert.ok(noteFindings.filter(f => f.id === 'extra-pattern').every(f => /^<redacted> \(\d+ chars\)$/.test(f.text)), 'extra-pattern findings must use redacted format')
  assert.ok(noteFindings.filter(f => f.id === 'draft-marker').every(f => f.text.includes('<redacted>')), 'cross-rule snippets must redact neighboring extra-pattern markers')
  assertNoPrivateLeak(leaked, 'notes.txt cross-rule leak')

  // 2. Staged .scan-extra: flagged as forbidden-file + extra-pattern + personal-email/path, and still prints zero private text.
  rmSync(join(repo, 'notes.txt'))
  git(repo, ['add', '-f', '.scan-extra'])
  const staged = runScan(join(repo, 'scripts', 'scan.mjs'), repo)
  assert.equal(staged.status, 1)
  const extraIds = mustFixIds(staged.findings, '.scan-extra')
  assert.ok(extraIds.includes('forbidden-file'), `expected forbidden-file on staged .scan-extra, got ${JSON.stringify(extraIds)}`)
  assert.ok(extraIds.includes('extra-pattern'), `expected extra-pattern on staged .scan-extra, got ${JSON.stringify(extraIds)}`)
  assert.ok(extraIds.includes('personal-email'), `expected personal-email on staged .scan-extra, got ${JSON.stringify(extraIds)}`)
  assert.ok(extraIds.includes('personal-path'), `expected personal-path on staged .scan-extra, got ${JSON.stringify(extraIds)}`)
  assertNoPrivateLeak(staged, 'staged .scan-extra')
})

test('scan.mjs redacts secret prefixes overlapping extra markers, overlapping prefix/longer markers, and invalid regex errors without leaking patterns', () => {
  const { repo } = initMinimalGitRepo()
  const tok = syntheticToken()
  const secretPrefixMarker = tok.slice(0, 6)
  const shortPrefix = 'OverlapMark'
  const longerPrefix = 'OverlapMarkTail99'
  const draftTag = ['DRAFT', 'for'].join(' ')
  writeFileSync(join(repo, '.scan-extra'), [secretPrefixMarker, shortPrefix, longerPrefix].join('\n') + '\n')
  writeFileSync(join(repo, 'mixed.txt'), [
    `token = ${tok}`,
    `${draftTag} ${longerPrefix}`,
  ].join('\n') + '\n')

  const res = runScan(join(repo, 'scripts', 'scan.mjs'), repo)
  assert.equal(res.status, 1)
  const mixedFindings = res.findings.filter(f => f.level === 'must fix' && f.file === 'mixed.txt')
  const ghFindings = mixedFindings.filter(f => f.id === 'secret-github')
  assert.equal(ghFindings.length, 1)
  assert.equal(ghFindings[0].text, `<redacted> (${tok.length} chars)`)
  const draftFindings = mixedFindings.filter(f => f.id === 'draft-marker')
  assert.equal(draftFindings.length, 1)
  assert.ok(draftFindings[0].text.includes('<redacted>'))
  const combined = `${res.stdout}\n${res.stderr}\n${JSON.stringify(res.findings)}`
  for (const sensitive of [secretPrefixMarker, shortPrefix, longerPrefix, 'Tail99']) {
    assert.ok(!combined.includes(sensitive), `report must never echo "${sensitive}"`)
  }

  // Invalid regex in SCAN_EXTRA_PATTERNS must fail with exit code 2 without echoing valid markers or raw regex text.
  const secretBeforeBad = 'PrivateBeforeBrokenRegex77'
  const badRes = runScan(join(repo, 'scripts', 'scan.mjs'), repo, {
    SCAN_EXTRA_PATTERNS: `${secretBeforeBad}\n(unclosed-regex-marker-99\n`,
  })
  assert.equal(badRes.status, 2)
  assert.match(badRes.stderr, /invalid extra scan pattern in SCAN_EXTRA_PATTERNS \(line 2\)/)
  const badOut = `${badRes.stdout}\n${badRes.stderr}`
  assert.ok(!badOut.includes(secretBeforeBad), 'stderr must never leak valid markers alongside an invalid regex')
  assert.ok(!badOut.includes('unclosed-regex-marker-99'), 'stderr must never echo the invalid pattern text')

  // Zero-width lookahead extra patterns must still fail with exit code 1 and redact same-line findings.
  const { repo: zwRepo } = initMinimalGitRepo()
  const zwMarker = 'ZeroWidthMarker99'
  writeFileSync(join(zwRepo, 'only-zw.txt'), `clean line ${zwMarker}\n`)
  const zwOnly = runScan(join(zwRepo, 'scripts', 'scan.mjs'), zwRepo, {
    SCAN_EXTRA_PATTERNS: `(?=${zwMarker})\n`,
  })
  assert.equal(zwOnly.status, 1)
  const zwFindings = zwOnly.findings.filter(f => f.level === 'must fix' && f.file === 'only-zw.txt')
  assert.equal(zwFindings.length, 1)
  assert.equal(zwFindings[0].id, 'extra-pattern')
  assert.equal(zwFindings[0].text, '<redacted> (0 chars)')
  assert.ok(!`${zwOnly.stdout}\n${JSON.stringify(zwOnly.findings)}`.includes(zwMarker))

  writeFileSync(join(zwRepo, 'only-zw.txt'), `${draftTag} ${zwMarker}\n`)
  const zwMixed = runScan(join(zwRepo, 'scripts', 'scan.mjs'), zwRepo, {
    SCAN_EXTRA_PATTERNS: `(?=${zwMarker})\n`,
  })
  assert.equal(zwMixed.status, 1)
  assert.ok(!`${zwMixed.stdout}\n${JSON.stringify(zwMixed.findings)}`.includes(zwMarker))
})
