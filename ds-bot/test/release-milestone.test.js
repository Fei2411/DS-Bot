import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectClosingIssuesFromGit,
  compareSemver,
  evaluatePrMergeGuard,
  evaluateReleaseMilestone,
  extractClosingIssueNumbers,
  findMilestoneForVersion,
  parseSemver,
  resolveActiveDevMilestone,
  runPrMergeGuard,
  runReleaseMilestoneCheck,
} from '../../scripts/check-release-milestone.mjs'
import {
  discoverTopLevelTests,
  parseShardSpec,
  partitionTestFiles,
  selectShardFiles,
} from '../scripts/run-tests-shard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const REPO_ROOT = join(PLUGIN_ROOT, '..')
const MILESTONE_SCRIPT = join(REPO_ROOT, 'scripts', 'check-release-milestone.mjs')
const SHARD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'run-tests-shard.mjs')

describe('release milestone gate', () => {
  it('parses and compares semver versions numerically including v0.4.2 vs v0.4.10 and prereleases', () => {
    assert.equal(parseSemver('v0.4.2').version, '0.4.2')
    assert.equal(parseSemver('0.4.2').tag, 'v0.4.2')
    assert.equal(parseSemver('0.4.2-rc.1').prerelease, true)
    assert.equal(parseSemver('not-a-version'), null)
    assert.equal(parseSemver('0.4.'), null)

    assert.equal(compareSemver('v0.4.1', 'v0.4.2'), -1)
    assert.equal(compareSemver('v0.4.2', 'v0.4.10'), -1)
    assert.equal(compareSemver('v0.4.10', 'v0.4.2'), 1)
    assert.equal(compareSemver('0.4.2', 'v0.4.2'), 0)
    assert.equal(compareSemver('0.4.2-rc.1', '0.4.2'), -1)
    assert.equal(compareSemver('0.4.2-rc.2', '0.4.2-rc.10'), -1)
    assert.equal(compareSemver('0.5.0', '0.4.99'), 1)

    const active = resolveActiveDevMilestone('0.4.1', [
      { number: 10, title: 'v0.4.10', state: 'open', open_issues: 1 },
      { number: 4, title: 'v0.4.2', state: 'open', open_issues: 2 },
    ])
    assert.equal(active?.parsed.tag, 'v0.4.2')
  })

  it('extracts GitHub closing keywords accurately while ignoring cross-repo issues', () => {
    const text = 'Fixes #123, closes: #456, Resolves Fei-Craft/DS-Bot#789, fix other/repo#999, mentions #111'
    assert.deepEqual([...extractClosingIssueNumbers(text, 'Fei-Craft/DS-Bot')].sort((a, b) => a - b), [123, 456, 789])
  })

  it('finds milestones matching vX.Y.Z or bare X.Y.Z', () => {
    const milestones = [
      { number: 1, title: 'v0.4.1', state: 'open', open_issues: 0 },
      { number: 2, title: '0.4.2', state: 'open', open_issues: 0 },
    ]
    assert.equal(findMilestoneForVersion(milestones, '0.4.1')?.number, 1)
    assert.equal(findMilestoneForVersion(milestones, 'v0.4.2')?.number, 2)
    assert.equal(findMilestoneForVersion(milestones, 'v0.4.3'), null)
  })

  it('fails when the target Milestone does not exist or has open issues/PRs', () => {
    const missing = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 1, title: 'v0.4.1', state: 'open', open_issues: 0 }],
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'milestone-not-found')

    const withOpen = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 2, closed_issues: 3 }],
      openItems: [
        { number: 2401, title: 'Fix installer check', state: 'open', html_url: 'https://github.com/Fei-Craft/DS-Bot/issues/2401' },
        { number: 2405, title: 'Implement feature X', state: 'open', pull_request: {}, html_url: 'https://github.com/Fei-Craft/DS-Bot/pull/2405' },
      ],
    })
    assert.equal(withOpen.ok, false)
    assert.equal(withOpen.reason, 'open-items-remaining')
    assert.equal(withOpen.blockingItems.length, 2)
    assert.match(withOpen.message, /\[Issue\] #2401 Fix installer check/u)
    assert.match(withOpen.message, /\[PR\] #2405 Implement feature X/u)

    // Fail-closed when open_issues > 0 and openItems is omitted.
    const noList = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 1 }],
      openItems: null,
    })
    assert.equal(noList.ok, false)
    assert.equal(noList.reason, 'open-items-remaining')
  })

  it('exempts open issues already fixed in dev (pending merge to main) while still blocking unmerged PRs and unfixed issues', () => {
    const allFixedInDev = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 2, closed_issues: 3 }],
      openItems: [
        { number: 2500, title: 'release: v0.4.2', state: 'open', pull_request: {} },
        { number: 2401, title: 'Already fixed on dev', state: 'open', html_url: 'https://github.com/Fei-Craft/DS-Bot/issues/2401' },
      ],
      ignorePrNumber: 2500,
      resolvedIssueNumbers: [2401],
    })
    assert.equal(allFixedInDev.ok, true)
    assert.equal(allFixedInDev.resolvedPendingMain.length, 1)
    assert.match(allFixedInDev.message, /will auto-close on merge to main/u)

    // Even if a PR number appears in resolvedIssueNumbers, unmerged PRs are never exempted.
    const unmergedPrStillBlocks = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 1 }],
      openItems: [
        { number: 2405, title: 'Open feature PR', state: 'open', pull_request: {} },
      ],
      resolvedIssueNumbers: [2405],
    })
    assert.equal(unmergedPrStillBlocks.ok, false)
    assert.equal(unmergedPrStillBlocks.blockingItems[0].number, 2405)
  })

  it('ignores the release PR itself via ignorePrNumber and allows clean, closed, hotfix, prerelease, or allowOpen runs', () => {
    const onlySelfPr = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 1, closed_issues: 8 }],
      openItems: [
        { number: 2500, title: 'release: v0.4.2', state: 'open', pull_request: {} },
      ],
      ignorePrNumber: 2500,
    })
    assert.equal(onlySelfPr.ok, true)
    assert.equal(onlySelfPr.reason, 'milestone-clean')

    // Closed milestone with 0 open items passes.
    const closedClean = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'closed', open_issues: 0, closed_issues: 12 }],
      openItems: [],
    })
    assert.equal(closedClean.ok, true)

    // Prerelease and hotfix skip strict milestone gate.
    assert.equal(evaluateReleaseMilestone({ targetVersion: 'v0.4.2-rc.1', milestones: [] }).skipped, true)
    assert.equal(evaluateReleaseMilestone({ targetVersion: 'v0.4.2', milestones: [], hotfix: true }).skipped, true)

    // allowOpen allows open items with warning.
    const allowed = evaluateReleaseMilestone({
      targetVersion: 'v0.4.2',
      milestones: [{ number: 4, title: 'v0.4.2', state: 'open', open_issues: 1 }],
      openItems: [{ number: 2410, title: 'Unfinished bug', state: 'open' }],
      allowOpen: true,
    })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.allowedOpen, true)
  })

  it('blocks PRs with needs-product-ok and blocks dev PRs with a future Milestone ahead of the active dev Milestone', () => {
    const openMilestones = [
      { number: 1, title: 'v0.3.9', state: 'open', open_issues: 0 },
      { number: 2, title: 'v0.4.0', state: 'open', open_issues: 0 },
      { number: 5, title: 'v0.4.1', state: 'open', open_issues: 0 },
      { number: 4, title: 'v0.4.2', state: 'open', open_issues: 2 },
      { number: 6, title: 'v0.4.3', state: 'open', open_issues: 1 },
    ]

    const active = resolveActiveDevMilestone('0.4.1', openMilestones)
    assert.equal(active?.parsed.tag, 'v0.4.2')

    const okDev = evaluatePrMergeGuard({
      baseRef: 'dev',
      labels: ['agent/antigravity', 'review/approved'],
      prMilestoneTitle: 'v0.4.2',
      currentVersion: '0.4.1',
      milestones: openMilestones,
    })
    assert.equal(okDev.ok, true)
    assert.equal(okDev.activeMilestone, 'v0.4.2')

    const futureDev = evaluatePrMergeGuard({
      baseRef: 'dev',
      labels: ['agent/antigravity'],
      prMilestoneTitle: 'v0.4.3',
      currentVersion: '0.4.1',
      milestones: openMilestones,
    })
    assert.equal(futureDev.ok, false)
    assert.equal(futureDev.blockedByFutureMilestone, true)
    assert.equal(futureDev.blockedByProductOk, false)
    assert.match(futureDev.summary, /v0\.4\.3.*v0\.4\.2/u)

    const needsProductOk = evaluatePrMergeGuard({
      baseRef: 'dev',
      labels: [{ name: 'needs-product-ok' }],
      prMilestoneTitle: 'v0.4.2',
      currentVersion: '0.4.1',
      milestones: openMilestones,
    })
    assert.equal(needsProductOk.ok, false)
    assert.equal(needsProductOk.blockedByProductOk, true)
    assert.equal(needsProductOk.blockedByFutureMilestone, false)

    const bothBlocked = evaluatePrMergeGuard({
      baseRef: 'dev',
      labels: ['needs-product-ok'],
      prMilestoneTitle: 'v0.4.3',
      currentVersion: '0.4.1',
      milestones: openMilestones,
    })
    assert.equal(bothBlocked.ok, false)
    assert.equal(bothBlocked.reasons.length, 2)

    const mainPrOk = evaluatePrMergeGuard({
      baseRef: 'main',
      labels: [],
      prMilestoneTitle: 'v0.4.3',
      currentVersion: '0.4.1',
      milestones: openMilestones,
    })
    assert.equal(mainPrOk.ok, true)
  })

  it('verifies HTTP pagination, same-origin guard, dev-fixed issue detection, fork restricted-token fallback, and CLI exit codes', async (t) => {
    // Create a tiny temp git repo with origin/main and origin/dev containing "Fixes #201" + a merged PR commit.
    const gitDir = mkdtempSync(join(tmpdir(), 'dsb-milestone-git-'))
    t.after(() => rmSync(gitDir, { recursive: true, force: true }))
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    }
    const git = (args) => {
      const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: gitDir, encoding: 'utf8', env: gitEnv })
      assert.equal(res.status, 0, res.stderr)
      return res.stdout.trim()
    }
    git(['init', '-b', 'dev'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(gitDir, 'a.txt'), 'v1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const mainSha = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', mainSha])
    writeFileSync(join(gitDir, 'a.txt'), 'v2\n')
    git(['add', '.'])
    git(['commit', '-m', 'fix(core): resolve bug\n\nFixes #201'])
    writeFileSync(join(gitDir, 'b.txt'), 'v3\n')
    git(['add', '.'])
    git(['commit', '-m', 'Merge pull request #500 from Fei-Craft/fix/issue-202'])
    const mergedPrSha = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/dev', mergedPrSha])

    assert.deepEqual([...collectClosingIssuesFromGit({ baseRef: 'origin/main', headRef: 'origin/dev', cwd: gitDir })], [201])

    const server = createServer((req, res) => {
      res.setHeader('connection', 'close')
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/repos/acme/rate-limited/milestones') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Resource not accessible by integration' }))
        return
      }
      if (url.pathname === '/repos/acme/cross-origin/milestones') {
        res.writeHead(200, {
          'content-type': 'application/json',
          link: '<https://evil.example/steal-token>; rel="next"',
        })
        res.end(JSON.stringify([]))
        return
      }
      if (url.pathname === '/repos/acme/ds-bot/milestones') {
        const page = url.searchParams.get('page') || '1'
        if (page === '1') {
          const next = `http://127.0.0.1:${String(server.address().port)}/repos/acme/ds-bot/milestones?state=all&per_page=100&page=2`
          res.writeHead(200, { 'content-type': 'application/json', link: `<${next}>; rel="next"` })
          res.end(JSON.stringify([
            { number: 1, title: 'v0.4.1', state: 'open', open_issues: 0, closed_issues: 5 },
          ]))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          { number: 2, title: 'v0.4.2', state: 'open', open_issues: 3, closed_issues: 3 },
          { number: 3, title: 'v0.4.3', state: 'open', open_issues: 2, closed_issues: 0 },
        ]))
        return
      }
      if (url.pathname === '/repos/acme/ds-bot/issues') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          { number: 99, title: 'release: v0.4.2', state: 'open', pull_request: {}, html_url: 'https://example.test/pull/99' },
          { number: 201, title: 'Fixed via commit in dev', state: 'open', html_url: 'https://example.test/issues/201' },
          { number: 202, title: 'Fixed via PR body merged to dev', state: 'open', html_url: 'https://example.test/issues/202' },
        ]))
        return
      }
      if (url.pathname === '/repos/acme/ds-bot/issues/202/timeline') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          {
            event: 'cross-referenced',
            source: {
              issue: {
                number: 500,
                state: 'closed',
                pull_request: { url: 'https://example.test/pull/500' },
                repository: { full_name: 'acme/ds-bot' },
              },
            },
          },
        ]))
        return
      }
      if (url.pathname === '/repos/acme/ds-bot/pulls/500') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          number: 500,
          merged: true,
          merged_at: '2026-11-27T10:00:00Z',
          merge_commit_sha: mergedPrSha,
          base: { ref: 'dev' },
          title: 'fix: resolve 202',
          body: 'Fixes #202',
        }))
        return
      }
      if (url.pathname === '/repos/acme/ds-bot/pulls/123') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          number: 123,
          state: 'open',
          base: { ref: 'dev' },
          head: { sha: 'deadbeef'.repeat(5) },
          labels: [{ name: 'agent/antigravity' }],
          milestone: { title: 'v0.4.3' },
        }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections?.()
      server.close()
    })
    const apiBase = `http://127.0.0.1:${String(server.address().port)}`

    // Without headRef, issues #201 and #202 + PR #99 all block.
    const blocked = await runReleaseMilestoneCheck({
      version: 'v0.4.2',
      repo: 'acme/ds-bot',
      apiBase,
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.blockingItems.length, 3)

    // With headRef=origin/dev + ignorePrNumber=99: #201 is cleared via git log Fixes #201 and #202 via timeline merged PR #500.
    const passedViaDevFixes = await runReleaseMilestoneCheck({
      version: 'v0.4.2',
      repo: 'acme/ds-bot',
      apiBase,
      ignorePrNumber: 99,
      baseRef: 'origin/main',
      headRef: 'origin/dev',
      cwd: gitDir,
    })
    assert.equal(passedViaDevFixes.ok, true, passedViaDevFixes.message)
    assert.deepEqual(passedViaDevFixes.resolvedPendingMain.map(i => i.number), [201, 202])

    // Cross-origin pagination Link header must fail closed without forwarding Authorization.
    await assert.rejects(
      runReleaseMilestoneCheck({
        version: 'v0.4.2',
        repo: 'acme/cross-origin',
        apiBase,
        token: 'placeholder-token-for-test',
      }),
      /cross-origin/u,
    )

    // Fork PR with non-empty restricted token skips cleanly when allowMissingToken is true and GitHub returns 403.
    const forkSkip = await runReleaseMilestoneCheck({
      version: 'v0.4.2',
      repo: 'acme/rate-limited',
      apiBase,
      token: 'restricted-fork-token-placeholder',
      allowMissingToken: true,
    })
    assert.equal(forkSkip.ok, true)
    assert.equal(forkSkip.skipped, true)
    assert.equal(forkSkip.reason, 'restricted-token')

    // PR guard via HTTP API blocks future Milestone v0.4.3 when active dev milestone is v0.4.2.
    const prGuard = await runPrMergeGuard({
      prNumber: 123,
      currentVersion: '0.4.1',
      repo: 'acme/ds-bot',
      apiBase,
    })
    assert.equal(prGuard.ok, false)
    assert.equal(prGuard.blockedByFutureMilestone, true)

    // CLI contract (must spawn asynchronously so the in-process mock HTTP server stays responsive).
    const runCli = (args, cwd = PLUGIN_ROOT) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [MILESTONE_SCRIPT, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.once('error', reject)
      child.once('close', (status) => { resolve({ status, stdout, stderr }) })
    })

    const cliFail = await runCli(['--version', 'v0.4.2', '--repo', 'acme/ds-bot', '--api-base', apiBase])
    assert.equal(cliFail.status, 1)
    assert.match(cliFail.stderr, /#99 release: v0\.4\.2/u)

    const cliOk = await runCli([
      '--version', 'v0.4.2',
      '--repo', 'acme/ds-bot',
      '--api-base', apiBase,
      '--ignore-pr', '99',
      '--base-ref', 'origin/main',
      '--head-ref', 'origin/dev',
    ], gitDir)
    assert.equal(cliOk.status, 0, cliOk.stderr)
    assert.match(cliOk.stdout, /passed/u)
  })
})

