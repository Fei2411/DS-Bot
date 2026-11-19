// Event ledger: monthly append-only books for immutable team events and their routing
// decisions, built on ledger.js. Private Bots write to isolated per-Bot monthly books so
// their events never enter the shared team ledger.
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_RETENTION_DAYS = 30
const DEDUPE_CACHE_MAX = 4000
const MONTH_MS = 32 * 86_400_000

const newEventId = () => `ev_${randomBytes(6).toString('hex')}`
const monthKey = (ms = Date.now()) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
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
  const cacheOf = (privateBotId) => {
    const scope = scopeOf(privateBotId)
    let set = dedupeCache.get(scope)
    if (set === undefined) {
      set = new Set()
      dedupeCache.set(scope, set)
    }
    if (!warmed.has(scope)) {
      warmed.add(scope)
      // Warm current and previous month so restart catch-up never redelivers recent events.
      const now = Date.now()
      const months = [...new Set([monthKey(now), monthKey(now - MONTH_MS)])]
      for (const month of months) {
        const book = privateBotId ? privateBook(privateBotId, month) : sharedBook(month)
        for (const record of rt.ledger.records(book)) {
          if (record.recordKind === 'event' && typeof record.dedupeKey === 'string' && record.dedupeKey !== '') {
            set.add(record.dedupeKey)
          }
        }
      }
      while (set.size > DEDUPE_CACHE_MAX) {
        const oldest = set.values().next().value
        set.delete(oldest)
      }
    }
    return set
  }

  const rememberDedupe = (privateBotId, dedupeKey) => {
    if (typeof dedupeKey !== 'string' || dedupeKey === '') return
    const set = cacheOf(privateBotId)
    set.add(dedupeKey)
    if (set.size > DEDUPE_CACHE_MAX) {
      const oldest = set.values().next().value
      set.delete(oldest)
    }
  }

  function hasDedupeKey(dedupeKey, { privateBotId } = {}) {
    if (typeof dedupeKey !== 'string' || dedupeKey === '') return false
    return cacheOf(privateBotId).has(dedupeKey)
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
    rememberDedupe(privateBotId, record.dedupeKey)
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
      const decisions = decisionsByEvent.get(ev.id) ?? []
      if (botId && !decisions.some(d => d.target?.botId === botId) && ev.privateBotId !== botId) continue
      if (roomId && !decisions.some(d => d.target?.roomId === roomId)) continue
      if (outcome && !decisions.some(d => d.outcome === outcome)) continue
      items.push({ ...ev, decisions })
    }
    items.sort((a, b) => b.time - a.time)
    return items.slice(0, Math.max(1, Math.min(500, limit)))
  }

  // Enforces private-Bot isolation: a Bot can read shared events and its own private events,
  // never another private Bot's events.
  function getEvent(eventId, { callerBotId, isUser = false } = {}) {
    const books = collectBooks({ includePrivate: isUser, callerBotId })
    for (const book of books) {
      const records = rt.ledger.records(book)
      const found = records.find(r => r.recordKind === 'event' && r.id === eventId)
      if (found === undefined) continue
      if (!isUser && found.privateBotId && found.privateBotId !== callerBotId) return undefined
      const decisions = records.filter(r => r.recordKind === 'decision' && r.eventId === eventId)
      return { ...found, decisions }
    }
    return undefined
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
    hasDedupeKey,
    recordEvent,
    recordDecision,
    listEvents,
    getEvent,
    pruneOldBooks,
  }
}
