// The two Markdown rules the phone used to get from the browser for free.
//
// CommonMark renders a single newline inside a paragraph as a soft break; HTML
// collapses it to a space, while React Native <Text> would draw a hard line break.
// A hard break (two trailing spaces or `\\`) is its own `br` token and stays a break.
export function softBreakText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ')
}

export type InlineImage =
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'alt'; text: string }

// Only an absolute https image can load on the phone. A workspace-relative path has
// no file service behind it on the phone, and http would be blocked as cleartext, so
// both keep the readable alt text they had before.
export function inlineImage(href: unknown, alt: unknown): InlineImage {
  const src = typeof href === 'string' ? href.trim() : ''
  const text = typeof alt === 'string' && alt.trim() !== '' ? alt.trim() : 'image'
  if (/^https:\/\/[^\s]+$/i.test(src)) return { kind: 'image', src, alt: text }
  return { kind: 'alt', text }
}
