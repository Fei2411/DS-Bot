import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPureBaseSync } from '../../scripts/check-pure-base-sync.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'check-pure-base-sync.mjs')

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-pure-sync-'))
  const git = (args, input) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', input })
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
  write('ds-bot/index.js', 'export const host = 1\n')
  write('README.md', '# Base\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial'])

  return {
    dir,
    gitDir: join(dir, '.git'),
    git,
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

  it('accepts a merge that also advances dev further later', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/host/pr.js', 'export const pr = true\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev1.js', 'export const d = 1\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev 1'])
      const dev1 = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      const afterSha = repo.git(['rev-parse', 'HEAD'])

      // Another PR lands on dev before triage runs.
      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/host/dev2.js', 'export const d = 2\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev 2'])

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, true)
      assert.equal(result.baseTip, dev1)
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
      const mergeAttempt = spawnSync('git', ['merge', '--no-edit', 'dev'], { cwd: repo.dir, encoding: 'utf8' })
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

  it('accepts clean merge followed by a Rebuild client.js commit', () => {
    const repo = makeRepo()
    try {
      repo.git(['checkout', '-b', 'feat/pr'])
      repo.write('ds-bot/src/client/pr.js', 'export const pr = 1\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'pr client work'])
      const beforeSha = repo.git(['rev-parse', 'HEAD'])

      repo.git(['checkout', 'dev'])
      repo.write('ds-bot/src/client/dev.js', 'export const dev = 1\n')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'dev client work'])

      repo.git(['checkout', 'feat/pr'])
      repo.git(['merge', '--no-edit', 'dev'])
      repo.write('ds-bot/client.js', '// rebuilt after clean merge\n')
      repo.git(['add', 'ds-bot/client.js'])
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
      const mergeAttempt = spawnSync('git', ['merge', '--no-edit', 'dev'], { cwd: repo.dir, encoding: 'utf8' })
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
      assert.equal(result.reason, 'base-did-not-advance')
    } finally {
      repo.cleanup()
    }
  })

  it('rejects force-pushes / rebases where before is no longer an ancestor of after', () => {
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

      const result = checkPureBaseSync({
        gitDir: repo.gitDir,
        beforeSha,
        afterSha,
        baseRef: 'refs/heads/dev',
      })
      assert.equal(result.pure, false)
      assert.equal(result.reason, 'before-not-ancestor')
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
      assert.equal(result.reason, 'non-base-changes')
      assert.deepEqual(result.changedFiles, ['ds-bot/src/host/side.js'])
    } finally {
      repo.cleanup()
    }
  })

  it('rejects deleting or replacing ds-bot/client.js with a symlink or executable bit', () => {
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
      repo.git(['merge', '--no-edit', 'dev'])

      // Case 1: delete ds-bot/client.js
      rmSync(join(repo.dir, 'ds-bot/client.js'))
      repo.git(['add', '-A'])
      repo.git(['commit', '-m', 'delete client.js'])
      const deletedSha = repo.git(['rev-parse', 'HEAD'])
      const r1 = checkPureBaseSync({ gitDir: repo.gitDir, beforeSha, afterSha: deletedSha, baseRef: 'refs/heads/dev' })
      assert.equal(r1.pure, false)
      assert.equal(r1.reason, 'invalid-generated-blob')

      // Case 2: replace with symlink (120000 via git plumbing so it works identically on Windows/macOS/Linux)
      const targetBlob = repo.git(['hash-object', '-w', '--stdin'], 'index.js')
      repo.git(['update-index', '--add', '--cacheinfo', `120000,${targetBlob},ds-bot/client.js`])
      repo.git(['commit', '-m', 'symlink client.js'])
      const symlinkSha = repo.git(['rev-parse', 'HEAD'])
      const r2 = checkPureBaseSync({ gitDir: repo.gitDir, beforeSha, afterSha: symlinkSha, baseRef: 'refs/heads/dev' })
      assert.equal(r2.pure, false)
      assert.equal(r2.reason, 'invalid-generated-blob')

      // Case 3: executable file mode (100755 instead of 100644)
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

  it('works via CLI and bare repository objects', () => {
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

      // Populate bare repo with only dev + PR head (mirrors pr-triage-labels.yml fetch).
      assert.equal(spawnSync('git', ['--git-dir', bare, 'init', '--bare'], { encoding: 'utf8' }).status, 0)
      assert.equal(
        spawnSync(
          'git',
          ['--git-dir', bare, 'fetch', '--no-tags', repo.dir, 'refs/heads/dev:refs/heads/dev', 'refs/heads/feat/pr:refs/pull/42/head'],
          { encoding: 'utf8' },
        ).status,
        0,
      )

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
