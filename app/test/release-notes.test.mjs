import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { checksums, copyName, downloadBlock, formatSize, missingPackages, PACKAGES, packageName, parseExternalPackageSpec, withDownloads } from '../scripts/release-notes.mjs'

const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const names = version => PACKAGES.map(entry => packageName(version, entry))
const MB = 1024 ** 2

test('the packages carry the names electron-builder gives them, and copies drop the version', () => {
  assert.match(read('../electron-builder.yml'), /^artifactName: DS-Bot-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/mu)
  assert.deepEqual(names('0.2.3'), [
    'DS-Bot-0.2.3-win-x64.exe',
    'DS-Bot-0.2.3-mac-arm64.zip',
    'DS-Bot-0.2.3-mac-x64.zip',
    'DS-Bot-0.2.3-linux-x86_64.AppImage',
    'DS-Bot-0.2.3-linux-amd64.deb',
    'DS-Bot-0.2.3-android.apk',
  ])
  assert.deepEqual(PACKAGES.map(copyName), [
    'DS-Bot-win-x64.exe',
    'DS-Bot-mac-arm64.zip',
    'DS-Bot-mac-x64.zip',
    'DS-Bot-linux-x86_64.AppImage',
    'DS-Bot-linux-amd64.deb',
    'DS-Bot-android.apk',
  ])
})

test('sizes are whole megabytes, as GitHub shows them', () => {
  assert.equal(formatSize(222_174_558), '212 MB')
  assert.equal(formatSize(10), '1 MB')
})

