// Group report-back watchers backed by `coordination.sqlite` (`rt.coordDb`):
// A `post_to_group(report_back: true)` call opens a tracked `room_work` plus a standard
// `call + wait(kind='call')` on the caller's work. When the group work it triggered truly
// finishes (long turns past 15s, approvals, group background tasks, subagents, nested
// group calls, and any active group_goal), the tracker work settles atomically in SQLite,
// appending `inbox(kind='result')` onto the caller's work, resolving its wait, and waking
// it once via `rt.kickScheduler()` — eliminating crash-before-delivery loss and double reports.
import { randomUUID } from 'node:crypto'
import { LATE_ANSWER, MESSAGE_INLINE_MAX } from './constants.js'
import { normalizeImOrigin, sameImOrigin } from './im/origin.js'
import { threadCurrentOfPart } from './threads.js'
import { failureLine } from './turns.js'

const STOPPED_RELAYS_KEPT = 200
const REPORT_WORK_PREFIX = 'room-report:'
const REPORT_CALL_PREFIX = 'call:report:'

const reportWorkId = id => (String(id).startsWith(REPORT_WORK_PREFIX) ? String(id) : `${REPORT_WORK_PREFIX}${id}`)
const reportCallId = id => `${REPORT_CALL_PREFIX}${id}`
const isPrivateBot = bot => bot?.private === true || bot?.privacy === true

