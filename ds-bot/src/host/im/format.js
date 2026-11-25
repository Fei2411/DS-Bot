// Outbound text for IM platforms. Bots write Markdown; each platform adapter turns it
// into what the platform renders (Telegram HTML) or plain text, and cuts it at the
// platform's per-message limit without breaking inside a code fence when it can help it.

const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Inline Markdown inside one line or block: `code`, **bold**, _italic_, ~~strike~~,
// [label](url). Code spans are pulled out first so markers inside them stay literal.
function inlineHtml(line) {
  const spans = []
  const kept = line.replace(/`([^`]+)`/g, (_all, code) => {
    spans.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00${spans.length - 1}\x00`
  })
  const html = escapeHtml(kept)
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => `<a href="${escapeHtml(url)}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\b_([^_]+)_\b/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return html.replace(/\u0000(\d+)\u0000/g, (_all, index) => spans[Number(index)])
}

function inlinePlain(line) {
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => (label === url ? label : `${label} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\b_([^_]+)_\b/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

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

const renderHtml = block => (block.kind === 'code'
  ? `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.lines.join('\n'))}</code></pre>`
  : block.lines.map(inlineHtml).join('\n'))

const renderPlain = block => (block.kind === 'code' ? block.lines.join('\n') : block.lines.map(inlinePlain).join('\n'))

export function toPlain(markdown) {
  return blocks(markdown).map(renderPlain).join('\n')
}

const points = text => Array.from(text).length

// Split a block that alone exceeds the limit: text at line boundaries (a line that
// is still too long is cut where it lands — Telegram answers it as plain text), a
// code fence into several fenced blocks.
function forceCut(block, limit) {
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
    for (const line of block.lines) {
      const lineHtml = inlineHtml(line)
      const candidate = html === '' ? lineHtml : `${html}\n${lineHtml}`
      if (points(candidate) <= limit) {
        html = candidate
        text = text === '' ? inlinePlain(line) : `${text}\n${inlinePlain(line)}`
        continue
      }
      flush()
      // A single line over the limit is cut on its rendered text.
      let rest = lineHtml
      let restPlain = inlinePlain(line)
      while (points(rest) > limit) {
        const part = Array.from(rest).slice(0, limit).join('')
        const plainPart = Array.from(restPlain).slice(0, limit).join('')
        chunks.push({ html: part, text: plainPart })
        rest = Array.from(rest).slice(limit).join('')
        restPlain = Array.from(restPlain).slice(limit).join('')
      }
      html = rest
      text = restPlain
    }
    flush()
    return chunks
  }
  const chunks = []
  const open = `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''}>`
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
export function chunkMarkdown(markdown, limit, { unit = 'code-point' } = {}) {
  const chunks = []
  // Trim before cutting, so the first chunk cannot open and the last cannot close on
  // a blank line. A message that is only whitespace has nothing to send: it returns
  // no chunk, the same as an empty string.
  let rest = withoutBlankEdges(String(markdown ?? ''))
  if (rest.trim() === '') return chunks
  // What is left has to fit the budget the caller asked for: code points, or UTF-16
  // units as well when the platform counts those.
  const fits = (text) => points(text) <= limit && (unit !== 'utf16' || text.length <= limit)
  while (rest !== '') {
    if (fits(rest)) { chunks.push(rest); break }
    // `limit` counts code points while `slice` and `lastIndexOf` count UTF-16 units, so
    // the cut index has to be converted: taken straight from the limit it lands one unit
    // early for every astral character before it, which splits an emoji in half. A
    // platform that counts units instead (Discord) gets a cut measured in them.
    let at = unit === 'utf16' ? unitsWithin(rest, limit) : codeUnitIndex(rest, limit)
    // The halfway mark of the same budget, in the same units: a separator early in the
    // budget is not worth preferring over a cut that uses it. A platform that counts units
    // already has its budget in them, so half of it is that number; converting half the
    // budget through `codeUnitIndex` instead measured half the *code points*, and astral
    // characters pushed the mark forward past a newline that sat exactly halfway in the
    // count the platform uses, so the cut went through a link the newline would have spared.
    const half = unit === 'utf16' ? Math.floor(limit / 2) : codeUnitIndex(rest, Math.floor(limit / 2))
    const newline = rest.lastIndexOf('\n', at)
    if (newline > half) at = newline
    else {
      const space = rest.lastIndexOf(' ', at)
      if (space > half) at = space
    }
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  return chunks
}

// The UTF-16 index of the `count`th code point of `text` (its length when it holds fewer).
function codeUnitIndex(text, count) {
  let at = 0
  for (let seen = 0; seen < count && at < text.length; seen += 1) {
    at += text.codePointAt(at) > 0xffff ? 2 : 1
  }
  return at
}

// The longest prefix of `text` that fits in `limit` UTF-16 units and ends on a whole
// code point, for a platform that counts units rather than characters.
function unitsWithin(text, limit) {
  let at = 0
  let used = 0
  while (at < text.length) {
    const width = text.codePointAt(at) > 0xffff ? 2 : 1
    if (used + width > limit) break
    used += width
    at += width
  }
  return at
}

export function chunkTelegram(markdown, limit = 4096) {
  const chunks = []
  let html = ''
  let text = ''
  const flush = () => {
    if (html === '' && text === '') return
    chunks.push({ html, text })
    html = ''
    text = ''
  }
  for (const block of blocks(markdown)) {
    const blockHtml = renderHtml(block)
    const blockText = renderPlain(block)
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
    chunks.push(...forceCut(block, limit))
  }
  flush()
  return chunks
}
