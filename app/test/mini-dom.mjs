// Minimal zero-dependency DOM host sufficient to mount real React 19 (`react-dom/client`
// `createRoot` + `flushSync` / `act`) in `app/test/*.test.mjs` without pulling `jsdom`
// from `ds-bot/dev/harness` (which is not installed in the standalone `Desktop app profile` CI job).

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'multiple', 'hidden', 'open'])

const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function kebabCase(name) {
  return name.startsWith('--') ? name : name.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)
}

function serializeStyle(style) {
  const parts = []
  for (const [key, value] of Object.entries(style)) {
    if (key === '_props' || typeof value === 'function') continue
    if (value === undefined || value === null || value === '') continue
    parts.push(`${kebabCase(key)}: ${value}`)
  }
  if (style._props) {
    for (const [key, value] of style._props) {
      if (value !== undefined && value !== null && value !== '') parts.push(`${key}: ${value}`)
    }
  }
  return parts.join('; ')
}

function makeStyle() {
  const props = new Map()
  return {
    _props: props,
    setProperty(name, value) {
      if (value === undefined || value === null || value === '') props.delete(String(name))
      else props.set(String(name), String(value))
    },
    removeProperty(name) { props.delete(String(name)) },
    getPropertyValue(name) { return props.get(String(name)) ?? '' },
  }
}

class MiniEvent {
  constructor(type, options = {}) {
    this.type = type
    this.bubbles = options.bubbles !== false
    this.cancelable = options.cancelable !== false
    this.composed = options.composed === true
    this.detail = options.detail
    this.target = null
    this.currentTarget = null
    this.defaultPrevented = false
    this.cancelBubble = false
    this.timeStamp = Date.now()
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this.cancelBubble = true }
  stopImmediatePropagation() { this.cancelBubble = true; this.immediateStopped = true }
  composedPath() { return this._path ?? [] }
}

class EventTargetMini {
  constructor() { this._miniListeners = new Map() }
  addEventListener(type, listener, options = {}) {
    if (typeof listener !== 'function' && (listener === null || typeof listener?.handleEvent !== 'function')) return
    const capture = options === true || options?.capture === true
    const key = `${type}:${capture ? 1 : 0}`
    if (!this._miniListeners.has(key)) this._miniListeners.set(key, new Set())
    this._miniListeners.get(key).add(listener)
  }
  removeEventListener(type, listener, options = {}) {
    const capture = options === true || options?.capture === true
    this._miniListeners.get(`${type}:${capture ? 1 : 0}`)?.delete(listener)
  }
  dispatchEvent(event) {
    if (event.target == null) event.target = this
    const path = []
    for (let node = event.target; node; node = node.parentNode) path.push(node)
    if (event.target?.ownerDocument && !path.includes(event.target.ownerDocument)) path.push(event.target.ownerDocument)
    event._path = path
    const invoke = (target, capture) => {
      event.currentTarget = target
      const listeners = [...(target._miniListeners?.get(`${event.type}:${capture ? 1 : 0}`) ?? [])]
      for (const listener of listeners) {
        if (event.immediateStopped) break
        if (typeof listener === 'function') listener.call(target, event)
        else listener.handleEvent(event)
      }
    }
    for (const target of [...path].reverse()) {
      if (target === event.target) continue
      invoke(target, true)
      if (event.cancelBubble) return !event.defaultPrevented
    }
    invoke(event.target, true)
    invoke(event.target, false)
    if (event.bubbles) {
      for (const target of path.slice(1)) {
        if (event.cancelBubble) break
        invoke(target, false)
      }
    }
    event.currentTarget = null
    return !event.defaultPrevented
  }
}

class NodeMini extends EventTargetMini {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
  static DOCUMENT_FRAGMENT_NODE = 11

  constructor(nodeType, ownerDocument) {
    super()
    this.nodeType = nodeType
    this.ownerDocument = ownerDocument
    this.parentNode = null
    this.childNodes = []
  }

  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }

  get nextSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index >= 0 ? (this.parentNode.childNodes[index + 1] ?? null) : null
  }

  get previousSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index > 0 ? (this.parentNode.childNodes[index - 1] ?? null) : null
  }

  appendChild(child) {
    if (child.nodeType === 11) {
      for (const item of [...child.childNodes]) this.appendChild(item)
      return child
    }
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child, ref) {
    if (ref == null) return this.appendChild(child)
    if (child.nodeType === 11) {
      for (const item of [...child.childNodes]) this.insertBefore(item, ref)
      return child
    }
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = this.childNodes.indexOf(ref)
    if (index === -1) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  contains(other) {
    for (let current = other; current; current = current.parentNode) {
      if (current === this) return true
    }
    return false
  }
}

