#!/usr/bin/env node
// Verifies whether a PR synchronize push (before -> after) is strictly a pure merge
// of newer commits from the PR's base branch (plus optional deterministic rebuilds of
// generated bundles whose integrity is verified by CI), with zero extra code changes
// or manual conflict resolution.
//
// Fail-closed: any missing object, rebase/force-push, non-base merge, source conflict,
// evil merge, or unexpected git error returns { pure: false }.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/i
const DEFAULT_ALLOWED_GENERATED = ['ds-bot/client.js']

function runGit(gitDir, args, extraArgs = []) {
  const fullArgs = [
    '--git-dir', gitDir,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    ...extraArgs,
    ...args,
  ]
  return spawnSync('git', fullArgs, {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
  })
}

function isCommit(gitDir, ref, extraArgs) {
  const res = runGit(gitDir, ['cat-file', '-t', ref], extraArgs)
  return res.status === 0 && res.stdout.trim() === 'commit'
}

function isRegularBlob(gitDir, commitSha, filePath, extraArgs) {
  const res = runGit(gitDir, ['ls-tree', '-z', commitSha, '--', filePath], extraArgs)
  if (res.status !== 0) return false
  const entries = res.stdout.split('\0').filter(Boolean)
  if (entries.length !== 1) return false
  const entry = entries[0]
  const tab = entry.indexOf('\t')
  if (tab === -1) return false
  const meta = entry.slice(0, tab)
  const name = entry.slice(tab + 1)
  return name === filePath && /^100644 blob [0-9a-f]{40}$/.test(meta)
}

/**
 * @param {object} options
 * @param {string} options.gitDir Path to a bare (or .git) repository containing baseRef and afterSha.
 * @param {string} options.beforeSha 40-hex commit SHA before synchronize.
 * @param {string} options.afterSha 40-hex commit SHA after synchronize.
 * @param {string} options.baseRef Git ref for the PR base branch (e.g. refs/heads/dev).
 * @param {string[]} [options.allowedGeneratedPaths] Generated files allowed to differ from merge-tree (verified by CI).
 * @param {string[]} [options.gitConfigArgs] Extra `-c key=val` args passed to git (e.g. promisor auth headers).
 */
export function checkPureBaseSync({
  gitDir,
  beforeSha,
  afterSha,
  baseRef,
  allowedGeneratedPaths = DEFAULT_ALLOWED_GENERATED,
  gitConfigArgs = [],
}) {
  const before = String(beforeSha || '').trim().toLowerCase()
  const after = String(afterSha || '').trim().toLowerCase()
  const base = String(baseRef || '').trim()

  if (!gitDir || !base) return { pure: false, reason: 'missing-arguments' }
  if (!SHA_RE.test(before) || !SHA_RE.test(after)) {
    return { pure: false, reason: 'invalid-sha' }
  }
  if (before === after) {
    return { pure: false, reason: 'unchanged-head' }
  }

  if (!isCommit(gitDir, before, gitConfigArgs)) {
    return { pure: false, reason: 'missing-before-commit' }
  }
  if (!isCommit(gitDir, after, gitConfigArgs)) {
    return { pure: false, reason: 'missing-after-commit' }
  }
  if (!isCommit(gitDir, base, gitConfigArgs)) {
    return { pure: false, reason: 'missing-base-ref' }
  }

  // Reject force-pushes and rebases: before must remain an ancestor of after.
  const anc = runGit(gitDir, ['merge-base', '--is-ancestor', before, after], gitConfigArgs)
  if (anc.status !== 0) {
    return { pure: false, reason: 'before-not-ancestor' }
  }

  // Find the newest base-branch commit merged into after.
  const mb = runGit(gitDir, ['merge-base', after, base], gitConfigArgs)
  if (mb.status !== 0) {
    return { pure: false, reason: 'no-base-merge-base' }
  }
  const baseTip = mb.stdout.trim().toLowerCase()
  if (!SHA_RE.test(baseTip)) {
    return { pure: false, reason: 'invalid-base-tip' }
  }

  // Base commits must actually have advanced beyond what before already contained;
  // otherwise a standalone edit to an allowed generated file would look like a pure sync.
  const alreadyMerged = runGit(gitDir, ['merge-base', '--is-ancestor', baseTip, before], gitConfigArgs)
  if (alreadyMerged.status === 0) {
    return { pure: false, reason: 'base-did-not-advance', baseTip }
  }
  if (alreadyMerged.status !== 1) {
    return { pure: false, reason: 'ancestor-check-failed', baseTip }
  }

  const allowed = new Set(allowedGeneratedPaths)

  // Compute the exact automatic 3-way merge tree of (before, baseTip) with no manual edits.
  const mt = runGit(
    gitDir,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', before, baseTip],
    gitConfigArgs,
  )
  if (mt.status !== 0 && mt.status !== 1) {
    return { pure: false, reason: 'merge-tree-error', baseTip }
  }

  const mtTokens = mt.stdout.split('\0')
  const pureTree = (mtTokens[0] || '').trim().toLowerCase()
  if (!SHA_RE.test(pureTree)) {
    return { pure: false, reason: 'invalid-merge-tree-oid', baseTip }
  }

  const conflicts = mt.status === 1
    ? mtTokens.slice(1).filter(Boolean)
    : []
  const disallowedConflicts = conflicts.filter((p) => !allowed.has(p))
  if (disallowedConflicts.length > 0) {
    return {
      pure: false,
      reason: 'source-merge-conflict',
      baseTip,
      conflicts: disallowedConflicts,
    }
  }

  // Compare the pure 3-way merge tree against after's actual tree.
  // Any non-allowed difference (evil merge, manual edit, mode/symlink change, extra branch) fails closed.
  const diff = runGit(
    gitDir,
    ['diff-tree', '-r', '--no-renames', '--name-only', '-z', pureTree, after],
    gitConfigArgs,
  )
  if (diff.status !== 0) {
    return { pure: false, reason: 'diff-tree-error', baseTip }
  }

  const changedFiles = diff.stdout.split('\0').filter(Boolean)
  const disallowedChanges = changedFiles.filter((p) => !allowed.has(p))
  if (disallowedChanges.length > 0) {
    return {
      pure: false,
      reason: 'non-base-changes',
      baseTip,
      changedFiles: disallowedChanges,
    }
  }

  // Allowed generated files that differ must still be regular 100644 blobs (not deleted or symlinked).
  for (const filePath of changedFiles) {
    if (!isRegularBlob(gitDir, after, filePath, gitConfigArgs)) {
      return {
        pure: false,
        reason: 'invalid-generated-blob',
        baseTip,
        changedFiles,
      }
    }
  }

  return {
    pure: true,
    reason: changedFiles.length === 0 ? 'clean-base-merge' : 'base-merge-with-generated-rebuild',
    baseTip,
    changedFiles,
  }
}

function parseCliArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--git-dir') out.gitDir = argv[++i]
    else if (arg === '--before') out.beforeSha = argv[++i]
    else if (arg === '--after') out.afterSha = argv[++i]
    else if (arg === '--base-ref') out.baseRef = argv[++i]
  }
  return out
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const result = checkPureBaseSync(parseCliArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
