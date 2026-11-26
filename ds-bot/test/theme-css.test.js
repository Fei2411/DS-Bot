import assert from 'node:assert/strict'
import { test } from 'node:test'
import { themeCssLoadsRemoteFiles, themeCssValueFetches, themeCssWithoutImports } from '../src/shared/theme-css.js'
import { mountUserStylesheet, sanitizeUserSheet, userStylesheetSupported } from '../src/client/theme-css.js'
import { userCss } from '../src/client/appearance.js'

// The scanner and the sanitizer are the zero-exfiltration boundary of the user
// stylesheet: anything that could make the page load a file must be caught, and the
// escape hatch for styling (inline data: images, same-document SVG fragments) must stay.

const fetching = [
  ['url(https://evil.example/x.png)', 'plain https url'],
  ['URL(HTTPS://EVIL.EXAMPLE)', 'uppercase scheme and function'],
  ['url(//evil.example/x)', 'protocol-relative'],
  ['url(file:///etc/passwd)', 'file url'],
  ['url(blob:https://evil.example/x)', 'blob url'],
  ['url(javascript:alert(1))', 'javascript url'],
  ['u\\72 l(https://evil.example)', 'hex escape inside the function name'],
  ['\\75 rl(https://evil.example)', 'the whole function name escaped'],
  ['url(htt\\70 s://evil.example)', 'hex escape inside the scheme'],
  ['url("d\\61ta:image/png;base64,AA==")', 'escape hiding a scheme inside a quoted url'],
  ['image-set(url(data:image/png;base64,AA==) 1x)', 'image-set even with a data url'],
  ['-webkit-image-set("https://evil.example" 1x)', 'prefixed image-set with a bare string'],
  ['image("https://evil.example/x.png")', 'CSS Images 4 image() with a bare string'],
  ['src(url(data:x))', 'src() even with a data url'],
  ['url()', 'empty url'],
  ['url("")', 'empty quoted url'],
  ['url(  )', 'whitespace-only url'],
  ['url("https://evil.example"', 'unterminated quoted url'],
  ['url(https://evil.example', 'unterminated unquoted url'],
  ['url("https://evil.example\')', 'mismatched quotes'],
  ['url(data:image/png;base64,AA== extra)', 'whitespace inside an unquoted url'],
  ['url("data:x" trailing)', 'content after the quoted url'],
  ['url( data:image/png;base64,AA==)', 'U+00A0 before the scheme is not CSS whitespace'],
  ['url(#frag\\ment)', 'escape inside a fragment'],
  ['var(--evil, url(https://evil.example))', 'url inside a var() fallback'],
  ['@import url(https://evil.example)', 'an @import inside a value'],
  ['url(data:image/png;base64,AA==) url(https://evil.example)', 'one good, one bad'],
]
const clean = [
  ['url(data:image/png;base64,iVBORw0KGgo=)', 'unquoted data url'],
  ['url("data:image/png;base64,iVBORw0KGgo=")', 'quoted data url'],
  ["url('data:image/svg+xml,%3Csvg%3E')", 'single-quoted data url'],
  ['URL(DATA:image/png;base64,AA==)', 'scheme and function case'],
  ['url( data:image/png;base64,AA== )', 'css whitespace around an unquoted data url'],
  ['url(#clip)', 'bare fragment'],
  ["url('#clip')", 'quoted fragment'],
  ['url(data:x )', 'U+00A0 inside the data stays data: whatever it decodes to'],
  ['#fff', 'a color'],
  ['var(--bt-ink)', 'a var() reference'],
  ['1px solid var(--bt-line)', 'a border'],
  ['linear-gradient(90deg,#000,#fff)', 'a gradient'],
  ['content: "url(https://evil.example)"', 'url() inside a string is text'],
  ["content: '@import \"https://evil.example\"'", '@import inside a string is text'],
  ['content: "image-set(\\"x\\")"', 'an escaped quote inside a string'],
  ['/* url(https://evil.example) */ red', 'url() inside a comment'],
  ['10px 20px', 'numbers'],
  ['"quoted \\} brace"', 'escaped brace in a string'],
]

