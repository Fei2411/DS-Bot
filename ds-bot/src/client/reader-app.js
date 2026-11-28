// The Reader App: a workspace Markdown file for reading, with an outline, its source,
// what changed, and a way to turn a selected passage into a revision request that
// goes to the Bot's chat. It never writes a file: the Bot edits, the Reader shows.
import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from './dsh-primitives.js'
import { useArticleImage, useHostBase, useWorkspaceFile } from './side-file-source.js'
import { DiffView, FileEmpty, ModeSwitch, SourceView, StatusLine, diffCount } from './side-file-views.js'
import { headingsIn, outlineOf, sectionAt } from './reading.js'
import { readerParts, revisionMessage, siblingPath } from './side-apps.js'
import { PanelMenu } from './browser-pane.js'
import { ChevronDownIcon, CopyIcon } from './icons.js'
import { reducedMotion, stepMenuFocus, useLinger } from './motion.js'
import { useEscape } from './overlay-hooks.js'
import { writeClipboard } from './dsh-primitives.js'
import { mdLabels, t } from './i18n.js'

// The outline is a column of its own from this panel width; below it, a menu.
export const WIDE_OUTLINE = 640
// A heading counts as being read once it is within this of the scroller's top.
const READ_LINE = 24

/** The outline entries of a rendered article and the tops they sit at. */
export function articleOutline(root) {
  const headings = headingsIn(root)
  return { headings, outline: outlineOf(headings) }
}

// What a refresh keeps of the reading place: the heading it is under and how far below.
export function anchorOf(scroller, headings) {
  const line = scroller.scrollTop + READ_LINE
  const tops = headings.map(node => node.offsetTop)
  const at = sectionAt(tops, line)
  if (at < 0) return { index: -1, text: '', offset: scroller.scrollTop }
  return { index: at, text: headings[at].textContent.trim(), offset: scroller.scrollTop - tops[at] }
}
export function restoreAnchor(scroller, headings, anchor) {
  if (anchor === null || anchor === undefined) return
  if (anchor.index < 0) { scroller.scrollTop = anchor.offset; return }
  const same = headings.findIndex(node => node.textContent.trim() === anchor.text)
  const node = headings[same >= 0 ? same : Math.min(anchor.index, headings.length - 1)]
  scroller.scrollTop = node ? node.offsetTop + anchor.offset : anchor.offset
}

// The heading that precedes a selection, as the section its request names.
export function sectionOfRange(headings, range) {
  let found = ''
  for (const node of headings) {
    if (node.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING || node === range.startContainer || node.contains(range.startContainer)) found = node.textContent.trim()
    else break
  }
  return found
}

function AskCard({ pick, onClose, onAdd, onSend }) {
  const [request, setRequest] = useState('')
  const [leaving, setLeaving] = useState(false)
  const field = useRef(null)
  const box = useRef(null)
  // The pill's spot is clamped for a 28px pill; the open card is far taller, so it
  // re-clamps against its real height once mounted instead of falling off the screen.
  const [top, setTop] = useState(pick.top)
  useLayoutEffect(() => {
    const node = box.current
    if (node) setTop(Math.max(8, Math.min(pick.top, window.innerHeight - node.offsetHeight - 8)))
  }, [pick.top])
  useEffect(() => { field.current?.focus() }, [])
  useEscape(() => onClose(true), true, { priority: -1 })
  const key = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) onSend(request)
    else onAdd(request)
  }
  const excerpt = pick.quote.length > 240 ? `${pick.quote.slice(0, 240)}…` : pick.quote
  return h('div', {
    ref: box,
    className: 'bt-sapp-ask', role: 'dialog', 'aria-label': t('Ask Bot about this passage'), 'data-leaving': leaving || undefined,
    style: { left: `${pick.left}px`, top: `${top}px` },
    onMouseDown: event => event.stopPropagation(),
  },
  h('blockquote', { className: 'bt-sapp-ask-quote' }, excerpt),
  h('textarea', {
    ref: field, className: 'bt-sapp-ask-input', rows: 3, value: request, placeholder: t('What should change?'),
    'aria-label': t('What should change?'), onChange: event => setRequest(event.target.value), onKeyDown: key,
  }),
  h('div', { className: 'bt-sapp-ask-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setLeaving(true); onClose(true) } }, t('Cancel')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onSend(request) }, t('Send')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-sapp-primary', onClick: () => onAdd(request) }, t('Add to chat'))))
}

// The small pill that follows a selection in the article.
function AskPill({ pick, onOpen }) {
  return h('button', {
    type: 'button', className: 'bt-sapp-pill', style: { left: `${pick.left}px`, top: `${pick.top}px` },
    onMouseDown: event => event.preventDefault(), onClick: onOpen,
  }, t('Ask Bot'))
}

