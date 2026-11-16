// Files a Bot's reply points at: a path in inline or fenced code, in a markdown
// link, and a web link whose last segment names a file. Whether the path is a
// real file, and where it lives, is the caller's decision (mobile.js resolves it
// against the folders the team may use).
const EXTENSION = /\.[a-z0-9]{1,8}$/i
const CODE_SPAN = /`([^`\r\n]{1,400})`/g
const FENCED_CODE = /```[^\n]*\n([\s\S]{1,4000}?)```/g
const MARKDOWN_LINK = /\[([^\]\r\n]{1,200})\]\(\s*<?([^)\s>]{1,800})>?\s*\)/g
const WEB = /^https?:\/\//i
const SKIP = /^(?:mailto:|data:|javascript:|#)/i
const LINK_BAD = /[\s*?"<>|]/
const CODE_BAD = /[\r\n<>|`"]/
const CANDIDATES_MAX = 8

// A reply names a real file in code, where spaces are part of the name (an
// Arabic PDF, a folder such as "DS Bot"); a link's target has no raw spaces.
const codePathLike = value => {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 600 && !CODE_BAD.test(trimmed) && EXTENSION.test(trimmed)
}
const linkPathLike = value => value.length > 0 && value.length <= 600 && !LINK_BAD.test(value) && EXTENSION.test(value)

function nameOf(value, label) {
  const shown = String(label ?? '').trim()
  if (shown !== '' && !LINK_BAD.test(shown) && EXTENSION.test(shown)) return shown
  const base = value.split(/[?#]/)[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  try {
    return (decodeURIComponent(base) || value).trim()
  } catch {
    return (base || value).trim()
  }
}

export function fileCandidates(text) {
  const value = String(text ?? '')
  const found = []
  const seen = new Set()
  const add = entry => {
    const key = `${entry.kind}:${entry.value}`
    if (seen.has(key) || found.length >= CANDIDATES_MAX) return
    seen.add(key)
    found.push(entry)
  }
  for (const match of value.matchAll(CODE_SPAN)) {
    const candidate = match[1].trim().replace(/^sandbox:/i, '')
    if (WEB.test(candidate) || SKIP.test(candidate) || !codePathLike(candidate)) continue
    add({ kind: 'path', value: candidate, name: nameOf(candidate) })
  }
  // A path a Bot prints as its own line of a code block, as the copy button offers it.
  for (const block of value.matchAll(FENCED_CODE)) {
    for (const line of block[1].split('\n')) {
      const candidate = line.trim().replace(/^sandbox:/i, '')
      if (WEB.test(candidate) || SKIP.test(candidate) || !codePathLike(candidate)) continue
      add({ kind: 'path', value: candidate, name: nameOf(candidate) })
    }
  }
  for (const match of value.matchAll(MARKDOWN_LINK)) {
    const label = match[1].trim()
    const href = match[2].trim()
    if (WEB.test(href)) {
      if (linkPathLike(nameOf(href, ''))) add({ kind: 'url', value: href, name: nameOf(href, label) })
      continue
    }
    if (SKIP.test(href)) continue
    const candidate = href.replace(/^sandbox:/i, '')
    if (!linkPathLike(candidate)) continue
    add({ kind: 'path', value: candidate, name: nameOf(candidate, label) })
  }
  return found
}
