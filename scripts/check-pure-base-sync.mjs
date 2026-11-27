#!/usr/bin/env node
// Verifies whether a PR head (`afterSha`) is strictly a chain of pure base-branch merges
// on top of the last trusted approved commit (`beforeSha`), allowing deterministic rebuilds
// of generated bundles ONLY when those bundles actually conflicted or both merge sides
// touched their build inputs (and whose contents are independently verified byte-for-byte by CI).
//
// Fail-closed: any missing object, ambiguous ref, rebase/force-push, non-base merge,
// source conflict, evil merge, unprompted generated-file edit, or git error returns { pure: false }.

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/i
const UNSAFE_REF_RE = /[\s\x00-\x1f\x7f~^:?*[\\]|\.\./
// Git for Windows rejects Node's `\\.\nul` (`os.devNull`) as GIT_CONFIG_GLOBAL with EINVAL,
// while `/dev/null` is accepted portably by POSIX Git and Git for Windows alike.
const GIT_NULL_CONFIG = '/dev/null'

const DEFAULT_GENERATED_SPECS = {
  'ds-bot/client.js': [
    /^ds-bot\/client\.js$/,
    /^ds-bot\/src\/client\//,
    /^ds-bot\/src\/shared\//,
    /^ds-bot\/package\.json$/,
    /^ds-bot\/package-lock\.json$/,
    /^ds-bot\/scripts\/build-client\.mjs$/,
    /^ds-bot\/scripts\/build-release-notes\.mjs$/,
    /^link\//,
    /^CHANGELOG\.md$/,
  ],
  'ds-bot/src/shared/release-notes-generated.js': [
    /^ds-bot\/src\/shared\/release-notes-generated\.js$/,
    /^ds-bot\/src\/shared\/release-notes\.json$/,
    /^ds-bot\/src\/shared\/semver\.js$/,
    /^ds-bot\/package\.json$/,
    /^ds-bot\/scripts\/build-client\.mjs$/,
    /^ds-bot\/scripts\/build-release-notes\.mjs$/,
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
      GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG,
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
  })
}

function isCommit(gitDir, ref, extraArgs) {
  const res = runGit(gitDir, ['cat-file', '-t', '--end-of-options', ref], extraArgs)
  return res.status === 0 && res.stdout.trim() === 'commit'
}

function isAncestor(gitDir, ancestorRef, descendantRef, extraArgs) {
  const res = runGit(
    gitDir,
    ['merge-base', '--is-ancestor', '--end-of-options', ancestorRef, descendantRef],
    extraArgs,
  )
  if (res.status === 0) return true
  if (res.status === 1) return false
  return null
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

function getParents(gitDir, commitSha, extraArgs) {
  const res = runGit(gitDir, ['rev-list', '--parents', '-n', '1', '--end-of-options', commitSha], extraArgs)
  if (res.status !== 0) return null
  const tokens = res.stdout.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 1 || tokens[0].toLowerCase() !== commitSha) return null
  return tokens.slice(1).map((s) => s.toLowerCase())
}