test('the table lists Windows first, then macOS, Linux and Android, and says which files are not for download', () => {
  const sizes = Object.fromEntries(names('0.2.3').map((name, index) => [name, (index + 1) * 100 * MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const rows = block.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| System'))
  assert.equal(rows.length, 6)
  assert.match(rows[0], /^\| \*\*Windows 10\/11 \(64-bit \/ 64 位\)\*\*<br>Double-click to install \/ 双击安装 \| \[DS-Bot-0\.2\.3-win-x64\.exe\]\(https:\/\/github\.com\/Fei-Craft\/DS-Bot\/releases\/download\/v0\.2\.3\/DS-Bot-0\.2\.3-win-x64\.exe\) \| 100 MB \|$/u)
  assert.match(rows[1], /^\| macOS, Apple chip .*mac-arm64\.zip.*\| 200 MB \|$/u)
  assert.match(rows[2], /^\| macOS, Intel .*mac-x64\.zip.*\| 300 MB \|$/u)
  assert.match(rows[3], /^\| Linux, AppImage .*linux-x86_64\.AppImage.*\| 400 MB \|$/u)
  assert.match(rows[4], /^\| Linux, deb .*linux-amd64\.deb.*\| 500 MB \|$/u)
  assert.match(rows[5], /^\| Android \(phone app \/ 手机 App\) .*android\.apk.*\| 600 MB \|$/u)
  assert.match(block, /^## Download \/ 下载$/mu)
  assert.match(block, /The `\.blockmap`, `latest\*\.yml` and `ds-bot-\*\.tgz` files and the source code archives are for updates and the plugin/u)
  assert.match(block, /\[SHA256SUMS\.txt\]\(https:\/\/github\.com\/Fei-Craft\/DS-Bot\/releases\/download\/v0\.2\.3\/SHA256SUMS\.txt\)/u)
  assert.doesNotMatch(block, /Mirror/u)
})

test('a mirror comes before GitHub, and a fork links to its own releases', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes, repo: 'someone/DS-Bot', mirror: 'https://mirror.example/ds-bot/v0.2.3/' })
  assert.match(block, /\| DS-Bot-0\.2\.3-win-x64\.exe: \[Mirror \/ 国内镜像\]\(https:\/\/mirror\.example\/ds-bot\/v0\.2\.3\/DS-Bot-0\.2\.3-win-x64\.exe\) · \[GitHub\]\(https:\/\/github\.com\/someone\/DS-Bot\/releases\/download\/v0\.2\.3\/DS-Bot-0\.2\.3-win-x64\.exe\) \|/u)
  assert.doesNotMatch(block, /Fei-Craft/u)
})

test('SHA256SUMS.txt lists each present package under both of its names and omits absent packages without fabricating hashes', () => {
  const hashes = Object.fromEntries(names('0.2.3').map((name, index) => [name, String(index).repeat(64)]))
  const lines = checksums('0.2.3', hashes).split('\n')
  assert.equal(lines.pop(), '')
  assert.equal(lines.length, 12)
  assert.equal(lines[0], `${'0'.repeat(64)}  DS-Bot-0.2.3-win-x64.exe`)
  assert.equal(lines[1], `${'0'.repeat(64)}  DS-Bot-win-x64.exe`)
  assert.equal(lines[9], `${'4'.repeat(64)}  DS-Bot-linux-amd64.deb`)
  assert.equal(lines[11], `${'5'.repeat(64)}  DS-Bot-android.apk`)

  const partialHashes = { ...hashes }
  delete partialHashes['DS-Bot-0.2.3-android.apk']
  delete partialHashes['DS-Bot-0.2.3-mac-x64.zip']
  const partialSums = checksums('0.2.3', partialHashes)
  assert.doesNotMatch(partialSums, /android\.apk|mac-x64\.zip|undefined/u)
  assert.equal(partialSums.trim().split('\n').length, 8)
})

test('a missing package is named; optionalFiles excludes intentionally skipped or pending packages', () => {
  const present = ['DS-Bot-0.2.3-win-x64.exe', 'DS-Bot-0.2.3-win-x64.exe.blockmap', 'DS-Bot-mac-arm64.zip', 'DS-Bot-0.2.2-mac-x64.zip',
    'DS-Bot-0.2.3-linux-x86_64.AppImage', 'DS-Bot-0.2.3-linux-amd64.deb', 'latest.yml']
  assert.deepEqual(missingPackages('0.2.3', present), ['DS-Bot-0.2.3-mac-arm64.zip', 'DS-Bot-0.2.3-mac-x64.zip', 'DS-Bot-0.2.3-android.apk'])
  assert.deepEqual(
    missingPackages('0.2.3', present, { optionalFiles: ['mac-x64.zip', 'android.apk'] }),
    ['DS-Bot-0.2.3-mac-arm64.zip'],
  )
  assert.deepEqual(missingPackages('0.2.3', names('0.2.3')), [])
})

test('reused external Android APK points at its historical release and pending macOS x64 displays a building placeholder', () => {
  assert.deepEqual(parseExternalPackageSpec('android.apk=0.4.0:64000000'), {
    file: 'android.apk',
    version: '0.4.0',
    size: 64_000_000,
  })
  assert.throws(() => parseExternalPackageSpec('unknown.bin=0.4.0'), /Unknown package key/u)

  const sizes = {
    'DS-Bot-0.4.2-win-x64.exe': 120 * MB,
    'DS-Bot-0.4.2-mac-arm64.zip': 150 * MB,
    'DS-Bot-0.4.2-linux-x86_64.AppImage': 140 * MB,
    'DS-Bot-0.4.2-linux-amd64.deb': 130 * MB,
  }
  const block = downloadBlock({
    version: '0.4.2',
    sizes,
    externalPackages: { 'android.apk': { version: '0.4.0', size: 62 * MB } },
    pendingPackages: ['mac-x64.zip'],
  })
  assert.match(
    block,
    /\| macOS, Intel \| Building… \/ 构建中… \| — \|/u,
  )
  assert.match(
    block,
    /\| Android \(phone app \/ 手机 App\) \| \[DS-Bot-0\.4\.0-android\.apk\]\(https:\/\/github\.com\/Fei-Craft\/DS-Bot\/releases\/download\/v0\.4\.0\/DS-Bot-0\.4\.0-android\.apk\) \*\(unchanged since v0\.4\.0 \/ 同 v0\.4\.0\)\* \| 62 MB \|/u,
  )
})

test('the table goes on top of the notes, and a second run replaces it', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const once = withDownloads('## What changed\r\n\r\n- Fixed it\r\n', block)
  assert.ok(once.startsWith(`${block}\n\n## What changed`))
  assert.equal(withDownloads(once, block), once)
  const bigger = downloadBlock({ version: '0.2.3', sizes: Object.fromEntries(names('0.2.3').map(name => [name, 2 * MB])) })
  const again = withDownloads(once, bigger)
  assert.ok(again.startsWith(`${bigger}\n\n## What changed`))
  assert.equal(again.split('## Download / 下载').length, 2)
  assert.equal(withDownloads('', block), `${block}\n`)
})

