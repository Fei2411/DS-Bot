#!/usr/bin/env node
// Verifies whether a PR head (`afterSha`) is strictly a pure merge of newer commits
// from the PR's base branch on top of the last trusted approved commit (`beforeSha`),
// allowing deterministic rebuilds of generated bundles ONLY when those bundles actually
// conflicted or both merge sides touched their build inputs (and whose contents are
// independently verified byte-for-byte by CI).
//
// Fail-closed: any missing object, ambiguous ref, rebase/force-push, non-base merge,
// source conflict, evil merge, unprompted generated-file edit, or git error returns { pure: false }.

import { spawnSync } from 'node:child_process'
import { devNull } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/i
const UNSAFE_REF_RE = /[\s\x00-\x1f\x7f~^:?*[\\]|\.\./

const DEFAULT_GENERATED_SPECS = {
  'ds-bot/client.js': [
    /^ds-bot\/client\.js$/,
    /^ds-bot\/src\/client\//,
    /^ds-bot\/src\/shared\//,
    /^ds-bot\/package-lock\.json$/,
    /^ds-bot\/scripts\/build-client\.mjs$/,
    /^link\//,
    /^CHANGELOG\.md$/,
  ],
  'ds-bot/src/shared/release-notes-generated.js': [
    /^ds-bot\/src\/shared\/release-notes-generated\.js$/,
    /^ds-bot\/src\/shared\/release-notes\.json$/,
    /^ds-bot\/scripts\/build-client\.mjs$/,
    /^CHANGELOG\.md$/,
  ],
}

function isSafeRef(ref) {
  return Boolean(ref && !ref.startsWith('-') && !UNSAFE_REF_RE.test(ref))
}

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
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
  })
}

function isCommit(gitDir, ref, extraArgs) {
  const res = runGit(gitDir, ['cat-file', '-t', '--end-of-options', ref], extraArgs)
  return res.status === 0 && res.stdout.trim() === 'commit'
}

