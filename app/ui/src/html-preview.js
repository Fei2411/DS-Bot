// Network-isolated HTML document preview. The preview never runs scripts and serves no
// sibling files, so the document is reduced to static markup before it enters a sandboxed
// iframe; the CSP and the shell's subframe-navigation guard are the layers behind it.
import { themeCssLoadsRemoteFiles, themeCssValueFetches, themeCssWithoutImports } from '../../../ds-bot/src/shared/theme-css.js'
import { sanitizeStyleDeclarations, sanitizeUserSheet } from '../../../ds-bot/src/client/theme-css.js'

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif)\s*[;,]/i
const previewCssUrl = content => content.startsWith('#') || DATA_IMAGE.test(content)
const URI_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'xml:base', 'action', 'formaction', 'poster', 'background', 'data', 'codebase', 'usemap', 'profile', 'manifest', 'longdesc'])
const LIST_ATTRIBUTES = new Set(['srcset', 'imagesrcset'])
const SVG_URL_ATTRIBUTES = new Set(['filter', 'fill', 'stroke', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor'])
const DROP_ELEMENTS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'base', 'meta', 'portal', 'template', 'math', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'noscript'])
const MAX_PASSES = 8

function parseHtml(text) {
  if (typeof DOMParser !== 'function') return null
  return new DOMParser().parseFromString(text, 'text/html')
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plainTextPreview(text) {
  return {
    html: `<!doctype html><html><head>${META}</head><body><pre>${escapeHtml(text)}</pre></body></html>`,
    blocked: true,
  }
}

function cleanInlineStyle(element, view) {
  const original = element.getAttribute('style')
  if (original === null) return false
  if (!themeCssLoadsRemoteFiles(original, previewCssUrl)) return false
  const style = element.style
  if (!style || typeof style.getPropertyValue !== 'function') {
    element.removeAttribute('style')
    return true
  }
  sanitizeStyleDeclarations(style, previewCssUrl)
  const cleaned = typeof style.cssText === 'string' ? style.cssText : ''
  if (cleaned.trim() === '' || themeCssLoadsRemoteFiles(cleaned, previewCssUrl)) element.removeAttribute('style')
  else element.setAttribute('style', cleaned)
  return true
}

function cleanStyleElement(element, view) {
  const original = element.textContent ?? ''
  if (!themeCssLoadsRemoteFiles(original, previewCssUrl)) return false
  const Sheet = view?.CSSStyleSheet ?? globalThis.CSSStyleSheet
  if (typeof Sheet !== 'function') {
    element.remove()
    return true
  }
  let sheet
  try {
    sheet = new Sheet()
    sheet.replaceSync(themeCssWithoutImports(original))
  } catch {
    element.remove()
    return true
  }
  sanitizeUserSheet(sheet, view, previewCssUrl)
  const cleaned = [...(sheet.cssRules ?? [])].map(rule => rule.cssText).join('\n')
  if (cleaned.trim() === '' || themeCssLoadsRemoteFiles(cleaned, previewCssUrl)) element.remove()
  else element.textContent = cleaned
  return true
}

function stripUrls(element) {
  let blocked = false
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || name === 'srcdoc' || name === 'ping' || name === 'attributionsrc' || LIST_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name)
      blocked = true
      continue
    }
    if (name === 'style') {
      blocked = cleanInlineStyle(element, element.ownerDocument?.defaultView ?? globalThis) || blocked
      continue
    }
    if (SVG_URL_ATTRIBUTES.has(name)) {
      if (themeCssValueFetches(attribute.value, previewCssUrl)) {
        element.removeAttribute(attribute.name)
        blocked = true
      }
      continue
    }
    if (!URI_ATTRIBUTES.has(name)) continue
    const value = attribute.value.trim()
    const tag = element.tagName.toLowerCase()
    const fragment = (name === 'href' || name === 'xlink:href') && value.startsWith('#')
    const rasterImage = DATA_IMAGE.test(value) && (
      (tag === 'img' && name === 'src')
      || (tag === 'image' && (name === 'href' || name === 'xlink:href'))
    )
    if (fragment || rasterImage) element.setAttribute(attribute.name, value)
    else {
      element.removeAttribute(attribute.name)
      blocked = true
    }
  }
  if (element.tagName.toLowerCase() === 'a') element.removeAttribute('target')
  return blocked
}

function ownCspMeta(element) {
  return element.getAttribute('http-equiv')?.trim().toLowerCase() === 'content-security-policy'
    && element.getAttribute('content') === HTML_PREVIEW_CSP
}

function sanitizeDocument(document) {
  let blocked = false
  for (const element of [...document.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase()
    if (DROP_ELEMENTS.has(tag)) {
      if (tag !== 'meta') blocked = true
      else if (!ownCspMeta(element) && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') blocked = true
      element.remove()
      continue
    }
    blocked = stripUrls(element) || blocked
    if (tag === 'style') blocked = cleanStyleElement(element, document.defaultView ?? globalThis) || blocked
  }
  const head = document.head
  if (head) {
    const meta = document.createElement('meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', HTML_PREVIEW_CSP)
    head.insertBefore(meta, head.firstChild)
  }
  return blocked
}

/**
 * Static HTML for the preview iframe, or null when this environment cannot parse HTML.
 * Scripts do not run (the iframe has no allow-scripts); remote and relative resources are
 * stripped here and refused again by HTML_PREVIEW_CSP. Raster data images, inline styles
 * without external resources, and same-document fragments stay.
 *
 * The serialized result is parsed and sanitized repeatedly until it stops changing. That
 * closes double-parse mutation gaps: markup that only becomes dangerous when the iframe
 * parses it is removed on the next pass, and a document that never reaches a fixed point
 * falls back to plain text.
 *
 * @param {string} text
 * @returns {{ html: string, blocked: boolean } | null}
 */
export function prepareHtmlPreview(text) {
  if (typeof DOMParser !== 'function') return null
  const input = String(text ?? '')
  let current = input
  let blocked = false
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let document
    try {
      document = parseHtml(current)
    } catch {
      return plainTextPreview(input)
    }
    if (!document?.documentElement) return plainTextPreview(input)
    blocked = sanitizeDocument(document) || blocked
    const output = `<!doctype html>${document.documentElement.outerHTML}`
    if (output === current) return { html: output, blocked }
    current = output
  }
  return plainTextPreview(input)
}
