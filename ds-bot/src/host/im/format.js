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

export function toTelegramHtml(markdown) {
  return blocks(markdown).map(renderHtml).join('\n')
}

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
  const room = limit - points(open) - points(close)
  while (body !== '') {
    let at = Math.min(points(body), Math.max(1, room))
    const chars = Array.from(body)
    const newline = body.lastIndexOf('\n', at)
    if (newline > room / 2) at = newline
    const part = chars.slice(0, at).join('')
    chunks.push({ html: `${open}${escapeHtml(part)}${close}`, text: part })
    body = chars.slice(at).join('').replace(/^\n/, '')
  }
  return chunks
}

// Chunks of one Markdown message, each under `limit` rendered characters. Block
// boundaries are kept where possible; a fence is only split when it alone is too big.
// Plain markdown chunks at a byte-pair limit: paragraphs and lines first, a
// hard cut at the limit for one over-long run. For platforms that take
// markdown as-is (Discord, QQ, WeCom, DingTalk, Slack has its own converter).
export function chunkMarkdown(markdown, limit) {
  const chunks = []
  let rest = String(markdown ?? '')
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
