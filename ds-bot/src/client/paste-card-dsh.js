// Plugin-only paste-card wiring for DSH's contenteditable composer and attachment rail.
// Shared PasteCard / PASTE_LIMIT / foldPastedText / pastedName / PASTE_CSS live in `paste-card.js`.
// Never imported by the desktop app (`app/ui/src/main.js`).
import { createElement as h, useEffect, useRef } from 'react'
import { PASTE_LIMIT, PasteCard, blockLives, foldPastedText, pasteLinks, pastedName, putBackText } from './paste-card.js'

export { PASTE_LIMIT, PasteCard, blockLives, foldPastedText, pasteLinks, pastedName, putBackText }

const NO_BLOCKS = []
const NO_IDS = []
// A card whose attachment never arrives gives its text back to the box after this
// long, so a refused upload never swallows the paste.
const ORPHAN_MS = 3000

// The shell's attachment rail lists draft files in the same order as their ids.
// File cards wear the file name as their title; an image tile wears it as the img alt.
function composerLabels(root) {
  const group = root.querySelector('[data-slot="conversation.input.attachments"] [role="group"]')
  if (group === null) return []
  return [...group.children].map((item) => {
    const alt = item.querySelector('img[alt]')?.getAttribute('alt') ?? ''
    if (alt !== '') return alt
    return item.querySelector('[title]')?.getAttribute('title') ?? ''
  })
}

// Hand a folded paste to the shell's own file input, the one "+ → Add files" opens, and
// keep a card for it. Returns null when the paste is short, carries a file of its own, or
// the composer takes no files: then the shell's normal paste is the whole answer.
export function handOffPaste({ event, card, sessionId, actions }) {
  if ((event.clipboardData?.files?.length ?? 0) > 0) return null
  const kept = foldPastedText(event.clipboardData?.getData('text/plain') ?? '')
  if (kept === null) return null
  const input = card.querySelector('input[type=file]')
  if (input === null || input === undefined) return null
  const file = new File([kept], pastedName(kept), { type: 'text/plain' })
  event.preventDefault()
  event.stopPropagation()
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  actions.addPaste(sessionId, kept, file.name)
  return file.name
}

const isEditableOnly = records => records.length > 0 && records.every((record) => {
  const target = record.target
  const el = target?.nodeType === 1 ? target : target?.parentElement
  return typeof el?.closest === 'function' && el.closest('[contenteditable=true]') !== null
})

// The cards of the pastes still in this chat, above the composer.
export function PasteDock({ sessionId, inputActions, useUi, useInput, actions }) {
  const blocks = useUi(state => state.paste?.[sessionId]) ?? NO_BLOCKS
  const draftRef = useRef('')
  useInput?.((state) => { draftRef.current = state.draft ?? ''; return null })
  if (blocks.length === 0) return null
  const drop = (block) => {
    if (block.attachmentId && typeof inputActions?.removeAttachment === 'function') inputActions.removeAttachment(block.attachmentId)
    actions.removePaste(sessionId, [block.id])
  }
  return h('div', { className: 'bt-paste-dock' }, blocks.map(block => h(PasteCard, {
    key: block.id, text: block.text,
    onPutBack: () => { if (putBackText({ block, inputActions, draft: draftRef.current })) actions.removePaste(sessionId, [block.id]) },
    onRemove: () => drop(block),
  })))
}

// The composer's paste listener and the bookkeeping that ties a card to the shell's own
// attachment for it. It draws nothing: it sits beside the "+" to find that card.
export function PasteGuard({ sessionId, inputActions, useInput, useUi, actions }) {
  const anchor = useRef(null)
  const blocks = useUi(state => state.paste?.[sessionId]) ?? NO_BLOCKS
  const idsRef = useRef(NO_IDS)
  const idsKey = useInput?.((state) => {
    const list = state.attachmentIds ?? NO_IDS
    idsRef.current = list
    return list.length === 0 ? '' : list.join('\0')
  }) ?? ''
  const ids = idsRef.current
  const draftRef = useRef('')
  useInput?.((state) => { draftRef.current = state.draft ?? ''; return null })
  const latest = useRef({ blocks, ids })
  latest.current = { blocks, ids }
  // Bind a waiting card only when its own file shows up in the rail. A file the user
  // attaches while the card waits keeps its id, so dismissing the card cannot delete it.
  // The rail draws after the id lands, and again while the file uploads.
  useEffect(() => {
    if (!blocks.some(block => block.attachmentId === null)) return undefined
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const sync = (records) => {
      if (Array.isArray(records) && isEditableOnly(records)) return
      const { blocks: now, ids: nowIds } = latest.current
      if (!now.some(block => block.attachmentId === null)) return
      const links = pasteLinks(now, nowIds, composerLabels(card))
      if (links.length > 0) actions.linkPastes(sessionId, links)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(card, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [idsKey, blocks])
  const shown = useRef(new Set())
  useEffect(() => {
    const stale = latest.current.blocks.filter(block => block.attachmentId !== null && !latest.current.ids.includes(block.attachmentId))
    if (stale.length > 0) actions.unlinkPastes(sessionId, stale.map(block => block.id))
  }, [sessionId])
  useEffect(() => {
    const nowIds = latest.current.ids
    const gone = latest.current.blocks.filter(block => !blockLives(block, nowIds) && shown.current.has(block.attachmentId))
    for (const id of nowIds) shown.current.add(id)
    if (gone.length > 0) actions.removePaste(sessionId, gone.map(block => block.id))
  }, [idsKey])
  useEffect(() => {
    const waiting = blocks.filter(block => block.attachmentId === null)
    if (waiting.length === 0) return undefined
    const timer = setTimeout(() => {
      let currentDraft = draftRef.current
      for (const block of waiting) {
        const now = latest.current.blocks.find(item => item.id === block.id)
        if (now === undefined || now.attachmentId !== null) continue
        if (putBackText({ block: now, inputActions, draft: currentDraft })) currentDraft = `${currentDraft}${now.text}`
        actions.removePaste(sessionId, [block.id])
      }
    }, ORPHAN_MS)
    return () => clearTimeout(timer)
  }, [blocks])
  useEffect(() => {
    const names = new Set()
    for (const block of blocks) {
      if (block.attachmentId !== null && block.name) names.add(block.name)
    }
    if (names.size === 0) return undefined
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const mark = (records) => {
      if (Array.isArray(records) && isEditableOnly(records)) return
      const scope = card.querySelector('[data-slot="conversation.input.attachments"]') ?? card
      for (const node of scope.querySelectorAll('[title]')) {
        if (names.has(node.getAttribute('title')) && !node.hasAttribute('data-bt-paste')) {
          node.setAttribute('data-bt-paste', '')
        }
      }
    }
    mark()
    const observer = new MutationObserver(mark)
    observer.observe(card, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [blocks, idsKey])
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const onPaste = (event) => { handOffPaste({ event, card, sessionId, actions }) }
    card.addEventListener('paste', onPaste, true)
    return () => card.removeEventListener('paste', onPaste, true)
  }, [sessionId])
  return h('span', { ref: anchor, className: 'bt-paste-guard', 'aria-hidden': true })
}

export const DSH_PASTE_CSS = `[data-composer-card] [data-bt-paste]{display:none!important}`
