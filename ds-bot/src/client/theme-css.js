// The user's own stylesheet goes into the page as a constructed stylesheet, never as a
// <style> element: replaceSync lets the browser parse it (which normalizes every escape
// and oddity into CSSOM) and the tree is then walked and stripped of everything that
// could load a file (shared/theme-css.js, the lexical scan, decides what can load one).
// Mutating the live CSSStyleSheet means nothing unsanitized is ever serialized back into
// text or re-parsed, so no double-parse gap exists. Where constructed stylesheets do not
// exist the user stylesheet simply does not apply -- fail closed.
import { themeCssValueFetches, themeCssWithoutImports } from '../shared/theme-css.js'

// Rules that hold other rules, per the CSSOM class hierarchy. @keyframes is recursed too
// (its frames carry style) but survives emptying: an empty group is dropped, an empty
// keyframe animation is kept, since dropping it changes nothing an attacker can use and
// keeping it changes nothing either -- the frames are clean by then.
const CONTAINERS = new Set(['CSSMediaRule', 'CSSSupportsRule', 'CSSLayerBlockRule', 'CSSContainerRule', 'CSSKeyframesRule'])
// Statements allowed to stay without a look inside: they cannot load anything.
const STATEMENTS = new Set(['CSSLayerStatementRule', 'CSSNamespaceRule'])

// Cross-realm rules fail instanceof, and tests build plain stand-ins, so the class is
// read off the constructor name first and the realm's own constructors second.
const RULE_TYPES = ['CSSMediaRule', 'CSSSupportsRule', 'CSSLayerBlockRule', 'CSSContainerRule', 'CSSKeyframesRule', 'CSSKeyframeRule', 'CSSFontFaceRule', 'CSSStyleRule', 'CSSPropertyRule', 'CSSLayerStatementRule', 'CSSNamespaceRule']
function ruleType(rule, view) {
  const name = rule?.constructor?.name
  if (typeof name === 'string' && RULE_TYPES.includes(name)) return name
  for (const type of RULE_TYPES) {
    const ctor = view?.[type] ?? globalThis[type]
    if (typeof ctor === 'function' && rule instanceof ctor) return type
  }
  return undefined
}

function declarationItems(style) {
  const names = []
  const length = Number.isInteger(style.length) ? style.length : 0
  for (let index = 0; index < length; index += 1) {
    const name = typeof style.item === 'function' ? style.item(index) : style[index]
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return names
}

// Strip every declaration whose value can load a file. Custom properties are scanned
// too: a url() stored in one reaches other properties through var() at use time.
function cleanStyle(style) {
  if (!style || typeof style.getPropertyValue !== 'function' || typeof style.removeProperty !== 'function') return
  for (const name of declarationItems(style)) {
    if (themeCssValueFetches(style.getPropertyValue(name))) style.removeProperty(name)
  }
}

/**
 * Remove everything that can load a file from a parsed sheet's rule tree, in place.
 * Unknown rules are dropped unless they are known statements: a rule this code does not
 * understand may be one a newer browser gives fetching powers.
 * @param {object} sheet - a CSSStyleSheet (or a stand-in of the same shape)
 * @param {object} [view] - the window the sheet belongs to, for cross-realm class checks
 */
export function sanitizeUserSheet(sheet, view) {
  // Rules delete through their owner (the sheet, the grouping rule), never through the
  // CSSRuleList itself: the list is a read-only live view.
  const cleanList = (owner) => {
    const list = owner?.cssRules
    if (!list || typeof list.length !== 'number') return
    const canDelete = typeof owner.deleteRule === 'function'
    const drop = (index) => { if (canDelete) owner.deleteRule(index) }
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const rule = list[index]
      if (!rule) { drop(index); continue }
      const type = ruleType(rule, view)
      const style = rule.style && typeof rule.style === 'object' ? rule.style : undefined
      if (type === 'CSSPropertyRule') {
        // @property's initial-value is a declaration the element tree will use. It is
        // read before anything is cleaned: where the attribute reflects the declaration
        // block, a cleaned block would already read empty.
        const initial = typeof rule.initialValue === 'string' ? rule.initialValue : ''
        const styleInitial = style && typeof style.getPropertyValue === 'function' ? style.getPropertyValue('initial-value') : ''
        if (themeCssValueFetches(initial) || themeCssValueFetches(styleInitial)) drop(index)
        else if (style) cleanStyle(style)
        continue
      }
      if (style) cleanStyle(style)
      if (type !== undefined && CONTAINERS.has(type)) {
        cleanList(rule)
        if (type !== 'CSSKeyframesRule' && (rule.cssRules?.length ?? 0) === 0) drop(index)
        continue
      }
      // A nested rule inside a style rule (CSS nesting) carries child rules too.
      if (rule.cssRules) cleanList(rule)
      if (type !== undefined && STATEMENTS.has(type)) continue
      if (type === 'CSSKeyframeRule') continue
      if ((type !== undefined && (type === 'CSSStyleRule' || type === 'CSSFontFaceRule')) || style) {
        // A rule stripped down to nothing has nothing left to say. Frames are the
        // exception above: their keyText is content of its own.
        const children = rule.cssRules?.length ?? 0
        if ((style?.length ?? 0) === 0 && children === 0) drop(index)
        continue
      }
      // An unknown bare rule has nothing verifiable. Where its owner cannot delete (a
      // nested rule position without the grouping API), nothing about it can be cleaned
      // either -- it is the one shape that stays unverified.
      drop(index)
    }
  }
  cleanList(sheet)
}