test('the script hashes and copies the packages and prints the notes', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  const from = join(work, 'packages')
  const to = join(work, 'attach')
  mkdirSync(from)
  for (const name of names('0.2.3')) writeFileSync(join(from, name), `package ${name}`)
  writeFileSync(join(from, 'DS-Bot-0.2.3-win-x64.exe.blockmap'), 'map')
  writeFileSync(join(work, 'notes.md'), '- Fixed it\n')
  const env = { ...process.env, GITHUB_REPOSITORY: '', MIRROR_BASE: '' }
  const run = spawnSync(process.execPath, [script, '0.2.3', from, to, join(work, 'notes.md')], { encoding: 'utf8', env })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.startsWith('<!-- downloads -->\n## Download / 下载\n'))
  assert.ok(run.stdout.endsWith('<!-- /downloads -->\n\n- Fixed it\n'))
  assert.match(run.stdout, /\/Fei-Craft\/DS-Bot\/releases\/download\/v0\.2\.3\/DS-Bot-0\.2\.3-win-x64\.exe/u)
  assert.deepEqual(readdirSync(to).sort(), [...PACKAGES.map(copyName), 'SHA256SUMS.txt'].sort())
  const sums = readFileSync(join(to, 'SHA256SUMS.txt'), 'utf8')
  for (const entry of PACKAGES) {
    const name = packageName('0.2.3', entry)
    const hash = createHash('sha256').update(`package ${name}`).digest('hex')
    assert.ok(sums.includes(`${hash}  ${name}\n`) && sums.includes(`${hash}  ${copyName(entry)}\n`), name)
    assert.equal(readFileSync(join(to, copyName(entry)), 'utf8'), `package ${name}`)
  }
})

test('two-stage release manifest workflow: primary release skips Android + marks macOS x64 pending, then macOS x64 merges idempotently', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-merge-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  const primaryFrom = join(work, 'primary-packages')
  const primaryTo = join(work, 'primary-attach')
  const x64From = join(work, 'x64-packages')
  const x64To = join(work, 'x64-attach')
  const manifestPath = join(work, 'manifest', 'release-manifest.json')
  mkdirSync(primaryFrom)
  mkdirSync(x64From)

  for (const file of ['win-x64.exe', 'mac-arm64.zip', 'linux-x86_64.AppImage', 'linux-amd64.deb']) {
    writeFileSync(join(primaryFrom, `DS-Bot-0.4.2-${file}`), `primary ${file}`)
  }
  writeFileSync(join(work, 'notes.md'), '### Fixed\n\n- Hotfix item\n')
  const env = { ...process.env, GITHUB_REPOSITORY: '', MIRROR_BASE: '' }

  // Stage 1: primary downloads job with skipped Android APK (reused from 0.4.1) and pending mac-x64.zip.
  const stage1 = spawnSync(process.execPath, [
    script,
    '0.4.2',
    primaryFrom,
    primaryTo,
    join(work, 'notes.md'),
    '--pending', 'mac-x64.zip',
    '--external-package', 'android.apk=0.4.1:65000000',
    '--write-manifest', manifestPath,
  ], { encoding: 'utf8', env })
  assert.equal(stage1.status, 0, stage1.stderr)
  assert.match(stage1.stdout, /Building… \/ 构建中…/u)
  assert.match(stage1.stdout, /releases\/download\/v0\.4\.1\/DS-Bot-0\.4\.1-android\.apk/u)
  const stage1Sums = readFileSync(join(primaryTo, 'SHA256SUMS.txt'), 'utf8')
  assert.doesNotMatch(stage1Sums, /mac-x64\.zip|android\.apk/u)
  assert.match(stage1Sums, /DS-Bot-0\.4\.2-mac-arm64\.zip/u)

  // Stage 2: async macOS x64 finishes and merges into manifest + existing release body.
  writeFileSync(join(work, 'notes-after-stage1.md'), stage1.stdout)
  writeFileSync(join(x64From, 'DS-Bot-0.4.2-mac-x64.zip'), 'intel mac bundle')
  const stage2 = spawnSync(process.execPath, [
    script,
    '0.4.2',
    x64From,
    x64To,
    join(work, 'notes-after-stage1.md'),
    '--merge-manifest', manifestPath,
  ], { encoding: 'utf8', env })
  assert.equal(stage2.status, 0, stage2.stderr)
  assert.doesNotMatch(stage2.stdout, /Building…/u)
  assert.match(stage2.stdout, /releases\/download\/v0\.4\.2\/DS-Bot-0\.4\.2-mac-x64\.zip/u)
  assert.match(stage2.stdout, /releases\/download\/v0\.4\.1\/DS-Bot-0\.4\.1-android\.apk/u)
  assert.equal(stage2.stdout.split('## Download / 下载').length, 2, 'download table must be replaced idempotently')
  assert.ok(stage2.stdout.endsWith('### Fixed\n\n- Hotfix item\n'))

  // Re-running stage 2 produces byte-identical release notes.
  writeFileSync(join(work, 'notes-after-stage2.md'), stage2.stdout)
  const stage2Repeat = spawnSync(process.execPath, [
    script,
    '0.4.2',
    x64From,
    join(work, 'x64-attach-2'),
    join(work, 'notes-after-stage2.md'),
    '--merge-manifest', manifestPath,
  ], { encoding: 'utf8', env })
  assert.equal(stage2Repeat.status, 0, stage2Repeat.stderr)
  assert.equal(stage2Repeat.stdout, stage2.stdout)

  // Stage 2 SHA256SUMS.txt contains all 5 built desktop packages (including mac-x64) and still omits reused Android.
  const stage2Sums = readFileSync(join(x64To, 'SHA256SUMS.txt'), 'utf8')
  const x64Hash = createHash('sha256').update('intel mac bundle').digest('hex')
  assert.ok(stage2Sums.includes(`${x64Hash}  DS-Bot-0.4.2-mac-x64.zip\n`))
  assert.ok(stage2Sums.includes(`${x64Hash}  DS-Bot-mac-x64.zip\n`))
  assert.ok(stage2Sums.includes('DS-Bot-0.4.2-win-x64.exe\n'))
  assert.doesNotMatch(stage2Sums, /android\.apk/u)
})

