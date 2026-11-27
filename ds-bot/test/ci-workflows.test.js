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

function runClassifier(workflowFile, filesChanged, envOverrides = {}, { baseFiles = {}, headContents = {} } = {}) {
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
    for (const [rel, content] of Object.entries(baseFiles)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    git(['add', '.'])
    git(['commit', '-m', 'base'])
    const baseSha = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/dev', baseSha])
    git(['update-ref', 'refs/remotes/origin/main', baseSha])

    for (const rel of filesChanged) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, headContents[rel] ?? `changed ${rel}\n`)
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
        HEAD_REF: 'fix/sample',
        BEFORE: baseSha,
        SHA: headSha,
        PR_NUMBER: '',
        PR_FULL_PACKAGE: 'false',
        PR_HOTFIX: 'false',
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
  it('parses all workflow files and enforces job dependencies, Windows sharding, macOS Intel gate, and PR merge guard', () => {
    const testWf = loadWorkflow('test.yml')
    const pkgWf = loadWorkflow('package.yml')
    const fullLabelWf = loadWorkflow('full-package.yml')
    const triageWf = loadWorkflow('pr-triage-labels.yml')
    const nightlyWf = loadWorkflow('nightly-release.yml')
    const cutReleaseWf = loadWorkflow('cut-release.yml')

    assert.equal(testWf.name, 'Test')
    assert.equal(pkgWf.name, 'Package & Native')
    assert.equal(fullLabelWf.name, 'Full Package (on label)')
    assert.equal(nightlyWf.name, 'Nightly Release')
    assert.equal(cutReleaseWf.name, 'Cut Release')
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

    // PR merge guard watches labels and milestones and evaluates needs-product-ok + future Milestone.
    for (const evType of ['labeled', 'unlabeled', 'milestoned', 'demilestoned']) {
      assert.ok(triageWf.on.pull_request_target.types.includes(evType), `pr-triage-labels.yml must trigger on ${evType}`)
    }
    const guardJob = triageWf.jobs['pr-merge-guard']
    assert.ok(guardJob, 'pr-triage-labels.yml must define pr-merge-guard job')
    assert.equal(guardJob.permissions?.statuses, 'write')
    const guardScript = guardJob.steps.find((s) => s.with?.script)?.with?.script || ''
    assert.match(guardScript, /evaluatePrMergeGuard/u)
    assert.match(guardScript, /createCommitStatus/u)
    assert.match(guardScript, /PR merge guard/u)

    // Windows unit tests are split into 4 parallel shards in test.yml.
    const winShards = testWf.jobs.test.strategy.matrix.include.filter((e) => e.os === 'windows-latest')
    assert.deepEqual(winShards.map((e) => e.shard), [1, 2, 3, 4])
    assert.ok(winShards.every((e) => e.shard_total === 4))
    const runUnitStep = testWf.jobs.test.steps.find((s) => s.name === 'Run unit tests')
    assert.match(runUnitStep?.run || '', /npm run test:windows:shard -- --shard/u)
    const saveHarnessStep = testWf.jobs.test.steps.find((s) => s.name === 'Save DSH test harness')
    assert.match(String(saveHarnessStep?.if || ''), /matrix\.shard == 1/u)

    // Release milestone gate is wired into test.yml and required by Test result.
    assert.ok(testWf.jobs['release-milestone'])
    const milestoneRun = testWf.jobs['release-milestone'].steps.map((s) => s.run || '').join('\n')
    assert.match(milestoneRun, /scripts\/check-release-milestone\.mjs/u)

    // package.yml dynamically gates macos-26-intel behind app_package_macos_x64.
    const macMatrixInclude = String(pkgWf.jobs['app-package-macos'].strategy.matrix.include || '')
    assert.match(macMatrixInclude, /needs\.changes\.outputs\.app_package_macos_x64 == 'true'/u)
    assert.match(macMatrixInclude, /macos-26-intel/u)
    assert.match(macMatrixInclude, /macos-latest/u)

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

    // Nightly release workflow contract: daily 20:00 UTC cron, pre-release only, no npm publish, readiness report.
    assert.deepEqual(nightlyWf.on.schedule, [{ cron: '0 20 * * *' }])
    const nightlyAllRuns = Object.values(nightlyWf.jobs).flatMap((j) => (j.steps || []).map((s) => s.run || '')).join('\n')
    assert.doesNotMatch(nightlyAllRuns, /npm publish/u, 'nightly-release.yml must never publish to npm')
    assert.match(nightlyAllRuns, /--prerelease/u)
    assert.match(nightlyAllRuns, /--latest=false/u)
    assert.match(nightlyAllRuns, /Release Readiness/u)
    assert.match(nightlyAllRuns, /needs-product-ok/u)

    // Cut release workflow contract: manual dispatch with version/mode/auto_publish(default false), milestone check, never Latest.
    const cutInputs = cutReleaseWf.on.workflow_dispatch.inputs
    assert.equal(cutInputs.version.required, true)
    assert.deepEqual(cutInputs.mode.options, ['stable', 'hotfix'])
    assert.equal(cutInputs.auto_publish.default, false)
    const cutAllRuns = Object.values(cutReleaseWf.jobs).flatMap((j) => (j.steps || []).map((s) => s.run || '')).join('\n')
    assert.match(cutAllRuns, /scripts\/check-release-milestone\.mjs/u)
    assert.match(cutAllRuns, /--latest=false/u)
    assert.match(cutAllRuns, /chore\/merge-main-/u)
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
    assert.equal(heavy.app_package_macos_x64, 'false')
  })

  it('triggers mobile native builds when native config, icon assets, or ds-bot version change on dev PRs', () => {
    for (const file of [
      'mobile/app.json',
      'mobile/assets/icon.png',
      'mobile/assets/android-icon-foreground.png',
      'ds-bot/package.json',
    ]) {
      const heavy = runClassifier('package.yml', [file])
      assert.equal(heavy.mobile_ios, 'true', `${file} must trigger mobile_ios`)
      assert.equal(heavy.mobile_android, 'true', `${file} must trigger mobile_android`)
      assert.equal(heavy.app_package_macos_x64, 'false', `PR touching ${file} must not block on macos-26-intel`)
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

  it('runs full 4-OS packaging (excluding macos-26-intel on PRs) for updater, packaging config, and runtime lockfile changes', () => {
    const updater = runClassifier('package.yml', ['app/src/updates.mjs'])
    assert.equal(updater.app_package_full, 'true')
    assert.equal(updater.app_package_macos_x64, 'false')
    assert.equal(updater.app_package_linux, 'true')
    assert.equal(updater.app_update, 'true')

    const builder = runClassifier('package.yml', ['app/electron-builder.yml'])
    assert.equal(builder.app_package_full, 'true')
    assert.equal(builder.app_package_macos_x64, 'false')
    assert.equal(builder.app_update, 'true')

    const runtimeLock = runClassifier('package.yml', ['app/scripts/primary-runtime.lock.json'])
    assert.equal(runtimeLock.app_package_full, 'true')
    assert.equal(runtimeLock.app_package_macos_x64, 'false')
    assert.equal(runtimeLock.app_package_linux, 'true')
  })

  it('runs workflow contract tests in test.yml when workflows or milestone script change', () => {
    for (const file of [
      '.github/workflows/package.yml',
      '.github/workflows/full-package.yml',
      '.github/workflows/pr-triage-labels.yml',
      '.github/workflows/release.yml',
      '.github/workflows/nightly-release.yml',
      '.github/workflows/cut-release.yml',
      'scripts/check-release-milestone.mjs',
    ]) {
      const fast = runClassifier('test.yml', [file])
      assert.equal(fast.ds_bot, 'true', `${file} must run ds_bot tests in test.yml`)
    }
  })

  it('runs full matrix on non-hotfix release PRs to main (without macos-26-intel) and enables macos-26-intel on schedule, workflow_dispatch, or ci/full-package', () => {
    const releasePrFast = runClassifier('test.yml', ['README.md'], { BASE_REF: 'main', HEAD_REF: 'chore/release-0.4.2' })
    assert.equal(releasePrFast.full, 'true')
    assert.equal(releasePrFast.release_pr, 'true')
    assert.equal(releasePrFast.hotfix, 'false')

    const releasePrPkg = runClassifier('package.yml', ['README.md'], { BASE_REF: 'main', HEAD_REF: 'chore/release-0.4.2' })
    assert.equal(releasePrPkg.full, 'true')
    assert.equal(releasePrPkg.app_package_full, 'true')
    assert.equal(releasePrPkg.app_package_macos_x64, 'false')
    assert.equal(releasePrPkg.mobile_ios, 'true')
    assert.equal(releasePrPkg.mobile_android, 'true')

    for (const overrides of [
      { PR_FULL_PACKAGE: 'true' },
      { EVENT: 'schedule', REF: 'refs/heads/main', BASE_REF: '' },
      { EVENT: 'workflow_dispatch', REF: 'refs/heads/main', BASE_REF: '' },
    ]) {
      const heavy = runClassifier('package.yml', ['README.md'], overrides)
      assert.equal(heavy.full, 'true')
      assert.equal(heavy.app_package_full, 'true')
      assert.equal(heavy.app_package_macos_x64, 'true')
      assert.equal(heavy.app_package_linux, 'true')
      assert.equal(heavy.app_update, 'true')
      assert.equal(heavy.mobile_ios, 'true')
      assert.equal(heavy.mobile_android, 'true')
    }
  })

  it('uses hotfix fast-lane on BASE_REF=main for hotfix/* branches and release/hotfix PRs without forcing iOS/Android/4-OS packaging', () => {
    const basePkg = JSON.stringify({ name: 'ds-bot', version: '0.4.1', dependencies: { ws: '8.18.3' } }, null, 2)
    const bumpedPkg = JSON.stringify({ name: 'ds-bot', version: '0.4.2', dependencies: { ws: '8.18.3' } }, null, 2)
    const baseAppPkg = JSON.stringify({ name: 'dsbot', version: '0.4.1' }, null, 2)
    const bumpedAppPkg = JSON.stringify({ name: 'dsbot', version: '0.4.2' }, null, 2)

    for (const overrides of [
      { BASE_REF: 'main', HEAD_REF: 'hotfix/0.4.2-mail-toggle' },
      { BASE_REF: 'main', HEAD_REF: 'fix/urgent-patch', PR_HOTFIX: 'true' },
    ]) {
      const pkgHotfix = runClassifier(
        'package.yml',
        ['ds-bot/src/host/tools.js', 'app/ui/src/session-chat.js', 'ds-bot/package.json', 'app/package.json'],
        overrides,
        {
          baseFiles: { 'ds-bot/package.json': basePkg, 'app/package.json': baseAppPkg },
          headContents: { 'ds-bot/package.json': bumpedPkg, 'app/package.json': bumpedAppPkg },
        },
      )
      assert.equal(pkgHotfix.hotfix, 'true')
      assert.equal(pkgHotfix.full, 'false')
      assert.equal(pkgHotfix.mobile_ios, 'false')
      assert.equal(pkgHotfix.mobile_android, 'false')
      assert.equal(pkgHotfix.app_package_full, 'false')
      assert.equal(pkgHotfix.app_package_macos_x64, 'false')
      assert.equal(pkgHotfix.app_package_linux, 'true')

      const testHotfix = runClassifier('test.yml', ['ds-bot/src/host/tools.js'], overrides)
      assert.equal(testHotfix.hotfix, 'true')
      assert.equal(testHotfix.release_pr, 'false')
      assert.equal(testHotfix.full, 'false')
      assert.equal(testHotfix.ds_bot, 'true')
    }

    // A hotfix that genuinely changes mobile native config or adds a dependency still triggers native/full packaging.
    const depChangePkg = JSON.stringify({ name: 'ds-bot', version: '0.4.2', dependencies: { ws: '8.18.4' } }, null, 2)
    const depHotfix = runClassifier(
      'package.yml',
      ['ds-bot/package.json', 'mobile/app.json'],
      { BASE_REF: 'main', HEAD_REF: 'hotfix/0.4.2-native' },
      {
        baseFiles: { 'ds-bot/package.json': basePkg },
        headContents: { 'ds-bot/package.json': depChangePkg },
      },
    )
    assert.equal(depHotfix.hotfix, 'true')
    assert.equal(depHotfix.app_package_full, 'true')
    assert.equal(depHotfix.mobile_ios, 'true')
    assert.equal(depHotfix.mobile_android, 'true')
  })

  it('keeps push to dev and push to main off scarce macOS/Windows runners', () => {
    const devPush = runClassifier('package.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/dev',
      BASE_REF: '',
    })
    assert.equal(devPush.app_package_full, 'false')
    assert.equal(devPush.app_package_macos_x64, 'false')
    assert.equal(devPush.app_package_linux, 'true')
    assert.equal(devPush.mobile_ios, 'false')

    const mainPush = runClassifier('package.yml', ['ds-bot/index.js'], {
      EVENT: 'push',
      REF: 'refs/heads/main',
      BASE_REF: '',
    })
    assert.equal(mainPush.app_package_full, 'false')
    assert.equal(mainPush.app_package_macos_x64, 'false')
    assert.equal(mainPush.app_package_linux, 'true')
    assert.equal(mainPush.mobile_ios, 'false')
    assert.equal(mainPush.mobile_android, 'false')
  })
})
