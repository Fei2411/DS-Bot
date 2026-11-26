// Lazy-loaded KaTeX math rendering and CommonMark/LaTeX math compatibility helpers.
// Supports `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and fenced ```math blocks while
// avoiding currency false positives (`$5 and $10`). KaTeX and its stylesheet load only
// when a message actually contains math.
import { createElement as h, useEffect, useState } from 'react'

let katexApi = null
let katexLoadPromise = null
let styleLoader = null

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
  try {
    return katexApi.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      maxExpand: 1000,
    })
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

function readInlineCodeSpan(text, start) {
  let ticks = 0
  while (start + ticks < text.length && text[start + ticks] === '`') ticks += 1
  const needle = '`'.repeat(ticks)
  let close = text.indexOf(needle, start + ticks)
  while (close !== -1) {
    const beforeOk = close === 0 || text[close - 1] !== '`'
    const afterOk = close + ticks >= text.length || text[close + ticks] !== '`'
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

/**
 * Walks CommonMark source while preserving fenced code blocks (` ``` ` / `~~~`),
 * CommonMark indented code blocks (4+ spaces / tab after blank line, including inside
 * blockquotes), and inline backtick spans completely untouched, calling
 * `onProseChar(text, i, out)` for non-code characters.
 */
function walkMarkdownProse(text, onProseChar) {
  const out = []
  let i = 0
  let lineStart = true
  let prevLineBlank = true
  let prevQuoteDepth = 0
  let inIndentedCode = false
  let fenceChar = ''
  let fenceLen = 0
  let fenceQuoteDepth = 0

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
        out.push(text.slice(i, lineEnd))
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
        out.push(text.slice(i, lineEnd))
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
        out.push(text.slice(i, lineEnd))
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
            out.push(text.slice(i, lineEnd))
            i = lineEnd
            lineStart = true
            continue
          }
        }
      }

      if (contentStart > i) {
        out.push(text.slice(i, contentStart))
        i = contentStart
        lineStart = false
        continue
      }
    }

    const ch = text[i]
    if (ch === '\n') {
      out.push('\n')
      i += 1
      lineStart = true
      continue
    }
    lineStart = false

    // Skip inline code spans with exact matching backtick count.
    if (ch === '`') {
      const end = readInlineCodeSpan(text, i)
      out.push(text.slice(i, end))
      i = end
      continue
    }

    const next = onProseChar(text, i, out)
    if (next > i) {
      if (text[next - 1] === '\n') lineStart = true
      i = next
      continue
    }

    out.push(ch)
    i += 1
  }
  return out.join('')
}

/**
 * Converts LaTeX `\(...\)` and `\[...\]` math delimiters into `$...$` / `$$...$$`
 * outside fenced code blocks (` ``` ` / `~~~`), CommonMark indented code blocks,
 * and inline code spans.
 */
export function normalizeMathDelimiters(text) {
  if (typeof text !== 'string' || (!text.includes('\\(') && !text.includes('\\['))) return text
  return walkMarkdownProse(text, (src, i, out) => {
    const ch = src[i]
    // Escaped backslash (`\\`) stays literal so `\\(` is not treated as math.
    if (ch === '\\' && src[i + 1] === '\\') {
      out.push('\\\\')
      return i + 2
    }
    // Display math: `\[ ... \]`
    if (ch === '\\' && src[i + 1] === '[') {
      const close = findLatexClose(src, i + 2, ']')
      if (close !== -1) {
        const inner = src.slice(i + 2, close).trim()
        if (inner !== '') {
          const prev = out.at(-1)
          const needBefore = prev !== undefined && !prev.endsWith('\n')
          const nextCh = src[close + 2]
          const needAfter = nextCh !== undefined && nextCh !== '\n'
          out.push(`${needBefore ? '\n' : ''}$$\n${inner}\n$$${needAfter ? '\n' : ''}`)
          return close + 2
        }
      }
    }
    // Inline math: `\(...\)` (single-line only to avoid swallowing prose)
    if (ch === '\\' && src[i + 1] === '(') {
      const close = findLatexClose(src, i + 2, ')', true)
      if (close !== -1) {
        const inner = src.slice(i + 2, close).trim()
        if (inner !== '') {
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

/**
 * Disambiguates currency dollar signs (e.g. `$5 and $10`, `$100-$200`, `价格$5和$10`,
 * `The item costs $5 and the answer is $x^2$.`) BEFORE `remark-math` pairs inline `$...$`,
 * so a leading price never borrows the opening `$` of a nearby real equation.
 * Preserves fenced code, CommonMark indented code, inline code, `$$...$$`, and escaped `\$`.
 */
export function escapeCurrencyDollars(text) {
  if (typeof text !== 'string' || !text.includes('$')) return text
  return walkMarkdownProse(text, (src, i, out) => {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length) {
      out.push(src.slice(i, i + 2))
      return i + 2
    }
    if (ch !== '$') return i
    // Preserve display math `$$...$$` intact.
    if (src[i + 1] === '$') {
      let j = i + 2
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '$') {
          out.push(src.slice(i, j + 2))
          return j + 2
        }
        j += 1
      }
      out.push('$$')
      return i + 2
    }
    const close = findNextSingleDollar(src, i + 1)
    if (isCurrencyOpeningDollar(src, i, close)) {
      out.push('\\$')
      return i + 1
    }
    // Real inline math span `$...$`: copy verbatim through closing `$` so we don't inspect its body.
    if (close !== -1) {
      out.push(src.slice(i, close + 1))
      return close + 1
    }
    out.push('$')
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
export function MathExpression({ tex, display = false }) {
  const [, setReady] = useState(() => isKatexLoaded())
  const html = renderKatexSync(tex, display)

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
}
