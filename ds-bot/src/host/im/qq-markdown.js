// Markdown for the QQ open platform. QQ renders a markdown message with its own
// renderer, which supports headings, emphasis, links, images, lists, quotes and
// rules but no GFM tables, and it fetches images only from a public URL or a
// `qqbot-media://` reference. That which it cannot render it rejects or draws
// wrong, so the text is converted to the subset before it is sent.

const LOCAL_IMAGE = /!\[([^\]]*)\]\((?!https?:\/\/|qqbot-media:\/\/)([^)\s]+)[^)]*\)/g

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
    out.push(`\u0000${fences.length - 1}\u0000`)
    at = end < lines.length ? end + 1 : lines.length
  }
  return { lines: out, fences }
}

function tableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) return null
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
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
  const { lines, fences } = protectFences(raw)
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
  return out.join('\n')
    .replace(LOCAL_IMAGE, (_all, alt) => (alt.trim() === '' ? '［图片］' : `［图片：${alt.trim()}］`))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_all, index) => fences[Number(index)] ?? '')
}

export default toQqMarkdown
