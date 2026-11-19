// Extracts local Markdown image links from a Bot/group reply, resolves them
// through DS Bot's existing `markdown-image` workspace boundary, and separates
// uploadable raster images from the reply text.
import { basename } from 'node:path'

const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const isRemoteTarget = (target) => {
  const value = String(target ?? '').trim()
  if (value === '') return true
  // Windows drive path (C:\ or C:/) and file:// URLs are local; all other schemes are remote.
  if (/^[a-z]:[\\/]/i.test(value) || /^file:\/\//i.test(value)) return false
  if (/^\/\//.test(value)) return true
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
}

const parseDestination = (text, openIdx) => {
  let i = openIdx + 1
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  if (i >= text.length) return undefined
  let path = ''
  if (text[i] === '<') {
    i += 1
    const start = i
    while (i < text.length && text[i] !== '>' && text[i] !== '\n' && text[i] !== '\r') {
      if (text[i] === '\\' && i + 1 < text.length) i += 2
      else i += 1
    }
    if (i >= text.length || text[i] !== '>') return undefined
    path = text.slice(start, i)
    i += 1
  } else {
    const start = i
    let depth = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\' && i + 1 < text.length) { i += 2; continue }
      if (ch === '(') { depth += 1; i += 1; continue }
      if (ch === ')') {
        if (depth === 0) break
        depth -= 1
        i += 1
        continue
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break
      i += 1
    }
    path = text.slice(start, i)
  }
  // Skip optional whitespace and optional title ("...", '...', (...)) before closing ')'.
  const wsStart = i
  while (i < text.length && /\s/.test(text[i])) i += 1
  if (i > wsStart && i < text.length && (text[i] === '"' || text[i] === '\'' || text[i] === '(')) {
    const closer = text[i] === '(' ? ')' : text[i]
    i += 1
    while (i < text.length && text[i] !== closer) {
      if (text[i] === '\\' && i + 1 < text.length) i += 2
      else i += 1
    }
    if (i >= text.length) return undefined
    i += 1
    while (i < text.length && /\s/.test(text[i])) i += 1
  }
  if (i >= text.length || text[i] !== ')') return undefined
  return { path: path.trim(), end: i + 1 }
}

// Finds the matching closing backtick run of exact length `ticks` (CommonMark
// inline code span rule: longer or shorter runs inside do not close it).
const findInlineCodeClose = (text, start, ticks) => {
  let i = start
  while (i < text.length) {
    if (text[i] === '`') {
      let run = 0
      while (i + run < text.length && text[i + run] === '`') run += 1
      if (run === ticks) return i + run
      i += run
      continue
    }
    i += 1
  }
  return -1
}

// Walks Markdown skipping fenced code blocks (``` / ~~~, including CRLF) and
// inline code spans (`...`), returning all local `![alt](target)` references.
export function extractLocalMarkdownImages(markdown) {
  const text = String(markdown ?? '')
  const links = []
  let i = 0
  let fence = null
  let atLineStart = true
  while (i < text.length) {
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', i)
      const end = lineEnd === -1 ? text.length : lineEnd
      const line = text.slice(i, end).replace(/\r$/, '')
      if (fence !== null) {
        const close = new RegExp(`^[ ]{0,3}${fence.ch}{${fence.len},}[ \\t]*$`)
        if (close.test(line)) fence = null
        i = lineEnd === -1 ? text.length : lineEnd + 1
        continue
      }
      const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      // CommonMark: backtick fence info strings cannot contain backticks, so a
      // line like ```` ```code``` ![a](./a.png) ```` is an inline code span, not a fence.
      if (match && (match[1][0] === '~' || !match[2].includes('`'))) {
        fence = { ch: match[1][0], len: match[1].length }
        i = lineEnd === -1 ? text.length : lineEnd + 1
        continue
      }
      atLineStart = false
    }
    const ch = text[i]
    if (ch === '\n') { atLineStart = true; i += 1; continue }
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue }
    if (ch === '`') {
      let ticks = 0
      while (i + ticks < text.length && text[i + ticks] === '`') ticks += 1
      const close = findInlineCodeClose(text, i + ticks, ticks)
      if (close === -1) { i += ticks; continue }
      i = close
      continue
    }
    if (ch === '!' && text[i + 1] === '[') {
      let j = i + 2
      let brackets = 1
      while (j < text.length && brackets > 0 && text[j] !== '\n' && text[j] !== '\r') {
        if (text[j] === '\\' && j + 1 < text.length) { j += 2; continue }
        if (text[j] === '[') brackets += 1
        else if (text[j] === ']') brackets -= 1
        j += 1
      }
      if (brackets === 0 && text[j] === '(') {
        const alt = text.slice(i + 2, j - 1)
        const parsed = parseDestination(text, j)
        if (parsed !== undefined) {
          if (!isRemoteTarget(parsed.path)) {
            links.push({ start: i, end: parsed.end, raw: text.slice(i, parsed.end), alt: alt.trim(), path: parsed.path })
          }
          i = parsed.end
          continue
        }
      }
    }
    i += 1
  }
  return links
}

