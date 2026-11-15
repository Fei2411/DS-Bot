// Markdown for the QQ open platform. QQ renders a markdown message with its own
// renderer, which supports headings, emphasis, links, images, lists, quotes and
// rules but no GFM tables, and it fetches images only from a public URL or a
// `qqbot-media://` reference. That which it cannot render it rejects or draws
// wrong, so the text is converted to the subset before it is sent.

const LOCAL_IMAGE = /!\[([^\]]*)\]\((?!https?:\/\/|qqbot-media:\/\/)([^)\s]+)[^)]*\)/g
// A real HTML tag: the name is followed by whitespace, `/` or `>`. An autolink
// such as <https://example.com> is not a tag — its name is followed by `:` —
// and must survive, or the address disappears from the reply.
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g

const FENCE = '\u0000'
const CODE = '\u0001'

// Fenced code is code, not markdown: a table or an image inside a fence must
// reach the platform exactly as written. The block is swapped for a placeholder
// and put back after the block-level conversion.
function protectFences(lines) {
  const out = []
  const fences = []
  for (let at = 0; at < lines.length;) {
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[at])
    if (open === null || (open[1][0] === '`' && open[2].includes('`'))) {
      out.push(lines[at])
      at += 1
      continue
    }
    const delimiter = open[1]
    let end = at + 1
    while (end < lines.length) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[end])
      if (close !== null && close[1][0] === delimiter[0] && close[1].length >= delimiter.length) break
      end += 1
    }
    fences.push(lines.slice(at, end < lines.length ? end + 1 : lines.length).join('\n'))
    out.push(`${FENCE}${fences.length - 1}${FENCE}`)
    at = end < lines.length ? end + 1 : lines.length
  }
  return { lines: out, fences }
}

// Inline code is code too: `<div>` or ![x](/tmp/a.png) inside backticks is an
// example, and rewriting it would hand the reader different code. A span is
// delimited by a run of backticks and closed by the same length of run.
function protectCodeSpans(line, spans) {
  if (!line.includes('`')) return line
  return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (all) => {
    // The delimiters stay with the span: QQ renders the code span itself, and
    // a double-backtick span must not lose its extra backticks.
    spans.push(all)
    return `${CODE}${spans.length - 1}${CODE}`
  })
}

function restore(text, token, values) {
  return text.replace(new RegExp(`${token}(\\d+)${token}`, 'g'), (_all, index) => values[Number(index)] ?? '')
}

// GFM lets a cell hold a literal pipe when it is escaped. Splitting on every
// pipe would move the rest of the row into the next column.
function tableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) return null
  const cells = []
  let cell = ''
  for (let at = 0; at < trimmed.length; at += 1) {
    const character = trimmed[at]
    if (character === '\\' && trimmed[at + 1] === '|') {
      cell += '|'
      at += 1
      continue
    }
    if (character === '|') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell)
  if (cells[0].trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells.map(entry => entry.trim())
}

function isSeparatorRow(line) {
  const cells = tableCells(line)
  return cells !== null && cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell))
}

// QQ has no table: one list item per row, each cell named by its column, keeps
// the pairing readable without the pipes.
function tableToList(header, rows) {
  return rows.map((row) => {
    const parts = row
      .map((cell, index) => (header[index] === undefined || header[index] === '' ? cell : `${header[index]}：${cell}`))
      .filter(part => part !== '')
    return `- ${parts.join('；')}`
  }).join('\n')
}

export function toQqMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : ''
  if (source === '') return ''
  const raw = source.replace(/\r\n?/g, '\n').split('\n')
  const { lines: fenced, fences } = protectFences(raw)
  const spans = []
  const lines = fenced.map(line => (line.startsWith(FENCE) ? line : protectCodeSpans(line, spans)))
  const out = []
  for (let at = 0; at < lines.length;) {
    if (isSeparatorRow(lines[at])) {
      at += 1
      continue
    }
    const header = tableCells(lines[at])
    if (header !== null && isSeparatorRow(lines[at + 1] ?? '')) {
      const rows = []
      let end = at + 2
      while (end < lines.length) {
        const cells = tableCells(lines[end])
        if (cells === null || cells.length === 0) break
        rows.push(cells)
        end += 1
      }
      out.push(tableToList(header, rows))
      at = end
      continue
    }
    out.push(lines[at])
    at += 1
  }
  const converted = out.join('\n')
    .replace(LOCAL_IMAGE, (_all, alt) => (alt.trim() === '' ? '［图片］' : `［图片：${alt.trim()}］`))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(HTML_TAG, '')
  return restore(restore(converted, CODE, spans), FENCE, fences)
}

export default toQqMarkdown
