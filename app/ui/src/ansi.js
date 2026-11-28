// Pure ANSI escape sequence parser and React renderer.
// Kept zero-dependency so tool output cards can colorize command output without
// pulling `@xterm/xterm` into the first-load desktop bundle.
import { createElement as h } from 'react'

const ESC_CODE = 0x1b
const BEL_CODE = 0x07

const FG_CODES = new Map([
  [30, 'gray'], [31, 'red'], [32, 'green'], [33, 'yellow'], [34, 'blue'], [35, 'magenta'], [36, 'cyan'], [37, 'ink'],
  [90, 'gray'], [91, 'red'], [92, 'green'], [93, 'yellow'], [94, 'blue'], [95, 'magenta'], [96, 'cyan'], [97, 'ink'],
])

/**
 * Fast check for ANSI escapes or terminal cursor-control characters (`\x1b`, `\r`, `\b`).
 * Plain command output skips full parsing completely.
 * @param {string} raw
 * @returns {boolean}
 */
export function hasAnsiSequence(raw) {
  if (typeof raw !== 'string' || raw === '') return false
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code === ESC_CODE || code === 0x08) return true
    if (code === 0x0d && raw.charCodeAt(i + 1) !== 0x0a) return true
  }
  return false
}

/**
 * Parses ANSI escape sequences and terminal cursor edits into styled text spans.
 * @param {string} raw
 * @returns {Array<{ text: string, fg?: string, bold?: boolean, dim?: boolean }>}
 */
export function parseAnsiSpans(raw) {
  const src = String(raw ?? '')
  if (src === '') return []
  const lines = []
  let line = []
  let col = 0
  let fg
  let bold = false
  let dim = false

  const finishLine = () => {
    while (line.length > col) {
      const tail = line[line.length - 1]
      if (tail.ch !== ' ' || tail.fg || tail.bold || tail.dim) break
      line.pop()
    }
    lines.push(line)
    line = []
    col = 0
  }

  const putChar = (ch) => {
    while (line.length < col) line.push({ ch: ' ' })
    line[col] = { ch, ...(fg ? { fg } : {}), ...(bold ? { bold: true } : {}), ...(dim ? { dim: true } : {}) }
    col += 1
  }

  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i)
    if (code === 0x0d) {
      if (src.charCodeAt(i + 1) === 0x0a) {
        i += 1
        finishLine()
      } else {
        col = 0
      }
      continue
    }
    if (code === 0x0a) {
      finishLine()
      continue
    }
    if (code === 0x08) {
      col = Math.max(0, col - 1)
      continue
    }
    if (code === ESC_CODE) {
      const next = src[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < src.length && ((src.charCodeAt(j) >= 0x30 && src.charCodeAt(j) <= 0x3f) || (src.charCodeAt(j) >= 0x20 && src.charCodeAt(j) <= 0x2f))) {
          j += 1
        }
        const params = src.slice(i + 2, j)
        const finalByte = j < src.length ? src[j] : ''
        i = j < src.length ? j : src.length - 1
        if (finalByte === 'm') {
          const codes = (params === '' ? '0' : params).split(';').map(n => Number.parseInt(n, 10))
          for (let k = 0; k < codes.length; k += 1) {
            const sgr = codes[k]
            if (Number.isNaN(sgr) || sgr === 0) {
              fg = undefined
              bold = false
              dim = false
            } else if (sgr === 38 || sgr === 48) {
              const mode = codes[k + 1]
              if (mode === 5) k += 2
              else if (mode === 2) k += 4
            } else if (sgr === 1) {
              bold = true
            } else if (sgr === 2) {
              dim = true
            } else if (sgr === 22) {
              bold = false
              dim = false
            } else if (sgr === 39) {
              fg = undefined
            } else if (FG_CODES.has(sgr)) {
              fg = FG_CODES.get(sgr)
            }
          }
        } else if (finalByte === 'K') {
          const mode = params === '' ? 0 : Number.parseInt(params.split(';')[0], 10)
          if (Number.isNaN(mode) || mode === 0) {
            if (col < line.length) line.length = col
          } else if (mode === 1) {
            for (let k = 0; k <= Math.min(col, line.length - 1); k += 1) line[k] = { ch: ' ' }
          } else if (mode === 2) {
            line.length = 0
          }
        } else if (finalByte === 'J') {
          const mode = params === '' ? 0 : Number.parseInt(params.split(';')[0], 10)
          if (Number.isNaN(mode) || mode === 0) {
            if (col < line.length) line.length = col
          } else if (mode === 2 || mode === 3) {
            lines.length = 0
            line = []
            col = 0
          }
        } else if (finalByte === 'D') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col = Math.max(0, col - n)
        } else if (finalByte === 'C') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col += n
        } else if (finalByte === 'G') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col = n - 1
        } else if (finalByte === 'P') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          if (col < line.length) line.splice(col, n)
        } else if (finalByte === '@') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          while (line.length < col) line.push({ ch: ' ' })
          line.splice(col, 0, ...Array.from({ length: n }, () => ({ ch: ' ' })))
        }
        continue
      }
      if (next === ']') {
        let j = i + 2
        while (j < src.length) {
          const c = src.charCodeAt(j)
          if (c === BEL_CODE) { i = j; break }
          if (c === ESC_CODE && src[j + 1] === '\\') { i = j + 1; break }
          j += 1
        }
        if (j >= src.length) i = src.length - 1
        continue
      }
      if (next === '(' || next === ')' || next === '#') {
        i = Math.min(src.length - 1, i + 2)
        continue
      }
      i = Math.min(src.length - 1, i + 1)
      continue
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) continue
    putChar(src[i])
  }
  finishLine()

  const spans = []
  const pushCell = (ch, cellFg, cellBold, cellDim) => {
    const last = spans[spans.length - 1]
    if (last && last.fg === cellFg && Boolean(last.bold) === Boolean(cellBold) && Boolean(last.dim) === Boolean(cellDim)) {
      last.text += ch
    } else {
      spans.push({
        text: ch,
        ...(cellFg ? { fg: cellFg } : {}),
        ...(cellBold ? { bold: true } : {}),
        ...(cellDim ? { dim: true } : {}),
      })
    }
  }
  for (let li = 0; li < lines.length; li += 1) {
    if (li > 0) pushCell('\n', undefined, false, false)
    for (const cell of lines[li]) {
      pushCell(cell.ch, cell.fg, cell.bold, cell.dim)
    }
  }
  return spans
}

