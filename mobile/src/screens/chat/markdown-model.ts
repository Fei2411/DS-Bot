import type { Token, Tokens } from 'marked'

export interface ParagraphImage {
  kind: 'image'
  href: string
  alt: string
  linkHref?: string
}

export type ParagraphSegment =
  | { kind: 'inlines'; tokens: Token[] }
  | ParagraphImage

// Single line breaks inside a Markdown paragraph are soft wraps, not hard <br>s;
// React Native renders literal '\n' inside <Text> as a line break, so collapse
// single newlines (CRLF or LF) into a space while keeping explicit <br> tokens.
export function normalizeSoftBreaks(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

function visualLength(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    width += code > 0x2e7f ? 2 : 1
  }
  return width
}

// Compute aligned column widths across headers and all rows. Narrow tables expand
// to fill containerWidth cleanly; wide tables keep natural clamped column widths so
// the enclosing horizontal scroller pans cleanly without clipping cells.
export function computeTableWidths(
  headers: string[],
  rows: string[][],
  opts: { min?: number; max?: number; containerWidth?: number; charWidth?: number; padding?: number } = {},
): number[] {
  const cols = headers.length
  if (cols === 0) return []
  const min = opts.min ?? 88
  const max = opts.max ?? 260
  const charWidth = opts.charWidth ?? 8.5
  const padding = opts.padding ?? 22
  const widths = new Array<number>(cols).fill(min)

  for (let c = 0; c < cols; c++) {
    let longest = visualLength(headers[c] ?? '')
    for (const row of rows) {
      longest = Math.max(longest, visualLength(row[c] ?? ''))
    }
    const desired = Math.ceil(longest * charWidth + padding)
    widths[c] = Math.min(max, Math.max(min, desired))
  }

  const container = opts.containerWidth ?? 0
  if (container > 0) {
    const sum = widths.reduce((a, b) => a + b, 0)
    if (sum < container) {
      const extra = container - sum
      const perCol = Math.floor(extra / cols)
      let remainder = extra - perCol * cols
      for (let c = 0; c < cols; c++) {
        widths[c] += perCol + (remainder > 0 ? 1 : 0)
        if (remainder > 0) remainder -= 1
      }
    }
  }
  return widths
}

export function tableToTsv(headers: string[], rows: string[][]): string {
  const clean = (cell: string) => cell.replace(/[\t\r\n]+/g, ' ').trim()
  return [headers.map(clean).join('\t'), ...rows.map(row => row.map(clean).join('\t'))].join('\n')
}

export function listItemInfo(
  list: Pick<Tokens.List, 'ordered' | 'start'>,
  item: Pick<Tokens.ListItem, 'task' | 'checked' | 'tokens'>,
  index: number,
  depth = 0,
): { marker: string; isTask: boolean; checked: boolean; tokens: Token[] } {
  const rawTokens = Array.isArray(item.tokens) ? item.tokens.filter(t => t.type !== 'space') : []
  const isTask = item.task === true
  const checked = item.checked === true
  let tokens = rawTokens
  if (isTask && tokens.length > 0 && tokens[0]?.type === 'checkbox') {
    tokens = tokens.slice(1)
  } else if (isTask && tokens.length > 0 && tokens[0]?.type === 'text' && Array.isArray((tokens[0] as Tokens.Text).tokens)) {
    const inner = (tokens[0] as Tokens.Text).tokens!
    if (inner[0]?.type === 'checkbox') {
      tokens = [{ ...tokens[0], tokens: inner.slice(1) } as Token, ...tokens.slice(1)]
    }
  }

  if (isTask) {
    return { marker: checked ? '☑' : '☐', isTask: true, checked, tokens }
  }
  if (list.ordered) {
    const parsed = typeof list.start === 'number' ? list.start : parseInt(String(list.start ?? ''), 10)
    const start = Number.isFinite(parsed) && !Number.isNaN(parsed) ? parsed : 1
    return { marker: `${start + index}.`, isTask: false, checked: false, tokens }
  }
  const bullet = depth <= 0 ? '•' : depth === 1 ? '◦' : '▪'
  return { marker: bullet, isTask: false, checked: false, tokens }
}

const IMAGE_WRAPPERS = new Set(['strong', 'em', 'del', 'link'])

function childInlineTokens(token: Token): Token[] | undefined {
  if (!IMAGE_WRAPPERS.has(token.type)) return undefined
  const inner = (token as { tokens?: Token[] }).tokens
  return Array.isArray(inner) ? inner : undefined
}

function containsImageToken(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (token.type === 'image') return true
    const inner = childInlineTokens(token)
    if (inner !== undefined && containsImageToken(inner)) return true
  }
  return false
}

// Split a paragraph's inline tokens into pure inline text runs and standalone image
// blocks so an <Image>/<View> is never mounted inside a <Text> subtree on Android Fabric.
export function splitParagraphImages(tokens: Token[]): ParagraphSegment[] {
  const segments: ParagraphSegment[] = []
  let run: Token[] = []

  const flush = () => {
    if (run.length > 0) {
      segments.push({ kind: 'inlines', tokens: run })
      run = []
    }
  }

  const walk = (list: Token[], wrap?: (inner: Token[]) => Token, linkHref?: string) => {
    for (const token of list) {
      if (token.type === 'image') {
        const img = token as Tokens.Image
        flush()
        const segment: ParagraphSegment = {
          kind: 'image',
          href: String(img.href ?? ''),
          alt: String(img.text || img.title || 'image'),
        }
        if (linkHref !== undefined && linkHref !== '') segment.linkHref = linkHref
        segments.push(segment)
        continue
      }
      const inner = childInlineTokens(token)
      if (inner !== undefined && containsImageToken(inner)) {
        const nextLink = token.type === 'link' ? (linkHref ?? String((token as Tokens.Link).href ?? '')) : linkHref
        const nextWrap = (part: Token[]) => {
          const wrapped = { ...token, tokens: part } as Token
          return wrap ? wrap([wrapped]) : wrapped
        }
        walk(inner, nextWrap, nextLink)
        continue
      }
      run.push(wrap ? wrap([token]) : token)
    }
  }

  walk(tokens)
  flush()
  return segments
}
