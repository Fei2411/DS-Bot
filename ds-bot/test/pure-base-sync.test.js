import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPureBaseSync, isStrictAncestor, resolveUniqueCommit } from '../../scripts/check-pure-base-sync.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'check-pure-base-sync.mjs')

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-pure-sync-'))
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  const git = (args, input) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      input,
      env: gitEnv,
    })
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`)
    }
    return res.stdout.trim()
  }
  const write = (rel, content) => {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  git(['init', '-b', 'dev'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  write('ds-bot/src/client/app.js', 'export const a = 1\n')
  write('ds-bot/client.js', '// bundle v0\n')
  write('ds-bot/src/shared/release-notes.json', '{"0.3.10":{}}\n')
  write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = {}\n')
  write('ds-bot/index.js', 'export const host = 1\n')
  write('README.md', '# Base\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial'])

  return {
    dir,
    gitDir: join(dir, '.git'),
    git,
    gitEnv,
    write,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('checkPureBaseSync', () => {
  it('accepts a clean merge of newer base commits', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/other.js', 'export const other = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev advance'])
      const devTip = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'clean-base-merge')
      assert.equal(result.baseTip, devTip)
      assert.deepEqual(result.changedFiles, [])
    } finally {
      repo.cleanup()
    }
  })

  it('accepts chained pure merges across multiple dev advances against the original approved SHA', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const approvedSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev1.js', 'export const d = 1\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev 1'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev2.js', 'export const d = 2\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev 2'])
      const dev2 = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      // Another PR lands on dev before triage runs.
      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev3.js', 'export const d = 3\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev 3'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha: approvedSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.baseTip, dev2)
    } finally {
      repo.cleanup()
    }
  })

  it('rejects an unreviewed commit followed by a pure dev merge when checked against the approved SHA', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'approved work'])
      const approvedSha = repo.git(['rev-parse', 'HEAD'])

      // Unreviewed commit pushed before a pure dev merge (simulates dropped intermediate synchronize run).
      repo.write('ds-bot/src/host/unreviewed.js', 'export const sneaky = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'unreviewed commit'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev1.js', 'export const d = 1\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev advance'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const liveHeadSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha: approvedSha,
        afterSha: liveHeadSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'non-merge-commit')
    } finally {
      repo.cleanup()
    }
  })

  it('accepts two successive clean dev syncs even when both sides reconciled an identical edit on sync 1 and dev edited it again on sync 2', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/index.js', 'export const host = 2\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr sets host=2'])
      const approvedSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/index.js', 'export const host = 2\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev also sets host=2'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/index.js', 'export const host = 3\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev advances host=3'])
      const dev2 = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha: approvedSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'clean-base-merge')
      assert.equal(result.baseTip, dev2)
    } finally {
      repo.cleanup()
    }
  })

  it('accepts release-notes rebuild when PR only changes build-release-notes.mjs and dev updates CHANGELOG.md', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/scripts/build-release-notes.mjs', 'export const limit = 9\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr updates notes generator'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('CHANGELOG.md', '## v0.4.0\n- item\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev updates changelog'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      repo.write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = { limit: 9 }\n')
      repo.write('ds-bot/client.js', '// rebuilt with new release notes\n')
      repo.git(['add', 'ds-bot/src/shared/release-notes-generated.js', 'ds-bot/client.js'])
      repo.git(['commit', '-m', 'Rebuild client.js after merging dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'base-merge-with-generated-rebuild')
    } finally {
      repo.cleanup()
    }
  })

  it('accepts a merge with ds-bot/client.js-only conflict resolved by rebuilding client.js (merge-dev.sh flow)', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/client/pr.js', 'export const pr = 1\n')
      repo.write('ds-bot/client.js', '// bundle pr\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr client work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/client/dev.js', 'export const dev = 1\n')
      repo.write('ds-bot/client.js', '// bundle dev\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev client work'])

      repo.git(['checkout', 'feat/pr'])
      const mergeAttempt = spawnSync('git', ['merge', '--no-edit', 'dev'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: repo.gitEnv,
      })
      assert.equal(mergeAttempt.status, 1)
      repo.write('ds-bot/client.js', '// bundle rebuilt from pr + dev\n')
      repo.git(['add', 'ds-bot/client.js'])
      repo.git(['commit', '--no-edit'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'base-merge-with-generated-rebuild')
      assert.deepEqual(result.changedFiles, ['ds-bot/client.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('accepts clean merge + Rebuild client.js and release-notes-generated.js when both sides touch their inputs', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/client/pr.js', 'export const pr = 1\n')
      repo.write('ds-bot/src/shared/release-notes.json', '{"0.3.10":{},"0.4.0":{"pr":true}}\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr client and notes work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/client/dev.js', 'export const dev = 1\n')
      repo.write('CHANGELOG.md', '## v0.4.0\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev client and changelog work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      repo.write('ds-bot/client.js', '// rebuilt after clean merge\n')
      repo.write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = { v: 2 }\n')
      repo.git(['add', 'ds-bot/client.js', 'ds-bot/src/shared/release-notes-generated.js'])
      repo.git(['commit', '-m', 'Rebuild client.js after merging dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'base-merge-with-generated-rebuild')
    } finally {
      repo.cleanup()
    }
  })

  it('accepts a release-notes-generated.js-only conflict resolved by rebuilding the bundle', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = { a: 1 }\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr notes'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = { b: 2 }\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev notes'])

      repo.git(['checkout', 'feat/pr'])
      const mergeAttempt = spawnSync('git', ['merge', '--no-edit', 'dev'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: repo.gitEnv,
      })
      assert.equal(mergeAttempt.status, 1)
      repo.write('ds-bot/src/shared/release-notes-generated.js', 'export const notes = { a: 1, b: 2 }\n')
      repo.git(['add', 'ds-bot/src/shared/release-notes-generated.js'])
      repo.git(['commit', '--no-edit'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.reason, 'base-merge-with-generated-rebuild')
      assert.deepEqual(result.changedFiles, ['ds-bot/src/shared/release-notes-generated.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('rejects unprompted ds-bot/client.js tampering when base only touched unrelated files', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr host work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('README.md', '# Updated docs\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'docs update'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-commit', '--no-ff', 'dev'])
      repo.write('ds-bot/client.js', '// tampered during unrelated docs merge\n')
      repo.git(['add', 'ds-bot/client.js'])
      repo.git(['commit', '-m', 'Merge dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'unexpected-generated-change')
      assert.deepEqual(result.changedFiles, ['ds-bot/client.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('rejects an evil merge that sneaks a non-generated edit into the merge commit', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev.js', 'export const dev = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-commit', '--no-ff', 'dev'])
      repo.write('ds-bot/index.js', 'export const host = 999 // sneaked!\n')
      repo.git(['add', 'ds-bot/index.js'])
      repo.git(['commit', '-m', 'Merge dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'non-base-changes')
      assert.deepEqual(result.changedFiles, ['ds-bot/index.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('rejects a merge that required manual source conflict resolution', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/index.js', 'export const host = 2\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr edit'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/index.js', 'export const host = 3\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev edit'])

      repo.git(['checkout', 'feat/pr'])
      const mergeAttempt = spawnSync('git', ['merge', '--no-edit', 'dev'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: repo.gitEnv,
      })
      assert.equal(mergeAttempt.status, 1)
      repo.write('ds-bot/index.js', 'export const host = 23\n')
      repo.git(['add', 'ds-bot/index.js'])
      repo.git(['commit', '--no-edit'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'source-merge-conflict')
      assert.deepEqual(result.conflicts, ['ds-bot/index.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('rejects a standalone edit to ds-bot/client.js when base did not advance', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.write('ds-bot/client.js', '// tampered without base merge\n')
      repo.git(['add', 'ds-bot/client.js'])
      repo.git(['commit', '-m', 'touch client.js'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'non-merge-commit')
    } finally {
      repo.cleanup()
    }
  })

  it('rejects force-pushes / rebases and unsafe flag-like baseRef values', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev.js', 'export const dev = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['rebase', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const rebaseRes = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(rebaseRes.pure, false)
      assert.equal(rebaseRes.reason, 'before-not-ancestor')

      const badRefRes = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: '--all',
      })
      assert.equal(badRefRes.pure, false)
      assert.equal(badRefRes.reason, 'invalid-base-ref')
    } finally {
      repo.cleanup()
    }
  })

  it('rejects merging an unrelated non-base branch alongside dev', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'side/unreviewed'])
      repo.write('ds-bot/src/host/side.js', 'export const side = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'side work'])

      repo.git(['checkout', 'dev'])
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev.js', 'export const dev = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      repo.git(['merge', '--no-edit', 'side/unreviewed'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'non-base-merge')
    } finally {
      repo.cleanup()
    }
  })

  it('rejects deleting or replacing ds-bot/client.js with a symlink or executable bit even when rebuild is expected', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/client/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr client work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/client/dev.js', 'export const dev = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev client work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])

      // Case 1: delete ds-bot/client.js
      const mergeSha = repo.git(['rev-parse', 'HEAD'])
      rmSync(join(repo.dir, 'ds-bot/client.js'))
      repo.git(['add', '-A'])
      repo.git(['commit', '-m', 'delete client.js'])
      const deletedSha = repo.git(['rev-parse', 'HEAD'])
      const r1 = checkPureBaseSync({ gitDir: repo.gitDir, beforeSha, afterSha: deletedSha, baseRef: 'refs/heads/dev' })
      assert.equal(r1.pure, false)
      assert.equal(r1.reason, 'invalid-generated-blob')

      // Case 2: replace with symlink directly after merge (120000 via git plumbing so it works on all OSes)
      repo.git(['reset', '--hard', mergeSha])
      const targetBlob = repo.git(['hash-object', '-w', '--stdin'], 'index.js')
      repo.git(['update-index', '--add', '--cacheinfo', `120000,${targetBlob},ds-bot/client.js`])
      repo.git(['commit', '-m', 'symlink client.js'])
      const symlinkSha = repo.git(['rev-parse', 'HEAD'])
      const r2 = checkPureBaseSync({ gitDir: repo.gitDir, beforeSha, afterSha: symlinkSha, baseRef: 'refs/heads/dev' })
      assert.equal(r2.pure, false)
      assert.equal(r2.reason, 'invalid-generated-blob')

      // Case 3: executable file mode directly after merge (100755 instead of 100644)
      repo.git(['reset', '--hard', mergeSha])
      const scriptBlob = repo.git(['hash-object', '-w', '--stdin'], '#!/bin/sh\n')
      repo.git(['update-index', '--add', '--cacheinfo', `100755,${scriptBlob},ds-bot/client.js`])
      repo.git(['commit', '-m', 'chmod client.js'])
      const execSha = repo.git(['rev-parse', 'HEAD'])
      const r3 = checkPureBaseSync({ gitDir: repo.gitDir, beforeSha, afterSha: execSha, baseRef: 'refs/heads/dev' })
      assert.equal(r3.pure, false)
      assert.equal(r3.reason, 'invalid-generated-blob')
    } finally {
      repo.cleanup()
    }
  })

  it('resolves short commit SHAs uniquely and works via CLI on bare repository objects', () => {
    const repo = makeRepo()
    const bare = mkdtempSync(join(tmpdir(), 'dsb-pure-sync-bare-'))
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev.js', 'export const dev = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      assert.equal(spawnSync('git', ['--git-dir', bare, 'init', '--bare'], { encoding: 'utf8', env: repo.gitEnv }).status, 0)
      assert.equal(
        spawnSync(
          'git',
          ['--git-dir', bare, 'fetch', '--no-tags', repo.dir, 'refs/heads/dev:refs/heads/dev', 'refs/heads/feat/pr:refs/pull/42/head'],
          { encoding: 'utf8', env: repo.gitEnv },
        ).status,
        0,
      )

      assert.equal(resolveUniqueCommit(bare, beforeSha.slice(0, 8)), beforeSha)
      assert.equal(resolveUniqueCommit(bare, 'deadbeef'), null)
      assert.equal(resolveUniqueCommit(bare, '--all'), null)
      assert.equal(isStrictAncestor(bare, beforeSha, afterSha), true)
      assert.equal(isStrictAncestor(bare, afterSha, afterSha), false)
      assert.equal(isStrictAncestor(bare, afterSha, beforeSha), false)

      const cli = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--git-dir', bare, '--before', beforeSha, '--after', afterSha, '--base-ref', 'refs/heads/dev'],
        { encoding: 'utf8' },
      )
      assert.equal(cli.status, 0, cli.stderr)
      const parsed = JSON.parse(cli.stdout)
      assert.equal(parsed.pure, true)
      assert.equal(parsed.reason, 'clean-base-merge')
    } finally {
      repo.cleanup()
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