function computeEligibleGenerated(gitDir, leftSha, rightSha, conflictSet, generatedSpecs, extraArgs) {
  const mbRes = runGit(gitDir, ['merge-base', '--end-of-options', leftSha, rightSha], extraArgs)
  if (mbRes.status !== 0) return null
  const commonBase = mbRes.stdout.trim().toLowerCase()
  if (!SHA_RE.test(commonBase)) return null

  const leftFiles = diffNames(gitDir, commonBase, leftSha, extraArgs)
  const rightFiles = diffNames(gitDir, commonBase, rightSha, extraArgs)
  if (leftFiles === null || rightFiles === null) return null

  const eligible = new Set()
  for (const [bundlePath, patterns] of Object.entries(generatedSpecs)) {
    if (
      conflictSet.has(bundlePath) ||
      (touchesAnyPattern(leftFiles, patterns) && touchesAnyPattern(rightFiles, patterns))
    ) {
      eligible.add(bundlePath)
    }
  }
  return eligible
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
 * Checks if `ancestorSha` is strictly an ancestor of `descendantSha` (true), equal/unrelated (false), or error (null).
 */
export function isStrictAncestor(gitDir, ancestorSha, descendantSha, gitConfigArgs = []) {
  const a = String(ancestorSha || '').trim().toLowerCase()
  const d = String(descendantSha || '').trim().toLowerCase()
  if (!SHA_RE.test(a) || !SHA_RE.test(d)) return null
  if (a === d) return false
  return isAncestor(gitDir, a, d, gitConfigArgs)
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
  if (isAncestor(gitDir, before, after, gitConfigArgs) !== true) {
    return { pure: false, reason: 'before-not-ancestor' }
  }

  // Walk the first-parent commit chain from before -> after so successive dev syncs are
  // verified in order against their actual merge bases (avoiding false conflicts on chained syncs).
  const chainRes = runGit(
    gitDir,
    ['rev-list', '--first-parent', '--reverse', '--end-of-options', `${before}..${after}`],
    gitConfigArgs,
  )
  if (chainRes.status !== 0) {
    return { pure: false, reason: 'rev-list-failed' }
  }
  const chain = chainRes.stdout.trim().split(/\r?\n/).filter(Boolean).map((s) => s.toLowerCase())
  if (chain.length === 0) {
    return { pure: false, reason: 'empty-chain' }
  }

  const allowed = new Set(Object.keys(generatedSpecs))
  let prev = before
  let latestBaseTip = null
  let pendingRebuildBundles = null
  const allGeneratedChanged = new Set()

  for (const commitSha of chain) {
    if (!SHA_RE.test(commitSha)) {
      return { pure: false, reason: 'invalid-chain-sha' }
    }
    const parents = getParents(gitDir, commitSha, gitConfigArgs)
    if (!parents || parents[0] !== prev) {
      return { pure: false, reason: 'broken-first-parent-chain' }
    }

    if (parents.length === 1) {
      // Allow a single generated-bundle rebuild commit immediately after a clean base merge
      // (e.g. `scripts/merge-dev.sh` "Rebuild client.js after merging dev").
      if (!pendingRebuildBundles || pendingRebuildBundles.size === 0) {
        return { pure: false, reason: 'non-merge-commit' }
      }
      const changed = diffNames(gitDir, prev, commitSha, gitConfigArgs)
      if (changed === null) {
        return { pure: false, reason: 'diff-tree-error', baseTip: latestBaseTip }
      }
      if (changed.length === 0) {
        return { pure: false, reason: 'empty-rebuild-commit', baseTip: latestBaseTip }
      }
      const disallowed = changed.filter((p) => !allowed.has(p))
      if (disallowed.length > 0) {
        return { pure: false, reason: 'non-base-changes', baseTip: latestBaseTip, changedFiles: disallowed }
      }
      const unexpected = changed.filter((p) => !pendingRebuildBundles.has(p))
      if (unexpected.length > 0) {
        return { pure: false, reason: 'unexpected-generated-change', baseTip: latestBaseTip, changedFiles: unexpected }
      }
      for (const filePath of changed) {
        if (!isRegularBlob(gitDir, commitSha, filePath, gitConfigArgs)) {
          return { pure: false, reason: 'invalid-generated-blob', baseTip: latestBaseTip, changedFiles: changed }
        }
        allGeneratedChanged.add(filePath)
      }
      pendingRebuildBundles = null
      prev = commitSha
      continue
    }

    if (parents.length !== 2) {
      return { pure: false, reason: 'octopus-merge-not-allowed' }
    }

    const baseTip = parents[1]
    // Second parent must be a commit on the PR's base branch.
    if (isAncestor(gitDir, baseTip, base, gitConfigArgs) !== true) {
      return { pure: false, reason: 'non-base-merge', baseTip }
    }
    // Base commits must actually advance beyond prev.
    const alreadyMerged = isAncestor(gitDir, baseTip, prev, gitConfigArgs)
    if (alreadyMerged !== false) {
      return { pure: false, reason: 'base-did-not-advance', baseTip }
    }

    const mt = runGit(
      gitDir,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--end-of-options', prev, baseTip],
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

    const conflicts = mt.status === 1 ? mtTokens.slice(1).filter(Boolean) : []
    const conflictSet = new Set(conflicts)
    const disallowedConflicts = conflicts.filter((p) => !allowed.has(p))
    if (disallowedConflicts.length > 0) {
      return { pure: false, reason: 'source-merge-conflict', baseTip, conflicts: disallowedConflicts }
    }

    const changedFiles = diffNames(gitDir, pureTree, commitSha, gitConfigArgs)
    if (changedFiles === null) {
      return { pure: false, reason: 'diff-tree-error', baseTip }
    }

    const disallowedChanges = changedFiles.filter((p) => !allowed.has(p))
    if (disallowedChanges.length > 0) {
      return { pure: false, reason: 'non-base-changes', baseTip, changedFiles: disallowedChanges }
    }

    const eligible = computeEligibleGenerated(gitDir, prev, baseTip, conflictSet, generatedSpecs, gitConfigArgs)
    if (eligible === null) {
      return { pure: false, reason: 'diff-tree-error', baseTip }
    }

    for (const filePath of changedFiles) {
      if (!eligible.has(filePath)) {
        return { pure: false, reason: 'unexpected-generated-change', baseTip, changedFiles: [filePath] }
      }
      if (!isRegularBlob(gitDir, commitSha, filePath, gitConfigArgs)) {
        return { pure: false, reason: 'invalid-generated-blob', baseTip, changedFiles }
      }
      allGeneratedChanged.add(filePath)
    }

    // If this was a clean merge (no rebuild folded into the merge commit itself), allow one
    // immediately following rebuild commit for eligible dual-sided generated bundles.
    pendingRebuildBundles = changedFiles.length === 0 ? eligible : null
    latestBaseTip = baseTip
    prev = commitSha
  }

  if (!latestBaseTip) {
    return { pure: false, reason: 'base-did-not-advance' }
  }

  const changedList = [...allGeneratedChanged]
  return {
    pure: true,
    reason: changedList.length === 0 ? 'clean-base-merge' : 'base-merge-with-generated-rebuild',
    baseTip: latestBaseTip,
    changedFiles: changedList,
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

function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const isDirectRun = process.argv[1] && safeRealpath(fileURLToPath(import.meta.url)) === safeRealpath(process.argv[1])
if (isDirectRun) {
  const result = checkPureBaseSync(parseCliArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