test('the script stops when a package is missing, so the release is not marked Latest', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  for (const name of names('0.2.3').slice(1)) writeFileSync(join(work, name), name)
  const run = spawnSync(process.execPath, [script, '0.2.3', work, join(work, 'attach')], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /has no DS-Bot-0\.2\.3-win-x64\.exe$/mu)
})

// A releases/latest link must never reach a release before primary builds + npm publish finish,
// while macOS x64 runs asynchronously and refreshes checksums/notes after downloads succeeds.
test('release.yml marks Latest after primary builds + publish, decouples macOS x64 async upload, gates Milestone, and skips unchanged Android', () => {
  const workflow = YAML.parse(read('../../.github/workflows/release.yml'))
  const runs = job => (job.steps ?? []).map(step => step.run ?? '').join('\n')
  const latest = Object.entries(workflow.jobs).filter(([, job]) => /gh release edit "\$TAG" --latest/u.test(runs(job)))
  assert.equal(latest.length, 1)
  const [name, job] = latest[0]
  assert.equal(name, 'downloads')

  const before = (jobName, seen = new Set()) => {
    for (const need of [workflow.jobs[jobName].needs ?? []].flat()) if (!seen.has(need)) before(need, seen.add(need))
    return seen
  }

  // Primary producers must all finish before downloads marks Latest.
  for (const primary of ['validate', 'publish', 'app-windows', 'app-macos-arm64', 'app-linux', 'app-android']) {
    assert.ok(before(name).has(primary), `${name} must come after ${primary}`)
  }

  // Intel macOS x64 must NOT block Latest; it attaches via downloads-macos-x64 after downloads completes.
  assert.ok(!before(name).has('app-macos-x64'), 'app-macos-x64 must not block downloads/Latest')
  assert.ok(workflow.jobs['app-macos-x64'], 'app-macos-x64 job must exist')
  const x64Attach = workflow.jobs['downloads-macos-x64']
  assert.ok(x64Attach, 'downloads-macos-x64 job must exist')
  assert.ok(before('downloads-macos-x64').has('downloads'))
  assert.ok(before('downloads-macos-x64').has('app-macos-x64'))
  assert.match(runs(x64Attach), /--merge-manifest/u)
  assert.match(runs(x64Attach), /node scripts\/release-upload\.mjs /u)
  assert.doesNotMatch(runs(x64Attach), /--latest/u)

  // validate checks Milestone and computes build_android; app-android respects build_android.
  assert.match(runs(workflow.jobs.validate), /check-release-milestone\.mjs/u)
  assert.ok(workflow.jobs.validate.outputs?.build_android)
  assert.match(String(workflow.jobs['app-android'].if || ''), /needs\.validate\.outputs\.build_android == 'true'/u)
  assert.ok(workflow.on.workflow_dispatch?.inputs?.force_android)

  // No app build job may attach assets directly to the GitHub release before publish succeeds.
  for (const [other, cfg] of Object.entries(workflow.jobs)) {
    if (other === name || other === 'downloads-macos-x64' || other === 'publish') continue
    assert.doesNotMatch(runs(cfg), /gh release upload|release-upload\.mjs/u, `${other} must not upload directly to the release before publish passes`)
  }
  assert.match(job.steps.at(-1).run, /^gh release edit "\$TAG" --latest$/u)
  assert.match(runs(job), /node scripts\/release-notes\.mjs /u)
  assert.match(runs(job), /node scripts\/release-upload\.mjs /u)
})

test('both READMEs link the latest release and do not hard-code release version numbers', () => {
  for (const file of ['../../README.md', '../../README.zh.md']) {
    const text = read(file)
    assert.match(text, /\(https:\/\/github\.com\/Fei-Craft\/DS-Bot\/releases\/latest\)/u, file)
    assert.doesNotMatch(text, /ds-bot-\d+\.\d+\.\d+\.tgz|DS-Bot#v\d/u, file)
  }
})
