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

// Decodes CommonMark backslash escapes before ASCII punctuation (e.g. `./plot\(1\).png`
// → `./plot(1).png`) while leaving Windows drive paths (`C:\dir\_file.png`) verbatim.
const decodeMarkdownDestination = (raw) => {
  const trimmed = String(raw ?? '').trim()
  if (/^[a-z]:\\/i.test(trimmed)) return trimmed
  return trimmed.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
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
  return { path: decodeMarkdownDestination(path), end: i + 1 }
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

const mapBlockOffset = (segments, bufStarts, pos) => {
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (bufStarts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return segments[lo].start + (pos - bufStarts[lo])
}

// Scans a single inline-bearing block (one paragraph or one ATX heading) so
// unclosed inline backticks never swallow images across blank lines or block boundaries.
const scanInlineBlock = (text, segments, links) => {
  if (segments.length === 0) return
  let buf
  let bufStarts = null
  if (segments.length === 1) {
    buf = text.slice(segments[0].start, segments[0].end)
  } else {
    bufStarts = []
    const parts = []
    let offset = 0
    for (let s = 0; s < segments.length; s += 1) {
      bufStarts.push(offset)
      const slice = text.slice(segments[s].start, segments[s].end)
      parts.push(slice)
      offset += slice.length + 1
    }
    buf = parts.join('\n')
  }
  if (buf.length === 0) return
  const toOrig = (pos) => (bufStarts === null ? segments[0].start + pos : mapBlockOffset(segments, bufStarts, pos))

  let i = 0
  while (i < buf.length) {
    const ch = buf[i]
    if (ch === '\\' && i + 1 < buf.length) { i += 2; continue }
    if (ch === '`') {
      let ticks = 0
      while (i + ticks < buf.length && buf[i + ticks] === '`') ticks += 1
      const close = findInlineCodeClose(buf, i + ticks, ticks)
      if (close === -1) { i += ticks; continue }
      i = close
      continue
    }
    if (ch === '!' && buf[i + 1] === '[') {
      let j = i + 2
      let brackets = 1
      while (j < buf.length && brackets > 0 && buf[j] !== '\n' && buf[j] !== '\r') {
        if (buf[j] === '\\' && j + 1 < buf.length) { j += 2; continue }
        if (buf[j] === '[') brackets += 1
        else if (buf[j] === ']') brackets -= 1
        j += 1
      }
      if (brackets === 0 && buf[j] === '(') {
        const alt = buf.slice(i + 2, j - 1)
        const parsed = parseDestination(buf, j)
        if (parsed !== undefined) {
          if (!isRemoteTarget(parsed.path)) {
            const start = toOrig(i)
            const end = toOrig(parsed.end - 1) + 1
            links.push({ start, end, raw: text.slice(start, end), alt: alt.trim(), path: parsed.path })
          }
          i = parsed.end
          continue
        }
      }
    }
    i += 1
  }
}

const measureIndent = (line, idx, col, vsp) => {
  let c = col + vsp
  let p = idx
  while (p < line.length) {
    if (line[p] === ' ') { c += 1; p += 1 }
    else if (line[p] === '\t') { c += 4 - (c % 4); p += 1 }
    else break
  }
  return { cols: c - col, idx: p, col: c }
}

const advanceColumns = (line, idx, col, vsp, count) => {
  let need = count
  let c = col
  let p = idx
  let v = vsp
  if (v > 0) {
    const take = Math.min(v, need)
    v -= take
    c += take
    need -= take
  }
  while (need > 0 && p < line.length) {
    if (line[p] === ' ') {
      c += 1
      p += 1
      need -= 1
    } else if (line[p] === '\t') {
      const width = 4 - (c % 4)
      if (width > need) {
        c += need
        v = width - need
        p += 1
        need = 0
      } else {
        c += width
        p += 1
        need -= width
      }
    } else {
      break
    }
  }
  return { idx: p, col: c, vsp: v }
}

const consumeBlockquote = (line, idx, col, vsp) => {
  const ind = measureIndent(line, idx, col, vsp)
  if (ind.cols > 3 || line[ind.idx] !== '>') return null
  const afterIdx = ind.idx + 1
  const afterCol = ind.col + 1
  if (line[afterIdx] === ' ' || line[afterIdx] === '\t') {
    return advanceColumns(line, afterIdx, afterCol, 0, 1)
  }
  return { idx: afterIdx, col: afterCol, vsp: 0 }
}

const isThematicBreak = (trimmed) => /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(trimmed)

const LIST_MARKER = /^([-+*]|\d{1,9}[.)])(?=[ \t]|$)/
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/
const ATX_HEADING = /^#{1,6}(?:[ \t]+|$)/

// Walks Markdown using CommonMark Phase 1 container/leaf tracking (fenced code
// blocks, indented code blocks, nested blockquotes and list items, Setext/ATX
// headings) and runs Phase 2 inline scanning per leaf block so unclosed code
// spans cannot cross paragraph or block boundaries.
export function extractLocalMarkdownImages(markdown) {
  const text = String(markdown ?? '')
  const links = []
  const containers = []
  let fence = null
  let leaf = 'none'
  let currentBlock = []

  const flushBlock = () => {
    if (currentBlock.length === 0) return
    scanInlineBlock(text, currentBlock, links)
    currentBlock = []
  }

  let lineStart = 0
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart)
    const rawEnd = nl === -1 ? text.length : nl
    const lineEnd = rawEnd > lineStart && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
    const line = text.slice(lineStart, lineEnd)
    const nextLine = nl === -1 ? text.length : nl + 1

    // Phase 1, step 1: match open containers left-to-right.
    let cursor = { idx: 0, col: 0, vsp: 0 }
    let matched = 0
    for (let k = 0; k < containers.length; k += 1) {
      const container = containers[k]
      const ind = measureIndent(line, cursor.idx, cursor.col, cursor.vsp)
      const restBlank = ind.idx >= line.length
      if (container.type === 'blockquote') {
        if (restBlank) break
        const next = consumeBlockquote(line, cursor.idx, cursor.col, cursor.vsp)
        if (next === null) break
        cursor = next
        matched += 1
      } else if (restBlank) {
        // CommonMark §5.2: a list item can begin with at most one blank line.
        if (container.justOpenedBlank) break
        matched += 1
      } else if (ind.cols >= container.indent) {
        cursor = advanceColumns(line, cursor.idx, cursor.col, cursor.vsp, container.indent)
        matched += 1
      } else {
        break
      }
    }

    // Phase 1, step 2: handle an active fenced code block.
    if (fence !== null) {
      if (matched < fence.containerDepth) {
        fence = null
        containers.length = matched
        leaf = 'none'
      } else {
        const ind = measureIndent(line, cursor.idx, cursor.col, cursor.vsp)
        if (ind.cols <= 3) {
          const close = new RegExp(`^${fence.ch}{${fence.len},}[ \\t]*$`)
          if (close.test(line.slice(ind.idx))) {
            fence = null
            leaf = 'none'
          }
        }
        lineStart = nextLine
        continue
      }
    }

    const firstInd = measureIndent(line, cursor.idx, cursor.col, cursor.vsp)
    if (firstInd.idx >= line.length) {
      flushBlock()
      containers.length = matched
      leaf = 'none'
      lineStart = nextLine
      continue
    }

    let allMatched = matched === containers.length
    if (!allMatched && leaf !== 'paragraph') {
      containers.length = matched
      allMatched = true
      leaf = 'none'
    }

    for (let k = 0; k < matched; k += 1) {
      if (containers[k].type === 'list') containers[k].justOpenedBlank = false
    }

    const closeUnmatched = () => {
      if (!allMatched) {
        flushBlock()
        containers.length = matched
        allMatched = true
        leaf = 'none'
      }
    }

    // Phase 1, step 3: open any new containers or leaf blocks on this line.
    let consumedLine = false
    for (;;) {
      const ind = measureIndent(line, cursor.idx, cursor.col, cursor.vsp)
      if (ind.idx >= line.length) {
        leaf = 'none'
        consumedLine = true
        break
      }

      if (ind.cols >= 4) {
        if (leaf !== 'paragraph') {
          leaf = 'indentedCode'
          consumedLine = true
        }
        break
      }

      const trimmed = line.slice(ind.idx)

      if (trimmed[0] === '>') {
        flushBlock()
        closeUnmatched()
        leaf = 'none'
        containers.push({ type: 'blockquote' })
        matched = containers.length
        cursor = consumeBlockquote(line, cursor.idx, cursor.col, cursor.vsp)
        continue
      }

      // CommonMark §4.3: Setext underline cannot be a lazy continuation line.
      if (allMatched && leaf === 'paragraph' && SETEXT_UNDERLINE.test(trimmed)) {
        flushBlock()
        leaf = 'none'
        consumedLine = true
        break
      }

      const heading = ATX_HEADING.exec(trimmed)
      if (heading) {
        flushBlock()
        closeUnmatched()
        leaf = 'none'
        scanInlineBlock(text, [{ start: lineStart + ind.idx + heading[0].length, end: lineEnd }], links)
        consumedLine = true
        break
      }

      const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed)
      // CommonMark §4.5: backtick fence info strings cannot contain backticks, so a
      // line like ```` ```code``` ![a](./a.png) ```` is an inline code span, not a fence.
      if (fenceMatch && (fenceMatch[1][0] === '~' || !fenceMatch[2].includes('`'))) {
        flushBlock()
        closeUnmatched()
        fence = { ch: fenceMatch[1][0], len: fenceMatch[1].length, containerDepth: containers.length }
        leaf = 'none'
        consumedLine = true
        break
      }

      if (isThematicBreak(trimmed)) {
        flushBlock()
        closeUnmatched()
        leaf = 'none'
        consumedLine = true
        break
      }

      const marker = LIST_MARKER.exec(trimmed)
      if (marker) {
        const rawMarker = marker[1]
        const isOrdered = rawMarker.length > 1
        const kind = isOrdered ? rawMarker.at(-1) : rawMarker
        const startNum = isOrdered ? Number(rawMarker.slice(0, -1)) : 0
        const afterMarkerIdx = ind.idx + rawMarker.length
        const afterMarkerCol = ind.col + rawMarker.length
        const wsInd = measureIndent(line, afterMarkerIdx, afterMarkerCol, 0)
        const bodyIsBlank = wsInd.idx >= line.length
        // CommonMark §5.2: an empty list item or an ordered list not starting at 1
        // cannot interrupt a paragraph (unless continuing the same list container).
        const continuesSameList = !allMatched && containers[matched]?.type === 'list' && containers[matched].kind === kind
        const canInterruptParagraph = !bodyIsBlank && (!isOrdered || startNum === 1)
        if (leaf !== 'paragraph' || continuesSameList || canInterruptParagraph) {
          flushBlock()
          closeUnmatched()
          leaf = 'none'
          // CommonMark §5.2: blank first line or >=5 spaces after marker yields padding=1.
          const padding = (bodyIsBlank || wsInd.cols >= 5) ? 1 : wsInd.cols
          const itemIndent = ind.cols + rawMarker.length + padding
          containers.push({ type: 'list', kind, indent: itemIndent, justOpenedBlank: bodyIsBlank })
          matched = containers.length
          if (bodyIsBlank) {
            consumedLine = true
            break
          }
          if (wsInd.cols >= 5) {
            leaf = 'indentedCode'
            consumedLine = true
            break
          }
          cursor = { idx: wsInd.idx, col: wsInd.col, vsp: 0 }
          continue
        }
      }

      leaf = 'paragraph'
      currentBlock.push({ start: lineStart + ind.idx, end: lineEnd })
      consumedLine = true
      break
    }

    if (!consumedLine) {
      // Reached only when `ind.cols >= 4 && leaf === 'paragraph'` (indented paragraph continuation).
      const ind = measureIndent(line, cursor.idx, cursor.col, cursor.vsp)
      currentBlock.push({ start: lineStart + ind.idx, end: lineEnd })
    }

    lineStart = nextLine
  }

  flushBlock()
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
