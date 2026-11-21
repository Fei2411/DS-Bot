import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import * as ui from './dsh-primitives.js'
import { imPlatform } from '../shared/im-platforms.js'
import { mentionSpans } from '../shared/mentions.js'
import { BotMark } from './mark.js'
import { CheckIcon, CopyIcon } from './icons.js'
import { dateLocale, t } from './i18n.js'
import { noHover } from './motion.js'
import { clockLabel, messageClock } from './text.js'
import { useFold } from './fold.js'

// -------------------------------------------------------------------------
// The user's own messages. DS Bot owns the row (fold, time, IM tag, copy, steering
// mark); how the contents are drawn depends on the DSH release:
// - Before DSH 0.2.1-alpha.3 the primitives projected user text (`projectUserText`),
//   and DS Bot drew the rest itself. DSH draws every "@word" there as a file reference
//   cut at the first space, so "@新 Bot" showed as a file "新": Bot mentions are cut out
//   first, by the rule the group host calls them with.
// - Since then DSH draws user contents by its `conversation.chat.user.content` factory,
//   for a caller that owns the row, and user text by rules (a Bot mention is one of
//   them). DS Bot hands it the part of the text the fold shows.
// The bubble used to mount only with the projection, so from 0.2.1-alpha.3 on it did
// not mount at all and long user messages stopped folding (#1616).

const projects = typeof ui.projectUserText === 'function'

// `drawsUserContent`: the host has the user-content factory (it has a user-text registry).
export const canDrawUserMessages = (drawsUserContent = false) => projects || drawsUserContent

// Other plugins mark where a message came from (Liveshare: "From <name> in a shared
// Session") in `conversation.chat.user.before`. DSH's own user row declares that slot,
// and only the entry that declares a slot may render it, so a row DS Bot draws cannot
// show those marks. While any plugin has a mark there, DS Bot leaves the user rows to
// DSH (the marks show, long messages do not fold); otherwise it draws them. Marks can
// register after DS Bot, so the choice follows the slot.
export const USER_SOURCE_SLOT = 'conversation.chat.user.before'

export function installUserBubble(slots, drawRows) {
  let dispose
  const refresh = () => {
    const marked = slots.entries(USER_SOURCE_SLOT).length > 0
    if (marked && dispose !== undefined) {
      dispose()
      dispose = undefined
    } else if (!marked && dispose === undefined) {
      dispose = drawRows()
    }
  }
  const unsubscribe = slots.subscribe(USER_SOURCE_SLOT, refresh)
  try { refresh() } catch (error) { unsubscribe(); throw error }
  return () => { unsubscribe(); dispose?.() }
}

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

// The contents as DSH's own user row prepares them for its content factory: its text
// joins the blocks with nothing between them, and the facts feed its text rules.
export function hostContent(content, { referenceLabels, skillNames } = {}) {
  const texts = []
  const attachments = []
  const extraBlocks = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'image' && block.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: block.attachment } })
    else if (block?.type === 'file' && block.attachment !== undefined) attachments.push({ type: 'file', file: block.attachment })
    else extraBlocks.push(block)
  }
  return {
    text: texts.join(''),
    attachments,
    extraBlocks,
    facts: { ...(referenceLabels === undefined ? {} : { sessionLabels: referenceLabels }), ...(skillNames === undefined ? {} : { skillNames }) },
  }
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