export function createRoomReports(rt, deps) {
  const {
    hasActiveRoomCalls,
    exitMemberRoomCalls,
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

  const db = () => rt.coordDb ?? null
  const writableDb = () => {
    const handle = db()
    if (handle === null || handle.isClosed?.() || handle.readonly || rt.readOnly?.() !== undefined) return null
    return handle
  }

  // In-memory live tracking for relays currently queued in this process (not persisted;
  // SQLite holds the durable tracker `room_work` across restarts).
  const queuedRelays = new Map()
  const inFlightLate = new Map()
  const roomOrigins = new Map()
  const originVersions = new Map()
  let nextOriginVersion = 0
  const bumpOriginVersion = (roomId) => {
    const next = ++nextOriginVersion
    originVersions.set(roomId, next)
    return next
  }
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

  // Projects a SQLite `room_work` tracker row into a normalized report record.
  const isReportWork = work => work !== undefined && work !== null
    && (work.meta?.kind === 'room_report'
      || work.meta?.migratedFrom === 'state.roomReports'
      || (typeof work.workId === 'string' && work.workId.startsWith(REPORT_WORK_PREFIX)))

  const projectReport = (work) => {
    if (!isReportWork(work)) return undefined
    const meta = work.meta ?? {}
    const statePatch = work.apiMeta ?? {}
    const merged = { ...meta, ...statePatch }
    const reportId = merged.reportId ?? (work.workId.startsWith(REPORT_WORK_PREFIX) ? work.workId.slice(REPORT_WORK_PREFIX.length) : work.workId)
    const imOriginMixed = merged.imOriginMixed === true
    const rawOrigin = statePatch.imOrigin !== undefined ? statePatch.imOrigin : (meta.imOrigin !== undefined ? meta.imOrigin : work.imOrigin)
    const imOrigin = imOriginMixed || rawOrigin === null ? undefined : normalizeImOrigin(rawOrigin)
    return {
      id: reportId,
      workId: work.workId,
      parentWorkId: work.parentWorkId ?? merged.parentWorkId,
      roomId: work.roomId ?? merged.roomId,
      botId: work.botId ?? merged.botId,
      name: merged.name ?? rt.botOf(work.botId)?.name ?? 'Bot',
      status: merged.status ?? 'tracking',
      fromSeq: merged.fromSeq,
      ...(Array.isArray(merged.ids) ? { ids: merged.ids } : {}),
      ...(merged.paused === true || work.status === 'paused' ? { paused: true } : {}),
      passed: Array.isArray(merged.passed) ? merged.passed : [],
      failed: Array.isArray(merged.failed) ? merged.failed : [],
      worked: merged.worked === true,
      stopped: merged.stopped === true,
      neverStarted: merged.neverStarted === true,
      at: merged.at ?? work.createdAt ?? Date.now(),
      ...(merged.sub ? { sub: merged.sub } : {}),
      ...(merged.fromTaskId ? { fromTaskId: merged.fromTaskId } : {}),
      ...(merged.fromRoomId ? { fromRoomId: merged.fromRoomId } : {}),
      ...(merged.fromPart ? { fromPart: merged.fromPart } : {}),
      ...(merged.returnAddress ? { returnAddress: merged.returnAddress } : {}),
      ...(imOrigin !== undefined ? { imOrigin } : {}),
      ...(imOriginMixed ? { imOriginMixed: true } : {}),
    }
  }

  const listActiveReports = (roomId) => {
    const handle = db()
    if (handle === null || handle.isClosed?.()) return []
    const works = handle.listWorks({ kind: 'room_work', ...(roomId !== undefined ? { roomId } : {}), activeOnly: true, limit: 500 })
    const out = []
    for (const work of works) {
      const projected = projectReport(work)
      if (projected !== undefined) out.push(projected)
    }
    return out
  }

  const getReportById = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    const handle = db()
    if (handle === null || handle.isClosed?.()) return undefined
    const work = handle.getWork(reportWorkId(id))
    if (!work || ['done', 'failed', 'stopped'].includes(work.status)) return undefined
    return projectReport(work)
  }

  const patchReport = (id, patch) => {
    const handle = writableDb()
    if (handle === null || typeof id !== 'string' || id === '') return undefined
    const wId = reportWorkId(id)
    const work = handle.getWork(wId)
    if (!work || ['done', 'failed', 'stopped'].includes(work.status)) return undefined
    const updated = handle.updateApiMeta(wId, current => (typeof patch === 'function' ? patch(current) : { ...current, ...patch }))
    return projectReport(updated)
  }

  const resolveCallerParentWork = (handle, senderId, { parentWorkId, fromTaskId, fromRoomId } = {}) => {
    if (typeof parentWorkId === 'string' && parentWorkId !== '') {
      const explicit = handle.getWork(parentWorkId)
      if (explicit && !['done', 'failed', 'stopped'].includes(explicit.status)) return explicit
    }
    if (typeof fromTaskId === 'string' && fromTaskId !== '') {
      const taskWork = handle.getWork(`task:${fromTaskId}`) ?? handle.getWorkByLogicalAddress(`task:${fromTaskId}`)
      if (taskWork && !['done', 'failed', 'stopped'].includes(taskWork.status)) return taskWork
    }
    if (typeof fromRoomId === 'string' && fromRoomId !== '') {
      const roomWorks = handle.listWorks({ botId: senderId, kind: 'room_work', roomId: fromRoomId, activeOnly: true, limit: 20 })
      const callerRoomWork = roomWorks.find(w => !isReportWork(w))
      if (callerRoomWork) return callerRoomWork
    }
    const bot = rt.botOf(senderId)
    return handle.ensureForegroundWork({
      botId: senderId,
      sessionId: rt.chatOf?.(senderId),
      workspaceDir: bot?.workDir,
      privacyScoped: isPrivateBot(bot),
    }).work
  }

  // Opens a durable report tracker `room_work` + `call` + `wait(kind='call')` in SQLite.
  const openRoomReportCall = (room, {
    id,
    botId,
    name,
    status = 'tracking',
    fromSeq = nextRoomSeq(room),
    ids,
    paused = false,
    sub,
    parentWorkId,
    returnAddress,
    fromTaskId,
    fromRoomId,
    fromPart,
    imOrigin,
    imOriginMixed = false,
  }) => {
    const handle = writableDb()
    if (handle === null) return undefined
    const reportId = id ?? sub ?? randomUUID()
    const wId = reportWorkId(reportId)
    const cleanOrigin = normalizeImOrigin(imOrigin)
    const effectiveOrigin = cleanOrigin && !imOriginMixed ? cleanOrigin : undefined
    const bot = rt.botOf(botId)

    return handle.transaction(() => {
      const existing = handle.getWork(wId)
      if (existing && !['done', 'failed', 'stopped'].includes(existing.status)) {
        const updated = handle.updateApiMeta(wId, current => ({
          ...current,
          status,
          fromSeq,
          ...(Array.isArray(ids) ? { ids } : {}),
          ...(paused ? { paused: true } : {}),
        }))
        return projectReport(updated)
      }
      const parentWork = resolveCallerParentWork(handle, botId, { parentWorkId, fromTaskId, fromRoomId })
      const lockedReturn = returnAddress ?? parentWork.logicalAddress
      const at = Date.now()
      const meta = {
        kind: 'room_report',
        reportId,
        roomId: room.id,
        botId,
        name: name ?? bot?.name ?? 'Bot',
        status,
        fromSeq,
        ...(Array.isArray(ids) ? { ids } : {}),
        ...(paused ? { paused: true } : {}),
        passed: [],
        failed: [],
        worked: false,
        stopped: false,
        neverStarted: false,
        at,
        ...(sub ? { sub } : {}),
        ...(fromTaskId ? { fromTaskId } : {}),
        ...(fromRoomId ? { fromRoomId } : {}),
        ...(fromPart ? { fromPart } : {}),
        parentWorkId: parentWork.workId,
        returnAddress: lockedReturn,
        ...(effectiveOrigin ? { imOrigin: effectiveOrigin } : {}),
        ...(imOriginMixed ? { imOriginMixed: true } : {}),
      }
      const created = handle.createWork({
        workId: wId,
        botId,
        kind: 'room_work',
        logicalAddress: `room-report:${room.id}:${reportId}`,
        status: paused ? 'paused' : 'waiting',
        priority: 'background',
        parentWorkId: parentWork.workId,
        roomId: room.id,
        title: `Group report from "${room.name}"`,
        originKind: 'group_report',
        imOrigin: effectiveOrigin,
        visibility: isPrivateBot(bot) ? 'private' : 'direct',
        privacyScoped: isPrivateBot(bot),
        meta,
      })
      if (created.created) {
        try {
          handle.createCall({
            callId: reportCallId(reportId),
            parentWorkId: parentWork.workId,
            childWorkId: wId,
            callerBotId: botId,
            calleeBotId: botId,
            returnAddress: lockedReturn,
            visibleScope: isPrivateBot(bot) ? 'private' : 'direct',
            roomId: room.id,
            required: true,
            meta: { kind: 'room_report', reportId, roomId: room.id, role: 'report' },
          })
        } catch (error) {
          // If a cycle or terminal parent prevents adding the call edge, still keep the
          // tracker work cleanly readable and log a diagnostic.
          rt.warn?.('ds-bot: attaching report call %s in %s failed: %s', reportId, room.name, error?.message ?? error)
        }
      }
      return projectReport(created.work)
    })
  }

  const dropRoomReport = (id) => {
    const handle = writableDb()
    if (handle === null || typeof id !== 'string' || id === '') return
    const wId = reportWorkId(id)
    const work = handle.getWork(wId)
    if (!work || ['done', 'failed', 'stopped'].includes(work.status)) return
    handle.stopWork(wId, { reason: 'Report cancelled before delivery' })
  }

  // Only already-tracking non-scoped reports carry whole-room outcomes (such as group_goal
  // completion); a queued post or a mid-round scoped post targeting a subset of members must
  // not suppress standalone goal notifications to the primary Main Bot.
  const hasRoomReportFor = (roomId, botId) => listActiveReports(roomId)
    .some(report => report.botId === botId && report.status === 'tracking' && !Array.isArray(report.ids))

  const roomReportImOrigin = (roomId, targetBotId) => {
    const active = listActiveReports(roomId).filter(report => rt.botOf(report.botId) !== undefined)
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
    const handle = writableDb()
    if (handle === null) return
    for (const report of listActiveReports(roomId)) {
      if (report.id === excludeReportId) continue
      if (report.imOrigin === undefined) continue
      if (!sameImOrigin(report.imOrigin, incomingOrigin)) {
        patchReport(report.id, { imOrigin: null, imOriginMixed: true })
      }
    }
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
    if (sid !== undefined && (rt.state.questions?.[sid] !== undefined || rt.state.views?.[sid] !== undefined)) return true
    const handle = db()
    if (handle === null || handle.isClosed?.()) return false
    const works = handle.listWorks({ botId, kind: 'room_work', roomId: room.id, activeOnly: true, limit: 20 })
    for (const work of works) {
      if (isReportWork(work)) continue
      const waits = handle.listWaits({ workId: work.workId, kind: 'user_question', status: 'open', limit: 5 })
      if (waits.length > 0) return true
    }
    return false
  }

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
    || hasActiveRoomCalls(room.id)

  const clearRoomOriginIfIdle = (room) => {
    if (room === undefined) return
    if (isRoomWorking(room)) return
    if (listActiveReports(room.id).length > 0) return
    if (roomOrigins.delete(room.id)) bumpOriginVersion(room.id)
    rt.clearRoomWebRound?.(room.id)
  }

  // Records a new opening post or user message entering `room`, returning whether an
  // incoming IM origin collided with unrelated active/queued work in the same room.
  const applyIncomingOrigin = (room, incomingOrigin, { excludeReportId, wasWorking } = {}) => {
    const working = wasWorking ?? isRoomWorking(room)
    const origin = normalizeImOrigin(incomingOrigin)
    const otherReports = listActiveReports(room.id).filter(report => report.id !== excludeReportId)
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
    for (const report of listActiveReports(roomId)) {
      reportOrigins.set(report.id, {
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
    for (const [id, saved] of snapshot.reportOrigins) {
      patchReport(id, {
        imOrigin: saved.imOrigin !== undefined ? saved.imOrigin : null,
        imOriginMixed: saved.imOriginMixed === true,
      })
    }
    bumpOriginVersion(roomId)
  }

  const registerQueuedReport = (room, sender, postExtra, { imOrigin, tainted = false } = {}) => {
    const reportId = postExtra.reportId ?? postExtra.sub ?? randomUUID()
    postExtra.reportId = reportId
    openRoomReportCall(room, {
      id: reportId,
      botId: sender.id,
      name: sender.name,
      status: 'queued',
      fromSeq: nextRoomSeq(room),
      sub: postExtra.sub,
      parentWorkId: postExtra.parentWorkId,
      returnAddress: postExtra.returnAddress,
      fromTaskId: postExtra.fromTaskId,
      fromRoomId: postExtra.fromRoomId,
      fromPart: postExtra.fromPart,
      imOrigin,
      imOriginMixed: tainted,
    })
    return reportId
  }

  const trackRoundReport = (room, post, afterSeq) => {
    const id = post.reportId ?? post.sub ?? randomUUID()
    const existing = getReportById(id)
    if (existing !== undefined) {
      patchReport(id, { status: 'tracking', fromSeq: afterSeq })
    } else {
      openRoomReportCall(room, {
        id,
        botId: post.botId,
        name: post.name,
        status: 'tracking',
        fromSeq: afterSeq,
        sub: post.sub,
        parentWorkId: post.parentWorkId,
        returnAddress: post.returnAddress,
        fromTaskId: post.fromTaskId,
        fromRoomId: post.fromRoomId,
        fromPart: post.fromPart,
      })
    }
  }

  const trackScopedReport = (room, sender, extra, ids, afterSeq = nextRoomSeq(room), { paused = false } = {}) => {
    const id = extra.reportId ?? extra.sub ?? randomUUID()
    const existing = getReportById(id)
    if (existing !== undefined) {
      patchReport(id, {
        status: 'tracking',
        fromSeq: afterSeq,
        ids,
        ...(paused ? { paused: true } : {}),
      })
    } else {
      openRoomReportCall(room, {
        id,
        botId: sender.id,
        name: sender.name,
        status: 'tracking',
        fromSeq: afterSeq,
        ids,
        paused,
        sub: extra.sub,
        parentWorkId: extra.parentWorkId,
        returnAddress: extra.returnAddress,
        fromTaskId: extra.fromTaskId,
        fromRoomId: extra.fromRoomId,
        fromPart: extra.fromPart,
      })
    }
  }

  const settleQueuedReportInRound = (room, postExtra, { paused = false } = {}) => {
    if (postExtra.reportBack !== true) return
    const id = postExtra.reportId ?? postExtra.sub
    const existing = id === undefined ? undefined : getReportById(id)
    if (existing !== undefined) {
      const patch = {}
      if (paused && existing.paused !== true) patch.paused = true
      if (existing.status === 'queued') {
        patch.status = 'tracking'
        patch.fromSeq = nextRoomSeq(room)
        patch.ids = []
      }
      if (Object.keys(patch).length > 0) patchReport(id, patch)
    } else if (paused && postExtra.botId !== undefined) {
      openRoomReportCall(room, {
        id: id ?? randomUUID(),
        botId: postExtra.botId,
        name: postExtra.name,
        status: 'tracking',
        fromSeq: nextRoomSeq(room),
        ids: [],
        paused: true,
        sub: postExtra.sub,
        parentWorkId: postExtra.parentWorkId,
        returnAddress: postExtra.returnAddress,
        fromTaskId: postExtra.fromTaskId,
        fromRoomId: postExtra.fromRoomId,
        fromPart: postExtra.fromPart,
      })
    }
  }

  const expandScopedReports = (roomId, callerId, callees) => {
    if (callerId === undefined || callees.length === 0) return
    for (const report of listActiveReports(roomId)) {
      if (report.status !== 'tracking' || !Array.isArray(report.ids)) continue
      if (!report.ids.includes(callerId)) continue
      const nextIds = [...report.ids]
      let changed = false
      for (const peer of callees) {
        if (!nextIds.includes(peer.id)) {
          nextIds.push(peer.id)
          changed = true
        }
      }
      if (changed) patchReport(report.id, { ids: nextIds })
    }
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
      if (hasActiveRoomCalls(room.id, { memberIds: report.ids, ignoreTaskId: report.fromTaskId, ignoreBotId: report.botId, waitingForUser })) return true
      return false
    }
    if (room.members.some(id => memberBusyForReport(room, id, report.fromTaskId))) return true
    if (hasActiveRoomCalls(room.id, { ignoreTaskId: report.fromTaskId, ignoreBotId: report.botId, waitingForUser })) return true
    const activeGoalAdmin = room.admin !== undefined && room.admin !== null && room.members.includes(room.admin) && rt.botOf(room.admin) !== undefined
    if (room.goal?.status === 'active' && room.goal.idle !== true && activeGoalAdmin) {
      if (!startup) return true
      // On startup with no active/recovering round, member, call, or queued relay left,
      // an active goal is dormant until the user continues; mark it idle instead of deadlocking reports.
      room.goal.idle = true
      room.goal.revision = (room.goal.revision ?? 0) + 1
      room.goal.updatedAt = Date.now()
      saveSoon()
    }
    return false
  }

  const markRoomReportsWorked = (roomId, botId) => {
    if (roomId === undefined) return
    for (const report of listActiveReports(roomId)) {
      if (report.status !== 'tracking' || report.worked === true) continue
      if (Array.isArray(report.ids) && botId !== undefined && !report.ids.includes(botId)) continue
      patchReport(report.id, { worked: true })
    }
  }

  const recordRoundOnReports = (room, round, { aborted = false } = {}) => {
    for (const report of listActiveReports(room.id)) {
      if (report.status !== 'tracking') continue
      const names = Array.isArray(report.ids) ? report.ids.map(id => rt.botOf(id)?.name).filter(Boolean) : undefined
      const passedAdd = names === undefined ? round.passed : round.passed.filter(name => names.includes(name))
      const failedAdd = names === undefined ? round.failed : round.failed.filter(name => names.includes(name))
      const passed = [...new Set([...(report.passed ?? []), ...passedAdd])]
      const failed = [...new Set([...(report.failed ?? []), ...failedAdd])]
      const worked = report.worked === true || (round.slots ?? []).some(slot => slot?.worked === true && (!Array.isArray(report.ids) || report.ids.includes(slot.id)))
      const stopped = report.stopped === true || aborted
      if (passed.length !== (report.passed?.length ?? 0)
        || failed.length !== (report.failed?.length ?? 0)
        || worked !== report.worked
        || stopped !== report.stopped) {
        patchReport(report.id, { passed, failed, worked, stopped })
      }
    }
  }

  const hasPausedRoomWork = (roomId) => {
    const handle = db()
    if (handle === null || handle.isClosed?.()) return false
    return handle.listWorks({ kind: 'room_work', roomId, status: 'paused', limit: 20 })
      .some(work => !isReportWork(work))
  }

  async function deliverRoomReport(room, report, { deleted = false, neverStarted = false } = {}) {
    const handle = writableDb()
    const bot = rt.botOf(report.botId)
    if (bot === undefined) {
      if (handle !== null) handle.stopWork(report.workId, { reason: 'Report caller deleted' })
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
      const pausedLine = report.paused === true || (!Array.isArray(report.ids) && hasPausedRoomWork(room.id))
        ? `Paused in "${room.name}": members made no measurable progress on the same step; waiting for the user there.`
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

    // Legacy sub-work compatibility if caller tracked `report.sub` through handoffs.js.
    const work = report.sub === undefined ? undefined : rt.closeWork?.(report.sub, `Group "${room.name}"`, text, report.worked === true ? { worked: true } : undefined)
    const late = work === undefined && report.sub !== undefined ? rt.abandonedWork?.(report.sub) : undefined
    const rawBody = late === undefined ? text : LATE_ANSWER + text
    const long = rawBody.length > MESSAGE_INLINE_MAX ? await rt.attachLong?.(rawBody, `Group report from ${room.name}.txt`) : undefined
    const body = long?.text ?? rawBody
    const reportKey = report.sub ?? report.id

    const back = rt.roomOf(report.fromRoomId)?.sessions?.[report.botId]
    const part = back === undefined && report.fromPart !== undefined ? threadCurrentOfPart(bot, report.fromPart) : undefined
    const target = back ?? part
    // Never carry a group IM origin onto the Bot's own chat if the Bot left or the origin group was deleted.
    const replyOrigin = report.imOriginMixed === true ? { mixed: true } : report.imOrigin
    const safeOrigin = replyOrigin !== undefined && !(report.fromRoomId !== undefined && back === undefined) ? replyOrigin : undefined
    if (safeOrigin !== undefined) {
      rt.rememberImReplyOrigin?.(reportKey, safeOrigin)
    }

    // Atomic single-settlement in SQLite: writes `inbox(kind='result')` onto the caller's work,
    // resolves `wait(kind='call')`, and enqueues `ready` in ONE transaction. `dsh-adapter.js`
    // then delivers the result via `rt.kickScheduler()` (never calling `rt.deliver` twice).
    if (handle !== null && typeof rt.kickScheduler === 'function') {
      const outcome = deleted || report.stopped === true ? 'stopped' : 'done'
      const renderedText = `[Group chat "${room.name}" · replies to your post]\n${body}`
      const resultMeta = {
        role: 'report',
        roomId: room.id,
        replyTo: reportKey,
        renderedText,
        ...(target ? { sessionId: target } : {}),
        ...(long?.files ? { files: long.files } : {}),
        ...(long?.length !== undefined ? { length: long.length } : {}),
        ...(safeOrigin !== undefined ? { imOrigin: safeOrigin } : {}),
        ...(work ? { work } : {}),
        source: {
          replyTo: reportKey,
          ...(work ? { work } : {}),
        },
      }
      const settled = handle.settleWork({
        workId: report.workId,
        outcome,
        force: true,
        summary: body,
        resultRef: long?.files?.[0]?.attachmentId,
        resultMeta,
      })
      if (settled.alreadyTerminal) return
      const kickIds = new Set(settled.wokenParents ?? [])
      for (const call of settled.settledCalls ?? []) {
        if (call?.parentWorkId && handle.getWork(call.parentWorkId)?.status === 'queued') {
          kickIds.add(call.parentWorkId)
        }
      }
      // Migrated legacy `state.roomReports` rows (from `importLegacyState`) have a parentWorkId
      // without a `calls` row: deliver the result directly into parent inbox so migration never drops reports.
      if ((settled.settledCalls?.length ?? 0) === 0) {
        const fallbackParent = resolveCallerParentWork(handle, report.botId, {
          parentWorkId: report.parentWorkId,
          fromTaskId: report.fromTaskId,
          fromRoomId: report.fromRoomId,
        })
        if (fallbackParent) {
          const recv = handle.receiveMessage({
            workId: fallbackParent.workId,
            kind: 'result',
            dedupKey: `call:${reportCallId(report.id)}:result`,
            senderAddress: `room-report:${room.id}:${report.id}`,
            senderBotId: report.botId,
            bodyRef: long?.files?.[0]?.attachmentId,
            bodyPreview: body,
            payload: resultMeta,
            wake: true,
          })
          if (recv.readyEnqueued || recv.work?.status === 'queued') {
            kickIds.add(fallbackParent.workId)
          }
        }
      }
      for (const parentId of kickIds) {
        await rt.kickScheduler({ workId: parentId }).catch(error => rt.warn('ds-bot: kicking scheduler for group report to %s failed: %s', report.name, error))
      }
      return
    }

    // Fallback path only when `dsh-adapter.js` scheduler is unavailable (e.g. isolated legacy unit test).
    if (handle !== null) {
      const settled = handle.settleWork({
        workId: report.workId,
        outcome: deleted || report.stopped === true ? 'stopped' : 'done',
        force: true,
        summary: body,
        resultRef: long?.files?.[0]?.attachmentId,
      })
      if (settled.alreadyTerminal) return
    }
    await rt.deliver({
      toId: report.botId,
      ...(target ? { sessionId: target } : {}),
      role: 'report',
      roomId: room.id,
      text: body,
      ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
      replyTo: reportKey,
      ...(work ? { work } : {}),
    }).catch(error => rt.warn('ds-bot: group report to %s failed: %s', report.name, error))
  }

  const preStepRecheckRooms = new Set()

  const isInPreStepWindow = (agent) => {
    if (!agent || agent.status !== 'running') return false
    const events = agent.session?.snapshotEvents?.()
    if (!Array.isArray(events) || events.length === 0) return true
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev?.type === 'user/message' || ev?.type === 'turn/end') return false
      if (ev?.type === 'turn/start') return true
    }
    return false
  }

  const schedulePreStepRecheck = (roomId, agent) => {
    if (preStepRecheckRooms.has(roomId) || typeof agent?.whenIdle !== 'function') return
    preStepRecheckRooms.add(roomId)
    void Promise.resolve(agent.whenIdle()).then(() => {
      preStepRecheckRooms.delete(roomId)
      if (isDisposed()) return
      return settleRoomReports(roomId, { startup: true })
    }).catch(() => {
      preStepRecheckRooms.delete(roomId)
    })
  }

  const roomAgentQueuedReports = async (room) => {
    const roomSid = rt.sessionOfRoom?.(room)
    if (!roomSid) return { agent: undefined, inPreStep: false, queuedSources: [] }
    let agent = rt.ctx?.get?.('agents')?.get?.(roomSid)
    if (agent === undefined && typeof rt.resolveAgent === 'function') {
      agent = await rt.resolveAgent(roomSid).catch(() => undefined)
    }
    if (!agent) return { agent: undefined, inPreStep: false, queuedSources: [] }
    const inPreStep = isInPreStepWindow(agent)
    const queuedSources = [
      ...(agent.inbox?.nextStep ?? []),
      ...(agent.inbox?.nextTurn ?? []),
    ].map(m => m?.source).filter(Boolean)
    return { agent, inPreStep, queuedSources }
  }

  async function settleRoomReports(roomId, { startup = false } = {}) {
    if (writableDb() === null || isDisposed()) return
    const touchedRoomIds = new Set()
    if (roomId !== undefined) touchedRoomIds.add(roomId)
    const roomStates = new Map()
    if (startup) {
      const queuedRooms = new Map()
      for (const report of listActiveReports(roomId)) {
        if (report.status !== 'tracking') {
          const r = rt.roomOf(report.roomId)
          if (r !== undefined) queuedRooms.set(r.id, r)
        }
      }
      for (const [rId, r] of queuedRooms.entries()) {
        roomStates.set(rId, await roomAgentQueuedReports(r))
      }
    }
    const ready = []
    for (const report of listActiveReports(roomId)) {
      touchedRoomIds.add(report.roomId)
      if (rt.botOf(report.botId) === undefined) {
        dropRoomReport(report.id)
        continue
      }
      const room = rt.roomOf(report.roomId)
      if (room === undefined) {
        ready.push({ room: { id: report.roomId, name: 'a group chat' }, report, deleted: true, neverStarted: false })
        continue
      }
      if (startup && report.status !== 'tracking') {
        // Re-check live inbox / preStep status after any awaits so a relay consumed while
        // resolving another room is never falsely treated as still queued or never-started.
        const liveState = roomStates.get(room.id)
        const roomSid = rt.sessionOfRoom?.(room)
        const liveAgent = (roomSid ? rt.ctx?.get?.('agents')?.get?.(roomSid) : undefined) ?? liveState?.agent
        const currentSources = liveAgent
          ? [...(liveAgent.inbox?.nextStep ?? []), ...(liveAgent.inbox?.nextTurn ?? [])].map(m => m?.source).filter(Boolean)
          : (liveState?.queuedSources ?? [])
        const inPreStep = liveAgent ? isInPreStepWindow(liveAgent) : (liveState?.inPreStep === true)
        if (inPreStep) {
          schedulePreStepRecheck(room.id, liveAgent)
          continue
        }
        if (currentSources.some(src => matchesReportPost(src, report))) {
          continue
        }
      }
      if (isReportBusy(room, report, { startup })) continue
      const neverStarted = report.status !== 'tracking' || report.neverStarted === true
      ready.push({ room, report, deleted: false, neverStarted })
    }
    for (const item of ready) {
      await deliverRoomReport(item.room, item.report, { deleted: item.deleted, neverStarted: item.neverStarted })
    }
    for (const id of touchedRoomIds) clearRoomOriginIfIdle(rt.roomOf(id))
  }

  async function forgetRoomReports(room) {
    queuedRelays.delete(room.id)
    inFlightLate.delete(room.id)
    roomOrigins.delete(room.id)
    originVersions.delete(room.id)
    rt.clearRoomWebRound?.(room.id)
    const active = listActiveReports(room.id)
    if (active.length === 0) return
    for (const report of active) {
      await deliverRoomReport(room, report, { deleted: true })
    }
  }

  async function forgetBotRoomReports(botId, touchedRooms = []) {
    for (const report of listActiveReports()) {
      if (report.botId === botId) dropRoomReport(report.id)
    }
    for (const room of touchedRooms) {
      await exitMemberRoomCalls(room, botId)
      await settleRoomReports(room.id)
    }
  }

  function stopRoomReports(roomId) {
    for (const exchangeId of queuedRelays.get(roomId)?.keys() ?? []) rememberStoppedRelay(exchangeId)
    queuedRelays.delete(roomId)
    roomOrigins.delete(roomId)
    bumpOriginVersion(roomId)
    rt.clearRoomWebRound?.(roomId)
    for (const report of listActiveReports(roomId)) {
      if (report.status === 'queued') {
        rememberStoppedRelay(report.id)
        patchReport(report.id, { neverStarted: true, stopped: true, status: 'tracking' })
      } else if (report.stopped !== true) {
        patchReport(report.id, { stopped: true })
      }
    }
  }

  const withdrawingRelays = new Set()
  const beginWithdrawingRelay = (exchangeId) => { if (typeof exchangeId === 'string' && exchangeId !== '') withdrawingRelays.add(exchangeId) }
  const endWithdrawingRelay = (exchangeId) => { withdrawingRelays.delete(exchangeId) }

  function roomRelayDiscarded(source, sessionId) {
    if (typeof source?.roomId !== 'string') return
    if (typeof source.exchangeId === 'string' && withdrawingRelays.has(source.exchangeId)) return
    const room = rt.roomOf(source.roomId)
    if (sessionId !== undefined && room !== undefined && sessionId !== rt.sessionOfRoom(room)) return
    if (Object.values(rt.state.switching ?? {}).some(entry => entry?.roomId === source.roomId && entry.botId === undefined)) return
    if ([...(rt.switchJobs?.() ?? [])].some(job => job.roomId === source.roomId && job.botId === undefined)) return
    roomRelayTaken(source.roomId, source.exchangeId)
    if (typeof source.reportId === 'string') {
      const report = getReportById(source.reportId)
      if (report?.status === 'queued') {
        patchReport(source.reportId, { neverStarted: true, stopped: true, status: 'tracking' })
      }
    }
    void settleRoomReports(source.roomId).catch(error => rt.warn('ds-bot: settling reports after discarded relay failed: %s', error))
  }

  Object.assign(rt, {
    noteRoomRelayQueued,
    roomRelayTaken,
    roomRelayDiscarded,
    beginWithdrawingRelay,
    endWithdrawingRelay,
    openRoomReportCall,
    dropRoomReport,
    hasRoomReportFor,
    roomReportImOrigin,
    markRoomReportsWorked,
    settleRoomReports,
    forgetRoomReports,
    forgetBotRoomReports,
  })

  return {
    listActiveReports,
    rememberStoppedRelay,
    isStoppedRelay,
    isBotPendingPost,
    noteRoomRelayQueued,
    roomRelayTaken,
    roomRelayDiscarded,
    enterLate,
    leaveLate,
    openRoomReportCall,
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
