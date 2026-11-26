// Network-isolated HTML document preview. The preview never runs scripts and serves no
// sibling files, so the document is reduced to static markup before it enters a sandboxed
// iframe; the CSP is the second, browser-enforced layer.

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
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
const URI_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'xml:base', 'action', 'formaction', 'poster', 'background', 'data', 'codebase', 'usemap', 'profile', 'manifest', 'longdesc'])
const LIST_ATTRIBUTES = new Set(['srcset', 'imagesrcset'])
const DROP_ELEMENTS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'base', 'meta', 'portal', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard'])

function stripUrls(element) {
  let blocked = false
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || name === 'srcdoc' || name === 'ping' || LIST_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name)
      blocked = blocked || name === 'srcdoc' || LIST_ATTRIBUTES.has(name)
      continue
    }
    if (!URI_ATTRIBUTES.has(name)) continue
    const value = attribute.value.trim()
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' && name === 'href' && value.startsWith('#')) {
      element.setAttribute(attribute.name, value)
    } else if ((tag === 'img' || tag === 'image') && (name === 'src' || name === 'href') && DATA_IMAGE.test(value)) {
      element.setAttribute(attribute.name, value)
    } else {
      element.removeAttribute(attribute.name)
      blocked = true
    }
  }
  if (element.tagName.toLowerCase() === 'a') element.removeAttribute('target')
  return blocked
}

/**
 * Static HTML for the preview iframe, or null when this environment cannot parse HTML.
 * Scripts do not run (the iframe has no allow-scripts); remote and relative resources are
 * stripped here and refused again by HTML_PREVIEW_CSP. Data images and inline styles stay.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function prepareHtmlPreview(text, notice = '') {
  if (typeof DOMParser !== 'function') return null
  const document = new DOMParser().parseFromString(String(text ?? ''), 'text/html')
  let blocked = false
  for (const element of [...document.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase()
    if (DROP_ELEMENTS.has(tag)) {
      blocked = blocked || tag !== 'meta' || element.getAttribute('http-equiv')?.toLowerCase() === 'refresh'
      element.remove()
      continue
    }
    blocked = stripUrls(element) || blocked
  }
  const body = document.body?.innerHTML ?? ''
  const head = document.head?.innerHTML ?? ''
  const warning = blocked && notice
    ? `<div style="box-sizing:border-box;margin:8px;padding:8px 10px;border:1px solid color-mix(in srgb, CanvasText 20%, transparent);border-radius:8px;background:color-mix(in srgb, CanvasText 5%, Canvas);color:CanvasText;font:13px/1.4 system-ui,sans-serif">${escapeHtml(notice)}</div>`
    : ''
  return `<!doctype html><html><head>${META}${head}</head><body>${warning}${body}</body></html>`
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
