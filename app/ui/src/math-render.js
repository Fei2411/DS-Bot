// Lazy-loaded KaTeX math rendering and CommonMark/LaTeX math compatibility helpers.
// Supports `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and fenced ```math blocks while
// avoiding currency false positives (`$5 and $10`). KaTeX and its stylesheet load only
// when a message actually contains math.
import { createElement as h, memo, useEffect, useMemo, useState } from 'react'

let katexApi = null
let katexLoadPromise = null
let styleLoader = null
const KATEX_CACHE_MAX = 512
const katexHtmlCache = new Map()

export function registerMathStyleLoader(fn) {
  styleLoader = typeof fn === 'function' ? fn : null
}

export function isKatexLoaded() {
  return katexApi !== null
}

export function ensureKatex() {
  if (katexApi !== null) return Promise.resolve(katexApi)
  if (katexLoadPromise !== null) return katexLoadPromise
  katexLoadPromise = Promise.all([
    import('katex'),
    Promise.resolve(styleLoader?.()).catch(() => undefined),
  ])
    .then(([mod]) => {
      const api = typeof mod?.renderToString === 'function'
        ? mod
        : (typeof mod?.default?.renderToString === 'function' ? mod.default : null)
      katexApi = api
      return katexApi
    })
    .catch(() => {
      katexLoadPromise = null
      return null
    })
  return katexLoadPromise
}

export function renderKatexSync(tex, display = false) {
  if (katexApi === null || typeof tex !== 'string') return null
  const key = `${display ? '1' : '0'}:${tex}`
  if (katexHtmlCache.has(key)) {
    const cached = katexHtmlCache.get(key)
    katexHtmlCache.delete(key)
    katexHtmlCache.set(key, cached)
    return cached
  }
  try {
    const html = katexApi.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      maxExpand: 1000,
    })
    katexHtmlCache.set(key, html)
    if (katexHtmlCache.size > KATEX_CACHE_MAX) {
      const oldest = katexHtmlCache.keys().next().value
      if (oldest !== undefined) katexHtmlCache.delete(oldest)
    }
    return html
  } catch {
    return null
  }
}

function measureIndent(text, lineStart) {
  let i = lineStart
  let col = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ') { col += 1; i += 1 }
    else if (ch === '\t') { col += 4 - (col % 4); i += 1 }
    else break
  }
  return { col, index: i }
}

// Returns the exclusive end index of the current paragraph (before the first
// blank line `\r?\n[ \t]*\r?\n` at or after `from`), or `text.length` if none.
// CommonMark inline constructs (code spans, inline math) cannot cross blank lines.
function findParagraphEnd(text, from) {
  let i = from
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    if (nl === -1) return text.length
    let j = nl + 1
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j += 1
    if (j < text.length && text[j] === '\n') return nl
    i = j
  }
  return text.length
}

function readInlineCodeSpan(text, start) {
  let ticks = 0
  while (start + ticks < text.length && text[start + ticks] === '`') ticks += 1
  const limit = findParagraphEnd(text, start + ticks)
  const needle = '`'.repeat(ticks)
  let close = text.indexOf(needle, start + ticks)
  while (close !== -1 && close + ticks <= limit) {
    const beforeOk = close === 0 || text[close - 1] !== '`'
    const afterOk = close + ticks >= limit || text[close + ticks] !== '`'
    if (beforeOk && afterOk) return close + ticks
    close = text.indexOf(needle, close + 1)
  }
  return start + ticks
}

function stripBlockquotePrefix(text, lineStartIdx, lineEnd) {
  let pos = lineStartIdx
  let depth = 0
  while (pos < lineEnd) {
    const { col, index } = measureIndent(text, pos)
    if (col <= 3 && index < lineEnd && text[index] === '>') {
      depth += 1
      pos = index + 1
      if (pos < lineEnd && text[pos] === ' ') pos += 1
      continue
    }
    break
  }
  return { depth, contentStart: pos }
}