describe('Windows test shard runner', () => {
  it('validates shard specifiers and rejects out-of-range inputs', () => {
    assert.deepEqual(parseShardSpec('1/4'), { index: 1, total: 4 })
    assert.deepEqual(parseShardSpec('4/4'), { index: 4, total: 4 })
    for (const bad of ['', '0/4', '5/4', '1/0', 'abc', '1/2/3']) {
      assert.throws(() => parseShardSpec(bad), /shard/i)
    }
  })

  it('partitions test files deterministically with complete non-overlapping coverage and balanced weights', () => {
    const entries = [
      { file: 'test/a.test.js', size: 130_000 },
      { file: 'test/b.test.js', size: 80_000 },
      { file: 'test/c.test.js', size: 70_000 },
      { file: 'test/d.test.js', size: 65_000 },
      { file: 'test/e.test.js', size: 30_000 },
      { file: 'test/f.test.js', size: 25_000 },
      { file: 'test/g.test.js', size: 20_000 },
      { file: 'test/h.test.js', size: 15_000 },
    ]
    const forward = partitionTestFiles(entries, 4)
    const reversed = partitionTestFiles([...entries].reverse(), 4)
    assert.deepEqual(forward, reversed, 'partitioning must be invariant to input order')

    const shardOf = (name) => forward.findIndex(bucket => bucket.includes(name))
    assert.equal(new Set(['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'].map(shardOf)).size, 4)

    const union = forward.flat().sort()
    assert.deepEqual(union, entries.map(e => e.file).sort())
    assert.deepEqual(selectShardFiles(entries, 2, 4), forward[1])
  })

  it('lists all ds-bot top-level tests across 4 CLI shards with zero drops or duplicates', () => {
    const all = discoverTopLevelTests().map(e => e.file).sort()
    assert.ok(all.length > 50, `expected >50 top-level tests, got ${String(all.length)}`)

    const seen = new Set()
    const collected = []
    for (let shard = 1; shard <= 4; shard += 1) {
      const run = spawnSync(process.execPath, [SHARD_SCRIPT, '--shard', `${String(shard)}/4`, '--list'], {
        cwd: PLUGIN_ROOT,
        encoding: 'utf8',
      })
      assert.equal(run.status, 0, run.stderr)
      const files = run.stdout.trim().split(/\r?\n/).filter(Boolean)
      assert.ok(files.length > 0, `shard ${String(shard)}/4 must not be empty`)
      for (const file of files) {
        assert.ok(!seen.has(file), `duplicate test file ${file} in shard ${String(shard)}/4`)
        seen.add(file)
        collected.push(file)
      }
    }
    assert.deepEqual(collected.sort(), all)
  })
})
