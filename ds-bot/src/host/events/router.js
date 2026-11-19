// Event router: persistent subscriptions, deterministic Fast Path (matching, quiet hours,
// entity coalescing, per-hour rate-limit circuit breaker), direct delivery to background
// tasks or Bot/group Sessions via stable identities, and dead-letter replay.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eventSourceMeta, formatEventEnvelope } from './envelope.js'

const DEFAULT_MAX_PER_HOUR = 20
const DEFAULT_COALESCE_MS = 0
const DEAD_LETTERS_MAX = 200
const CONTEXT_BUFFER_MAX = 40
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const newSubId = () => `sub_${randomBytes(4).toString('hex')}`
const newDlqId = () => `dlq_${randomBytes(4).toString('hex')}`
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path, data) {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

function minutesInZone(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms))
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    const d = new Date(ms)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  }
}

export function isQuietNow(quietHours, nowMs = Date.now()) {
  if (!quietHours || !HHMM.test(String(quietHours.start ?? '')) || !HHMM.test(String(quietHours.end ?? ''))) return false
  const [sh, sm] = quietHours.start.split(':').map(Number)
  const [eh, em] = quietHours.end.split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  if (start === end) return false
  const cur = minutesInZone(nowMs, quietHours.tz)
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

export function matchesSubscription(sub, event) {
  const match = sub.match ?? {}
  if (match.sourceId && event.source?.id !== match.sourceId) return false
  if (match.sourceKind && event.source?.kind !== match.sourceKind) return false
  if (match.threadKey) {
    const key = String(event.threadKey ?? '')
    if (match.threadKey.endsWith('*')) {
      if (!key.startsWith(match.threadKey.slice(0, -1))) return false
    } else if (key !== match.threadKey) {
      return false
    }
  }
  if (Array.isArray(match.eventTypes) && match.eventTypes.length > 0 && !match.eventTypes.includes(event.eventType)) {
    return false
  }
  if (Array.isArray(match.actorsAllow) && match.actorsAllow.length > 0) {
    const actor = String(event.source?.actor ?? '').toLowerCase()
    const allowed = match.actorsAllow.map(item => String(item).toLowerCase())
    if (!allowed.includes(actor)) return false
  }
  if (Array.isArray(match.keywords) && match.keywords.length > 0) {
    const hay = `${event.summary ?? ''}\n${event.body ?? ''}`.toLowerCase()
    if (!match.keywords.some(word => word && hay.includes(String(word).toLowerCase()))) return false
  }
  return true
}

export function createEventRouter(rt, eventLedger, { onCircuitBreak } = {}) {
  const dir = join(rt.home, 'events')
  const subsPath = join(dir, 'subscriptions.json')
  const dlqPath = join(dir, 'dead-letters.json')

  let subscriptions = readJson(subsPath, [])
  if (!Array.isArray(subscriptions)) subscriptions = []
  let deadLetters = readJson(dlqPath, [])
  if (!Array.isArray(deadLetters)) deadLetters = []

  // Ephemeral runtime state: hourly delivery timestamps, pending coalesce timers, deferred
  // quiet-hour queue, and context-only buffers per target key.
  const hourHits = new Map()
  const coalesceMap = new Map()
  const deferredQueue = new Map()
  const contextBuffers = new Map()
  const filteredCounts = new Map()
  const writes = () => rt.readOnly?.() === undefined

  const saveSubs = () => { if (writes()) writeJsonAtomic(subsPath, subscriptions) }
  const saveDlq = () => { if (writes()) writeJsonAtomic(dlqPath, deadLetters) }

  const reloadIfReadOnly = () => {
    if (!writes()) {
      const s = readJson(subsPath, [])
      if (Array.isArray(s)) subscriptions = s
      const d = readJson(dlqPath, [])
      if (Array.isArray(d)) deadLetters = d
    }
  }

  const targetKey = target => (target.kind === 'room' ? `room:${target.roomId}`
    : target.kind === 'task' ? `task:${target.botId}:${target.taskId}`
      : `bot:${target.botId}`)

  const isTargetPrivate = (target) => {
    if (target?.kind === 'room') return false
    return rt.botOf(target?.botId)?.private === true
  }

  function validateTarget(target) {
    if (!target || typeof target !== 'object') throw invalid('Subscription target is required')
    if (target.kind === 'bot') {
      if (!rt.botOf(target.botId)) throw invalid(`Unknown Bot ${target.botId}`)
      return { kind: 'bot', botId: target.botId }
    }
    if (target.kind === 'room') {
      if (!rt.roomOf(target.roomId)) throw invalid(`Unknown group chat ${target.roomId}`)
      return { kind: 'room', roomId: target.roomId }
    }
    if (target.kind === 'task') {
      const bot = rt.botOf(target.botId)
      if (!bot) throw invalid(`Unknown Bot ${target.botId}`)
      if (!target.taskId) throw invalid('Task subscription requires taskId')
      return { kind: 'task', botId: target.botId, taskId: String(target.taskId) }
    }
    throw invalid(`Unsupported target kind: ${target.kind}`)
  }

  function listSubscriptions({ callerBotId, isUser = false } = {}) {
    reloadIfReadOnly()
    return subscriptions
      .filter((sub) => {
        if (isUser) return true
        if (isTargetPrivate(sub.target) && sub.target.botId !== callerBotId) return false
        return callerBotId === undefined || sub.target.botId === callerBotId
      })
      .map(sub => ({ ...sub, filteredCount: filteredCounts.get(sub.id) ?? 0 }))
  }

  function saveSubscription(input, { callerBotId, isUser = false } = {}) {
    const target = validateTarget(input.target)
    if (!isUser && isTargetPrivate(target) && target.botId !== callerBotId) {
      throw invalid('Only the user can manage subscriptions for a private Bot')
    }
    const now = Date.now()
    const existingIdx = input.id ? subscriptions.findIndex(s => s.id === input.id) : -1
    const existing = existingIdx >= 0 ? subscriptions[existingIdx] : null
    if (existing && !isUser && isTargetPrivate(existing.target) && existing.target.botId !== callerBotId) {
      throw invalid('Only the user can modify a private Bot subscription')
    }

    const mode = input.mode === 'context' ? 'context' : 'drive'
    const maxPerHour = Number.isInteger(input.fastPath?.maxPerHour) && input.fastPath.maxPerHour > 0
      ? Math.min(500, input.fastPath.maxPerHour)
      : existing?.fastPath?.maxPerHour ?? DEFAULT_MAX_PER_HOUR
    const coalesceMs = Number.isInteger(input.fastPath?.coalesceMs) && input.fastPath.coalesceMs >= 0
      ? Math.min(3_600_000, input.fastPath.coalesceMs)
      : existing?.fastPath?.coalesceMs ?? DEFAULT_COALESCE_MS

    const record = {
      id: existing?.id ?? newSubId(),
      name: String(input.name ?? existing?.name ?? '').trim().slice(0, 100),
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true),
      pausedReason: input.enabled === true ? null : (input.pausedReason ?? existing?.pausedReason ?? null),
      target,
      mode,
      speculative: isUser ? Boolean(input.speculative ?? existing?.speculative ?? false) : Boolean(existing?.speculative ?? false),
      match: {
        ...(input.match?.sourceId ? { sourceId: String(input.match.sourceId) } : {}),
        ...(input.match?.sourceKind ? { sourceKind: String(input.match.sourceKind) } : {}),
        ...(input.match?.threadKey ? { threadKey: String(input.match.threadKey) } : {}),
        ...(Array.isArray(input.match?.eventTypes) && input.match.eventTypes.length > 0 ? { eventTypes: input.match.eventTypes.map(String) } : {}),
        ...(Array.isArray(input.match?.actorsAllow) && input.match.actorsAllow.length > 0 ? { actorsAllow: input.match.actorsAllow.map(String) } : {}),
        ...(Array.isArray(input.match?.keywords) && input.match.keywords.length > 0 ? { keywords: input.match.keywords.map(String) } : {}),
      },
      fastPath: {
        maxPerHour,
        coalesceMs,
        ...(input.fastPath?.quietHours ? { quietHours: input.fastPath.quietHours } : {}),
      },
      mandate: {
        scope: String(input.mandate?.scope ?? existing?.mandate?.scope ?? '').trim().slice(0, 500),
        allowExternalWrite: isUser ? Boolean(input.mandate?.allowExternalWrite ?? existing?.mandate?.allowExternalWrite ?? false) : false,
        createdBy: existing?.mandate?.createdBy ?? (isUser ? 'user' : callerBotId ?? 'system'),
        expiresAt: Number.isFinite(input.mandate?.expiresAt) ? input.mandate.expiresAt : (existing?.mandate?.expiresAt ?? null),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existingIdx >= 0) subscriptions[existingIdx] = record
    else subscriptions.push(record)
    saveSubs()
    return record
  }

  function toggleSubscription(id, enabled, pausedReason = null, { callerBotId, isUser = false } = {}) {
    const sub = subscriptions.find(s => s.id === id)
    if (!sub) throw invalid('Unknown subscription')
    if (!isUser && isTargetPrivate(sub.target) && sub.target.botId !== callerBotId) {
      throw invalid('Only the user can change a private Bot subscription')
    }
    sub.enabled = Boolean(enabled)
    sub.pausedReason = sub.enabled ? null : (pausedReason ?? 'paused by user')
    sub.updatedAt = Date.now()
    if (sub.enabled) hourHits.delete(sub.id)
    saveSubs()
    return sub
  }

  function deleteSubscription(id, { callerBotId, isUser = false } = {}) {
    const idx = subscriptions.findIndex(s => s.id === id)
    if (idx === -1) throw invalid('Unknown subscription')
    const sub = subscriptions[idx]
    if (!isUser && isTargetPrivate(sub.target) && sub.target.botId !== callerBotId) {
      throw invalid('Only the user can delete a private Bot subscription')
    }
    subscriptions.splice(idx, 1)
    hourHits.delete(id)
    for (const [key, entry] of coalesceMap) {
      if (key.startsWith(`${id}:`)) {
        clearTimeout(entry.timer)
        coalesceMap.delete(key)
      }
    }
    deferredQueue.delete(id)
    saveSubs()
    return true
  }

  // Resolve a stable target into a concrete live Session ID. For `task` targets, inspects
  // bot.openParts for a matching `part.task.id` (v0.3.9 async work compatibility).
  async function resolveDeliveryTarget(sub) {
    const { target } = sub
    if (target.kind === 'room') {
      const room = rt.roomOf(target.roomId)
      if (!room) throw new Error(`Group chat ${target.roomId} no longer exists`)
      return { kind: 'room', room, sessionId: rt.sessionOfRoom(room) }
    }
    const bot = rt.botOf(target.botId)
    if (!bot) throw new Error(`Bot ${target.botId} no longer exists`)
    if (target.kind === 'task') {
      const part = (bot.openParts ?? []).find(p => p.task?.id === target.taskId)
      if (!part) throw new Error(`Background task ${target.taskId} no longer exists`)
      if (part.task.status === 'stopped') {
        throw Object.assign(new Error(`Background task ${target.taskId} was stopped`), { taskStopped: true })
      }
      if (part.task.status === 'done' && sub.mode === 'drive') {
        part.task.status = 'running'
        await rt.save?.()
      }
      return { kind: 'task', bot, part, sessionId: part.sessionId }
    }
    return { kind: 'bot', bot, sessionId: rt.chatOf(bot.id) }
  }

  async function deliverNow(event, sub, { privateBotId } = {}) {
    const now = Date.now()
    const limit = sub.fastPath?.maxPerHour ?? DEFAULT_MAX_PER_HOUR
    const hits = (hourHits.get(sub.id) ?? []).filter(ts => now - ts < 3_600_000)
    if (hits.length >= limit) {
      sub.enabled = false
      sub.pausedReason = `Rate limit exceeded (${limit}/hour)`
      sub.updatedAt = now
      saveSubs()
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'paused_rate_limit', reason: sub.pausedReason, target: sub.target }, { privateBotId })
      await onCircuitBreak?.(sub, event, sub.pausedReason)
      return { outcome: 'paused_rate_limit', reason: sub.pausedReason }
    }

    if (sub.mode === 'context') {
      const key = targetKey(sub.target)
      const list = contextBuffers.get(key) ?? []
      list.push({ eventId: event.id, summary: event.summary, source: event.source, threadKey: event.threadKey, time: event.time })
      if (list.length > CONTEXT_BUFFER_MAX) list.splice(0, list.length - CONTEXT_BUFFER_MAX)
      contextBuffers.set(key, list)
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'context_buffered', reason: 'context-only subscription', target: sub.target }, { privateBotId })
      return { outcome: 'context_buffered' }
    }

    try {
      const resolved = await resolveDeliveryTarget(sub)
      const envelope = await formatEventEnvelope(rt, event, sub)
      const sourceMeta = eventSourceMeta(event, sub)
      await rt.deliverEvent({
        sessionId: resolved.sessionId,
        toId: resolved.bot?.id,
        roomId: resolved.room?.id,
        text: envelope.text,
        files: envelope.files,
        length: envelope.length,
        source: sourceMeta,
        steer: resolved.kind === 'task',
      })
      hits.push(now)
      hourHits.set(sub.id, hits)
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'delivered', target: sub.target }, { privateBotId })
      return { outcome: 'delivered', sessionId: resolved.sessionId }
    } catch (error) {
      const reason = error?.message ?? String(error)
      const dlqEntry = {
        id: newDlqId(),
        eventId: event.id,
        subId: sub.id,
        target: sub.target,
        privateBotId: privateBotId ?? null,
        summary: event.summary,
        reason,
        time: now,
      }
      deadLetters.unshift(dlqEntry)
      if (deadLetters.length > DEAD_LETTERS_MAX) deadLetters.length = DEAD_LETTERS_MAX
      saveDlq()
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'dead_letter', reason, target: sub.target }, { privateBotId })
      return { outcome: 'dead_letter', reason, deadLetterId: dlqEntry.id }
    }
  }

  async function routeEvent(event, { privateBotId, nowMs = Date.now() } = {}) {
    const results = []
    for (const sub of subscriptions) {
      if (!sub.enabled) continue
      if (sub.mandate?.expiresAt && nowMs >= sub.mandate.expiresAt) {
        sub.enabled = false
        sub.pausedReason = 'expired'
        sub.updatedAt = nowMs
        saveSubs()
        continue
      }
      // A private event only routes to its own private Bot; never leak across boundaries.
      if (privateBotId && sub.target.botId !== privateBotId) continue
      if (!privateBotId && isTargetPrivate(sub.target) && event.source?.privateBotId && event.source.privateBotId !== sub.target.botId) continue

      if (!matchesSubscription(sub, event)) {
        filteredCounts.set(sub.id, (filteredCounts.get(sub.id) ?? 0) + 1)
        continue
      }

      if (isQuietNow(sub.fastPath?.quietHours, nowMs)) {
        const action = sub.fastPath.quietHours.action === 'drop' ? 'drop' : 'defer'
        if (action === 'drop') {
          await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'filtered', reason: 'quiet hours (drop)', target: sub.target }, { privateBotId })
          results.push({ subId: sub.id, outcome: 'filtered' })
        } else {
          const list = deferredQueue.get(sub.id) ?? []
          list.push({ event, privateBotId })
          deferredQueue.set(sub.id, list)
          await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'deferred', reason: 'quiet hours (defer)', target: sub.target }, { privateBotId })
          results.push({ subId: sub.id, outcome: 'deferred' })
        }
        continue
      }

      const coalesceMs = sub.fastPath?.coalesceMs ?? 0
      const entity = event.entityKey || event.threadKey
      if (coalesceMs > 0 && entity) {
        const key = `${sub.id}:${entity}`
        const pending = coalesceMap.get(key)
        if (pending) {
          clearTimeout(pending.timer)
          await eventLedger.recordDecision({ eventId: pending.event.id, subId: sub.id, outcome: 'coalesced', reason: `replaced by ${event.id}`, target: sub.target }, { privateBotId: pending.privateBotId })
        }
        const entry = { event, privateBotId, timer: null }
        entry.timer = setTimeout(() => {
          coalesceMap.delete(key)
          void deliverNow(entry.event, sub, { privateBotId: entry.privateBotId })
        }, coalesceMs)
        entry.timer.unref?.()
        coalesceMap.set(key, entry)
        results.push({ subId: sub.id, outcome: 'coalescing' })
        continue
      }

      const res = await deliverNow(event, sub, { privateBotId })
      results.push({ subId: sub.id, ...res })
    }

    if (results.length === 0) {
      await eventLedger.recordDecision({ eventId: event.id, outcome: 'filtered', reason: 'no matching subscription' }, { privateBotId })
    }
    return results
  }

  // Flushes deferred quiet-hour events once quiet hours end.
  async function flushDeferred(nowMs = Date.now()) {
    for (const [subId, items] of deferredQueue) {
      const sub = subscriptions.find(s => s.id === subId)
      if (!sub || !sub.enabled) {
        deferredQueue.delete(subId)
        continue
      }
      if (isQuietNow(sub.fastPath?.quietHours, nowMs)) continue
      deferredQueue.delete(subId)
      // Collapse duplicate entities before flushing.
      const latestByEntity = new Map()
      const ordered = []
      for (const item of items) {
        const key = item.event.entityKey || item.event.id
        if (latestByEntity.has(key)) {
          const prev = latestByEntity.get(key)
          await eventLedger.recordDecision({ eventId: prev.event.id, subId, outcome: 'coalesced', reason: `quiet-hours collapse into ${item.event.id}`, target: sub.target }, { privateBotId: prev.privateBotId })
        }
        latestByEntity.set(key, item)
      }
      for (const item of latestByEntity.values()) ordered.push(item)
      for (const item of ordered) await deliverNow(item.event, sub, { privateBotId: item.privateBotId })
    }
  }

  async function replayDeadLetter(deadLetterId) {
    const idx = deadLetters.findIndex(d => d.id === deadLetterId)
    if (idx === -1) throw invalid('Unknown dead-letter entry')
    const entry = deadLetters[idx]
    const sub = subscriptions.find(s => s.id === entry.subId)
    if (!sub) throw invalid('Original subscription no longer exists')
    const event = eventLedger.getEvent(entry.eventId, { isUser: true })
    if (!event) throw invalid('Original event no longer exists in ledger')
    deadLetters.splice(idx, 1)
    saveDlq()
    const result = await deliverNow(event, sub, { privateBotId: entry.privateBotId ?? undefined })
    if (result.outcome === 'delivered') {
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'replayed', target: sub.target }, { privateBotId: entry.privateBotId ?? undefined })
    }
    return result
  }

  function dismissDeadLetter(deadLetterId) {
    const idx = deadLetters.findIndex(d => d.id === deadLetterId)
    if (idx === -1) return false
    deadLetters.splice(idx, 1)
    saveDlq()
    return true
  }

  function listDeadLetters() {
    reloadIfReadOnly()
    return deadLetters
  }

  function takeContextBuffer(target) {
    const key = targetKey(target)
    const items = contextBuffers.get(key) ?? []
    contextBuffers.delete(key)
    return items
  }

  function dispose() {
    for (const entry of coalesceMap.values()) clearTimeout(entry.timer)
    coalesceMap.clear()
  }

  return {
    listSubscriptions,
    saveSubscription,
    toggleSubscription,
    deleteSubscription,
    routeEvent,
    flushDeferred,
    replayDeadLetter,
    dismissDeadLetter,
    listDeadLetters,
    takeContextBuffer,
    dispose,
  }
}
