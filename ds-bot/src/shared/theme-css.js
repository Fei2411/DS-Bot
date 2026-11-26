// Lexical scan of stylesheet text for anything that makes the page load a file:
// @import, url(), image-set() and src(). The scan reads the text the way a CSS parser
// does -- comments and strings are skipped as such, so a url() inside a string is text,
// not a fetch. It never tries to be clever with what remains: a backslash outside a
// string means an escape may be hiding the real token (u\72 l, \75 rl), so the value is
// treated as fetching. Whitespace is exactly the CSS whitespace [ \t\n\f\r]; lookalikes
// such as U+00A0 are not whitespace, so they can never smuggle a padded scheme past the
// data: check either.
//
// The only URLs allowed are data: ones (inline, nothing is loaded) and bare fragments
// (#id, a paint server in the page's own SVG). Everything else -- http(s), file, blob,
// a malformed or empty url(), any image-set() or src() -- counts as a fetch. That is
// wider than what a browser would really load, on purpose: when the scan is unsure, the
// declaration goes out.

/** CSS whitespace, and only CSS whitespace (never U+00A0 or other lookalikes). */
const isCssSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r'

// Name code points: letters, digits, hyphen, underscore and anything non-ASCII. Good
// enough to tell `url` from `10px` or `image-set`; escapes never reach here (they count
// as a fetch before an identifier can hide behind them).
const isNameCode = code => code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39)
  || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code >= 0x80

const urlAllowedByDefault = content => content.startsWith('#') || (content.length >= 5 && content.slice(0, 5).toLowerCase() === 'data:')

// Functions whose argument is a resource. url() is inspected because data: and fragments
// stay; the others can carry a bare string or several candidates, so they count as a
// fetch as soon as they appear.
const REMOTE_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'src'])

/**
 * Scan stylesheet text (or one declaration value) for file loads.
 * @param {string} text
 * @returns {{ fetches: boolean, imports: Array<[number, number]> }} - `imports` are the
 *   [start, end) spans of whole `@import` statements, for blanking them out
 */
