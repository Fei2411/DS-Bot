import { createElement as h, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowDownIcon } from '../../../ds-bot/src/client/icons.js'
import { reducedMotion } from '../../../ds-bot/src/client/motion.js'
import { writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { mentionableBots } from '../../../ds-bot/src/client/user-message.js'
import { AgentEmptyHero } from './classic-sidebar.js'
import { SessionTranscript, UserAttachments, useSessionFollow } from './session-chat.js'
import { SubagentLineageBar } from './subagent-viewer.js'
import { UserMessageText } from './user-text.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const EMPTY_OBJ = {}
const EMPTY_WORK = { bots: {}, approvals: [] }
const EMPTY_SESSIONS = { ids: [], byId: {} }
const NO_OBJ_HOOK = selector => selector(EMPTY_OBJ)
const NO_WORK_HOOK = selector => selector(EMPTY_WORK)
const NO_SESSIONS_HOOK = selector => selector(EMPTY_SESSIONS)
const wrapMemo = fn => (typeof memo === 'function' ? memo(fn) : fn)
const MemoChatRows = wrapMemo(ChatRows)

const sameItem = (a, b) => (a.id !== undefined && b.id !== undefined
  ? a.id === b.id && a.kind === b.kind && (a.time ?? null) === (b.time ?? null)
  : a.kind === b.kind && a.time === b.time && a.text === b.text)

// `room-chat` speaks the mobile API contract (kind: 'bot' with botId/name/color,
// kind: 'event' with event: 'done'|'failed'|'schedule'|...). `ChatRows` expects
// group rows as 'post' and 'relay' so members stay distinct and round events render
// with RelayEvent instead of falling into the 1:1 'Message from a Bot' row.
export function adaptRoomItem(item) {
  if (!item || typeof item !== 'object') return item
  if (item.kind === 'bot') {
    return {
      id: item.id,
      kind: 'post',
      seq: item.id,
      botId: item.botId,
      name: item.name,
      color: item.color,
      text: item.text,
      time: item.time,
      ...(Number.isFinite(item.duration) ? { duration: item.duration } : {}),
      ...(item.changes ? { changes: item.changes } : {}),
      ...(Array.isArray(item.files) && item.files.length > 0 ? { presented: item.files } : {}),
      ...(item.whole?.file ? { file: item.whole.file, length: item.whole.length } : {}),
    }
  }
  if (item.kind === 'event') {
    return {
      id: item.id,
      kind: 'relay',
      time: item.time,
      reply: {
        kind: item.event,
        botId: item.botId,
        name: item.name,
        color: item.color,
        text: item.text,
        code: item.code,
        time: item.time,
      },
    }
  }
  return item
}

export const adaptRoomItems = items => (Array.isArray(items) ? items.map(adaptRoomItem) : [])

// Merges a refreshed newest page onto already-loaded history without discarding
// earlier pages or rewinding the cursor.
export function mergeLatestPage(currentItems, currentCursor, nextItems, nextCursor) {
  if (currentItems.length === 0) return { items: nextItems, cursor: nextCursor }
  if (nextItems.length === 0) return { items: [], cursor: nextCursor }
  let cut = -1
  for (const next of nextItems) {
    for (let i = currentItems.length - 1; i >= 0; i -= 1) {
      if (sameItem(currentItems[i], next)) { cut = i; break }
    }
    if (cut !== -1) break
  }
  if (cut > 0) return { items: [...currentItems.slice(0, cut), ...nextItems], cursor: currentCursor }
  if (cut === 0) return { items: nextItems, cursor: nextCursor }
  if (nextCursor && nextCursor.beforeSeq === undefined && Number.isInteger(nextCursor.part)) {
    return { items: [...currentItems, ...nextItems], cursor: currentCursor }
  }
  return { items: nextItems, cursor: nextCursor }
}

const userItemKey = item => (item.id !== undefined ? `id:${item.id}` : `t:${item.time ?? ''}:${item.text}`)

// Group chat: pages from `room-chat`, refreshed when the live feed announces room activity.
function useRoomChat(roomId, part, feed, keep, onUserMatch) {
  const active = roomId !== undefined
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
  const ready = useRef(false)
  const busy = useRef(false)
  const reloadQueued = useRef(false)
  const gen = useRef(0)
  const hasLoaded = useRef(false)
  const knownUserIds = useRef(new Set())
  const onUserMatchRef = useRef(onUserMatch)
  onUserMatchRef.current = onUserMatch

  const load = useCallback(async (cursor, scroller, refresh = false) => {
    if (!active) return
    if (busy.current) {
      if (cursor === undefined) reloadQueued.current = true
      return
    }
    const myGen = gen.current
    busy.current = true
    if (cursor === undefined && !refresh) ready.current = false
    if (!refresh) setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const page = await call('room-chat', { roomId, ...(cursor ? { cursor } : {}) })
      if (gen.current !== myGen) return
      const pageItems = adaptRoomItems(page.items)
      const pageSessionId = page.sessionId ?? part
      if (cursor === undefined) {
        ready.current = true
        setView((current) => {
          if (refresh && current.sessionId === pageSessionId && current.items.length > 0) {
            const merged = mergeLatestPage(current.items, current.cursor, pageItems, page.cursor)
            return { ...current, items: merged.items, cursor: merged.cursor, loading: false, failed: false }
          }
          return { sessionId: pageSessionId, items: pageItems, cursor: page.cursor, loading: false, failed: false }
        })
        const initial = !hasLoaded.current
        hasLoaded.current = true
        const freshUsers = []
        for (const item of pageItems) {
          if (item.kind !== 'user') continue
          const key = userItemKey(item)
          if (knownUserIds.current.has(key)) continue
          knownUserIds.current.add(key)
          freshUsers.push(item)
        }
        if (freshUsers.length > 0) onUserMatchRef.current?.(freshUsers, initial)
      } else {
        for (const item of pageItems) {
          if (item.kind === 'user') knownUserIds.current.add(userItemKey(item))
        }
        // Content added above the viewport would push the view down; keep its distance from the end.
        if (scroller) keep.current = scroller.scrollHeight - scroller.scrollTop
        setView(current => ({ ...current, items: [...pageItems, ...current.items], cursor: page.cursor, loading: false }))
      }
    } catch {
      if (gen.current !== myGen) return
      ready.current = cursor !== undefined || refresh || ready.current
      if (!refresh) setView(current => ({ ...current, loading: false, failed: true }))
    } finally {
      if (gen.current === myGen) {
        busy.current = false
        if (reloadQueued.current) {
          reloadQueued.current = false
          void loadRef.current(undefined, undefined, true)
        }
      }
    }
  }, [active, roomId, part, keep])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const myGen = ++gen.current
    busy.current = false
    reloadQueued.current = false
    ready.current = false
    hasLoaded.current = false
    knownUserIds.current.clear()
    setView({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
    if (active) void loadRef.current(undefined)
    return () => {
      if (gen.current === myGen) gen.current += 1
      busy.current = false
      reloadQueued.current = false
    }
  }, [active, roomId, part])

  useEffect(() => {
    if (!active || !feed) return undefined
    return feed.on((event, data) => {
      if (event === 'hello') { if (data?.resumed !== true && ready.current) void loadRef.current(undefined, undefined, true); return }
      if (event === 'room' && data?.roomId === roomId) void loadRef.current(undefined, undefined, true)
    })
  }, [active, feed, roomId])

  return { view, load }
}