function isRegularBlob(gitDir, commitSha, filePath, extraArgs) {
  const res = runGit(gitDir, ['ls-tree', '-z', '--end-of-options', commitSha, '--', filePath], extraArgs)
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

function diffNames(gitDir, fromRef, toRef, extraArgs) {
  const res = runGit(
    gitDir,
    ['diff-tree', '-r', '--no-renames', '--name-only', '-z', '--end-of-options', fromRef, toRef],
    extraArgs,
  )
  if (res.status !== 0) return null
  return res.stdout.split('\0').filter(Boolean)
}

function touchesAnyPattern(files, patterns) {
  return files.some((file) => patterns.some((re) => re.test(file)))
}

/**
 * Resolves a 7-40 hex commit SHA prefix uniquely in `gitDir` (fails closed on missing or ambiguous prefix).
 */
export function resolveUniqueCommit(gitDir, shaPrefix, gitConfigArgs = []) {
  const raw = String(shaPrefix || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(raw)) return null
  const res = runGit(gitDir, ['rev-parse', '--verify', '--end-of-options', `${raw}^{commit}`], gitConfigArgs)
  if (res.status !== 0) return null
  const resolved = res.stdout.trim().toLowerCase()
  return SHA_RE.test(resolved) ? resolved : null
}

/**
 * @param {object} options
 * @param {string} options.gitDir Path to a bare (or .git) repository containing baseRef and afterSha.
 * @param {string} options.beforeSha 40-hex commit SHA of the last trusted approved commit.
 * @param {string} options.afterSha 40-hex commit SHA of the live PR head.
 * @param {string} options.baseRef Git ref for the PR base branch (e.g. refs/heads/dev).
 * @param {Record<string, RegExp[]>} [options.generatedSpecs] Map of allowed generated path -> input patterns.
 * @param {string[]} [options.gitConfigArgs] Extra `-c key=val` args passed to git (e.g. promisor auth headers).
 */
export function checkPureBaseSync({
  gitDir,
  beforeSha,
  afterSha,
  baseRef,
  generatedSpecs = DEFAULT_GENERATED_SPECS,
  gitConfigArgs = [],
}) {
  const before = String(beforeSha || '').trim().toLowerCase()
  const after = String(afterSha || '').trim().toLowerCase()
  const base = String(baseRef || '').trim()

  if (!gitDir || !base) return { pure: false, reason: 'missing-arguments' }
  if (!isSafeRef(base)) return { pure: false, reason: 'invalid-base-ref' }
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
  const anc = runGit(gitDir, ['merge-base', '--is-ancestor', '--end-of-options', before, after], gitConfigArgs)
  if (anc.status !== 0) {
    return { pure: false, reason: 'before-not-ancestor' }
  }

  // Find the newest base-branch commit merged into after.
  const mb = runGit(gitDir, ['merge-base', '--end-of-options', after, base], gitConfigArgs)
  if (mb.status !== 0) {
    return { pure: false, reason: 'no-base-merge-base' }
  }
  const baseTip = mb.stdout.trim().toLowerCase()
  if (!SHA_RE.test(baseTip)) {
    return { pure: false, reason: 'invalid-base-tip' }
  }

  // Base commits must actually have advanced beyond what before already contained;
  // otherwise a standalone edit to a generated file would look like a pure sync.
  const alreadyMerged = runGit(gitDir, ['merge-base', '--is-ancestor', '--end-of-options', baseTip, before], gitConfigArgs)
  if (alreadyMerged.status === 0) {
    return { pure: false, reason: 'base-did-not-advance', baseTip }
  }
  if (alreadyMerged.status !== 1) {
    return { pure: false, reason: 'ancestor-check-failed', baseTip }
  }

  const allowed = new Set(Object.keys(generatedSpecs))

  // Compute the exact automatic 3-way merge tree of (before, baseTip) with no manual edits.
  const mt = runGit(
    gitDir,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--end-of-options', before, baseTip],
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
  const conflictSet = new Set(conflicts)
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
  const changedFiles = diffNames(gitDir, pureTree, after, gitConfigArgs)
  if (changedFiles === null) {
    return { pure: false, reason: 'diff-tree-error', baseTip }
  }

  const disallowedChanges = changedFiles.filter((p) => !allowed.has(p))
  if (disallowedChanges.length > 0) {
    return {
      pure: false,
      reason: 'non-base-changes',
      baseTip,
      changedFiles: disallowedChanges,
    }
  }

  if (changedFiles.length > 0) {
    // Defense in depth: only allow a generated bundle to differ from the automatic merge tree
    // if that bundle actually conflicted OR both sides of the merge touched its build inputs.
    const commonBaseRes = runGit(gitDir, ['merge-base', '--end-of-options', before, baseTip], gitConfigArgs)
    if (commonBaseRes.status !== 0) {
      return { pure: false, reason: 'no-common-merge-base', baseTip }
    }
    const commonBase = commonBaseRes.stdout.trim().toLowerCase()
    if (!SHA_RE.test(commonBase)) {
      return { pure: false, reason: 'invalid-common-merge-base', baseTip }
    }

    const prFiles = diffNames(gitDir, commonBase, before, gitConfigArgs)
    const baseFiles = diffNames(gitDir, commonBase, baseTip, gitConfigArgs)
    if (prFiles === null || baseFiles === null) {
      return { pure: false, reason: 'diff-tree-error', baseTip }
    }

    for (const filePath of changedFiles) {
      const patterns = generatedSpecs[filePath] || []
      const rebuildExpected =
        conflictSet.has(filePath) ||
        (touchesAnyPattern(prFiles, patterns) && touchesAnyPattern(baseFiles, patterns))
      if (!rebuildExpected) {
        return {
          pure: false,
          reason: 'unexpected-generated-change',
          baseTip,
          changedFiles: [filePath],
        }
      }
      if (!isRegularBlob(gitDir, after, filePath, gitConfigArgs)) {
        return {
          pure: false,
          reason: 'invalid-generated-blob',
          baseTip,
          changedFiles,
        }
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
