// DM current-segment chat over `api/bot/session` (host/session-follow.js) and
// `ds-bot/src/client/session-log.js`: follows DSH frames directly, pages earlier
// messages via `session-page`, bridges earlier segments via `EarlierParts`, and renders
// user messages, settled card replies, Markdown replies, thinking, tool calls
// (via `tool.call.toolview` -> `WidgetCell` for `show_view` / `GenericToolCard`),
// compaction markers, Bot/schedule events, and failed turns (`FailureCell`).
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { BtwTurnTail } from '../../../ds-bot/src/client/btw.js'
import { Bubbles, EarlierParts, PartLine, ThinkingRow, ToolCell, isBotTool } from '../../../ds-bot/src/client/cells.js'
import { ChangesCard } from '../../../ds-bot/src/client/changes-card.js'
import { MarkdownText, fileExtension, fileSizeText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { SaveFileAction } from '../../../ds-bot/src/client/file-save.js'
import { FOLD_HUGE, useFold } from '../../../ds-bot/src/client/fold.js'
import { CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, FileIcon, ImageIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { LearningTurnTail } from '../../../ds-bot/src/client/learning-card.js'
import { BotMark, RoomAvatar } from '../../../ds-bot/src/client/mark.js'
import { noHover } from '../../../ds-bot/src/client/motion.js'
import { addPage, applyFrame, emptyLog, pageBefore, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { clockLabel, messageClock } from '../../../ds-bot/src/client/text.js'
import { layoutOf, thinkingShown } from '../../../ds-bot/src/client/themes.js'
import { FailureCell, failureText } from '../../../ds-bot/src/client/turn-error.js'
import { ViaTag, contentParts, mentionableBots, userTextParts } from '../../../ds-bot/src/client/user-message.js'
import { AnsweredReply } from '../../../ds-bot/src/client/widget-cell.js'
import { openSessionFollow } from './api.js'
import { buildSessionRows, extractTurnFacts } from './session-transcript.js'
import { CHAT_NODE_SLOT, SlotOutlet, slots as defaultSlots } from './slots.js'
import { GenericToolCard, ToolCallCard } from './tool-card.js'

const PAGE_SIZE = 40
const SEPARATOR_GAP_MS = 30 * 60 * 1000
const IMAGE_CACHE_MAX = 120
const EMPTY_OBJ = {}
const EMPTY_WORK = { bots: {}, approvals: [] }
const NO_UI_HOOK = () => false
const NO_OBJECT_HOOK = selector => selector(EMPTY_OBJ)
const NO_WORK_HOOK = selector => selector(EMPTY_WORK)
const NO_HELD_CARDS_HOOK = () => undefined

const imageCache = new Map()
const imageInflight = new Map()

function rememberImage(key, value) {
  imageCache.delete(key)
  imageCache.set(key, value)
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value
    if (oldest === undefined) break
    imageCache.delete(oldest)
  }
}

function loadAttachmentImage(sessionId, attachmentId) {
  const key = `${sessionId}:${attachmentId}`
  if (imageCache.has(key)) {
    const cached = imageCache.get(key)
    rememberImage(key, cached)
    return Promise.resolve(cached)
  }
  const existing = imageInflight.get(key)
  if (existing) return existing
  const promise = Promise.resolve(call('image', { sessionId, attachmentId, preview: true }))
    .then((res) => {
      const src = res?.mime && res?.data ? `data:${res.mime};base64,${res.data}` : null
      if (src) rememberImage(key, src)
      return src
    })
    .catch(() => null)
    .finally(() => { imageInflight.delete(key) })
  imageInflight.set(key, promise)
  return promise
}

function userSummaryOf(event) {
  const { text, attachments } = contentParts(event?.data?.content)
  let images = 0
  let files = 0
  for (const block of attachments) {
    if (block?.type === 'image') images += 1
    else if (block?.type === 'file') files += 1
  }
  return { text, images, files }
}

function collectUserEvents(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') out.push(event)
  }
  return out
}

// Recover reasoning start time from an activeAttempt's compact stream on reconnect,
// falling back to `now` when live chunks arrive without a prior baseline timestamp.
function reasoningStartFrom(log, existing, now) {
  const writing = log.writing
  if (!writing) return Object.keys(existing).length === 0 ? existing : {}
  const attemptId = writing.attemptId ?? 'live'
  if (attemptId in existing) return existing
  for (const record of Array.isArray(writing.base) ? writing.base : []) {
    if (record?.type === 'reasoning-chunks' && Number.isFinite(record.time0)) {
      return { ...existing, [attemptId]: record.time0 }
    }
    if (record?.type === 'chunk' && record.chunk?.type === 'block-start' && record.chunk?.blockType === 'reasoning' && Number.isFinite(record.time)) {
      return { ...existing, [attemptId]: record.time }
    }
  }
  const blocks = writingBlocks(log)
  if (blocks.some(block => block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '')) {
    return { ...existing, [attemptId]: now }
  }
  return existing
}

/**
 * Follows one Bot's current Session via `api/bot/session` and pages older records
 * via `session-page`, keeping `SessionLog` in sync across reconnects and read-only updates.
 */
export function useSessionFollow({ sessionId, enabled, feed, readOnly, onUserMessage, keep, openFollow = openSessionFollow }) {
  const [state, setState] = useState(() => ({
    log: emptyLog(),
    thinkingAt: {},
    loading: enabled,
    paging: false,
    failed: false,
    pageFailed: false,
    terminalError: null,
  }))
  const logRef = useRef(emptyLog())
  const followRef = useRef(null)
  const genRef = useRef(0)
  const pagingRef = useRef(false)
  const openedRef = useRef(false)
  const seenUserSeqsRef = useRef(new Set())
  const onUserRef = useRef(onUserMessage)
  onUserRef.current = onUserMessage
  const openFollowRef = useRef(openFollow)
  openFollowRef.current = openFollow

  useEffect(() => {
    const myGen = ++genRef.current
    pagingRef.current = false
    openedRef.current = false
    seenUserSeqsRef.current = new Set()
    const fresh = emptyLog()
    logRef.current = fresh
    setState({ log: fresh, thinkingAt: {}, loading: enabled, paging: false, failed: false, pageFailed: false, terminalError: null })
    if (!enabled || !sessionId) return undefined

    const handle = openFollowRef.current({ sessionId, max: PAGE_SIZE }, (event, data) => {
      if (genRef.current !== myGen) return
      if (event === 'frame') {
        const next = applyFrame(logRef.current, data)
        logRef.current = next.log
        // Notify new user messages so optimistic pending bubbles clear one-for-one without
        // matching historical duplicates or dropping messages on a gap-reopen frame.
        if (data?.type === 'snapshot') {
          const initial = !openedRef.current
          openedRef.current = true
          const users = collectUserEvents(data.records?.map(record => record.event))
          for (const userEv of users) {
            if (seenUserSeqsRef.current.has(userEv.seq)) continue
            seenUserSeqsRef.current.add(userEv.seq)
            const summary = userSummaryOf(userEv)
            onUserRef.current?.(summary.text, userEv.time, initial, summary)
          }
        } else if (!next.reopen && data?.type === 'event' && data.event?.type === 'user/message' && data.event.data?.source?.kind === 'user') {
          if (!seenUserSeqsRef.current.has(data.event.seq)) {
            seenUserSeqsRef.current.add(data.event.seq)
            const summary = userSummaryOf(data.event)
            onUserRef.current?.(summary.text, data.event.time, false, summary)
          }
        }
        const now = Date.now()
        setState(current => ({
          ...current,
          log: next.log,
          thinkingAt: reasoningStartFrom(next.log, current.thinkingAt, now),
          loading: false,
          failed: false,
          terminalError: null,
        }))
        if (next.reopen) followRef.current?.reopen()
      } else if (event === 'error') {
        const terminal = data?.code === 'bot/not-found' || data?.code === 'bot/refused' || data?.code === 'bot/invalid'
        setState(current => ({
          ...current,
          loading: false,
          failed: !terminal && !openedRef.current,
          terminalError: terminal ? data : current.terminalError,
        }))
      } else if (event === 'lost') {
        setState(current => (openedRef.current ? current : { ...current, failed: true, loading: false }))
      }
    })
    followRef.current = handle
    return () => {
      if (genRef.current === myGen) genRef.current += 1
      handle.close()
      if (followRef.current === handle) followRef.current = null
    }
  }, [sessionId, enabled])

  // Read-only windows only receive the opening snapshot from DSH (host/session-follow.js):
  // reopen when the team live feed reports a revision or reconnects.
  useEffect(() => {
    if (!enabled || !sessionId || !feed) return undefined
    return feed.on((event) => {
      if (readOnly && (event === 'revision' || event === 'hello')) followRef.current?.reopen()
    })
  }, [enabled, sessionId, feed, readOnly])

  const loadEarlier = useCallback(async (scroller) => {
    if (!enabled || !sessionId || pagingRef.current) return
    const beforeSeq = pageBefore(logRef.current)
    if (beforeSeq === undefined) return
    const myGen = genRef.current
    pagingRef.current = true
    setState(current => ({ ...current, paging: true, pageFailed: false }))
    try {
      const page = await call('session-page', { sessionId, beforeSeq, maxMessages: PAGE_SIZE })
      if (genRef.current !== myGen) return
      const next = addPage(logRef.current, page)
      if (next !== logRef.current) {
        for (const userEv of collectUserEvents(page?.records?.map(record => record.event))) {
          seenUserSeqsRef.current.add(userEv.seq)
        }
        // Only anchor scroll when the page actually prepended onto the active log.
        if (scroller && keep) keep.current = scroller.scrollHeight - scroller.scrollTop
        logRef.current = next
      }
      setState(current => ({ ...current, log: next, paging: false, pageFailed: false }))
    } catch {
      if (genRef.current !== myGen) return
      setState(current => ({ ...current, paging: false, pageFailed: true }))
    } finally {
      if (genRef.current === myGen) pagingRef.current = false
    }
  }, [enabled, sessionId, keep])

  const retry = useCallback(() => {
    setState(current => ({ ...current, loading: true, failed: false, terminalError: null }))
    followRef.current?.reopen()
  }, [])

  return {
    log: state.log,
    loading: state.loading,
    paging: state.paging,
    failed: state.failed,
    pageFailed: state.pageFailed,
    terminalError: state.terminalError,
    hasMore: pageBefore(state.log) !== undefined,
    thinkingAt: state.thinkingAt,
    loadEarlier,
    retry,
  }
}

function CopyTextButton({ text, className = 'bt-tool' }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  return h('button', {
    type: 'button',
    className,
    'aria-label': copied ? t('Copied') : t('Copy'),
    title: copied ? t('Copied') : t('Copy'),
    onClick: copy,
  }, copied ? h(CheckIcon) : h(CopyIcon))
}

function UserImageThumb({ sessionId, attachment }) {
  const name = attachment?.name || t('Image')
  const direct = attachment?.previewUrl ?? null
  const attachmentId = attachment?.attachmentId
  const cached = !direct && sessionId && attachmentId ? imageCache.get(`${sessionId}:${attachmentId}`) ?? null : null
  const [loaded, setLoaded] = useState(cached)
  const [zoomed, setZoomed] = useState(false)
  const closeBtn = useRef(null)
  const src = direct ?? loaded

  useEffect(() => {
    if (direct || !sessionId || !attachmentId) return undefined
    const key = `${sessionId}:${attachmentId}`
    if (imageCache.has(key)) {
      setLoaded(imageCache.get(key))
      return undefined
    }
    let alive = true
    void loadAttachmentImage(sessionId, attachmentId).then((url) => {
      if (alive && url) setLoaded(url)
    })
    return () => { alive = false }
  }, [direct, sessionId, attachmentId])

  useEffect(() => {
    if (!zoomed) return undefined
    closeBtn.current?.focus?.()
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setZoomed(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoomed])

  if (!src) {
    return h('span', { className: 'bt-ufile', title: name },
      h('span', { className: 'dsb-ufile-icon', 'aria-hidden': true }, h(ImageIcon)),
      h('span', { className: 'bt-ufile-text' }, h('span', { className: 'bt-ufile-name' }, name)))
  }
  const lightbox = zoomed ? h('div', {
    className: 'dsb-lightbox',
    role: 'dialog',
    'aria-modal': true,
    'aria-label': name,
    onClick: (event) => { if (event.target === event.currentTarget) setZoomed(false) },
  },
  h('button', {
    ref: closeBtn,
    type: 'button',
    className: 'dsb-lightbox-close',
    'aria-label': t('Close'),
    title: t('Close'),
    onClick: () => setZoomed(false),
  }, h(CloseIcon)),
  h('img', { className: 'dsb-lightbox-img', src, alt: name })) : null
  const portalTarget = typeof document !== 'undefined' && document?.body ? document.body : null
  return h(Fragment, null,
    h('button', {
      type: 'button',
      className: 'dsb-uimg-btn',
      title: name,
      'aria-label': name,
      onClick: () => setZoomed(true),
    }, h('img', { className: 'dsb-uimg', src, alt: name, loading: 'lazy' })),
    lightbox && portalTarget ? createPortal(lightbox, portalTarget) : lightbox)
}

export function UserAttachments({ attachments, sessionId }) {
  if (!attachments || attachments.length === 0) return null
  return h('div', { className: 'bt-uattach' }, attachments.map((block, index) => {
    const file = block.attachment ?? {}
    if (block.type === 'image') {
      return h(UserImageThumb, { key: file.attachmentId ?? file.previewUrl ?? index, sessionId, attachment: file })
    }
    const meta = [fileExtension(file.name)?.toUpperCase().slice(0, 8), fileSizeText(file.bytes)].filter(Boolean).join(' · ')
    return h('span', { key: file.attachmentId ?? `${file.name ?? 'file'}:${index}`, className: 'bt-ufile', title: file.name },
      h('span', { className: 'dsb-ufile-icon', 'aria-hidden': true }, h(FileIcon)),
      h('span', { className: 'bt-ufile-text' },
        h('span', { className: 'bt-ufile-name' }, file.name || 'file'),
        meta ? h('span', { className: 'bt-ufile-meta' }, meta) : null))
  }))
}

function UserRow({ row, sessionId, roster, actions, classic = false }) {
  const { shown, folded, control } = useFold(row.text ?? '', { markdown: false })
  const container = useRef(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => {
    if (!toolsOpen) return undefined
    const onDown = (event) => { if (!container.current?.contains(event.target)) setToolsOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown) }
  }, [toolsOpen])
  const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0
  if (row.text === '' && !hasAttachments) return null
  const tapTools = (event) => {
    if (!noHover() || (event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]'))) return
    setToolsOpen(value => !value)
  }
  const bots = Array.isArray(roster?.bots) ? mentionableBots(roster, sessionId) : []
  const body = userTextParts(shown, bots).map((part, index) => (part.bot
    ? h('button', { key: index, type: 'button', className: 'bt-umention', title: `@${part.bot.name}`, onClick: () => actions.openSession(part.bot.id) },
      h(BotMark, { bot: part.bot, size: 16 }), part.label)
    : h(Fragment, { key: index }, part.text)))
  const hasTime = Number.isFinite(row.time)
  const sentAt = hasTime ? messageClock(row.time) : undefined
  const timeTitle = hasTime ? clockLabel(row.time) : undefined
  if (classic) {
    return h('div', {
      ref: container,
      className: 'dsb-dsh-user',
      'data-chat-flow-kind': 'user',
      'data-open': toolsOpen || undefined,
    },
    h('div', { className: 'dsb-dsh-user-stack' },
      h(UserAttachments, { attachments: row.attachments, sessionId }),
      row.text !== '' ? h('div', {
        className: 'dsb-dsh-user-bubble',
        title: timeTitle,
        'data-folded': folded || undefined,
        'data-text-interaction-source': '',
        onClick: tapTools,
      },
      control ? h('div', { className: 'bt-fold-body' }, body) : body,
      control) : null),
    (row.text !== '' || sentAt) ? h('div', { className: 'dsb-dsh-user-actions' },
      sentAt ? h('span', { className: 'dsb-dsh-msg-time', title: timeTitle }, sentAt) : null,
      row.text !== '' ? h(CopyTextButton, { text: row.text, className: 'dsb-dsh-act-btn' }) : null) : null)
  }
  return h('div', { ref: container, className: 'bt-umsg' },
    h('div', { className: 'bt-ustack' },
      h(UserAttachments, { attachments: row.attachments, sessionId }),
      row.text !== '' ? h('div', { className: 'bt-ubody', title: timeTitle, 'data-folded': folded || undefined, 'data-text-interaction-source': '', onClick: tapTools },
        control ? h('div', { className: 'bt-fold-body' }, body) : body,
        control) : null,
      (sentAt || row.via) ? h('div', { className: 'bt-utime', title: timeTitle },
        row.via ? h(ViaTag, { via: row.via }) : null,
        sentAt) : null),
    row.text === '' ? null : h('div', { className: 'bt-utools', 'data-open': toolsOpen || undefined }, h(CopyTextButton, { text: row.text })))
}

function CompactionRow({ row }) {
  const [open, setOpen] = useState(false)
  const hasSummary = typeof row.summary === 'string' && row.summary !== ''
  const label = Number.isInteger(row.shadowedItemCount) && row.shadowedItemCount > 0
    ? t('{count} earlier messages compacted', { count: row.shadowedItemCount })
    : t('Conversation compacted')
  return h('div', { className: 'dsb-compaction', role: 'separator', 'data-open': open || undefined },
    h('div', { className: 'dsb-compaction-bar' },
      hasSummary
        ? h('button', {
          type: 'button',
          className: 'dsb-compaction-pill',
          'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        },
        h('span', null, label),
        h('span', { className: 'dsb-compaction-chev', 'aria-hidden': true }, h(ChevronRightIcon)))
        : h('span', { className: 'dsb-compaction-pill', 'data-static': '' }, label)),
    open && hasSummary ? h('div', { className: 'dsb-compaction-summary' }, row.summary) : null)
}

function SessionEventRow({ row, selfId, roster, actions }) {
  switch (row.eventKind) {
    case 'update': return h('div', { className: 'bt-event' }, t('Profile updated'))
    case 'resume': return h('div', { className: 'bt-event' }, t('Picked up its work after a restart'))
    case 'retry': return h('div', { className: 'bt-event' }, t('Asked to make the tool call it wrote as text'))
    case 'continue': return h('div', { className: 'bt-event' }, t('Went on after the failed turn'))
    case 'schedule': return h('div', { className: 'bt-event' }, row.text ? t('Scheduled task: {text}', { text: row.text }) : t('Routine started'))
    case 'report': {
      const room = roster.roomsById?.[row.roomId]
      return h('div', { className: 'bt-event' },
        h('span', null, t('Replies from')),
        room ? h('button', { type: 'button', onClick: () => actions.openSession(room.id) }, h(RoomAvatar, { room, roster, size: 16 }), room.name) : h('span', null, t('a group chat')))
    }
    case 'request':
    case 'reply':
    case 'stopped': {
      const sender = roster.byId?.[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
      const prefix = row.eventKind === 'stopped' ? t('Stopped by') : row.eventKind === 'reply' ? t('Reply from') : t('Message from')
      return h('div', { className: 'bt-event' },
        h('button', { type: 'button', className: 'bt-event-whole', title: sender.name, onClick: () => { if (selfId && sender.id) actions.openExchange(selfId, sender.id) } },
          h('span', null, prefix), h(BotMark, { bot: sender, size: 16 }), h('span', { className: 'bt-event-name' }, sender.name)))
    }
    default: return null
  }
}

const activityParts = line => line.split('`').map((part, index) => (index % 2 === 1 ? h('code', { key: index }, part) : part))

function SpeakerHead({ bot, time }) {
  return h('div', { className: 'bt-group-name' },
    h('span', { className: 'bt-lead' }, h(BotMark, { bot, size: 22 })), bot.name,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null)
}

function AssistantRow({ row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt, classic = false }) {
  const showThinking = thinkingShown(roster.prefs)
  const selfId = bot?.id ?? sessionId
  const flat = layoutOf(roster.prefs) === 'flat'
  // Preserve reactions saved under legacy `ChatRows` keys (`${sessionId}:${time}`) while
  // using DSH-aligned `${sessionId}:${turn}:${seq}` for newly added reactions.
  const legacyKey = Number.isFinite(row.time) ? `${sessionId}:${row.time}` : undefined
  const primaryKey = `${sessionId}:${row.turn ?? ''}:${row.seq ?? ''}`
  const useReadUi = typeof useUi === 'function' ? useUi : NO_UI_HOOK
  const hasLegacyReaction = useReadUi(state => Boolean(legacyKey && state?.reactions?.[legacyKey]))
  const msgKey = row.streaming ? undefined : (hasLegacyReaction ? legacyKey : primaryKey)

  const hasThinking = showThinking && row.reasoning !== ''
  const hasActivity = row.activity.length > 0
  const hasTexts = row.texts.length > 0
  if (!hasThinking && !hasActivity && !hasTexts) return null
  const liveAt = row.thinkingLive ? thinkingAt?.[row.attemptId ?? 'live'] : undefined
  if (classic) {
    const combinedText = row.texts.join('\n\n')
    const mdLabels = { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') } }
    const hasTime = Number.isFinite(row.time)
    return h(Fragment, null,
      hasActivity ? h('div', { className: 'bt-agent-activity' }, row.activity.map((line, index) => h('div', { key: index, className: 'bt-agent-act', title: line },
        h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }),
        h('span', { className: 'bt-agent-act-text' }, activityParts(line))))) : null,
      hasThinking ? h(ThinkingRow, {
        text: row.reasoning,
        live: row.thinkingLive,
        viewKey: `${sessionId}:${row.turn ?? 't'}:${row.step ?? row.seq ?? row.attemptId ?? 'live'}`,
        textInteractionSource: !row.streaming,
        ...(row.thinkingLive ? { at: liveAt } : { ms: row.reasoningMs }),
      }) : null,
      hasTexts ? h('div', {
        className: 'dsb-dsh-asst',
        'data-chat-flow-kind': 'assistant',
        'data-streaming': row.streaming ? '' : undefined,
      },
      h('div', { className: 'dsb-dsh-asst-body', 'data-text-interaction-source': !row.streaming ? '' : undefined },
        row.texts.map((text, index) => h(MarkdownText, { key: index, text, labels: mdLabels }))),
      !row.streaming ? h('div', { className: 'dsb-dsh-asst-actions' },
        h(CopyTextButton, { text: combinedText, className: 'dsb-dsh-act-btn' }),
        hasTime ? h('span', { className: 'dsb-dsh-msg-time dsb-dsh-asst-time', title: clockLabel(row.time) }, messageClock(row.time)) : null) : null) : null)
  }
  return h(Fragment, null,
    showSpeaker && flat && bot ? h(SpeakerHead, { bot, time: row.time }) : null,
    hasActivity ? h('div', { className: 'bt-agent-activity' }, row.activity.map((line, index) => h('div', { key: index, className: 'bt-agent-act', title: line },
      h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }),
      h('span', { className: 'bt-agent-act-text' }, activityParts(line))))) : null,
    hasThinking ? h(ThinkingRow, {
      text: row.reasoning,
      live: row.thinkingLive,
      viewKey: `${sessionId}:${row.turn ?? 't'}:${row.step ?? row.seq ?? row.attemptId ?? 'live'}`,
      textInteractionSource: !row.streaming,
      ...(row.thinkingLive ? { at: liveAt } : { ms: row.reasoningMs }),
    }) : null,
    hasTexts ? h(Bubbles, {
      texts: row.texts,
      roster,
      selfId,
      actions,
      streaming: row.streaming,
      sessionId,
      msgKey,
      useUi,
      fold: FOLD_HUGE,
      time: flat || row.streaming ? undefined : row.time,
      textInteractionSource: !row.streaming,
    }) : null)
}

function TurnErrorRow({ row, bot, sessionId, useRoster, useTurnClock, actions }) {
  if (typeof useRoster === 'function' && typeof useTurnClock === 'function') {
    return h(FailureCell, {
      node: { data: { ...row.error, turn: row.turn } },
      sessionId,
      useRoster,
      useTurnClock,
      actions,
    })
  }
  const code = row.error?.code ?? ''
  const text = failureText(code, { name: bot?.name ?? t('This Bot'), provider: t('The model service') })
  const title = code === 'AUTH' ? code : (row.error?.message || code || undefined)
  return h('div', { className: 'bt-fail', 'data-settled': '', role: 'status', title },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)))
}

