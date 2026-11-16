// A soft break (a newline inside one paragraph) is a space, as HTML renders it;
// a hard break is its own `br` token. RN Text would otherwise draw a line break.
export function softBreakText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ')
}

// Bot text is untrusted: only web images are fetched and opened.
export function isRemoteImageUrl(href: string | undefined): href is string {
  return href !== undefined && /^https?:\/\//i.test(href)
}

const MARKDOWN_LINK = /\[([^\]\r\n]{1,200})\]\(\s*<?([^)\s>]{1,800})>?\s*\)/g
const FILE_EXTENSION = /\.[a-z0-9]{1,8}$/i
const LINKS_MAX = 8

// Web links whose last path segment is a file name: the phone downloads those
// itself, so they show as file cards even when the computer is an older build.
export function webFileLinks(text: string): { name: string; url: string }[] {
  const found: { name: string; url: string }[] = []
  const seen = new Set<string>()
  // A link shown as code is an example, not a file the reply offers.
  const plain = String(text ?? '').replace(/```[\s\S]*?```/g, ' ')
  for (const match of plain.matchAll(MARKDOWN_LINK)) {
    const href = match[2].trim()
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue
    const clean = href.split(/[?#]/)[0]
    if (!FILE_EXTENSION.test(clean)) continue
    seen.add(href)
    const label = match[1].trim()
    const base = clean.split('/').pop() ?? ''
    let name = base
    try {
      name = decodeURIComponent(base) || base
    } catch { /* keep the encoded name */ }
    found.push({ name: FILE_EXTENSION.test(label) ? label : name || href, url: href })
    if (found.length >= LINKS_MAX) break
  }
  return found
}