const PendingUserRows = wrapMemo(function PendingUserRows({ items, sessionId, classic = false, reconnecting = false }) {
  if (!items || items.length === 0) return null
  const statusLabel = reconnecting ? t('Waiting to confirm…') : t('Sending…')
  const meta = h('div', { className: 'dsb-pending-meta', 'data-reconnecting': reconnecting || undefined },
    h('span', { className: 'dsb-pending-dot', 'aria-hidden': true }),
    h('span', null, statusLabel))
  if (classic) {
    return h('div', { className: 'dsb-pending' }, items.map((entry, index) => h('div', { key: `${entry.time}:${index}`, className: 'dsb-dsh-user' },
      h('div', { className: 'dsb-dsh-user-stack' },
        entry.attachments?.length ? h(UserAttachments, { attachments: entry.attachments, sessionId }) : null,
        entry.text !== '' ? h('div', { className: 'dsb-dsh-user-bubble' }, h(UserMessageText, { text: entry.text, interactive: false })) : null,
        meta))))
  }
  return h('div', { className: 'dsb-pending' }, items.map((entry, index) => h('div', { key: `${entry.time}:${index}`, className: 'bt-umsg' },
    h('div', { className: 'bt-ustack' },
      entry.attachments?.length ? h(UserAttachments, { attachments: entry.attachments, sessionId }) : null,
      entry.text !== '' ? h('div', { className: 'bt-ubody' }, h(UserMessageText, { text: entry.text, interactive: false })) : null,
      meta))))
})