/**
 * Whether this document can hold a constructed stylesheet. No fallback exists on
 * purpose: without CSSOM there is no way to verify what the CSS does, so the user
 * stylesheet stays off entirely.
 * @param {object} doc
 * @returns {boolean}
 */
export function userStylesheetSupported(doc) {
  const view = doc?.defaultView ?? globalThis
  return typeof view?.CSSStyleSheet === 'function' && doc !== undefined && doc !== null && 'adoptedStyleSheets' in doc
}

const mounted = new WeakMap()

/**
 * The sheet for one document: created once, adopted at the end of adoptedStyleSheets
 * (constructed sheets order after <style> elements, so the user's rules still load last,
 * as promised) and re-parsed on every call. Anything wrong along the way leaves the
 * sheet empty, never the raw text. In a window opened through the plugin, the sheet
 * detaches itself when the plugin's own last <style> marker leaves the head, so an
 * unloaded plugin leaves nothing behind.
 * @param {object} doc
 * @param {string} css - the user stylesheet as written, already absent in safe appearance
 * @returns {boolean} whether the sheet is in use
 */
export function mountUserStylesheet(doc, css) {
  if (!userStylesheetSupported(doc)) return false
  const view = doc.defaultView ?? globalThis
  try {
    let entry = mounted.get(doc)
    if (!entry) {
      const sheet = new view.CSSStyleSheet()
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      if (!doc.adoptedStyleSheets.includes(sheet)) return false
      entry = { sheet }
      mounted.set(doc, entry)
    }
    let text = themeCssWithoutImports(css)
    try {
      entry.sheet.replaceSync(text)
    } catch {
      // Invalid input must never end up half-applied; nor may what an engine chokes on.
      entry.sheet.replaceSync('')
    }
    sanitizeUserSheet(entry.sheet, view)

    if (!entry.observer && typeof view.MutationObserver === 'function' && typeof doc.head?.querySelectorAll === 'function') {
      // The plugin marks its sheets through dataset.dshBot (styles.js); the marker is
      // looked up the same way, never by the attribute's hyphenated form.
      const marker = () => {
        for (const style of doc.head.querySelectorAll('style')) {
          if (style.dataset?.dshBot === 'user-stylesheet') return style
        }
        return null
      }
      let seen = marker() !== null
      entry.observer = new view.MutationObserver(() => {
        const present = marker() !== null
        seen = seen || present
        // The plugin's own marker element leaves the head when the plugin unloads; the
        // constructed sheet must not stay behind. Windows without that marker (the
        // desktop app's own) keep the sheet for the window's lifetime.
        if (seen && !present) {
          try {
            entry.observer.disconnect()
            entry.observer = undefined
            entry.sheet.replaceSync('')
            doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(sheet => sheet !== entry.sheet)
            mounted.delete(doc)
          } catch { /* a document this far gone keeps nothing either way */ }
        }
      })
      entry.observer.observe(doc.head, { childList: true })
    }
    return true
  } catch {
    return false
  }
}