/**
 * Renders the projected DM session transcript (earlier segments via EarlierParts,
 * time separators, user messages, settled card replies, thinking, Markdown replies,
 * tool call cards via `tool.call.toolview` / DS Bot `ToolCell` / `GenericToolCard`,
 * compaction checkpoints, Bot/schedule events, and failed turns).
 */
function DeliverablesRow({ row, sessionId, onOpenFile }) {
  const files = Array.isArray(row.files) ? row.files : []
  if (files.length === 0) return null
  return h('div', { className: 'dsb-deliverables', role: 'region', 'aria-label': t('Delivered files') },
    files.map((file, index) => {
      const fileIndex = Number.isInteger(file.index) ? file.index : index
      const name = String(file.path ?? '').split(/[\\/]/).filter(Boolean).at(-1) || file.path
      const actionUrl = sessionId && Number.isInteger(row.seq)
        ? `present://file?sessionId=${encodeURIComponent(sessionId)}&seq=${row.seq}&index=${fileIndex}`
        : ''
      return h('div', { key: `${row.seq}:${fileIndex}:${file.path}`, className: 'dsb-deliverable' },
        h('span', { className: 'dsb-deliverable-icon', 'aria-hidden': true }, h(FileIcon)),
        h('span', { className: 'dsb-deliverable-text' },
          typeof onOpenFile === 'function'
            ? h('button', {
              type: 'button',
              className: 'dsb-deliverable-link',
              title: file.path,
              onClick: () => onOpenFile(file.path),
            }, name)
            : h('span', { className: 'dsb-deliverable-name', title: file.path }, name),
          file.description ? h('span', { className: 'dsb-deliverable-desc' }, file.description) : null),
        actionUrl ? h(SaveFileAction, { actionUrl }) : null)
    }))
}