/**
 * Clips parsed ANSI spans to at most `maxLines` lines and `maxChars` characters,
 * preserving style boundaries and returning total plain-text line count.
 */
export function clipAnsiSpans(spans, maxLines, maxChars) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return { shown: [], folded: false, lines: 0, plain: '' }
  }
  let plain = ''
  for (const span of spans) plain += span.text
  let totalLines = 1
  for (let i = 0; i < plain.length; i += 1) {
    if (plain.charCodeAt(i) === 10) totalLines += 1
  }
  const tooLong = totalLines > maxLines || plain.length > maxChars
  if (!tooLong) {
    return { shown: spans, folded: false, lines: totalLines, plain }
  }

  const out = []
  let lineCount = 1
  let charCount = 0
  let truncated = false

  for (const span of spans) {
    if (truncated) break
    let sliceEnd = 0
    for (let i = 0; i < span.text.length; i += 1) {
      if (charCount >= maxChars) {
        truncated = true
        break
      }
      if (span.text.charCodeAt(i) === 10) {
        if (lineCount >= maxLines) {
          truncated = true
          break
        }
        lineCount += 1
      }
      charCount += 1
      sliceEnd = i + 1
    }
    if (sliceEnd > 0) {
      out.push(sliceEnd === span.text.length ? span : { ...span, text: span.text.slice(0, sliceEnd) })
    }
  }
  out.push({ text: '\n…' })
  return { shown: out, folded: true, lines: totalLines, plain }
}

/**
 * Renders parsed ANSI spans as React children using theme-driven `.dsb-ansi` hooks.
 */
export function renderAnsiSpans(spans, keyPrefix = 'ansi') {
  if (!Array.isArray(spans) || spans.length === 0) return ''
  return spans.map((span, index) => (span.fg || span.bold || span.dim
    ? h('span', {
      key: `${keyPrefix}:${index}`,
      className: 'dsb-ansi',
      'data-fg': span.fg || undefined,
      'data-bold': span.bold || undefined,
      'data-dim': span.dim || undefined,
    }, span.text)
    : span.text))
}