test('the lexical scan flags every fetching shape and allows data: urls and fragments', () => {
  for (const [value, what] of fetching) assert.equal(themeCssValueFetches(value), true, `should flag: ${what}`)
  for (const [value, what] of clean) assert.equal(themeCssValueFetches(value), false, `should allow: ${what}`)
})

test('whole stylesheets count @import anywhere outside strings and comments', () => {
  assert.equal(themeCssLoadsRemoteFiles('@import url(https://evil.example);'), true)
  assert.equal(themeCssLoadsRemoteFiles('@import "https://evil.example";'), true)
  assert.equal(themeCssLoadsRemoteFiles('@IMPORT "https://evil.example";'), true)
  assert.equal(themeCssLoadsRemoteFiles('@import/*x*/"https://evil.example" screen and (min-width:1px);'), true)
  assert.equal(themeCssLoadsRemoteFiles('@im\\70 ort "https://evil.example";'), true)
  assert.equal(themeCssLoadsRemoteFiles('@import "https://evil.example"'), true)
  assert.equal(themeCssLoadsRemoteFiles('/* @import "https://evil.example"; */ .a{color:red}'), false)
  assert.equal(themeCssLoadsRemoteFiles('.a{content:"@import url(x)";color:red}'), false)
  assert.equal(themeCssLoadsRemoteFiles('.a{color:red}.b{background:url(https://evil.example)}'), true)
  assert.equal(themeCssLoadsRemoteFiles('.a{fill:url(#clip)}.b{background:url(data:x)}'), false)
})

test('escaped @import statements are blanked like plain ones', () => {
  // \70 is 'p': the rule decodes to @import.
  const css = '@im\\70 ort "https://evil.example/x.css";\n.a{color:red}'
  const out = themeCssWithoutImports(css)
  assert.equal(out.includes('evil.example'), false)
  assert.equal(out.length, css.length)
  assert.ok(out.endsWith('.a{color:red}'))
  assert.equal(themeCssLoadsRemoteFiles(css), true)
  // Other spellings of the same rule: a hex escape with its trailing whitespace, a plain
  // character escape, an uppercase hex digit.
  for (const spelling of ['@\\69mport "x";', '@i\\6d port "x";', '@\\49MPORT "x";']) {
    assert.equal(themeCssWithoutImports(spelling).includes('"x"'), false, spelling)
  }
  // An escaped at-rule that is not @import stays as written.
  assert.equal(themeCssWithoutImports('@me\\64 ia (min-width:1px){.a{}}'), '@me\\64 ia (min-width:1px){.a{}}')
})

test('themeCssWithoutImports blanks whole statements in place and keeps everything else', () => {
  const css = '@import url(https://evil.example) screen;\n.a{color:red}\n@import "x";\n.b{content:"@import y"}'
  const out = themeCssWithoutImports(css)
  assert.equal(out.length, css.length, 'positions are kept')
  assert.equal(out.includes('evil.example'), false)
  assert.equal(out.includes('@import url'), false)
  assert.ok(out.endsWith('.b{content:"@import y"}'), 'the string stays as it is')
  assert.match(out, /\.a\{color:red\}/)
  // An import cut off by the end of the text is blanked to its end.
  assert.equal(themeCssWithoutImports('.a{} @import "x"').includes('"x"'), false)
  // Nothing to blank: the text is returned as given.
  assert.equal(themeCssWithoutImports('.a{color:red}'), '.a{color:red}')
})

