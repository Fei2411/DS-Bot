import { createElement as h, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowDownIcon } from '../../../ds-bot/src/client/icons.js'
import { findMessageRow, highlightMessage, messageJumpStep } from '../../../ds-bot/src/client/message-jump.js'
import { reducedMotion } from '../../../ds-bot/src/client/motion.js'
import { pageBefore, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
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
const MemoChatRows = memo(ChatRows)

function watchMessageCenter(node, row, onStop) {
  if (typeof ResizeObserver !== 'function') return undefined
  const column = row.closest('.dsb-column')
  if (!column) return undefined
  const observer = new ResizeObserver(() => {
    const rect = row.getBoundingClientRect()
    const center = node.getBoundingClientRect().top + node.clientHeight / 2
    if (Math.abs(rect.top + rect.height / 2 - center) > 1) {
      row.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
  })
  let watching = true
  const stop = () => {
    if (!watching) return
    watching = false
    observer.disconnect()
    node.removeEventListener('pointerdown', stop)
    node.removeEventListener('wheel', stop)
    node.ownerDocument.removeEventListener('keydown', stop, true)
    onStop()
  }
  node.addEventListener('pointerdown', stop)
  node.addEventListener('wheel', stop, { passive: true })
  node.ownerDocument.addEventListener('keydown', stop, true)
  observer.observe(column)
  observer.observe(row)
  observer.observe(node)
  return stop
}

const itemIdKey = item => (item?.id !== undefined && item?.id !== null
  ? `${item.sessionId ?? ''}:${item.id}`
  : null)

const sameItem = (a, b) => (a.id !== undefined && b.id !== undefined
  ? a.id === b.id && (a.sessionId ?? null) === (b.sessionId ?? null) && a.kind === b.kind && (a.time ?? null) === (b.time ?? null)
  : a.kind === b.kind && (a.sessionId ?? null) === (b.sessionId ?? null) && a.time === b.time && a.text === b.text)

// `room-chat` speaks the mobile API contract (kind: 'bot' with botId/name/color,
// kind: 'event' with event: 'done'|'failed'|'schedule'|...). `ChatRows` expects
// group rows as 'post' and 'relay' so members stay distinct and round events render
// with RelayEvent instead of falling into the 1:1 'Message from a Bot' row.
export function adaptRoomItem(item) {
  if (!item || typeof item !== 'object') return item
  const seg = item.sessionId !== undefined ? { sessionId: item.sessionId } : {}
  if (item.kind === 'bot') {
    return {
      ...seg,
      id: item.id,
      kind: 'post',
      seq: item.id,
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(Number.isInteger(item.turn) ? { turn: item.turn } : {}),
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
      ...seg,
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

// Structural equality with cycle protection (`seen` allocated lazily on nested objects).
function valuesEqual(a, b, seen) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const visited = seen ?? new WeakMap()
  let pairs = visited.get(a)
  if (pairs) {
    if (pairs.has(b)) return true
    pairs.add(b)
  } else {
    visited.set(a, new Set([b]))
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!valuesEqual(a[i], b[i], visited)) return false
    }
    return true
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !valuesEqual(a[key], b[key], visited)) return false
  }
  return true
}

const itemsEqual = (a, b) => a === b || (sameItem(a, b) && valuesEqual(a, b))

// Appends incremental room delta items while preserving exact object references of
// unchanged existing rows so memoized `ChatRows` entries skip re-rendering.
export function mergeIncrementalItems(currentItems, deltaItems) {
  if (!Array.isArray(deltaItems) || deltaItems.length === 0) return currentItems
  if (!Array.isArray(currentItems) || currentItems.length === 0) return deltaItems
  const byId = new Map()
  for (let i = 0; i < currentItems.length; i += 1) {
    const key = itemIdKey(currentItems[i])
    if (key !== null) byId.set(key, i)
  }
  let next = null
  for (const incoming of deltaItems) {
    const key = itemIdKey(incoming)
    const existingIdx = key !== null ? byId.get(key) : undefined
    if (existingIdx !== undefined) {
      const cur = (next ?? currentItems)[existingIdx]
      if (itemsEqual(cur, incoming)) continue
      if (next === null) next = currentItems.slice()
      next[existingIdx] = incoming
    } else {
      if (next === null) next = currentItems.slice()
      if (key !== null) byId.set(key, next.length)
      next.push(incoming)
    }
  }
  return next ?? currentItems
}

// Merges a refreshed newest page onto already-loaded history without discarding
// earlier pages, rewinding the cursor, or churning unchanged row object references.
export function mergeLatestPage(currentItems, currentCursor, nextItems, nextCursor) {
  if (currentItems.length === 0) return { items: nextItems, cursor: nextCursor }
  if (nextItems.length === 0) {
    // A freshly rolled-over empty new part (`cursor: { part: N - 1 }` with no `beforeSeq`)
    // must keep already-displayed earlier-part history on screen until messages arrive in it.
    if (nextCursor && nextCursor.beforeSeq === undefined && Number.isInteger(nextCursor.part)) {
      return { items: currentItems, cursor: currentCursor }
    }
    return { items: [], cursor: nextCursor }
  }
  const existingById = new Map()
  for (const item of currentItems) {
    const key = itemIdKey(item)
    if (key !== null) existingById.set(key, item)
  }
  const stableNext = nextItems.map((item) => {
    const key = itemIdKey(item)
    const prev = key !== null ? existingById.get(key) : undefined
    return prev && itemsEqual(prev, item) ? prev : item
  })
  let cut = -1
  for (const next of stableNext) {
    for (let i = currentItems.length - 1; i >= 0; i -= 1) {
      if (sameItem(currentItems[i], next)) { cut = i; break }
    }
    if (cut !== -1) break
  }
  if (cut > 0) return { items: [...currentItems.slice(0, cut), ...stableNext], cursor: currentCursor }
  if (cut === 0) return { items: stableNext, cursor: nextCursor }
  if (nextCursor && nextCursor.beforeSeq === undefined && Number.isInteger(nextCursor.part)) {
    return { items: [...currentItems, ...stableNext], cursor: currentCursor }
  }
  return { items: stableNext, cursor: nextCursor }
}

const userItemKey = item => (item.id !== undefined
  ? `id:${item.sessionId ?? ''}:${item.id}`
  : `t:${item.sessionId ?? ''}:${item.time ?? ''}:${item.text}`)

// Group chat: pages from `room-chat`, incrementally appended when the live feed announces room activity.
function useRoomChat(roomId, part, feed, keep, onUserMatch) {
  const active = roomId !== undefined
  const [view, setView] = useState({ sessionId: null, partSessionId: null, items: [], cursor: null, loading: active, failed: false })
  const ready = useRef(false)
  const busy = useRef(false)
  const reloadQueued = useRef(false)
  const reloadFullQueued = useRef(false)
  const earlierQueued = useRef(null)
  const tipRef = useRef(null)
  const gen = useRef(0)
  const hasLoaded = useRef(false)
  const knownUserIds = useRef(new Set())
  const onUserMatchRef = useRef(onUserMatch)
  onUserMatchRef.current = onUserMatch

  const load = useCallback(async (cursor, scroller, refresh = false, { incremental = false } = {}) => {
    if (!active) return
    if (busy.current) {
      if (cursor === undefined) {
        reloadQueued.current = true
        if (!incremental) reloadFullQueued.current = true
      } else {
        earlierQueued.current = { cursor, scroller }
      }
      return
    }
    const myGen = gen.current
    busy.current = true
    if (cursor === undefined && !refresh) ready.current = false
    if (!refresh) setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const after = cursor === undefined && incremental ? tipRef.current : null
      const page = await call('room-chat', {
        roomId,
        ...(cursor ? { cursor } : {}),
        ...(after ? { after } : {}),
      })
      if (gen.current !== myGen) return
      const pageItems = adaptRoomItems(page.items)
      const pageSessionId = roomId ?? part
      const pagePartSessionId = page.tip?.sessionId ?? null
      if (cursor === undefined) {
        ready.current = true
        if (page.tip !== undefined) tipRef.current = page.tip
        setView((current) => {
          if (
            page.incremental === true
            && current.sessionId === pageSessionId
            && (pagePartSessionId === null || current.partSessionId === pagePartSessionId)
          ) {
            const nextItems = mergeIncrementalItems(current.items, pageItems)
            if (nextItems === current.items && !current.loading && !current.failed) return current
            return { ...current, items: nextItems, loading: false, failed: false }
          }
          if (refresh && current.sessionId === pageSessionId && current.items.length > 0) {
            const merged = mergeLatestPage(current.items, current.cursor, pageItems, page.cursor)
            return { ...current, partSessionId: pagePartSessionId, items: merged.items, cursor: merged.cursor, loading: false, failed: false }
          }
          return { sessionId: pageSessionId, partSessionId: pagePartSessionId, items: pageItems, cursor: page.cursor, loading: false, failed: false }
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
        if (earlierQueued.current !== null) {
          const pendingEarlier = earlierQueued.current
          earlierQueued.current = null
          void loadRef.current(pendingEarlier.cursor, pendingEarlier.scroller)
        } else if (reloadQueued.current) {
          const forceFull = reloadFullQueued.current
          reloadQueued.current = false
          reloadFullQueued.current = false
          void loadRef.current(undefined, undefined, true, { incremental: !forceFull })
        }
      }
    }
  }, [active, roomId, part, keep])
  const loadRef = useRef(load)
  loadRef.current = load

  const prevPartRef = useRef(part)
  useEffect(() => {
    const myGen = ++gen.current
    prevPartRef.current = part
    busy.current = false
    reloadQueued.current = false
    reloadFullQueued.current = false
    earlierQueued.current = null
    tipRef.current = null
    ready.current = false
    hasLoaded.current = false
    knownUserIds.current.clear()
    setView({ sessionId: null, partSessionId: null, items: [], cursor: null, loading: active, failed: false })
    if (active) void loadRef.current(undefined)
    return () => {
      if (gen.current === myGen) gen.current += 1
      busy.current = false
      reloadQueued.current = false
      reloadFullQueued.current = false
      earlierQueued.current = null
    }
  }, [active, roomId])

  // When the same room rolls over to a new part (`part` changes while `roomId` stays equal),
  // refresh without wiping already-displayed earlier-part history on screen.
  useEffect(() => {
    const prevPart = prevPartRef.current
    prevPartRef.current = part
    if (!active || prevPart === part || !ready.current) return
    void loadRef.current(undefined, undefined, true, { incremental: false })
  }, [active, roomId, part])

  useEffect(() => {
    if (!active || !feed) return undefined
    return feed.on((event, data) => {
      if (event === 'hello') { if (data?.resumed !== true && ready.current) void loadRef.current(undefined, undefined, true, { incremental: false }); return }
      if (event === 'room' && data?.roomId === roomId) void loadRef.current(undefined, undefined, true, { incremental: true })
    })
  }, [active, feed, roomId])

  return { view, load }
}

const PendingUserRows = memo(function PendingUserRows({ items, sessionId, classic = false, reconnecting = false }) {
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
export const Transcript = memo(function Transcript({
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
  const messageJump = hooks.useUi?.(state => state?.messageJump?.sessionId === sessionId ? state.messageJump : null)
  const sessionRunning = hooks.useSessionStatus(map => map.get(activeSessionId)?.running === true)
  const feedDisconnected = hooks.useConnection ? hooks.useConnection(state => state.status !== 'connected') : false

  const earlierTopRef = useRef(null)
  const follow = useRef(true)
  const smoothScrollRef = useRef(null)
  const [following, setFollowing] = useState(true)
  const keep = useRef(null)
  const jumpProgress = useRef(null)
  const stopJumpCentering = useRef()

  useLayoutEffect(() => () => stopJumpCentering.current?.(), [viewedSessionId])

  useLayoutEffect(() => {
    keep.current = null
    follow.current = true
    smoothScrollRef.current = null
    setFollowing(true)
  }, [activeSessionId])

  if (transcriptRef) {
    transcriptRef.current = {
      followBottom() {
        stopJumpCentering.current?.()
        follow.current = true
        setFollowing(true)
      },
      resetFollow() {
        stopJumpCentering.current?.()
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
    if (messageJump) return
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
    if (!follow.current && node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX) {
      follow.current = true
      setFollowing(true)
    }
  }, [contentRevision, pending, running, question, scrollerRef, messageJump])

  const onScroll = () => {
    const node = scrollerRef.current
    if (!node || messageJump) return
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
    stopJumpCentering.current?.()
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
  const canAutoLoadEarlier = isRoom
    ? Boolean(roomChat.view.cursor && !roomChat.view.loading && !roomChat.view.failed && roomChat.view.sessionId !== null)
    : Boolean(dmChat.hasMore && !dmChat.loading && !dmChat.paging && !dmChat.pageFailed)
  const loadEarlierRef = useRef(null)
  loadEarlierRef.current = (preserveScroll = true) => {
    const scroller = preserveScroll ? scrollerRef.current : undefined
    if (isRoom) {
      if (roomChat.view.cursor) void roomChat.load(roomChat.view.cursor, scroller)
    } else if (dmChat.hasMore) {
      void dmChat.loadEarlier(scroller)
    }
  }
  const jumpViewRef = useRef(viewedSessionId)
  useLayoutEffect(() => {
    const viewChanged = jumpViewRef.current !== viewedSessionId
    jumpViewRef.current = viewedSessionId
    if (!messageJump) {
      jumpProgress.current = null
      return undefined
    }
    const node = scrollerRef.current
    if (!node) return undefined
    if (viewingSubagent) {
      onSelectSubagentDepth(0)
      return undefined
    }
    if (viewChanged) return undefined
    if (jumpProgress.current?.target !== messageJump) {
      stopJumpCentering.current?.()
      jumpProgress.current = { target: messageJump, tried: new Set(), followedTail: follow.current }
    }
    follow.current = false
    smoothScrollRef.current = null
    keep.current = null
    setFollowing(false)
    const roomCursor = roomChat.view.cursor
    const cursor = isRoom
      ? (roomCursor?.beforeSeq == null ? null : `${roomCursor.part}:${roomCursor.beforeSeq}`)
      : pageBefore(dmChat.log)
    const failed = isRoom ? roomChat.view.failed : (dmChat.failed || dmChat.pageFailed || dmChat.terminalError)
    const tried = jumpProgress.current.tried
    const reachedTurnStart = !isRoom && dmChat.log.events.some(event => event.type === 'turn/start' && event.data?.turn === messageJump.turn)
    const row = busy ? undefined : findMessageRow(node, messageJump, reachedTurnStart || cursor == null || failed || tried.has(cursor))
    const step = messageJumpStep({ row, waiting: busy, failed, cursor }, tried)
    if (step === 'load') {
      tried.add(cursor)
      loadEarlierRef.current(false)
    } else if (step === 'found') {
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          keep.current = null
          stopJumpCentering.current = watchMessageCenter(node, row, () => { stopJumpCentering.current = undefined })
          highlightMessage(row, stopJumpCentering.current)
          actions.finishMessageJump(messageJump)
        })
      })
      return () => cancelAnimationFrame(frame)
    } else if (step === 'stop') {
      if (jumpProgress.current.followedTail) {
        follow.current = true
        setFollowing(true)
      }
      actions.finishMessageJump(messageJump)
    }
    return undefined
  }, [messageJump, isRoom, busy, dmChat.log, dmChat.failed, dmChat.pageFailed, dmChat.terminalError, roomChat.view, viewedSessionId, viewingSubagent, onSelectSubagentDepth, actions, scrollerRef])

  // Auto-load the previous page when the user scrolls near the top, mirroring `EarlierParts`.
  // Gated on `!following` so initial open (before scroll-to-bottom) and live tail following never trigger it.
  useEffect(() => {
    if (messageJump || !canAutoLoadEarlier || following || typeof IntersectionObserver !== 'function') return undefined
    const topNode = earlierTopRef.current
    const rootNode = scrollerRef.current
    if (!topNode || !rootNode) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (!follow.current && entries.some(entry => entry.isIntersecting)) {
        loadEarlierRef.current?.()
      }
    }, { root: rootNode, rootMargin: '600px 0px 0px 0px' })
    observer.observe(topNode)
    return () => observer.disconnect()
  }, [messageJump, canAutoLoadEarlier, following, isRoom, roomChat.view.cursor, dmChat.hasMore, scrollerRef])

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
        earlier ? h('div', { ref: earlierTopRef, className: 'bt-earlier-top' }, earlier) : null,
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