// A picture beside the article: its label until the host's bytes arrive, and its label
// again if they never do. The address is an object URL this component owns.
function ReaderImage({ tab, path, alt, version }) {
  const image = useArticleImage(tab, path, version)
  const label = alt === '' ? `[${t('Image')}]` : `[${t('Image')}: ${alt}]`
  if (image.status !== 'ready') {
    return h('p', { className: 'bt-sapp-figure', 'data-state': image.status, title: path }, label)
  }
  return h('p', { className: 'bt-sapp-figure', 'data-state': 'ready' },
    h('img', { src: image.url, alt, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer', draggable: false }))
}

function ReadingBody({ tab, text, revision, scroller, headings, onHeadings, openFile, source, sessionId, actions }) {
  const article = useRef(null)
  const [pick, setPick] = useState(null)
  const [asking, setAsking] = useState(false)
  const measure = () => {
    const box = article.current
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    if (!box || !selection || selection.rangeCount === 0 || selection.isCollapsed) { if (!asking) setPick(null); return }
    const range = selection.getRangeAt(0)
    if (!box.contains(range.commonAncestorContainer)) { if (!asking) setPick(null); return }
    const quote = selection.toString().trim()
    if (quote === '') { if (!asking) setPick(null); return }
    const rect = range.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320))
    const below = rect.bottom + 8
    const top = below > window.innerHeight - 44 ? Math.max(8, rect.top - 36) : below
    setPick({ quote, section: sectionOfRange(headings.current, range), left, top })
  }
  useEffect(() => {
    const hide = () => { if (!asking) setPick(null) }
    const node = scroller.current
    node?.addEventListener('scroll', hide, { passive: true })
    return () => node?.removeEventListener('scroll', hide)
  }, [asking])
  useEffect(() => { setPick(null); setAsking(false) }, [tab.key])
  const send = (request, immediate) => {
    if (!pick) return
    const message = revisionMessage({ displayPath: tab.displayPath, section: pick.section, quote: pick.quote, source, request })
    const done = () => { setPick(null); setAsking(false); window.getSelection()?.removeAllRanges() }
    if (immediate) {
      Promise.resolve(actions.send(sessionId, message)).then(done, error => actions.reportError?.(error, 'reader-send'))
      return
    }
    actions.draftInsert(sessionId, message)
    done()
  }
  const click = (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    const sibling = siblingPath(tab.displayPath, href)
    if (sibling !== null) { openFile(sibling); return }
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
  }
  const parts = useMemo(() => readerParts(text, tab.displayPath), [text, tab.displayPath])
  useLayoutEffect(() => { onHeadings(article.current) })
  return h('div', { className: 'bt-sapp-article', ref: article, onMouseUp: () => setTimeout(measure, 0), onKeyUp: measure, onClick: click },
    parts.map((part, index) => (part.kind === 'image'
      ? h(ReaderImage, { key: `${tab.key}:${index}:${part.path}`, tab, path: part.path, alt: part.alt, version: revision })
      : h(MarkdownText, { key: `${index}:text`, text: part.text, labels: mdLabels() }))),
    pick && !asking ? createPortal(h(AskPill, { pick, onOpen: () => setAsking(true) }), document.body) : null,
    pick && asking ? createPortal(h(AskCard, {
      pick, onClose: () => { setAsking(false); setPick(null) },
      onAdd: request => send(request, false), onSend: request => send(request, true),
    }), document.body) : null)
}

export function ReaderView({ tab, mode, onMode, visible, actions, openFile }) {
  const [outline, setOutline] = useState([])
  const [current, setCurrent] = useState(-1)
  const [menu, setMenu] = useState(false)
  const [wide, setWide] = useState(false)
  const [shown, leaving] = useLinger(menu, 120)
  const scroller = useRef(null)
  const headings = useRef([])
  const anchor = useRef(null)
  const trigger = useRef(null)
  const pop = useRef(null)
  const box = useRef(null)
  const file = useWorkspaceFile(tab, visible)
  const host = useHostBase(tab, file.revision, mode === 'diff')
  const ready = typeof file.text === 'string'
  const reading = mode === 'preview'
  useEscape(() => { setMenu(false); trigger.current?.focus() }, menu)
  // The outline column needs the room; this follows the panel as it is dragged.
  useEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => setWide(node.clientWidth >= WIDE_OUTLINE))
    observer.observe(node)
    setWide(node.clientWidth >= WIDE_OUTLINE)
    return () => observer.disconnect()
  }, [])
  // The place being read is kept across a refresh: remembered before the text changes,
  // put back after it has drawn.
  const remember = () => { if (scroller.current) anchor.current = anchorOf(scroller.current, headings.current) }
  const lastText = useRef(file.text)
  if (lastText.current !== file.text) { remember(); lastText.current = file.text }
  const onHeadings = (root) => {
    if (!root) return
    const found = articleOutline(root)
    headings.current = found.headings
    setOutline(prev => (prev.length === found.outline.length && prev.every((entry, index) => entry.text === found.outline[index].text && entry.depth === found.outline[index].depth) ? prev : found.outline))
    if (anchor.current !== null && scroller.current) { restoreAnchor(scroller.current, found.headings, anchor.current); anchor.current = null }
  }
  const follow = () => {
    const node = scroller.current
    if (!node) return
    setCurrent(sectionAt(headings.current.map(item => item.offsetTop), node.scrollTop + READ_LINE))
  }
  useEffect(() => { follow() }, [outline])
  const toSection = (index) => {
    const node = headings.current[index]
    if (!node || !scroller.current) return
    scroller.current.scrollTo({ top: node.offsetTop - 8, behavior: reducedMotion() ? 'auto' : 'smooth' })
    setMenu(false)
  }
  const copyPath = () => { void writeClipboard(tab.displayPath) }
  const items = [{ key: 'copy', icon: CopyIcon, label: t('Copy path'), onPick: copyPath }]
  const sectionLabel = current >= 0 && outline[current] ? outline[current].text : t('Contents')
  const list = outline.length > 0
  let body
  if (!ready) {
    body = h(FileEmpty, { status: file.status, path: tab.displayPath, message: file.error?.message, onRetry: file.refresh })
  } else if (mode === 'source') {
    body = h(SourceView, { text: file.text, label: t('Source of {path}', { path: tab.displayPath }) })
  } else if (mode === 'diff') {
    body = h(DiffView, { file, host, onReviewed: file.markReviewed })
  } else {
    body = h('div', { className: 'bt-sapp-reader', 'data-wide': wide && list ? '' : undefined },
      wide && list ? h('nav', { className: 'bt-sapp-outline', 'aria-label': t('Contents') },
        outline.map((entry, index) => h('button', {
          key: index, type: 'button', className: 'bt-sapp-outline-item', 'data-depth': entry.depth || undefined, 'aria-current': index === current || undefined, onClick: () => toSection(index),
        }, entry.text))) : null,
      h('div', { className: 'bt-sapp-scroll', ref: scroller, onScroll: follow, tabIndex: 0, role: 'region', 'aria-label': t('Reading {path}', { path: tab.displayPath }) },
        h(ReadingBody, { tab, text: file.text, revision: file.revision, scroller, headings, onHeadings, openFile, source: file.text, sessionId: tab.sessionId, actions })))
  }
  return h('div', { className: 'bt-panel-view bt-sapp', 'data-app': 'reader', ref: box },
    h('div', { className: 'bt-sapp-bar' },
      reading && !wide && list ? h('span', { className: 'bt-pmenu bt-sapp-contents' },
        h('button', {
          ref: trigger, type: 'button', className: 'bt-sapp-contents-btn', 'aria-haspopup': 'menu', 'aria-expanded': menu,
          'aria-label': t('Sections in this article: {section}', { section: sectionLabel }), title: sectionLabel, onClick: () => setMenu(value => !value),
          onKeyDown: (event) => { if (event.key === 'ArrowDown' && !menu) { event.preventDefault(); setMenu(true) } },
        }, h('span', { className: 'bt-sapp-contents-label' }, sectionLabel), h(ChevronDownIcon)),
        shown ? h('div', {
          ref: pop, className: 'bt-menu bt-sapp-menu', role: 'menu', 'data-leaving': leaving || undefined, 'aria-label': t('Contents'),
          onKeyDown: event => stepMenuFocus(pop.current, event, trigger.current),
        }, outline.map((entry, index) => h('button', {
          key: index, type: 'button', role: 'menuitem', 'data-depth': entry.depth || undefined, 'aria-current': index === current || undefined, onClick: () => toSection(index),
        }, h('span', { className: 'bt-menu-label' }, entry.text)))) : null) : null,
      h(ModeSwitch, { app: 'reader', mode, onMode, changes: diffCount(file, host) }),
      h(PanelMenu, { items, className: 'bt-icon-btn', 'aria-label': t('More') })),
    h(StatusLine, { file, path: tab.displayPath }),
    h('div', { className: 'bt-sapp-body' }, body))
}
