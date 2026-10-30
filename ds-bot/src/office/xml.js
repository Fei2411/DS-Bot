// XML helpers over @xmldom/xmldom: parse/serialize, safe pretty-print for `unpack`,
// and the inverse whitespace strip for `pack`. Elements whose text must survive
// pretty whitespace rules (w:t, w:delText, w:instrText, a:t, and anything inside
// xml:space="preserve") keep their character data untouched.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  xml: 'http://www.w3.org/XML/1998/namespace',
}

export const parser = new DOMParser({ onError: (level, message) => { throw new XmlError(message) } })
const serializer = new XMLSerializer()

export class XmlError extends Error {
  constructor(message) { super(`XML not well-formed: ${message}`); this.code = 'xml' }
}

/**
 * @param {string|Buffer} text
 * @returns {Document} parsed document; throws XmlError when not well-formed
 */
export function parseXml(text) {
  return parser.parseFromString(String(text), 'text/xml')
}

export function serializeXml(node) {
  return serializer.serializeToString(node)
}

export function qname(ns, local) { return `${ns}:${local}` }

// Tag names whose character data is document content, never pretty-print filler.
const TEXT_TAGS = new Set(['w:t', 'w:delText', 'w:instrText', 'a:t', 'm:t'])

function preserved(element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentNode) {
    if (node.getAttribute?.('xml:space') === 'preserve') return true
  }
  return false
}

/**
 * Insert pretty-print indentation. Text-bearing elements and xml:space="preserve"
 * subtrees are never touched.
 * @param {Document} doc
 * @returns {string}
 */
export function prettyXml(doc) {
  const indent = (node, depth) => {
    const children = [...node.childNodes]
    if (children.length === 0 || preserved(node) || children.some(child => child.nodeType === 3 || child.nodeType === 4)) return
    const pad = '\n' + '  '.repeat(depth)
    for (const child of children) {
      if (child.nodeType === 1) indent(child, depth + 1)
      node.insertBefore(doc.createTextNode(pad), child)
    }
    node.appendChild(doc.createTextNode('\n' + '  '.repeat(Math.max(0, depth - 1))))
  }
  indent(doc.documentElement, 1)
  return serializeXml(doc)
}

/**
 * Remove the whitespace `prettyXml` (or an editor's formatting) added: every
 * whitespace-only text node outside protected elements.
 * @param {Document} doc
 */
export function stripPrettyWhitespace(doc) {
  const drop = []
  const walk = (node) => {
    if (node.nodeType === 3) {
      if (node.data.trim() === '' && !preserved(node.parentNode) && !TEXT_TAGS.has(node.parentNode?.tagName)) drop.push(node)
      return
    }
    for (const child of [...node.childNodes]) walk(child)
  }
  walk(doc.documentElement)
  for (const node of drop) node.parentNode.removeChild(node)
}

/** @returns {Element[]} child elements of `node` with the given qualified tag, or all when omitted */
export function childrenOf(node, tag) {
  return [...(node?.childNodes ?? [])].filter(child => child.nodeType === 1 && (tag === undefined || child.tagName === tag))
}

/** @returns {Element[]} all descendant elements, filtered to `tag` when given */
export function elementsOf(node, tag) {
  const found = []
  const walk = (el) => {
    if (el.nodeType !== 1) return
    if (tag === undefined || el.tagName === tag) found.push(el)
    for (const child of childrenOf(el)) walk(child)
  }
  walk(node)
  return found
}

/** @returns {Element | undefined} first descendant element with the tag */
export function firstOf(node, tag) {
  if (node.tagName === tag && node.nodeType === 1) return node
  for (const child of childrenOf(node)) {
    const hit = firstOf(child, tag)
    if (hit) return hit
  }
  return undefined
}

/** @returns {string} concatenated character data, optionally skipping deleted text */
export function textOf(node, { skipDeleted = true } = {}) {
  let out = ''
  const walk = (el, deleted) => {
    if (el.nodeType === 3 || el.nodeType === 4) { if (!deleted) out += el.data; return }
    if (el.nodeType !== 1) return
    const gone = deleted || (skipDeleted && (el.tagName === 'w:del' || el.tagName === 'w:moveFrom'))
    for (const child of [...el.childNodes]) walk(child, gone)
  }
  walk(node, false)
  return out
}
