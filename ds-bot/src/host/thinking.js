// The exact thinking time of a Turn, read from the timed model stream DSH keeps in
// each assistant/message event: for one step, its last reasoning chunk's time minus
// its first one's, summed over the turn. assistant/attempt events are skipped on
// purpose — a failed or retried attempt's thinking never reached the reply.
import { HISTORY_TIMEOUT_MS } from './constants.js'

export function thinkingMs(events, turn) {
  let total = 0
  let timed = false
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.turn !== turn) continue
    const span = streamReasoningMs(event.data.stream)
    if (span === undefined) continue
    timed = true
    total += span
  }
  return timed ? total : undefined
}

// One stream's reasoning span. A reasoning-chunks record packs its member times as
// the first time plus the gaps to each next member, so its last member lands at
// time0 + sum(dt).
const streamReasoningMs = (stream) => {
  let first
  let last
  for (const record of stream ?? []) {
    if (record.type !== 'reasoning-chunks' || record.texts.length === 0) continue
    const end = record.dt.reduce((time, gap) => time + gap, record.time0)
    if (first === undefined || record.time0 < first) first = record.time0
    if (last === undefined || end > last) last = end
  }
  return first === undefined ? undefined : last - first
}

// Thinking duration for every turn in an oldest-first page whose full span is inside `events`.
export function pageThinkingMs(events, { atTip = false } = {}) {
  const byTurn = new Map()
  const started = new Set()
  const ended = new Set()
  let minSeenTurn
  let maxTurn
  for (const event of events) {
    const turn = event.data?.turn
    if (typeof turn !== 'number') continue
    if (minSeenTurn === undefined || turn < minSeenTurn) minSeenTurn = turn
    if (maxTurn === undefined || turn > maxTurn) maxTurn = turn
    if (event.type === 'turn/start' || event.seq === 0 || minSeenTurn < turn) started.add(turn)
    if (event.type === 'turn/end') ended.add(turn)
    let bucket = byTurn.get(turn)
    if (bucket === undefined) {
      bucket = []
      byTurn.set(turn, bucket)
    }
    bucket.push(event)
  }
  const result = new Map()
  const startsAtZero = events[0]?.seq === 0
  for (const [turn, bucket] of byTurn) {
    const hasStart = startsAtZero || started.has(turn)
    const hasEnd = ended.has(turn) || (maxTurn !== undefined && maxTurn > turn) || atTip
    if (hasStart && hasEnd) result.set(turn, thinkingMs(bucket, turn))
  }
  return result
}

const COALESCE_TURN_SPAN = 50

export function install(rt) {
  // A closed turn's events do not change; cache its answer once turn/end exists.
  const settled = new Map()
  const pending = new Map()
  const queued = new Map()

  const readThinking = async (sessionId, turn) => {
    const key = `${sessionId}:${turn}`
    if (settled.has(key)) return settled.get(key)
    // Widen slightly to include nearby queued waiters for the same Session so one scan answers all of them.
    let stopBefore = turn
    for (const waiter of queued.get(sessionId) ?? []) {
      if (waiter.turn < stopBefore && turn - waiter.turn <= COALESCE_TURN_SPAN) stopBefore = waiter.turn
    }
    const events = []
    const byTurn = new Map()
    // Newest first; events older than the turn close the read.
    for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
      events.push(event)
      const eventTurn = event.data?.turn
      if (typeof eventTurn === 'number') {
        let bucket = byTurn.get(eventTurn)
        if (bucket === undefined) {
          bucket = []
          byTurn.set(eventTurn, bucket)
        }
        bucket.push(event)
        if (eventTurn < stopBefore) break
      }
    }
    // The read went through every newer turn whole, so each closed one is answered too.
    for (const event of events) {
      if (event.type === 'turn/end' && typeof event.data?.turn === 'number' && event.data.turn >= stopBefore) {
        const closedTurn = event.data.turn
        settled.set(`${sessionId}:${closedTurn}`, thinkingMs(byTurn.get(closedTurn) ?? [], closedTurn))
      }
    }
    return settled.has(key) ? settled.get(key) : thinkingMs(byTurn.get(turn) ?? [], turn)
  }

  rt.thinkingOf = (sessionId, turn) => {
    const key = `${sessionId}:${turn}`
    if (settled.has(key)) return Promise.resolve(settled.get(key))
    let waiters = queued.get(sessionId)
    if (waiters === undefined) {
      waiters = new Set()
      queued.set(sessionId, waiters)
    }
    const waiter = { turn }
    waiters.add(waiter)
    const previous = pending.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => {
      waiters.delete(waiter)
      return readThinking(sessionId, turn)
    })
    const tail = current.catch(() => {}).finally(() => {
      waiters.delete(waiter)
      if (waiters.size === 0 && queued.get(sessionId) === waiters) queued.delete(sessionId)
      if (pending.get(sessionId) === tail) pending.delete(sessionId)
    })
    pending.set(sessionId, tail)
    return current
  }
}
