// Watchdog (#781): zero-token host supervisor that detects stalled turns or background
// tasks, orphan subscriptions, paused/broken watchers, and dead-letter deliveries. Never
// silently drops stuck work: surfaces actionable alerts in the unified Inbox and event log.
import { randomBytes } from 'node:crypto'
import { taskOfSession, threadOfPart } from '../threads.js'

const DEFAULT_STALL_MS = 10 * 60_000
const DEFAULT_POLL_MS = 60_000

const newAlertId = () => `al_${randomBytes(4).toString('hex')}`

export function createWatchdog(rt, { eventLedger, router, watchers, onPublish } = {}) {
  const alerts = new Map()
  const lastActivityAt = new Map()
  let timer = null

  const writes = () => rt.readOnly?.() === undefined
  const stallThresholdMs = () => {
    const configured = rt.config.events?.watchdogStallMs ?? rt.state?.prefs?.watchdogStallMs
    return Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_STALL_MS
  }

  // Track genuine forward progress (stream deltas, tool calls, turn starts) per Session.
  const markProgress = (sessionId, at = Date.now()) => {
    if (sessionId) lastActivityAt.set(sessionId, at)
  }
  const clearProgress = (sessionId) => {
    if (!sessionId) return
    lastActivityAt.delete(sessionId)
    for (const [id, alert] of alerts) {
      if (alert.kind === 'stalled_turn' && alert.sessionId === sessionId) alerts.delete(id)
    }
  }

  function addAlert(alert) {
    // Deduplicate active alerts by semantic key so the Inbox never floods.
    for (const existing of alerts.values()) {
      if (existing.dedupeKey && existing.dedupeKey === alert.dedupeKey) {
        existing.reason = alert.reason
        existing.updatedAt = Date.now()
        return existing
      }
    }
    const record = {
      id: newAlertId(),
      time: Date.now(),
      updatedAt: Date.now(),
      ...alert,
    }
    alerts.set(record.id, record)
    onPublish?.()
    return record
  }

  function dismissAlert(id) {
    const ok = alerts.delete(id)
    if (ok) onPublish?.()
    return ok
  }

  function dismissAlertByKey(dedupeKey) {
    if (!dedupeKey) return false
    let removed = false
    for (const [id, alert] of alerts) {
      if (alert.dedupeKey === dedupeKey) {
        alerts.delete(id)
        removed = true
      }
    }
    if (removed) onPublish?.()
    return removed
  }

  async function recordWatchdogEvent(eventType, summary, body, meta = {}, { privateBotId } = {}) {
    return eventLedger.recordEvent({
      source: { kind: 'watchdog', id: 'watchdog', name: 'Watchdog', actor: 'host', actorTrusted: true },
      trust: 'team',
      threadKey: meta.threadKey ?? `watchdog:${eventType}`,
      entityKey: meta.entityKey ?? `watchdog:${eventType}`,
      eventType,
      dedupeKey: meta.dedupeKey ?? '',
      summary,
      body,
      meta,
    }, { privateBotId })
  }

  async function sweep(nowMs = Date.now()) {
    if (!writes()) return { alerts: 0, orphans: 0 }
    let createdAlerts = 0
    let pausedOrphans = 0

    // 1. Flush any deferred quiet-hour deliveries whose quiet window just ended.
    await router.flushDeferred(nowMs)

    // 2. Detect stalled turns / background tasks with no active approval, running jobs, or subagents.
    const threshold = stallThresholdMs()
    const pendingApprovals = new Set((rt.approvalsView?.() ?? []).map(a => a.sessionId))
    for (const [sessionId, liveEntry] of (rt.live?.entries?.() ?? [])) {
      if (liveEntry?.turn === undefined) continue
      if (pendingApprovals.has(sessionId)) continue
      if ((rt.runningJobs?.(sessionId)?.length ?? 0) > 0) continue
      if (rt.hasSubagents?.(sessionId) === true) continue
      const lastAt = lastActivityAt.get(sessionId) ?? liveEntry.since ?? liveEntry.startedAt ?? nowMs
      if (nowMs - lastAt < threshold) continue

      const botId = rt.selfOf?.(sessionId) ?? rt.chatOwners?.get(sessionId)
      const roomId = rt.groupOwners?.get(sessionId)?.roomId ?? null
      const bot = botId ? rt.botOf(botId) : undefined
      const task = taskOfSession(bot, sessionId)
        ?? (() => {
          const thread = threadOfPart(bot, sessionId)
          return thread?.thread === 'task' ? bot?.tasks?.[thread.index] : undefined
        })()
      const label = task ? `Background task "${task.title}" (${bot?.name ?? botId})` : (bot?.name ?? sessionId)
      const minutes = Math.max(1, Math.round((nowMs - lastAt) / 60_000))
      const dedupeKey = `stalled:${sessionId}:${liveEntry.turn}`
      const existed = [...alerts.values()].some(a => a.dedupeKey === dedupeKey)
      if (!existed) {
        const reason = `No progress for ${minutes} min (no stream, tool call, or pending approval)`
        addAlert({
          kind: 'stalled_turn',
          dedupeKey,
          sessionId,
          botId: bot?.id ?? null,
          roomId,
          taskId: task?.id ?? null,
          title: `${label} appears stalled`,
          reason,
        })
        await recordWatchdogEvent('watchdog.stalled', `${label} stalled (${minutes}m)`, reason, {
          sessionId,
          botId: bot?.id,
          taskId: task?.id,
          threadKey: `watchdog:stalled:${sessionId}`,
          dedupeKey,
        }, { privateBotId: bot?.private === true ? bot.id : undefined })
        createdAlerts += 1
      }
    }

    // 3. Auto-pause orphan subscriptions whose Bot, group, or background task is gone/stopped.
    for (const sub of router.listSubscriptions({ isUser: true })) {
      if (!sub.enabled) continue
      const { target } = sub
      let orphanReason = null
      if (target.kind === 'bot' && !rt.botOf(target.botId)) orphanReason = 'Target Bot was removed'
      else if (target.kind === 'room' && !rt.roomOf(target.roomId)) orphanReason = 'Target group chat was removed'
      else if (target.kind === 'task') {
        const bot = rt.botOf(target.botId)
        const task = (bot?.tasks ?? []).find(t => t.id === target.taskId)
        if (!bot || !task) orphanReason = 'Background task no longer exists'
        else if (task.status === 'stopped') orphanReason = 'Background task was stopped'
      }
      if (orphanReason) {
        router.toggleSubscription(sub.id, false, orphanReason, { isUser: true })
        pausedOrphans += 1
      }
    }

    // 4. Prune expired monthly event ledger books.
    eventLedger.pruneOldBooks(rt.state?.prefs?.eventRetentionDays ?? 30)

    return { alerts: createdAlerts, orphans: pausedOrphans }
  }

  function listAlerts() {
    const out = [...alerts.values()]
    // Include currently paused watchers and rate-limited subscriptions so user always sees why.
    for (const w of watchers.listWatchers({ isUser: true })) {
      if (!w.enabled && w.runtime?.pausedReason) {
        out.push({
          id: `wp_${w.id}`,
          kind: 'watcher_paused',
          watcherId: w.id,
          title: `Watcher "${w.name}" paused`,
          reason: w.runtime.pausedReason,
          botId: w.target?.botId ?? null,
          roomId: w.target?.roomId ?? null,
          time: w.runtime.lastCheckedAt ?? w.updatedAt,
        })
      }
    }
    for (const sub of router.listSubscriptions({ isUser: true })) {
      if (!sub.enabled && sub.pausedReason && sub.pausedReason !== 'paused by user') {
        out.push({
          id: `sp_${sub.id}`,
          kind: 'subscription_paused',
          subId: sub.id,
          title: `Subscription "${sub.name || sub.match?.threadKey || sub.id}" paused`,
          reason: sub.pausedReason,
          botId: sub.target?.botId ?? null,
          roomId: sub.target?.roomId ?? null,
          time: sub.updatedAt,
        })
      }
    }
    for (const dlq of router.listDeadLetters()) {
      out.push({
        id: `dlq_${dlq.id}`,
        deadLetterId: dlq.id,
        kind: 'dead_letter',
        title: `Delivery failed: ${dlq.summary || dlq.eventId}`,
        reason: dlq.reason,
        botId: dlq.target?.botId ?? null,
        roomId: dlq.target?.roomId ?? null,
        time: dlq.time,
      })
    }
    out.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    return out
  }

  function start() {
    if (!writes() || timer !== null || rt.config.events?.disableTimers === true) return
    const ms = rt.config.events?.watchdogPollMs ?? DEFAULT_POLL_MS
    timer = setInterval(() => {
      void sweep().catch(() => {})
    }, ms)
    timer.unref?.()
  }

  function dispose() {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  return {
    markProgress,
    clearProgress,
    addAlert,
    dismissAlert,
    dismissAlertByKey,
    sweep,
    listAlerts,
    start,
    dispose,
  }
}
