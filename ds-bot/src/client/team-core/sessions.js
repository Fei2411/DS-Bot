// Client-side session store for standalone hosts (desktop app and future own-UI hosts)
// that maintain session rows, status flags, pending sends, turn outlines, closing replies,
// user questions, queues, and connection state without DSH's frontend services.
import { toolState } from '../mark.js'
import { currentPart } from '../text.js'
import { createSource } from './roster.js'

export const EMPTY_PENDING = Object.freeze([])
const EMPTY_TURN_FACTS = Object.freeze({ turns: undefined, openTurn: undefined })
const MAX_CONFIRMED_USERS = 512

export function createBus() {
  const listeners = new Set()
  return {
    on(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event, data) {
      for (const listener of listeners) listener(event, data)
    },
  }
}

export function appendTurnOutline(row, { kind, text, turn, seq = null }) {
  const prev = Array.isArray(row.projectionValues?.turnOutline) ? row.projectionValues.turnOutline : []
  const outline = prev.map(entry => ({ ...entry }))
  const field = kind === 'bot' ? 'response' : 'prompt'
  const joinText = (existing, nextText, sameSeq) => (
    kind === 'bot' && sameSeq && typeof existing === 'string' && existing !== ''
      ? `${existing}\n\n${nextText}`
      : nextText
  )
  let effectiveTurn
  if (Number.isInteger(turn) && turn >= 0) {
    effectiveTurn = turn
    const idx = outline.findIndex(entry => entry.turn === turn)
    if (idx >= 0) {
      const current = outline[idx]
      const sameSeq = Number.isInteger(seq) && current.seq === seq
      outline[idx] = {
        ...current,
        [field]: joinText(current[field], text, sameSeq),
        ...(Number.isInteger(seq) ? { seq } : {}),
        _synthetic: false,
      }
    } else {
      outline.push({ turn, [field]: text, ...(Number.isInteger(seq) ? { seq } : {}) })
      outline.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    }
  } else {
    const last = outline.at(-1)
    const sameSeqBot = kind === 'bot' && last && Number.isInteger(seq) && last.seq === seq
    if (sameSeqBot) {
      effectiveTurn = last.turn
      outline[outline.length - 1] = {
        ...last,
        response: joinText(last.response, text, true),
      }
    } else if (kind === 'bot' && last && Number.isInteger(last.turn) && last.turn >= 0 && !last.response) {
      effectiveTurn = last.turn
      outline[outline.length - 1] = {
        ...last,
        response: text,
        ...(Number.isInteger(seq) ? { seq } : {}),
      }
    } else {
      const maxTurn = outline.reduce((max, entry) => (Number.isInteger(entry.turn) && entry.turn > max ? entry.turn : max), -1)
      effectiveTurn = maxTurn + 1
      outline.push({
        turn: effectiveTurn,
        [field]: text,
        ...(Number.isInteger(seq) ? { seq } : {}),
        _synthetic: true,
      })
    }
  }
  return { outline, turn: effectiveTurn }
}

const confirmedUserKey = (msg) => {
  if (Number.isInteger(msg?.seq)) return `seq:${msg.seq}`
  if (msg?.id !== undefined && msg.id !== null && msg.id !== '') return `id:${msg.id}`
  if (Number.isFinite(msg?.time)) return `time:${msg.time}:${typeof msg.text === 'string' ? msg.text : ''}`
  return null
}

const textMatchesPending = (pendingText, msgText) => (
  pendingText === msgText || pendingText.trim() === msgText.trim()
)

