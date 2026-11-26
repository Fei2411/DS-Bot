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
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml)\s*[;,]/i
const URI_ATTRIBUTES = new Set(['src', 'href', 'action', 'formaction', 'poster', 'background', 'data', 'codebase'])
const LIST_ATTRIBUTES = new Set(['srcset', 'imagesrcset'])
const DROP_ELEMENTS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'base', 'meta', 'portal'])

function stripUrls(element) {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || name === 'srcdoc' || name === 'ping' || LIST_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name)
      continue
    }
    if (!URI_ATTRIBUTES.has(name)) continue
    const value = attribute.value.trim()
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' && value.startsWith('#')) {
      element.setAttribute(attribute.name, value)
    } else if ((tag === 'img' || tag === 'image') && DATA_IMAGE.test(value)) {
      element.setAttribute(attribute.name, value)
    } else {
      element.removeAttribute(attribute.name)
    }
  }
  if (element.tagName.toLowerCase() === 'a') element.removeAttribute('target')
}

/**
 * Static HTML for the preview iframe, or null when this environment cannot parse HTML.
 * Scripts do not run (the iframe has no allow-scripts); remote and relative resources are
 * stripped here and refused again by HTML_PREVIEW_CSP. Data images and inline styles stay.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function prepareHtmlPreview(text) {
  if (typeof DOMParser !== 'function') return null
  const document = new DOMParser().parseFromString(String(text ?? ''), 'text/html')
  for (const element of [...document.querySelectorAll('*')]) {
    if (DROP_ELEMENTS.has(element.tagName.toLowerCase())) {
      element.remove()
      continue
    }
    stripUrls(element)
  }
  const body = document.body?.innerHTML ?? ''
  const head = document.head?.innerHTML ?? ''
  return `<!doctype html><html><head>${META}${head}</head><body>${body}</body></html>`
}
