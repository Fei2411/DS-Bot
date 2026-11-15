import type { Token, Tokens } from 'marked'

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


export const hasInlineImage = (tokens: Token[] = []): boolean => tokens.some(token => {
  if (token.type === 'image') return inlineImage((token as Tokens.Image).href, (token as Tokens.Image).text).kind === 'image'
  return 'tokens' in token && Array.isArray(token.tokens) && hasInlineImage(token.tokens)
})

type ImagePart = { kind: 'image'; src: string; alt: string; href?: string }
type TextPart = { kind: 'text'; tokens: Token[] }

export function imageFlow(tokens: Token[]): (ImagePart | TextPart)[] {
  const parts: (ImagePart | TextPart)[] = []
  const walk = (token: Token, wrappers: Token[] = [], href?: string) => {
    if (token.type === 'image') {
      const image = token as Tokens.Image
      const shown = inlineImage(image.href, image.text)
      if (shown.kind === 'image') { parts.push({ ...shown, href }); return }
    }
    if ('tokens' in token && Array.isArray(token.tokens) && hasInlineImage(token.tokens)) {
      const link = token.type === 'link' && /^(https?:|mailto:)/i.test((token as Tokens.Link).href) ? (token as Tokens.Link).href : href
      for (const child of token.tokens) walk(child, [...wrappers, token], link)
      return
    }
    const wrapped = wrappers.reduceRight((child, parent) => ({ ...parent, tokens: [child] }) as Token, token)
    const last = parts.at(-1)
    if (last?.kind === 'text') last.tokens.push(wrapped)
    else parts.push({ kind: 'text', tokens: [wrapped] })
  }
  for (const token of tokens) walk(token)
  return parts
}