const safeFilename = (rawPath, mediaType, index) => {
  let cleaned = String(rawPath ?? '').split('#')[0].split('?')[0]
  try { cleaned = decodeURIComponent(cleaned) } catch { /* keep raw */ }
  const base = basename(cleaned.replace(/\\/g, '/')).replace(/[\r\n\0/\\]/g, '')
  const ext = MIME_EXT[mediaType] ?? 'png'
  if (!base || base === '.' || base === '..') return `image-${index + 1}.${ext}`
  return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`
}

const cleanRewrittenText = (text) => text
  .replace(/\r\n/g, '\n')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

// Resolves local image references via `resolveImage(path)` (backed by DS Bot's
// `markdown-image` workspace boundary), strips successfully resolved tags from
// the reply text, and replaces unresolved ones with a visible failure note.
export async function prepareOutboundReply(body, { resolveImage }) {
  const source = String(body ?? '')
  const links = extractLocalMarkdownImages(source)
  if (links.length === 0) return { text: source, images: [], failed: [] }

  const cache = new Map()
  const images = []
  const failed = []
  const outcomes = []

  for (const link of links) {
    let outcome = cache.get(link.path)
    if (outcome === undefined) {
      try {
        const got = await resolveImage(link.path)
        const mediaType = String(got?.mime ?? '').toLowerCase()
        const data = typeof got?.bytes === 'string' ? Buffer.from(got.bytes, 'base64') : undefined
        if (!RASTER_MIMES.has(mediaType)) {
          outcome = { ok: false, reason: `Unsupported IM image format (${mediaType || 'unknown'})` }
        } else if (data === undefined || data.byteLength === 0) {
          outcome = { ok: false, reason: 'Empty image' }
        } else {
          const image = {
            data,
            mediaType,
            name: safeFilename(link.path, mediaType, images.length),
            alt: link.alt,
          }
          images.push(image)
          outcome = { ok: true, image }
        }
      } catch (error) {
        outcome = { ok: false, reason: String(error?.message ?? error) }
      }
      if (!outcome.ok) failed.push({ path: link.path, alt: link.alt, reason: outcome.reason })
      cache.set(link.path, outcome)
    }
    outcomes.push({ link, outcome })
  }

  let rewritten = source
  for (let idx = outcomes.length - 1; idx >= 0; idx -= 1) {
    const { link, outcome } = outcomes[idx]
    let fallbackBase = link.path.split('#')[0].split('?')[0]
    try { fallbackBase = decodeURIComponent(fallbackBase) } catch { /* keep raw */ }
    const label = link.alt || basename(fallbackBase.replace(/\\/g, '/')) || 'image'
    const replacement = outcome.ok ? '' : `[Image unavailable: ${label}]`
    rewritten = rewritten.slice(0, link.start) + replacement + rewritten.slice(link.end)
  }

  return { text: cleanRewrittenText(rewritten), images, failed }
}
