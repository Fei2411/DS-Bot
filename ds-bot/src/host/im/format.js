// Outbound text for IM platforms. Bots write Markdown; each platform adapter turns it
// into what the platform renders (Telegram HTML) or plain text, and cuts it at the
// platform's per-message limit without breaking inside a code fence when it can help it.

const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Inline Markdown inside one line or block: `code`, **bold**, _italic_, ~~strike~~,
// [label](url). Code spans are pulled out first so markers inside them stay literal.
function withCodeSpans(line, renderCode, renderInline) {
  const spans = []
  const kept = line.replace(/`([^`]+)`/g, (_all, code) => {
    spans.push(renderCode(code))
    return `\x00${spans.length - 1}\x00`
  })
  return renderInline(kept).replace(/\u0000(\d+)\u0000/g, (_all, index) => spans[Number(index)])
}

function inlineHtml(line) {
  return withCodeSpans(line, code => `<code>${escapeHtml(code)}</code>`, kept => escapeHtml(kept)
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => `<a href="${escapeHtml(url)}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\b_([^_]+)_\b/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>'))
}

function stripInlineFormatting(line) {
  return line
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => (label === url ? label : `${label} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\b_([^_]+)_\b/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

const inlinePlain = line => stripInlineFormatting(line.replace(/`([^`]+)`/g, '$1'))
const inlineTablePlain = line => withCodeSpans(line, code => code, stripInlineFormatting)

// One Markdown document as blocks: fenced code stays a block of its own so chunking
// can keep it whole; the rest splits on blank lines.
function blocks(markdown) {
  const out = []
  const lines = String(markdown).split('\n')
  let at = 0
  let buffer = []
  const flush = () => {
    if (buffer.length > 0) out.push({ kind: 'text', lines: buffer })
    buffer = []
  }
  while (at < lines.length) {
    const line = lines[at]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence !== null) {
      flush()
      const close = lines.slice(at + 1).findIndex(item => /^```\s*$/.test(item))
      const body = close === -1 ? lines.slice(at + 1) : lines.slice(at + 1, at + 1 + close)
      out.push({ kind: 'code', lang: fence[1] ?? '', lines: body, open: true })
      at += 1 + (close === -1 ? body.length : close + 1)
      continue
    }
    if (line.trim() === '') flush()
    else buffer.push(line)
    at += 1
  }
  flush()
  return out
}

const codeHtmlOpen = lang => lang ? `<pre><code class="language-${escapeHtml(lang).replaceAll('"', '&quot;')}">` : '<pre><code>'
const renderCodeHtml = block => `${codeHtmlOpen(block.lang)}${escapeHtml(block.lines.join('\n'))}</code></pre>`

const renderPlain = block => (block.kind === 'code' ? block.lines.join('\n') : block.lines.map(inlinePlain).join('\n'))

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)\s*$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
const TABLE_DELIMITER = /^:?-+:?$/
const LITERAL_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/
const LITERAL_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/

function literalFenceGuard(source) {
  const laterClosers = { '`': new Uint32Array(source.length), '~': new Uint32Array(source.length) }
  const widestCloser = { '`': 0, '~': 0 }
  for (let at = source.length - 1; at >= 0; at -= 1) {
    laterClosers['`'][at] = widestCloser['`']
    laterClosers['~'][at] = widestCloser['~']
    const close = LITERAL_FENCE_CLOSE.exec(source[at])?.[1]
    if (close) widestCloser[close[0]] = Math.max(widestCloser[close[0]], close.length)
  }
  let marker = ''
  let listIndent = 0
  return (at, canOpen = true) => {
    const line = source[at]
    const indent = /^ */.exec(line)[0].length
    if (listIndent > indent && line.trim() !== '') {
      marker = ''
      listIndent = 0
    }
    if (marker !== '') {
      const close = LITERAL_FENCE_CLOSE.exec(line)?.[1]
      if (close?.[0] === marker[0] && close.length >= marker.length) {
        marker = ''
        listIndent = 0
      }
      return true
    }
    if (!canOpen) return false
    const listPrefix = LIST_ITEM.exec(line)?.[0]
    const fence = LITERAL_FENCE_OPEN.exec(listPrefix ? line.slice(listPrefix.length) : line)
    if (fence === null || (fence[1][0] === '`' && fence[2].includes('`'))) return false
    marker = fence[1]
    // Only an unmatched list fence can end on dedent instead of on a fence marker.
    if (laterClosers[marker[0]][at] < marker.length) {
      if (listPrefix) listIndent = listPrefix.length
      else if (marker[0] === '`' && indent > 0) {
        const previousListIndent = LIST_ITEM.exec(source[at - 1] ?? '')?.[0].length ?? 0
        if (previousListIndent <= indent) listIndent = previousListIndent
      }
    }
    return true
  }
}

function tableCells(line) {
  if (/^ {0,3}[\t>]|^ {4}/.test(line) || ATX_HEADING.test(line)) return undefined
  const cells = ['']
  for (const part of line.trim().match(/\\.|(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)|[^\\`|]+|`+|\\|\|/g) ?? []) {
    if (part === '|') cells.push('')
    else cells[cells.length - 1] += part.replace(/\\./g, escape => escape === '\\|' ? '|' : escape)
  }
  if (cells.length === 1) return undefined
  const leadingPipe = cells[0] === ''
  const trailingPipe = cells.at(-1) === ''
  if (leadingPipe) cells.shift()
  if (trailingPipe) cells.pop()
  return { cells: cells.map(cell => cell.trim()), leadingPipe, trailingPipe }
}

function tableRow(line, header) {
  if (LIST_ITEM.test(line)) return undefined
  const row = tableCells(line)
  if (row === undefined || header === undefined) return row
  return row.cells.length === header.cells.length
    && (!header.leadingPipe || row.leadingPipe)
    && (!header.trailingPipe || row.trailingPipe) ? row : undefined
}

function telegramLines(lines, isLiteral) {
  const rendered = []
  const tableLine = at => isLiteral[at] ? '' : lines[at] ?? ''
  const renderTableRow = (headers, row) => {
    for (const [index, header] of headers.entries()) {
      const label = row === undefined ? header : header + ':'
      const value = row?.[index] ?? ''
      rendered.push({
        html: '• <b>' + inlineHtml(label) + '</b>' + (value ? ' ' + inlineHtml(value) : ''),
        text: '• ' + inlineTablePlain(label) + (value ? ' ' + inlineTablePlain(value) : ''),
      })
    }
  }
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    if (isLiteral[at]) {
      rendered.push({ html: inlineHtml(line), text: inlinePlain(line) })
      continue
    }
    const next = tableLine(at + 1)
    if (next.includes('-')) {
      const delimiters = tableCells(next)?.cells
      if (delimiters?.length > 0 && delimiters.every(cell => TABLE_DELIMITER.test(cell))) {
        const header = tableRow(line)
        if (header?.cells.length === delimiters.length) {
          at += 1
          let row = tableRow(tableLine(at + 1), header)
          if (row === undefined) renderTableRow(header.cells)
          while (row !== undefined) {
            at += 1
            renderTableRow(header.cells, row.cells)
            row = tableRow(tableLine(at + 1), header)
            if (row !== undefined) rendered.push({ html: '', text: '' })
          }
          continue
        }
      }
    }
    const heading = ATX_HEADING.exec(line)
    const isHeading = heading !== null && !/^#+$/.test(heading[1])
    const content = isHeading ? heading[1].replace(/[ \t]+#+$/, '') : line
    const html = inlineHtml(content)
    rendered.push({ html: isHeading ? '<b>' + html + '</b>' : html, text: inlinePlain(content) })
  }
  return rendered
}

export function toPlain(markdown) {
  return blocks(markdown).map(renderPlain).join('\n')
}

const points = text => Array.from(text).length

// Split oversized blocks at line boundaries, using escaped plain text if a line
// itself is too long. Split a code fence into several fenced blocks.
function forceCut(block, limit, lines) {
  if (block.kind !== 'code') {
    const chunks = []
    let html = ''
    let text = ''
    const flush = () => {
      if (html === '') return
      chunks.push({ html, text })
      html = ''
      text = ''
    }
    for (const { html: lineHtml, text: lineText } of lines) {
      const candidate = html === '' ? lineHtml : `${html}\n${lineHtml}`
      if (points(candidate) <= limit) {
        html = candidate
        text = text === '' ? lineText : `${text}\n${lineText}`
        continue
      }
      flush()
      if (points(lineHtml) <= limit) {
        html = lineHtml
        text = lineText
        continue
      }
      let used = 0
      for (const char of lineText) {
        const escaped = escapeHtml(char)
        const width = escaped === char ? 1 : escaped.length
        if (used + width > limit) {
          flush()
          used = 0
        }
        html += escaped
        text += char
        used += width
      }
    }
    flush()
    return chunks
  }
  const chunks = []
  const open = codeHtmlOpen(block.lang)
  const close = '</code></pre>'
  let body = block.lines.join('\n')
  const room = Math.max(1, limit - points(open) - points(close))
  while (body !== '') {
    const chars = Array.from(body)
    // Cut on what the platform receives, not on the raw code: "<" and "&" become
    // "&lt;" and "&amp;", so a fence of markup renders three to five times longer
    // than the text this cut used to be computed from, and the chunk went out over
    // the limit the caller asked for.
    let at = 0
    let used = 0
    while (at < chars.length) {
      const width = escapeHtml(chars[at]).length
      if (used + width > room) break
      used += width
      at += 1
    }
    // A limit too small to hold even one character still has to make progress.
    if (at === 0) at = 1
    // Prefer a line boundary in the second half, so a cut does not split a line
    // that would have fit on its own.
    let cut = at
    for (let index = at - 1; index >= 0; index -= 1) {
      if (chars[index] === '\n') {
        if (index > at / 2) cut = index
        break
      }
    }
    const part = chars.slice(0, cut).join('')
    chunks.push({ html: `${open}${escapeHtml(part)}${close}`, text: part })
    body = chars.slice(cut).join('').replace(/^\n/, '')
  }
  return chunks
}

// Blank lines at the very start and end of a message: clients show them as an empty
// first line above the text or as extra space under it, and nothing in the Markdown
// needs them. Only whitespace-only edge lines go; blank lines inside the text and the
// indentation of a content line stay exactly as written. Scan lines linearly so a long
// run of blank lines before content never backtracks.
const BLANK_EDGE_LINE = /^[ \t\u3000\r]*$/
function withoutBlankEdges(text) {
  const lines = text.split('\n')
  let start = 0
  let end = lines.length
  while (start < end && BLANK_EDGE_LINE.test(lines[start])) start += 1
  while (end > start && BLANK_EDGE_LINE.test(lines[end - 1])) end -= 1
  if (start === end) return ''
  if (start === 0 && end === lines.length) return text
  const body = lines.slice(start, end).join('\n')
  return end < lines.length && body.endsWith('\r') ? body.slice(0, -1) : body
}

// Chunks of one Markdown message, each under `limit` rendered characters. Block
// boundaries are kept where possible; a fence is only split when it alone is too big.
// Plain markdown chunks at a byte-pair limit: paragraphs and lines first, a
// hard cut at the limit for one over-long run. For platforms that take
// markdown as-is (Discord, QQ, WeCom, DingTalk, Slack has its own converter).
export function chunkMarkdown(markdown, limit) {
  const chunks = []
  // Trim before cutting, so the first chunk cannot open and the last cannot close on
  // a blank line. A message that is only whitespace has nothing to send: it returns
  // no chunk, the same as an empty string.
  let rest = withoutBlankEdges(String(markdown ?? ''))
  if (rest.trim() === '') return chunks
  while (rest !== '') {
    if (points(rest) <= limit) { chunks.push(rest); break }
    let at = limit
    const newline = rest.lastIndexOf('\n', at)
    if (newline > limit / 2) at = newline
    else {
      const space = rest.lastIndexOf(' ', at)
      if (space > limit / 2) at = space
    }
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  return chunks
}

export function chunkTelegram(markdown, limit = 4096) {
  const chunks = []
  const source = String(markdown).split('\n')
  const isLiteral = literalFenceGuard(source)
  let at = 0
  let html = ''
  let text = ''
  const flush = () => {
    if (html === '' && text === '') return
    chunks.push({ html, text })
    html = ''
    text = ''
  }
  for (const block of blocks(markdown)) {
    while (source[at]?.trim() === '') at += 1
    const isCode = block.kind === 'code'
    let lines
    if (isCode) {
      isLiteral(at)
      // A legacy code body can close an outer guard, but cannot start another one.
      const end = Math.min(source.length, at + block.lines.length + 2)
      for (let index = at + 1; index < end; index += 1) isLiteral(index, false)
      lines = []
    } else {
      lines = telegramLines(block.lines, block.lines.map((_, index) => isLiteral(at + index)))
    }
    // Dev's code blocks omit the opening and closing lines.
    at += block.lines.length + (isCode ? 2 : 0)
    const blockHtml = block.kind === 'code' ? renderCodeHtml(block) : lines.map(line => line.html).join('\n')
    const blockText = block.kind === 'code' ? renderPlain(block) : lines.map(line => line.text).join('\n')
    const candidate = html === '' ? blockHtml : `${html}\n${blockHtml}`
    if (points(candidate) <= limit) {
      html = candidate
      text = text === '' ? blockText : `${text}\n${blockText}`
      continue
    }
    flush()
    if (points(blockHtml) <= limit) {
      html = blockHtml
      text = blockText
      continue
    }
    chunks.push(...forceCut(block, limit, lines))
  }
  flush()
  return chunks
}