export function createSessionStore({
  store,
  workPhrase = () => '',
  onNoteLive = null,
  onShow = null,
  onPruneExtra = null,
} = {}) {
  const { roster, work } = store
  const sessions = createSource({ ids: [], byId: {} })
  const status = createSource(new Map())
  const sent = createSource({})
  const shown = createSource(null)
  const userQuestions = createSource([])
  const sessionQueues = createSource({})
  const connection = createSource({ status: 'connected', error: null, code: null })
  const chat = createBus()

  const turnFactsBySession = new Map()
  const turnWatchers = new Map()
  const closingRepliesBySession = new Map()
  const outlineReconcileListeners = new Set()
  const lastFeedMessageCursor = new Map()
  const lastFeedReplySeq = new Map()
  const lastGroupNoticeSeq = new Map()
  const streamingReply = new Set()

  const confirmedUsersBySession = new Map()
  const evictedConfirmedSeqBySession = new Map()
  const maxConfirmedUserSeqBySession = new Map()
  const pendingSentMeta = new WeakMap()

  const notifyTurnWatchers = (sessionId) => {
    const set = turnWatchers.get(sessionId)
    if (!set) return
    for (const listener of Array.from(set)) {
      try { listener() } catch { /* listener failure */ }
    }
  }

  const notifyOutlineReconciled = (sessionId, maxTurn) => {
    for (const listener of outlineReconcileListeners) {
      try { listener(sessionId, maxTurn) } catch { /* listener failure */ }
    }
  }

  const onOutlineReconcile = (listener) => {
    outlineReconcileListeners.add(listener)
    return () => { outlineReconcileListeners.delete(listener) }
  }

  const editRow = (id, edit) => sessions.set((list) => {
    const row = list.byId[id] ?? { id }
    return {
      ids: list.ids.includes(id) ? list.ids : [...list.ids, id],
      byId: { ...list.byId, [id]: edit(row) },
    }
  })

  const setStatus = (id, patch) => status.set((map) => {
    const entry = map.get(id) ?? {}
    if (Object.entries(patch).every(([key, value]) => (entry[key] ?? false) === value)) return map
    return new Map(map).set(id, { ...entry, ...patch })
  })

  const clearShown = () => {
    const before = shown.getSnapshot()
    if (before === null) return
    shown.set(null)
    editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
  }

  const show = (id) => {
    if (!id) return
    onShow?.(id, roster.getSnapshot())
    if (shown.getSnapshot() === id) return
    const before = shown.getSnapshot()
    shown.set(id)
    if (before) editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
    editRow(id, row => ({ ...row, replyCount: row.replyCount ?? 0, retainedBy: { mainView: 1 } }))
    setStatus(id, { completionUnread: false })
  }

  const mergeSessionQueues = (nextMap) => {
    if (!nextMap || typeof nextMap !== 'object') return
    sessionQueues.set((prev) => {
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(nextMap)
      let changed = prevKeys.length !== nextKeys.length
      const merged = {}
      for (const sid of nextKeys) {
        const prevRows = prev[sid]
        const nextRows = nextMap[sid]
        if (prevRows !== undefined && JSON.stringify(prevRows) === JSON.stringify(nextRows)) {
          merged[sid] = prevRows
        } else {
          merged[sid] = nextRows
          changed = true
        }
      }
      return changed ? merged : prev
    })
  }

  const setUserQuestions = (nextValue) => {
    if (JSON.stringify(userQuestions.getSnapshot()) !== JSON.stringify(nextValue)) {
      userQuestions.set(nextValue)
    }
  }

  const openTurnOf = (sessionId) => {
    const facts = turnFactsBySession.get(sessionId)
    if (!facts?.turns || facts.turns.size === 0) return undefined
    let active
    for (const entry of facts.turns.values()) {
      if (Number.isInteger(entry?.turn) && entry.turn >= 0 && entry.status !== 'closed') {
        if (active === undefined || entry.turn > active) active = entry.turn
      }
    }
    return active
  }

  const recordClosingReply = (sessionId, turn, text, seq = null) => {
    if (!sessionId || !Number.isInteger(turn) || turn < 0 || typeof text !== 'string' || text === '') return
    let map = closingRepliesBySession.get(sessionId)
    if (!map) { map = new Map(); closingRepliesBySession.set(sessionId, map) }
    const prev = map.get(turn)
    if (prev && seq !== null && prev.seq === seq) {
      map.set(turn, { text: `${prev.text}\n\n${text}`, seq })
    } else {
      map.set(turn, { text, seq })
    }
    notifyTurnWatchers(sessionId)
  }

  const advanceFeedMessageCursor = (sessionId, seq, block) => {
    if (!sessionId || !Number.isInteger(seq)) return false
    const ordinal = Number.isInteger(block) && block >= 0 ? block : 0
    const prev = lastFeedMessageCursor.get(sessionId)
    if (prev !== undefined && (seq < prev.seq || (seq === prev.seq && ordinal <= prev.block))) {
      return true
    }
    lastFeedMessageCursor.set(sessionId, { seq, block: ordinal })
    return false
  }

  const maxCoveredSeqOf = (sessionId) => {
    const facts = turnFactsBySession.get(sessionId)
    if (!facts?.turns || facts.turns.size === 0) return -1
    let maxSeq = -1
    for (const entry of facts.turns.values()) {
      if (Number.isInteger(entry?.end?.seq) && entry.end.seq > maxSeq) maxSeq = entry.end.seq
      if (Number.isInteger(entry?.start?.seq) && entry.start.seq > maxSeq) maxSeq = entry.start.seq
    }
    return maxSeq
  }

  const recordConfirmedUser = (sessionId, msg) => {
    const key = confirmedUserKey(msg)
    const hasSeq = Number.isInteger(msg?.seq)
    if (key !== null) {
      const evictedMax = evictedConfirmedSeqBySession.get(sessionId) ?? -1
      if (hasSeq && msg.seq <= evictedMax) return false
      let seen = confirmedUsersBySession.get(sessionId)
      if (!seen) { seen = new Set(); confirmedUsersBySession.set(sessionId, seen) }
      if (seen.has(key)) return false
      seen.add(key)
      while (seen.size > MAX_CONFIRMED_USERS) {
        const oldest = seen.values().next().value
        seen.delete(oldest)
        if (typeof oldest === 'string' && oldest.startsWith('seq:')) {
          const oldSeq = Number(oldest.slice(4))
          if (Number.isInteger(oldSeq) && oldSeq > (evictedConfirmedSeqBySession.get(sessionId) ?? -1)) {
            evictedConfirmedSeqBySession.set(sessionId, oldSeq)
          }
        }
      }
    }
    if (hasSeq) {
      const prevMax = maxConfirmedUserSeqBySession.get(sessionId) ?? -1
      if (msg.seq > prevMax) maxConfirmedUserSeqBySession.set(sessionId, msg.seq)
    }
    return true
  }

  const findPendingMatchIndex = (queue, msg, source) => {
    const hasSeq = Number.isInteger(msg?.seq)
    const hasMsgText = typeof msg?.text === 'string'
    const hasMsgTime = Number.isFinite(msg?.time)
    const isEligible = (entry) => {
      const meta = pendingSentMeta.get(entry)
      if (hasSeq && Number.isInteger(meta?.afterSeq) && meta.afterSeq >= 0 && msg.seq <= meta.afterSeq) {
        return false
      }
      if (source === 'facts' && meta?.hasExplicitTime && hasMsgTime && msg.time < entry.time - 2000) {
        return false
      }
      return true
    }
    if (hasMsgText) {
      for (let i = 0; i < queue.length; i += 1) {
        const entry = queue[i]
        if (typeof entry.text === 'string' && isEligible(entry) && textMatchesPending(entry.text, msg.text)) {
          return i
        }
      }
      for (let i = 0; i < queue.length; i += 1) {
        const entry = queue[i]
        if (entry.text === undefined && isEligible(entry)) {
          return i
        }
      }
      return -1
    }
    for (let i = 0; i < queue.length; i += 1) {
      if (isEligible(queue[i])) return i
    }
    return -1
  }

  const confirmUserMessage = (sessionId, msg, { source = 'feed' } = {}) => {
    if (!sessionId || !msg) return
    if (!recordConfirmedUser(sessionId, msg)) return
    sent.set((state) => {
      const queue = state[sessionId]
      if (!queue?.length) return state
      const index = findPendingMatchIndex(queue, msg, source)
      if (index < 0) return state
      if (queue.length === 1) {
        const next = { ...state }
        delete next[sessionId]
        return next
      }
      return { ...state, [sessionId]: [...queue.slice(0, index), ...queue.slice(index + 1)] }
    })
  }

  const syncOutlineFromFacts = (sessionId, facts) => {
    if (!facts?.turns || facts.turns.size === 0) return
    const closedReplies = facts.closingReplies
    const ordered = [...facts.turns.values()]
      .filter(entry => Number.isInteger(entry.turn) && entry.turn >= 0)
      .sort((a, b) => a.turn - b.turn)
    if (ordered.length === 0) return
    let prunedSynthetic = false
    let reconciledMaxTurn = ordered[ordered.length - 1].turn
    sessions.set((list) => {
      const row = list.byId[sessionId] ?? { id: sessionId }
      const prev = Array.isArray(row.projectionValues?.turnOutline) ? row.projectionValues.turnOutline : []
      const canonicalTurns = new Set(ordered.map(entry => entry.turn))
      const byTurn = new Map()
      let droppedSynthetic = false
      for (const item of prev) {
        if (!Number.isInteger(item?.turn) || item.turn < 0) continue
        if (item._synthetic && !canonicalTurns.has(item.turn)) {
          droppedSynthetic = true
          continue
        }
        byTurn.set(item.turn, { ...item })
      }
      if (droppedSynthetic) prunedSynthetic = true
      let changed = droppedSynthetic
      for (const entry of ordered) {
        const hasReply = Boolean(closedReplies?.has(entry.turn))
        const reply = hasReply ? closedReplies.get(entry.turn) : undefined
        const existing = byTurn.get(entry.turn)
        if (!existing) {
          byTurn.set(entry.turn, reply ? { turn: entry.turn, response: reply } : { turn: entry.turn })
          changed = true
        } else {
          const nextEntry = { ...existing }
          let updated = false
          if (nextEntry._synthetic) {
            delete nextEntry._synthetic
            updated = true
          }
          if (hasReply && nextEntry.response !== reply) {
            if (reply) nextEntry.response = reply
            else delete nextEntry.response
            updated = true
          }
          if (updated) {
            byTurn.set(entry.turn, nextEntry)
            changed = true
          }
        }
      }
      const needReplyCount = typeof row.replyCount !== 'number'
      if (!changed && !needReplyCount) return list
      const nextOutline = [...byTurn.values()].sort((a, b) => a.turn - b.turn)
      if (nextOutline.length > 0) reconciledMaxTurn = nextOutline[nextOutline.length - 1].turn
      return {
        ids: list.ids.includes(sessionId) ? list.ids : [...list.ids, sessionId],
        byId: {
          ...list.byId,
          [sessionId]: {
            ...row,
            replyCount: row.replyCount ?? 0,
            projectionValues: { ...(row.projectionValues ?? {}), turnOutline: nextOutline },
          },
        },
      }
    })
    if (prunedSynthetic) {
      notifyOutlineReconciled(sessionId, reconciledMaxTurn)
    }
  }

  const noteTurnFacts = (sessionId, facts) => {
    if (!sessionId) return
    if (!facts) {
      if (!turnFactsBySession.has(sessionId)) return
      turnFactsBySession.delete(sessionId)
    } else {
      turnFactsBySession.set(sessionId, facts)
      syncOutlineFromFacts(sessionId, facts)
      if (Array.isArray(facts.userMessages)) {
        for (const msg of facts.userMessages) {
          confirmUserMessage(sessionId, msg, { source: 'facts' })
        }
      }
    }
    notifyTurnWatchers(sessionId)
  }

  const closingReply = (sessionId, turn) => {
    if (!sessionId || !Number.isInteger(turn) || turn < 0) return null
    const facts = turnFactsBySession.get(sessionId)
    const turnFact = facts?.turns?.get(turn)
    if (turnFact && turnFact.status !== 'closed') return undefined
    const fromFacts = facts?.closingReplies?.get(turn)
    if (typeof fromFacts === 'string' && fromFacts !== '') return fromFacts
    if (turnFact?.status === 'closed') return ''
    const fromFeed = closingRepliesBySession.get(sessionId)?.get(turn)?.text
    if (typeof fromFeed === 'string' && fromFeed !== '') return fromFeed
    const row = sessions.getSnapshot().byId?.[sessionId]
    const outline = row?.projectionValues?.turnOutline
    if (Array.isArray(outline)) {
      const entry = outline.find(item => item?.turn === turn)
      if (typeof entry?.response === 'string' && entry.response !== '') return entry.response
    }
    const snap = roster.getSnapshot()
    const known = row !== undefined || snap.byId?.[sessionId] !== undefined || snap.roomsById?.[sessionId] !== undefined
    return known ? undefined : null
  }

  const turnFacts = sessionId => turnFactsBySession.get(sessionId) ?? EMPTY_TURN_FACTS

  const watchTurns = (sessionId, listener) => {
    if (!sessionId || typeof listener !== 'function') return () => {}
    let set = turnWatchers.get(sessionId)
    if (!set) { set = new Set(); turnWatchers.set(sessionId, set) }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) turnWatchers.delete(sessionId)
    }
  }

  const noteSent = (sessionId, meta) => {
    if (!sessionId) return () => {}
    const hasExplicitTime = Number.isFinite(meta?.time)
    const entry = {
      placement: typeof meta?.placement === 'string' ? meta.placement : 'direct',
      time: hasExplicitTime ? meta.time : Date.now(),
      ...(typeof meta?.requestId === 'string' && meta.requestId !== '' ? { requestId: meta.requestId } : {}),
      ...(typeof meta?.text === 'string' ? { text: meta.text } : {}),
    }
    const afterSeq = Math.max(maxCoveredSeqOf(sessionId), maxConfirmedUserSeqBySession.get(sessionId) ?? -1)
    pendingSentMeta.set(entry, { afterSeq, hasExplicitTime })
    sent.set(state => ({ ...state, [sessionId]: [...(state[sessionId] ?? EMPTY_PENDING), entry] }))
    return () => {
      sent.set((state) => {
        const queue = state[sessionId]
        if (!queue?.length) return state
        const index = queue.indexOf(entry)
        if (index < 0) return state
        if (queue.length === 1) {
          const next = { ...state }
          delete next[sessionId]
          return next
        }
        return { ...state, [sessionId]: [...queue.slice(0, index), ...queue.slice(index + 1)] }
      })
    }
  }

  const noteReplyArrival = (sessionId, delta) => {
    if (!sessionId || !Number.isFinite(delta) || delta <= 0) return
    editRow(sessionId, (row) => {
      const base = typeof row.replyCount === 'number'
        ? row.replyCount
        : (Array.isArray(row.projectionValues?.turnOutline)
          ? row.projectionValues.turnOutline.reduce((count, entry) => count + (entry?.response ? 1 : 0), 0)
          : 0)
      return { ...row, replyCount: base + delta }
    })
  }

  const followWork = () => {
    const snap = work.getSnapshot()
    const bots = snap.bots ?? {}
    const rooms = snap.rooms ?? {}
    const agentsWork = snap.agents ?? {}
    const r = roster.getSnapshot()
    for (const bot of r.bots) {
      const part = currentPart(bot)
      const doing = bots[bot.id]?.roomId === undefined ? bots[bot.id] : undefined
      setStatus(part, { running: doing !== undefined })
      onNoteLive?.(part, 'tool', doing?.tool ? { label: workPhrase(doing), state: toolState(doing.tool) } : null)
    }
    const activeRooms = new Set(snap.activeRooms ?? [])
    for (const room of r.rooms ?? []) {
      const part = currentPart(room)
      const busy = activeRooms.has(room.id) || (rooms[room.id]?.length ?? 0) > 0
      setStatus(part, { running: busy })
    }
    const turns = snap.turns ?? {}
    for (const agent of r.agents ?? []) {
      const anyRunning = Object.keys(turns).some(sid => (agent.sessions ?? []).includes(sid))
      for (const sid of agent.sessions ?? []) {
        const running = turns[sid] !== undefined || (!anyRunning && agentsWork[agent.id] !== undefined && sid === shown.getSnapshot())
        setStatus(sid, { running })
      }
    }
  }

  const pruneSessions = (indexed) => {
    const activeShown = shown.getSnapshot()
    const keep = id => id === activeShown || indexed.byId[id] !== undefined || indexed.roomsById[id] !== undefined || indexed.agentOf?.[id] !== undefined
    sessions.set((list) => {
      if (list.ids.every(keep)) return list
      const ids = list.ids.filter(keep)
      const byId = {}
      for (const id of ids) byId[id] = list.byId[id]
      return { ids, byId }
    })
    status.set((map) => {
      let dirty = false
      for (const id of map.keys()) { if (!keep(id)) { dirty = true; break } }
      if (!dirty) return map
      const next = new Map()
      for (const [id, entry] of map) if (keep(id)) next.set(id, entry)
      return next
    })
    sent.set((state) => {
      const keys = Object.keys(state)
      if (keys.every(keep)) return state
      const next = {}
      for (const id of keys) if (keep(id)) next[id] = state[id]
      return next
    })
    for (const id of [...turnFactsBySession.keys()]) if (!keep(id)) turnFactsBySession.delete(id)
    for (const id of [...closingRepliesBySession.keys()]) if (!keep(id)) closingRepliesBySession.delete(id)
    for (const id of [...lastFeedMessageCursor.keys()]) if (!keep(id)) lastFeedMessageCursor.delete(id)
    for (const id of [...confirmedUsersBySession.keys()]) if (!keep(id)) confirmedUsersBySession.delete(id)
    for (const id of [...evictedConfirmedSeqBySession.keys()]) if (!keep(id)) evictedConfirmedSeqBySession.delete(id)
    for (const id of [...maxConfirmedUserSeqBySession.keys()]) if (!keep(id)) maxConfirmedUserSeqBySession.delete(id)
    for (const id of [...lastFeedReplySeq.keys()]) if (!keep(id)) lastFeedReplySeq.delete(id)
    for (const id of [...lastGroupNoticeSeq.keys()]) if (!keep(id)) lastGroupNoticeSeq.delete(id)
    for (const id of [...streamingReply]) {
      if (!keep(id)) {
        streamingReply.delete(id)
        onNoteLive?.(id, 'reply', null)
      }
    }
    onPruneExtra?.(keep)
  }

  return {
    sessions,
    status,
    sent,
    shown,
    userQuestions,
    sessionQueues,
    connection,
    chat,
    streamingReply,
    lastFeedReplySeq,
    lastGroupNoticeSeq,
    editRow,
    setStatus,
    clearShown,
    show,
    mergeSessionQueues,
    setUserQuestions,
    openTurnOf,
    recordClosingReply,
    advanceFeedMessageCursor,
    maxCoveredSeqOf,
    confirmUserMessage,
    noteTurnFacts,
    closingReply,
    turnFacts,
    watchTurns,
    noteSent,
    noteReplyArrival,
    onOutlineReconcile,
    followWork,
    pruneSessions,
  }
}
