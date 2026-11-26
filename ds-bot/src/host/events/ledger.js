// Event ledger: monthly append-only books for immutable team events and their routing
// decisions, built on ledger.js. Private Bots write to isolated per-Bot monthly books so
// their events never enter the shared team ledger.
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_RETENTION_DAYS = 30
const DEDUPE_CACHE_MAX = 4000

const newEventId = () => `ev_${randomBytes(6).toString('hex')}`
const monthKey = (ms = Date.now()) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
// Exact calendar previous month (avoids 32-day subtraction skipping February on March 1-4).
export const prevMonthKey = (ms = Date.now()) => {
  const date = new Date(ms)
  const prev = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}
const sharedBook = month => `events-${month}`
const privateBook = (botId, month) => `events-priv-${botId}-${month}`
const bookFor = (privateBotId, ms = Date.now()) => (privateBotId ? privateBook(privateBotId, monthKey(ms)) : sharedBook(monthKey(ms)))

// Monthly book names on disk, newest first.
function listBooks(ledgerDir, prefix) {
  try {
    return readdirSync(ledgerDir)
      .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
      .map(name => name.slice(0, -'.jsonl'.length))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export function createEventLedger(rt) {
  const ledgerDir = join(rt.home, 'ledger')
  // Dedupe keys kept per scope ('shared' or privateBotId) with FIFO trimming.
  const dedupeCache = new Map()
  const warmed = new Set()

  const scopeOf = privateBotId => (privateBotId ? `priv:${privateBotId}` : 'shared')
  const cacheOf = (privateBotId, nowMs = Date.now()) => {
    const scope = scopeOf(privateBotId)
    let map = dedupeCache.get(scope)
    if (map === undefined) {
      map = new Map()
      dedupeCache.set(scope, map)
    }
    if (!warmed.has(scope)) {
      warmed.add(scope)
      // Warm current and exact previous calendar month so restart catch-up never redelivers.
      const months = [...new Set([monthKey(nowMs), prevMonthKey(nowMs)])]
      for (const month of months) {
        const book = privateBotId ? privateBook(privateBotId, month) : sharedBook(month)
        for (const record of rt.ledger.records(book)) {
          if (record.recordKind === 'event' && typeof record.dedupeKey === 'string' && record.dedupeKey !== '') {
            map.set(record.dedupeKey, record.id)
          }
        }
      }
      while (map.size > DEDUPE_CACHE_MAX) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
    }
    return map
  }

  const rememberDedupe = (privateBotId, dedupeKey, eventId, nowMs) => {
    if (typeof dedupeKey !== 'string' || dedupeKey === '') return
    const map = cacheOf(privateBotId, nowMs)
    map.set(dedupeKey, eventId)
    if (map.size > DEDUPE_CACHE_MAX) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  function findDedupeEventId(dedupeKey, { privateBotId, nowMs } = {}) {
    if (typeof dedupeKey !== 'string' || dedupeKey === '') return undefined
    return cacheOf(privateBotId, nowMs).get(dedupeKey)
  }

  function hasDedupeKey(dedupeKey, { privateBotId, nowMs } = {}) {
    return findDedupeEventId(dedupeKey, { privateBotId, nowMs }) !== undefined
  }

  async function recordEvent(input, { privateBotId } = {}) {
    const time = Number.isFinite(input.time) ? input.time : Date.now()
    const book = bookFor(privateBotId, time)
    const seq = rt.ledger.lastSeq(book) + 1
    const record = {
      recordKind: 'event',
      seq,
      id: input.id || newEventId(),
      time,
      source: input.source,
      trust: input.trust ?? 'external',
      threadKey: input.threadKey ?? '',
      entityKey: input.entityKey ?? input.threadKey ?? '',
      eventType: input.eventType ?? 'event',
      dedupeKey: input.dedupeKey ?? '',
      summary: String(input.summary ?? '').slice(0, 500),
      body: String(input.body ?? ''),
      ...(input.bodyRef ? { bodyRef: input.bodyRef } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(privateBotId ? { privateBotId } : {}),
    }
    rt.ledger.append(book, record)
    await rt.ledger.written(book)
    rememberDedupe(privateBotId, record.dedupeKey, record.id, time)
    return record
  }

  async function recordDecision(decision, { privateBotId } = {}) {
    const time = Number.isFinite(decision.time) ? decision.time : Date.now()
    const book = bookFor(privateBotId, time)
    const record = {
      recordKind: 'decision',
      eventId: decision.eventId,
      subId: decision.subId ?? null,
      outcome: decision.outcome,
      reason: decision.reason ?? '',
      ...(decision.target ? { target: decision.target } : {}),
      time,
    }
    rt.ledger.append(book, record)
    await rt.ledger.written(book).catch(() => {})
    return record
  }

  function collectBooks({ includePrivate = false, callerBotId } = {}) {
    const names = [...listBooks(ledgerDir, 'events-20')]
    if (includePrivate) {
      names.push(...listBooks(ledgerDir, 'events-priv-'))
    } else if (callerBotId && rt.botOf(callerBotId)?.private === true) {
      names.push(...listBooks(ledgerDir, `events-priv-${callerBotId}-`))
    }
    return [...new Set(names)]
  }

  function listEvents({ limit = 80, sourceId, botId, roomId, outcome, includePrivate = false, callerBotId } = {}) {
    const eventsById = new Map()
    const decisionsByEvent = new Map()
    for (const book of collectBooks({ includePrivate, callerBotId })) {
      for (const record of rt.ledger.records(book)) {
        if (record.recordKind === 'event') {
          eventsById.set(record.id, record)
        } else if (record.recordKind === 'decision' && record.eventId) {
          const list = decisionsByEvent.get(record.eventId) ?? []
          list.push(record)
          decisionsByEvent.set(record.eventId, list)
        }
      }
    }
    const items = []
    for (const ev of eventsById.values()) {
      if (sourceId && ev.source?.id !== sourceId) continue
      const decisions = (decisionsByEvent.get(ev.id) ?? []).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
      if (botId && !decisions.some(d => d.target?.botId === botId) && ev.privateBotId !== botId) continue
      if (roomId && !decisions.some(d => d.target?.roomId === roomId)) continue
      if (outcome && !decisions.some(d => d.outcome === outcome)) continue
      items.push({ ...ev, decisions })
    }
    items.sort((a, b) => b.time - a.time)
    return items.slice(0, Math.max(1, Math.min(500, limit)))
  }

  // Enforces private-Bot isolation and aggregates cross-month decisions (e.g. replays or
  // quiet-hour flushes that happened in the following month).
  function getEvent(eventId, { callerBotId, isUser = false } = {}) {
    const books = collectBooks({ includePrivate: isUser, callerBotId })
    let found
    for (const book of books) {
      const match = rt.ledger.records(book).find(r => r.recordKind === 'event' && r.id === eventId)
      if (match !== undefined) {
        found = match
        break
      }
    }
    if (found === undefined) return undefined
    if (!isUser && found.privateBotId && found.privateBotId !== callerBotId) return undefined

    const eventMonth = monthKey(found.time)
    const decisions = []
    for (const book of books) {
      if (found.privateBotId) {
        if (!book.startsWith(`events-priv-${found.privateBotId}-`)) continue
      } else {
        const isShared = book.startsWith('events-20')
        const isOwnPrivate = !isUser && callerBotId && book.startsWith(`events-priv-${callerBotId}-`)
        const isAnyPrivate = isUser && book.startsWith('events-priv-')
        if (!isShared && !isOwnPrivate && !isAnyPrivate) continue
      }
      const m = /(\d{4}-\d{2})$/.exec(book)
      if (m && m[1] < eventMonth) continue
      for (const record of rt.ledger.records(book)) {
        if (record.recordKind !== 'decision' || record.eventId !== eventId) continue
        if (!isUser && record.target?.kind !== 'room' && record.target?.botId
          && rt.botOf(record.target.botId)?.private === true && record.target.botId !== callerBotId) {
          continue
        }
        decisions.push(record)
      }
    }
    decisions.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    return { ...found, decisions }
  }

  function resetDedupeCache() {
    dedupeCache.clear()
    warmed.clear()
  }

  function pruneOldBooks(retentionDays = DEFAULT_RETENTION_DAYS) {
    if (rt.readOnly?.() !== undefined) return 0
    const cutoff = monthKey(Date.now() - Math.max(7, retentionDays) * 86_400_000)
    let dropped = 0
    for (const book of [...listBooks(ledgerDir, 'events-20'), ...listBooks(ledgerDir, 'events-priv-')]) {
      const match = /(\d{4}-\d{2})$/.exec(book)
      if (match !== null && match[1] < cutoff) {
        rt.ledger.drop(book)
        dropped += 1
      }
    }
    return dropped
  }

  return {
    bookFor,
    findDedupeEventId,
    hasDedupeKey,
    recordEvent,
    recordDecision,
    listEvents,
    getEvent,
    resetDedupeCache,
    pruneOldBooks,
  }
}
