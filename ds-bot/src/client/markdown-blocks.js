// Splits Markdown source into closed blocks for incremental streaming renders.
//
// While a reply streams, the closed blocks are already final: nothing that arrives later
// can change what they mean, because the split only happens at a blank-line boundary the
// CommonMark block structure itself places there, and any syntax whose meaning is decided
// document-wide (link reference definitions, footnotes, raw HTML blocks, container
// directives, display math, Setext underlines, duplicate heading slugs) stops the split
// entirely instead of risking one wrong block. The renderer then parses each closed block
// once and only re-parses the live trailing piece as it grows, instead of re-parsing the
// whole message per chunk.
//
// `splitMarkdownBlocks(text)` returns the pieces, in order, joined exactly back into the
// input (`blocks.join('') === text`), or `null` when the text holds anything that makes
// splitting unsafe; `null` means: render the whole document in one parse, as before.
//
// Blank lines never open a piece: they close the block before them, so a piece always
// ends on a blank line and the trailing piece starts with real content. A split is never
// made inside a fenced code block, before an indented continuation line (indented code
// and loose list items can continue across blank lines that way), or before a list
// marker that could continue a list on the other side of the blank lines (items of one
// list separated by blank lines still form one loose list, so a marker line or an
// indented line just before them keeps the boundary closed).
//
// One known approximation, visual only: a list item whose last paragraph is continued
// lazy (an unindented text line right after the item line) followed by blank lines and
// the next item's marker splits as two tight lists where the whole document reads one
// loose list, so the items show paragraph margins until the settled full parse replaces
// the pieces. Anything worse than spacing this never does, and lazy continuations of
// that shape are rare in assistant output next to the indented form, which never splits.

const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FOOTNOTE_REFERENCE = /\[\^[^\]\n]+\]/
// Link reference definitions reach across the whole document from wherever they sit —
// inside blockquotes (nested included) and list items — so the check strips the
// container prefixes a definition can hide behind before scanning the label itself.
// The whitespace a container can carry, ASCII space and tab both (`-\t[x]: /url` is a
// definition inside a list item exactly as `- [x]: /url` is).
const CONTAINER_PREFIX = /^(?:>+[ \t]*|\d{1,9}[.)][ \t]+|[-+*][ \t]+|[ \t]*)/

// Container prefixes a definition can hide behind, stripped as far as they nest
// (`> > [x]: url` is a definition inside a quote inside a quote).
const stripContainerPrefixes = (line) => {
  let rest = line
  while (true) {
    const next = rest.replace(CONTAINER_PREFIX, '')
    if (next === rest) return rest
    rest = next
  }
}

// Whether the line can open a link reference (or footnote) definition once its container
// prefixes are off. A definition is `[` label `]` immediately followed by `:`, so the
// scan walks the label escape-aware:
//   - no unescaped `]` on the line at all could be a label the next line finishes
//     (`[long` / `label]: url` is one definition), so it bails;
//   - `]` directly followed by `:` is the definition itself, escaped brackets inside the
//     label included, so it bails;
//   - anything else (`[x] = compute()`, `- [ ] todo`, `[text](url)`) never opens a
//     definition, and the split stands. False positives only cost the split; a missed
//     definition would corrupt the render.
const opensLinkDefinition = (line) => {
  const rest = stripContainerPrefixes(line)
  if (!rest.startsWith('[')) return false
  for (let index = 1; index < rest.length; index += 1) {
    const char = rest[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === ']') return rest[index + 1] === ':'
  }
  return true
}
const RAW_HTML_BLOCK = /^ {0,3}<[A-Za-z/!?]/
const CONTAINER_DIRECTIVE = /^ {0,3}:::/
const DISPLAY_MATH = /^ {0,3}\$\$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const SETEXT_DASHES = /^ {0,3}-+[ \t]*$/
const SETEXT_EQUALS = /^ {0,3}=+[ \t]*$/
const BLANK = /^[ \t]*$/

