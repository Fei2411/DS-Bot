#!/usr/bin/env node
// Release milestone and PR merge-guard gate.
// Zero external dependencies (Node 24 ESM) so CI jobs can run it before npm ci.
//
// Modes:
//   1. Release milestone gate (default):
//      node scripts/check-release-milestone.mjs --version v0.4.2 [--repo Fei-Craft/DS-Bot]
//        [--ignore-pr <num>] [--allow-open] [--hotfix] [--allow-missing-token] [--json]
//   2. PR merge guard (--mode pr-guard):
//      node scripts/check-release-milestone.mjs --mode pr-guard --pr <num> --current-version 0.4.1
//        [--repo Fei-Craft/DS-Bot] [--json]
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REPO = 'Fei-Craft/DS-Bot'
export const DEFAULT_API_BASE = 'https://api.github.com'
export const PRODUCT_OK_LABEL = 'needs-product-ok'

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

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
 */
export function evaluateReleaseMilestone({
  targetVersion,
  milestones = [],
  openItems = null,
  ignorePrNumber = null,
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
        milestone: null,
      }
    }
    return {
      ok: false,
      skipped: false,
      reason: 'milestone-not-found',
      message: `GitHub Milestone "${parsed.tag}" was not found. Create Milestone "${parsed.tag}" and close all planned issues/PRs before releasing.`,
      blockingItems: [],
      milestone: null,
    }
  }

  const reportedOpenCount = Number(milestone.open_issues ?? 0)
  const ignoreNum = Number.isSafeInteger(ignorePrNumber) && ignorePrNumber > 0 ? ignorePrNumber : null

  let blockingItems = []
  if (Array.isArray(openItems)) {
    blockingItems = openItems
      .filter((item) => {
        if (!item || item.state === 'closed') return false
        if (ignoreNum !== null && Number(item.number) === ignoreNum && Boolean(item.pull_request)) {
          return false
        }
        return true
      })
      .map(item => ({
        number: Number(item.number),
        title: String(item.title || '').trim(),
        type: item.pull_request ? 'PR' : 'Issue',
        url: String(item.html_url || ''),
      }))
      .sort((a, b) => a.number - b.number)
  } else if (reportedOpenCount > 0) {
    // Fail-closed when open_issues > 0 and caller did not supply the itemized list.
    blockingItems = Array.from({ length: reportedOpenCount }, (_, idx) => ({
      number: 0,
      title: `Unresolved open item #${String(idx + 1)} (item list unavailable)`,
      type: 'Item',
      url: '',
    }))
  }

  // Guard against pagination truncation or stale list when milestone reports more open items than ignored PR.
  const expectedMinBlocking = ignoreNum !== null
    ? Math.max(0, reportedOpenCount - (Array.isArray(openItems) && openItems.some(i => Number(i?.number) === ignoreNum && Boolean(i?.pull_request)) ? 1 : 0))
    : reportedOpenCount

  const effectiveCount = Math.max(blockingItems.length, expectedMinBlocking)
  if (effectiveCount > 0) {
    const summaryLines = blockingItems.map(item => (
      item.number > 0
        ? `  - [${item.type}] #${String(item.number)} ${item.title}${item.url ? ` (${item.url})` : ''}`
        : `  - ${item.title}`
    ))
    const detail = summaryLines.length > 0 ? `\n${summaryLines.join('\n')}` : ''
    if (allowOpen) {
      return {
        ok: true,
        skipped: false,
        allowedOpen: true,
        reason: 'open-items-allowed',
        message: `Warning (--allow-open): Milestone "${milestone.title}" still has ${String(effectiveCount)} open item(s):${detail}`,
        blockingItems,
        milestone,
      }
    }
    return {
      ok: false,
      skipped: false,
      reason: 'open-items-remaining',
      message: `Milestone "${milestone.title}" still has ${String(effectiveCount)} open item(s); close or move them before releasing ${parsed.tag}:${detail}`,
      blockingItems,
      milestone,
    }
  }

  return {
    ok: true,
    skipped: false,
    reason: 'milestone-clean',
    message: `Milestone "${milestone.title}" passed (0 open items remaining, ${String(milestone.closed_issues ?? 0)} closed).`,
    blockingItems: [],
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

async function fetchJson(url, { token, fetchImpl = globalThis.fetch } = {}) {
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
  const out = []
  let nextUrl = initialUrl
  let pages = 0
  while (nextUrl && pages < 50) {
    pages += 1
    const { data, headers } = await fetchJson(nextUrl, options)
    if (!Array.isArray(data)) break
    out.push(...data)
    const link = headers.get('link') || ''
    const nextMatch = /<([^>]+)>;\s*rel="next"/u.exec(link)
    nextUrl = nextMatch ? nextMatch[1] : null
  }
  return out
}

export async function runReleaseMilestoneCheck({
  version,
  repo = DEFAULT_REPO,
  token = '',
  apiBase = DEFAULT_API_BASE,
  ignorePrNumber = null,
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
  try {
    milestones = await paginateGitHub(
      `${base}/repos/${repo}/milestones?state=all&per_page=100`,
      { token, fetchImpl },
    )
  } catch (err) {
    if (allowMissingToken && !token && err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
      return {
        ok: true,
        skipped: true,
        reason: 'missing-token-rate-limited',
        message: `Skipping milestone API check without GH_TOKEN (${err.message}).`,
        blockingItems: [],
        milestone: null,
      }
    }
    throw err
  }

  const milestone = findMilestoneForVersion(milestones, parsed.tag)
  let openItems = []
  if (milestone !== null && Number(milestone.open_issues ?? 0) > 0 && !hotfix) {
    openItems = await paginateGitHub(
      `${base}/repos/${repo}/issues?milestone=${String(milestone.number)}&state=open&per_page=100`,
      { token, fetchImpl },
    )
  }

  return evaluateReleaseMilestone({
    targetVersion: version,
    milestones,
    openItems,
    ignorePrNumber,
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
  fetchImpl = globalThis.fetch,
}) {
  const base = apiBase.replace(/\/+$/u, '')
  const [{ data: pr }, milestones] = await Promise.all([
    fetchJson(`${base}/repos/${repo}/pulls/${String(prNumber)}`, { token, fetchImpl }),
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
}

export function parseCliArgs(argv, env = process.env) {
  const opts = {
    mode: 'release',
    version: '',
    prNumber: null,
    currentVersion: '',
    repo: env.GITHUB_REPOSITORY || DEFAULT_REPO,
    ignorePrNumber: null,
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
