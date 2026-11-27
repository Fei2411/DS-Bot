#!/usr/bin/env node
// Release milestone and PR merge-guard gate.
// Zero external dependencies (Node 24 ESM) so CI jobs can run it before npm ci.
//
// Modes:
//   1. Release milestone gate (default):
//      node scripts/check-release-milestone.mjs --version v0.4.2 [--repo Fei-Craft/DS-Bot]
//        [--ignore-pr <num>] [--base-ref origin/main] [--head-ref origin/dev]
//        [--allow-open] [--hotfix] [--allow-missing-token] [--json]
//   2. PR merge guard (--mode pr-guard):
//      node scripts/check-release-milestone.mjs --mode pr-guard --pr <num> --current-version 0.4.1
//        [--repo Fei-Craft/DS-Bot] [--allow-missing-token] [--json]
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REPO = 'Fei-Craft/DS-Bot'
export const DEFAULT_API_BASE = 'https://api.github.com'
export const PRODUCT_OK_LABEL = 'needs-product-ok'

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/giu

/** Parse a semver string (with optional leading "v"). Returns null when invalid. */
export function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const match = SEMVER_RE.exec(trimmed)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  const preRaw = match[4] ?? null
  if (preRaw !== null) {
    const preParts = preRaw.split('.')
    if (preParts.some(part => part === '')) return null
    return {
      major,
      minor,
      patch,
      pre: preParts,
      prerelease: true,
      version: `${String(major)}.${String(minor)}.${String(patch)}-${preRaw}`,
      tag: `v${String(major)}.${String(minor)}.${String(patch)}-${preRaw}`,
    }
  }
  const version = `${String(major)}.${String(minor)}.${String(patch)}`
  return {
    major,
    minor,
    patch,
    pre: null,
    prerelease: false,
    version,
    tag: `v${version}`,
  }
}