function trailingNewlines(out) {
  let count = 0
  for (let idx = out.length - 1; idx >= 0; idx -= 1) {
    const piece = out[idx]
    for (let j = piece.length - 1; j >= 0; j -= 1) {
      if (piece[j] === '\n') {
        count += 1
        if (count >= 2) return 2
      } else {
        return count
      }
    }
  }
  return count
}

function hasPrecedingContent(out) {
  for (let idx = out.length - 1; idx >= 0; idx -= 1) {
    const piece = out[idx]
    for (let j = piece.length - 1; j >= 0; j -= 1) {
      const ch = piece.charCodeAt(j)
      if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) return true
    }
  }
  return false
}

function hasNonWhitespaceFrom(text, start) {
  for (let idx = start; idx < text.length; idx += 1) {
    const ch = text.charCodeAt(idx)
    if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) return true
  }
  return false
}

function leadingNewlines(text, start) {
  let count = 0
  for (let idx = start; idx < text.length; idx += 1) {
    if (text[idx] === '\n') {
      count += 1
      if (count >= 2) return 2
    } else {
      break
    }
  }
  return count
}

/**
 * Walks CommonMark source while preserving fenced code blocks (` ``` ` / `~~~`),
 * CommonMark indented code blocks (4+ spaces / tab after blank line, including inside
 * blockquotes), and inline backtick spans completely untouched, calling
 * `onProseChar(text, i, out, quoteDepth)` for non-code characters.
 */
function walkMarkdownProse(text, onProseChar) {
  const out = []
  let i = 0
  let segStart = 0
  let lineStart = true
  let prevLineBlank = true
  let prevQuoteDepth = 0
  let inIndentedCode = false
  let fenceChar = ''
  let fenceLen = 0
  let fenceQuoteDepth = 0

  const flushSeg = (end) => {
    if (end > segStart) out.push(text.slice(segStart, end))
    segStart = end
  }

  while (i < text.length) {
    if (lineStart) {
      const nl = text.indexOf('\n', i)
      const lineEnd = nl === -1 ? text.length : nl + 1
      const { depth: quoteDepth, contentStart } = stripBlockquotePrefix(text, i, lineEnd)
      const { col, index: firstNonWs } = measureIndent(text, contentStart)
      const isBlank = firstNonWs >= lineEnd || text[firstNonWs] === '\n' || text[firstNonWs] === '\r'

      if (fenceChar !== '' && quoteDepth < fenceQuoteDepth) {
        fenceChar = ''
        fenceLen = 0
        fenceQuoteDepth = 0
      }

      if (fenceChar !== '') {
        if (col <= 3) {
          const ch = text[firstNonWs]
          if (ch === fenceChar) {
            let count = 0
            while (firstNonWs + count < lineEnd && text[firstNonWs + count] === ch) count += 1
            if (count >= fenceLen && text.slice(firstNonWs + count, lineEnd).trim() === '') {
              fenceChar = ''
              fenceLen = 0
              fenceQuoteDepth = 0
            }
          }
        }
        i = lineEnd
        lineStart = true
        prevLineBlank = isBlank
        prevQuoteDepth = quoteDepth
        continue
      }

      if (quoteDepth !== prevQuoteDepth) {
        inIndentedCode = false
        prevLineBlank = true
      }

      if (isBlank) {
        i = lineEnd
        lineStart = true
        prevLineBlank = true
        prevQuoteDepth = quoteDepth
        continue
      }

      // CommonMark indented code block: 4+ column indent when starting after a blank line
      // (or container/document start) or continuing an active indented code block.
      if ((prevLineBlank || inIndentedCode) && col >= 4) {
        inIndentedCode = true
        prevLineBlank = false
        prevQuoteDepth = quoteDepth
        i = lineEnd
        lineStart = true
        continue
      }

      inIndentedCode = false
      prevLineBlank = false
      prevQuoteDepth = quoteDepth

      if (col <= 3) {
        const ch = text[firstNonWs]
        if (ch === '`' || ch === '~') {
          let count = 0
          while (firstNonWs + count < lineEnd && text[firstNonWs + count] === ch) count += 1
          // Backtick info strings cannot contain backticks in CommonMark.
          const info = text.slice(firstNonWs + count, lineEnd)
          if (count >= 3 && (ch === '~' || !info.includes('`'))) {
            fenceChar = ch
            fenceLen = count
            fenceQuoteDepth = quoteDepth
            i = lineEnd
            lineStart = true
            continue
          }
        }
      }

      if (contentStart > i) {
        i = contentStart
        lineStart = false
        continue
      }
    }

    const ch = text[i]
    if (ch === '\n') {
      i += 1
      lineStart = true
      continue
    }
    lineStart = false

    // Skip inline code spans with exact matching backtick count.
    if (ch === '`') {
      i = readInlineCodeSpan(text, i)
      continue
    }

    const beforeLen = out.length
    const next = onProseChar(text, i, out, prevQuoteDepth, flushSeg)
    if (next > i) {
      if (out.length === beforeLen) {
        // Callback accepted characters without emitting a replacement: keep contiguous slice.
      } else {
        segStart = next
      }
      if (text[next - 1] === '\n') lineStart = true
      i = next
      continue
    }

    i += 1
  }
  if (segStart === 0 && out.length === 0) return text
  if (segStart < text.length) out.push(text.slice(segStart))
  return out.join('')
}

