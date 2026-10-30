import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { mentionSpans } from '../shared/mentions.js'
import { BotMark } from './mark.js'
import { CheckIcon, CopyIcon } from './icons.js'
import { dateLocale, t } from './i18n.js'
import { noHover } from './motion.js'
import { clockLabel, messageClock } from './text.js'
import { useFold } from './fold.js'

// -------------------------------------------------------------------------
// The user's own messages. DSH draws every "@word" in them as a file reference, and
// cuts it at the first space, so "@新 Bot" showed as a file "新". Here the Bot mentions
// are cut out first, by the rule the group host calls them with; DSH's own drawing
// keeps everything else (files, conversation references, skills).

// DSH releases without the text projection keep their own bubble.
export const canDrawUserMessages = () => typeof ui.projectUserText === 'function'

export function contentParts(content) {
  const texts = []
  const attachments = []
  const rest = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if ((block?.type === 'image' || block?.type === 'file') && block.attachment !== undefined) attachments.push(block)
    else rest.push(block)
  }
  // Joined as the group host joins them, so a mention never spans two blocks here only.
  return { text: texts.join('\n'), attachments, rest }
}

// In a group only its members are called; elsewhere a mention opens that Bot's chat.
export function mentionableBots(roster, sessionId) {
  const room = roster.roomsById[sessionId]
  if (room) return room.members.map(id => roster.byId[id]).filter(Boolean)
  return roster.byId[sessionId] ? roster.bots : []
}

// Runs of plain text and Bot mentions, in order.
export function userTextParts(text, bots, referenceLabels = []) {
  const parts = []
  let cursor = 0
  for (const span of mentionSpans(text, bots, { references: referenceLabels })) {
    if (!span.bot) continue
    if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start) })
    parts.push({ bot: span.bot, label: text.slice(span.start + 1, span.end) })
    cursor = span.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

function UserText({ text, bots, referenceLabels, skillNames, references, actions }) {
  return userTextParts(text, bots, referenceLabels).map((part, index) => (part.bot
    ? h('button', { key: index, type: 'button', className: 'bt-umention', title: `@${part.bot.name}`, onClick: () => actions.openSession(part.bot.id) },
      h(BotMark, { bot: part.bot, size: 16 }), part.label)
    : h(Fragment, { key: index }, ui.projectUserText(part.text, referenceLabels, skillNames, 'skill', references))))
}

function Attachments({ attachments, renderMessageImages }) {
  const compact = attachments.length > 1
  return h('div', { className: 'bt-uattach' }, attachments.map((block, index) => {
    if (block.type === 'image') {
      return renderMessageImages ? h(Fragment, { key: index }, renderMessageImages({ images: [{ attachment: block.attachment }], align: 'end', compact })) : null
    }
    const file = block.attachment
    const meta = [ui.fileExtension?.(file.name)?.toUpperCase().slice(0, 8), ui.fileSizeText?.(file.bytes)].filter(Boolean).join(' · ')
    return h('span', { key: index, className: 'bt-ufile', title: file.name },
      ui.FileTypeIcon ? h(ui.FileTypeIcon, { path: file.name, className: 'bt-ufile-icon' }) : null,
      h('span', { className: 'bt-ufile-text' }, h('span', { className: 'bt-ufile-name' }, file.name), meta ? h('span', { className: 'bt-ufile-meta' }, meta) : null))
  }))
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  return h('button', { type: 'button', className: 'bt-tool', 'aria-label': copied ? t('Copied') : t('Copy'), title: copied ? t('Copied') : t('Copy'), onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon))
}

const clock = time => (typeof time === 'number' ? new Date(time).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }) : undefined)

// A sent message, or one that joined a running turn ("steering").
export function UserMessageCell({ node, sessionId, useRoster, actions, renderMessageImages, openFile, openSkill }) {
  const roster = useRoster(value => value)
  const data = node.data ?? {}
  const { text, attachments, rest } = contentParts(data.content)
  const referenceLabels = data.referenceLabels ?? []
  const references = openFile && openSkill ? { openFile, openSkill } : undefined
  const steering = node.kind === 'steering'
  const groupTime = roster.roomsById?.[sessionId] && Number.isFinite(data.time) ? messageClock(data.time) : undefined
  const { shown, folded, control } = useFold(text, { markdown: false })
  const body = h(UserText, { text: shown, bots: mentionableBots(roster, sessionId), referenceLabels, skillNames: data.skillNames ?? [], references, actions })
  const row = useRef(null)
  // Touch has no hover: a tap on the bubble opens its copy tool, a tap elsewhere closes it.
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => {
    if (!toolsOpen) return undefined
    const onDown = (event) => { if (!row.current?.contains(event.target)) setToolsOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown) }
  }, [toolsOpen])
  const tapTools = (event) => {
    if (!noHover() || event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]')) return
    setToolsOpen(value => !value)
  }
  return h('div', { ref: row, className: 'bt-umsg', 'data-steering': steering || undefined },
    h('div', { className: 'bt-ustack' },
      attachments.length > 0 ? h(Attachments, { attachments, renderMessageImages }) : null,
      text !== '' || rest.length > 0 ? h('div', { className: 'bt-ubody', title: clock(data.time), 'data-folded': folded || undefined, onClick: tapTools },
        control ? h('div', { className: 'bt-fold-body' }, body) : body,
        control,
        rest.map((block, index) => (ui.JsonBlock ? h(ui.JsonBlock, { key: index, label: t('Content'), payload: block }) : null))) : null,
      referenceLabels.length > 0 ? h('div', { className: 'bt-urefs' }, t('Referenced {labels}', { labels: referenceLabels.join(t(', ')) })) : null,
      groupTime ? h('div', { className: 'bt-utime', title: clockLabel(data.time) }, groupTime) : null),
    text === '' ? null : h('div', { className: 'bt-utools', 'data-open': toolsOpen || undefined }, h(CopyButton, { text })))
}

export const USER_MESSAGE_CSS = `
.bt-umsg{display:flex;flex-direction:row-reverse;align-items:center;justify-content:flex-start;gap:4px}
.bt-ustack{min-width:0;max-width:calc(var(--bt-msg-w) * 100%);display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.bt-ubody{max-width:100%;box-sizing:border-box;background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 10px);white-space:pre-wrap;word-break:break-word;text-wrap:pretty;text-autospace:normal}
.bt-ubody a{color:inherit}
.bt-umention{display:inline-flex;align-items:center;gap:3px;vertical-align:-3px;max-width:100%;padding:0 1px;border:0;background:none;color:inherit;font:inherit;font-weight:600;line-height:inherit;cursor:pointer;border-radius:6px;white-space:nowrap}
.bt-umention:hover{text-decoration:underline;text-underline-offset:2px}
.bt-umention>:first-child{flex:none}
.bt-uattach{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}
.bt-ufile{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;width:240px;min-height:64px;padding:8px 12px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-ufile-icon{flex:none;width:28px;height:28px}
.bt-ufile-text{display:flex;flex-direction:column;min-width:0}
.bt-ufile-name{font-size:14px;line-height:22px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ufile-meta{font-size:12px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-urefs{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-utools{display:flex;flex:none;gap:2px;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
.bt-umsg:hover .bt-utools,.bt-umsg:focus-within .bt-utools{opacity:1;visibility:visible}
`