// Scrollable conversation transcript that owns the live streaming subscription
// (`useSessionFollow` for DM / Classic / Subagent sessions and `useRoomChat` for group chats).
export const Transcript = wrapMemo(function Transcript({
  sessionId,
  activeSessionId,
  viewedSessionId,
  viewingSubagent,
  subagentStack,
  subagentAncestors,
  bot,
  room,
  isRoom,
  isAgent,
  isClassic,
  name,
  readOnly,
  pending,
  transcriptPending,
  scrollerRef,
  transcriptRef,
  onClearPendingUsers,
  onSessionUser,
  onWritingChange,
  onOpenSubagent,
  onPopSubagent,
  onSelectSubagentDepth,
  actions,
  hooks,
  feed,
  registry,
}) {
  const roster = hooks.useRoster(value => value)
  const useSessions = hooks.useSessions ?? NO_SESSIONS_HOOK
  const useWork = hooks.useWork ?? NO_WORK_HOOK
  const useHeldCards = hooks.useHeldCards ?? NO_OBJ_HOOK
  const useComputer = hooks.useComputer ?? NO_OBJ_HOOK
  const useBrowserHolds = hooks.useBrowserHolds ?? NO_OBJ_HOOK
  const useBrowserTabs = hooks.useBrowserTabs ?? NO_OBJ_HOOK
  const useBrowserPages = hooks.useBrowserPages ?? NO_OBJ_HOOK

  const sessionBlank = useSessions(list => list.byId[activeSessionId]?.blank === true)
  const viewedUpdatedAt = useSessions(list => list.byId[viewedSessionId]?.updatedAt)
  const sessionRunning = hooks.useSessionStatus(map => map.get(activeSessionId)?.running === true)
  const feedDisconnected = hooks.useConnection ? hooks.useConnection(state => state.status !== 'connected') : false

  const follow = useRef(true)
  const smoothScrollRef = useRef(null)
  const [following, setFollowing] = useState(true)
  const keep = useRef(null)

  useEffect(() => {
    keep.current = null
    follow.current = true
    smoothScrollRef.current = null
    setFollowing(true)
  }, [activeSessionId])

  if (transcriptRef) {
    transcriptRef.current = {
      followBottom() {
        follow.current = true
        setFollowing(true)
      },
      resetFollow() {
        follow.current = true
        setFollowing(true)
        keep.current = null
      },
    }
  }

  const roomChat = useRoomChat(room?.id, sessionId, feed, keep, onClearPendingUsers)
  const dmChat = useSessionFollow({
    sessionId: viewedSessionId,
    parent: viewingSubagent?.parentSessionId,
    mode: viewingSubagent?.mode,
    enabled: !isRoom && Boolean(viewedSessionId),
    feed,
    readOnly,
    readOnlyUpdatedAt: readOnly ? viewedUpdatedAt : undefined,
    onUserMessage: viewingSubagent ? undefined : onSessionUser,
    keep,
  })

  const dmWriting = !isRoom && dmChat.log.writing !== null
  useEffect(() => {
    onWritingChange?.(dmWriting)
  }, [dmWriting, onWritingChange])

  // While a DM reply streams text through `api/bot/session`, mark it live so the activity row yields.
  const dmWritingText = !isRoom && writingBlocks(dmChat.log).some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
  useEffect(() => {
    if (isRoom || !activeSessionId || typeof actions.noteLive !== 'function') return undefined
    actions.noteLive(activeSessionId, 'session-reply', dmWritingText ? { text: true } : null)
    return () => actions.noteLive(activeSessionId, 'session-reply', null)
  }, [isRoom, activeSessionId, dmWritingText, actions])

  const question = roster.questions?.[activeSessionId] ?? roster.questions?.[sessionId]
  const running = sessionRunning || dmWriting

  const contentRevision = isRoom ? roomChat.view.items : dmChat.log.revision
  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
    if (!follow.current && node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX) {
      follow.current = true
      setFollowing(true)
    }
  }, [contentRevision, pending, running, question, scrollerRef])

  const onScroll = () => {
    const node = scrollerRef.current
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
    if (atBottom) {
      smoothScrollRef.current = null
    } else if (smoothScrollRef.current !== null) {
      // Keep following during an in-flight smooth scroll to bottom unless the user scrolls back up.
      if (node.scrollTop < smoothScrollRef.current.lastTop - 2 || Date.now() > smoothScrollRef.current.until) {
        smoothScrollRef.current = null
      } else {
        smoothScrollRef.current.lastTop = node.scrollTop
        return
      }
    }
    follow.current = atBottom
    setFollowing(prev => (prev === atBottom ? prev : atBottom))
  }

  const scrollToBottom = () => {
    follow.current = true
    setFollowing(true)
    const node = scrollerRef.current
    if (!node) return
    if (typeof node.scrollTo === 'function' && !reducedMotion()) {
      smoothScrollRef.current = { lastTop: node.scrollTop, until: Date.now() + 1500 }
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    } else {
      smoothScrollRef.current = null
      node.scrollTop = node.scrollHeight
    }
  }

  const busy = isRoom ? roomChat.view.loading : (dmChat.loading || dmChat.paging)
  const earlier = isRoom
    ? (roomChat.view.loading && roomChat.view.sessionId !== null ? h(Shimmer, null, t('Loading earlier messages…'))
      : roomChat.view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => roomChat.load(roomChat.view.cursor ?? undefined, scrollerRef.current) }, t('Couldn’t load earlier messages · Retry'))
        : roomChat.view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => roomChat.load(roomChat.view.cursor, scrollerRef.current) }, t('Load earlier')) : null)
    : (dmChat.paging ? h(Shimmer, null, t('Loading earlier messages…'))
      : dmChat.pageFailed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => dmChat.loadEarlier(scrollerRef.current) }, t('Couldn’t load earlier messages · Retry'))
        : dmChat.hasMore ? h('button', { type: 'button', className: 'bt-soft', onClick: () => dmChat.loadEarlier(scrollerRef.current) }, t('Load earlier')) : null)

  const sessionNotice = !isRoom && (dmChat.terminalError || dmChat.failed)
    ? h('div', { className: 'dsb-session-error', role: 'alert' },
      h('span', null, dmChat.terminalError?.code === 'bot/stream-overflow'
        ? t('Live updates paused: message too large')
        : dmChat.terminalError ? t('Session unavailable') : t('Couldn’t load this conversation')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: dmChat.retry }, t('Retry')))
    : null

  const renderRoomUserAttachments = useCallback((row) => {
    const blocks = [
      ...(Array.isArray(row.imageRefs) ? row.imageRefs.map(ref => ({ type: 'image', attachment: ref })) : []),
      ...(Array.isArray(row.fileRefs) ? row.fileRefs.map(ref => ({ type: 'file', attachment: ref })) : []),
    ]
    if (blocks.length === 0) return null
    return h(UserAttachments, { attachments: blocks, sessionId: row.sessionId ?? activeSessionId })
  }, [activeSessionId])

  const openRoomFile = useMemo(() => (typeof actions?.openFile === 'function'
    ? target => actions.openFile(typeof target === 'string'
      ? { path: target, sessionId: activeSessionId }
      : { ...target, sessionId: target?.sessionId ?? activeSessionId })
    : undefined), [actions, activeSessionId])
  const revealRoomFolder = useMemo(() => (typeof actions?.revealFolder === 'function'
    ? target => actions.revealFolder(typeof target === 'string'
      ? { path: target, sessionId: activeSessionId }
      : { ...target, sessionId: target?.sessionId ?? activeSessionId })
    : openRoomFile
      ? target => openRoomFile(typeof target === 'string' ? { path: target, isDir: true } : { ...target, isDir: true })
      : undefined), [actions, activeSessionId, openRoomFile])
  const roomMentionBots = useMemo(
    () => (Array.isArray(roster?.bots) ? mentionableBots(roster, activeSessionId) : []),
    [roster, activeSessionId],
  )
  const renderRoomUserText = useCallback(({ text, fullText, revealedSecrets, onToggleSecret }) => h(UserMessageText, {
    text,
    fullText,
    bots: roomMentionBots,
    revealedSecrets,
    onToggleSecret,
    onOpenBot: actions?.openSession,
    onOpenFile: openRoomFile,
    onRevealFolder: revealRoomFolder,
  }), [roomMentionBots, actions, openRoomFile, revealRoomFolder])

  const hasAgentMessages = !isRoom && Array.isArray(dmChat.log?.events)
    && dmChat.log.events.some(ev => ev?.type === 'user/message' || ev?.type === 'assistant/message' || ev?.type === 'turn/start' || ev?.type === 'tool/call')
  const showAgentHero = isAgent
    && (!dmChat.loading || sessionBlank)
    && !dmChat.failed
    && !dmChat.terminalError
    && !dmChat.hasMore
    && pending.length === 0
    && dmChat.log.writing === null
    && !hasAgentMessages
  const heroCwd = dmChat.log?.header?.cwd || roster.workspace || ''

  return h(Fragment, null,
    viewingSubagent ? h(SubagentLineageBar, {
      stack: subagentStack,
      rootLabel: name || t('Parent session'),
      running: dmChat.log.writing !== null,
      onBack: onPopSubagent,
      onSelectDepth: onSelectSubagentDepth,
    }) : null,
    h('div', { ref: scrollerRef, className: 'dsb-scroll', 'data-bt-scroll': '', 'data-bt-following-tail': following ? 'true' : 'false', 'data-empty-hero': !viewingSubagent && showAgentHero ? '' : undefined, onScroll },
      !viewingSubagent && showAgentHero ? h(AgentEmptyHero, { cwd: heroCwd, actions, readOnly }) : null,
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        sessionNotice,
        h('div', { className: 'dsb-flow', 'data-bt-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': busy },
          !isRoom && dmChat.historyReloaded ? h('div', { key: 'history-reloaded', className: 'bt-time-sep', role: 'separator' }, t('Conversation history was reloaded')) : null,
          isRoom
            ? h(MemoChatRows, { items: roomChat.view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true, renderUserAttachments: renderRoomUserAttachments, renderUserText: renderRoomUserText })
            : h(SessionTranscript, {
              log: dmChat.log,
              sessionId: viewedSessionId,
              parent: viewingSubagent?.parentSessionId,
              mode: viewingSubagent?.mode,
              ancestors: subagentAncestors,
              bot,
              roster,
              actions,
              classic: isClassic,
              feed,
              readOnly: readOnly || Boolean(viewingSubagent),
              onOpenSubagent: onOpenSubagent,
              useUi: hooks.useUi,
              useRoster: hooks.useRoster,
              useWork,
              useTurnClock: hooks.useTurnClock,
              useHeldCards,
              useBrowserHolds,
              useBrowserTabs,
              useBrowserPages,
              useComputer,
              thinkingAt: dmChat.thinkingAt,
              hasMore: dmChat.hasMore,
              quietSeq: dmChat.quietSeq,
              reloadEpoch: dmChat.reloadEpoch,
              registry,
            }),
          !viewingSubagent ? h(PendingUserRows, { items: transcriptPending, sessionId: activeSessionId, classic: isClassic, reconnecting: feedDisconnected }) : null,
          // The Bot views' activity row (from the header pill) draws itself in here.
          !viewingSubagent ? h('div', { 'data-bt-running': '' }) : null))),
    !following && !viewingSubagent ? h('button', {
      type: 'button',
      className: 'bt-to-bottom',
      'data-bt-to-bottom': '',
      'aria-label': t('Back to bottom'),
      title: t('Back to bottom'),
      onClick: scrollToBottom,
    }, h(ArrowDownIcon)) : null)
})