function turnFactsSignature(facts) {
  if (!facts?.turns) return ''
  const parts = [`open:${facts.openTurn ?? ''}`]
  for (const entry of facts.turns.values()) {
    parts.push(`${entry.turn}:${entry.status}:${entry.start?.seq ?? ''}:${entry.start?.time ?? ''}:${entry.end?.seq ?? ''}:${entry.end?.time ?? ''}`)
  }
  return parts.join('|')
}

function SessionChangesRow({ row, sessionId, actions }) {
  const [changes, setChanges] = useState(null)
  useEffect(() => {
    if (!sessionId || !Number.isInteger(row.seq)) return undefined
    let alive = true
    void call('workspace-changes', { sessionId, seq: row.seq })
      .then((res) => {
        if (!alive || !Array.isArray(res?.files) || res.files.length === 0) return
        setChanges({
          sessionId,
          seq: row.seq,
          turn: res.turn,
          total: res.total,
          added: res.added,
          deleted: res.deleted,
          files: res.files.map(file => ({
            path: file.display ?? file.path,
            added: file.added,
            deleted: file.deleted,
            ...(file.binary === true ? { binary: true } : {}),
            ...(file.oversized === true ? { oversized: true } : {}),
          })),
        })
      })
      .catch(() => { /* stale or disposed session summary stays hidden */ })
    return () => { alive = false }
  }, [sessionId, row.seq])
  return changes ? h(ChangesCard, { changes, actions }) : null
}