class TextMini extends NodeMini {
  constructor(data, ownerDocument) {
    super(3, ownerDocument)
    this._data = String(data ?? '')
  }

  get nodeValue() { return this._data }
  set nodeValue(value) { this._data = String(value ?? '') }
  get data() { return this._data }
  set data(value) { this._data = String(value ?? '') }
  get textContent() { return this._data }
  set textContent(value) { this._data = String(value ?? '') }
}

class CommentMini extends NodeMini {
  constructor(data, ownerDocument) {
    super(8, ownerDocument)
    this.data = String(data ?? '')
  }

  get textContent() { return '' }
}

class FragmentMini extends NodeMini {
  constructor(ownerDocument) {
    super(11, ownerDocument)
  }
}

function matchesSimple(element, selector) {
  for (const part of String(selector).split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('.')) {
      if (element.className.split(/\s+/).includes(trimmed.slice(1))) return true
    } else if (trimmed.startsWith('#')) {
      if (element.id === trimmed.slice(1)) return true
    } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1)
      const eq = inner.indexOf('=')
      if (eq === -1) {
        if (element.hasAttribute(inner)) return true
      } else {
        const key = inner.slice(0, eq).trim()
        const val = inner.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
        if (element.getAttribute(key) === val) return true
      }
    } else if (element.localName === trimmed.toLowerCase()) {
      return true
    }
  }
  return false
}

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node._data)
  if (node.nodeType === 8) return `<!--${node.data}-->`
  if (node.nodeType !== 1) return ''
  const tag = node.localName
  let attrs = ''
  const entries = new Map(node._attrs)
  const styleText = serializeStyle(node.style)
  if (styleText !== '' && !entries.has('style')) entries.set('style', styleText)
  for (const [key, value] of entries) {
    if (value === '' && BOOL_ATTRS.has(key)) attrs += ` ${key}`
    else attrs += ` ${key}="${escapeAttr(value)}"`
  }
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`
  return `<${tag}${attrs}>${node.childNodes.map(serializeNode).join('')}</${tag}>`
}

class ElementMini extends NodeMini {
  constructor(tag, ownerDocument, namespaceURI = 'http://www.w3.org/1999/xhtml') {
    super(1, ownerDocument)
    this.namespaceURI = namespaceURI
    this.localName = String(tag).toLowerCase()
    this.tagName = namespaceURI === 'http://www.w3.org/1999/xhtml' ? this.localName.toUpperCase() : String(tag)
    this.nodeName = this.tagName
    this._attrs = new Map()
    this.style = makeStyle()
    this.dataset = {}
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const name of names) set.add(name)
        this.className = [...set].join(' ')
      },
      remove: (...names) => {
        const drop = new Set(names)
        this.className = this.className.split(/\s+/).filter(n => n && !drop.has(n)).join(' ')
      },
      contains: name => this.className.split(/\s+/).includes(name),
    }
  }

  get className() { return this._attrs.get('class') ?? '' }
  set className(value) {
    const str = String(value ?? '')
    if (str === '') this._attrs.delete('class')
    else this._attrs.set('class', str)
  }

  get id() { return this._attrs.get('id') ?? '' }
  set id(value) { this.setAttribute('id', value) }
  get type() { return this._attrs.get('type') ?? '' }
  set type(value) { this.setAttribute('type', value) }
  get href() { return this._attrs.get('href') ?? '' }
  set href(value) { this.setAttribute('href', value) }
  get src() { return this._attrs.get('src') ?? '' }
  set src(value) { this.setAttribute('src', value) }
  get title() { return this._attrs.get('title') ?? '' }
  set title(value) { this.setAttribute('title', value) }
  get hidden() { return this._attrs.has('hidden') }
  set hidden(value) { if (value) this._attrs.set('hidden', ''); else this._attrs.delete('hidden') }
  get disabled() { return this._attrs.has('disabled') }
  set disabled(value) { if (value) this._attrs.set('disabled', ''); else this._attrs.delete('disabled') }
  get checked() { return this._attrs.has('checked') }
  set checked(value) { if (value) this._attrs.set('checked', ''); else this._attrs.delete('checked') }
  get defaultChecked() { return this._attrs.has('checked') }
  set defaultChecked(value) { if (value) this._attrs.set('checked', ''); else this._attrs.delete('checked') }
  get value() { return this._value ?? this._attrs.get('value') ?? '' }
  set value(value) { this._value = String(value ?? '') }
  get defaultValue() { return this._attrs.get('value') ?? '' }
  set defaultValue(value) { this.setAttribute('value', value) }

  setAttribute(key, value) { this._attrs.set(String(key), String(value ?? '')) }
  setAttributeNS(_ns, key, value) { this._attrs.set(String(key), String(value ?? '')) }
  getAttribute(key) { return this._attrs.has(String(key)) ? this._attrs.get(String(key)) : null }
  removeAttribute(key) { this._attrs.delete(String(key)) }
  hasAttribute(key) { return this._attrs.has(String(key)) }

  get textContent() { return this.childNodes.map(child => child.textContent).join('') }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    const str = String(value ?? '')
    if (str !== '') this.appendChild(new TextMini(str, this.ownerDocument))
  }

  get innerHTML() { return this.childNodes.map(serializeNode).join('') }
  set innerHTML(value) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value) this.appendChild(new TextMini(String(value), this.ownerDocument))
  }

  get outerHTML() { return serializeNode(this) }
  matches(selector) { return matchesSimple(this, selector) }
  closest(selector) {
    for (let current = this; current && current.nodeType === 1; current = current.parentNode) {
      if (matchesSimple(current, selector)) return current
    }
    return null
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }

  querySelector(selector) {
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (matchesSimple(child, selector)) return child
        const hit = walk(child)
        if (hit) return hit
      }
      return null
    }
    return walk(this)
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (matchesSimple(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

class HTMLIFrameElementMini extends ElementMini {}
class SVGElementMini extends ElementMini {}

class DocumentMini extends NodeMini {
  constructor() {
    super(9, null)
    this.ownerDocument = this
    this.activeElement = null
    this.documentElement = new ElementMini('html', this)
    this.head = new ElementMini('head', this)
    this.body = new ElementMini('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.childNodes.push(this.documentElement)
    this.defaultView = null
  }

  createElement(tag) { return new ElementMini(tag, this) }
  createElementNS(ns, tag) { return new ElementMini(tag, this, ns) }
  createTextNode(data) { return new TextMini(data, this) }
  createComment(data) { return new CommentMini(data, this) }
  createDocumentFragment() { return new FragmentMini(this) }
  querySelector(selector) { return this.documentElement.querySelector(selector) }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector) }
}

export function installMiniDom() {
  const document = new DocumentMini()
  const Event = class Event extends MiniEvent {}
  const CustomEvent = class CustomEvent extends MiniEvent {}
  const MutationObserver = class MutationObserver { observe() {} disconnect() {} takeRecords() { return [] } }
  const window = Object.assign(new EventTargetMini(), {
    document,
    navigator: { userAgent: 'node-mini-dom' },
    location: { href: 'http://localhost/', protocol: 'http:' },
    HTMLElement: ElementMini,
    HTMLIFrameElement: HTMLIFrameElementMini,
    SVGElement: SVGElementMini,
    Element: ElementMini,
    Node: NodeMini,
    Text: TextMini,
    Comment: CommentMini,
    Document: DocumentMini,
    DocumentFragment: FragmentMini,
    Event,
    CustomEvent,
    MutationObserver,
    getComputedStyle: () => ({}),
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame: id => clearTimeout(id),
  })
  document.defaultView = window
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: ElementMini,
    HTMLIFrameElement: HTMLIFrameElementMini,
    SVGElement: SVGElementMini,
    Element: ElementMini,
    Node: NodeMini,
    Text: TextMini,
    Comment: CommentMini,
    Document: DocumentMini,
    DocumentFragment: FragmentMini,
    Event,
    CustomEvent,
    MutationObserver,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
  })) {
    if (globalThis[key] === undefined) globalThis[key] = value
  }
  return { window, document }
}
