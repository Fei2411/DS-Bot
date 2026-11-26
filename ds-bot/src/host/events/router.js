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
  const pendingPath = join(dir, 'pending.json')
  const contextPath = join(dir, 'context-buffers.json')

  let subscriptions = readJson(subsPath, [])
  if (!Array.isArray(subscriptions)) subscriptions = []
  let deadLetters = readJson(dlqPath, [])
  if (!Array.isArray(deadLetters)) deadLetters = []

  // Runtime state: hourly delivery timestamps, pending coalesce timers, deferred
  // quiet-hour queue, and context-only buffers per target key.
  const hourHits = new Map()
  const coalesceMap = new Map()
  const deferredQueue = new Map()
  const contextBuffers = new Map()
  const savedContext = readJson(contextPath, {})
  if (savedContext && typeof savedContext === 'object') {
    for (const [key, list] of Object.entries(savedContext)) {
      if (Array.isArray(list) && list.length > 0) contextBuffers.set(key, list.slice(-CONTEXT_BUFFER_MAX))
    }
  }
  const filteredCounts = new Map()
  const writes = () => rt.readOnly?.() === undefined
  const assertWritable = () => {
    if (!writes()) throw invalid('Team is read-only in this window')
  }

  const saveSubs = () => { if (writes()) writeJsonAtomic(subsPath, subscriptions) }
  const saveDlq = () => { if (writes()) writeJsonAtomic(dlqPath, deadLetters) }
  const saveContext = () => {
    if (!writes()) return
    const obj = {}
    for (const [key, list] of contextBuffers) {
      if (list.length > 0) obj[key] = list
    }
    writeJsonAtomic(contextPath, obj)
  }
  const savePending = () => {
    if (!writes()) return
    const deferred = []
    for (const [subId, items] of deferredQueue) {
      for (const item of items) {
        deferred.push({
          subId,
          eventId: item.event.id,
          privateBotId: item.privateBotId ?? null,
          queuedAt: item.queuedAt ?? Date.now(),
        })
      }
    }
    const coalesce = []
    for (const [key, entry] of coalesceMap) {
      coalesce.push({
        key,
        subId: entry.subId,
        entity: entry.entity,
        eventId: entry.event.id,
        privateBotId: entry.privateBotId ?? null,
        dueAt: entry.dueAt,
      })
    }
    writeJsonAtomic(pendingPath, { deferred, coalesce })
  }

  function reloadStateFromDisk() {
    const s = readJson(subsPath, [])
    if (Array.isArray(s)) subscriptions = s
    const d = readJson(dlqPath, [])
    if (Array.isArray(d)) deadLetters = d
    contextBuffers.clear()
    const ctxData = readJson(contextPath, {})
    if (ctxData && typeof ctxData === 'object') {
      for (const [key, list] of Object.entries(ctxData)) {
        if (Array.isArray(list) && list.length > 0) contextBuffers.set(key, list.slice(-CONTEXT_BUFFER_MAX))
      }
    }
  }

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

  const targetAllowed = (target, allowedTargets) => {
    if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) return true
    if (target.kind === 'room') {
      return allowedTargets.includes(target.roomId) || allowedTargets.includes(`room:${target.roomId}`)
    }
    return allowedTargets.includes(target.botId) || allowedTargets.includes(`bot:${target.botId}`)
  }

  function assertBotCanManageExisting(sub, callerBotId) {
    if (!callerBotId) throw invalid('Caller identity is required')
    if (sub.mandate?.createdBy === 'user') {
      throw invalid('Only the user can modify or delete a user-created subscription')
    }
    if (sub.target.kind === 'room') {
      if (sub.mandate?.createdBy !== callerBotId) {
        throw invalid('Only the Bot that created this group subscription or the user can modify it')
      }
      return
    }
    if (sub.target.botId !== callerBotId) {
      throw invalid('Bots can only manage their own subscriptions')
    }
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

  function listSubscriptions({ callerBotId, callerRoomId, isUser = false } = {}) {
    reloadIfReadOnly()
    return subscriptions
      .filter((sub) => {
        if (isUser) return true
        if (isTargetPrivate(sub.target) && sub.target.botId !== callerBotId) return false
        if (callerBotId === undefined) return true
        if (sub.target.botId === callerBotId) return true
        if (sub.target.kind === 'room') {
          if (callerRoomId && sub.target.roomId === callerRoomId) return true
          if (sub.mandate?.createdBy === callerBotId) return true
        }
        return false
      })
      .map(sub => ({ ...sub, filteredCount: filteredCounts.get(sub.id) ?? 0 }))
  }

  function saveSubscription(input, { callerBotId, isUser = false } = {}) {
    assertWritable()
    const target = validateTarget(input.target)
    if (!isUser) {
      if (!callerBotId) throw invalid('Caller identity is required')
      if (target.kind === 'room') {
        const room = rt.roomOf(target.roomId)
        if (!room?.members?.includes(callerBotId)) {
          throw invalid('A Bot can only subscribe a group chat it belongs to')
        }
      } else if (target.botId !== callerBotId) {
        throw invalid('Bots can only create subscriptions for themselves')
      }
    }
    const now = Date.now()
    const existingIdx = input.id ? subscriptions.findIndex(s => s.id === input.id) : -1
    const existing = existingIdx >= 0 ? subscriptions[existingIdx] : null
    if (existing && !isUser) assertBotCanManageExisting(existing, callerBotId)

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

  function clearCoalesceForSub(id) {
    let changed = false
    for (const [key, entry] of coalesceMap) {
      if (key.startsWith(`${id}:`)) {
        clearTimeout(entry.timer)
        coalesceMap.delete(key)
        changed = true
      }
    }
    if (changed) savePending()
  }

  function toggleSubscription(id, enabled, pausedReason = null, { callerBotId, isUser = false } = {}) {
    assertWritable()
    const sub = subscriptions.find(s => s.id === id)
    if (!sub) throw invalid('Unknown subscription')
    if (!isUser) assertBotCanManageExisting(sub, callerBotId)
    sub.enabled = Boolean(enabled)
    sub.pausedReason = sub.enabled ? null : (pausedReason ?? 'paused by user')
    sub.updatedAt = Date.now()
    if (sub.enabled) hourHits.delete(sub.id)
    else clearCoalesceForSub(sub.id)
    saveSubs()
    return sub
  }

  function deleteSubscription(id, { callerBotId, isUser = false } = {}) {
    assertWritable()
    const idx = subscriptions.findIndex(s => s.id === id)
    if (idx === -1) throw invalid('Unknown subscription')
    const sub = subscriptions[idx]
    if (!isUser) assertBotCanManageExisting(sub, callerBotId)
    subscriptions.splice(idx, 1)
    hourHits.delete(id)
    clearCoalesceForSub(id)
    if (deferredQueue.delete(id)) savePending()
    saveSubs()
    return true
  }

  // Resolve a stable target into a concrete live Session ID. For `task` targets, looks up
  // the background task in `bot.tasks`.
  function resolveDeliveryTarget(sub) {
    const { target } = sub
    if (target.kind === 'room') {
      const room = rt.roomOf(target.roomId)
      if (!room) throw new Error(`Group chat ${target.roomId} no longer exists`)
      return { kind: 'room', room, sessionId: rt.sessionOfRoom(room) }
    }
    const bot = rt.botOf(target.botId)
    if (!bot) throw new Error(`Bot ${target.botId} no longer exists`)
    if (target.kind === 'task') {
      const task = (bot.tasks ?? []).find(t => t.id === target.taskId)
      if (!task) throw new Error(`Background task ${target.taskId} no longer exists`)
      if (task.status === 'stopped') {
        throw Object.assign(new Error(`Background task ${target.taskId} was stopped`), { taskStopped: true })
      }
      if (!task.sessionId) throw new Error(`Background task ${target.taskId} session is unavailable`)
      return {
        kind: 'task',
        bot,
        task,
        sessionId: task.sessionId,
        resumeDoneTask: (task.status === 'completed' || task.status === 'done') && sub.mode === 'drive',
      }
    }
    return { kind: 'bot', bot, sessionId: rt.chatOf(bot.id) }
  }

  async function deliverNow(event, sub, { privateBotId, isVirtual = false } = {}) {
    const now = Date.now()
    const targetPrivate = isTargetPrivate(sub.target)
    // Decisions targeting a private Bot ALWAYS write to that Bot's private ledger scope so
    // non-private Bots calling read_event on a shared event never see its botId or subId.
    const decisionPrivateBotId = privateBotId ?? (targetPrivate ? sub.target.botId : undefined)
    const limit = sub.fastPath?.maxPerHour ?? DEFAULT_MAX_PER_HOUR
    const hits = (hourHits.get(sub.id) ?? []).filter(ts => now - ts < 3_600_000)
    if (hits.length >= limit) {
      const reason = `Rate limit exceeded (${limit}/hour)`
      if (!isVirtual) {
        sub.enabled = false
        sub.pausedReason = reason
        sub.updatedAt = now
        saveSubs()
      } else {
        // Never silently drop virtual watcher / direct Push deliveries on rate limit:
        // retain them in dead-letters so the user sees them in Inbox and can replay.
        const dlqEntry = {
          id: newDlqId(),
          eventId: event.id,
          subId: sub.id,
          subName: sub.name || '',
          target: sub.target,
          mode: sub.mode,
          speculative: Boolean(sub.speculative),
          mandate: sub.mandate ?? null,
          isVirtual: true,
          privateBotId: decisionPrivateBotId ?? null,
          summary: event.summary,
          reason,
          time: now,
        }
        deadLetters.unshift(dlqEntry)
        if (deadLetters.length > DEAD_LETTERS_MAX) deadLetters.length = DEAD_LETTERS_MAX
        saveDlq()
      }
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'paused_rate_limit', reason, target: sub.target }, { privateBotId: decisionPrivateBotId })
      await onCircuitBreak?.(sub, event, reason)
      return { outcome: 'paused_rate_limit', reason, privateTarget: targetPrivate }
    }

    if (sub.mode === 'context') {
      const key = targetKey(sub.target)
      const list = contextBuffers.get(key) ?? []
      list.push({
        eventId: event.id,
        summary: event.summary,
        source: event.source,
        trust: event.trust,
        threadKey: event.threadKey,
        eventType: event.eventType,
        time: event.time,
      })
      if (list.length > CONTEXT_BUFFER_MAX) list.splice(0, list.length - CONTEXT_BUFFER_MAX)
      contextBuffers.set(key, list)
      saveContext()
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'context_buffered', reason: 'context-only subscription', target: sub.target }, { privateBotId: decisionPrivateBotId })
      return { outcome: 'context_buffered', privateTarget: targetPrivate }
    }

    try {
      const resolved = resolveDeliveryTarget(sub)
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
      if (resolved.resumeDoneTask) {
        resolved.task.status = 'running'
        resolved.task.updatedAt = Date.now()
        delete resolved.task.endedAt
        await rt.save?.()
      }
      hits.push(now)
      hourHits.set(sub.id, hits)
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'delivered', target: sub.target }, { privateBotId: decisionPrivateBotId })
      return { outcome: 'delivered', sessionId: resolved.sessionId, targetKey: targetKey(sub.target), privateTarget: targetPrivate }
    } catch (error) {
      const reason = error?.message ?? String(error)
      const dlqEntry = {
        id: newDlqId(),
        eventId: event.id,
        subId: sub.id,
        subName: sub.name || '',
        target: sub.target,
        mode: sub.mode,
        speculative: Boolean(sub.speculative),
        mandate: sub.mandate ?? null,
        isVirtual: Boolean(isVirtual),
        privateBotId: decisionPrivateBotId ?? null,
        summary: event.summary,
        reason,
        time: now,
      }
      deadLetters.unshift(dlqEntry)
      if (deadLetters.length > DEAD_LETTERS_MAX) deadLetters.length = DEAD_LETTERS_MAX
      saveDlq()
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'dead_letter', reason, target: sub.target }, { privateBotId: decisionPrivateBotId })
      return { outcome: 'dead_letter', reason, deadLetterId: dlqEntry.id, privateTarget: targetPrivate }
    }
  }

  async function deliverToVirtual(event, virtualSub, { privateBotId } = {}) {
    return deliverNow(event, virtualSub, { privateBotId, isVirtual: true })
  }

  function scheduleCoalesceEntry(key, { subId, entity, event, privateBotId, dueAt }) {
    const delay = Math.max(0, dueAt - Date.now())
    const entry = { subId, entity, event, privateBotId, dueAt, timer: null }
    entry.timer = setTimeout(() => {
      coalesceMap.delete(key)
      savePending()
      const current = subscriptions.find(s => s.id === subId)
      if (!current || !current.enabled) return
      void deliverNow(entry.event, current, { privateBotId: entry.privateBotId })
    }, delay)
    entry.timer.unref?.()
    coalesceMap.set(key, entry)
    savePending()
  }

  async function routeEvent(event, { privateBotId, allowedTargets, canAccessTarget, nowMs = Date.now(), recordUnmatched = true } = {}) {
    const results = []
    const handledTargets = new Set()
    let matchedAny = false
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
      // Token-scoped Push / External API events may only route to targets explicitly authorized on the token.
      if (!targetAllowed(sub.target, allowedTargets)) continue
      if (typeof canAccessTarget === 'function' && !canAccessTarget(sub.target)) continue

      if (!matchesSubscription(sub, event)) {
        filteredCounts.set(sub.id, (filteredCounts.get(sub.id) ?? 0) + 1)
        continue
      }
      matchedAny = true
      const subTargetKey = targetKey(sub.target)
      const targetPrivate = isTargetPrivate(sub.target)
      const decisionPrivateBotId = privateBotId ?? (targetPrivate ? sub.target.botId : undefined)
      // Once an enabled subscription matches this target, it governs policy (quiet hours,
      // coalescing, rate-limit, delivery) so virtual direct delivery never bypasses it.
      handledTargets.add(subTargetKey)

      if (isQuietNow(sub.fastPath?.quietHours, nowMs)) {
        const action = sub.fastPath.quietHours.action === 'drop' ? 'drop' : 'defer'
        if (action === 'drop') {
          await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'filtered', reason: 'quiet hours (drop)', target: sub.target }, { privateBotId: decisionPrivateBotId })
          results.push({ subId: sub.id, outcome: 'filtered', privateTarget: targetPrivate })
        } else {
          const list = deferredQueue.get(sub.id) ?? []
          list.push({ event, privateBotId: decisionPrivateBotId, queuedAt: nowMs })
          deferredQueue.set(sub.id, list)
          savePending()
          await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'deferred', reason: 'quiet hours (defer)', target: sub.target }, { privateBotId: decisionPrivateBotId })
          results.push({ subId: sub.id, outcome: 'deferred', privateTarget: targetPrivate })
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
        scheduleCoalesceEntry(key, {
          subId: sub.id,
          entity,
          event,
          privateBotId: decisionPrivateBotId,
          dueAt: nowMs + coalesceMs,
        })
        results.push({ subId: sub.id, outcome: 'coalescing', privateTarget: targetPrivate })
        continue
      }

      const res = await deliverNow(event, sub, { privateBotId: decisionPrivateBotId })
      results.push({ subId: sub.id, ...res })
    }

    if (!matchedAny && recordUnmatched) {
      await eventLedger.recordDecision({ eventId: event.id, outcome: 'filtered', reason: 'no matching subscription' }, { privateBotId })
    }
    return { matchedAny, handledTargets, results }
  }

  // Flushes deferred quiet-hour events once quiet hours end.
  async function flushDeferred(nowMs = Date.now()) {
    let changed = false
    for (const [subId, items] of deferredQueue) {
      const sub = subscriptions.find(s => s.id === subId)
      if (!sub || !sub.enabled) {
        deferredQueue.delete(subId)
        changed = true
        continue
      }
      if (isQuietNow(sub.fastPath?.quietHours, nowMs)) continue
      deferredQueue.delete(subId)
      changed = true
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
    if (changed) savePending()
  }

  // Reload persisted state + deferred/coalescing deliveries on startup or lock takeover.
  // Always rebuild runtime queues strictly from the persisted snapshot so lock handovers
  // (A -> B -> A) never replay stale in-memory items already flushed by another host.
  async function recoverPending(nowMs = Date.now()) {
    if (!writes()) return { deferred: 0, coalesced: 0 }
    for (const entry of coalesceMap.values()) clearTimeout(entry.timer)
    coalesceMap.clear()
    deferredQueue.clear()
    reloadStateFromDisk()
    const saved = readJson(pendingPath, null)
    if (!saved || typeof saved !== 'object') return { deferred: 0, coalesced: 0 }
    let restoredDeferred = 0
    let restoredCoalesce = 0
    for (const item of (Array.isArray(saved.deferred) ? saved.deferred : [])) {
      const sub = subscriptions.find(s => s.id === item.subId && s.enabled)
      if (!sub) continue
      const ev = eventLedger.getEvent(item.eventId, { isUser: true })
      if (!ev) continue
      const list = deferredQueue.get(item.subId) ?? []
      if (list.some(existing => existing.event.id === ev.id)) continue
      list.push({ event: ev, privateBotId: item.privateBotId ?? undefined, queuedAt: item.queuedAt ?? nowMs })
      deferredQueue.set(item.subId, list)
      restoredDeferred += 1
    }
    for (const item of (Array.isArray(saved.coalesce) ? saved.coalesce : [])) {
      const sub = subscriptions.find(s => s.id === item.subId && s.enabled)
      if (!sub) continue
      const ev = eventLedger.getEvent(item.eventId, { isUser: true })
      if (!ev) continue
      if (coalesceMap.has(item.key)) continue
      restoredCoalesce += 1
      if (nowMs >= (item.dueAt ?? 0)) {
        await deliverNow(ev, sub, { privateBotId: item.privateBotId ?? undefined })
      } else {
        scheduleCoalesceEntry(item.key, {
          subId: item.subId,
          entity: item.entity,
          event: ev,
          privateBotId: item.privateBotId ?? undefined,
          dueAt: item.dueAt,
        })
      }
    }
    await flushDeferred(nowMs)
    savePending()
    return { deferred: restoredDeferred, coalesced: restoredCoalesce }
  }

  async function replayDeadLetter(deadLetterId) {
    assertWritable()
    const idx = deadLetters.findIndex(d => d.id === deadLetterId)
    if (idx === -1) throw invalid('Unknown dead-letter entry')
    const entry = deadLetters[idx]
    let sub = subscriptions.find(s => s.id === entry.subId)
    let isVirtual = false
    if (!sub) {
      if (!entry.target) throw invalid('Original subscription no longer exists')
      isVirtual = true
      sub = {
        id: entry.subId || `replay_${entry.id}`,
        name: entry.subName || 'Replayed event',
        enabled: true,
        target: entry.target,
        mode: entry.mode === 'context' ? 'context' : 'drive',
        speculative: Boolean(entry.speculative),
        fastPath: { maxPerHour: DEFAULT_MAX_PER_HOUR, coalesceMs: 0 },
        mandate: entry.mandate ?? { scope: '', allowExternalWrite: false },
      }
    }
    const event = eventLedger.getEvent(entry.eventId, { isUser: true })
    if (!event) throw invalid('Original event no longer exists in ledger')
    deadLetters.splice(idx, 1)
    saveDlq()
    const result = await deliverNow(event, sub, { privateBotId: entry.privateBotId ?? undefined, isVirtual })
    if (result.outcome === 'delivered') {
      await eventLedger.recordDecision({ eventId: event.id, subId: sub.id, outcome: 'replayed', target: sub.target }, { privateBotId: entry.privateBotId ?? undefined })
    }
    return result
  }

  function dismissDeadLetter(deadLetterId) {
    assertWritable()
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
    if (items.length > 0) {
      contextBuffers.delete(key)
      saveContext()
    }
    return items
  }

  function matchDryRun(event, { privateBotId, allowedTargets, canAccessTarget, nowMs = Date.now() } = {}) {
    const matched = []
    for (const sub of subscriptions) {
      if (!sub.enabled) continue
      if (sub.mandate?.expiresAt && nowMs >= sub.mandate.expiresAt) continue
      if (privateBotId && sub.target.botId !== privateBotId) continue
      if (!privateBotId && isTargetPrivate(sub.target) && event.source?.privateBotId && event.source.privateBotId !== sub.target.botId) continue
      if (!targetAllowed(sub.target, allowedTargets)) continue
      if (typeof canAccessTarget === 'function' && !canAccessTarget(sub.target)) continue
      if (matchesSubscription(sub, event)) matched.push(sub.id)
    }
    return matched
  }

  function resetRateLimit(subId) {
    if (typeof subId === 'string' && subId !== '') hourHits.delete(subId)
  }

  function dispose() {
    for (const entry of coalesceMap.values()) clearTimeout(entry.timer)
    coalesceMap.clear()
    deferredQueue.clear()
  }

  return {
    listSubscriptions,
    saveSubscription,
    toggleSubscription,
    deleteSubscription,
    routeEvent,
    matchDryRun,
    deliverToVirtual,
    resetRateLimit,
    flushDeferred,
    recoverPending,
    replayDeadLetter,
    dismissDeadLetter,
    listDeadLetters,
    takeContextBuffer,
    targetKey,
    dispose,
  }
}