test('unescaped newlines terminate CSS strings so subsequent rules and @import cannot hide behind an unclosed quote', () => {
  // Unclosed quote before LF / CR / FF closes as a bad-string token, so the next line's
  // remote url() and @import are still scanned and stripped instead of swallowed as text.
  for (const nl of ['\n', '\r', '\f', '\r\n']) {
    const withUrl = `.a{content:"unclosed${nl}}.b{background:url(https://evil.example/a.png)}.c{content:"x"}`
    assert.equal(themeCssLoadsRemoteFiles(withUrl), true, `url after unclosed quote (${JSON.stringify(nl)})`)
    const withImport = `.a{content:"unclosed${nl}}@import "https://evil.example/a.css";${nl}.c{content:"x"}`
    assert.equal(themeCssLoadsRemoteFiles(withImport), true, `@import after unclosed quote (${JSON.stringify(nl)})`)
    const stripped = themeCssWithoutImports(withImport)
    assert.equal(stripped.includes('evil.example'), false, `@import stripped after unclosed quote (${JSON.stringify(nl)})`)
    assert.ok(stripped.endsWith('.c{content:"x"}'))
  }
  // An unclosed quoted url() before a newline also terminates at the newline rather than eating @import.
  const brokenUrlThenImport = '.a{background:url("data:x\n}@import "https://evil.example/b.css";\n.b{content:"y")}'
  assert.equal(themeCssLoadsRemoteFiles(brokenUrlThenImport), true)
  assert.equal(themeCssWithoutImports(brokenUrlThenImport).includes('evil.example'), false)
  // Valid backslash-escaped line continuations (\LF and \CRLF) stay inside the string.
  assert.equal(themeCssLoadsRemoteFiles('.a{content:"line1 \\\n url(https://evil.example) line2"}'), false)
  assert.equal(themeCssLoadsRemoteFiles('.a{content:"line1 \\\r\n @import \\"https://evil.example\\" line2"}'), false)
})

// --- The CSSOM sanitizer, over stand-in rules of the same shape. ---

class MockStyleDecl {
  constructor(pairs = []) { this.map = new Map(pairs) }
  get length() { return this.map.size }
  item(index) { return [...this.map.keys()][index] ?? '' }
  getPropertyValue(name) { return this.map.get(name) ?? '' }
  removeProperty(name) { this.map.delete(name); return '' }
}
// Rule lists are read-only views, as in the real CSSOM; deletion goes through the owner.
const ruleList = (...rules) => {
  const list = [...rules]
  return list
}
const own = (rule, rules) => {
  rule.cssRules = rules ?? []
  rule.deleteRule = (index) => { rule.cssRules.splice(index, 1) }
  return rule
}
class CSSStyleRule {
  constructor(selector, pairs, children) {
    this.selectorText = selector
    this.style = new MockStyleDecl(pairs)
    if (children) own(this, children)
  }
}
class CSSFontFaceRule {
  constructor(pairs) { this.style = new MockStyleDecl(pairs) }
}
class CSSKeyframesRule {
  constructor(name, frames) { this.name = name; own(this, frames) }
}
class CSSKeyframeRule {
  constructor(keyText, pairs) { this.keyText = keyText; this.style = new MockStyleDecl(pairs) }
}
class CSSMediaRule {
  constructor(mediaText, rules) { this.media = { mediaText }; own(this, rules) }
}
class CSSSupportsRule {
  constructor(conditionText, rules) { this.conditionText = conditionText; own(this, rules) }
}
class CSSLayerBlockRule {
  constructor(name, rules) { this.name = name; own(this, rules) }
}
class CSSContainerRule {
  constructor(rules) { own(this, rules) }
}
class CSSLayerStatementRule {}
class CSSNamespaceRule {}
class UnknownRule {}
class WeirdStyledRule {
  constructor(pairs) { this.style = new MockStyleDecl(pairs) }
}
// @property, per the spec: plain attributes, no declaration block. With `withStyle`,
// as an implementation carrying a declaration block would expose it: the initialValue
// attribute reflects the initial-value declaration.
class CSSPropertyRule {
  constructor(initialValue, withStyle = false) {
    this.name = '--x'
    this.syntax = '<color>'
    this.inherits = false
    this.initialValue = initialValue
    if (withStyle) {
      this.style = new MockStyleDecl([['syntax', '<color>'], ['inherits', 'false'], ['initial-value', initialValue]])
      Object.defineProperty(this, 'initialValue', { get: () => this.style.getPropertyValue('initial-value') })
    }
  }
}

