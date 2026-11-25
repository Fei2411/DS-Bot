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

function boldInlineHtml(line) {
  const html = inlineHtml(line).replace(/<\/?b>/g, '')
  const tags = []
  let rendered = ''
  let segment = ''
  let hasText = false
  let at = 0
  for (const match of html.matchAll(/<code>[\s\S]*?<\/code>|<a href="[^"]*">|<\/?[ais]>/g)) {
    const text = html.slice(at, match.index)
    const tag = match[0]
    segment += text
    hasText ||= text !== ''
    if (tag.startsWith('<code>') && tags.some(open => open.startsWith('<a '))) {
      segment += tag.slice('<code>'.length, -'</code>'.length)
      hasText = true
    } else if (tag.startsWith('<code>')) {
      if (hasText) rendered += '<b>' + segment + tags.slice().reverse().map(open => '</' + open[1] + '>').join('') + '</b>'
      rendered += tag
      segment = tags.join('')
      hasText = false
    } else {
      if (tag[1] === '/') tags.pop()
      else tags.push(tag)
      segment += tag
    }
    at = match.index + tag.length
  }
  const tail = html.slice(at)
  return hasText || tail !== '' ? rendered + '<b>' + segment + tail + '</b>' : rendered
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

const codeHtmlOpen = lang => lang ? `<pre><code class="language-${escapeHtml(lang)}">` : '<pre><code>'
const renderCodeHtml = block => `${codeHtmlOpen(block.lang)}${escapeHtml(block.lines.join('\n'))}</code></pre>`

const renderPlain = block => (block.kind === 'code' ? block.lines.join('\n') : block.lines.map(inlinePlain).join('\n'))

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)\s*$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
const TABLE_DELIMITER = /^:?-+:?$/
const FENCE_LIKE = /^\s*(?:(?:[-+*]|\d+[.)])\s+|>\s*)*(?:`{3,}|~{3,})/

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

const renderLine = line => ({ html: inlineHtml(line), text: inlinePlain(line) })

function telegramLines(lines, formatBefore, limit) {
  const rendered = []
  const tableLine = at => at < formatBefore ? lines[at] : ''
  const fits = ({ html, text }) => points(html) <= limit && points(text) <= limit
  const renderTableRow = (headers, row) => headers.map((header, index) => {
    const label = row === undefined ? header : header + ':'
    const value = row?.[index] ?? ''
    return {
      html: '• ' + boldInlineHtml(label) + (value ? ' ' + inlineHtml(value) : ''),
      text: '• ' + inlineTablePlain(label) + (value ? ' ' + inlineTablePlain(value) : ''),
    }
  })
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    if (at >= formatBefore) {
      rendered.push(renderLine(line))
      continue
    }
    const next = tableLine(at + 1)
    if (next.includes('-')) {
      const delimiters = tableCells(next)?.cells
      if (delimiters?.length > 0 && delimiters.every(cell => TABLE_DELIMITER.test(cell))) {
        const header = tableRow(line)
        if (header?.cells.length === delimiters.length) {
          const start = at
          const rows = []
          at += 1
          let row = tableRow(tableLine(at + 1), header)
          if (row === undefined) rows.push(renderTableRow(header.cells))
          while (row !== undefined) {
            at += 1
            rows.push(renderTableRow(header.cells, row.cells))
            row = tableRow(tableLine(at + 1), header)
          }
          const original = lines.slice(start, at + 1).map(renderLine)
          const converted = {
            html: rows.map(cells => cells.map(cell => cell.html).join('\n')).join('\n\n'),
            text: rows.map(cells => cells.map(cell => cell.text).join('\n')).join('\n\n'),
          }
          if (fits(converted) && original.every(fits)) rendered.push(converted)
          else for (const raw of original) rendered.push(raw)
          continue
        }
      }
    }
    const original = renderLine(line)
    const heading = ATX_HEADING.exec(line)
    if (heading !== null && !/^#+$/.test(heading[1]) && fits(original)) {
      const content = heading[1].replace(/[ \t]+#+$/, '')
      const converted = { html: boldInlineHtml(content), text: inlinePlain(content) }
      if (fits(converted)) {
        rendered.push(converted)
        continue
      }
    }
    rendered.push(original)
  }
  return rendered
}

export function toPlain(markdown) {
  return blocks(markdown).map(renderPlain).join('\n')
}

const points = text => Array.from(text).length

// Split oversized blocks at line boundaries and code fences into several fenced blocks.
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
      const htmlChars = Array.from(lineHtml)
      const textChars = Array.from(lineText)
      const width = Math.max(1, Math.trunc(limit))
      let at = 0
      while (htmlChars.length - at > limit) {
        chunks.push({
          html: htmlChars.slice(at, at + width).join(''),
          text: textChars.slice(at, at + width).join(''),
        })
        at += width
      }
      html = htmlChars.slice(at).join('')
      text = textChars.slice(at).join('')
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
  let formatProse = true
  let html = ''
  let text = ''
  const flush = () => {
    if (html === '' && text === '') return
    chunks.push({ html, text })
    html = ''
    text = ''
  }
  for (const block of blocks(markdown)) {
    let lines = []
    if (block.kind === 'code') {
      // A legacy opener can be an inline span or a wider fence, not an ordinary code block.
      if (block.lang.includes('`')) formatProse = false
    } else {
      const fence = formatProse ? block.lines.findIndex(line => FENCE_LIKE.test(line)) : 0
      formatProse = fence === -1
      lines = telegramLines(block.lines, formatProse ? block.lines.length : fence, limit)
    }
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