/**
 * Converts LaTeX `\(...\)` and `\[...\]` math delimiters into `$...$` / `$$...$$`
 * outside fenced code blocks (` ``` ` / `~~~`), CommonMark indented code blocks,
 * and inline code spans. Outside blockquotes, `\[...\]` is separated by blank lines
 * into an independent display block so incremental block splitting stays intact.
 */
export function normalizeMathDelimiters(text) {
  if (typeof text !== 'string' || (!text.includes('\\(') && !text.includes('\\['))) return text
  return walkMarkdownProse(text, (src, i, out, quoteDepth, flushSeg) => {
    const ch = src[i]
    if (ch !== '\\') return i
    // Escaped backslash (`\\`) stays literal so `\\(` is not treated as math.
    if (src[i + 1] === '\\') return i + 2
    // Display math: `\[ ... \]`
    if (src[i + 1] === '[') {
      const close = findLatexClose(src, i + 2, ']')
      if (close !== -1) {
        const inner = src.slice(i + 2, close).trim()
        if (inner !== '') {
          flushSeg(i)
          let before = ''
          let after = ''
          let nextIdx = close + 2
          if (quoteDepth === 0) {
            // Trim horizontal spaces immediately before `\[` and after `\]` so the
            // emitted display block sits between clean blank lines without leaving a
            // leading space on the following paragraph (which would look indented to
            // `splitMarkdownBlocks`).
            while (out.length > 0) {
              const last = out[out.length - 1]
              const trimmed = last.replace(/[ \t]+$/, '')
              if (trimmed === last) break
              if (trimmed === '') out.pop()
              else { out[out.length - 1] = trimmed; break }
            }
            if (hasPrecedingContent(out)) {
              const haveBefore = trailingNewlines(out)
              if (haveBefore < 2) before = '\n'.repeat(2 - haveBefore)
            }
            while (nextIdx < src.length && (src[nextIdx] === ' ' || src[nextIdx] === '\t')) nextIdx += 1
            if (nextIdx < src.length) {
              const haveAfter = leadingNewlines(src, nextIdx)
              if (haveAfter < 2 && hasNonWhitespaceFrom(src, nextIdx)) after = '\n'.repeat(2 - haveAfter)
            }
          } else {
            const prev = out.at(-1)
            if (prev !== undefined && !prev.endsWith('\n')) before = '\n'
            const nextCh = src[nextIdx]
            if (nextCh !== undefined && nextCh !== '\n') after = '\n'
          }
          out.push(`${before}$$\n${inner}\n$$${after}`)
          return nextIdx
        }
      }
    }
    // Inline math: `\(...\)` (single-line only to avoid swallowing prose)
    if (src[i + 1] === '(') {
      const close = findLatexClose(src, i + 2, ')', true)
      if (close !== -1) {
        const inner = src.slice(i + 2, close).trim()
        if (inner !== '') {
          flushSeg(i)
          out.push(`$${inner}$`)
          return close + 2
        }
      }
    }
    return i
  })
}