const sanitize = (...rules) => {
  const sheet = own({}, rules)
  sanitizeUserSheet(sheet)
  return sheet.cssRules
}

test('fetching declarations are stripped and the rest of the rule stays', () => {
  const [rule] = sanitize(new CSSStyleRule('.a', [
    ['background', 'url(https://evil.example)'],
    ['color', 'red'],
    ['background-image', 'url(data:image/png;base64,AA==)'],
    ['fill', 'url(#clip)'],
    ['content', '"url(https://evil.example)"'],
  ]))
  assert.equal(rule.style.getPropertyValue('background'), '')
  assert.equal(rule.style.getPropertyValue('color'), 'red')
  assert.equal(rule.style.getPropertyValue('background-image'), 'url(data:image/png;base64,AA==)')
  assert.equal(rule.style.getPropertyValue('fill'), 'url(#clip)')
  assert.equal(rule.style.getPropertyValue('content'), '"url(https://evil.example)"')
})

test('custom properties are stripped too: var() would carry their url into other properties', () => {
  const [rule] = sanitize(new CSSStyleRule('.a', [
    ['--evil', 'url(https://evil.example)'],
    ['--inline', 'url(data:x)'],
    ['color', 'var(--evil)'],
  ]))
  assert.equal(rule.style.getPropertyValue('--evil'), '')
  assert.equal(rule.style.getPropertyValue('--inline'), 'url(data:x)')
  // Referencing a custom property is not a fetch in itself; the value scanned was clean.
  assert.equal(rule.style.getPropertyValue('color'), 'var(--evil)')
})

test('@font-face loses a remote src and keyframes are cleaned inside out', () => {
  const [face, frames] = sanitize(
    new CSSFontFaceRule([['font-family', 'x'], ['src', 'url(https://evil.example/font.woff2)']]),
    new CSSKeyframesRule('spin', [
      new CSSKeyframeRule('0%', [['opacity', '1'], ['background', 'u\\72 l(https://evil.example)']]),
    ]),
  )
  assert.equal(face.style.getPropertyValue('font-family'), 'x')
  assert.equal(face.style.getPropertyValue('src'), '')
  assert.equal(frames.cssRules.length, 1, 'keyframes survive emptying of their frames')
  assert.equal(frames.cssRules[0].style.getPropertyValue('opacity'), '1')
  assert.equal(frames.cssRules[0].style.getPropertyValue('background'), '')
})

test('grouping rules are cleaned recursively and dropped once empty', () => {
  const rules = sanitize(
    new CSSMediaRule('(min-width:1px)', [
      new CSSStyleRule('.a', [['background', 'url(https://evil.example)']]),
    ]),
    new CSSSupportsRule('(display:grid)', [
      new CSSStyleRule('.b', [['color', 'red']]),
    ]),
    new CSSLayerBlockRule('mine', [
      new CSSStyleRule('.c', [['list-style', 'image-set(url(data:x) 1x)']]),
    ]),
    new CSSContainerRule([
      new CSSStyleRule('.d', [['color', 'blue']]),
    ]),
  )
  assert.equal(rules.length, 3, 'the media block dropped once empty; the empty @layer stays to preserve cascade order')
  assert.equal(rules[0].conditionText, '(display:grid)')
  assert.equal(rules[0].cssRules.length, 1)
  assert.equal(rules[1].name, 'mine')
  assert.equal(rules[1].cssRules.length, 0, 'the unsafe rule inside @layer is gone')
  assert.equal(rules[2].cssRules[0].style.getPropertyValue('color'), 'blue')
})