// GitHub-style anchor slugs, close enough for a conservative duplicate check: a false
// positive only costs the split, a missed duplicate would split a document whose heading
// ids depend on document order.
const slugOf = (text) => {
  let inner = text.replace(/[ \t]+#+[ \t]*$/, '').trim().toLowerCase()
  inner = inner.replace(/[^\p{L}\p{N}_ -]/gu, '')
  return inner.replace(/ /g, '-')
}

const fenceClose = (line, fence) => {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
  if (match === null) return false
  return match[1][0] === fence.char && match[1].length >= fence.length
}

/**
 * Split Markdown source at safe closed-block boundaries.
 * @param {string} text
 * @returns {string[] | null} the pieces, or null when the document must be parsed whole
 */
export function splitMarkdownBlocks(text) {
  if (typeof text !== 'string' || text === '') return null
  // CRLF pairs are block-structure characters in Markdown; normalizing them would break
  // the exact-join contract, and re-parsing whole is cheap enough for such input.
  if (text.includes('\r') || text.includes('﻿')) return null

  const lines = text.split('\n')
  // Character offset at which each line starts; the end of line `index` (its newline
  // included) is the start of the next one.
  const starts = [0]
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1)
  const ends = []
  let fence = null
  let previousBlank = true
  let previousLineMarker = false
  let previousLineIndented = false
  // The guards look at every line, the last one included: while a reply streams the
  // steady state has no trailing newline, and a definition that lands on the final line
  // reaches backwards across the whole document exactly as any other.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence !== null) {
      if (fenceClose(line, fence)) {
        fence = null
        // Fence contents never decide a boundary. The closing fence line itself is plain
        // non-blank content for what follows it: not blank, not a marker, not indented
        // in the list-continuation sense.
        previousBlank = false
        previousLineMarker = false
        previousLineIndented = false
      }
      continue
    }
    const blank = BLANK.test(line)
    if (!blank) {
      const opening = FENCE_OPEN.exec(line)
      if (opening !== null) {
        // An info string with the fence's own character does not open a backtick fence,
        // but treating it as one only ever delays a split; it never splits inside a fence
        // that CommonMark would see.
        fence = { char: opening[1][0], length: opening[1].length }
      }
      // Anything whose reach crosses block boundaries stops the split outright.
      if (opensLinkDefinition(line)) return null
      if (FOOTNOTE_REFERENCE.test(line)) return null
      if (RAW_HTML_BLOCK.test(line)) return null
      if (CONTAINER_DIRECTIVE.test(line)) return null
      if (DISPLAY_MATH.test(line)) return null
      if (!previousBlank && (SETEXT_DASHES.test(line) || SETEXT_EQUALS.test(line))) return null
      previousBlank = false
      previousLineMarker = LIST_MARKER.test(line)
      previousLineIndented = line.startsWith(' ') || line.startsWith('\t')
      continue
    }
    // A run of blank lines: only the last one can close a block, and only when the next
    // line is real content that cannot continue what came before. The final line never
    // has a successor, so no boundary opens after it.
    if (index + 1 < lines.length && !BLANK.test(lines[index + 1])) {
      const next = lines[index + 1]
      const indented = next.startsWith(' ') || next.startsWith('\t')
      // A list marker on the far side only threatens the split when the near side could
      // belong to the same list: a marker line of its own or an indented line just before
      // the blank run. After plain text the marker plainly starts a new list.
      const continuesList = LIST_MARKER.test(next) && (previousLineMarker || previousLineIndented)
      if (!indented && !continuesList) ends.push(starts[index + 1])
    }
    previousBlank = true
  }
  if (ends.length === 0) return [text]
  // Duplicate ATX heading slugs are resolved document-wide (`# A` then `# A` again
  // becomes `a` and `a-1`); with duplicates present no block may be parsed alone.
  const slugs = new Set()
  let insideFence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (insideFence !== null) {
      if (fenceClose(line, insideFence)) insideFence = null
      continue
    }
    const opening = FENCE_OPEN.exec(line)
    if (opening !== null) {
      insideFence = { char: opening[1][0], length: opening[1].length }
      continue
    }
    const heading = ATX_HEADING.exec(line)
    if (heading === null) continue
    const slug = slugOf(line.slice(heading[0].length))
    if (slug !== '') {
      if (slugs.has(slug)) return null
      slugs.add(slug)
    }
  }
  const blocks = []
  let from = 0
  for (const end of ends) {
    blocks.push(text.slice(from, end))
    from = end
  }
  const rest = text.slice(from)
  if (rest !== '') blocks.push(rest)
  return blocks.length > 0 ? blocks : [text]
}
