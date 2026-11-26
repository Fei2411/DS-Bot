// Validates src/shared/release-notes.json, supplements any released versions present in
// ../CHANGELOG.md that are not yet hand-authored, and generates src/shared/release-notes-generated.js
// so esbuild (ds-bot), Vite (app/ui), Metro (mobile), and Node (host) all import offline data directly.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanSemver, compareSemver } from '../src/shared/semver.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(PLUGIN)
export const RELEASE_NOTES_SOURCE = join(PLUGIN, 'src', 'shared', 'release-notes.json')
export const CHANGELOG_SOURCE = join(REPO_ROOT, 'CHANGELOG.md')
export const RELEASE_NOTES_OUTPUT = join(PLUGIN, 'src', 'shared', 'release-notes-generated.js')

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u
const LOCALE_KEY = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u
const FALLBACK_MAX_ITEMS = 8

/** Strip Markdown formatting and trailing PR/issue/author citations into clean user-facing text. */
export function cleanChangelogLine(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''
  // Protect inline code spans before stripping HTML tags so tokens like `</DSML …>` survive.
  const codeSpans = []
  text = text.replace(/`([^`]+)`/gu, (_, code) => {
    const idx = codeSpans.length
    codeSpans.push(code)
    return `\uE000${idx}\uE001`
  })
  // Unwrap Markdown links `[label](url)` -> `label`.
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/gu, '$1')
  // Remove inline HTML tags like `<br>` or `<code>`.
  text = text.replace(/<[^>]+>/gu, ' ')
  // Remove bold/italic wrappers.
  text = text.replace(/\*\*([^*]+)\*\*/gu, '$1')
  text = text.replace(/__([^_]+)__/gu, '$1')
  // Restore unwrapped inline code spans.
  text = text.replace(/\uE000(\d+)\uE001/gu, (_, idx) => codeSpans[Number(idx)] ?? '')
  // Strip trailing parentheticals referencing PRs, issues, or contributor credits:
  // e.g. "(#123, #456)", "(by @alice; #123)", "(reported by @bob; #123, reverts #456)".
  while (/\s*\((?:[^()]*?(?:#\d+|@\w+|reverts?\b)[^()]*)\)\s*$/iu.test(text)) {
    text = text.replace(/\s*\((?:[^()]*?(?:#\d+|@\w+|reverts?\b)[^()]*)\)\s*$/iu, '')
  }
  text = text.replace(/\s+/gu, ' ').trim()
  text = text.replace(/[;,\s]+$/u, '').trim()
  return text
}

/** Parse released version sections from Keep-a-Changelog Markdown (skips [Unreleased]). */
export function parseChangelog(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') return []
  // Strip download tables wrapped in HTML comments if present.
  const stripped = markdown.replace(/<!--\s*downloads\s*-->[\s\S]*?<!--\s*\/downloads\s*-->/giu, '')
  const lines = stripped.split(/\r?\n/u)
  const sections = []
  let current = null
  let inDownloadHeading = false

  for (const rawLine of lines) {
    const header = /^##\s+\[?([^\]\s]+)\]?(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/u.exec(rawLine.trim())
    if (header !== null) {
      const label = header[1].trim()
      if (/^unreleased$/iu.test(label)) {
        current = null
        inDownloadHeading = false
        continue
      }
      const version = cleanSemver(label)
      if (version === null) {
        current = null
        inDownloadHeading = false
        continue
      }
      current = { version, date: header[2] ?? '', items: [] }
      sections.push(current)
      inDownloadHeading = false
      continue
    }
    if (current === null) continue

    const sub = /^###?\s+(.+)$/u.exec(rawLine.trim())
    if (sub !== null) {
      inDownloadHeading = /^download\b|下载/iu.test(sub[1].trim())
      continue
    }
    if (inDownloadHeading) continue
    if (/^\s*\|/u.test(rawLine)) continue

    const bullet = /^-\s+(.+)$/u.exec(rawLine.trim())
    if (bullet === null) continue
    const cleaned = cleanChangelogLine(bullet[1])
    if (cleaned !== '' && !current.items.includes(cleaned)) {
      current.items.push(cleaned)
    }
  }

  return sections
    .filter(section => section.items.length > 0)
    .map(section => ({
      version: section.version,
      date: section.date,
      notes: { en: { items: section.items.slice(0, FALLBACK_MAX_ITEMS) } },
    }))
}

function normalizeLocaleNote(raw, label) {
  if (Array.isArray(raw)) {
    const items = raw.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    if (items.length === 0 || items.length !== raw.length) {
      throw new Error(`${label} must be a non-empty array of non-empty strings`)
    }
    return { items }
  }
  if (raw !== null && typeof raw === 'object') {
    const allowed = new Set(['intro', 'items', 'outro'])
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error(`${label} has unknown field "${key}"`)
    }
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      throw new Error(`${label}.items must be a non-empty array of strings`)
    }
    const items = raw.items.map(item => (typeof item === 'string' ? item.trim() : ''))
    if (items.some(item => item === '')) {
      throw new Error(`${label}.items must contain only non-empty strings`)
    }
    const out = { items }
    if (raw.intro !== undefined) {
      if (typeof raw.intro !== 'string' || raw.intro.trim() === '') {
        throw new Error(`${label}.intro must be a non-empty string when present`)
      }
      out.intro = raw.intro.trim()
    }
    if (raw.outro !== undefined) {
      if (typeof raw.outro !== 'string' || raw.outro.trim() === '') {
        throw new Error(`${label}.outro must be a non-empty string when present`)
      }
      out.outro = raw.outro.trim()
    }
    return out
  }
  throw new Error(`${label} must be a string[] or { intro?, items, outro? }`)
}

/** Validate and normalize hand-authored release-notes.json entries. */
export function validateReleaseNotes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('release-notes.json must be a non-empty JSON array')
  }
  const seen = new Set()
  const normalized = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const prefix = `release-notes.json[${i}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${prefix} must be an object`)
    }
    const version = cleanSemver(entry.version)
    if (version === null) {
      throw new Error(`${prefix}.version "${entry.version}" is not a valid semver version`)
    }
    if (seen.has(version)) {
      throw new Error(`${prefix}.version "${version}" is duplicated`)
    }
    seen.add(version)
    const date = typeof entry.date === 'string' ? entry.date.trim() : ''
    if (!ISO_DATE.test(date)) {
      throw new Error(`${prefix}.date "${entry.date}" must use YYYY-MM-DD format`)
    }
    if (entry.notes === null || typeof entry.notes !== 'object' || Array.isArray(entry.notes)) {
      throw new Error(`${prefix}.notes must be a locale map`)
    }
    const locales = Object.keys(entry.notes)
    if (locales.length === 0) {
      throw new Error(`${prefix}.notes must define at least one locale`)
    }
    const notes = {}
    for (const locale of locales) {
      if (!LOCALE_KEY.test(locale)) {
        throw new Error(`${prefix}.notes has invalid locale key "${locale}"`)
      }
      notes[locale] = normalizeLocaleNote(entry.notes[locale], `${prefix}.notes.${locale}`)
    }
    if (notes.en === undefined && notes.zh === undefined) {
      throw new Error(`${prefix}.notes must include at least "en" or "zh"`)
    }
    normalized.push({ version, date, notes })
  }
  return normalized
}

/** Merge hand-authored notes with parsed CHANGELOG.md fallback entries, newest version first. */
export function buildReleaseNotesData({ sourceEntries, changelogText = '' }) {
  const authored = validateReleaseNotes(sourceEntries)
  const byVersion = new Map(authored.map(entry => [entry.version, entry]))
  for (const fallback of parseChangelog(changelogText)) {
    if (!byVersion.has(fallback.version)) {
      byVersion.set(fallback.version, fallback)
    }
  }
  return [...byVersion.values()].sort((a, b) => compareSemver(b.version, a.version))
}

/** Render the static ESM module consumed offline by esbuild, Vite, Metro, and Node. */
export function generateReleaseNotesModule({
  sourcePath = RELEASE_NOTES_SOURCE,
  changelogPath = CHANGELOG_SOURCE,
} = {}) {
  const sourceEntries = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const changelogText = changelogPath && existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8')
    : ''
  const data = buildReleaseNotesData({ sourceEntries, changelogText })
  return [
    '// Generated from src/shared/release-notes.json and ../CHANGELOG.md by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    `export const RELEASE_NOTES = ${JSON.stringify(data, null, 2)}`,
    '',
  ].join('\n')
}
