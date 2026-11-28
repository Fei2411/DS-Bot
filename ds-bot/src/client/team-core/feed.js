// Live SSE feed event merger and connection lifecycle controller for standalone
// frontends (desktop app and future own-UI hosts).
import { currentPart } from '../text.js'
import { appendTurnOutline } from './sessions.js'

const DEFAULT_RECONNECT_NOTICE_MS = 2_000

export function createFeedController({
  store,
  sessionStore,
  openFeed,
  read,
  onNoteLive,
  isCovered = snap => snap.inbox === true || Boolean(snap.newChat),
  reconnectNoticeMs = DEFAULT_RECONNECT_NOTICE_MS,
} = {}) {
  const { roster, ui } = store
  const {
    shown,
    connection,
    chat,
    streamingReply,
    lastFeedReplySeq,
    lastGroupNoticeSeq,
    editRow,
    setStatus,
    openTurnOf,
    recordClosingReply,
    advanceFeedMessageCursor,
    maxCoveredSeqOf,
    confirmUserMessage,
  } = sessionStore

  const onFeed = (event, data) => {
    if (event === 'hello' && data?.resumed !== true) {
      for (const sessionId of streamingReply) onNoteLive?.(sessionId, 'reply', null)
      streamingReply.clear()
      // Notice seq restarts from 1 on a fresh host boot; session log seq is durable.
      lastGroupNoticeSeq.clear()
    }
    if (event === 'message' && data?.sessionId && data.item) {
      const { sessionId, item } = data
      const text = item.kind === 'bot' || item.kind === 'user' ? item.text : ''
      const hasSeq = Number.isInteger(item.seq)
      const isReplay = Boolean(hasSeq && advanceFeedMessageCursor(sessionId, item.seq, item.block))
      const coveredByFacts = Boolean(
        text
        && hasSeq
        && !(Number.isInteger(item.turn) && item.turn >= 0)
        && item.seq <= maxCoveredSeqOf(sessionId),
      )
      if (item.kind === 'user') {
        confirmUserMessage(sessionId, item, { source: 'feed' })
      }
      let countReply = false
      if (item.kind === 'bot') {
        const hasFiniteSeq = Number.isFinite(item.seq)
        const prevSeq = hasFiniteSeq ? (lastFeedReplySeq.get(sessionId) ?? -1) : -1
        const seqReplay = hasFiniteSeq && item.seq <= prevSeq
        if (hasFiniteSeq && !seqReplay) lastFeedReplySeq.set(sessionId, item.seq)
        // Active DM Sessions count tail arrivals via SessionTranscript's monotonic seq watermark
        // so "Load earlier", gap fills, and replays never inflate replyCount or double-count.
        countReply = !seqReplay && !isReplay && !coveredByFacts && shown.getSnapshot() !== sessionId
      }
      if (!isReplay && !coveredByFacts) {
        if (item.kind === 'bot') {
          if (streamingReply.delete(sessionId)) onNoteLive?.(sessionId, 'reply', null)
          // Set completionUnread BEFORE updating turnOutline so watchBotCompletions sees the
          // unread flag on the first turnOutline snapshot for a background Bot.
          if (shown.getSnapshot() !== sessionId || isCovered(ui.getSnapshot())) setStatus(sessionId, { completionUnread: true })
        }
        let effectiveTurn = null
        editRow(sessionId, (row) => {
          const updatedAt = Math.max(row.updatedAt ?? 0, item.time ?? 0)
          const replyPatch = countReply
            ? { replyCount: (row.replyCount ?? 0) + 1 }
            : (typeof row.replyCount === 'number' ? {} : { replyCount: 0 })
          if (!text) return { ...row, updatedAt, ...replyPatch }
          const resolvedTurn = Number.isInteger(item.turn) && item.turn >= 0 ? item.turn : openTurnOf(sessionId)
          const next = appendTurnOutline(row, {
            kind: item.kind,
            text,
            turn: resolvedTurn,
            seq: hasSeq ? item.seq : null,
          })
          effectiveTurn = next.turn
          return {
            ...row,
            updatedAt,
            ...replyPatch,
            projectionValues: { ...row.projectionValues, turnOutline: next.outline },
          }
        })
        if (item.kind === 'bot' && text && Number.isInteger(effectiveTurn)) {
          recordClosingReply(sessionId, effectiveTurn, text, hasSeq ? item.seq : null)
        }
      } else if (item.kind === 'bot' && streamingReply.delete(sessionId)) {
        onNoteLive?.(sessionId, 'reply', null)
      }
    }
    if (event === 'notice' && data?.kind === 'group' && data.roomId) {
      const room = roster.getSnapshot().roomsById?.[data.roomId]
      const roomSession = room ? currentPart(room) : data.roomId
      const hasSeq = Number.isFinite(data.seq)
      const prevSeq = hasSeq ? (lastGroupNoticeSeq.get(roomSession) ?? -1) : -1
      const isReplay = hasSeq && data.seq <= prevSeq
      if (hasSeq && !isReplay) lastGroupNoticeSeq.set(roomSession, data.seq)
      if (!isReplay && (shown.getSnapshot() !== roomSession || isCovered(ui.getSnapshot()))) setStatus(roomSession, { completionUnread: true })
      if (data.text && !isReplay) {
        editRow(roomSession, (row) => {
          const next = appendTurnOutline(row, {
            kind: 'bot',
            text: data.text,
            turn: data.turn,
            seq: Number.isInteger(data.seq) ? data.seq : null,
          })
          return {
            ...row,
            updatedAt: Math.max(row.updatedAt ?? 0, data.time ?? 0),
            replyCount: (row.replyCount ?? 0) + 1,
            projectionValues: { ...row.projectionValues, turnOutline: next.outline },
          }
        })
      }
    }
    // While a reply streams in, it stands in for the activity row; notify only on transitions.
    if (event === 'stream' && data?.sessionId) {
      const streaming = data.phase === undefined && Boolean(data.text)
      if (streaming) {
        if (!streamingReply.has(data.sessionId)) {
          streamingReply.add(data.sessionId)
          onNoteLive?.(data.sessionId, 'reply', { text: true })
        }
      } else if (streamingReply.delete(data.sessionId)) {
        onNoteLive?.(data.sessionId, 'reply', null)
      }
    }
    chat.emit(event, data)
  }

  let stopped = false
  let lostTimer
  let lostSince = 0
  let closeFeed = () => {}

  const clearLost = () => {
    if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
    lostSince = 0
    if (connection.getSnapshot().status !== 'connected') {
      connection.set({ status: 'connected', error: null, code: null })
    }
  }

  const noteLost = () => {
    if (stopped || lostSince > 0 || connection.getSnapshot().status === 'error') return
    lostSince = Date.now()
    lostTimer = setTimeout(() => {
      lostTimer = undefined
      if (!stopped && lostSince > 0) {
        connection.set({ status: 'reconnecting', error: null, code: null })
      }
    }, reconnectNoticeMs)
  }

  const handleFeedEvent = (event, data) => {
    if (stopped) return
    if (event === 'lost') {
      noteLost()
      onFeed(event, data)
      return
    }
    if (event === 'error' && data?.fatal === true) {
      if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
      lostSince = 0
      connection.set({ status: 'error', error: data?.message ?? null, code: data?.code ?? null })
      onFeed(event, data)
      return
    }
    clearLost()
    if (event === 'revision') read?.()
    else if (event === 'live') {
      if (typeof document === 'undefined' || !document.hidden) read?.()
    } else if (event === 'hello' && data?.resumed !== true) {
      if (typeof document === 'undefined' || !document.hidden) read?.()
    }
    onFeed(event, data)
  }

  const connect = () => {
    closeFeed()
    closeFeed = openFeed(handleFeedEvent)
  }

  const start = () => {
    stopped = false
    connect()
    return () => {
      stopped = true
      if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
      lostSince = 0
      closeFeed()
      closeFeed = () => {}
    }
  }

  const restart = () => {
    if (stopped) return
    if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
    lostSince = Date.now()
    connection.set({ status: 'reconnecting', error: null, code: null })
    connect()
  }

  return { onFeed, start, restart }
}