function TurnTailRow({ row, sessionId, useRoster, actions }) {
  if (typeof actions?.turnFacts !== 'function' || typeof actions?.watchTurns !== 'function') return null
  return h(Fragment, null,
    h(BtwTurnTail, { turn: row.turnInfo, sessionId, useRoster, actions }),
    h(LearningTurnTail, { turn: row.turnInfo, sessionId, useRoster, actions }))
}

export function SessionTranscript({
  log, sessionId, bot, roster, actions, classic = false,
  useUi, useRoster, useWork, useTurnClock, useHeldCards,
  useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer,
  thinkingAt, hasMore = false, registry = defaultSlots,
}) {
  const rows = useMemo(() => buildSessionRows(log, { roster, sessionId }), [log, roster, sessionId])
  const turnFacts = useMemo(() => extractTurnFacts(log?.events, { roster, sessionId }), [log?.events, roster, sessionId])
  const turnSig = turnFactsSignature(turnFacts)
  const turnFactsRef = useRef(turnFacts)
  turnFactsRef.current = turnFacts
  const safeRoster = useMemo(() => ({
    bots: [], rooms: [], byId: {}, roomsById: {}, exchangeTurns: {}, ...roster,
  }), [roster])
  const fallbackUseRoster = useCallback(selector => selector(safeRoster), [safeRoster])
  const resolvedUseRoster = typeof useRoster === 'function' ? useRoster : fallbackUseRoster
  const resolvedUseUi = typeof useUi === 'function' ? useUi : NO_OBJECT_HOOK
  const resolvedUseWork = typeof useWork === 'function' ? useWork : NO_WORK_HOOK
  const resolvedUseHeldCards = typeof useHeldCards === 'function' ? useHeldCards : NO_HELD_CARDS_HOOK
  const resolvedUseBrowserHolds = typeof useBrowserHolds === 'function' ? useBrowserHolds : NO_OBJECT_HOOK
  const resolvedUseBrowserTabs = typeof useBrowserTabs === 'function' ? useBrowserTabs : NO_OBJECT_HOOK
  const resolvedUseBrowserPages = typeof useBrowserPages === 'function' ? useBrowserPages : NO_OBJECT_HOOK
  const resolvedUseComputer = typeof useComputer === 'function' ? useComputer : NO_OBJECT_HOOK
  // Sync turn facts (`{ turns, openTurn }`) only when turn boundaries actually change so
  // non-turn streaming events do not fan out re-renders across every turn tail.
  useEffect(() => {
    if (typeof actions?.noteTurnFacts !== 'function' || !sessionId) return undefined
    actions.noteTurnFacts(sessionId, turnFactsRef.current)
    return undefined
  }, [turnSig, sessionId, actions])
  useEffect(() => () => {
    if (typeof actions?.noteTurnFacts === 'function' && sessionId) actions.noteTurnFacts(sessionId, null)
  }, [sessionId, actions])
  // Sync turn start/end timestamps straight from `log.events` so `FailureCell` settles as
  // soon as a Retry turn starts, even before the new turn emits any assistant text.
  useEffect(() => {
    if (typeof actions?.noteTurnTime !== 'function') return
    for (const event of Array.isArray(log?.events) ? log.events : []) {
      const turn = event?.data?.turn
      if (!Number.isInteger(turn) || !Number.isFinite(event.time)) continue
      if (event.type === 'turn/start') actions.noteTurnTime(sessionId, turn, 'first', event.time)
      else if (event.type === 'turn/end') actions.noteTurnTime(sessionId, turn, 'end', event.time)
    }
    for (const row of rows) {
      if (Number.isInteger(row.turn) && Number.isFinite(row.time)) {
        actions.noteTurnTime(sessionId, row.turn, 'first', row.time)
      }
    }
  }, [log?.events, rows, sessionId, actions])

  const selfId = bot?.id ?? sessionId
  const cwd = log?.header?.cwd
  const showThinking = thinkingShown(roster.prefs)
  const flat = layoutOf(roster.prefs) === 'flat'
  const canLoadEarlierParts = typeof actions?.earlier === 'function'
  const hasPartStart = rows.some(row => row.kind === 'part-start')
  // `bot.parts` holds only earlier segments (host/channel.js), not current `bot.sessionId`.
  // Wait until the opening snapshot lands (`log.header !== null`) before mounting EarlierParts
  // so we never issue wasted RPCs while loading or duplicate a snapshot's `part-start`.
  const showTopEarlierParts = log?.header !== null && !hasMore && !hasPartStart && canLoadEarlierParts && (bot?.parts?.length ?? 0) > 0
  const seenTurnSpeaker = new Set()
  let prevTime

  const projected = rows.flatMap((row) => {
    if (row.kind === 'part-start') {
      prevTime = undefined
      return [canLoadEarlierParts
        ? h(EarlierParts, { key: row.key, sessionId, roster, actions })
        : h(PartLine, { key: row.key, time: row.time })]
    }

    // Track whether a flat-layout turn still needs its opening Bot avatar+name line.
    let showSpeaker = false
    if (row.kind === 'assistant') {
      const visible = row.texts.length > 0 || row.activity.length > 0 || (showThinking && row.reasoning !== '')
      if (!visible) return []
    }
    if (row.kind === 'assistant' || row.kind === 'tool') {
      const turnKey = row.turn ?? row.key
      if (!seenTurnSpeaker.has(turnKey)) {
        seenTurnSpeaker.add(turnKey)
        showSpeaker = true
      }
    }

    const pause = !classic && Number.isFinite(row.time) && (prevTime === undefined || row.time - prevTime >= SEPARATOR_GAP_MS)
    if (Number.isFinite(row.time)) prevTime = row.time

    const renderToolFallback = (ownerProps) => {
      if (typeof isBotTool === 'function' && isBotTool(ownerProps.toolName)) {
        if (ownerProps.toolName === 'show_view' && ownerProps.phase === 'preparing') {
          return h(GenericToolCard, ownerProps)
        }
        return h(ToolCell, {
          node: {
            key: ownerProps.callId || row.key,
            data: { root: { ...ownerProps.block, subCalls: [] } },
            location: { turn: { turn: row.turn } },
          },
          sessionId,
          useRoster: resolvedUseRoster,
          useUi: resolvedUseUi,
          useWork: resolvedUseWork,
          useHeldCards: resolvedUseHeldCards,
          useBrowserHolds: resolvedUseBrowserHolds,
          useBrowserTabs: resolvedUseBrowserTabs,
          useBrowserPages: resolvedUseBrowserPages,
          useComputer: resolvedUseComputer,
          actions,
        })
      }
      return h(GenericToolCard, ownerProps)
    }

    const renderTool = () => h(Fragment, null,
      showSpeaker && flat && bot ? h(SpeakerHead, { bot, time: row.time }) : null,
      h(ToolCallCard, {
        entry: row,
        cwd,
        openFile: actions?.openFile,
        registry,
        fallback: renderToolFallback,
      }))

    const renderDefault = () => {
      switch (row.kind) {
        case 'user': return h(UserRow, { row, sessionId, roster, actions, classic })
        case 'answer': return h(AnsweredReply, { node: { data: row.data } })
        case 'assistant': return h(AssistantRow, { row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt, classic })
        case 'tool': return renderTool()
        case 'compaction': return h(CompactionRow, { row })
        case 'event': return h(SessionEventRow, { row, selfId, roster, actions })
        case 'deliverables': return h(DeliverablesRow, { row, sessionId, onOpenFile: actions?.openFile })
        case 'changes': return h(SessionChangesRow, { row, sessionId, actions })
        case 'turn-error': return h(TurnErrorRow, { row, bot, sessionId, useRoster, useTurnClock, actions })
        case 'turn-tail': return h(TurnTailRow, { row, sessionId, useRoster: resolvedUseRoster, actions })
        default: return null
      }
    }

    const node = h(SlotOutlet, {
      key: row.key,
      registry,
      name: CHAT_NODE_SLOT,
      slotKey: row.kind,
      resetKey: row.key,
      props: { row, sessionId, bot, roster, actions, useUi },
      fallback: renderDefault,
    })

    return pause
      ? [h('div', { key: `${row.key}:clock`, className: 'bt-time-sep', role: 'separator' }, clockLabel(row.time)), node]
      : [node]
  })

  return showTopEarlierParts
    ? [h(EarlierParts, { key: `earlier-parts:${sessionId}`, sessionId, roster, actions }), ...projected]
    : projected
}