// A Bot mention in a bubble DSH draws itself (DSH 0.2.2-rc.1 and later draw user text by
// rules; see user-text-rule.js). Only a Bot this chat can call is drawn as one: the rule
// matches every Bot of the team, so any other name stays the text it was typed as.
export function BotMention({ node, raw, interactive, sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = mentionableBots(roster, sessionId).find(item => item.id === node.data.botId)
  if (!bot) return raw
  const mark = h(BotMark, { bot, size: 16 })
  return interactive
    ? h('button', { type: 'button', className: 'bt-umention', title: `@${bot.name}`, onClick: () => actions.openSession(bot.id) }, mark, node.data.label)
    : h('span', { className: 'bt-umention', 'data-static': '', title: `@${bot.name}` }, mark, node.data.label)
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

// A message that came in over IM names its platform: "via Telegram" by the time.
export const viaOf = source => (typeof source?.rpcId === 'string' && source.rpcId.startsWith('im:') ? source.rpcId.split(':')[1] : undefined)
export const ViaTag = ({ via }) => h('span', { className: 'bt-uvia' }, t('via {platform}', { platform: t(imPlatform(via)?.name ?? via) }))

// Before DSH 0.2.1-alpha.3: DS Bot draws the attachments, the text and the other blocks.
function ProjectedContent({ data, text, shown, folded, control, roster, sessionId, actions, renderMessageImages, openFile, openSkill, onClick }) {
  const { attachments, rest } = contentParts(data.content)
  const referenceLabels = data.referenceLabels ?? []
  const references = openFile && openSkill ? { openFile, openSkill } : undefined
  const body = h(UserText, { text: shown, bots: mentionableBots(roster, sessionId), referenceLabels, skillNames: data.skillNames ?? [], references, actions })
  return h(Fragment, null,
    attachments.length > 0 ? h(Attachments, { attachments, renderMessageImages }) : null,
    text !== '' || rest.length > 0 ? h('div', { className: 'bt-ubody', title: clock(data.time), 'data-folded': folded || undefined, 'data-text-interaction-source': text !== '' ? '' : undefined, onClick },
      control ? h('div', { className: 'bt-fold-body' }, body) : body,
      control,
      rest.map((block, index) => (ui.JsonBlock ? h(ui.JsonBlock, { key: index, label: t('Content'), payload: block }) : null))) : null,
    referenceLabels.length > 0 ? h('div', { className: 'bt-urefs' }, t('Referenced {labels}', { labels: referenceLabels.join(t(', ')) })) : null)
}

// Since DSH 0.2.1-alpha.3: the host's content factory draws the attachments, the part of
// the text the fold shows (with every text rule: files, skills, conversations, Bot
// mentions) and the other blocks, in its own bubble. The fold control sits under it.
// The reference line is DS Bot's, so the fold's fade lands on the text, the last thing
// the factory draws.
function HostContent({ data, prepared, shown, folded, control, loadImage, renderFactorySlot, onClick }) {
  const referenceLabels = data.referenceLabels ?? []
  const content = renderFactorySlot('conversation.chat.user.content', {
    content: { text: shown, attachments: prepared.attachments, extraBlocks: prepared.extraBlocks },
    loadImage,
    facts: prepared.facts,
    interactive: true,
  })
  return h(Fragment, null,
    h('div', { className: 'bt-uhost', title: clock(data.time), 'data-folded': folded || undefined, onClick },
      control ? h('div', { className: 'bt-fold-body' }, content) : content,
      control),
    referenceLabels.length > 0 ? h('div', { className: 'bt-urefs' }, t('Referenced {labels}', { labels: referenceLabels.join(t(', ')) })) : null)
}

// A sent message, or one that joined a running turn ("steering").
export function UserMessageCell({ node, sessionId, useRoster, actions, renderMessageImages, openFile, openSkill, loadImage, renderFactorySlot }) {
  const roster = useRoster(value => value)
  const data = node.data ?? {}
  const prepared = projects ? undefined : hostContent(data.content, data)
  const text = prepared?.text ?? contentParts(data.content).text
  const steering = node.kind === 'steering'
  const sentAt = Number.isFinite(data.time) ? messageClock(data.time) : undefined
  const via = viaOf(data.source) ?? roster.imVia?.[sessionId]?.[data.seq]
  const { shown, folded, control } = useFold(text, { markdown: false })
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
  const fold = { data, text, shown, folded, control, onClick: tapTools }
  return h('div', { ref: row, className: 'bt-umsg', 'data-steering': steering || undefined },
    h('div', { className: 'bt-ustack' },
      prepared === undefined
        ? h(ProjectedContent, { ...fold, roster, sessionId, actions, renderMessageImages, openFile, openSkill })
        : h(HostContent, { ...fold, prepared, loadImage, renderFactorySlot }),
      (sentAt || via) ? h('div', { className: 'bt-utime', title: clockLabel(data.time) }, ...(via ? [h(ViaTag, { key: 'via', via })] : []), sentAt) : null),
    text === '' ? null : h('div', { className: 'bt-utools', 'data-open': toolsOpen || undefined }, h(CopyButton, { text })))
}

export const USER_MESSAGE_CSS = `
.bt-umsg{display:flex;flex-direction:row-reverse;align-items:center;justify-content:flex-start;gap:4px}
.bt-ustack{min-width:0;max-width:calc(var(--bt-msg-w) * 100%);display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.bt-ubody{max-width:100%;box-sizing:border-box;background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 10px);white-space:pre-wrap;word-break:break-word;text-wrap:pretty;text-autospace:normal}
.bt-ubody a{color:inherit}
/* The host's content stack sits in DS Bot's: the width follows --bt-msg-w (the user's
   message width) through .bt-ustack, not the host's own cap. The fold control goes
   under the stack, at its right edge. */
.bt-uhost{max-width:100%;min-width:0;display:flex;flex-direction:column;align-items:flex-end}
.bt-uhost [class*="_userStack"]{max-width:100%}
.bt-uhost>.bt-fold{color:var(--bt-ink-3)}
.bt-umention{display:inline-flex;align-items:center;gap:3px;vertical-align:-3px;max-width:100%;padding:0 1px;border:0;background:none;color:inherit;font:inherit;font-weight:600;line-height:inherit;cursor:pointer;border-radius:6px;white-space:nowrap}
.bt-umention:hover{text-decoration:underline;text-underline-offset:2px}
.bt-umention[data-static]{cursor:inherit}
.bt-umention[data-static]:hover{text-decoration:none}
.bt-umention>:first-child{flex:none}
.bt-uattach{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}
.bt-ufile{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;width:240px;min-height:64px;padding:8px 12px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-ufile-icon{flex:none;width:28px;height:28px}
.bt-ufile-text{display:flex;flex-direction:column;min-width:0}
.bt-ufile-name{font-size:14px;line-height:22px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ufile-meta{font-size:12px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-urefs{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-uvia{display:inline-block;margin-right:6px;padding:0 6px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:11px;line-height:16px;vertical-align:1px}
.bt-utools{display:flex;flex:none;gap:2px;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
.bt-umsg:hover .bt-utools,.bt-umsg:focus-within .bt-utools{opacity:1;visibility:visible}
`