/** Standard semver ordering: -1 when a < b, 0 when equal, 1 when a > b. */
export function compareSemver(aRaw, bRaw) {
  const a = typeof aRaw === 'string' ? parseSemver(aRaw) : aRaw
  const b = typeof bRaw === 'string' ? parseSemver(bRaw) : bRaw
  if (a === null || b === null) {
    throw new Error(`Cannot compare non-semver values: ${String(aRaw)} vs ${String(bRaw)}`)
  }
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i += 1) {
    const left = a.pre[i]
    const right = b.pre[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNum = /^\d+$/u.test(left)
    const rightNum = /^\d+$/u.test(right)
    if (leftNum && rightNum) {
      const diff = BigInt(left) - BigInt(right)
      return diff < 0n ? -1 : 1
    }
    if (leftNum !== rightNum) return leftNum ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Extract issue numbers referenced with GitHub closing keywords (Fixes/Closes/Resolves #N).
 * Cross-repo references (other/repo#N) are ignored unless they match `repo`.
 */
export function extractClosingIssueNumbers(text, repo = DEFAULT_REPO) {
  const numbers = new Set()
  if (typeof text !== 'string' || text === '') return numbers
  const targetRepo = String(repo || '').toLowerCase()
  for (const match of text.matchAll(CLOSING_KEYWORD_RE)) {
    const explicitRepo = match[1] ? match[1].toLowerCase() : null
    if (explicitRepo && targetRepo && explicitRepo !== targetRepo) continue
    const num = Number(match[2])
    if (Number.isSafeInteger(num) && num > 0) numbers.add(num)
  }
  return numbers
}

/**
 * Collect issue numbers closed by commits in `baseRef..headRef` in a local git checkout.
 * Never throws when git history or refs are unavailable (returns an empty Set).
 */
export function collectClosingIssuesFromGit({
  baseRef = 'origin/main',
  headRef = 'HEAD',
  repo = DEFAULT_REPO,
  cwd = process.cwd(),
} = {}) {
  if (!headRef || !baseRef) return new Set()
  const res = spawnSync('git', ['log', '--format=%B', `${baseRef}..${headRef}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.status !== 0 || !res.stdout) return new Set()
  return extractClosingIssueNumbers(res.stdout, repo)
}

function isCommitAncestor(commitSha, headRef, cwd = process.cwd()) {
  if (!commitSha || !headRef || !/^[0-9a-f]{7,40}$/iu.test(commitSha)) return false
  const res = spawnSync('git', ['merge-base', '--is-ancestor', commitSha, headRef], {
    cwd,
    encoding: 'utf8',
  })
  return res.status === 0
}

/**
 * Find the GitHub Milestone matching `targetVersion` (prefers exact "vX.Y.Z", accepts "X.Y.Z").
 */
export function findMilestoneForVersion(milestones, targetVersion) {
  const parsed = parseSemver(targetVersion)
  if (parsed === null || !Array.isArray(milestones)) return null
  const exactTag = milestones.find(m => typeof m?.title === 'string' && m.title.trim() === parsed.tag)
  if (exactTag) return exactTag
  const bare = milestones.find(m => typeof m?.title === 'string' && m.title.trim() === parsed.version)
  return bare ?? null
}

/**
 * Pure evaluation of whether a release version passes the Milestone zero-open gate.
 * Open issues already fixed in `dev` (included in `resolvedIssueNumbers`, waiting for merge to
 * default branch `main` to auto-close) are listed as pending auto-close and do not block release.
 * Unmerged open PRs (except `ignorePrNumber`) always block release.
 */
export function evaluateReleaseMilestone({
  targetVersion,
  milestones = [],
  openItems = null,
  ignorePrNumber = null,
  resolvedIssueNumbers = [],
  allowOpen = false,
  hotfix = false,
  skipPrerelease = true,
}) {
  const parsed = parseSemver(targetVersion)
  if (parsed === null) {
    return {
      ok: false,
      skipped: false,
      reason: 'invalid-version',
      message: `Invalid target release version "${String(targetVersion)}"; expected semver like v0.4.2.`,
      blockingItems: [],
      resolvedPendingMain: [],
      milestone: null,
    }
  }

  if (skipPrerelease && parsed.prerelease) {
    return {
      ok: true,
      skipped: true,
      reason: 'prerelease',
      message: `Skipping milestone gate for prerelease ${parsed.tag}.`,
      blockingItems: [],
      resolvedPendingMain: [],
      milestone: null,
    }
  }

  const milestone = findMilestoneForVersion(milestones, parsed.tag)

  if (hotfix) {
    return {
      ok: true,
      skipped: true,
      reason: 'hotfix',
      message: milestone
        ? `Hotfix mode: skipping strict milestone gate for ${parsed.tag} (milestone #${String(milestone.number)} currently has ${String(milestone.open_issues ?? 0)} open item(s)).`
        : `Hotfix mode: skipping strict milestone gate for ${parsed.tag} (no milestone required for hotfix).`,
      blockingItems: [],
      resolvedPendingMain: [],
      milestone,
    }
  }

  if (milestone === null) {
    if (allowOpen) {
      return {
        ok: true,
        skipped: false,
        allowedOpen: true,
        reason: 'milestone-not-found-allowed',
        message: `Warning (--allow-open): GitHub Milestone "${parsed.tag}" does not exist.`,
        blockingItems: [],
        resolvedPendingMain: [],
        milestone: null,
      }
    }
    return {
      ok: false,
      skipped: false,
      reason: 'milestone-not-found',
      message: `GitHub Milestone "${parsed.tag}" was not found. Create Milestone "${parsed.tag}" and close all planned issues/PRs before releasing.`,
      blockingItems: [],
      resolvedPendingMain: [],
      milestone: null,
    }
  }

  const reportedOpenCount = Number(milestone.open_issues ?? 0)
  const ignoreNum = Number.isSafeInteger(ignorePrNumber) && ignorePrNumber > 0 ? ignorePrNumber : null
  const resolvedSet = new Set(
    [...(resolvedIssueNumbers || [])].map(Number).filter(n => Number.isSafeInteger(n) && n > 0),
  )

  let blockingItems = []
  const resolvedPendingMain = []
  let ignoredSelfPrCount = 0

  if (Array.isArray(openItems)) {
    for (const item of openItems) {
      if (!item || item.state === 'closed') continue
      const num = Number(item.number)
      const isPr = Boolean(item.pull_request)
      if (ignoreNum !== null && num === ignoreNum && isPr) {
        ignoredSelfPrCount += 1
        continue
      }
      const entry = {
        number: num,
        title: String(item.title || '').trim(),
        type: isPr ? 'PR' : 'Issue',
        url: String(item.html_url || ''),
      }
      // Only non-PR issues that already have a closing commit/PR in this release branch are exempted.
      if (!isPr && resolvedSet.has(num)) {
        resolvedPendingMain.push(entry)
        continue
      }
      blockingItems.push(entry)
    }
    blockingItems.sort((a, b) => a.number - b.number)
    resolvedPendingMain.sort((a, b) => a.number - b.number)
  } else if (reportedOpenCount > 0) {
    // Fail-closed when open_issues > 0 and caller did not supply the itemized list.
    blockingItems = Array.from({ length: reportedOpenCount }, (_, idx) => ({
      number: 0,
      title: `Unresolved open item #${String(idx + 1)} (item list unavailable)`,
      type: 'Item',
      url: '',
    }))
  }

  const accountedExemptions = ignoredSelfPrCount + resolvedPendingMain.length
  const expectedMinBlocking = Math.max(0, reportedOpenCount - accountedExemptions)
  const effectiveCount = Math.max(blockingItems.length, expectedMinBlocking)

  const formatList = (list) => list.map(item => (
    item.number > 0
      ? `  - [${item.type}] #${String(item.number)} ${item.title}${item.url ? ` (${item.url})` : ''}`
      : `  - ${item.title}`
  )).join('\n')

  if (effectiveCount > 0) {
    const detail = blockingItems.length > 0 ? `\n${formatList(blockingItems)}` : ''
    const resolvedNote = resolvedPendingMain.length > 0
      ? `\nAlready fixed in release branch (pending auto-close on merge to main):\n${formatList(resolvedPendingMain)}`
      : ''
    if (allowOpen) {
      return {
        ok: true,
        skipped: false,
        allowedOpen: true,
        reason: 'open-items-allowed',
        message: `Warning (--allow-open): Milestone "${milestone.title}" still has ${String(effectiveCount)} open item(s):${detail}${resolvedNote}`,
        blockingItems,
        resolvedPendingMain,
        milestone,
      }
    }
    return {
      ok: false,
      skipped: false,
      reason: 'open-items-remaining',
      message: `Milestone "${milestone.title}" still has ${String(effectiveCount)} open item(s); close or move them before releasing ${parsed.tag}:${detail}${resolvedNote}`,
      blockingItems,
      resolvedPendingMain,
      milestone,
    }
  }

  const resolvedSuffix = resolvedPendingMain.length > 0
    ? `\nResolved in release branch (will auto-close on merge to main):\n${formatList(resolvedPendingMain)}`
    : ''

  return {
    ok: true,
    skipped: false,
    reason: 'milestone-clean',
    message: `Milestone "${milestone.title}" passed (0 blocking open items, ${String(resolvedPendingMain.length)} fixed pending merge to main, ${String(milestone.closed_issues ?? 0)} closed).${resolvedSuffix}`,
    blockingItems: [],
    resolvedPendingMain,
    milestone,
  }
}

/**
 * Determine the active target release Milestone for `dev`:
 * the lowest open stable semver milestone strictly greater than `currentVersion`.
 */
export function resolveActiveDevMilestone(currentVersion, milestones = []) {
  const current = parseSemver(currentVersion)
  if (current === null || !Array.isArray(milestones)) return null
  const candidates = []
  for (const m of milestones) {
    if (!m || m.state !== 'open') continue
    const parsed = parseSemver(m.title)
    if (parsed === null || parsed.prerelease) continue
    if (compareSemver(parsed, current) > 0) {
      candidates.push({ milestone: m, parsed })
    }
  }
  candidates.sort((a, b) => compareSemver(a.parsed, b.parsed))
  return candidates[0] ?? null
}

/**
 * Pure PR merge-guard evaluation:
 *   1. Blocks any PR carrying the `needs-product-ok` label.
 *   2. Blocks any PR targeting `dev` whose Milestone is ahead of the active `dev` release Milestone.
 */
export function evaluatePrMergeGuard({
  baseRef,
  labels = [],
  prMilestoneTitle = null,
  currentVersion,
  milestones = [],
}) {
  const normalizedLabels = labels.map(l => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean)
  const reasons = []

  const hasNeedsProductOk = normalizedLabels.some(name => name.toLowerCase() === PRODUCT_OK_LABEL)
  if (hasNeedsProductOk) {
    reasons.push({
      code: 'needs-product-ok',
      message: `PR has the "${PRODUCT_OK_LABEL}" label and requires maintainer product sign-off before merging.`,
    })
  }

  let activeMilestone = null
  let prMilestoneParsed = null
  if (baseRef === 'dev' && typeof prMilestoneTitle === 'string' && prMilestoneTitle.trim() !== '') {
    prMilestoneParsed = parseSemver(prMilestoneTitle)
    const active = resolveActiveDevMilestone(currentVersion, milestones)
    activeMilestone = active ? active.parsed.tag : null
    if (prMilestoneParsed !== null) {
      if (active !== null && compareSemver(prMilestoneParsed, active.parsed) > 0) {
        reasons.push({
          code: 'future-milestone',
          message: `PR targets "dev" with future Milestone "${prMilestoneParsed.tag}", ahead of active release Milestone "${active.parsed.tag}". Wait until "${active.parsed.tag}" is cut or retarget the Milestone.`,
        })
      } else if (active === null) {
        const current = parseSemver(currentVersion)
        if (current !== null && compareSemver(prMilestoneParsed, current) > 0) {
          const matchingOpen = milestones.some(m => m?.state === 'open' && parseSemver(m.title)?.version === prMilestoneParsed.version)
          if (!matchingOpen) {
            reasons.push({
              code: 'future-milestone',
              message: `PR targets "dev" with Milestone "${prMilestoneParsed.tag}", which is ahead of current version "${current.tag}" and not an active open Milestone.`,
            })
          }
        }
      }
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      blockedByProductOk: hasNeedsProductOk,
      blockedByFutureMilestone: reasons.some(r => r.code === 'future-milestone'),
      activeMilestone,
      prMilestone: prMilestoneParsed?.tag ?? prMilestoneTitle ?? null,
      reasons,
      summary: reasons.map(r => r.message).join(' '),
    }
  }

  return {
    ok: true,
    blockedByProductOk: false,
    blockedByFutureMilestone: false,
    activeMilestone,
    prMilestone: prMilestoneParsed?.tag ?? prMilestoneTitle ?? null,
    reasons: [],
    summary: activeMilestone
      ? `PR merge guard passed (active dev milestone: ${activeMilestone}).`
      : 'PR merge guard passed.',
  }
}

export class GitHubApiError extends Error {
  constructor(status, url, detail) {
    super(`GitHub API HTTP ${String(status)} for ${url}${detail ? `: ${detail}` : ''}`)
    this.name = 'GitHubApiError'
    this.status = status
    this.url = url
  }
}

function assertSameOrigin(targetUrl, allowedOrigin) {
  const parsed = new URL(targetUrl)
  if (parsed.origin !== allowedOrigin) {
    throw new Error(`Refusing cross-origin GitHub pagination redirect to ${parsed.origin} (expected ${allowedOrigin})`)
  }
  return parsed.href
}

async function fetchJson(url, { token, allowedOrigin, fetchImpl = globalThis.fetch } = {}) {
  if (allowedOrigin) assertSameOrigin(url, allowedOrigin)
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ds-bot-release-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetchImpl(url, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GitHubApiError(res.status, url, text.slice(0, 300))
  }
  return { data: await res.json(), headers: res.headers }
}

async function paginateGitHub(initialUrl, options) {
  const allowedOrigin = new URL(initialUrl).origin
  const out = []
  let nextUrl = initialUrl
  let pages = 0
  while (nextUrl && pages < 50) {
    pages += 1
    assertSameOrigin(nextUrl, allowedOrigin)
    const { data, headers } = await fetchJson(nextUrl, { ...options, allowedOrigin })
    if (!Array.isArray(data)) break
    out.push(...data)
    const link = headers.get('link') || ''
    const nextMatch = /<([^>]+)>;\s*rel="next"/u.exec(link)
    if (nextMatch) {
      nextUrl = assertSameOrigin(nextMatch[1], allowedOrigin)
    } else {
      nextUrl = null
    }
  }
  return out
}

/**
 * Determine whether an open issue has a merged PR (targeting `dev`, carrying a closing keyword
 * for `issueNumber`, and whose merge commit is an ancestor of `headRef` when checked locally)
 * so it will auto-close as soon as the release merges to `main`.
 */
async function isIssueFixedInDevViaTimeline({
  issueNumber,
  repo,
  apiBase,
  token,
  fetchImpl,
  headRef,
  cwd,
  checkAncestry,
}) {
  const base = apiBase.replace(/\/+$/u, '')
  const allowedOrigin = new URL(base).origin
  const events = await paginateGitHub(
    `${base}/repos/${repo}/issues/${String(issueNumber)}/timeline?per_page=100`,
    { token, fetchImpl },
  )
  const candidatePrs = new Set()
  for (const ev of events) {
    if (ev?.event !== 'cross-referenced') continue
    const src = ev?.source?.issue
    if (!src?.pull_request || src.state !== 'closed') continue
    if (src.repository?.full_name && src.repository.full_name.toLowerCase() !== repo.toLowerCase()) continue
    const prNum = Number(src.number)
    if (Number.isSafeInteger(prNum) && prNum > 0) candidatePrs.add(prNum)
  }

  for (const prNum of candidatePrs) {
    const { data: pr } = await fetchJson(
      `${base}/repos/${repo}/pulls/${String(prNum)}`,
      { token, allowedOrigin, fetchImpl },
    )
    if (!pr?.merged || !pr.merged_at) continue
    const closedByBody = extractClosingIssueNumbers(`${pr.title || ''}\n${pr.body || ''}`, repo)
    if (!closedByBody.has(issueNumber)) continue
    if (checkAncestry) {
      if (isCommitAncestor(pr.merge_commit_sha, headRef, cwd)) return true
    } else if (pr.base?.ref === 'dev') {
      return true
    }
  }
  return false
}

export async function runReleaseMilestoneCheck({
  version,
  repo = DEFAULT_REPO,
  token = '',
  apiBase = DEFAULT_API_BASE,
  ignorePrNumber = null,
  baseRef = 'origin/main',
  headRef = '',
  cwd = process.cwd(),
  resolvedIssueNumbers = null,
  allowOpen = false,
  hotfix = false,
  allowMissingToken = false,
  fetchImpl = globalThis.fetch,
}) {
  const parsed = parseSemver(version)
  if (parsed === null || parsed.prerelease) {
    return evaluateReleaseMilestone({
      targetVersion: version,
      milestones: [],
      openItems: [],
      ignorePrNumber,
      allowOpen,
      hotfix,
    })
  }

  const base = apiBase.replace(/\/+$/u, '')
  let milestones
  let openItems = []
  const resolvedSet = new Set(
    [...(resolvedIssueNumbers || [])].map(Number).filter(n => Number.isSafeInteger(n) && n > 0),
  )

  try {
    milestones = await paginateGitHub(
      `${base}/repos/${repo}/milestones?state=all&per_page=100`,
      { token, fetchImpl },
    )

    const milestone = findMilestoneForVersion(milestones, parsed.tag)
    if (milestone !== null && Number(milestone.open_issues ?? 0) > 0 && !hotfix) {
      openItems = await paginateGitHub(
        `${base}/repos/${repo}/issues?milestone=${String(milestone.number)}&state=open&per_page=100`,
        { token, fetchImpl },
      )

      const openNonPrIssues = openItems.filter(item => item && item.state !== 'closed' && !item.pull_request)
      if (openNonPrIssues.length > 0 && headRef) {
        const fromGit = collectClosingIssuesFromGit({ baseRef, headRef, repo, cwd })
        for (const num of fromGit) resolvedSet.add(num)

        const hasLocalHead = spawnSync('git', ['rev-parse', '--verify', `${headRef}^{commit}`], { cwd, encoding: 'utf8' }).status === 0
        for (const issue of openNonPrIssues) {
          const num = Number(issue.number)
          if (resolvedSet.has(num)) continue
          const fixedInDev = await isIssueFixedInDevViaTimeline({
            issueNumber: num,
            repo,
            apiBase: base,
            token,
            fetchImpl,
            headRef,
            cwd,
            checkAncestry: hasLocalHead,
          })
          if (fixedInDev) resolvedSet.add(num)
        }
      }
    }
  } catch (err) {
    // On fork PRs github.token may be present but restricted (401/403); gracefully skip only when allowed.
    if (allowMissingToken && err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
      return {
        ok: true,
        skipped: true,
        reason: 'restricted-token',
        message: `Skipping milestone API check due to restricted/missing token (${err.message}).`,
        blockingItems: [],
        resolvedPendingMain: [],
        milestone: null,
      }
    }
    throw err
  }

  return evaluateReleaseMilestone({
    targetVersion: version,
    milestones,
    openItems,
    ignorePrNumber,
    resolvedIssueNumbers: [...resolvedSet],
    allowOpen,
    hotfix,
  })
}

export async function runPrMergeGuard({
  prNumber,
  currentVersion,
  repo = DEFAULT_REPO,
  token = '',
  apiBase = DEFAULT_API_BASE,
  allowMissingToken = false,
  fetchImpl = globalThis.fetch,
}) {
  const base = apiBase.replace(/\/+$/u, '')
  const allowedOrigin = new URL(base).origin
  try {
    const [{ data: pr }, milestones] = await Promise.all([
      fetchJson(`${base}/repos/${repo}/pulls/${String(prNumber)}`, { token, allowedOrigin, fetchImpl }),
      paginateGitHub(`${base}/repos/${repo}/milestones?state=open&per_page=100`, { token, fetchImpl }),
    ])
    return {
      ...evaluatePrMergeGuard({
        baseRef: String(pr?.base?.ref || ''),
        labels: Array.isArray(pr?.labels) ? pr.labels : [],
        prMilestoneTitle: pr?.milestone?.title ?? null,
        currentVersion,
        milestones,
      }),
      headSha: String(pr?.head?.sha || ''),
      baseRef: String(pr?.base?.ref || ''),
      state: String(pr?.state || ''),
    }
  } catch (err) {
    if (allowMissingToken && err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
      return {
        ok: true,
        skipped: true,
        reason: 'restricted-token',
        summary: `Skipping PR merge guard API check due to restricted/missing token (${err.message}).`,
        reasons: [],
      }
    }
    throw err
  }
}

export function parseCliArgs(argv, env = process.env) {
  const opts = {
    mode: 'release',
    version: '',
    prNumber: null,
    currentVersion: '',
    repo: env.GITHUB_REPOSITORY || DEFAULT_REPO,
    ignorePrNumber: null,
    baseRef: 'origin/main',
    headRef: '',
    allowOpen: false,
    hotfix: false,
    allowMissingToken: false,
    json: false,
    apiBase: env.GITHUB_API_URL || DEFAULT_API_BASE,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mode') opts.mode = argv[++i] ?? ''
    else if (arg === '--version') opts.version = argv[++i] ?? ''
    else if (arg === '--pr') opts.prNumber = Number(argv[++i])
    else if (arg === '--current-version') opts.currentVersion = argv[++i] ?? ''
    else if (arg === '--repo') opts.repo = argv[++i] ?? ''
    else if (arg === '--ignore-pr') opts.ignorePrNumber = Number(argv[++i])
    else if (arg === '--base-ref') opts.baseRef = argv[++i] ?? 'origin/main'
    else if (arg === '--head-ref') opts.headRef = argv[++i] ?? ''
    else if (arg === '--api-base') opts.apiBase = argv[++i] ?? DEFAULT_API_BASE
    else if (arg === '--allow-open') opts.allowOpen = true
    else if (arg === '--hotfix') opts.hotfix = true
    else if (arg === '--allow-missing-token') opts.allowMissingToken = true
    else if (arg === '--json') opts.json = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return opts
}

async function main(argv) {
  let opts
  try {
    opts = parseCliArgs(argv)
  } catch (err) {
    console.error(`check-release-milestone: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  try {
    let result
    if (opts.mode === 'pr-guard') {
      if (!Number.isSafeInteger(opts.prNumber) || opts.prNumber < 1 || !opts.currentVersion) {
        console.error('check-release-milestone: --mode pr-guard requires --pr <number> and --current-version <semver>')
        process.exit(2)
      }
      result = await runPrMergeGuard({
        prNumber: opts.prNumber,
        currentVersion: opts.currentVersion,
        repo: opts.repo,
        token,
        apiBase: opts.apiBase,
        allowMissingToken: opts.allowMissingToken,
      })
    } else if (opts.mode === 'release') {
      if (!opts.version) {
        console.error('check-release-milestone: --version <vX.Y.Z> is required')
        process.exit(2)
      }
      result = await runReleaseMilestoneCheck({
        version: opts.version,
        repo: opts.repo,
        token,
        apiBase: opts.apiBase,
        ignorePrNumber: opts.ignorePrNumber,
        baseRef: opts.baseRef,
        headRef: opts.headRef,
        allowOpen: opts.allowOpen,
        hotfix: opts.hotfix,
        allowMissingToken: opts.allowMissingToken,
      })
    } else {
      console.error(`check-release-milestone: unsupported --mode "${opts.mode}"`)
      process.exit(2)
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      const text = result.message || result.summary || ''
      if (result.ok) {
        console.log(text)
      } else {
        console.error(text)
      }
    }
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(`check-release-milestone: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
