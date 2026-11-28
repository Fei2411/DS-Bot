import { createElement as h } from 'react'
import { TextIcon } from './icons.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// A long paste lands in the box as a card, not as a wall of text (#256). The text
// travels as the composer's own file attachment, so a send carries it whole whether
// the card is opened or not; the card's buttons only put the text back into the box
// or drop the paste.
// Shared pure helpers, PasteCard, and PASTE_CSS live here; plugin-only DSH DOM
// wiring (PasteGuard, PasteDock, handOffPaste) lives in `paste-card-dsh.js`.

// Longer than this and the paste folds. It is where the transcript starts folding a
// message, so "long" means the same in the box and in the chat.
export const PASTE_LIMIT = 1500

// The kept text of a paste that is long enough to fold, else null.
export const foldPastedText = text => (typeof text === 'string' && text.length > PASTE_LIMIT ? text : null)

// The file a fold becomes: the shell's attachment path carries it whole, and this name
// is what both the card and the sent message show.
export const pastedName = text => `Pasted text (${text.length} characters).txt`

// A card still backed by an attachment, or still waiting for one.
export const blockLives = (block, ids) => block.attachmentId === null || ids.includes(block.attachmentId)

// Waiting cards bind to the attachments whose labels are those cards' own file names.
// A rail that has not caught up has a different count; pairing it early would claim
// a file the user added while the card was waiting.
export function pasteLinks(blocks, ids, labels) {
  if (labels.length !== ids.length) return []
  const taken = new Set()
  for (const block of blocks) if (block.attachmentId !== null) taken.add(block.attachmentId)
  const links = []
  for (const block of blocks) {
    if (block.attachmentId !== null || !block.name) continue
    const index = labels.findIndex((label, i) => label === block.name && !taken.has(ids[i]))
    if (index === -1) continue
    taken.add(ids[index])
    links.push({ blockId: block.id, attachmentId: ids[index] })
  }
  return links
}

// Put a card's text back at the caret. A draft that moved under the caret falls back
// to setting the whole draft, so the text is never lost.
export function putBackText({ block, inputActions, draft = '' }) {
  const text = block?.text ?? ''
  if (text === '' || !inputActions) return false
  if (block.attachmentId && typeof inputActions.removeAttachment === 'function') inputActions.removeAttachment(block.attachmentId)
  if (typeof inputActions.insertText === 'function' && inputActions.insertText(text, inputActions.captureInsertion())) return true
  inputActions.setDraft?.(`${draft}${text}`)
  return true
}

// One pasted text: how long it is, and the two things the user can do with it.
export function PasteCard({ text, onPutBack, onRemove }) {
  return h('div', { className: 'bt-paste-card' },
    h('span', { className: 'bt-paste-icon', 'aria-hidden': true }, h(TextIcon)),
    h('span', { className: 'bt-paste-label' }, t('Pasted text · {count} characters', { count: text.length.toLocaleString() })),
    onPutBack === undefined ? null : h('button', {
      type: 'button', className: 'bt-paste-put', title: t('Put back into the box'), onClick: onPutBack,
    }, t('Put back')),
    h('button', {
      type: 'button', className: 'bt-paste-x', 'aria-label': t('Remove pasted text'), title: t('Remove pasted text'), onClick: onRemove,
    }, '×'))
}

export const PASTE_CSS = `
.bt-paste-guard{display:none}
.bt-paste-dock{box-sizing:border-box;width:calc(100% - var(--bt-composer-side,0px) - var(--bt-composer-side,0px) - var(--bt-composer-dock-inset,0px) - var(--bt-composer-dock-inset,0px));max-width:calc(var(--bt-composer-max-w,748px) - var(--bt-composer-dock-inset,0px) - var(--bt-composer-dock-inset,0px));margin:0 auto calc(0px - var(--bt-composer-gap,8px) + 8px);padding:0 var(--bt-composer-dock-inset,0px);flex:none;display:flex;flex-direction:column;gap:6px}
.bt-paste-card{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 5px 4px 10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px}
.bt-paste-icon{flex:none;display:inline-flex;width:16px;height:16px;color:var(--bt-ink-3)}
.bt-paste-label{min-width:0;flex:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-paste-put{flex:none;border:0;border-radius:8px;background:none;color:var(--bt-accent);font:inherit;font-size:13px;line-height:18px;padding:4px 6px;cursor:pointer}
.bt-paste-put:hover{background:color-mix(in srgb,var(--bt-accent) 10%,transparent)}
.bt-paste-x{position:relative;flex:none;display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:8px;background:none;color:var(--bt-ink-3);font:inherit;font-size:15px;line-height:1;cursor:pointer}
.bt-paste-x::after{content:"";position:absolute;inset:-4px}
.bt-paste-x:hover{background:color-mix(in srgb,var(--bt-ink) 8%,transparent);color:var(--bt-ink)}
`
