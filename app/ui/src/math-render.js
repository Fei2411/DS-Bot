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

/**
 * Converts LaTeX `\(...\)` and `\[...\]` math delimiters into `$...$` / `$$...$$`
 * outside fenced code blocks (` ``` ` / `~~~`) and inline code spans.
 */
export function normalizeMathDelimiters(text) {
  if (typeof text !== 'string' || (!text.includes('\\(') && !text.includes('\\['))) return text
  const out = []
  let i = 0
  let lineStart = true
  let fenceChar = ''
  let fenceLen = 0

  while (i < text.length) {
    if (lineStart) {
      let lead = i
      let spaces = 0
      while (lead < text.length && text[lead] === ' ' && spaces < 3) {
        lead += 1
        spaces += 1
      }
      const ch = text[lead]
      if (ch === '`' || ch === '~') {
        let count = 0
        while (lead + count < text.length && text[lead + count] === ch) count += 1
        if (count >= 3) {
          if (fenceChar === '') {
            fenceChar = ch
            fenceLen = count
          } else if (ch === fenceChar && count >= fenceLen) {
            const after = text.slice(lead + count)
            const nl = after.indexOf('\n')
            const rest = nl === -1 ? after : after.slice(0, nl)
            if (rest.trim() === '') {
              fenceChar = ''
              fenceLen = 0
            }
          }
          const nl = text.indexOf('\n', lead)
          const end = nl === -1 ? text.length : nl + 1
          out.push(text.slice(i, end))
          i = end
          lineStart = true
          continue
        }
      }
      if (fenceChar !== '') {
        const nl = text.indexOf('\n', i)
        const end = nl === -1 ? text.length : nl + 1
        out.push(text.slice(i, end))
        i = end
        lineStart = true
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
      let ticks = 0
      while (i + ticks < text.length && text[i + ticks] === '`') ticks += 1
      const needle = '`'.repeat(ticks)
      let close = text.indexOf(needle, i + ticks)
      while (close !== -1) {
        const beforeOk = close === 0 || text[close - 1] !== '`'
        const afterOk = close + ticks >= text.length || text[close + ticks] !== '`'
        if (beforeOk && afterOk) break
        close = text.indexOf(needle, close + 1)
      }
      if (close !== -1) {
        out.push(text.slice(i, close + ticks))
        i = close + ticks
        continue
      }
      out.push(needle)
      i += ticks
      continue
    }

    // Escaped backslash (`\\`) stays literal so `\\(` is not treated as math.
    if (ch === '\\' && text[i + 1] === '\\') {
      out.push('\\\\')
      i += 2
      continue
    }

    // Display math: `\[ ... \]`
    if (ch === '\\' && text[i + 1] === '[') {
      const close = findLatexClose(text, i + 2, ']')
      if (close !== -1) {
        const inner = text.slice(i + 2, close).trim()
        if (inner !== '') {
          const prev = out.at(-1)
          const needBefore = prev !== undefined && !prev.endsWith('\n')
          const nextCh = text[close + 2]
          const needAfter = nextCh !== undefined && nextCh !== '\n'
          out.push(`${needBefore ? '\n' : ''}$$\n${inner}\n$$${needAfter ? '\n' : ''}`)
          i = close + 2
          lineStart = !needAfter ? false : true
          continue
        }
      }
    }

    // Inline math: `\(...\)` (single-line only to avoid swallowing prose)
    if (ch === '\\' && text[i + 1] === '(') {
      const close = findLatexClose(text, i + 2, ')', true)
      if (close !== -1) {
        const inner = text.slice(i + 2, close).trim()
        if (inner !== '') {
          out.push(`$${inner}$`)
          i = close + 2
          continue
        }
      }
    }

    out.push(ch)
    i += 1
  }
  return out.join('')
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

// Heuristic rejecting accidental currency spans like `$5 and $10` or `$12.50 to $20`.
function looksLikeCurrencyProse(value) {
  if (typeof value !== 'string') return true
  if (value === '' || /^\s/.test(value) || /\s$/.test(value)) return true
  // Leading digit followed by prose words without math operators/commands.
  if (/^\d[\d,.]*(?:\s+[A-Za-z]+)+/.test(value) && !/[\\^_{}=<>+\-*/|]/.test(value)) return true
  // Plain multi-word English sentence without any TeX/math tokens.
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