test('unknown rules are dropped unless they are bare statements or carry verifiable style', () => {
  const rules = sanitize(
    new UnknownRule(),
    new CSSLayerStatementRule(),
    new CSSNamespaceRule(),
    new WeirdStyledRule([['color', 'red'], ['background', 'url(https://evil.example)']]),
  )
  assert.equal(rules.length, 3)
  assert.ok(rules[0] instanceof CSSLayerStatementRule)
  assert.ok(rules[1] instanceof CSSNamespaceRule)
  assert.equal(rules[2].style.getPropertyValue('color'), 'red', 'a style-bearing rule stays, cleaned')
  assert.equal(rules[2].style.getPropertyValue('background'), '')
})

test('@property with a fetching initial value is deleted, in either implementation shape', () => {
  assert.equal(sanitize(new CSSPropertyRule('url(https://evil.example)')).length, 0)
  const [safe] = sanitize(new CSSPropertyRule('#ff0000'))
  assert.equal(safe.initialValue, '#ff0000')
  assert.equal(sanitize(new CSSPropertyRule('src(url(data:x))', true)).length, 0)
  const [kept] = sanitize(new CSSPropertyRule('#00ff00', true))
  assert.equal(kept.initialValue, '#00ff00')
})

test('nested style rules (CSS nesting) are cleaned both in style and in their children', () => {
  const child = new CSSStyleRule('.nested', [['background', 'url(https://evil.example)'], ['color', 'red']])
  const [outer] = sanitize(new CSSStyleRule('.outer', [['color', 'blue'], ['outline', '1px src(x)']], ruleList(child)))
  assert.equal(outer.style.getPropertyValue('outline'), '')
  assert.equal(outer.style.getPropertyValue('color'), 'blue')
  assert.equal(child.style.getPropertyValue('background'), '')
  assert.equal(child.style.getPropertyValue('color'), 'red')
})

// A declaration block the way Chromium holds a pending substitution: the shorthand's
// value stays on the shorthand itself (not enumerated), its longhands enumerate empty.
class PendingShorthandStyle extends MockStyleDecl {
  constructor(pairs, shorthands) {
    super(pairs)
    this.shorthands = new Map(shorthands)
  }
  getPropertyValue(name) {
    if (this.shorthands.has(name)) return this.shorthands.get(name)
    return super.getPropertyValue(name)
  }
  removeProperty(name) {
    if (this.shorthands.has(name)) {
      const value = this.shorthands.get(name)
      this.shorthands.delete(name)
      return value
    }
    return super.removeProperty(name)
  }
  get cssText() {
    const parts = [...this.shorthands.entries()].map(([key, value]) => `${key}: ${value};`)
    for (const [key, value] of this.map) if (value !== '') parts.push(`${key}: ${value};`)
    return parts.join(' ')
  }
  set cssText(value) {
    if (value === '') { this.map.clear(); this.shorthands.clear() }
  }
}

test('a pending-substitution shorthand with a fetching var() fallback goes out, the clean declarations stay', () => {
  const style = new PendingShorthandStyle(
    [['background-image', ''], ['background-color', ''], ['color', 'red']],
    [['background', 'var(--nope, url(https://evil.example/x.png))']],
  )
  const target = new CSSStyleRule('.a', [['x-placeholder', '1']], undefined)
  target.style = style
  const [rule] = sanitize(target)
  assert.equal(rule.style.getPropertyValue('background'), '', 'the shorthand was removed')
  assert.equal(rule.style.getPropertyValue('color'), 'red', 'the clean declaration stays: the surgical scan was enough')
})

test('the cssText backstop clears the whole block when a fetch survives per-property scans', () => {
  // A shorthand this code does not list: nothing per-property catches it, the backstop does.
  const style = new PendingShorthandStyle(
    [['color', 'red']],
    [['future-shorthand', 'var(--x, url(https://evil.example))']],
  )
  const target = new CSSStyleRule('.a', [['x-placeholder', '1']], undefined)
  target.style = style
  sanitize(target)
  assert.equal(style.getPropertyValue('future-shorthand'), '', 'the unknown shorthand is gone')
  assert.equal(style.getPropertyValue('color'), '', 'the whole block went, not just the fetching value')
})