function findLatexClose(text, start, closer, singleLine = false) {
  for (let i = start; i < text.length; i += 1) {
    if (singleLine && text[i] === '\n') return -1
    if (text[i] === '\\') {
      if (text[i + 1] === closer) return i
      i += 1
    }
  }
  return -1
}

const CURRENCY_NUM_RE = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[kKmMbBtT](?![A-Za-z0-9_]))?/

function findNextSingleDollar(text, start) {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n' || ch === '`') return -1
    if (ch === '\\') { i += 1; continue }
    if (ch === '$') {
      if (text[i + 1] === '$') return -1
      return i
    }
  }
  return -1
}

function isCurrencyOpeningDollar(text, open, close) {
  if (close === -1) return false
  if (open > 0 && /[A-Za-z0-9]/.test(text[open - 1])) return false
  const inner = text.slice(open + 1, close)
  if (inner === '') return false
  const numMatch = CURRENCY_NUM_RE.exec(inner)
  if (!numMatch) return false

  const afterNum = inner.slice(numMatch[0].length)
  const afterClose = text[close + 1] ?? ''

  // Closing `$` followed immediately by a digit (e.g. `$100-$200`, `$10–$20`, `$5/$10`, `价格$5和$10`, `$5 and $10`).
  if (/\d/.test(afterClose)) return true
  // Trailing whitespace before the next `$` (e.g. `The item costs $5 and the answer is $x^2$.`).
  if (/\s$/.test(inner)) return true
  // Currency amount followed by CJK/non-ASCII text or English prose words without TeX/math operators.
  if (afterNum !== '' && !/[\\^_{}=<>|]/.test(afterNum)) {
    if (/[^\x00-\x7F]/.test(afterNum)) return true
    if (/^(?:,\s|\s+[A-Za-z]{2,})/.test(afterNum)) return true
  }
  return false
}

// Matches a standalone flow display-math opener (`^ {0,3}\${2,}[ \t]*\r?\n`) at `start`
// and returns the index right after its matching closing line (`^ {0,3}\${dollars,}[ \t]*$`),
// allowing blank lines inside flow `$$...$$` blocks (matching CommonMark / remark-math).
// Returns -1 if `start` is not a standalone flow opener or has no closing fence.
function findFlowMathFenceClose(src, start) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1
  if (start - lineStart > 3) return -1
  for (let k = lineStart; k < start; k += 1) {
    if (src[k] !== ' ') return -1
  }
  let dollars = 0
  while (start + dollars < src.length && src[start + dollars] === '$') dollars += 1
  if (dollars < 2) return -1
  let pos = start + dollars
  while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\r')) pos += 1
  if (pos >= src.length || src[pos] !== '\n') return -1
  pos += 1
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos)
    const lineEnd = nl === -1 ? src.length : nl
    let spaces = 0
    while (pos + spaces < lineEnd && src[pos + spaces] === ' ') spaces += 1
    if (spaces <= 3) {
      let c = 0
      while (pos + spaces + c < lineEnd && src[pos + spaces + c] === '$') c += 1
      if (c >= dollars) {
        let tail = pos + spaces + c
        while (tail < lineEnd && (src[tail] === ' ' || src[tail] === '\t' || src[tail] === '\r')) tail += 1
        if (tail === lineEnd) return pos + spaces + c
      }
    }
    if (nl === -1) break
    pos = nl + 1
  }
  return -1
}

/**
 * Disambiguates currency dollar signs (e.g. `$5 and $10`, `$100-$200`, `价格$5和$10`,
 * `The item costs $5 and the answer is $x^2$.`) BEFORE `remark-math` pairs inline `$...$`,
 * so a leading price never borrows the opening `$` of a nearby real equation.
 * Preserves fenced code, CommonMark indented code, inline code, `$$...$$`, and escaped `\$`.
 */
export function escapeCurrencyDollars(text) {
  if (typeof text !== 'string' || !text.includes('$')) return text
  return walkMarkdownProse(text, (src, i, out, quoteDepth, flushSeg) => {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length) return i + 2
    if (ch !== '$') return i
    // Preserve display math `$$...$$` intact.
    if (src[i + 1] === '$') {
      if (quoteDepth === 0) {
        const flowClose = findFlowMathFenceClose(src, i)
        if (flowClose !== -1) return flowClose
      }
      // Inline (non-flow) `$$` cannot cross blank lines; bound the scan to the current paragraph
      // so an unclosed `$$` in one paragraph never hides currency in a later paragraph.
      const limit = findParagraphEnd(src, i + 2)
      let j = i + 2
      while (j + 1 < limit) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '$') return j + 2
        j += 1
      }
      return i + 2
    }
    const close = findNextSingleDollar(src, i + 1)
    if (isCurrencyOpeningDollar(src, i, close)) {
      flushSeg(i)
      out.push('\\$')
      return i + 1
    }
    // Real inline math span `$...$`: skip verbatim through closing `$` so we don't inspect its body.
    if (close !== -1) return close + 1
    return i + 1
  })
}

// Second-line safety net for any remaining accidental currency/prose spans.
// Preserves valid inline numeric arithmetic like `$10-3$` and `$1/2$` while still catching
// unfinished currency ranges (`$100-$`) and currency-followed-by-prose spans.
function looksLikeCurrencyProse(value) {
  if (typeof value !== 'string') return true
  if (value === '' || /^\s/.test(value) || /\s$/.test(value)) return true
  if (/^\d[\d,.]*(?:[-–—/~·]$|\s+[A-Za-z]+|[^\x00-\x7F])/.test(value) && !/[\\^_{}=<>|]/.test(value)) return true
  if (/\s/.test(value) && !/[\\^_{}=<>+\-*/|()[\]]/.test(value) && /^[A-Za-z0-9.,;:!?\s'-]+$/.test(value)) return true
  return false
}

/**
 * Remark plugin paired with `remark-math`: restores single-dollar currency false positives
 * (e.g. `$5 and $10`) back into plain text while keeping real inline & display math nodes.
 */
export function remarkGuardCurrencyMath() {
  function walk(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i]
      if (child.type === 'inlineMath' && looksLikeCurrencyProse(child.value)) {
        node.children[i] = { type: 'text', value: `$${child.value}$` }
      } else {
        walk(child)
      }
    }
  }
  return tree => { walk(tree) }
}

/**
 * Renders inline or display math with lazy-loaded KaTeX (falls back gracefully to TeX text until loaded).
 */
export const MathExpression = memo(function MathExpression({ tex, display = false }) {
  const [, setReady] = useState(() => isKatexLoaded())
  const loaded = isKatexLoaded()
  const html = useMemo(() => (loaded ? renderKatexSync(tex, display) : null), [tex, display, loaded])

  useEffect(() => {
    if (katexApi !== null) return undefined
    let alive = true
    void ensureKatex().then((api) => {
      if (alive && api !== null) setReady(true)
    })
    return () => { alive = false }
  }, [])

  if (html !== null) {
    if (display) {
      return h('div', {
        className: 'dsb-math-block',
        'data-math-display': '',
        'data-tex': tex,
        dangerouslySetInnerHTML: { __html: html },
      })
    }
    return h('span', {
      className: 'dsb-math-inline',
      'data-math-inline': '',
      'data-tex': tex,
      dangerouslySetInnerHTML: { __html: html },
    })
  }

  return display
    ? h('pre', { className: 'dsb-math-block dsb-math-fallback', 'data-math-display': '', 'data-tex': tex }, h('code', null, tex))
    : h('code', { className: 'dsb-math-inline dsb-math-fallback', 'data-math-inline': '', 'data-tex': tex }, tex)
})
