import { Unzip, UnzipInflate, strFromU8 } from 'fflate'
import { DomUtils, parseDocument } from 'htmlparser2'
import { marked } from 'marked'
import { fileChunks } from '../../../ds-bot/src/shared/file-chunks.js'
import { acquireTransferHold } from './transfer-hold.ts'

export interface FileRef { name: string; bytes?: number; description?: string; sessionId?: string; attachmentId?: string; seq?: number; index?: number }
export type FilePreview = { kind: 'text' | 'html'; content: string }

const MAX_TEXT = 2 * 1024 * 1024
const MAX_DOCX = 4 * 1024 * 1024
const TOO_LARGE = 'This file is too large to preview'
const UNREADABLE = 'This file cannot be read here'

export function fileTarget(file: FileRef, sessionId?: string) {
  const targetSession = file.sessionId ?? sessionId
  return file.attachmentId !== undefined
    ? { sessionId: targetSession, attachmentId: file.attachmentId }
    : { sessionId: targetSession, seq: file.seq, index: file.index }
}

export function previewFormat(name: string) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  switch (name.slice(dot + 1).toLowerCase()) {
    case 'md': case 'markdown': return 'markdown'
    case 'txt': return 'text'
    case 'html': case 'htm': return 'html'
    case 'docx': return 'docx'
    default: return undefined
  }
}

type Node = ReturnType<typeof parseDocument>['children'][number]
const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const KEEP = new Set('address article aside b blockquote br caption code dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark ol p pre s samp section small strong sub summary sup table tbody td th thead tfoot tr u ul'.split(' '))
const SKIP = new Set('head script style template iframe object embed svg math noscript'.split(' '))
const WINDOWS_1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'

function decodeText(bytes: Uint8Array, html: boolean) {
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe
  if (littleEndian || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let text = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode(view.getUint16(i, littleEndian))
    return bytes.length % 2 === 0 ? text : text + '\uFFFD'
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return strFromU8(bytes.subarray(3))
  if (html) {
    const prefix = strFromU8(bytes.subarray(0, 1024), true)
    const meta = DomUtils.findOne(tag => tag.name === 'meta' && 'charset' in tag.attribs, parseDocument(prefix).children)
    const charset = meta?.attribs.charset.trim().toLowerCase()
    if (charset && /^(?:windows-1252|cp1252|iso-8859-1|latin-?1)$/.test(charset)) {
      return strFromU8(bytes, true).replace(/[\u0080-\u009f]/g, char => WINDOWS_1252[char.charCodeAt(0) - 0x80])
    }
  }
  return strFromU8(bytes)
}

function staticHtml(source: string) {
  function render(node: Node, depth: number): string {
    if (depth > 100) throw new Error(UNREADABLE)
    if (node.type === 'text') return escapeText(node.data)
    if (!DomUtils.isTag(node) || SKIP.has(node.name)) return ''
    if (node.name === 'img') return escapeText(node.attribs.alt ?? '')
    if (node.name === 'br' || node.name === 'hr') return `<${node.name}>`
    const body = node.children.map(child => render(child, depth + 1)).join('')
    return KEEP.has(node.name) ? `<${node.name}>${body}</${node.name}>` : body
  }
  return parseDocument(source).children.map(node => render(node, 0)).join('')
}

function joinBytes(chunks: Uint8Array[], size: number) {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function docxBody(archive: Uint8Array) {
  let xml: string | undefined
  const unzip = new Unzip(file => {
    if (file.name !== 'word/document.xml') return
    if (file.originalSize !== undefined && file.originalSize > MAX_TEXT) throw new Error(TOO_LARGE)
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, data, final) => {
      if (error) throw new Error(UNREADABLE)
      size += data.length
      if (size > MAX_TEXT) throw new Error(TOO_LARGE)
      chunks.push(data)
      if (final) xml = decodeText(joinBytes(chunks, size), false)
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let i = 0; i < archive.length; i += 8192) {
    unzip.push(archive.subarray(i, i + 8192), i + 8192 >= archive.length)
  }
  if (xml === undefined) throw new Error(UNREADABLE)

  const root = parseDocument(xml, { xmlMode: true }).children.find(DomUtils.isTag)
  if (root === undefined || root.name.split(':').pop() !== 'document') throw new Error(UNREADABLE)
  const colon = root.name.indexOf(':')
  const prefix = colon < 0 ? '' : root.name.slice(0, colon + 1)
  const namespace = root.attribs[colon < 0 ? 'xmlns' : `xmlns:${prefix.slice(0, -1)}`]
  if (namespace !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    && namespace !== 'http://purl.oclc.org/ooxml/wordprocessingml/main') throw new Error(UNREADABLE)
  const body = root.children.find(node => DomUtils.isTag(node) && node.name === `${prefix}body`)
  if (body === undefined) throw new Error(UNREADABLE)

  function render(node: Node, depth: number): string {
    if (depth > 100) throw new Error(UNREADABLE)
    if (!DomUtils.isTag(node) || !node.name.startsWith(prefix)) return ''
    const renderChildren = () => node.children.map(child => render(child, depth + 1)).join('')
    switch (node.name.slice(prefix.length)) {
      case 't': return node.children.map(child => child.type === 'text' ? escapeText(child.data) : '').join('')
      case 'br': case 'cr': return '<br>'
      case 'tab': return ' '
      case 'body': case 'r': case 'hyperlink': case 'ins': case 'moveTo': case 'sdt': case 'sdtContent': return renderChildren()
      case 'p': {
        const props = node.children.find(child => DomUtils.isTag(child) && child.name === `${prefix}pPr`)
        const style = props && DomUtils.isTag(props) ? props.children.find(child => DomUtils.isTag(child) && child.name === `${prefix}pStyle`) : undefined
        const heading = style && DomUtils.isTag(style) ? /^heading([1-6])$/i.exec(style.attribs[`${prefix}val`] ?? '') : null
        const tag = heading ? `h${heading[1]}` : 'p'
        return `<${tag}>${renderChildren() || '<br>'}</${tag}>`
      }
      case 'tbl': return `<table><tbody>${renderChildren()}</tbody></table>`
      case 'tr': return `<tr>${renderChildren()}</tr>`
      case 'tc': return `<td>${renderChildren()}</td>`
      default: return ''
    }
  }
  return render(body, 0)
}

export async function readFilePreview(call: (endpoint: string, payload: object) => Promise<unknown>, file: FileRef, sessionId: string | undefined, signal: AbortSignal): Promise<FilePreview> {
  const format = previewFormat(file.name)
  if (format === undefined) throw new Error(UNREADABLE)
  const limit = format === 'docx' ? MAX_DOCX : MAX_TEXT
  if (file.bytes !== undefined && file.bytes > limit) throw new Error(TOO_LARGE)
  const chunks: Uint8Array[] = []
  let size = 0
  const releaseHold = acquireTransferHold()
  try {
    for await (const part of fileChunks(call, fileTarget(file, sessionId))) {
      if (signal.aborted) throw new Error(UNREADABLE)
      size += part.data.length
      if (part.size > limit || size > limit) throw new Error(TOO_LARGE)
      chunks.push(part.data)
    }
  } finally {
    releaseHold()
  }
  const bytes = joinBytes(chunks, size)
  if (format === 'docx') return { kind: 'html', content: docxBody(bytes) }
  const text = decodeText(bytes, format === 'html')
  if (format === 'text') return { kind: 'text', content: text }
  return { kind: 'html', content: staticHtml(format === 'markdown' ? marked.parse(text, { async: false }) : text) }
}
