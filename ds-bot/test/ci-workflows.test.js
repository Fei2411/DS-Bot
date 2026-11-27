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
    assert.deepEqual(fullLabelWf.on.pull_request.types, ['labeled'])
    assert.equal(fullLabelWf.jobs.package.uses, './.github/workflows/package.yml')
    assert.equal(fullLabelWf.jobs.package.with.force_full, true)
    assert.match(String(pkgWf.concurrency?.group || ''), /inputs\.force_full/, 'package.yml must isolate forced full-package concurrency lane')
    assert.match(String(triageWf.jobs['sync-labels'].if || ''), /changes\.base/, 'pr-triage-labels.yml must run on PR base retargeting')
    assert.match(String(triageWf.concurrency?.group || ''), /pr-triage-retarget-/, 'pr-triage-labels.yml must isolate base-retarget concurrency lane')
    const triageScript = triageWf.jobs['sync-labels'].steps.find((s) => s.with?.script)?.with?.script || ''
    assert.match(triageScript, /base_ref_changed/, 'pr-triage-labels.yml must durably reject approvals predating base_ref_changed')

    const winNextStep = pkgWf.jobs['app-package'].steps.find((s) => s.name === 'Build the next version')
    assert.equal(winNextStep?.env?.ELECTRON_BUILDER_COMPRESSION_LEVEL, '1')

    // test.yml must stay fast: no desktop packaging or native mobile build jobs.
    assert.equal(testWf.jobs['app-package'], undefined)
    assert.equal(testWf.jobs['app-package-macos'], undefined)
    assert.equal(testWf.jobs['app-package-linux'], undefined)
    assert.equal(testWf.jobs['mobile-ios'], undefined)
    assert.equal(testWf.jobs['mobile-android'], undefined)
    assert.ok(testWf.jobs['app-windows'])

    // Every non-publish job in test.yml is checked by Test result.
    const testJobs = Object.keys(testWf.jobs).filter((k) => k !== 'result' && k !== 'publish-docker')
    assert.deepEqual([...testWf.jobs.result.needs].sort(), [...testJobs].sort())

    // Every job in package.yml is checked by Package result.
    const pkgJobs = Object.keys(pkgWf.jobs).filter((k) => k !== 'result')
    assert.deepEqual([...pkgWf.jobs.result.needs].sort(), [...pkgJobs].sort())
  })

  it('keeps mobile/src PRs on the fast gate without triggering iOS/Android native builds', () => {
    const fast = runClassifier('test.yml', ['mobile/src/components/LiveMark.tsx'])
    const heavy = runClassifier('package.yml', ['mobile/src/components/LiveMark.tsx'])

    assert.equal(fast.mobile, 'true')
    assert.equal(fast.ds_bot, 'false')
    assert.equal(heavy.mobile_ios, 'false')
    assert.equal(heavy.mobile_android, 'false')
    assert.equal(heavy.app_package_full, 'false')
    assert.equal(heavy.app_package_linux, 'false')
  })

  it('triggers mobile native builds when native config, icon assets, or ds-bot version change', () => {
    for (const file of [
      'mobile/app.json',
      'mobile/assets/icon.png',
      'mobile/assets/android-icon-foreground.png',
      'ds-bot/package.json',
    ]) {
      const heavy = runClassifier('package.yml', [file])
      assert.equal(heavy.mobile_ios, 'true', `${file} must trigger mobile_ios`)
      assert.equal(heavy.mobile_android, 'true', `${file} must trigger mobile_android`)
    }
  })

  it('runs fast UI build + Ubuntu/Windows unit tests for app/ui PRs without 4-OS Electron packaging', () => {
    const fast = runClassifier('test.yml', ['app/ui/src/App.jsx'])
    const heavy = runClassifier('package.yml', ['app/ui/src/App.jsx'])

    assert.equal(fast.app_unit, 'true')
    assert.equal(fast.app_unit_win, 'true')
    assert.equal(heavy.app_package_full, 'false')
    assert.equal(heavy.app_package_linux, 'false')
    assert.equal(heavy.app_update, 'false')
  })

  it('runs Linux packaged smoke for app/src and desktop UI bundle config PRs without blocking on macOS/Windows full packaging', () => {
    for (const file of ['app/src/bot-views.mjs', 'app/vite.config.js', 'app/ui/index.html']) {
      const fast = runClassifier('test.yml', [file])
      const heavy = runClassifier('package.yml', [file])

      assert.equal(fast.app_unit, 'true', `${file} must run app_unit`)
      assert.equal(fast.app_unit_win, 'true', `${file} must run app_unit_win`)
      assert.equal(heavy.app_package_linux, 'true', `${file} must run app_package_linux`)
      assert.equal(heavy.app_package_full, 'false', `${file} should not trigger 4-OS packaging`)
      assert.equal(heavy.app_update, 'false', `${file} should not trigger update double-build`)
    }
  })

  it('runs full 4-OS packaging for updater, packaging config, and runtime lockfile changes', () => {
    const updater = runClassifier('package.yml', ['app/src/updates.mjs'])
    assert.equal(updater.app_package_full, 'true')
    assert.equal(updater.app_package_linux, 'true')
    assert.equal(updater.app_update, 'true')

    const builder = runClassifier('package.yml', ['app/electron-builder.yml'])
    assert.equal(builder.app_package_full, 'true')
    assert.equal(builder.app_update, 'true')

    const runtimeLock = runClassifier('package.yml', ['app/scripts/primary-runtime.lock.json'])
    assert.equal(runtimeLock.app_package_full, 'true')
    assert.equal(runtimeLock.app_package_linux, 'true')
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

  it('runs full matrix on release PRs to main, ci/full-package label, and daily schedule', () => {
    for (const overrides of [
      { BASE_REF: 'main' },
      { PR_FULL_PACKAGE: 'true' },
      { EVENT: 'schedule', REF: 'refs/heads/main', BASE_REF: '' },
    ]) {
      const heavy = runClassifier('package.yml', ['README.md'], overrides)
      assert.equal(heavy.full, 'true')
      assert.equal(heavy.app_package_full, 'true')
      assert.equal(heavy.app_package_linux, 'true')
      assert.equal(heavy.app_update, 'true')
      assert.equal(heavy.mobile_ios, 'true')
      assert.equal(heavy.mobile_android, 'true')
    }
  })

  it('keeps push to dev and push to main off scarce macOS/Windows runners', () => {
    const devPush = runClassifier('package.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/dev',
      BASE_REF: '',
    })
    assert.equal(devPush.app_package_full, 'false')
    assert.equal(devPush.app_package_linux, 'true')
    assert.equal(devPush.mobile_ios, 'false')

    const mainPush = runClassifier('package.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/main',
      BASE_REF: '',
    })
    assert.equal(mainPush.app_package_full, 'false')
    assert.equal(mainPush.app_package_linux, 'true')
    assert.equal(mainPush.mobile_ios, 'false')
    assert.equal(mainPush.mobile_android, 'false')
  })
})
