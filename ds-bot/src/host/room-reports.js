// Group report-back watchers (`state.roomReports`): a post_to_group call that wants the
// outcome back waits until the group work it triggered truly finishes (long replies past
// 15s, approvals, group background tasks, intra-group batches and relays, and any active
// group_goal), then delivers once to the caller's conversation.
import { randomUUID } from 'node:crypto'
import { LATE_ANSWER, MESSAGE_INLINE_MAX, SOURCE_KIND } from './constants.js'
import { normalizeImOrigin, sameImOrigin } from './im/origin.js'
import { addressedSession, returnAddress } from './threads.js'
import { failureLine } from './turns.js'

const STOPPED_RELAYS_KEPT = 200

export function createRoomReports(rt, deps) {
  const { ctx } = rt
  const {
    batches,
    closeBatch,
    exitMemberBatches,
    releaseIdleParentBatches,
    pendingDirectRelays,
    activeInRoom,
    runningRound,
    isFinalizing,
    isDisposed = () => false,
    laterPostsOf,
    bookOf,
    ensureRoomLog,
    rowOf,
    saveSoon,
    nextRoomSeq,
  } = deps

  const reports = () => (rt.state.roomReports ??= {})
  const returning = new Set()
  // Follow-up relays queued on a room's own Session and not yet taken into roomInbox.
  // Maps `roomId -> Map<exchangeId, reportId | undefined>` so startup checks each report's
  // own relay without letting a surviving sibling mask a missing report.
  const queuedRelays = new Map()
  // Late member replies/failures mid-async-post before postToRoom queues their follow-up.
  const inFlightLate = new Map()
  // Active or queued room work origin (`roomId -> { origin?: ImOrigin, mixed: boolean }`),
  // so same-IM `report_back: false` posts followed by `report_back: true` stay untainted
  // while mixed Web/IM or cross-chat posts taint cleanly.
  const roomOrigins = new Map()
  // Monotonic mutation counter so a failed flush never rolls back concurrent taint,
  // and deleting a room cleans up originVersions without ever reusing an old version.
  const originVersions = new Map()
  let nextOriginVersion = 0
  const bumpOriginVersion = (roomId) => {
    const next = ++nextOriginVersion
    originVersions.set(roomId, next)
    return next
  }
  // Guards against scheduling duplicate idle re-checks during a DSH preStep startup window.
  const pendingStartupRechecks = new Set()
  // Relays that postToRoom is synchronously withdrawing after a failed flush: suppress
  // agent/inbox/discarded so it never settles the failed report as "stopped" or settles
  // a sibling report before postToRoom rolls back its origin taint.
  const withdrawingRelays = new Set()
  const withWithdrawingRelay = (exchangeId, fn) => {
    if (typeof exchangeId === 'string' && exchangeId !== '') withdrawingRelays.add(exchangeId)
    try {
      return fn()
    } finally {
      if (typeof exchangeId === 'string' && exchangeId !== '') withdrawingRelays.delete(exchangeId)
    }
  }
  // Bounded set of exchangeId / reportId values cancelled by stopRoomWork so even a
  // relay already claimed out of the room Session inbox cannot resurrect a stopped report.
  const stoppedRelays = new Set()

  const rememberStoppedRelay = (id) => {
    if (typeof id !== 'string' || id === '') return
    stoppedRelays.add(id)
    if (stoppedRelays.size > STOPPED_RELAYS_KEPT) stoppedRelays.delete(stoppedRelays.values().next().value)
  }
  const isStoppedRelay = post => post?.goal !== 'draft'
    && ((typeof post?.exchangeId === 'string' && stoppedRelays.has(post.exchangeId))
      || (typeof post?.reportId === 'string' && stoppedRelays.has(post.reportId)))
  const isBotPendingPost = post => post !== undefined
    && ((post.botId !== undefined && post.stopped !== true) || post.goal === 'nudge' || post.goal === 'resume')

  const noteRoomRelayQueued = (roomId, exchangeId, reportId) => {
    if (typeof roomId !== 'string' || typeof exchangeId !== 'string' || exchangeId === '') return
    let map = queuedRelays.get(roomId)
    if (map === undefined) queuedRelays.set(roomId, map = new Map())
    map.set(exchangeId, reportId)
  }
  const hasQueuedRelayForReport = (roomId, report) => {
    const map = queuedRelays.get(roomId)
    if (map === undefined) return false
    for (const rid of map.values()) {
      if (rid !== undefined && (rid === report.id || (report.sub !== undefined && rid === report.sub))) return true
    }
    return false
  }
  const roomRelayTaken = (roomId, exchangeId) => {
    const map = queuedRelays.get(roomId)
    if (map === undefined) return
    map.delete(exchangeId)
    if (map.size === 0) queuedRelays.delete(roomId)
  }
  const enterLate = (roomId) => inFlightLate.set(roomId, (inFlightLate.get(roomId) ?? 0) + 1)
  const leaveLate = (roomId) => {
    const next = (inFlightLate.get(roomId) ?? 1) - 1
    if (next <= 0) inFlightLate.delete(roomId)
    else inFlightLate.set(roomId, next)
  }

  const createReport = (room, {
    id,
    botId,
    name,
    status = 'tracking',
    fromSeq = nextRoomSeq(room),
    ids,
    paused = false,
    sub,
    fromTaskId,
    fromRoomId,
    fromPart,
    imOrigin,
    imOriginMixed = false,
  }) => {
    const cleanOrigin = normalizeImOrigin(imOrigin)
    return {
      id,
      roomId: room.id,
      botId,
      name: name ?? rt.botOf(botId)?.name ?? 'Bot',
      status,
      fromSeq,
      ...(Array.isArray(ids) ? { ids } : {}),
      ...(paused ? { paused: true } : {}),
      passed: [],
      failed: [],
      at: Date.now(),
      ...(sub ? { sub } : {}),
      ...(fromTaskId ? { fromTaskId } : {}),
      ...(fromRoomId ? { fromRoomId } : {}),
      ...(fromPart ? { fromPart } : {}),
      ...(cleanOrigin && !imOriginMixed ? { imOrigin: cleanOrigin } : {}),
      ...(imOriginMixed ? { imOriginMixed: true } : {}),
    }
  }

  const dropRoomReport = (id) => {
    if (id === undefined || reports()[id] === undefined) return
    delete reports()[id]
    saveSoon()
  }

  // Only already-tracking non-scoped reports carry whole-room outcomes (such as group_goal
  // completion); a queued post or a mid-round scoped post targeting a subset of members must
  // not suppress standalone goal notifications to the primary Main Bot.
  const hasRoomReportFor = (roomId, botId) => Object.values(reports())
    .some(report => report.roomId === roomId && report.botId === botId && report.status === 'tracking' && !Array.isArray(report.ids))

  const roomReportImOrigin = (roomId, targetBotId) => {
    const active = Object.values(reports()).filter(report => report.roomId === roomId && rt.botOf(report.botId) !== undefined)
    if (active.length === 0) return undefined
    const first = active[0].imOrigin
    if (first === undefined) return undefined
    for (const report of active) {
      if (!sameImOrigin(report.imOrigin, first)) return undefined
    }
    if (targetBotId !== undefined && !active.some(report => !Array.isArray(report.ids) || report.ids.includes(targetBotId))) {
      return undefined
    }
    return first
  }

  // Unrelated local Web input or a conflicting Bot post entering a room while an IM-origin
  // report is pending taints the report's IM origin so unrelated replies and local approvals
  // never leak back to the IM chat.
  const taintRoomReportOrigins = (roomId, incomingOrigin, { excludeReportId } = {}) => {
    let changed = false
    for (const report of Object.values(reports())) {
      if (report.roomId !== roomId || report.id === excludeReportId) continue
      if (report.imOrigin === undefined) continue
      if (!sameImOrigin(report.imOrigin, incomingOrigin)) {
        delete report.imOrigin
        report.imOriginMixed = true
        changed = true
      }
    }
    if (changed) saveSoon()
  }

  const memberBusyForReport = (room, botId, ignoreTaskId) => {
    if (activeInRoom(room, botId, ignoreTaskId)) return true
    const sessionId = room.sessions?.[botId]
    if (sessionId !== undefined) {
      if (rt.live.get(sessionId)?.retrying === true) return true
      if (rt.waitsForApproval?.(sessionId) === true) return true
    }
    return [...(rt.switchJobs?.() ?? [])].some(job => job.roomId === room.id && job.botId === botId)
  }

  const waitingForUser = (room, botId) => {
    const sid = room.sessions?.[botId]
    return sid !== undefined && (rt.state.questions?.[sid] !== undefined || rt.state.views?.[sid] !== undefined)
  }

  // A batch whose only remaining pending members are blocked on user answer cards
  // (`ask_user` / interactive `show_view`), or held open solely by the waiting background
  // task that sent this report (`ignoreTaskId`), is not blocking this report.
  const batchMemberBusy = (room, id, ignoreTaskId, ignoreBotId) => {
    if (!room.members.includes(id)) return false
    if (waitingForUser(room, id)) return false
    if (ignoreTaskId !== undefined && id === ignoreBotId && !memberBusyForReport(room, id, ignoreTaskId)) return false
    return true
  }
  const batchActivelyBusy = (room, batch, ignoreTaskId, ignoreBotId) => (batch.pending.length === 0 && !batch.answered)
    || batch.pending.some(id => batchMemberBusy(room, id, ignoreTaskId, ignoreBotId))

  const hasRoomPendingWork = (room, { includeAllInbox = false } = {}) =>
    runningRound(room.id) !== undefined
    || isFinalizing(room.id)
    || (inFlightLate.get(room.id) ?? 0) > 0
    || laterPostsOf(room.id).some(isBotPendingPost)
    || (includeAllInbox
      ? (rt.roomInbox.get(room.id)?.length ?? 0) > 0
      : (rt.roomInbox.get(room.id) ?? []).some(isBotPendingPost))
    || (queuedRelays.get(room.id)?.size ?? 0) > 0

  const isRoomWorking = (room) => hasRoomPendingWork(room, { includeAllInbox: true })
    || room.members.some(id => memberBusyForReport(room, id))
    || Object.values(batches()).some(batch => batch.roomId === room.id && batchActivelyBusy(room, batch))

  const clearRoomOriginIfIdle = (room) => {
    if (room === undefined) return
    if (isRoomWorking(room)) return
    if (Object.values(reports()).some(report => report.roomId === room.id)) return
    if (roomOrigins.delete(room.id)) bumpOriginVersion(room.id)
    rt.clearRoomWebRound?.(room.id)
  }

  // Records a new opening post or user message entering `room`, returning whether an
  // incoming IM origin collided with unrelated active/queued work in the same room.
  const applyIncomingOrigin = (room, incomingOrigin, { excludeReportId, wasWorking } = {}) => {
    const working = wasWorking ?? isRoomWorking(room)
    const origin = normalizeImOrigin(incomingOrigin)
    const otherReports = Object.values(reports()).filter(report => report.roomId === room.id && report.id !== excludeReportId)
    if (!working && otherReports.length === 0) {
      roomOrigins.set(room.id, { origin, mixed: false })
      return { tainted: false, version: bumpOriginVersion(room.id) }
    }
    const existingMixed = origin !== undefined && otherReports
      .some(other => other.imOriginMixed === true || !sameImOrigin(other.imOrigin, origin))
    const priorState = roomOrigins.get(room.id)
    const sameAsPrior = origin !== undefined && (priorState !== undefined
      ? priorState.mixed !== true && sameImOrigin(priorState.origin, origin)
      : sameImOrigin(rt.captureImOrigin?.(rt.sessionOfRoom(room)) ?? roomReportImOrigin(room.id), origin))
    const tainted = origin !== undefined && (existingMixed || !sameAsPrior)
    if (origin !== undefined && !tainted) {
      roomOrigins.set(room.id, { origin, mixed: false })
    } else if (origin === undefined && priorState !== undefined && priorState.mixed !== true && priorState.origin === undefined
      && !otherReports.some(other => other.imOrigin !== undefined)) {
      roomOrigins.set(room.id, { origin: undefined, mixed: false })
    } else {
      roomOrigins.set(room.id, { origin: undefined, mixed: true })
    }
    taintRoomReportOrigins(room.id, origin, { excludeReportId })
    return { tainted, version: bumpOriginVersion(room.id) }
  }

  const noteRoomUserOrigin = (room, incomingOrigin) => {
    if (room === undefined) return
    applyIncomingOrigin(room, incomingOrigin)
  }

  const snapshotOriginState = (roomId) => {
    const priorRoom = roomOrigins.get(roomId)
    const reportOrigins = new Map()
    for (const [id, report] of Object.entries(reports())) {
      if (report.roomId !== roomId) continue
      reportOrigins.set(id, {
        ...(report.imOrigin !== undefined ? { imOrigin: { ...report.imOrigin } } : {}),
        ...(report.imOriginMixed === true ? { imOriginMixed: true } : {}),
      })
    }
    return {
      priorRoom: priorRoom === undefined ? undefined : { origin: priorRoom.origin ? { ...priorRoom.origin } : undefined, mixed: priorRoom.mixed },
      reportOrigins,
    }
  }

  // Only roll back if no concurrent post, user message, or stop mutated this room's
  // origin state while the failed flush was awaiting (fail-closed against erasing taint).
  const restoreOriginState = (roomId, snapshot, expectedVersion) => {
    if (snapshot === undefined) return
    if (expectedVersion !== undefined && (originVersions.get(roomId) ?? 0) !== expectedVersion) return
    if (snapshot.priorRoom === undefined) roomOrigins.delete(roomId)
    else roomOrigins.set(roomId, snapshot.priorRoom)
    let changed = false
    for (const [id, saved] of snapshot.reportOrigins) {
      const report = reports()[id]
      if (report === undefined) continue
      if (saved.imOrigin !== undefined) report.imOrigin = saved.imOrigin
      else delete report.imOrigin
      if (saved.imOriginMixed === true) report.imOriginMixed = true
      else delete report.imOriginMixed
      changed = true
    }
    bumpOriginVersion(roomId)
    if (changed) saveSoon()
  }

  const registerQueuedReport = (room, sender, postExtra, { imOrigin, tainted = false } = {}) => {
    const reportId = postExtra.reportId ?? postExtra.sub ?? randomUUID()
    postExtra.reportId = reportId
    reports()[reportId] = createReport(room, {
      id: reportId,
      botId: sender.id,
      name: sender.name,
      status: 'queued',
      fromSeq: nextRoomSeq(room),
      sub: postExtra.sub,
      fromTaskId: postExtra.fromTaskId,
      fromRoomId: postExtra.fromRoomId,
      fromPart: postExtra.fromPart,
      imOrigin,
      imOriginMixed: tainted,
    })
    saveSoon()
    return reportId
  }

  const trackRoundReport = (room, post, afterSeq) => {
    const id = post.reportId ?? post.sub ?? randomUUID()
    const existing = reports()[id]
    if (existing !== undefined) {
      existing.status = 'tracking'
      existing.fromSeq = afterSeq
    } else {
      reports()[id] = createReport(room, {
        id,
        botId: post.botId,
        name: post.name,
        status: 'tracking',
        fromSeq: afterSeq,
        sub: post.sub,
        fromTaskId: post.fromTaskId,
        fromRoomId: post.fromRoomId,
        fromPart: post.fromPart,
      })
    }
  }

  const trackScopedReport = (room, sender, extra, ids, afterSeq = nextRoomSeq(room), { paused = false } = {}) => {
    const id = extra.reportId ?? extra.sub ?? randomUUID()
    const existing = reports()[id]
    if (existing !== undefined) {
      existing.status = 'tracking'
      existing.fromSeq = afterSeq
      existing.ids = ids
      if (paused) existing.paused = true
    } else {
      reports()[id] = createReport(room, {
        id,
        botId: sender.id,
        name: sender.name,
        status: 'tracking',
        fromSeq: afterSeq,
        ids,
        paused,
        sub: extra.sub,
        fromTaskId: extra.fromTaskId,
        fromRoomId: extra.fromRoomId,
        fromPart: extra.fromPart,
      })
    }
    saveSoon()
  }

  const settleQueuedReportInRound = (room, postExtra, { paused = false } = {}) => {
    if (postExtra.reportBack !== true) return
    const id = postExtra.reportId ?? postExtra.sub
    const existing = id === undefined ? undefined : reports()[id]
    if (existing !== undefined) {
      let changed = false
      if (paused && existing.paused !== true) {
        existing.paused = true
        changed = true
      }
      if (existing.status === 'queued') {
        existing.status = 'tracking'
        existing.fromSeq = nextRoomSeq(room)
        existing.ids = []
        changed = true
      }
      if (changed) saveSoon()
    } else if (paused && postExtra.botId !== undefined) {
      const nextId = id ?? randomUUID()
      reports()[nextId] = createReport(room, {
        id: nextId,
        botId: postExtra.botId,
        name: postExtra.name,
        status: 'tracking',
        fromSeq: nextRoomSeq(room),
        ids: [],
        paused: true,
        sub: postExtra.sub,
        fromTaskId: postExtra.fromTaskId,
        fromRoomId: postExtra.fromRoomId,
        fromPart: postExtra.fromPart,
      })
      saveSoon()
    }
  }

  const expandScopedReports = (roomId, callerId, callees) => {
    if (callerId === undefined || callees.length === 0) return
    let changed = false
    for (const report of Object.values(reports())) {
      if (report.roomId !== roomId || report.status !== 'tracking' || !Array.isArray(report.ids)) continue
      if (!report.ids.includes(callerId)) continue
      for (const peer of callees) {
        if (!report.ids.includes(peer.id)) {
          report.ids.push(peer.id)
          changed = true
        }
      }
    }
    if (changed) saveSoon()
  }

  const matchesReportPost = (post, report) => post !== undefined
    && (post.reportId === report.id || (report.sub !== undefined && post.sub === report.sub))

  const isReportBusy = (room, report, { startup = false } = {}) => {
    if (report.status !== 'tracking') {
      if (!startup) return true
      if (hasQueuedRelayForReport(room.id, report)) return true
      const inRoomQueue = (rt.roomInbox.get(room.id) ?? []).some(post => matchesReportPost(post, report))
        || laterPostsOf(room.id).some(post => matchesReportPost(post, report))
      if (inRoomQueue || runningRound(room.id)?.starting === true) return true
      return false
    }
    if (hasRoomPendingWork(room)) return true
    if (Array.isArray(report.ids)) {
      if (report.ids.some(id => room.members.includes(id) && memberBusyForReport(room, id, report.fromTaskId))) return true
      if (Object.values(batches()).some(batch => batch.roomId === room.id
        && (report.ids.includes(batch.by) || batch.pending.some(id => report.ids.includes(id)))
        && batchActivelyBusy(room, batch, report.fromTaskId, report.botId))) return true
      return false
    }
    if (room.members.some(id => memberBusyForReport(room, id, report.fromTaskId))) return true
    if (Object.values(batches()).some(batch => batch.roomId === room.id && batchActivelyBusy(room, batch, report.fromTaskId, report.botId))) return true
    const activeGoalAdmin = room.admin !== undefined && room.admin !== null && room.members.includes(room.admin) && rt.botOf(room.admin) !== undefined
    if (room.goal?.status === 'active' && room.goal.idle !== true && activeGoalAdmin) {
      if (!startup) return true
      // On startup with no active/recovering round, member, batch, or queued relay left,
      // an active goal is dormant until the user continues; mark it idle instead of deadlocking reports.
      room.goal.idle = true
      room.goal.revision = (room.goal.revision ?? 0) + 1
      room.goal.updatedAt = Date.now()
      saveSoon()
    }
    return false
  }

  // On startup/reload, inspect whether DSH still holds this specific queued report in a
  // queue the new plugin will consume (live inbox, or preStep before user/message is emitted).
  // Does not mutate room-wide state mid-loop so a surviving sibling never hides a missing report.
  const inspectLiveQueuedRelay = async (room, report, roomAgentCache) => {
    let agent = roomAgentCache.get(room.id)
    if (agent === undefined && !roomAgentCache.has(room.id)) {
      const roomSid = rt.sessionOfRoom(room)
      agent = ctx.get?.('agents')?.get(roomSid)
        ?? await rt.resolveAgent?.(roomSid).catch(() => undefined)
      roomAgentCache.set(room.id, agent ?? null)
    }
    if (!agent) return { alive: false }
    const matchesReport = (src) => src?.kind === SOURCE_KIND && src.role === 'post'
      && (src.reportId === report.id || (report.sub !== undefined && src.sub === report.sub))
    const lanes = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
    const queuedMsg = lanes.find(msg => matchesReport(msg?.source))
    if (queuedMsg !== undefined) {
      // Register synchronously while the entry is confirmed in agent.inbox so if the room
      // consumes it during a later await (e.g. resolving another room's agent), roomRelayTaken
      // removes it cleanly instead of a deferred insert stranding the room.
      if (typeof queuedMsg.source.exchangeId === 'string' && queuedMsg.source.exchangeId !== '') {
        noteRoomRelayQueued(room.id, queuedMsg.source.exchangeId, report.id)
        return { alive: true }
      }
      return { alive: true, recheckAgent: agent }
    }
    if (agent.status !== 'running') return { alive: false }
    const snapshot = agent.session?.snapshotEvents?.()
    if (!Array.isArray(snapshot)) return { alive: true, recheckAgent: agent }
    const lastStart = snapshot.findLastIndex(ev => ev?.type === 'turn/start')
    const currentTurn = lastStart === -1 ? snapshot : snapshot.slice(lastStart)
    const ended = currentTurn.some(ev => ev?.type === 'turn/end')
    const hasUserMessage = currentTurn.some(ev => ev?.type === 'user/message')
    // DSH preStep window: inbox.claim() popped nextTurn before user/message was emitted.
    // Keep queued until that turn settles and re-check once; if user/message was already
    // emitted before reload, the old plugin's roomInbox is gone so settle cleanly instead.
    if (!ended && !hasUserMessage) return { alive: true, recheckAgent: agent }
    return { alive: false }
  }

  const scheduleStartupRecheck = (roomId, agent) => {
    if (isDisposed() || pendingStartupRechecks.has(roomId) || typeof agent?.whenIdle !== 'function') return
    pendingStartupRechecks.add(roomId)
    void Promise.resolve(agent.whenIdle())
      .catch(() => {})
      .finally(() => {
        pendingStartupRechecks.delete(roomId)
        if (isDisposed()) return
        void settleRoomReports(roomId, { startup: true }).catch(error => rt.warn('ds-bot: startup recheck in %s failed: %s', roomId, error))
      })
  }

  const markRoomReportsWorked = (roomId, botId) => {
    if (roomId === undefined) return
    let changed = false
    for (const report of Object.values(reports())) {
      if (report.roomId !== roomId || report.status !== 'tracking' || report.worked === true) continue
      if (Array.isArray(report.ids) && botId !== undefined && !report.ids.includes(botId)) continue
      report.worked = true
      changed = true
    }
    if (changed) saveSoon()
  }

  const recordRoundOnReports = (room, round, { aborted = false } = {}) => {
    let changed = false
    for (const report of Object.values(reports())) {
      if (report.roomId !== room.id || report.status !== 'tracking') continue
      const names = Array.isArray(report.ids) ? report.ids.map(id => rt.botOf(id)?.name).filter(Boolean) : undefined
      const passed = names === undefined ? round.passed : round.passed.filter(name => names.includes(name))
      const failed = names === undefined ? round.failed : round.failed.filter(name => names.includes(name))
      for (const name of passed) {
        if (!(report.passed ??= []).includes(name)) {
          report.passed.push(name)
          changed = true
        }
      }
      for (const name of failed) {
        if (!(report.failed ??= []).includes(name)) {
          report.failed.push(name)
          changed = true
        }
      }
      if (report.worked !== true && (round.slots ?? []).some(slot => slot?.worked === true && (!Array.isArray(report.ids) || report.ids.includes(slot.id)))) {
        report.worked = true
        changed = true
      }
      if (aborted && report.stopped !== true) {
        report.stopped = true
        changed = true
      }
    }
    if (changed) saveSoon()
  }

  async function settleRoomReports(roomId, { startup = false } = {}) {
    if (rt.readOnly?.() !== undefined) return
    const ready = []
    let pruned = false
    const roomAgentCache = startup ? new Map() : undefined
    const rechecks = new Map()
    const touchedRoomIds = new Set()
    if (roomId !== undefined) touchedRoomIds.add(roomId)
    for (const [id, report] of Object.entries(reports())) {
      if (roomId !== undefined && report.roomId !== roomId) continue
      if (returning.has(id)) continue
      touchedRoomIds.add(report.roomId)
      if (rt.botOf(report.botId) === undefined) {
        delete reports()[id]
        pruned = true
        continue
      }
      const room = rt.roomOf(report.roomId)
      if (room === undefined) {
        returning.add(id)
        ready.push({ room: { id: report.roomId, name: 'a group chat' }, report, deleted: true })
        continue
      }
      if (isReportBusy(room, report, { startup })) continue
      if (startup && report.status !== 'tracking') {
        const live = await inspectLiveQueuedRelay(room, report, roomAgentCache)
        if (live.alive) {
          if (live.recheckAgent !== undefined) rechecks.set(room.id, live.recheckAgent)
          continue
        }
      }
      // Re-check after awaiting resolveAgent in case a live round claimed or deleted this report.
      const current = reports()[id]
      if (current === undefined || returning.has(id) || isReportBusy(room, current, { startup })) continue
      const neverStarted = current.status !== 'tracking' || current.neverStarted === true
      returning.add(id)
      ready.push({ room, report: current, deleted: false, neverStarted })
    }
    for (const [recheckRoomId, agent] of rechecks) scheduleStartupRecheck(recheckRoomId, agent)
    if (pruned) saveSoon()
    try {
      for (const item of ready) await deliverRoomReport(item.room, item.report, { deleted: item.deleted, neverStarted: item.neverStarted })
    } finally {
      for (const item of ready) returning.delete(item.report.id)
      for (const id of touchedRoomIds) clearRoomOriginIfIdle(rt.roomOf(id))
    }
  }

  async function forgetRoomReports(room) {
    queuedRelays.delete(room.id)
    inFlightLate.delete(room.id)
    roomOrigins.delete(room.id)
    originVersions.delete(room.id)
    rt.clearRoomWebRound?.(room.id)
    const dropped = []
    for (const [id, report] of Object.entries(reports())) {
      if (report.roomId !== room.id || returning.has(id)) continue
      returning.add(id)
      dropped.push(report)
    }
    try {
      for (const report of dropped) await deliverRoomReport(room, report, { deleted: true })
    } finally {
      for (const report of dropped) returning.delete(report.id)
    }
  }

  async function forgetBotRoomReports(botId, touchedRooms = []) {
    let pruned = false
    for (const [id, report] of Object.entries(reports())) {
      if (report.botId !== botId) continue
      delete reports()[id]
      pruned = true
    }
    if (pruned) saveSoon()
    for (const room of touchedRooms) {
      await exitMemberBatches(room, botId)
      await settleRoomReports(room.id)
    }
  }

  function stopRoomReports(roomId) {
    for (const exchangeId of queuedRelays.get(roomId)?.keys() ?? []) rememberStoppedRelay(exchangeId)
    queuedRelays.delete(roomId)
    roomOrigins.delete(roomId)
    bumpOriginVersion(roomId)
    rt.clearRoomWebRound?.(roomId)
    let marked = false
    for (const report of Object.values(reports())) {
      if (report.roomId !== roomId) continue
      if (report.status === 'queued') {
        rememberStoppedRelay(report.id)
        report.neverStarted = true
        report.status = 'tracking'
        marked = true
      }
      if (report.stopped !== true) {
        report.stopped = true
        marked = true
      }
    }
    if (marked) saveSoon()
  }

  function roomRelayDiscarded(source, sessionId) {
    if (typeof source?.roomId !== 'string') return
    if (typeof source.exchangeId === 'string' && withdrawingRelays.has(source.exchangeId)) return
    const room = rt.roomOf(source.roomId)
    // Ignore removals from an earlier part or while the group's own Session is moving parts.
    if (sessionId !== undefined && room !== undefined && sessionId !== rt.sessionOfRoom(room)) return
    if (Object.values(rt.state.switching ?? {}).some(entry => entry?.roomId === source.roomId && entry.botId === undefined)) return
    if ([...(rt.switchJobs?.() ?? [])].some(job => job.roomId === source.roomId && job.botId === undefined)) return
    roomRelayTaken(source.roomId, source.exchangeId)
    const discardedParents = []
    if (typeof source.exchangeId === 'string') {
      const relay = pendingDirectRelays?.get(source.exchangeId)
      if (relay !== undefined) {
        pendingDirectRelays.delete(source.exchangeId)
        if (relay.by !== undefined && relay.parentBatchKey !== undefined) {
          discardedParents.push({ by: relay.by, parentBatchKey: relay.parentBatchKey })
        }
      }
    }
    if (source.batchEnd && source.batch) {
      const batch = batches()[source.batch]
      const parentKey = batch?.parentBatchKey ?? source.parentBatchKey
      const callerId = batch?.by ?? source.askedBy
      closeBatch(source.batch)
      if (callerId !== undefined && parentKey !== undefined) {
        discardedParents.push({ by: callerId, parentBatchKey: parentKey })
      }
    }
    if (room !== undefined && discardedParents.length > 0) {
      releaseIdleParentBatches?.(room, discardedParents)
    }
    if (typeof source.reportId === 'string' && reports()[source.reportId]?.status === 'queued') {
      reports()[source.reportId].neverStarted = true
      reports()[source.reportId].stopped = true
      reports()[source.reportId].status = 'tracking'
      saveSoon()
    }
    void settleRoomReports(source.roomId).catch(error => rt.warn('ds-bot: settling reports after discarded relay failed: %s', error))
  }

  async function deliverRoomReport(room, report, { deleted = false, neverStarted = false } = {}) {
    const bot = rt.botOf(report.botId)
    if (bot === undefined) {
      delete reports()[report.id]
      saveSoon()
      return
    }
    let text
    if (deleted) {
      text = `Group "${room.name}" was deleted before it finished.`
    } else if (neverStarted || report.neverStarted === true) {
      text = report.stopped === true
        ? `Work in "${room.name}" was stopped before your post started.`
        : `Your post in "${room.name}" did not start before DS Bot restarted.`
    } else {
      ensureRoomLog(room)
      const from = report.fromSeq ?? (room.seq + 1)
      // Read the room book directly instead of groupRows: late member replies are logged
      // with `session: true` (so the group chat does not draw them twice), and must still
      // be included in the report to the poster, while user lines and other opening posts stay out.
      const allRows = rt.ledger.range(bookOf(room.id), from, room.seq)
        .filter(record => record.openingPost !== true && !(record.session === true && record.botId === undefined))
        .map(rowOf)
        .filter(Boolean)
      const rows = Array.isArray(report.ids) ? allRows.filter(row => report.ids.includes(row.botId)) : allRows
      const presentedLine = file => `[Presented file ${file.path}${file.description ? `: ${file.description}` : ''}]`
      const lines = rows.filter(row => row.kind === undefined)
        .map(row => `${row.name}: ${[row.text, ...(row.presented ?? []).map(presentedLine)].filter(Boolean).join('\n')}`)
      const repliedNames = new Set(rows.filter(row => row.kind === undefined).map(row => row.name))
      const stoppedNames = [...new Set(rows.filter(row => row.kind === 'stopped').map(row => row.name).filter(Boolean))]
      const passed = [...new Set(report.passed ?? [])].filter(name => !repliedNames.has(name) && !stoppedNames.includes(name))
      const failedRows = rows.filter(row => row.kind === 'failed')
      const failedNames = [...new Set([...(report.failed ?? []), ...failedRows.map(row => row.name).filter(Boolean)])]
      const waitingCards = (Array.isArray(report.ids) ? report.ids : room.members)
        .filter(id => waitingForUser(room, id))
        .map(id => rt.botOf(id)?.name)
        .filter(Boolean)
      // If the user cleared a completed/stopped goal before the round settled, recover it from pastGoals.
      const goal = !Array.isArray(report.ids)
        ? (room.goal ?? (room.pastGoals ?? []).findLast(past => (past?.endedAt ?? 0) >= report.at))
        : undefined
      const goalLine = goal === undefined ? ''
        : goal.status === 'complete' && (goal.endedAt ?? 0) >= report.at
          ? `Goal "${goal.title}" completed.\nSummary: ${goal.summary}\nEvidence: ${goal.evidence}`
          : goal.status === 'stopped' && (goal.endedAt ?? 0) >= report.at
            ? `Goal "${goal.title}" was stopped${goal.reason ? `: ${goal.reason}` : ''}.`
            : goal.status === 'paused'
              ? `Goal "${goal.title}" is paused; waiting for the user in "${room.name}".`
              : goal.status === 'drafting' || (goal.status === 'active' && goal.idle === true)
                ? `Goal "${goal.title}" is waiting for input from the user in "${room.name}".`
                : ''
      const pausedLine = report.paused === true || (!Array.isArray(report.ids) && room.idlePaused !== undefined)
        ? `Paused in "${room.name}": members went back and forth without making progress; waiting for the user there.`
        : ''
      const goalStopped = goal?.status === 'stopped' && (goal.endedAt ?? 0) >= report.at
      const stoppedLine = report.stopped === true && !goalStopped
        ? `Work in "${room.name}" was stopped before finishing.`
        : report.stopped !== true && stoppedNames.length > 0
          ? `Stopped before finishing: ${stoppedNames.join(', ')}.`
          : ''
      const failedLine = failedNames.length > 0
        ? `Could not answer because their model call failed: ${failedNames.map((name) => {
            const row = failedRows.findLast(item => item.name === name)
            return row ? `${name} (${failureLine({ code: row.code, status: row.status, message: row.text })})` : name
          }).join(', ')}.`
        : ''
      text = [
        goalLine,
        lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : (goalLine === '' && waitingCards.length === 0 && stoppedLine === '' && pausedLine === '' ? 'Nobody replied to your post.' : ''),
        waitingCards.length > 0 ? `Waiting for the user's answer in "${room.name}": ${waitingCards.join(', ')}.` : '',
        pausedLine,
        stoppedLine,
        passed.length > 0 ? `Stayed silent: ${passed.join(', ')}.` : '',
        failedLine,
      ].filter(Boolean).join('\n\n') || 'Nobody replied to your post.'
    }
    // Replies the poster waited for go on with the work it posted for.
    const work = report.sub === undefined ? undefined : rt.closeWork(report.sub, `Group "${room.name}"`, text, report.worked === true ? { worked: true } : undefined)
    // The wait may already have been given up: the replies still reach the poster,
    // marked as the late answer they are, and open no work.
    const late = work === undefined && report.sub !== undefined ? rt.abandonedWork?.(report.sub) : undefined
    const rawBody = late === undefined ? text : LATE_ANSWER + text
    const long = rawBody.length > MESSAGE_INLINE_MAX ? await rt.attachLong?.(rawBody, `Group report from ${room.name}.txt`) : undefined
    const body = long?.text ?? rawBody
    const reportKey = report.sub ?? report.id
    // The report goes back to the conversation the post was written from: its
    // Session in that group when the post came from one, or the current part of
    // that own-chat thread, else the own chat.
    const rawAddress = report.fromTaskId ? { taskId: report.fromTaskId } : returnAddress(bot, report.fromPart, report.fromRoomId)
    const resolvedTarget = addressedSession(rt, bot.id, rawAddress)
    const address = resolvedTarget !== undefined ? rawAddress : { foreground: true }
    const target = resolvedTarget ?? rt.chatOf(bot.id)
    // Never carry a group IM origin onto the Bot's own chat if the Bot left or the origin group was deleted.
    const replyOrigin = report.imOriginMixed === true ? { mixed: true } : report.imOrigin
    const eligibleReplyOrigin = replyOrigin !== undefined && !(report.fromRoomId !== undefined && resolvedTarget === undefined)
      ? replyOrigin
      : undefined
    if (eligibleReplyOrigin !== undefined) {
      rt.rememberImReplyOrigin?.(reportKey, eligibleReplyOrigin)
    }
    const exchangeId = `group-report:${reportKey}`
    const deliverPayload = {
      toId: report.botId,
      address,
      exchangeId,
      ...(target ? { sessionId: target } : {}),
      role: 'report',
      roomId: room.id,
      text: body,
      ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
      replyTo: reportKey,
      ...(work ? { work } : {}),
    }
    const obligationId = `room-report:${reportKey}`
    // Persist the delivery obligation and watcher-removal marker atomically in SQLite
    // before dropping the pending report from state.roomReports so a crash between SQLite
    // commit and `state.json` save never drops OR duplicates the report, and preserves
    // delegated child-work closure and eligible IM reply origin on recovery.
    rt.coordination?.commitObligation?.({
      id: obligationId,
      kind: 'room_report',
      ownerId: report.id,
      botId: report.botId,
      address,
      payload: deliverPayload,
      deliveryId: exchangeId,
      terminalMarker: {
        kind: 'room_report',
        ownerId: report.id,
        snapshot: {
          roomId: room.id,
          roomName: room.name,
          botId: report.botId,
          reportKey,
          ...(report.sub !== undefined ? { sub: report.sub, workResult: text, worked: report.worked === true } : {}),
          ...(eligibleReplyOrigin !== undefined ? { imReplyOrigin: eligibleReplyOrigin } : {}),
        },
      },
    })
    delete reports()[report.id]
    void rt.save().then(() => {
      try {
        rt.coordination?.clearTerminalMarker?.('room_report', report.id)
      } catch (error) {
        rt.warn?.('ds-bot: clearing room_report terminal marker %s failed: %s', report.id, error)
      }
    }, () => {})
    await rt.deliver(deliverPayload).then(() => {
      rt.coordination?.markObligation?.(obligationId, 'settled')
    }, (error) => {
      if (error?.code === 'bot/unresolved-return') {
        rt.coordination?.markObligation?.(obligationId, 'cancelled')
      }
      rt.warn('ds-bot: group report to %s failed: %s', report.name, error)
    })
  }

  Object.assign(rt, {
    noteRoomRelayQueued,
    roomRelayTaken,
    roomRelayDiscarded,
    dropRoomReport,
    hasRoomReportFor,
    roomReportImOrigin,
    markRoomReportsWorked,
    settleRoomReports,
    forgetRoomReports,
    forgetBotRoomReports,
  })

  return {
    reports,
    rememberStoppedRelay,
    isStoppedRelay,
    isBotPendingPost,
    noteRoomRelayQueued,
    roomRelayTaken,
    roomRelayDiscarded,
    withWithdrawingRelay,
    enterLate,
    leaveLate,
    dropRoomReport,
    hasRoomReportFor,
    roomReportImOrigin,
    taintRoomReportOrigins,
    noteRoomUserOrigin,
    applyIncomingOrigin,
    snapshotOriginState,
    restoreOriginState,
    registerQueuedReport,
    trackRoundReport,
    trackScopedReport,
    settleQueuedReportInRound,
    expandScopedReports,
    recordRoundOnReports,
    isRoomWorking,
    settleRoomReports,
    forgetRoomReports,
    forgetBotRoomReports,
    stopRoomReports,
    deliverRoomReport,
  }
}