function scanThemeCss(text, allowUrl = urlAllowedByDefault) {
  const source = String(text ?? '')
  const n = source.length
  let fetches = false
  const imports = []
  let i = 0

  const skipComment = () => {
    const end = source.indexOf('*/', i + 2)
    i = end === -1 ? n : end + 2
  }

  // A string, per CSS Syntax Level 3 §4.3.5: backslash escapes the next character (or
  // continues the string over a newline, including CRLF), while an unescaped newline
  // terminates the string immediately as a bad-string token so subsequent rules cannot
  // hide behind an unclosed quote.
  const skipString = () => {
    const quote = source[i]
    i += 1
    while (i < n) {
      const ch = source[i]
      if (ch === '\\') {
        i = Math.min(i + (source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2), n)
        continue
      }
      if (ch === '\n' || ch === '\r' || ch === '\f') {
        fetches = true
        return
      }
      i += 1
      if (ch === quote) return
    }
  }

  // The end of an @import statement: the first top-level semicolon, the start of a block,
  // or the end of the text. Strings, comments and parentheses along the way are skipped.
  // This scan is its own pass with its own position: the main loop's position must not
  // move while the statement is measured.
  const endOfImport = (start) => {
    let at = start
    let depth = 0
    while (at < n) {
      const ch = source[at]
      if (ch === '"' || ch === "'") {
        const quote = ch
        at += 1
        while (at < n) {
          const c = source[at]
          if (c === '\\') {
            at = Math.min(at + (source[at + 1] === '\r' && source[at + 2] === '\n' ? 3 : 2), n)
            continue
          }
          if (c === '\n' || c === '\r' || c === '\f') break
          at += 1
          if (c === quote) break
        }
        continue
      }
      if (ch === '/' && source[at + 1] === '*') {
        const close = source.indexOf('*/', at + 2)
        at = close === -1 ? n : close + 2
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') depth = Math.max(0, depth - 1)
      else if (ch === ';' && depth === 0) return at + 1
      else if (ch === '{' && depth === 0) return at
      at += 1
    }
    return n
  }

  // The argument of url(, once i sits past the opening parenthesis. Only an exactly
  // well-formed data: URL or bare fragment passes; anything malformed counts as a fetch,
  // because a browser may still make something of it.
  const urlArgument = () => {
    while (i < n && isCssSpace(source[i])) i += 1
    let content = ''
    let malformed = false
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      let closed = false
      while (i < n) {
        const c = source[i]
        if (c === '\\') {
          malformed = true
          i = Math.min(i + (source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2), n)
          continue
        }
        if (c === '\n' || c === '\r' || c === '\f') { malformed = true; break }
        if (c === quote) { closed = true; i += 1; break }
        content += c
        i += 1
      }
      if (!closed) malformed = true
      while (i < n && isCssSpace(source[i])) i += 1
      if (source[i] === ')') i += 1
      else malformed = true
    } else {
      let raw = ''
      while (i < n && source[i] !== ')') {
        const c = source[i]
        if (c === '\\') { malformed = true; i = Math.min(i + 2, n); continue }
        if (c === '"' || c === "'" || c === '(') malformed = true
        raw += c
        i += 1
      }
      if (source[i] === ')') i += 1
      else malformed = true
      content = raw.replace(/[ \t\n\f\r]+$/, '')
      if (/[ \t\n\f\r]/.test(content)) malformed = true
    }
    if (malformed || content === '') { fetches = true; return }
    if (allowUrl(content)) return
    fetches = true
  }

  while (i < n) {
    const ch = source[i]
    if (isCssSpace(ch)) { i += 1; continue }
    if (ch === '/' && source[i + 1] === '*') { skipComment(); continue }
    if (ch === '"' || ch === "'") { skipString(); continue }
    if (ch === '\\') {
      // An escape outside a string can spell any letter: u\72 l( is url(. Rather than
      // decoding and second-guessing, the value counts as a fetch -- hand-written
      // stylesheets essentially never need escapes outside strings.
      fetches = true
      i = Math.min(i + 2, n)
      continue
    }
    if (ch === '@') {
      // The at-rule's name, with escapes decoded: @im\70 ort is @import. A hex escape
      // takes up to six digits plus one whitespace, any other character stands for itself.
      const at = i
      let j = i + 1
      let name = ''
      while (j < n) {
        const code = source.charCodeAt(j)
        if (isNameCode(code)) { name += source[j]; j += 1; continue }
        if (source[j] === '\\' && j + 1 < n && source[j + 1] !== '\n' && source[j + 1] !== '\r' && source[j + 1] !== '\f') {
          const rest = source.slice(j + 1)
          const hex = /^[0-9a-fA-F]{1,6}/.exec(rest)
          if (hex !== null) {
            const cp = parseInt(hex[0], 16)
            name += String.fromCodePoint(cp === 0 || cp > 0x10ffff ? 0xfffd : cp)
            j += 1 + hex[0].length
            // One whitespace after a hex escape belongs to the escape (a CRLF counts as one).
            if (source[j] === '\r' && source[j + 1] === '\n') j += 2
            else if (isCssSpace(source[j])) j += 1
          } else {
            name += source[j + 1]
            j += 2
          }
          continue
        }
        break
      }
      if (name.toLowerCase() === 'import') {
        fetches = true
        const end = endOfImport(j)
        imports.push([at, end])
        i = end
        continue
      }
      i = j > i + 1 ? j : i + 1
      continue
    }
    if (isNameCode(source.charCodeAt(i))) {
      let j = i
      while (j < n && isNameCode(source.charCodeAt(j))) j += 1
      const name = source.slice(i, j).toLowerCase()
      if (source[j] === '(') {
        i = j + 1
        if (name === 'url') urlArgument()
        else if (REMOTE_FUNCTIONS.has(name)) fetches = true
        continue
      }
      i = j
      continue
    }
    i += 1
  }
  return { fetches, imports }
}

/**
 * Whether a declaration value can make the page load a file.
 * @param {string} value
 * @returns {boolean}
 */
export const themeCssValueFetches = (value, allowUrl) => scanThemeCss(value, allowUrl).fetches

/**
 * Whether stylesheet text can make the page load a file, counting @import. One scanner
 * serves both questions: an @import inside a value is just as impossible to allow.
 * @param {string} css
 * @returns {boolean}
 */
export const themeCssLoadsRemoteFiles = (css, allowUrl) => scanThemeCss(css, allowUrl).fetches

/**
 * The stylesheet with every @import statement blanked to spaces (positions kept, so the
 * rest parses exactly as before). Constructed stylesheets forbid @import; some engines
 * throw on replaceSync when one is present, so the statements go before parsing instead.
 * @param {string} css
 * @returns {string}
 */
export function themeCssWithoutImports(css) {
  const source = String(css ?? '')
  const { imports } = scanThemeCss(source)
  if (imports.length === 0) return source
  let out = ''
  let at = 0
  for (const [start, end] of imports) {
    out += source.slice(at, start) + ' '.repeat(end - start)
    at = end
  }
  return out + source.slice(at)
}
