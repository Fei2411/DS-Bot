// Quoting untrusted text in a prompt. Content an attacker controls — a web page,
// a message from outside, a pasted document — can carry the closing line of any
// fixed quote fence inside it and break out into what reads as instructions. The
// fence length here is not fixed: it grows past the longest run of angle brackets
// in the quoted text itself, so nothing inside the text can ever close it. Pure,
// so both sides import it.

// The longest contiguous run of angle brackets in the text, in UTF-16 units.
export const fenceNeed = (text) => {
  let longest = 0
  for (const match of String(text ?? '').matchAll(/[<>]+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

// The fence length one text needs: at least 3, always one more than the longest
// run inside it. A closing line is `>` repeated that many, and the text holds no
// such run anywhere, at a line start or not.
export const fenceLengthOf = text => Math.max(3, fenceNeed(text) + 1)

// `text` verbatim between one opening and one closing fence. The opening carries
// the optional label, which says what is quoted (the label is sanitized: brackets
// and line breaks would let it break the fence shape itself). The text is never
// altered: a review quotes what was said, not what survived a cleanup.
export function fenceQuotedText(text, label) {
  const body = String(text ?? '')
  const length = fenceLengthOf(body)
  const note = String(label ?? '').replace(/[[\]<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${'<'.repeat(length)}${note === '' ? '' : ` ${note}`}\n${body}\n${'>'.repeat(length)}`
}

// Untrusted words inline in a sentence of the prompt — a name, a label, an error —
// where a fence would not fit: Unicode-normalized, without brackets (which memory
// metadata and topic links are made of), without line breaks or control characters
// (which would fabricate prompt structure), whitespace collapsed, cut to `maxLen`
// UTF-16 units ending in `…`. The cut is on code points, so a surrogate pair never
// splits; a grapheme cluster may break at the boundary, which a bounded label can
// live with.
export function inlineUntrusted(raw, maxLen = 200) {
  // Whitespace characters collapse rather than vanish, so words separated by a
  // tab or a line break stay two words; other control characters carry no
  // meaning in one line and are stripped.
  const clean = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[[\]\r\n]/g, ' ')
    .replace(/[\t\v\f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ch => (ch === '\u200c' || ch === '\u200d' ? ch : ''))
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= maxLen) return clean
  let out = ''
  let used = 0
  for (const point of clean) {
    if (used + point.length > Math.max(0, maxLen - 1)) break
    out += point
    used += point.length
  }
  return `${out}…`
}
