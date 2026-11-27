// Pure offline release-notes utilities shared across host, desktop UI, plugin client, and mobile.
import { RELEASE_NOTES } from './release-notes-generated.js'
import { cleanSemver, compareSemver, isNewerRelease, parseSemver } from './semver.js'

export { cleanSemver, compareSemver, isNewerRelease, parseSemver, RELEASE_NOTES }

/**
 * @typedef {{ intro?: string, items: string[], outro?: string } | string[]} ReleaseLocaleNotes
 * @typedef {{ version: string, date?: string, notes: Record<string, ReleaseLocaleNotes | undefined> }} ReleaseNotesEntry
 */

/**
 * Look up one release entry by normalized SemVer.
 * @param {string | null | undefined} version
 * @param {ReadonlyArray<ReleaseNotesEntry>} [releases]
 * @returns {ReleaseNotesEntry | null}
 */
export function getReleaseEntry(version, releases = RELEASE_NOTES) {
  const clean = cleanSemver(version)
  if (clean === null || !Array.isArray(releases)) return null
  return releases.find(entry => cleanSemver(entry?.version) === clean) ?? null
}

/**
 * Determine whether the current release should be shown automatically after an upgrade.
 * - Unknown current version -> []
 * - Existing install upgrading from before lastSeenVersion existed (`lastSeenVersion == null`),
 *   or upgrading from any older version (`lastSeenVersion < current`):
 *   return `[current]` when the current release has bundled notes (never pile older versions).
 * - Same version, build-metadata-only change, or downgrade (`lastSeenVersion >= current`): [].
 * @param {{ current?: string | null, lastSeenVersion?: string | null, releases?: ReadonlyArray<ReleaseNotesEntry> }} [options]
 * @returns {string[]}
 */
export function pendingReleaseVersions({ current, lastSeenVersion = null, releases = RELEASE_NOTES } = {}) {
  const cur = cleanSemver(current)
  if (cur === null || !Array.isArray(releases) || releases.length === 0) return []
  const seen = lastSeenVersion === null || lastSeenVersion === undefined || lastSeenVersion === ''
    ? null
    : cleanSemver(lastSeenVersion)

  if (seen !== null && compareSemver(cur, seen) <= 0) return []

  const match = getReleaseEntry(cur, releases)
  return match ? [match.version] : []
}

function normalizeNoteValue(value) {
  if (Array.isArray(value)) {
    const items = value.filter(item => typeof item === 'string' && item.trim() !== '')
    return items.length > 0 ? { items } : null
  }
  if (value !== null && typeof value === 'object' && Array.isArray(value.items)) {
    const items = value.items.filter(item => typeof item === 'string' && item.trim() !== '')
    if (items.length === 0) return null
    const intro = typeof value.intro === 'string' && value.intro.trim() !== '' ? value.intro.trim() : undefined
    const outro = typeof value.outro === 'string' && value.outro.trim() !== '' ? value.outro.trim() : undefined
    return { ...(intro ? { intro } : {}), items, ...(outro ? { outro } : {}) }
  }
  return null
}

/**
 * Pick localized release notes with deterministic fallback:
 * - `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant` -> `zh-TW` -> `zh` -> `en`
 * - `zh` / `zh-CN` / `zh-Hans` -> `zh` -> `en`
 * - Other locales -> exact -> base language -> `en` -> first available locale
 */
export function selectReleaseNotes(entry, locale = 'en') {
  const notes = entry?.notes
  if (notes === null || typeof notes !== 'object') return null

  const byLower = new Map()
  for (const [key, val] of Object.entries(notes)) {
    const normalized = normalizeNoteValue(val)
    if (normalized !== null) byLower.set(key.toLowerCase(), { locale: key, ...normalized })
  }
  if (byLower.size === 0) return null

  const raw = String(locale ?? 'en').trim().toLowerCase().replace(/_/gu, '-')
  const candidates = []
  if (raw === 'zh-tw' || raw === 'zh-hk' || raw === 'zh-mo' || raw === 'zh-hant' || raw.startsWith('zh-hant-')) {
    candidates.push('zh-tw', 'zh', 'en')
  } else if (raw === 'zh' || raw === 'zh-cn' || raw === 'zh-sg' || raw === 'zh-hans' || raw.startsWith('zh-hans-')) {
    candidates.push('zh', 'en')
  } else {
    if (raw) candidates.push(raw)
    const base = raw.split('-')[0]
    if (base && base !== raw) candidates.push(base)
    candidates.push('en')
  }

  for (const candidate of candidates) {
    const hit = byLower.get(candidate)
    if (hit !== undefined) {
      return {
        ...hit,
        exact: candidate === raw || (candidate === 'zh' && (raw === 'zh' || raw === 'zh-cn' || raw === 'zh-hans')),
      }
    }
  }
  const first = byLower.values().next().value
  return first ? { ...first, exact: false } : null
}
