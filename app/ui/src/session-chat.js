// DM current-segment chat over `api/bot/session` (host/session-follow.js) and
// `ds-bot/src/client/session-log.js`: follows DSH frames directly, pages earlier
// messages via `session-page`, bridges earlier segments via `EarlierParts`, and renders
// user messages, settled card replies, Markdown replies, thinking, tool calls
// (via `tool.call.toolview` -> `WidgetCell` for `show_view` / `GenericToolCard`),
// compaction markers, Bot/schedule events, and failed turns (`FailureCell`).
import { createElement as h, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { BtwTurnTail } from '../../../ds-bot/src/client/btw.js'
import { Bubbles, EarlierParts, PartLine, ThinkingRow, ToolCell, isBotTool } from '../../../ds-bot/src/client/cells.js'
import { ChangesCard } from '../../../ds-bot/src/client/changes-card.js'
import { MarkdownText, fileExtension, fileSizeText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { SaveFileAction } from '../../../ds-bot/src/client/file-save.js'
import { FOLD_HUGE, useFold } from '../../../ds-bot/src/client/fold.js'
import { CheckIcon, ChevronRightIcon, CopyIcon, FileIcon, ImageIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { LearningTurnTail } from '../../../ds-bot/src/client/learning-card.js'
import { BotMark, RoomAvatar } from '../../../ds-bot/src/client/mark.js'
import { noHover } from '../../../ds-bot/src/client/motion.js'
import { ReplyGuide } from '../../../ds-bot/src/client/reading.js'
import { addPage, applyFrame, emptyLog, pageBefore, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { clockLabel, messageClock, normalizeFileLinks } from '../../../ds-bot/src/client/text.js'
import { layoutOf, thinkingShown } from '../../../ds-bot/src/client/themes.js'
import { FailureCell, failureText } from '../../../ds-bot/src/client/turn-error.js'
import { ViaTag, contentParts, mentionableBots } from '../../../ds-bot/src/client/user-message.js'
import { AnsweredReply } from '../../../ds-bot/src/client/widget-cell.js'
import { openSessionFollow } from './api.js'
import { ComputerToolView, isComputerToolName } from './browser-computer-tool-views.js'
import { ClassicFeedbackActions, ClassicFeedbackDialog, useSessionFeedback } from './classic-feedback.js'
import { ImageLightbox } from './image-lightbox.js'
import { getAppLocale } from './locale.js'
import { buildSessionRowParts, extractTurnFacts } from './session-transcript.js'
import { CHAT_NODE_SLOT, SlotOutlet, slots as defaultSlots } from './slots.js'
import { resolveSubagentCatalog } from './subagent-job-tool-views.js'
import { UserMessageText, copyableUserText } from './user-text.js'

const NO_LOCALE = () => {}

// Subscribe to the active interface language so memoized transcript rows receive `lang`
// and re-render on a language switch without pulling React into pure `./locale.js`.
function useUiLanguage() {
  const subscribe = useCallback((notify) => {
    const service = getAppLocale()
    return typeof service?.subscribe === 'function' ? service.subscribe(notify) : NO_LOCALE
  }, [])
  const snapshot = useCallback(() => getAppLocale()?.getLocale?.().active ?? 'en', [])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
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

function loadAttachmentImage(sessionId, attachmentId, { parent, mode, ancestors, preview = true } = {}) {
  const ancKey = Array.isArray(ancestors) && ancestors.length > 0 ? ancestors.map(a => a.sessionId).join('>') : ''
  const key = `${sessionId}:${parent ?? ''}:${mode ?? ''}:${ancKey}:${attachmentId}:${preview ? 'p' : 'f'}`
  if (imageCache.has(key)) {
    const cached = imageCache.get(key)
    rememberImage(key, cached)
    return Promise.resolve(cached)
  }
  const existing = imageInflight.get(key)
  if (existing) return existing
  const params = {
    sessionId,
    attachmentId,
    preview,
    ...(parent ? { parent } : {}),
    ...(mode ? { mode } : {}),
    ...(Array.isArray(ancestors) && ancestors.length > 0 ? { ancestors } : {}),
  }
  const promise = Promise.resolve(call('image', params))
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
export function useSessionFollow({ sessionId, parent, mode, enabled, feed, readOnly, onUserMessage, keep, openFollow = openSessionFollow }) {
  const [state, setState] = useState(() => ({
    log: emptyLog(),
    thinkingAt: {},
    loading: enabled,
    paging: false,
    failed: false,
    pageFailed: false,
    terminalError: null,
    historyReloaded: false,
  }))
  const logRef = useRef(emptyLog())
  const followRef = useRef(null)
  const genRef = useRef(0)
  const pagingRef = useRef(false)
  const openedRef = useRef(false)
  const resyncRef = useRef(false)
  const seenUserSeqsRef = useRef(new Set())
  const onUserRef = useRef(onUserMessage)
  onUserRef.current = onUserMessage
  const openFollowRef = useRef(openFollow)
  openFollowRef.current = openFollow

  useEffect(() => {
    const myGen = ++genRef.current
    pagingRef.current = false
    openedRef.current = false
    resyncRef.current = false
    seenUserSeqsRef.current = new Set()
    const fresh = emptyLog()
    logRef.current = fresh
    setState({ log: fresh, thinkingAt: {}, loading: enabled, paging: false, failed: false, pageFailed: false, terminalError: null, historyReloaded: false })
    if (!enabled || !sessionId) return undefined

    const handle = openFollowRef.current({
      sessionId,
      ...(parent ? { parent } : {}),
      ...(mode ? { mode } : {}),
      max: PAGE_SIZE,
      after: () => (resyncRef.current ? undefined : logRef.current.cursor),
    }, (event, data) => {
      if (genRef.current !== myGen) return
      if (event === 'frame') {
        const resyncing = data?.type === 'snapshot' && resyncRef.current
        const next = applyFrame(resyncing ? emptyLog() : logRef.current, data)
        if (resyncing) resyncRef.current = false
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
          historyReloaded: current.historyReloaded || resyncing,
        }))
        if (next.reopen) followRef.current?.reopen()
      } else if (event === 'error') {
        if (data?.code === 'bot/stale' && !resyncRef.current) {
          // The durable log no longer reaches this window's cursor. Reopen once without
          // `after`; the fresh opening replaces the rows instead of looping on that cursor.
          resyncRef.current = true
          followRef.current?.reopen()
          return
        }
        const terminal = data?.code === 'bot/not-found' || data?.code === 'bot/refused' || data?.code === 'bot/invalid' || data?.code === 'bot/stale'
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
  }, [sessionId, parent, mode, enabled])

  // Read-only windows only receive the opening snapshot from DSH (host/session-follow.js):
  // reopen when the team live feed reports a revision or reconnects.
  useEffect(() => {
    if (!enabled || !sessionId || !feed) return undefined
    return feed.on((event) => {
      if (readOnly && (event === 'revision' || event === 'hello')) followRef.current?.reopen()
    })
  }, [enabled, sessionId, parent, mode, feed, readOnly])

  const loadEarlier = useCallback(async (scroller) => {
    if (!enabled || !sessionId || pagingRef.current) return
    const beforeSeq = pageBefore(logRef.current)
    if (beforeSeq === undefined) return
    const myGen = genRef.current
    pagingRef.current = true
    setState(current => ({ ...current, paging: true, pageFailed: false }))
    try {
      const page = await call('session-page', {
        sessionId,
        ...(parent ? { parent } : {}),
        ...(mode ? { mode } : {}),
        beforeSeq,
        maxMessages: PAGE_SIZE,
      })
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
  }, [enabled, sessionId, parent, mode, keep])

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
    historyReloaded: state.historyReloaded,
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

function UserImageThumb({ sessionId, parent, mode, ancestors, attachment }) {
  const name = attachment?.name || t('Image')
  const direct = attachment?.previewUrl ?? null
  const attachmentId = attachment?.attachmentId
  const ancKey = Array.isArray(ancestors) && ancestors.length > 0 ? ancestors.map(a => a.sessionId).join('>') : ''
  const cacheKey = `${sessionId}:${parent ?? ''}:${mode ?? ''}:${ancKey}:${attachmentId}:p`
  const cached = !direct && sessionId && attachmentId ? imageCache.get(cacheKey) ?? null : null
  const [loaded, setLoaded] = useState(cached)
  const [zoomed, setZoomed] = useState(false)
  const src = direct ?? loaded

  useEffect(() => {
    if (direct || !sessionId || !attachmentId) return undefined
    if (imageCache.has(cacheKey)) {
      setLoaded(imageCache.get(cacheKey))
      return undefined
    }
    let alive = true
    void loadAttachmentImage(sessionId, attachmentId, { parent, mode, ancestors, preview: true }).then((url) => {
      if (alive && url) setLoaded(url)
    })
    return () => { alive = false }
  }, [direct, sessionId, parent, mode, ancestors, attachmentId, cacheKey])

  if (!src) {
    return h('span', { className: 'bt-ufile', title: name },
      h('span', { className: 'dsb-ufile-icon', 'aria-hidden': true }, h(ImageIcon)),
      h('span', { className: 'bt-ufile-text' }, h('span', { className: 'bt-ufile-name' }, name)))
  }
  const loadFull = !direct && sessionId && attachmentId
    ? () => loadAttachmentImage(sessionId, attachmentId, { parent, mode, ancestors, preview: false })
    : undefined
  return h(Fragment, null,
    h('button', {
      type: 'button',
      className: 'dsb-uimg-btn',
      title: name,
      'aria-label': name,
      onClick: () => setZoomed(true),
    }, h('img', { className: 'dsb-uimg', src, alt: name, loading: 'lazy' })),
    h(ImageLightbox, { open: zoomed, src, loadFull, alt: name, onClose: () => setZoomed(false) }))
}

export function UserAttachments({ attachments, sessionId, parent, mode, ancestors }) {
  if (!attachments || attachments.length === 0) return null
  return h('div', { className: 'bt-uattach' }, attachments.map((block, index) => {
    const file = block.attachment ?? {}
    if (block.type === 'image') {
      return h(UserImageThumb, { key: file.attachmentId ?? file.previewUrl ?? index, sessionId, parent, mode, ancestors, attachment: file })
    }
    const meta = [fileExtension(file.name)?.toUpperCase().slice(0, 8), fileSizeText(file.bytes)].filter(Boolean).join(' · ')
    const fallbackName = file.name || t('File')
    return h('span', { key: file.attachmentId ?? `${fallbackName}:${index}`, className: 'bt-ufile', title: fallbackName },
      h('span', { className: 'dsb-ufile-icon', 'aria-hidden': true }, h(FileIcon)),
      h('span', { className: 'bt-ufile-text' },
        h('span', { className: 'bt-ufile-name' }, fallbackName),
        meta ? h('span', { className: 'bt-ufile-meta' }, meta) : null))
  }))
}

// Message rows are memoized: while a reply streams in, the transcript rebuilds per chunk
// but the rows before it are the very same objects (the committed-row cache in
// session-transcript.js), so a memoized row renders once and the stream never re-renders
// the history behind it. Roster, actions, bot, hooks and thinkingAt keep their object
// identity across stream chunks, which is what the memo relies on.
const UserRow = memo(function UserRow({ row, sessionId, parent, mode, ancestors, roster, actions, classic = false, onOpenFile, onRevealFolder }) {
  const { shown, folded, control } = useFold(row.text ?? '', { markdown: false })
  const container = useRef(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [revealedSecrets, setRevealedSecrets] = useState(() => new Set())
  useEffect(() => {
    setRevealedSecrets(prev => (prev.size === 0 ? prev : new Set()))
  }, [row.text])
  useEffect(() => {
    if (!toolsOpen) return undefined
    const onDown = (event) => { if (!container.current?.contains(event.target)) setToolsOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown) }
  }, [toolsOpen])
  const toggleSecret = useCallback((key) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const copyText = useMemo(() => copyableUserText(row.text ?? '', revealedSecrets), [row.text, revealedSecrets])
  const bots = useMemo(
    () => (Array.isArray(roster?.bots) ? mentionableBots(roster, sessionId) : []),
    [roster, sessionId],
  )
  const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0
  if (row.text === '' && !hasAttachments) return null
  const tapTools = (event) => {
    if (!noHover() || (event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]'))) return
    setToolsOpen(value => !value)
  }
  const body = h(UserMessageText, {
    text: shown,
    fullText: row.text ?? '',
    bots,
    revealedSecrets,
    onToggleSecret: toggleSecret,
    onOpenBot: actions?.openSession,
    onOpenFile,
    onRevealFolder,
  })
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
      h(UserAttachments, { attachments: row.attachments, sessionId, parent, mode, ancestors }),
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
      row.text !== '' ? h(CopyTextButton, { text: copyText, className: 'dsb-dsh-act-btn' }) : null) : null)
  }
  return h('div', { ref: container, className: 'bt-umsg' },
    h('div', { className: 'bt-ustack' },
      h(UserAttachments, { attachments: row.attachments, sessionId, parent, mode, ancestors }),
      row.text !== '' ? h('div', { className: 'bt-ubody', title: timeTitle, 'data-folded': folded || undefined, 'data-text-interaction-source': '', onClick: tapTools },
        control ? h('div', { className: 'bt-fold-body' }, body) : body,
        control) : null,
      (sentAt || row.via) ? h('div', { className: 'bt-utime', title: timeTitle },
        row.via ? h(ViaTag, { via: row.via }) : null,
        sentAt) : null),
    row.text === '' ? null : h('div', { className: 'bt-utools', 'data-open': toolsOpen || undefined }, h(CopyTextButton, { text: copyText })))
})

const CompactionRow = memo(function CompactionRow({ row }) {
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
})

const SessionEventRow = memo(function SessionEventRow({ row, selfId, roster, actions }) {
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
})

const activityParts = line => line.split('`').map((part, index) => (index % 2 === 1 ? h('code', { key: index }, part) : part))

function SpeakerHead({ bot, time }) {
  return h('div', { className: 'bt-group-name' },
    h('span', { className: 'bt-lead' }, h(BotMark, { bot, size: 22 })), bot.name,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null)
}

const AssistantRow = memo(function AssistantRow({
  row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt, lang, classic = false, readOnly = false,
  onOpenFile, onRevealFolder, fileMentions,
  feedbackAvailable = false, feedbackItem = null, feedbackPending = false, onSelectFeedback, onRetractFeedback,
}) {
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
  const classicBodyRef = useRef(null)

  const hasThinking = showThinking && row.reasoning !== ''
  const hasActivity = row.activity.length > 0
  const hasTexts = row.texts.length > 0
  if (!hasThinking && !hasActivity && !hasTexts) return null
  const liveAt = row.thinkingLive ? thinkingAt?.[row.attemptId ?? 'live'] : undefined
  if (classic) {
    const combinedText = row.texts.join('\n\n')
    const mdLabels = { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') } }
    const hasTime = Number.isFinite(row.time)
    const showFeedback = !row.streaming && feedbackAvailable && typeof row.messageId === 'string' && row.messageId !== ''
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
      h('div', {
        ref: classicBodyRef,
        className: 'dsb-dsh-asst-body',
        'data-text-interaction-source': !row.streaming ? '' : undefined,
      },
      row.texts.map((text, index) => h(MarkdownText, {
        key: index,
        text: normalizeFileLinks(text),
        labels: mdLabels,
        streaming: row.streaming && index === row.texts.length - 1,
        onOpenFile,
        onRevealFolder,
        fileMentions,
      }))),
      h(ReplyGuide, { box: classicBodyRef, active: !row.streaming }),
      !row.streaming ? h('div', { className: 'dsb-dsh-asst-actions' },
        h(CopyTextButton, { text: combinedText, className: 'dsb-dsh-act-btn' }),
        showFeedback ? h(ClassicFeedbackActions, {
          messageId: row.messageId,
          item: feedbackItem,
          pending: feedbackPending,
          readOnly: Boolean(readOnly || roster?.readOnly),
          onSelect: onSelectFeedback,
          onRetract: onRetractFeedback,
        }) : null,
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
      mentions: fileMentions,
      useUi,
      lang,
      fold: FOLD_HUGE,
      time: flat || row.streaming ? undefined : row.time,
      textInteractionSource: !row.streaming,
    }) : null)
})

const TurnErrorRow = memo(function TurnErrorRow({ row, bot, sessionId, useRoster, useTurnClock, actions }) {
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
})


// A tool row, memoized like the message rows: the fallback closures exist only when the
// row itself renders, so a committed tool card renders once per roster or language change
// and never per stream chunk. `lang` rides along because the cards carry translated copy.
const SessionToolRow = memo(function SessionToolRow({
  row, showSpeaker, flat, bot, cwd, sessionId, roster, actions, registry, lang,
  loadImage, feed, readOnly, subagentCatalog, onOpenSubagent,
  useRoster, useUi, useWork, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer,
}) {
  const toolHooks = useMemo(
    () => ({ useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer }),
    [useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer],
  )
  const renderToolFallback = (ownerProps) => {
    if (isComputerToolName(ownerProps.toolName)) {
      return h(ComputerToolView, ownerProps)
    }
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
        useRoster,
        useUi,
        useWork,
        useHeldCards,
        useBrowserHolds,
        useBrowserTabs,
        useBrowserPages,
        useComputer,
        actions,
      })
    }
    return h(GenericToolCard, ownerProps)
  }

  return h(Fragment, null,
    showSpeaker && flat && bot ? h(SpeakerHead, { bot, time: row.time }) : null,
    h(ToolCallCard, {
      entry: row,
      cwd,
      openFile: actions?.openFile,
      loadImage,
      sessionId,
      botId: bot?.id,
      roster,
      actions,
      feed,
      readOnly,
      hooks: toolHooks,
      subagentCatalog,
      onOpenSubagent,
      registry,
      fallback: renderToolFallback,
    }))
})

/**
 * Renders the projected DM session transcript (earlier segments via EarlierParts,
 * time separators, user messages, settled card replies, thinking, Markdown replies,
 * tool call cards via `tool.call.toolview` / DS Bot `ToolCell` / `GenericToolCard`,
 * compaction checkpoints, Bot/schedule events, and failed turns).
 */
const DeliverablesRow = memo(function DeliverablesRow({ row, sessionId, onOpenFile }) {
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
})

function turnFactsSignature(facts) {
  if (!facts?.turns) return ''
  const parts = [`open:${facts.openTurn ?? ''}`]
  for (const entry of facts.turns.values()) {
    parts.push(`${entry.turn}:${entry.status}:${entry.start?.seq ?? ''}:${entry.start?.time ?? ''}:${entry.end?.seq ?? ''}:${entry.end?.time ?? ''}`)
  }
  return parts.join('|')
}

const SessionChangesRow = memo(function SessionChangesRow({ row, sessionId, actions }) {
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
})

const TurnTailRow = memo(function TurnTailRow({ row, sessionId, useRoster, actions }) {
  if (typeof actions?.turnFacts !== 'function' || typeof actions?.watchTurns !== 'function') return null
  return h(Fragment, null,
    h(BtwTurnTail, { turn: row.turnInfo, sessionId, useRoster, actions }),
    h(LearningTurnTail, { turn: row.turnInfo, sessionId, useRoster, actions }))
})


const EMPTY_SPEAKERS = new Set()

function renderTranscriptRows({
  rows, initialSpeakers = EMPTY_SPEAKERS, canLoadEarlierParts,
  sessionId, bot, roster, actions, classic, useUi, useRoster, useTurnClock, useWork, useHeldCards,
  useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, thinkingAt, registry, lang,
  resolvedUseRoster, resolvedUseUi, resolvedUseWork, resolvedUseHeldCards,
  resolvedUseBrowserHolds, resolvedUseBrowserTabs, resolvedUseBrowserPages, resolvedUseComputer,
  selfId, cwd, showThinking, flat,
  openSessionFile, revealSessionFolder, turnFileMentions, feedback,
  onSelectFeedback, onRetractFeedback, renderEarlierUserText,
  parent, mode, ancestors, safeRoster, loadImage, feed, readOnly, subagentCatalog, onOpenSubagent,
}) {
  const seenTurnSpeaker = new Set(initialSpeakers)
  let prevTime

  return rows.flatMap((row) => {
    if (row.kind === 'part-start') {
      prevTime = undefined
      return [canLoadEarlierParts
        ? h(EarlierParts, { key: row.key, sessionId, roster, actions, renderUserText: renderEarlierUserText })
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

    const renderDefault = () => {
      switch (row.kind) {
        case 'user': return h(UserRow, { row, sessionId, parent, mode, ancestors, roster, actions, lang, classic, onOpenFile: openSessionFile, onRevealFolder: revealSessionFolder })
        case 'answer': return h(AnsweredReply, { node: { data: row.data } })
        case 'assistant': {
          const feedbackEnabled = Boolean(classic && !readOnly && !parent)
          return h(AssistantRow, {
            row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt, lang, classic, readOnly,
            onOpenFile: openSessionFile,
            onRevealFolder: revealSessionFolder,
            fileMentions: turnFileMentions.get(row.turn ?? 'none'),
            feedbackAvailable: feedbackEnabled && feedback.available,
            feedbackItem: feedbackEnabled && row.messageId ? (feedback.items.get(row.messageId) ?? null) : null,
            feedbackPending: feedbackEnabled && row.messageId ? feedback.pendingIds.has(row.messageId) : false,
            onSelectFeedback,
            onRetractFeedback,
          })
        }
        case 'tool': return h(SessionToolRow, {
          row, showSpeaker, flat, bot, cwd, sessionId, roster: safeRoster, actions, registry, lang,
          loadImage, feed, readOnly, subagentCatalog, onOpenSubagent,
          useRoster: resolvedUseRoster, useUi: resolvedUseUi, useWork: resolvedUseWork,
          useHeldCards: resolvedUseHeldCards, useBrowserHolds: resolvedUseBrowserHolds,
          useBrowserTabs: resolvedUseBrowserTabs, useBrowserPages: resolvedUseBrowserPages,
          useComputer: resolvedUseComputer,
        })
        case 'compaction': return h(CompactionRow, { row, lang })
        case 'event': return h(SessionEventRow, { row, selfId, roster, actions, lang })
        case 'deliverables': return h(DeliverablesRow, { row, sessionId, onOpenFile: openSessionFile, lang })
        case 'changes': return h(SessionChangesRow, { row, sessionId, actions, lang })
        case 'turn-error': return h(TurnErrorRow, { row, bot, sessionId, useRoster, useTurnClock, actions, lang })
        case 'turn-tail': return h(TurnTailRow, { row, sessionId, useRoster: resolvedUseRoster, actions, lang })
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
}

export function SessionTranscript({
  log, sessionId, parent, mode, ancestors, bot, roster, actions, classic = false, feed, readOnly = false, onOpenSubagent,
  useUi, useRoster, useWork, useTurnClock, useHeldCards,
  useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer,
  thinkingAt, hasMore = false, registry = defaultSlots,
}) {
  // The memoized rows read `t()` at render time, so the language travels as a prop:
  // a switch re-renders them in the new language, and a stream chunk never changes it.
  const lang = useUiLanguage()
  const rowParts = useMemo(() => buildSessionRowParts(log, { roster, sessionId }), [log, roster, sessionId])
  const subagentCatalog = useMemo(() => resolveSubagentCatalog(log), [log])
  const loadImage = useCallback(
    (attachmentId, options) => loadAttachmentImage(sessionId, attachmentId, { parent, mode, ancestors, preview: options?.preview ?? true }),
    [sessionId, parent, mode, ancestors],
  )
  const turnFacts = useMemo(() => extractTurnFacts(log?.events, { roster, sessionId }), [log?.events, roster, sessionId])
  const turnSig = useMemo(() => turnFactsSignature(turnFacts), [turnFacts])
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
  // soon as a Retry turn starts, even before the new turn emits any assistant text. A
  // stream chunk replaces neither the events array nor any committed row (the cache in
  // session-transcript.js), and writing rows carry no time, so when the events array is
  // the same one the effect already noted there is nothing new to note and it skips.
  const notedEventsRef = useRef(null)
  useEffect(() => {
    if (typeof actions?.noteTurnTime !== 'function') return
    const prev = notedEventsRef.current
    if (log?.events !== undefined
      && prev !== null
      && prev.events === log.events
      && prev.sessionId === sessionId
      && prev.noteTurnTime === actions.noteTurnTime) return
    notedEventsRef.current = { events: log?.events ?? null, sessionId, noteTurnTime: actions.noteTurnTime }
    for (const event of Array.isArray(log?.events) ? log.events : []) {
      const turn = event?.data?.turn
      if (!Number.isInteger(turn) || !Number.isFinite(event.time)) continue
      if (event.type === 'turn/start') actions.noteTurnTime(sessionId, turn, 'first', event.time)
      else if (event.type === 'turn/end') actions.noteTurnTime(sessionId, turn, 'end', event.time)
    }
    for (const row of rowParts.committed) {
      if (Number.isInteger(row.turn) && Number.isFinite(row.time)) {
        actions.noteTurnTime(sessionId, row.turn, 'first', row.time)
      }
    }
  }, [log?.events, rowParts.committed, sessionId, actions])

  const selfId = bot?.id ?? sessionId
  const cwd = log?.header?.cwd
  const showThinking = thinkingShown(roster.prefs)
  const flat = layoutOf(roster.prefs) === 'flat'
  const canLoadEarlierParts = typeof actions?.earlier === 'function'
  const hasPartStart = useMemo(() => rowParts.committed.some(row => row.kind === 'part-start'), [rowParts.committed])
  const openSessionFile = useMemo(() => (typeof actions?.openFile === 'function'
    ? target => actions.openFile(typeof target === 'string'
      ? { path: target, sessionId }
      : { ...target, sessionId: target?.sessionId ?? sessionId })
    : undefined), [actions, sessionId])
  const revealSessionFolder = useMemo(() => (typeof actions?.revealFolder === 'function'
    ? target => actions.revealFolder(typeof target === 'string'
      ? { path: target, sessionId }
      : { ...target, sessionId: target?.sessionId ?? sessionId })
    : openSessionFile
      ? target => openSessionFile(typeof target === 'string' ? { path: target, isDir: true } : { ...target, isDir: true })
      : undefined), [actions, sessionId, openSessionFile])

  // Build per-turn delivered file maps from committed `log.events` (not `rows`) so stream
  // chunks keep identical Map references and never invalidate memoized committed rows.
  const turnFileMentions = useMemo(() => {
    const byTurn = new Map()
    for (const item of Array.isArray(log?.events) ? log.events : []) {
      if (item?.type !== 'deliverables/presented' || !Array.isArray(item.data?.files)) continue
      const key = item.data?.turn ?? 'none'
      let map = byTurn.get(key)
      if (!map) { map = new Map(); byTurn.set(key, map) }
      for (const file of item.data.files) {
        if (!file?.path) continue
        const entry = { path: file.path, display: file.path }
        map.set(file.path, entry)
        const base = String(file.path).split(/[\\/]/).filter(Boolean).at(-1)
        if (base && !map.has(base)) map.set(base, entry)
      }
    }
    return byTurn
  }, [log?.events])

  // Classic Agent reply feedback (strictly top-level Classic sessions; read-only child subagent views never show rating controls).
  const feedbackEnabled = Boolean(classic && !readOnly && !parent)
  const feedback = useSessionFeedback(sessionId, feedbackEnabled)
  const { retract: retractFeedback, submit: submitFeedback } = feedback
  const [feedbackDraft, setFeedbackDraft] = useState(null)
  const [feedbackError, setFeedbackError] = useState('')
  useEffect(() => {
    setFeedbackDraft(null)
    setFeedbackError('')
  }, [sessionId, feedbackEnabled])
  const handleSelectFeedback = useCallback((messageId, rating) => {
    setFeedbackError('')
    setFeedbackDraft({ messageId, rating })
  }, [])
  const handleRetractFeedback = useCallback(async (messageId) => {
    const res = await retractFeedback(messageId)
    if (!res?.ok && res?.message) actions?.notice?.(res.message)
  }, [retractFeedback, actions])
  const handleSubmitFeedback = useCallback(async ({ messageId, rating, category, note }) => {
    setFeedbackError('')
    const res = await submitFeedback(messageId, { rating, category, note })
    if (res?.ok) {
      setFeedbackDraft(null)
    } else if (res?.message) {
      setFeedbackError(res.message)
    }
  }, [submitFeedback])

  const earlierMentionBots = useMemo(
    () => (Array.isArray(roster?.bots) ? mentionableBots(roster, sessionId) : []),
    [roster, sessionId],
  )
  const renderEarlierUserText = useCallback(({ text, fullText, revealedSecrets, onToggleSecret }) => h(UserMessageText, {
    text,
    fullText,
    bots: earlierMentionBots,
    revealedSecrets,
    onToggleSecret,
    onOpenBot: actions?.openSession,
    onOpenFile: openSessionFile,
    onRevealFolder: revealSessionFolder,
  }), [earlierMentionBots, actions, openSessionFile, revealSessionFolder])

  // `bot.parts` holds only earlier segments (host/channel.js), not current `bot.sessionId`.
  // Wait until the opening snapshot lands (`log.header !== null`) before mounting EarlierParts
  // so we never issue wasted RPCs while loading or duplicate a snapshot's `part-start`.
  const showTopEarlierParts = log?.header !== null && !hasMore && !hasPartStart && canLoadEarlierParts && (bot?.parts?.length ?? 0) > 0
  const committedSpeakers = useMemo(() => {
    const speakers = new Set()
    for (const row of rowParts.committed) {
      if (row.kind === 'assistant') {
        if (row.texts.length === 0 && row.activity.length === 0 && !(showThinking && row.reasoning !== '')) continue
      } else if (row.kind !== 'tool') continue
      speakers.add(row.turn ?? row.key)
    }
    return speakers
  }, [rowParts.committed, showThinking])
  const rowProps = {
    canLoadEarlierParts, sessionId, bot, roster, actions, classic, useUi, useRoster, useTurnClock, useWork, useHeldCards,
    useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, thinkingAt, registry, lang,
    resolvedUseRoster, resolvedUseUi, resolvedUseWork, resolvedUseHeldCards,
    resolvedUseBrowserHolds, resolvedUseBrowserTabs, resolvedUseBrowserPages, resolvedUseComputer,
    selfId, cwd, showThinking, flat,
    openSessionFile, revealSessionFolder, turnFileMentions, feedback,
    onSelectFeedback: handleSelectFeedback, onRetractFeedback: handleRetractFeedback, renderEarlierUserText,
    parent, mode, ancestors, safeRoster, loadImage, feed, readOnly, subagentCatalog, onOpenSubagent,
  }

  // Committed and live rows must be siblings in one keyed list: a live tool call that
  // commits keeps the same component instance instead of unmounting into another subtree.
  // The committed elements are memoized without `thinkingAt`, so stream chunks and
  // reasoning clocks never repaint finished history.
  const committedElements = useMemo(() => renderTranscriptRows({
    ...rowProps,
    thinkingAt: undefined,
    rows: rowParts.committed,
  }), [
    rowParts.committed, canLoadEarlierParts, sessionId, bot, roster, actions, classic,
    useUi, useRoster, useTurnClock, useWork, useHeldCards,
    useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, registry, lang,
    resolvedUseRoster, resolvedUseUi, resolvedUseWork, resolvedUseHeldCards,
    resolvedUseBrowserHolds, resolvedUseBrowserTabs, resolvedUseBrowserPages, resolvedUseComputer,
    selfId, cwd, showThinking, flat,
    openSessionFile, revealSessionFolder, turnFileMentions, feedback,
    handleSelectFeedback, handleRetractFeedback, renderEarlierUserText,
    parent, mode, ancestors, safeRoster, loadImage, feed, readOnly, subagentCatalog, onOpenSubagent,
  ])
  const liveElements = rowParts.live.length === 0
    ? []
    : renderTranscriptRows({ ...rowProps, rows: rowParts.live, initialSpeakers: committedSpeakers })
  const projected = [...committedElements, ...liveElements]

  const feedbackDialog = feedbackEnabled ? h(ClassicFeedbackDialog, {
    key: 'classic-feedback-dialog',
    draft: feedbackDraft,
    current: feedbackDraft ? (feedback.items.get(feedbackDraft.messageId) ?? null) : null,
    pending: feedbackDraft ? feedback.pendingIds.has(feedbackDraft.messageId) : false,
    error: feedbackError,
    onClose: () => { setFeedbackDraft(null); setFeedbackError('') },
    onSubmit: handleSubmitFeedback,
  }) : null

  return [
    ...(showTopEarlierParts ? [h(EarlierParts, { key: `earlier-parts:${sessionId}`, sessionId, roster, actions, renderUserText: renderEarlierUserText })] : []),
    ...projected,
    ...(feedbackDialog ? [feedbackDialog] : []),
  ]
}
