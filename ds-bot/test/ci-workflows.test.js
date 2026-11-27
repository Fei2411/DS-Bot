import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const REPO_ROOT = join(PLUGIN_ROOT, '..')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows')
const harnessBase = process.env.DSH_HARNESS
  ? join(process.env.DSH_HARNESS, 'package.json')
  : join(PLUGIN_ROOT, 'dev', 'harness', 'package.json')
const harnessRequire = createRequire(harnessBase)
const { parse: parseYaml } = harnessRequire('yaml')

function resolveBashExecutable() {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    process.env.GIT_BASH,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'
}

const BASH_EXE = resolveBashExecutable()

function loadWorkflow(filename) {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, filename), 'utf8'))
}

function runClassifier(workflowFile, filesChanged, envOverrides = {}) {
  const wf = loadWorkflow(workflowFile)
  const filterStep = wf.jobs.changes.steps.find((s) => s.id === 'filter')
  assert.ok(filterStep?.run, `${workflowFile}: missing filter step`)

  const dir = mkdtempSync(join(tmpdir(), 'dsb-ci-filter-'))
  const outputFile = join(dir, 'github_output.txt')
  writeFileSync(outputFile, '')

  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }

  const git = (args) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: gitEnv,
    })
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    }
    return res.stdout.trim()
  }

  try {
    git(['init', '-b', 'dev'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(dir, 'README.md'), 'init\n')
    git(['add', '.'])
    git(['commit', '-m', 'base'])
    const baseSha = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/dev', baseSha])
    git(['update-ref', 'refs/remotes/origin/main', baseSha])

    for (const rel of filesChanged) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, `changed ${rel}\n`)
    }
    git(['add', '.'])
    git(['commit', '--allow-empty', '-m', 'pr change'])
    const headSha = git(['rev-parse', 'HEAD'])

    const res = spawnSync(BASH_EXE, ['-c', filterStep.run], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        GITHUB_OUTPUT: outputFile,
        EVENT: 'pull_request',
        REF: 'refs/pull/1/merge',
        BASE_REF: 'dev',
        BEFORE: baseSha,
        SHA: headSha,
        PR_NUMBER: '',
        PR_FULL_PACKAGE: 'false',
        GH_TOKEN: '',
        GH_REPO: '',
        ...envOverrides,
      },
    })
    assert.equal(res.status, 0, `${workflowFile} classifier failed: ${res.stderr}`)

    const out = {}
    for (const rawLine of readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      const idx = line.indexOf('=')
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('CI workflow separation and path classification', () => {
  it('parses test.yml, package.yml, full-package.yml and pr-triage-labels.yml with matching result job needs', () => {
    const testWf = loadWorkflow('test.yml')
    const pkgWf = loadWorkflow('package.yml')
    const fullLabelWf = loadWorkflow('full-package.yml')
    const triageWf = loadWorkflow('pr-triage-labels.yml')

    assert.equal(testWf.name, 'Test')
    assert.equal(pkgWf.name, 'Package & Native')
    assert.equal(fullLabelWf.name, 'Full Package (on label)')
    assert.equal(triageWf.permissions.contents, 'read')
    assert.ok(pkgWf.on.workflow_call?.inputs?.force_full)
    assert.deepEqual(pkgWf.on.push.branches, ['main'])
    assert.deepEqual(fullLabelWf.on.pull_request.types, ['labeled'])
    assert.equal(fullLabelWf.jobs.package.uses, './.github/workflows/package.yml')
    assert.equal(fullLabelWf.jobs.package.with.force_full, true)
    assert.match(String(testWf.concurrency?.group || ''), /nightly-dev/, 'test.yml must isolate schedule nightly concurrency lane from push:main')
    assert.match(String(testWf.concurrency?.['cancel-in-progress'] || ''), /refs\/heads\/dev/, 'test.yml must cancel superseded dev pushes')
    assert.match(String(pkgWf.concurrency?.group || ''), /inputs\.force_full/, 'package.yml must isolate forced full-package concurrency lane')
    assert.match(String(pkgWf.concurrency?.group || ''), /package-nightly-dev/, 'package.yml must isolate schedule nightly concurrency lane from push:main')
    assert.match(String(triageWf.jobs['sync-labels'].if || ''), /changes\.base/, 'pr-triage-labels.yml must run on PR base retargeting')
    assert.match(String(triageWf.concurrency?.group || ''), /pr-triage-retarget-/, 'pr-triage-labels.yml must isolate base-retarget concurrency lane')
    const triageScript = triageWf.jobs['sync-labels'].steps.find((s) => s.with?.script)?.with?.script || ''
    assert.match(triageScript, /base_ref_changed/, 'pr-triage-labels.yml must durably reject approvals predating base_ref_changed')

    const winNextStep = pkgWf.jobs['app-package'].steps.find((s) => s.name === 'Build the next version')
    assert.equal(winNextStep?.env?.ELECTRON_BUILDER_COMPRESSION_LEVEL, '1')

    // test.yml shards Linux unit tests, separates Playwright browser & Windows jobs, and keeps packaging out.
    assert.deepEqual(testWf.jobs.test.strategy?.matrix?.shard, [1, 2, 3])
    assert.equal(testWf.jobs.test['runs-on'], 'ubuntu-latest')
    assert.ok(testWf.jobs['test-browser'])
    assert.ok(testWf.jobs['test-windows'])
    assert.equal(testWf.jobs['test-windows']['runs-on'], 'windows-latest')
    assert.ok(testWf.jobs['app-windows'])
    assert.equal(testWf.jobs['app-package'], undefined)
    assert.equal(testWf.jobs['app-package-macos'], undefined)
    assert.equal(testWf.jobs['app-package-linux'], undefined)
    assert.equal(testWf.jobs['mobile-ios'], undefined)
    assert.equal(testWf.jobs['mobile-android'], undefined)

    // Every checkout step in test.yml and package.yml must target dev on schedule runs.
    for (const [name, wf] of [['test.yml', testWf], ['package.yml', pkgWf]]) {
      for (const [jobId, job] of Object.entries(wf.jobs)) {
        const checkout = (job.steps || []).find((s) => String(s.uses || '').startsWith('actions/checkout@'))
        if (!checkout) continue
        assert.match(
          String(checkout.with?.ref || ''),
          /github\.event_name == 'schedule' && 'dev'/,
          `${name} job ${jobId} must check out dev on schedule runs`
        )
      }
    }

    // Every non-publish job in test.yml is checked by Test result.
    const testJobs = Object.keys(testWf.jobs).filter((k) => k !== 'result' && k !== 'publish-docker')
    assert.deepEqual([...testWf.jobs.result.needs].sort(), [...testJobs].sort())

    // Every job in package.yml is checked by Package result.
    const pkgJobs = Object.keys(pkgWf.jobs).filter((k) => k !== 'result')
    assert.deepEqual([...pkgWf.jobs.result.needs].sort(), [...pkgJobs].sort())
  })

  it('keeps everyday ds-bot host PRs to dev on the fast Linux-only gate (no Windows, Playwright, Docker, or packaging)', () => {
    const fast = runClassifier('test.yml', ['ds-bot/src/host/turns.js'])
    const heavy = runClassifier('package.yml', ['ds-bot/src/host/turns.js'])

    assert.equal(fast.ds_bot, 'true')
    assert.equal(fast.ds_bot_browser, 'false')
    assert.equal(fast.ds_bot_win, 'false')
    assert.equal(fast.node22, 'false')
    assert.equal(fast.app_unit, 'true')
    assert.equal(fast.app_unit_win, 'false')
    assert.equal(fast.docker, 'false')
    assert.equal(heavy.app_package_full, 'false')
    assert.equal(heavy.app_package_linux, 'false')
    assert.equal(heavy.mobile_ios, 'false')
    assert.equal(heavy.mobile_android, 'false')
  })

  it('runs parallel Playwright browser tests on client, browser-host, and html-preview PRs to dev', () => {
    for (const file of [
      'ds-bot/src/client/themes.js',
      'ds-bot/src/host/browser/gate.js',
      'app/ui/src/html-preview.js',
    ]) {
      const fast = runClassifier('test.yml', [file])
      assert.equal(fast.ds_bot_browser, 'true', `${file} must trigger ds_bot_browser`)
      assert.equal(fast.ds_bot_win, 'false', `${file} must not trigger Windows tests on PR to dev`)
    }
  })

  it('keeps everyday app, mobile, and updater PRs to dev off heavy packaging and Windows runners', () => {
    for (const file of [
      'mobile/src/components/LiveMark.tsx',
      'mobile/app.json',
      'app/ui/src/App.jsx',
      'app/src/updates.mjs',
      'app/electron-builder.yml',
      'ds-bot/package.json',
    ]) {
      const fast = runClassifier('test.yml', [file])
      const heavy = runClassifier('package.yml', [file])
      assert.equal(fast.ds_bot_win, 'false', `${file} must defer ds_bot_win to Nightly`)
      assert.equal(fast.app_unit_win, 'false', `${file} must defer app_unit_win to Nightly`)
      assert.equal(fast.docker, 'false', `${file} must defer docker to Nightly`)
      assert.equal(heavy.app_package_full, 'false', `${file} must defer 4-OS packaging to Nightly`)
      assert.equal(heavy.app_package_linux, 'false', `${file} must defer Linux packaging to Nightly`)
      assert.equal(heavy.app_update, 'false', `${file} must defer updater double-build to Nightly`)
      assert.equal(heavy.mobile_ios, 'false', `${file} must defer iOS native build to Nightly`)
      assert.equal(heavy.mobile_android, 'false', `${file} must defer Android native build to Nightly`)
    }
  })

  it('still verifies docker changes directly on PRs to dev', () => {
    const fast = runClassifier('test.yml', ['docker/Dockerfile'])
    assert.equal(fast.docker, 'true')
    assert.equal(fast.ds_bot_win, 'false')
  })

  it('runs workflow contract tests in test.yml when package or triage workflows change', () => {
    for (const file of [
      '.github/workflows/package.yml',
      '.github/workflows/full-package.yml',
      '.github/workflows/pr-triage-labels.yml',
    ]) {
      const fast = runClassifier('test.yml', [file])
      assert.equal(fast.ds_bot, 'true', `${file} must run ds_bot tests in test.yml`)
    }
  })

  it('runs full matrix on release PRs to main, workflow edits, ci/full-package label, and daily dev Nightly', () => {
    for (const [files, overrides] of [
      [['README.md'], { BASE_REF: 'main' }],
      [['README.md'], { EVENT: 'schedule', REF: 'refs/heads/main', BASE_REF: '' }],
      [['README.md'], { EVENT: 'workflow_dispatch', REF: 'refs/heads/dev', BASE_REF: '' }],
      [['.github/workflows/test.yml'], {}],
    ]) {
      const fast = runClassifier('test.yml', files, overrides)
      assert.equal(fast.full, 'true')
      assert.equal(fast.ds_bot, 'true')
      assert.equal(fast.ds_bot_browser, 'true')
      assert.equal(fast.ds_bot_win, 'true')
      assert.equal(fast.node22, 'true')
      assert.equal(fast.app_unit, 'true')
      assert.equal(fast.app_unit_win, 'true')
      assert.equal(fast.mobile, 'true')
      assert.equal(fast.link, 'true')
      assert.equal(fast.docker, 'true')
    }

    for (const [files, overrides] of [
      [['README.md'], { BASE_REF: 'main' }],
      [['README.md'], { PR_FULL_PACKAGE: 'true' }],
      [['README.md'], { EVENT: 'schedule', REF: 'refs/heads/main', BASE_REF: '' }],
      [['README.md'], { EVENT: 'workflow_dispatch', REF: 'refs/heads/dev', BASE_REF: '' }],
      [['.github/workflows/package.yml'], {}],
    ]) {
      const heavy = runClassifier('package.yml', files, overrides)
      assert.equal(heavy.full, 'true')
      assert.equal(heavy.app_package_full, 'true')
      assert.equal(heavy.app_package_linux, 'true')
      assert.equal(heavy.app_update, 'true')
      assert.equal(heavy.mobile_ios, 'true')
      assert.equal(heavy.mobile_android, 'true')
    }
  })

  it('keeps push to dev Linux-only and fast, and keeps push to main off Windows/macOS runners', () => {
    const devTestPush = runClassifier('test.yml', ['ds-bot/index.js', 'docker/Dockerfile'], {
      EVENT: 'push',
      REF: 'refs/heads/dev',
      BASE_REF: '',
    })
    assert.equal(devTestPush.ds_bot, 'true')
    assert.equal(devTestPush.app_unit, 'true')
    assert.equal(devTestPush.ds_bot_win, 'false')
    assert.equal(devTestPush.app_unit_win, 'false')
    assert.equal(devTestPush.node22, 'false')
    assert.equal(devTestPush.docker, 'false')

    const mainTestPush = runClassifier('test.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/main',
      BASE_REF: '',
    })
    assert.equal(mainTestPush.ds_bot, 'true')
    assert.equal(mainTestPush.ds_bot_browser, 'true')
    assert.equal(mainTestPush.ds_bot_win, 'false')
    assert.equal(mainTestPush.app_unit_win, 'false')
    assert.equal(mainTestPush.docker, 'true')

    const mainPkgPush = runClassifier('package.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/main',
      BASE_REF: '',
    })
    assert.equal(mainPkgPush.app_package_full, 'false')
    assert.equal(mainPkgPush.app_package_linux, 'true')
    assert.equal(mainPkgPush.mobile_ios, 'false')
    assert.equal(mainPkgPush.mobile_android, 'false')
  })
})
