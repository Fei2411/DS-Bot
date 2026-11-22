// DM current-segment chat over `api/bot/session` (host/session-follow.js) and
// `ds-bot/src/client/session-log.js`: follows DSH frames directly, pages earlier
// messages via `session-page`, and renders user messages, Markdown replies, thinking,
// tool calls (via `tool.call.toolview` -> GenericToolCard), compaction markers, and events.
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { Bubbles, ThinkingRow } from '../../../ds-bot/src/client/cells.js'
import { FOLD_HUGE, useFold } from '../../../ds-bot/src/client/fold.js'
import { CheckIcon, ChevronRightIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { BotMark, RoomAvatar } from '../../../ds-bot/src/client/mark.js'
import { noHover } from '../../../ds-bot/src/client/motion.js'
import { addPage, applyFrame, emptyLog, pageBefore, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { clockLabel, messageClock } from '../../../ds-bot/src/client/text.js'
import { layoutOf, thinkingShown } from '../../../ds-bot/src/client/themes.js'
import { FailureCell, failureText } from '../../../ds-bot/src/client/turn-error.js'
import { ViaTag, contentParts, mentionableBots, userTextParts } from '../../../ds-bot/src/client/user-message.js'
import { openSessionFollow } from './api.js'
import { fileExtension, fileSizeText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { buildSessionRows } from './session-transcript.js'
import { CHAT_NODE_SLOT, SlotOutlet, slots as defaultSlots } from './slots.js'
import { ToolCallCard } from './tool-card.js'

const PAGE_SIZE = 40
const SEPARATOR_GAP_MS = 30 * 60 * 1000

const userTextOf = event => contentParts(event?.data?.content).text

function collectUserEvents(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') out.push(event)
  }
  return out
}

/**
 * Follows one Bot's current Session via `api/bot/session` and pages older records
 * via `session-page`, keeping `SessionLog` in sync across reconnects and read-only updates.
 */
export function useSessionFollow({ sessionId, enabled, feed, readOnly, onUserMessage, keep, openFollow = openSessionFollow }) {
  const [state, setState] = useState(() => ({
    log: emptyLog(),
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
  const thinkingAtRef = useRef(new Map())
  const onUserRef = useRef(onUserMessage)
  onUserRef.current = onUserMessage
  const openFollowRef = useRef(openFollow)
  openFollowRef.current = openFollow

  useEffect(() => {
    const myGen = ++genRef.current
    pagingRef.current = false
    openedRef.current = false
    seenUserSeqsRef.current = new Set()
    thinkingAtRef.current = new Map()
    const fresh = emptyLog()
    logRef.current = fresh
    setState({ log: fresh, loading: enabled, paging: false, failed: false, pageFailed: false, terminalError: null })
    if (!enabled || !sessionId) return undefined

    const recordThinkingStart = (log) => {
      const writing = log.writing
      if (!writing) {
        thinkingAtRef.current.clear()
        return
      }
      const attemptId = writing.attemptId ?? 'live'
      if (thinkingAtRef.current.has(attemptId)) return
      const blocks = writingBlocks(log)
      if (blocks.some(block => block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '')) {
        thinkingAtRef.current.set(attemptId, Date.now())
      }
    }

    const handle = openFollowRef.current({ sessionId, max: PAGE_SIZE }, (event, data) => {
      if (genRef.current !== myGen) return
      if (event === 'frame') {
        const next = applyFrame(logRef.current, data)
        logRef.current = next.log
        recordThinkingStart(next.log)
        // Notify new user messages so optimistic pending bubbles clear one-for-one without
        // matching historical duplicates.
        if (data?.type === 'snapshot') {
          const initial = !openedRef.current
          openedRef.current = true
          const users = collectUserEvents(data.records?.map(record => record.event))
          for (const userEv of users) {
            if (seenUserSeqsRef.current.has(userEv.seq)) continue
            seenUserSeqsRef.current.add(userEv.seq)
            onUserRef.current?.(userTextOf(userEv), userEv.time, initial)
          }
        } else if (data?.type === 'event' && data.event?.type === 'user/message' && data.event.data?.source?.kind === 'user') {
          if (!seenUserSeqsRef.current.has(data.event.seq)) {
            seenUserSeqsRef.current.add(data.event.seq)
            onUserRef.current?.(userTextOf(data.event), data.event.time, false)
          }
        }
        setState(current => ({ ...current, log: next.log, loading: false, failed: false, terminalError: null }))
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
      for (const userEv of collectUserEvents(page?.records?.map(record => record.event))) {
        seenUserSeqsRef.current.add(userEv.seq)
      }
      if (scroller && keep) keep.current = scroller.scrollHeight - scroller.scrollTop
      const next = addPage(logRef.current, page)
      logRef.current = next
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
    thinkingAt: thinkingAtRef.current,
    loadEarlier,
    retry,
  }
}

function CopyTextButton({ text }) {
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
    className: 'bt-tool',
    'aria-label': copied ? t('Copied') : t('Copy'),
    title: copied ? t('Copied') : t('Copy'),
    onClick: copy,
  }, copied ? h(CheckIcon) : h(CopyIcon))
}

function UserAttachments({ attachments }) {
  if (!attachments || attachments.length === 0) return null
  return h('div', { className: 'bt-uattach' }, attachments.map((block, index) => {
    const file = block.attachment ?? {}
    if (block.type === 'image') {
      const name = file.name || t('1 image')
      return h('span', { key: index, className: 'bt-ufile', title: name },
        h('span', { className: 'bt-ufile-text' }, h('span', { className: 'bt-ufile-name' }, name)))
    }
    const meta = [fileExtension(file.name)?.toUpperCase().slice(0, 8), fileSizeText(file.bytes)].filter(Boolean).join(' · ')
    return h('span', { key: index, className: 'bt-ufile', title: file.name },
      h('span', { className: 'bt-ufile-text' },
        h('span', { className: 'bt-ufile-name' }, file.name || 'file'),
        meta ? h('span', { className: 'bt-ufile-meta' }, meta) : null))
  }))
}

function UserRow({ row, sessionId, roster, actions }) {
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
  const tapTools = (event) => {
    if (!noHover() || (event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]'))) return
    setToolsOpen(value => !value)
  }
  const bots = Array.isArray(roster?.bots) ? mentionableBots(roster, sessionId) : []
  const body = userTextParts(shown, bots).map((part, index) => (part.bot
    ? h('button', { key: index, type: 'button', className: 'bt-umention', title: `@${part.bot.name}`, onClick: () => actions.openSession(part.bot.id) },
      h(BotMark, { bot: part.bot, size: 16 }), part.label)
    : h(Fragment, { key: index }, part.text)))
  const sentAt = Number.isFinite(row.time) ? messageClock(row.time) : undefined
  return h('div', { ref: container, className: 'bt-umsg' },
    h('div', { className: 'bt-ustack' },
      h(UserAttachments, { attachments: row.attachments }),
      row.text !== '' ? h('div', { className: 'bt-ubody', title: clockLabel(row.time), 'data-folded': folded || undefined, 'data-text-interaction-source': '', onClick: tapTools },
        control ? h('div', { className: 'bt-fold-body' }, body) : body,
        control) : null,
      (sentAt || row.via) ? h('div', { className: 'bt-utime', title: clockLabel(row.time) },
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

function AssistantRow({ row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt }) {
  const showThinking = thinkingShown(roster.prefs)
  const selfId = bot?.id ?? sessionId
  const flat = layoutOf(roster.prefs) === 'flat'
  const hasThinking = showThinking && row.reasoning !== ''
  const hasActivity = row.activity.length > 0
  const hasTexts = row.texts.length > 0
  if (!hasThinking && !hasActivity && !hasTexts) return null
  const liveAt = row.thinkingLive ? thinkingAt?.get?.(row.attemptId ?? 'live') : undefined
  return h(Fragment, null,
    showSpeaker && flat && bot ? h(SpeakerHead, { bot, time: row.time }) : null,
    hasActivity ? h('div', { className: 'bt-agent-activity' }, row.activity.map((line, index) => h('div', { key: index, className: 'bt-agent-act', title: line },
      h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }),
      h('span', { className: 'bt-agent-act-text' }, activityParts(line))))) : null,
    hasThinking ? h(ThinkingRow, {
      text: row.reasoning,
      live: row.thinkingLive,
      viewKey: `${sessionId}:${row.turn ?? row.seq ?? row.attemptId ?? 'live'}`,
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
      msgKey: row.streaming ? undefined : `${sessionId}:${row.turn ?? ''}:${row.seq ?? ''}`,
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
  return h('div', { className: 'bt-fail', 'data-settled': '', role: 'status', title: row.error?.message || code || undefined },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)))
}

/**
 * Renders the projected DM session transcript (time separators, user messages,
 * thinking, Markdown replies, tool call cards via `tool.call.toolview`, compaction
 * checkpoints, Bot/schedule events, and turn errors).
 */
export function SessionTranscript({ log, sessionId, bot, roster, actions, useUi, useRoster, useTurnClock, thinkingAt, registry = defaultSlots }) {
  const rows = useMemo(() => buildSessionRows(log, { roster, sessionId }), [log, roster, sessionId])
  useEffect(() => {
    if (typeof actions?.noteTurnTime !== 'function') return
    for (const row of rows) {
      if (Number.isInteger(row.turn) && Number.isFinite(row.time)) {
        actions.noteTurnTime(sessionId, row.turn, 'first', row.time)
      }
    }
  }, [rows, sessionId, actions])
  const selfId = bot?.id ?? sessionId
  const cwd = log?.header?.cwd
  const showThinking = thinkingShown(roster.prefs)
  const flat = layoutOf(roster.prefs) === 'flat'
  const seenTurnSpeaker = new Set()
  let prevTime

  return rows.flatMap((row) => {
    if (row.kind === 'part-start') {
      prevTime = undefined
      return [h('div', { key: row.key, className: 'bt-part-line', role: 'separator' })]
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

    const pause = Number.isFinite(row.time) && (prevTime === undefined || row.time - prevTime >= SEPARATOR_GAP_MS)
    if (Number.isFinite(row.time)) prevTime = row.time

    const renderDefault = () => {
      switch (row.kind) {
        case 'user': return h(UserRow, { row, sessionId, roster, actions })
        case 'assistant': return h(AssistantRow, { row, showSpeaker, bot, sessionId, roster, actions, useUi, thinkingAt })
        case 'tool': return h(Fragment, null,
          showSpeaker && flat && bot ? h(SpeakerHead, { bot, time: row.time }) : null,
          h(ToolCallCard, { entry: row, cwd, registry }))
        case 'compaction': return h(CompactionRow, { row })
        case 'event': return h(SessionEventRow, { row, selfId, roster, actions })
        case 'turn-error': return h(TurnErrorRow, { row, bot, sessionId, useRoster, useTurnClock, actions })
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
