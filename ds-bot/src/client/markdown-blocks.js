// Splits Markdown source into closed blocks for incremental streaming renders.
//
// While a reply streams, the closed blocks are already final: nothing that arrives later
// can change what they mean, because the split only happens at a blank-line boundary the
// CommonMark block structure itself places there, and any syntax whose meaning is decided
// document-wide (link reference definitions, footnotes, raw HTML blocks, container
// directives, Setext underlines, duplicate heading slugs) stops the split
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
// marker while a list is open (items of one list separated by blank lines — including
// items with unindented lazy continuation lines — still form one loose list).

const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/
const BARE_ORDERED_PREFIX = /^ {0,3}\d{1,9}$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const INDENTED_FENCE_CLOSE = /^ {4,}(`+|~+)[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
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
  if (line === '') return ''
  const first = line.charCodeAt(0)
  // Fast path: ordinary prose/heading/code lines cannot start with a container prefix.
  if (
    first !== 32 /* ' ' */
    && first !== 9 /* '\t' */
    && first !== 62 /* '>' */
    && first !== 45 /* '-' */
    && first !== 43 /* '+' */
    && first !== 42 /* '*' */
    && (first < 48 || first > 57) /* '0'-'9' */
  ) {
    return line
  }
  let rest = line
  while (true) {
    const next = rest.replace(CONTAINER_PREFIX, '')
    if (next === rest) return rest
    rest = next
  }
}

// Whether a line (already stripped of container prefixes) can open a link reference
// (or footnote) definition. A definition is `[` label `]` immediately followed by `:`,
// so the scan walks the label escape-aware:
//   - no unescaped `]` on the line at all (including a trailing `\` before EOL) could
//     be a label the next line finishes (`[long` / `label]: url` is one definition), so
//     it conservatively bails;
//   - `]` directly followed by `:` is the definition itself, escaped brackets inside the
//     label included, so it bails;
//   - anything else (`[x] = compute()`, `- [ ] todo`, `[text](url)`) never opens a
//     definition, and the split stands. False positives only cost the split; a missed
//     definition would corrupt the render.
const opensLinkDefinitionStripped = (rest) => {
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
const MATH_FENCE_OPEN = /^ {0,3}(\${2,})(.*)$/
const INDENTED_MATH_CLOSE = /^ {4,}(\${2,})[ \t]*$/
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

const leadingSpaces = (line) => {
  let count = 0
  while (count < line.length && line[count] === ' ') count += 1
  return count
}

const fenceOpen = (line) => {
  const match = FENCE_OPEN.exec(line)
  if (match === null) return null
  const marker = match[1]
  // CommonMark §4.5 / micromark code-fenced: a backtick fence's info string cannot
  // contain any backtick, so that line stays a paragraph (tilde fences have no limit).
  if (marker[0] === '`' && line.includes('`', match[0].length)) return null
  return { char: marker[0], length: marker.length, indent: leadingSpaces(line) }
}

const fenceClose = (line, fence) => {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
  if (match === null) return false
  return match[1][0] === fence.char && match[1].length >= fence.length
}

// Returns true if `rest` contains an unescaped closing dollar run of at least `markerLen`
// after non-empty math content (e.g. `x^2$$。` or `x^2$$ trailing text`).
function hasUnescapedClosingDollars(rest, markerLen) {
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '$') {
      let run = 1
      while (i + run < rest.length && rest[i + run] === '$') run += 1
      if (run >= markerLen && i > 0) return true
      i += run
      continue
    }
    i += 1
  }
  return false
}

// Display math `$$` fence opener:
// - `$$` followed only by whitespace opens a multi-line flow math block (spans blank lines).
// - `$$...$$` on a single line (including trailing punctuation/prose like `$$x^2$$。`) is
//   self-contained inline/paragraph math and never opens a multi-line flow block.
// - `$$text` without a closing `$` run on the same line (e.g. a streaming inline display
//   math line) is tracked as `inlineCandidate` so it stays unsplit through EOF unless a
//   blank line appears inside it, in which case the splitter bails conservatively.
const mathFenceOpen = (line) => {
  const match = MATH_FENCE_OPEN.exec(line)
  if (match === null) return null
  const marker = match[1]
  const rest = match[2]
  if (BLANK.test(rest)) {
    return { length: marker.length, indent: leadingSpaces(line), inlineCandidate: false }
  }
  if (hasUnescapedClosingDollars(rest, marker.length)) {
    return null
  }
  return { length: marker.length, indent: leadingSpaces(line), inlineCandidate: true }
}

const mathFenceClose = (line, mathFence) => {
  const match = /^ {0,3}(\${2,})[ \t]*$/.exec(line)
  if (match === null) return false
  return match[1].length >= mathFence.length
}

// Tracks unescaped `\[` ... `\]` LaTeX display math balance on a line while carrying
// multi-line inline backtick code-span state across lines within a paragraph.
function scanLatexDisplayLine(line, currentlyOpen, initialCodeTicks = 0) {
  let open = currentlyOpen
  let codeTicks = initialCodeTicks
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (!open && ch === '`') {
      let ticks = 0
      while (i + ticks < line.length && line[i + ticks] === '`') ticks += 1
      if (codeTicks === 0) codeTicks = ticks
      else if (codeTicks === ticks) codeTicks = 0
      i += ticks
      continue
    }
    if (codeTicks > 0) {
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1]
      if (!open && next === '[') open = true
      else if (open && next === ']') open = false
      i += 2
      continue
    }
    i += 1
  }
  return { open, codeTicks }
}