// --- Mounting as a constructed stylesheet, over a stand-in document. ---

// A tiny parser for the controlled inputs of these tests: rules of the form
// `selector{prop:value;...}`, no nesting. The real browser does this parsing; here it is
// only so the end-to-end assertions have a tree to read.
const parseMini = (text) => {
  const rules = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const pairs = match[2].split(';').map(part => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf(':')
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()]
    })
    rules.push(new CSSStyleRule(match[1].trim(), pairs))
  }
  return rules
}

function fakeDocument() {
  let parseCount = 0
  let mountedDuringParse = false
  class FakeSheet {
    constructor() { this.cssRules = []; this.texts = [] }
    replaceSync(text) {
      if (text !== '' && doc.adoptedStyleSheets.includes(this)) mountedDuringParse = true
      parseCount += 1
      this.texts.push(text)
      this.cssRules = parseMini(text)
    }
    deleteRule(index) { this.cssRules.splice(index, 1) }
  }
  const observers = []
  class FakeObserver {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  let hasMarker = true
  const doc = {
    head: { querySelectorAll: what => (what === 'style' && hasMarker ? [{ dataset: { dshBot: 'user-stylesheet' } }] : []) },
    adoptedStyleSheets: [],
    defaultView: { CSSStyleSheet: FakeSheet, MutationObserver: FakeObserver },
  }
  return {
    doc,
    fireMutations: () => observers.forEach(observer => observer.callback([])),
    removeMarker: () => { hasMarker = false },
    sheet: () => doc.adoptedStyleSheets[0],
    parseCount: () => parseCount,
    mountedDuringParse: () => mountedDuringParse,
  }
}

test('the user stylesheet mounts as a constructed sheet, imports blanked, values cleaned', () => {
  const { doc, sheet } = fakeDocument()
  assert.equal(userStylesheetSupported(doc), true)
  const css = '@import url(https://evil.example);\n.a{background:url(https://evil.example);color:red}\n.b{background:url(data:x)}'
  assert.equal(mountUserStylesheet(doc, css), true)
  assert.equal(doc.adoptedStyleSheets.length, 1)
  const texts = sheet().texts
  assert.equal(texts[0].includes('evil.example') && texts[0].includes('@import'), false, 'the import is blanked before parsing')
  const [a, b] = sheet().cssRules
  assert.equal(a.style.getPropertyValue('background'), '')
  assert.equal(a.style.getPropertyValue('color'), 'red')
  assert.equal(b.style.getPropertyValue('background'), 'url(data:x)')
  // A second mount reuses the one sheet instead of adopting another.
  mountUserStylesheet(doc, '.c{color:blue}')
  assert.equal(doc.adoptedStyleSheets.length, 1)
  assert.equal(sheet().cssRules.length, 1)
})

test('the sheet detaches when the plugin marker leaves the head, and unsupported documents get nothing', () => {
  const { doc, fireMutations, removeMarker, sheet } = fakeDocument()
  mountUserStylesheet(doc, '.a{color:red}')
  assert.equal(doc.adoptedStyleSheets.length, 1)
  const adopted = sheet()
  fireMutations()
  assert.equal(doc.adoptedStyleSheets.length, 1, 'the marker is still there')
  removeMarker()
  fireMutations()
  assert.equal(doc.adoptedStyleSheets.length, 0, 'the sheet leaves with the plugin')
  assert.equal(adopted.cssRules.length, 0, 'and it was emptied before leaving')
  // Documents without constructed stylesheets are refused: no raw <style> fallback exists.
  assert.equal(userStylesheetSupported({}), false)
  assert.equal(mountUserStylesheet({}, '.a{}'), false)
  assert.equal(mountUserStylesheet(undefined, '.a{}'), false)
})

test('userCss never returns text for injection and syncs the constructed sheet instead', () => {
  const { doc, sheet } = fakeDocument()
  assert.equal(userCss({ css: '.a{color:red}' }, false, doc), '')
  assert.equal(doc.adoptedStyleSheets.length, 1)
  assert.equal(sheet().cssRules.length, 1)
  // Safe appearance empties the sheet; a cleared stylesheet does the same.
  userCss({ css: '.a{color:red}' }, true, doc)
  assert.equal(sheet().cssRules.length, 0)
  userCss({ css: '.a{color:red}' }, false, doc)
  assert.equal(sheet().cssRules.length, 1)
  userCss({}, false, doc)
  assert.equal(sheet().cssRules.length, 0)
  // Without a document there is nothing to do, and nothing throws.
  assert.equal(userCss({ css: '.a{}' }, false, undefined), '')
})

test('an unchanged stylesheet is not re-parsed or re-sanitized on every render, and sheets are parsed offline before adoption', () => {
  const { doc, sheet, parseCount, mountedDuringParse } = fakeDocument()
  mountUserStylesheet(doc, '.a{color:red}')
  const first = sheet()
  assert.equal(parseCount(), 1)
  assert.equal(mountedDuringParse(), false, 'raw stylesheet parses offline before adoption')
  mountUserStylesheet(doc, '.a{color:red}')
  assert.equal(parseCount(), 1, 'same text: nothing re-parsed')
  assert.equal(sheet(), first)
  // If another caller replaces adoptedStyleSheets, unchanged text re-adopts without re-parsing.
  doc.adoptedStyleSheets = []
  mountUserStylesheet(doc, '.a{color:red}')
  assert.equal(parseCount(), 1)
  assert.equal(sheet(), first)
  // Updating parses offline on a fresh sheet, swaps it in, and empties the detached previous sheet.
  mountUserStylesheet(doc, '.a{color:blue}')
  assert.equal(doc.adoptedStyleSheets.length, 1)
  assert.equal(first.cssRules.length, 0, 'detached previous sheet is emptied')
  assert.equal(mountedDuringParse(), false, 'updates also parse offline before adoption')
  const countAfterUpdate = parseCount()
  mountUserStylesheet(doc, '')
  assert.ok(parseCount() > countAfterUpdate)
  assert.equal(sheet().cssRules.length, 0)
})

test('out-of-range hex escapes clamp to U+FFFD without throwing or poisoning the sheet cache', () => {
  const { doc, sheet } = fakeDocument()
  assert.equal(themeCssWithoutImports('@\\ffffff foo; .a{color:red}').includes('.a{color:red}'), true)
  assert.equal(mountUserStylesheet(doc, '.a{color:red}'), true)
  assert.equal(sheet().cssRules.length, 1)
  assert.equal(mountUserStylesheet(doc, '@\\ffffff foo; .b{color:blue}'), true)
  assert.equal(mountUserStylesheet(doc, '.a{color:red}'), true)
  assert.equal(sheet().cssRules.length, 1, 'recovering back to the prior valid stylesheet still applies')
})

test('a mount failure resets the cached text so re-applying the prior stylesheet recovers', () => {
  const { doc, sheet } = fakeDocument()
  assert.equal(mountUserStylesheet(doc, '.a{color:red}'), true)
  assert.equal(sheet().cssRules.length, 1)
  // Force sanitizeUserSheet to throw on a non-string input, simulating an unexpected failure.
  assert.equal(mountUserStylesheet(doc, /** @type {any} */ ({ toString() { throw new Error('boom') } })), false)
  assert.equal(sheet().cssRules.length, 0, 'failed mount empties the sheet fail-closed')
  assert.equal(mountUserStylesheet(doc, '.a{color:red}'), true)
  assert.equal(sheet().cssRules.length, 1, 're-applying the earlier valid stylesheet is not skipped by a stale cache')
})