// True when `rest` (already container-stripped) contains an explicit `]:` link definition
// delimiter (as opposed to an unclosed `[` at EOL that might simply be multi-line math).
function hasExplicitLinkDefColon(rest) {
  if (!rest.startsWith('[')) return false
  for (let i = 1; i < rest.length; i += 1) {
    const ch = rest[i]
    if (ch === '\\') { i += 1; continue }
    if (ch === ']') return rest[i + 1] === ':'
  }
  return false
}

/**
 * Split Markdown source at safe closed-block boundaries.
 * @param {string} text
 * @param {{ allowDuplicateHeadings?: boolean }} [options]
 * @returns {string[] | null} the pieces, or null when the document must be parsed whole
 */
export function splitMarkdownBlocks(text, options = {}) {
  if (typeof text !== 'string' || text === '') return null
  // CRLF pairs are block-structure characters in Markdown; normalizing them would break
  // the exact-join contract, and re-parsing whole is cheap enough for such input.
  if (text.includes('\r') || text.includes('﻿')) return null

  const checkDuplicateHeadings = options?.allowDuplicateHeadings !== true
  const lines = text.split('\n')
  // Character offset at which each line starts; the end of line `index` (its newline
  // included) is the start of the next one.
  const starts = [0]
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1)
  const ends = []
  const slugs = checkDuplicateHeadings ? new Set() : null
  let fence = null
  let mathFence = null
  let latexMathOpen = false
  let sawUnsafeInLatex = false
  let inlineCodeTicks = 0
  let previousBlank = true
  let inList = false
  let previousLineIndented = false
  // The guards look at every line, the last one included: while a reply streams the
  // steady state has no trailing newline, and a definition that lands on the final line
  // reaches backwards across the whole document exactly as any other.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence !== null) {
      const blankInside = BLANK.test(line)
      // An indented fence (1–3 spaces) can sit inside a list item, where a less-indented
      // non-blank line closes the list container and implicitly ends the fence without a
      // closing marker. A 4+ space closing-fence candidate can likewise close a list-item
      // fence (CommonMark §4.5 + §5.2 allows 0–3 spaces beyond the list content column).
      // Without container-stack tracking, bail rather than invert state or skip later guards.
      if (!blankInside && fence.indent > 0 && leadingSpaces(line) < fence.indent) return null
      if (fence.indent > 0) {
        const deepClose = INDENTED_FENCE_CLOSE.exec(line)
        if (deepClose !== null && deepClose[1][0] === fence.char && deepClose[1].length >= fence.length) return null
      }
      if (fenceClose(line, fence)) {
        const wasIndented = fence.indent > 0
        fence = null
        inlineCodeTicks = 0
        // A top-level fence (indent 0) always ends any open list, whereas an indented
        // fence may belong to a list item whose next marker (`1. Step two`) continues the
        // same loose list. Preserve list / indentation state across an indented fence close.
        previousBlank = false
        if (!wasIndented) inList = false
        previousLineIndented = wasIndented
      }
      continue
    }
    if (mathFence !== null) {
      const blankInside = BLANK.test(line)
      if (mathFence.inlineCandidate && blankInside) return null
      if (!blankInside && mathFence.indent > 0 && leadingSpaces(line) < mathFence.indent) return null
      if (mathFence.indent > 0) {
        const deepClose = INDENTED_MATH_CLOSE.exec(line)
        if (deepClose !== null && deepClose[1].length >= mathFence.length) return null
      }
      if (mathFenceClose(line, mathFence)) {
        const wasIndented = mathFence.indent > 0
        mathFence = null
        inlineCodeTicks = 0
        previousBlank = false
        if (!wasIndented) inList = false
        previousLineIndented = wasIndented
      }
      continue
    }
    if (latexMathOpen) {
      const blankInside = BLANK.test(line)
      if (!blankInside) {
        const stripped = stripContainerPrefixes(line)
        // A code fence inside an unclosed `\[` risks state inversion if `\]` appears inside
        // the fence; bail immediately to whole-document parse.
        if (fenceOpen(line) !== null || (stripped !== line && fenceOpen(stripped) !== null)) return null
        // Explicit document-wide definitions / HTML / directives never belong inside display
        // math and would corrupt earlier frozen blocks if `\[` was literal or closed inside
        // inline code later.
        if (
          hasExplicitLinkDefColon(stripped)
          || (line.includes('[^') && FOOTNOTE_REFERENCE.test(line))
          || (line.includes('<') && RAW_HTML_BLOCK.test(line))
          || (line.includes(':::') && CONTAINER_DIRECTIVE.test(line))
        ) {
          return null
        }
        // Ambiguous guards (e.g. unclosed `[` at EOL, Setext underlines, duplicate headings)
        // are recorded and force whole-document fallback if `\[` stays unclosed at EOF.
        if (
          opensLinkDefinitionStripped(stripped)
          || (!previousBlank && (SETEXT_EQUALS.test(line) || SETEXT_DASHES.test(line)))
        ) {
          sawUnsafeInLatex = true
        } else if (slugs !== null) {
          const heading = ATX_HEADING.exec(line)
          if (heading !== null) {
            const slug = slugOf(line.slice(heading[0].length))
            if (slug !== '' && slugs.has(slug)) sawUnsafeInLatex = true
          }
        }
      }
      const scanned = scanLatexDisplayLine(line, true, 0)
      if (!scanned.open) {
        latexMathOpen = false
        sawUnsafeInLatex = false
        inlineCodeTicks = scanned.codeTicks
        previousBlank = false
        inList = false
        previousLineIndented = false
      } else {
        previousBlank = blankInside
      }
      continue
    }
    const blank = BLANK.test(line)
    if (!blank) {
      const stripped = stripContainerPrefixes(line)
      const opening = fenceOpen(line)
      if (opening !== null) {
        fence = opening
        inlineCodeTicks = 0
        if (opening.indent === 0) inList = false
      } else {
        const mathOpening = mathFenceOpen(line)
        if (mathOpening !== null) {
          mathFence = mathOpening
          inlineCodeTicks = 0
          if (mathOpening.indent === 0) inList = false
        } else {
          // A fence or display math nested behind a container prefix (`- ```js`, `> $$`)
          // cannot be tracked safely without container state. Fall back to whole-doc parse.
          if (stripped !== line && (fenceOpen(stripped) !== null || MATH_FENCE_OPEN.test(stripped))) return null
          const needsLatexScan = inlineCodeTicks > 0 || line.includes('`') || line.includes('\\[')
          if (needsLatexScan) {
            const scanned = scanLatexDisplayLine(line, false, inlineCodeTicks)
            inlineCodeTicks = scanned.codeTicks
            if (scanned.open) {
              if (stripped !== line) return null
              latexMathOpen = true
              sawUnsafeInLatex = false
              inList = false
              previousBlank = false
              previousLineIndented = false
              continue
            }
          }
          // Duplicate ATX heading slugs are resolved document-wide (`# A` then `# A` again
          // becomes `a` and `a-1`); checking them in the same pass keeps fence state identical.
          if (slugs !== null) {
            const heading = ATX_HEADING.exec(line)
            if (heading !== null) {
              const slug = slugOf(line.slice(heading[0].length))
              if (slug !== '') {
                if (slugs.has(slug)) return null
                slugs.add(slug)
              }
            }
          }
        }
      }
      // Anything whose reach crosses block boundaries stops the split outright.
      if (opensLinkDefinitionStripped(stripped)) return null
      if (line.includes('[^') && FOOTNOTE_REFERENCE.test(line)) return null
      if (line.includes('<') && RAW_HTML_BLOCK.test(line)) return null
      if (line.includes(':::') && CONTAINER_DIRECTIVE.test(line)) return null
      const isListMarker = LIST_MARKER.test(line)
      const isUnindentedListDash = leadingSpaces(line) === 0 && inList && isListMarker
      if (!previousBlank && (SETEXT_EQUALS.test(line) || (SETEXT_DASHES.test(line) && !isUnindentedListDash))) return null
      previousBlank = false
      if (isListMarker) inList = true
      else if (ATX_HEADING.test(line) || THEMATIC_BREAK.test(line)) {
        inList = false
        inlineCodeTicks = 0
      }
      previousLineIndented = line.startsWith(' ') || line.startsWith('\t')
      continue
    }
    inlineCodeTicks = 0
    // A run of blank lines: only the last one can close a block, and only when the next
    // line is real content that cannot continue what came before. The final line never
    // has a successor, so no boundary opens after it.
    if (index + 1 < lines.length && !BLANK.test(lines[index + 1])) {
      const next = lines[index + 1]
      const indented = next.startsWith(' ') || next.startsWith('\t')
      const isFinalLine = index + 1 === lines.length - 1
      const pendingOrderedMarker = isFinalLine && BARE_ORDERED_PREFIX.test(next)
      // A list marker (or trailing bare digit that may become `2.` on the next stream chunk)
      // on the far side threatens the split whenever the near side belongs to an open list
      // (including lazy continuation lines) or an indented line. After plain text outside
      // any list, the marker plainly starts a new list.
      const continuesList = (LIST_MARKER.test(next) || pendingOrderedMarker) && (inList || previousLineIndented)
      if (!indented && !continuesList) {
        ends.push(starts[index + 1])
        inList = false
      }
    }
    previousBlank = true
  }
  if (latexMathOpen && sawUnsafeInLatex) return null
  if (ends.length === 0) return [text]
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
