// Hand-offs: Bot-to-Bot delegations, ask_back/answer_work, wait-graph cycle checks,
// hard-signal no-progress detection, large result files, and read-only views.
//
// All coordination state lives in SQLite (`rt.coordDb`): works, calls, inbox, waits, ready.
// No state.works / closedWorks / pairLoops / abandonedWorks / imReplyOrigins / workSeq,
// and no hardcoded WORK_ASK_BACK_LIMIT or WORK_REWORK_CHECKPOINT counters.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LATE_ANSWER, TEXT_KEPT } from './constants.js'
import { CoordinationError } from './coordination-db.js'
import { normalizeImOrigin, sameImOrigin } from './im/origin.js'
import { headOf } from './text.js'
import {
  foregroundAddress,
  install as installThreads,
  ownChatSessions,
  returnAddress,
  roomMemberAddress,
  taskAddress,
} from './threads.js'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped'])

const minutes = (since) => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}
// A card can wait for days.
const forHowLong = (since) => {
  const hours = Math.floor((Date.now() - since) / 3_600_000)
  if (hours < 1) return minutes(since)
  if (hours < 24) return `for ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `for ${days} day${days === 1 ? '' : 's'}`
}

export function install(rt) {
  if (typeof rt.resolveLogicalSession !== 'function') installThreads(rt)

  const { ctx, state } = rt
  const nameOf = id => rt.botOf(id)?.name
  const writes = () => rt.readOnly?.() === undefined
  const hasCoordDb = () => rt.coordDb != null && !rt.coordDb.isClosed?.()
  const writableCoordDb = () => hasCoordDb() && rt.coordDb.readonly !== true && writes()

  // In-memory cache of full result bodies written during this process lifetime,
  // and bounded fallback map for non-work reply exchange IM origins (never written to state.json).
  const whole = new Map()
  const transientImOrigins = new Map()
  const TRANSIENT_IM_MAX = 200
  // Bounded process-local cache of abandoned work metadata so late subagent/reply checks stay O(1).
  const abandonedCache = new Map()
  const ABANDONED_CACHE_MAX = 100
  // In-memory held answer text for turns whose upstream delegation was refused.
  const heldAnswers = new Map()

  let workRefSeq = null
  const resetWorkRefSeq = () => { workRefSeq = null }
  const nextWorkRef = () => {
    if (workRefSeq === null) {
      let maxSeq = 0
      if (hasCoordDb()) {
        for (const work of rt.coordDb.listWorks({ limit: 10_000 })) {
          const match = /^W(\d+)$/i.exec(String(work.workRef ?? ''))
          if (match !== null) {
            const n = Number.parseInt(match[1], 10)
            if (Number.isInteger(n) && n > maxSeq) maxSeq = n
          }
        }
      }
      workRefSeq = maxSeq
    }
    workRefSeq += 1
    return `W${workRefSeq}`
  }

  const normalizeRef = (ref) => {
    const text = String(ref ?? '').trim()
    const match = /^#?(w\d+)$/i.exec(text)
    return match === null ? undefined : match[1].toUpperCase()
  }

  // --- Large result files (`<home>/handoff-results/`) ---
  const resultsDir = join(rt.home, 'handoff-results')
  const resultPath = name => join(resultsDir, name)
  const resultName = (id) => {
    const text = String(id)
    return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash('sha256').update(text).digest('hex')}.txt`
  }
  const keptName = (file) => {
    if (typeof file !== 'string') return undefined
    const base = file.startsWith('handoff-results/') ? file.slice('handoff-results/'.length) : file
    return /^[A-Za-z0-9_-]+\.txt$/.test(base) ? base : undefined
  }

  function keepResult(id, text) {
    const body = String(text ?? '')
    if (body.length <= TEXT_KEPT || !writes()) return undefined
    const name = resultName(id)
    const path = resultPath(name)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(temp, body, 'utf8')
      renameSync(temp, path)
      whole.set(id, body)
      return name
    } catch (error) {
      rt.warn?.('ds-bot: result of work %s not kept whole: %s', id, error)
      try { rmSync(temp, { force: true }) } catch {}
      return undefined
    }
  }

  function readResultFile(refOrName) {
    const name = keptName(refOrName)
    if (name === undefined) return undefined
    try {
      return readFileSync(resultPath(name), 'utf8')
    } catch {
      return undefined
    }
  }

  function resultText(result) {
    if (result == null) return { text: '', whole: true }
    if (result.id !== undefined && whole.has(result.id)) return { text: whole.get(result.id), whole: true }
    const ref = result.file ?? result.resultRef ?? result.bodyRef
    const fromDisk = readResultFile(ref)
    if (fromDisk !== undefined && (result.length === undefined || fromDisk.length === result.length)) {
      return { text: fromDisk, whole: true }
    }
    const fallback = result.text ?? result.resultSummary ?? result.bodyPreview ?? ''
    if (result.length === undefined || fallback.length >= result.length) {
      return { text: fallback, whole: true }
    }
    return { text: fallback, whole: false }
  }

  async function pruneOrphanResultFiles() {
    if (!writes()) return
    let entries
    try {
      entries = await readdir(resultsDir)
    } catch {
      return
    }
    if (!hasCoordDb() || !writes()) return
    const used = new Set()
    const activeNonFg = new Set()
    for (const work of rt.coordDb.listWorks({ limit: 5000 })) {
      const isActive = !TERMINAL_STATUSES.has(work.status)
      if (isActive && work.kind !== 'foreground') activeNonFg.add(work.workId)
      if (isActive || work.parentWorkId === null) {
        const name = keptName(work.resultRef)
        if (name !== undefined) used.add(name)
      }
    }
    for (const call of rt.coordDb.listCalls({ limit: 5000 })) {
      if (!activeNonFg.has(call.parentWorkId)) continue
      const name = keptName(call.resultRef)
      if (name !== undefined) used.add(name)
    }
    for (const file of entries) {
      const name = keptName(file)
      if (name === undefined || used.has(name)) continue
      await rm(resultPath(name), { force: true }).catch(() => {})
    }
  }

  // --- Coordination DB helpers ---

  const executionKindOf = (botId) => {
    const cap = rt.localAgentCapability?.(botId)
    if (cap?.executionKind) return cap.executionKind
    const bot = rt.botOf(botId)
    const ref = bot?.model ?? bot?.appliedModel ?? rt.cachedDefault?.()
    return (rt.localAgentBadge?.(ref) !== undefined || rt.isLocalAgentRef?.(ref) === true) ? 'local_cli' : 'dsh'
  }

  function ensureForegroundWorkForBot(botId) {
    if (!hasCoordDb() || typeof botId !== 'string' || botId === '') return undefined
    const existing = rt.coordDb.getForegroundWork(botId)
    if (existing !== undefined) return existing
    if (!writableCoordDb()) return undefined
    const bot = rt.botOf(botId)
    return rt.coordDb.ensureForegroundWork({
      botId,
      workId: `fg:${botId}`,
      logicalAddress: foregroundAddress(botId),
      sessionId: rt.chatOf?.(botId) ?? botId,
      workspaceDir: bot?.workDir ?? rt.teamFolder?.(),
      executionKind: executionKindOf(botId),
      privacyScoped: bot?.private === true,
    }).work
  }

  // Maps a `coordDb` work + optional incoming call into a unified object that exposes
  // canonical SQLite fields alongside legacy compatibility aliases (`ref`, `from`, `to`, `state`).
  const mapWorkCompat = (work, call) => {
    if (work === undefined) return undefined
    const incoming = call ?? (hasCoordDb()
      ? (rt.coordDb.listCalls({ childWorkId: work.workId, status: 'open', limit: 1 })[0]
        ?? rt.coordDb.listCalls({ childWorkId: work.workId, limit: 1 })[0])
      : undefined)
    const openAsk = hasCoordDb() && !TERMINAL_STATUSES.has(work.status)
      ? rt.coordDb.listWaits({ workId: work.workId, kind: 'ask', status: 'open', limit: 1 })[0]
      : undefined
    const legacyState = TERMINAL_STATUSES.has(work.status)
      ? (work.status === 'stopped' ? 'cancelled' : work.status === 'done' ? 'closed' : 'failed')
      : work.status === 'paused' || work.status === 'needs_verification'
        ? 'paused'
        : openAsk !== undefined
          ? 'need_input'
          : 'open'
    return {
      ...work,
      id: work.workId,
      ref: work.workRef ?? undefined,
      from: incoming?.callerBotId ?? (work.parentWorkId && hasCoordDb() ? rt.coordDb.getWork(work.parentWorkId)?.botId : undefined),
      to: work.botId,
      parent: work.parentWorkId ?? undefined,
      room: work.roomId ?? undefined,
      toSession: work.sessionId ?? undefined,
      goal: work.title ?? undefined,
      state: legacyState,
      ...(openAsk?.meta?.question ? { question: openAsk.meta.question } : {}),
      ...(incoming ? { callId: incoming.callId, returnAddress: incoming.returnAddress } : {}),
    }
  }

  function findDbWork(refOrId) {
    if (!hasCoordDb()) return undefined
    const key = String(refOrId ?? '').trim()
    if (key === '') return undefined
    const direct = rt.coordDb.getWork(key)
      ?? rt.coordDb.getWork(`handoff:${key}`)
      ?? rt.coordDb.getWork(`task:${key}`)
      ?? rt.coordDb.getWorkByLogicalAddress(key)
    if (direct !== undefined) return direct
    const ref = normalizeRef(key)
    if (ref !== undefined) {
      const byRef = rt.coordDb.getWorkByRef(ref)
      if (byRef !== undefined) return byRef
    }
    const call = rt.coordDb.getCall(key)
    if (call !== undefined) return rt.coordDb.getWork(call.childWorkId)
    return undefined
  }

  function resolveWork(refOrId) {
    const work = findDbWork(refOrId)
    if (work === undefined || TERMINAL_STATUSES.has(work.status)) return undefined
    const compat = mapWorkCompat(work)
    return { id: work.workId, work: compat, dbWork: work }
  }

  function closedWorkOf(refOrId) {
    const work = findDbWork(refOrId)
    if (work === undefined || !TERMINAL_STATUSES.has(work.status)) return undefined
    const compat = mapWorkCompat(work)
    const isAbandoned = work.status === 'stopped' && (work.error?.abandoned === true || abandonedCache.has(work.workId))
    return {
      id: work.workId,
      ref: work.workRef ?? undefined,
      from: compat.from,
      to: work.botId,
      status: isAbandoned ? 'abandoned' : work.status === 'stopped' ? 'cancelled' : work.status === 'done' ? 'closed' : 'failed',
      at: work.finishedAt ?? work.updatedAt,
      work: compat,
    }
  }

  const workRefOf = id => findDbWork(id)?.workRef ?? undefined
  const workStateOf = (id) => {
    const resolved = resolveWork(id)
    return resolved?.work?.state
  }

  // The work a turn does: the request it answers, or the work a result that came back goes on with.
  const workOf = (info) => {
    if (info === undefined) return undefined
    const direct = info.workId ?? (typeof info.coordWorkId === 'string' && !info.coordWorkId.startsWith('fg:') ? info.coordWorkId : undefined)
    if (direct !== undefined) return direct
    const raw = info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work
    return typeof raw === 'string' && !raw.startsWith('fg:') ? raw : undefined
  }

  function resolveWorkForSession(sessionId, { ensureForeground = true } = {}) {
    if (!hasCoordDb() || typeof sessionId !== 'string' || sessionId === '') return undefined
    const liveInfo = rt.live?.get(sessionId)?.info
    const activeId = workOf(liveInfo)
    if (activeId !== undefined) {
      const fromLive = findDbWork(activeId)
      if (fromLive !== undefined && !TERMINAL_STATUSES.has(fromLive.status)) return fromLive
    }
    const taskOwner = rt.taskOwners?.get(sessionId)
    if (taskOwner?.taskId) {
      const taskWork = rt.coordDb.getWork(`task:${taskOwner.taskId}`) ?? rt.coordDb.getWorkBySessionId(sessionId)
      if (taskWork !== undefined && !TERMINAL_STATUSES.has(taskWork.status)) return taskWork
    }
    const bySession = rt.coordDb.getWorkBySessionId(sessionId)
    if (bySession !== undefined && !TERMINAL_STATUSES.has(bySession.status)) return bySession
    const groupOwner = rt.groupOwners?.get(sessionId)
    if (groupOwner?.roomId && groupOwner?.botId) {
      const roomWork = rt.coordDb.getWorkByLogicalAddress(roomMemberAddress(groupOwner.roomId, groupOwner.botId))
      if (roomWork !== undefined && !TERMINAL_STATUSES.has(roomWork.status)) return roomWork
    }
    const botId = rt.chatOwners?.get(sessionId) ?? rt.selfOf?.(sessionId)
    if (botId !== undefined) {
      const fg = rt.coordDb.getForegroundWork(botId)
      if (fg !== undefined) return fg
      if (ensureForeground) return ensureForegroundWorkForBot(botId)
    }
    return undefined
  }

  // Walks upstream along open `call` waits and calls to find every Bot currently waiting
  // (directly or transitively) on any work in `workIds`.
  function upstreamOf(workIds) {
    const bots = new Set()
    if (!hasCoordDb()) return bots
    const queue = []
    const visited = new Set()
    for (const rawId of workIds ?? []) {
      const work = findDbWork(rawId)
      if (work !== undefined && !visited.has(work.workId)) {
        visited.add(work.workId)
        queue.push(work.workId)
      }
    }
    while (queue.length > 0) {
      const currentId = queue.shift()
      const incomingWaits = rt.coordDb.listWaits({ targetWorkId: currentId, kind: 'call', status: 'open', limit: 200 })
      for (const wait of incomingWaits) {
        const parent = rt.coordDb.getWork(wait.workId)
        if (parent !== undefined && !TERMINAL_STATUSES.has(parent.status)) {
          if (parent.botId) bots.add(parent.botId)
          if (!visited.has(parent.workId)) {
            visited.add(parent.workId)
            queue.push(parent.workId)
          }
        }
      }
      const incomingCalls = rt.coordDb.listCalls({ childWorkId: currentId, status: 'open', limit: 200 })
      for (const call of incomingCalls) {
        if (call.callerBotId) bots.add(call.callerBotId)
        if (call.parentWorkId && !visited.has(call.parentWorkId)) {
          visited.add(call.parentWorkId)
          queue.push(call.parentWorkId)
        }
      }
    }
    return bots
  }

  // Creates a tracked delegation (`childWork + call + wait(kind='call') + initial inbox(request)`)
  // in a single atomic SQLite transaction, enforcing wait-graph cycle detection (both work-level
  // and Bot-level) and privacy boundaries.
  function createCall({
    workId,
    callId,
    parentWorkId,
    callerBotId,
    calleeBotId,
    returnAddr,
    visibleScope,
    roomId,
    explicitPublish = false,
    title,
    imOrigin,
    priority = 'interactive',
    workspaceDir,
    workspaceMode,
    initialMessage,
    meta,
    sessionId,
    assignRef = true,
  }) {
    if (!writableCoordDb()) {
      throw new CoordinationError('coordination/readonly', 'Coordination database is not writable')
    }
    const callerBot = rt.botOf(callerBotId)
    const calleeBot = rt.botOf(calleeBotId)
    const cleanOrigin = normalizeImOrigin(imOrigin)
    const privacyScoped = Boolean(callerBot?.private === true || calleeBot?.private === true)
    const effectiveScope = visibleScope ?? (privacyScoped ? 'private' : (roomId ? 'room' : 'direct'))

    return rt.coordDb.transaction(() => {
      const parent = (parentWorkId ? rt.coordDb.getWork(parentWorkId) : undefined)
        ?? ensureForegroundWorkForBot(callerBotId)
      if (parent === undefined) {
        throw new CoordinationError('coordination/not_found', `Parent work for caller ${callerBotId} not found`)
      }

      // Bot-level cycle guard: refuse delegating back to a Bot already waiting on this work chain.
      const waitingBots = upstreamOf([parent.workId])
      if (waitingBots.has(calleeBotId)) {
        throw new CoordinationError(
          'coordination/wait_cycle',
          `Delegation from ${callerBotId} (${parent.workId}) to ${calleeBotId} would form a wait cycle`,
          { suggestedAction: 'ask', upstreamBotId: calleeBotId, parentWorkId: parent.workId },
        )
      }

      const id = workId ?? `w_${randomUUID()}`
      const cId = callId ?? `c_${id}`
      const ref = assignRef && roomId === undefined ? nextWorkRef() : undefined
      const effectiveReturn = returnAddr ?? parent.logicalAddress ?? foregroundAddress(callerBotId)
      const childAddress = roomId ? roomMemberAddress(roomId, calleeBotId) : taskAddress(id)
      const childPrivacy = privacyScoped || parent.privacyScoped === true
      const effectiveSessionId = sessionId ?? (roomId ? rt.roomOf(roomId)?.sessions?.[calleeBotId] : rt.chatOf?.(calleeBotId))
      const callerDisplayName = callerBot?.name ?? 'teammate'

      const { work: childWork } = rt.coordDb.createWork({
        workId: id,
        ...(ref !== undefined ? { workRef: ref } : {}),
        botId: calleeBotId,
        kind: roomId ? 'room_work' : 'task',
        logicalAddress: childAddress,
        status: 'idle',
        priority,
        parentWorkId: parent.workId,
        ...(roomId ? { roomId } : {}),
        ...(typeof title === 'string' && title.trim() !== '' ? { title: headOf(title.trim().replace(/\s+/g, ' '), 80) } : {}),
        originKind: roomId ? 'group' : 'bot',
        ...(cleanOrigin ? { imOrigin: cleanOrigin } : {}),
        visibility: childPrivacy ? 'private' : effectiveScope,
        privacyScoped: childPrivacy,
        ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
        executionKind: executionKindOf(calleeBotId),
        workspaceDir: workspaceDir ?? calleeBot?.workDir ?? rt.teamFolder?.(),
        workspaceMode: workspaceMode ?? ((workspaceDir ?? calleeBot?.workDir ?? rt.teamFolder?.()) ? 'write' : 'isolated'),
        meta: {
          ...(meta ?? {}),
          callerBotId,
          returnAddress: effectiveReturn,
        },
      })

      const initPayload = initialMessage?.payload ?? {}
      const initText = typeof initPayload.text === 'string' ? initPayload.text : (initialMessage?.bodyPreview ?? '')
      const defaultRendered = initText !== ''
        ? `[Work${ref ? ` #${ref}` : ''} from ${callerDisplayName} · reply closes work; call ask_back if blocked]\n${initText}`
        : undefined
      const callRes = rt.coordDb.createCall({
        callId: cId,
        parentWorkId: parent.workId,
        childWorkId: childWork.workId,
        callerBotId,
        calleeBotId,
        returnAddress: effectiveReturn,
        visibleScope: childPrivacy && !explicitPublish && effectiveScope === 'room' ? 'private' : effectiveScope,
        ...(roomId ? { roomId } : {}),
        explicitPublish,
        initialMessage: initialMessage === undefined
          ? undefined
          : {
              ...initialMessage,
              senderAddress: initialMessage.senderAddress ?? effectiveReturn,
              senderBotId: initialMessage.senderBotId ?? callerBotId,
              payload: {
                ...initPayload,
                ...(initPayload.renderedText === undefined && defaultRendered !== undefined ? { renderedText: defaultRendered } : {}),
                source: {
                  senderName: callerDisplayName,
                  ...(initPayload.source ?? {}),
                },
                workId: childWork.workId,
                callId: cId,
                ...(ref ? { workRef: ref } : {}),
                returnAddress: effectiveReturn,
              },
            },
        meta,
      })

      return {
        ...callRes,
        work: callRes.childWork,
        workId: childWork.workId,
        workRef: ref,
        returnAddress: effectiveReturn,
      }
    })
  }

  // Compatibility wrapper for callers that still invoke `rt.openWork(id, opts)`.
  function openWork(id, { from, to, parent, fromRoom, room, name, child, fromPart, toSession, toTaskId, imOrigin, goal } = {}) {
    if (!writableCoordDb() || typeof id !== 'string' || id === '') return undefined
    const ownerBot = to ?? from
    if (!ownerBot) return undefined
    if (from && to && room === undefined && child === undefined) {
      const parentWork = (parent ? findDbWork(parent) : undefined)
        ?? (fromPart ? resolveWorkForSession(fromPart) : undefined)
        ?? ensureForegroundWorkForBot(from)
      const res = createCall({
        workId: id,
        parentWorkId: parentWork?.workId,
        callerBotId: from,
        calleeBotId: to,
        returnAddr: returnAddress(rt, { fromRoom, fromPart, botId: from, workId: parentWork?.workId }),
        title: goal ?? name,
        imOrigin,
        sessionId: toSession,
        meta: { ...(toTaskId ? { taskId: toTaskId } : {}), ...(fromRoom ? { fromRoom } : {}), ...(fromPart ? { fromPart } : {}) },
      })
      return mapWorkCompat(res.work, res.call)
    }
    const parentWork = parent ? findDbWork(parent) : undefined
    const bot = rt.botOf(ownerBot)
    const cleanOrigin = normalizeImOrigin(imOrigin)
    const { work } = rt.coordDb.createWork({
      workId: id,
      botId: ownerBot,
      kind: room ? 'room_work' : 'task',
      logicalAddress: room ? roomMemberAddress(room, ownerBot) : taskAddress(id),
      status: 'idle',
      priority: 'background',
      ...(parentWork ? { parentWorkId: parentWork.workId } : {}),
      ...(room ? { roomId: room } : {}),
      ...(typeof (goal ?? name) === 'string' && (goal ?? name).trim() !== '' ? { title: headOf(String(goal ?? name).trim().replace(/\s+/g, ' '), 80) } : {}),
      originKind: child ? 'task' : room ? 'group' : 'bot',
      ...(cleanOrigin ? { imOrigin: cleanOrigin } : {}),
      privacyScoped: bot?.private === true,
      ...(toSession ? { sessionId: toSession } : {}),
      executionKind: executionKindOf(ownerBot),
      workspaceDir: bot?.workDir ?? rt.teamFolder?.(),
      meta: {
        ...(name ? { name } : {}),
        ...(child ? { child, taskId: toTaskId ?? child } : {}),
        ...(fromRoom ? { fromRoom } : {}),
        ...(fromPart ? { fromPart } : {}),
      },
    })
    if (parentWork !== undefined && from !== undefined) {
      rt.coordDb.createCall({
        callId: `c_${id}`,
        parentWorkId: parentWork.workId,
        childWorkId: work.workId,
        callerBotId: from,
        calleeBotId: ownerBot,
        returnAddress: returnAddress(rt, { fromRoom, fromPart, botId: from, workId: parentWork.workId }) ?? parentWork.logicalAddress,
        visibleScope: bot?.private === true ? 'private' : (room ? 'room' : 'direct'),
        ...(room ? { roomId: room } : {}),
      })
    }
    return mapWorkCompat(work)
  }

  function setWorkTargetSession(id, toSession) {
    if (!writableCoordDb()) return
    const work = findDbWork(id)
    if (work === undefined) return
    rt.coordDb.rebindSession(work.workId, toSession || null)
  }

  // Worker asks the caller a blocking question without closing the work.
  // Enforces ask-cycle detection via `rt.coordDb.askBack`; no hardcoded round limit.
  function askBackWork(idOrRef, question, { bodyRef, bodyPreview, payload, meta } = {}) {
    if (!writableCoordDb()) return { error: 'readonly' }
    const work = findDbWork(idOrRef)
    if (work === undefined) return { error: 'not_found' }
    if (TERMINAL_STATUSES.has(work.status)) return { error: `state_${work.status}`, work: mapWorkCompat(work) }
    const call = rt.coordDb.listCalls({ childWorkId: work.workId, status: 'open', limit: 1 })[0]
    const targetWorkId = call?.parentWorkId ?? work.parentWorkId
    if (!targetWorkId) return { error: 'no_caller', work: mapWorkCompat(work) }
    const targetWork = rt.coordDb.getWork(targetWorkId)
    if (targetWork === undefined || TERMINAL_STATUSES.has(targetWork.status)) {
      return { error: 'caller_terminal', work: mapWorkCompat(work) }
    }
    const fullQuestion = String(question ?? '').trim()
    const boundedQuestion = headOf(fullQuestion, 400)
    const workerName = nameOf(work.botId) ?? 'teammate'
    const tag = work.workRef ? ` #${work.workRef}` : ''
    try {
      const res = rt.coordDb.askBack({
        askerWorkId: work.workId,
        targetWorkId,
        bodyRef,
        bodyPreview: bodyPreview ?? boundedQuestion,
        payload: {
          role: 'ask_back',
          askWork: work.workId,
          ...(work.workRef ? { workRef: work.workRef } : {}),
          question: fullQuestion,
          renderedText: `[Work${tag} · ${workerName} asks before continuing · call answer_work to unblock or cancel_work to stop]\n${payload?.text ?? fullQuestion}`,
          source: {
            askWork: work.workId,
            senderName: workerName,
            ...(work.workRef ? { workRef: work.workRef } : {}),
            ...(payload?.source ?? {}),
          },
          ...(payload ?? {}),
        },
        meta: {
          question: boundedQuestion,
          ...(call ? { callId: call.callId, callerBotId: call.callerBotId } : {}),
          ...(meta ?? {}),
        },
      })
      return {
        status: 'asked',
        id: work.workId,
        work: mapWorkCompat(rt.coordDb.getWork(work.workId), call),
        wait: res.wait,
        message: res.message,
        targetWorkId,
        callerBotId: call?.callerBotId ?? targetWork.botId,
      }
    } catch (error) {
      if (error?.code === 'coordination/ask_cycle') {
        return {
          error: 'ask_cycle',
          suggestedAction: error.details?.suggestedAction ?? 'user_question',
          cycle: error.details?.cycle ?? [],
          work: mapWorkCompat(work, call),
        }
      }
      throw error
    }
  }

  // Caller answers an ask_back question and unblocks the worker atomically in SQLite.
  function answerWork(idOrRef, answerText = '', { senderBotId, senderAddress, bodyRef, payload } = {}) {
    if (!writableCoordDb()) return { error: 'readonly' }
    const work = findDbWork(idOrRef)
    if (work === undefined) return { error: 'not_found' }
    if (TERMINAL_STATUSES.has(work.status)) return { error: `state_${work.status}`, work: mapWorkCompat(work) }
    const askWait = rt.coordDb.listWaits({ workId: work.workId, kind: 'ask', status: 'open', limit: 1 })[0]
    if (askWait === undefined) return { error: `state_${work.status}`, work: mapWorkCompat(work) }
    const text = String(answerText ?? '').trim()
    const callerName = (senderBotId ? nameOf(senderBotId) : undefined) ?? 'the caller'
    const tag = work.workRef ? ` #${work.workRef}` : ''
    const res = rt.coordDb.resolveWait({
      waitId: askWait.waitId,
      status: 'resolved',
      resolution: { answerPreview: headOf(text, 400) },
      inboxMessage: {
        kind: 'answer',
        senderBotId,
        senderAddress,
        bodyRef,
        bodyPreview: headOf(text, 400),
        payload: {
          role: 'answer',
          work: work.workId,
          ...(work.workRef ? { workRef: work.workRef } : {}),
          text,
          renderedText: `[Work${tag} · ${callerName} answered your question · continue and reply when done]\n${text}`,
          source: {
            work: work.workId,
            senderName: callerName,
            ...(work.workRef ? { workRef: work.workRef } : {}),
            ...(payload?.source ?? {}),
          },
          ...(payload ?? {}),
        },
      },
    })
    return {
      status: 'answered',
      id: work.workId,
      work: mapWorkCompat(res.work),
      wait: res.wait,
      workWoken: res.workWoken,
    }
  }

  // Cancels an open/waiting/paused work cleanly in a single SQLite transaction.
  function cancelWork(idOrRef, { reason = '', by, cascadeChildren = true } = {}) {
    if (!writableCoordDb()) return undefined
    const work = findDbWork(idOrRef)
    if (work === undefined || TERMINAL_STATUSES.has(work.status)) return undefined
    const incoming = rt.coordDb.listCalls({ childWorkId: work.workId, status: 'open', limit: 1 })[0]
    const cleanReason = reason.trim() || 'Cancelled'
    const targetName = nameOf(work.botId) ?? work.title ?? 'The other Bot'
    const tag = work.workRef ? ` #${work.workRef}` : ''
    const res = rt.coordDb.stopWork(work.workId, {
      reason: cleanReason,
      by,
      cascadeChildren,
      summary: cleanReason,
      ...(typeof by === 'string' && by !== '' && by !== 'user' && by !== 'system' ? { suppressParentBotId: by } : {}),
      resultMeta: {
        role: 'reply',
        replyTo: work.workId,
        ...(work.workRef ? { workRef: work.workRef } : {}),
        senderName: targetName,
        renderedText: `[Work${tag} stopped · ${targetName}]\n${cleanReason}`,
        source: {
          replyTo: work.workId,
          ...(work.workRef ? { workRef: work.workRef } : {}),
          senderName: targetName,
        },
      },
    })
    whole.delete(work.workId)
    if (res.wokenParents?.length > 0 || res.wokenAskers?.length > 0) {
      void rt.kickScheduler?.().catch(() => {})
    }
    return {
      id: work.workId,
      workId: work.workId,
      ref: work.workRef ?? undefined,
      from: incoming?.callerBotId ?? (work.parentWorkId ? rt.coordDb.getWork(work.parentWorkId)?.botId : undefined),
      to: work.botId,
      room: work.roomId ?? undefined,
      parent: work.parentWorkId ?? undefined,
      toSession: work.sessionId ?? undefined,
      state: work.status,
      work: res.work,
      settledCalls: res.settledCalls,
      wokenParents: res.wokenParents,
      wokenAskers: res.wokenAskers,
      stoppedChildren: res.stoppedChildren,
    }
  }

  function pauseWork(idOrRef, { reason = 'paused', detail, status = 'paused', pauseChain = false } = {}) {
    if (!writableCoordDb()) return { paused: false, reason: 'readonly', pausedWorkIds: [] }
    const work = findDbWork(idOrRef)
    if (work === undefined) return { paused: false, reason: 'not_found', pausedWorkIds: [] }
    return rt.coordDb.pauseWork(work.workId, { reason, detail, status, pauseChain })
  }

  function resumeWork(idOrRef, { resumeChain = true, resetProgress = true, reason = 'user_resume' } = {}) {
    if (!writableCoordDb()) return { resumed: false, resumedWorkIds: [], queuedWorkIds: [] }
    const work = findDbWork(idOrRef)
    if (work === undefined) return { resumed: false, resumedWorkIds: [], queuedWorkIds: [] }
    const res = rt.coordDb.resumeWork(work.workId, { resumeChain, resetProgress, reason })
    if (res.resumed) {
      void rt.kickScheduler?.().catch(() => {})
    }
    return res
  }

  // Hard-signal stagnation check: compares `(chainRevisionSum, workspaceDigest, outputDigest, errorSignature)`.
  // Normal chains making progress run arbitrarily many steps; stagnation pauses ONLY this causal chain.
  function recordWorkProgress({
    workId,
    unresolvedKey,
    workspaceDigest = '',
    outputDigest = '',
    errorSignature = '',
    revision,
    threshold,
    pauseOnStagnation = true,
    reason,
  }) {
    if (!writableCoordDb()) return { progressed: true, stagnant: false, paused: false, pausedWorkIds: [] }
    const work = findDbWork(workId)
    if (work === undefined) return { progressed: true, stagnant: false, paused: false, pausedWorkIds: [] }
    return rt.coordDb.recordProgressCheck({
      workId: work.workId,
      unresolvedKey,
      workspaceDigest,
      outputDigest,
      errorSignature,
      ...(revision !== undefined ? { revision } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      pauseOnStagnation,
      reason,
    })
  }

  function closeWork(id, _name, text, extra = {}) {
    if (!writableCoordDb()) return undefined
    const work = findDbWork(id)
    if (work === undefined || TERMINAL_STATUSES.has(work.status) || work.kind === 'foreground') return undefined
    const body = String(text ?? '')
    const file = keepResult(work.workId, body)
    if (body.length > TEXT_KEPT) {
      try { rt.coordDb.updateApiMeta?.(work.workId, { resultLength: body.length }) } catch {}
    }
    const outcome = extra?.abandoned === true ? 'stopped' : extra?.failed === true ? 'failed' : 'done'
    const res = rt.coordDb.settleWork({
      workId: work.workId,
      outcome,
      force: true,
      summary: headOf(body, TEXT_KEPT),
      ...(file ? { resultRef: file } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.deliverDirect === true ? { notifyParents: false } : {}),
    })
    if (extra?.deliverDirect !== true && (res.wokenParents?.length > 0 || res.wokenAskers?.length > 0)) {
      void rt.kickScheduler?.().catch(() => {})
    }
    return work.parentWorkId ?? undefined
  }

  function dropWork(id) {
    if (!writableCoordDb()) return
    const work = findDbWork(id)
    if (work === undefined || TERMINAL_STATUSES.has(work.status)) return
    rt.coordDb.stopWork(work.workId, { reason: 'dropped', cascadeChildren: false })
    whole.delete(work.workId)
  }

  // Gives up waiting on one child work/call: settles it as stopped with an explicit result
  // in SQLite so the parent wakes immediately once required waits reach zero, and any late
  // result is archived without resurrecting the work.
  function abandonWork(idOrRef, reason = 'user') {
    if (!writableCoordDb()) return false
    let work = findDbWork(idOrRef)
    if (work === undefined) {
      const wait = rt.coordDb.listWaits({ status: 'open', limit: 500 }).find(w => w.waitId === idOrRef || w.targetId === idOrRef)
      if (wait?.targetWorkId) work = rt.coordDb.getWork(wait.targetWorkId)
    }
    if (work === undefined || TERMINAL_STATUSES.has(work.status)) return false
    const incoming = rt.coordDb.listCalls({ childWorkId: work.workId, status: 'open', limit: 1 })[0]
    const targetName = work.roomId
      ? `the group chat "${rt.roomOf(work.roomId)?.name ?? 'a group chat'}"`
      : work.meta?.child !== undefined
        ? (work.apiMeta?.name ?? work.meta?.name ?? work.title ?? 'subagent')
        : (nameOf(work.botId) ?? work.title ?? 'the other Bot')
    const tag = work.workRef ? ` #${work.workRef}` : ''
    const summary = reason === 'gone'
      ? `${targetName} is no longer on the team, so no reply can come back for work${tag}. The user gave up waiting for that answer: this counts as its result.`
      : reason === 'restart'
        ? `Work${tag} handed to ${targetName} did not complete before DeepSeek Harness restarted. This counts as its result.`
        : `No reply came back from ${targetName}, and the user gave up waiting for work${tag}. This counts as its result.`

    if (abandonedCache.size >= ABANDONED_CACHE_MAX) {
      abandonedCache.delete(abandonedCache.keys().next().value)
    }
    abandonedCache.set(work.workId, {
      at: Date.now(),
      from: incoming?.callerBotId,
      to: work.botId,
      room: work.roomId ?? undefined,
      parent: work.parentWorkId ?? undefined,
      name: targetName,
      reason,
      waiting: incoming?.callerBotId,
    })

    if (reason === 'gone') rt.dropRoomReport?.(work.workId)
    const parentWork = work.parentWorkId ? rt.coordDb.getWork(work.parentWorkId) : undefined
    const grandAsker = parentWork && parentWork.kind !== 'foreground'
      ? nameOf(rt.coordDb.listCalls({ childWorkId: parentWork.workId, status: 'open', limit: 1 })[0]?.callerBotId)
      : undefined
    const goesOn = grandAsker === undefined ? '' : ` · for the work ${grandAsker} asked you for; your answer goes to ${grandAsker} once everything you handed on is back`
    const header = reason === 'restart'
      ? `[Work${tag} · ${targetName} did not complete before restart${goesOn}]`
      : `[Waiting given up · ${targetName} did not hand back this work; go on with the work it was for${goesOn}]`
    const res = rt.coordDb.settleWork({
      workId: work.workId,
      outcome: 'stopped',
      force: true,
      summary,
      resultMeta: {
        role: 'reply',
        abandoned: true,
        abandonedReason: reason,
        replyTo: work.workId,
        ...(work.workRef ? { workRef: work.workRef } : {}),
        senderName: targetName,
        renderedText: `${header}\n${summary}`,
        source: {
          replyTo: work.workId,
          ...(work.workRef ? { workRef: work.workRef } : {}),
          senderName: targetName,
          abandoned: true,
        },
      },
      error: { code: 'work/abandoned', message: reason, abandoned: true },
    })
    void rt.abortWorkExecution?.(work.workId, { reason: `abandoned:${reason}`, by: reason }).catch(() => {})
    if (res.wokenParents?.length > 0 || res.wokenAskers?.length > 0) {
      void rt.kickScheduler?.().catch(() => {})
    }
    return true
  }

  function takeAbandoned(id) {
    const entry = abandonedCache.get(id)
    if (entry === undefined) return undefined
    abandonedCache.delete(id)
    return entry
  }

  // --- Queries & compatibility helpers ---

  const owns = (botId, workId) => {
    if (!botId || !workId) return false
    const work = findDbWork(workId)
    return work !== undefined && !TERMINAL_STATUSES.has(work.status) && work.botId === botId
  }

  const waits = (workId) => {
    if (!hasCoordDb() || !workId) return false
    const work = findDbWork(workId)
    if (work === undefined || TERMINAL_STATUSES.has(work.status)) return false
    return rt.coordDb.listWaits({ workId: work.workId, status: 'open', limit: 1 }).length > 0
  }

  const hold = (workId, text) => {
    if (!workId || !text) return
    heldAnswers.set(workId, headOf(String(text), TEXT_KEPT))
    if (heldAnswers.size > 100) heldAnswers.delete(heldAnswers.keys().next().value)
  }
  const hasHeldWork = workId => heldAnswers.has(workId)

  const askedBy = (workId) => {
    const work = findDbWork(workId)
    if (work === undefined) return undefined
    const call = rt.coordDb.listCalls({ childWorkId: work.workId, status: 'open', limit: 1 })[0]
      ?? rt.coordDb.listCalls({ childWorkId: work.workId, limit: 1 })[0]
    return {
      kind: 'bot',
      role: 'request',
      exchangeId: work.workId,
      workId: work.workId,
      ...(work.workRef ? { workRef: work.workRef } : {}),
      ...(call?.callerBotId ? { senderSessionId: call.callerBotId } : {}),
      ...(call?.returnAddress ? { returnAddress: call.returnAddress } : {}),
      ...(work.meta?.fromPart ? { senderPart: work.meta.fromPart } : {}),
      ...(work.meta?.fromRoom ? { senderRoomId: work.meta.fromRoom } : {}),
    }
  }

  function answerText(workId, reply, botName) {
    const said = reply !== '' ? reply : (heldAnswers.get(workId) ?? '')
    heldAnswers.delete(workId)
    if (!hasCoordDb()) return said || `${botName} finished without a reply.`
    const work = findDbWork(workId)
    if (work === undefined) return said || `${botName} finished without a reply.`
    const formatEntry = (label, resObj) => {
      const { text, whole: isWhole } = resultText(resObj)
      const body = isWhole || resObj.length === undefined
        ? text
        : `${text}\n[cut; ${resObj.length} characters in all, the rest was not kept]`
      return `${label}:\n${body}`
    }
    const settledChildren = rt.coordDb.listCalls({ parentWorkId: work.workId, limit: 50 })
      .filter(call => call.status !== 'open' && !String(call.childWorkId ?? '').startsWith('room-report:'))
    const results = settledChildren.map((call) => {
      const childWork = rt.coordDb.getWork(call.childWorkId)
      const childName = childWork?.meta?.child !== undefined
        ? (childWork.apiMeta?.name ?? childWork.meta?.name ?? childWork.title ?? 'subagent')
        : (nameOf(call.calleeBotId) ?? 'teammate')
      const origLength = childWork?.apiMeta?.resultLength ?? call.meta?.resultLength
      return formatEntry(childName, {
        id: call.childWorkId,
        resultRef: call.resultRef,
        resultSummary: call.resultSummary,
        ...(origLength !== undefined ? { length: origLength } : {}),
      })
    })
    for (const legacy of Array.isArray(work.meta?.legacyResults) ? work.meta.legacyResults : []) {
      results.push(formatEntry(legacy.name ?? 'teammate', legacy))
    }
    return results.length === 0
      ? (said || `${botName} finished without a reply.`)
      : [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
  }

  const sameWork = (id, parent) => {
    const work = findDbWork(id)
    const p = parent ? findDbWork(parent) : undefined
    return (work?.parentWorkId ?? undefined) === (p?.workId ?? undefined)
  }

  const needInputWorksFor = (callerId) => {
    if (!hasCoordDb() || !callerId) return []
    const openAsks = rt.coordDb.listWaits({ kind: 'ask', status: 'open', limit: 200 })
    const out = []
    for (const askWait of openAsks) {
      const target = askWait.targetWorkId ? rt.coordDb.getWork(askWait.targetWorkId) : undefined
      if (target?.botId !== callerId) continue
      const askerWork = rt.coordDb.getWork(askWait.workId)
      if (askerWork === undefined || TERMINAL_STATUSES.has(askerWork.status)) continue
      out.push({ id: askerWork.workId, work: mapWorkCompat(askerWork), wait: askWait })
    }
    return out
  }

  const openWorksBetween = (fromId, toId) => {
    if (!hasCoordDb() || !fromId || !toId) return []
    const openCalls = rt.coordDb.listCalls({ status: 'open', limit: 500 })
      .filter(call => call.callerBotId === fromId && call.calleeBotId === toId)
    const out = []
    for (const call of openCalls) {
      const child = rt.coordDb.getWork(call.childWorkId)
      if (child !== undefined && !TERMINAL_STATUSES.has(child.status)) {
        out.push({ id: child.workId, work: mapWorkCompat(child, call), call })
      }
    }
    return out
  }

  const workImOrigin = (id) => {
    const work = findDbWork(id)
    if (work === undefined) return undefined
    if (work.meta?.imOriginMixed === true) return { mixed: true }
    return work.imOrigin ?? undefined
  }

  function rememberImReplyOrigin(id, imOrigin) {
    const isMixed = imOrigin?.mixed === true
    const cleanOrigin = isMixed ? undefined : normalizeImOrigin(imOrigin)
    if (typeof id !== 'string' || id === '' || (!isMixed && cleanOrigin === undefined)) return
    transientImOrigins.set(id, isMixed ? { mixed: true, at: Date.now() } : { ...cleanOrigin, at: Date.now() })
    if (transientImOrigins.size > TRANSIENT_IM_MAX) {
      transientImOrigins.delete(transientImOrigins.keys().next().value)
    }
  }

  function imReplyOrigin(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const fromDb = workImOrigin(id)
    if (fromDb !== undefined) return fromDb
    return transientImOrigins.get(id)
  }

  // Compatibility no-ops for removed heuristic pair-loop counters (replaced by hard-signal `recordWorkProgress`).
  const checkPairLoop = () => ({ ok: true })
  const noteWorkCompleted = () => {}
  const resetPairLoop = () => {}
  const resetBotLoops = () => {}
  const markWorkWorked = () => {}
  const taken = () => {}
  const lateWork = () => {}
  const answerMissed = () => {}
  const mergeWorkImOrigin = (id, nextImOrigin) => {
    const existing = imReplyOrigin(id)
    const cleanNext = normalizeImOrigin(nextImOrigin)
    if (existing !== undefined && existing.mixed !== true && !sameImOrigin(existing, cleanNext)) {
      rememberImReplyOrigin(id, { mixed: true })
    }
  }

  // --- Client-compatible Read-Only Views (safe in readonly windows) ---

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    if (!hasCoordDb()) return view
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    const openWaits = rt.coordDb.listWaits({ status: 'open', limit: 500 })
    for (const wait of openWaits) {
      if (wait.kind !== 'call' && wait.kind !== 'ask') continue
      const ownerWork = rt.coordDb.getWork(wait.workId)
      if (ownerWork === undefined || ownerWork.kind === 'foreground' || TERMINAL_STATUSES.has(ownerWork.status)) continue
      if (ownerWork.status === 'running' || (ownerWork.sessionId && rt.live?.get?.(ownerWork.sessionId)?.turn !== undefined)) continue
      const owner = ownerWork.botId
      const targetWork = wait.targetWorkId ? rt.coordDb.getWork(wait.targetWorkId) : undefined
      if (targetWork === undefined || TERMINAL_STATUSES.has(targetWork.status)) continue
      const entry = view[owner] ??= { bots: [], rooms: [], for: [], waits: [] }
      if (targetWork.roomId) {
        add(entry.rooms, targetWork.roomId)
        entry.waits.push({ id: targetWork.workId, room: targetWork.roomId, name: rt.roomOf(targetWork.roomId)?.name })
      } else {
        add(entry.bots, targetWork.botId)
        entry.waits.push({ id: targetWork.workId, to: targetWork.botId, name: nameOf(targetWork.botId) ?? targetWork.title })
      }
      const incoming = rt.coordDb.listCalls({ childWorkId: ownerWork.workId, status: 'open', limit: 1 })[0]
      if (incoming?.callerBotId && incoming.callerBotId !== owner) add(entry.for, incoming.callerBotId)
    }
    return view
  }

  function pausedWorksView() {
    const out = []
    const seenIds = new Set()
    if (hasCoordDb()) {
      const paused = rt.coordDb.listWorks({ statuses: ['paused', 'needs_verification'], limit: 200 })
      for (const work of paused) {
        if (work.originKind === 'request_dedup') continue
        const call = rt.coordDb.listCalls({ childWorkId: work.workId, limit: 1 })[0]
        const parentWork = work.parentWorkId ? rt.coordDb.getWork(work.parentWorkId) : undefined
        const from = call?.callerBotId ?? parentWork?.botId ?? null
        const detail = work.pauseDetail ?? {}
        const id = work.meta?.legacyWorkId ?? work.workId
        seenIds.add(id)
        seenIds.add(work.workId)
        out.push({
          id,
          ref: work.workRef ?? null,
          from,
          fromName: from ? (nameOf(from) ?? null) : null,
          to: work.botId ?? null,
          toName: nameOf(work.botId) ?? null,
          reason: work.pauseReason ?? (work.status === 'needs_verification' ? 'interrupted_tools' : 'paused'),
          kind: detail.kind ?? (work.status === 'needs_verification' ? 'needs_verification' : 'no_progress'),
          goal: work.title ?? headOf(detail.message ?? detail.text ?? '', 200),
          ...(detail.question ? { question: headOf(detail.question, 200) } : {}),
          ...(detail.count !== undefined ? { bounces: detail.count } : {}),
          at: typeof detail.at === 'number' ? detail.at : (work.updatedAt ?? work.createdAt),
        })
      }
    }
    // Project any not-yet-migrated legacy `state.works` paused entries (e.g. before `adoptLiveWork`
    // or in read-only windows) using the exact same id/timestamp so inbox baselines stay stable.
    for (const [id, lw] of Object.entries(state.works ?? {})) {
      if (!lw || typeof lw !== 'object' || lw.state !== 'paused') continue
      if (seenIds.has(id) || seenIds.has(`handoff:${id}`)) continue
      seenIds.add(id)
      const detail = lw.paused ?? {}
      out.push({
        id,
        ref: lw.ref ?? null,
        from: lw.from ?? null,
        fromName: lw.from ? (nameOf(lw.from) ?? null) : null,
        to: lw.to ?? null,
        toName: lw.to ? (nameOf(lw.to) ?? null) : null,
        reason: detail.reason ?? 'paused',
        kind: detail.kind ?? 'no_progress',
        goal: lw.goal ?? headOf(detail.message ?? detail.text ?? '', 200),
        ...(detail.question ? { question: headOf(detail.question, 200) } : {}),
        ...(detail.bounces !== undefined ? { bounces: detail.bounces } : {}),
        at: typeof detail.at === 'number' ? detail.at : (lw.at ?? 0),
      })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  // Startup sweep for works whose target Bot or group no longer exists.
  function reconcileLostWorks() {
    if (!writableCoordDb()) return
    const active = rt.coordDb.listWorks({ activeOnly: true, limit: 1000 })
    for (const work of active) {
      if (work.kind === 'foreground' || work.originKind === 'request_dedup') continue
      const targetGone = work.roomId ? rt.roomOf(work.roomId) === undefined : rt.botOf(work.botId) === undefined
      if (targetGone) abandonWork(work.workId, 'gone')
    }
  }

  // A deleted Bot answers no more work and waits for none.
  function forgetBot(botId, { onOutgoing } = {}) {
    if (!writableCoordDb() || !botId) return []
    const active = rt.coordDb.listWorks({ botId, activeOnly: true, limit: 500 })
    const waiting = []
    for (const work of active) {
      if (work.originKind === 'request_dedup') continue
      if (work.kind !== 'foreground') waiting.push(askedBy(work.workId))
      rt.coordDb.stopWork(work.workId, { reason: 'Bot was deleted', by: botId, cascadeChildren: false })
    }
    const outgoingCalls = rt.coordDb.listCalls({ status: 'open', limit: 500 })
      .filter(call => call.callerBotId === botId && call.calleeBotId !== botId)
    const outgoing = []
    for (const call of outgoingCalls) {
      const snapshot = cancelWork(call.childWorkId, { by: botId, reason: 'The calling Bot was deleted.' })
      if (snapshot !== undefined) outgoing.push(snapshot)
    }
    if (typeof onOutgoing === 'function') onOutgoing(outgoing)
    void rt.kickScheduler?.().catch(() => {})
    return waiting.filter(Boolean)
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const chat = rt.chatOf(botId)
    const bot = rt.botOf(botId)
    const own = bot === undefined ? [chat] : ownChatSessions(bot)
    const sessions = [...new Set([...own, ...(rt.groupSessionsOf?.(botId) ?? [])])]
    const place = (sessionId) => {
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      if (room) return `in group "${room.name}"`
      const task = rt.taskBySession?.(sessionId)?.task
      if (task !== undefined) return `in background task "${task.title}"`
      return 'in its own chat'
    }
    const forWhom = (sessionId, info) => {
      if (rt.groupOwners.has(sessionId)) return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : ''
      const workId = workOf(info)
      const work = workId ? resolveWork(workId)?.work : undefined
      const asker = info?.role === 'request' || info?.role === 'stopped' ? info.senderSessionId : work?.from
      if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      return info === undefined ? ', for the user' : ''
    }
    const doing = (entry) => {
      const what = rt.doingOf?.(entry) ?? {}
      if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ''}`
      return what.said ? `: "${what.said.slice(0, 100)}"` : ''
    }
    const lines = []
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.botId === botId)
    const switching = [...(rt.switchJobs?.() ?? [])].find(job => job.botId === botId)
    const running = sessions.filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    if (approval !== undefined) lines.push(`waiting for the user's approval to run ${approval.tool || 'a tool'} ${place(approval.sessionId)} (${minutes(approval.at)})`)
    else if (switching !== undefined) lines.push(`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? '?'}"` : 'own chat'}`)
    for (const sessionId of approval === undefined && switching === undefined ? running : []) {
      const entry = rt.live.get(sessionId)
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${forWhom(sessionId, entry.info)}${doing(entry)}`)
    }
    if (hasCoordDb()) {
      const activeWorks = rt.coordDb.listWorks({ botId, activeOnly: true, limit: 100 })
      for (const work of activeWorks) {
        if (work.originKind === 'request_dedup') continue
        if (work.status === 'paused' || work.status === 'needs_verification') {
          lines.push(`paused work ${work.workRef ?? work.workId} (${work.pauseReason ?? work.status}; waiting for the user to continue or cancel)`)
          continue
        }
        const openWaits = rt.coordDb.listWaits({ workId: work.workId, status: 'open', limit: 20 })
        const askWaits = openWaits.filter(w => w.kind === 'ask')
        const callWaits = openWaits.filter(w => w.kind === 'call')
        if (askWaits.length > 0) {
          const target = askWaits[0].targetWorkId ? rt.coordDb.getWork(askWaits[0].targetWorkId) : undefined
          lines.push(`waiting for ${nameOf(target?.botId) ?? 'the caller'} to answer a question on ${work.workRef ?? work.workId}`)
        } else if (callWaits.length > 0 && work.status !== 'running') {
          const names = [...new Set(callWaits.map((w) => {
            const child = w.targetWorkId ? rt.coordDb.getWork(w.targetWorkId) : undefined
            if (child?.roomId) return `group "${rt.roomOf(child.roomId)?.name ?? 'a group'}"`
            return nameOf(child?.botId) ?? child?.title ?? 'a teammate'
          }))]
          lines.push(`waiting for ${names.join(' and ')} to hand back work`)
        }
      }
    }
    if (lines.length === 0) lines.push('idle')
    for (const [kind, card] of [['question', state.questions?.[chat]], ['view', state.views?.[chat]]]) {
      if (card !== undefined) lines.push(`a ${kind} card in its own chat has waited for the user's answer ${forHowLong(card.askedAt)}`)
    }
    if (hasCoordDb()) {
      const fg = rt.coordDb.getForegroundWork(botId)
      if (fg !== undefined) {
        const unread = new Map()
        for (const msg of rt.coordDb.listInbox(fg.workId, { unreadOnly: true, includeNotes: false, limit: 100 })) {
          const name = nameOf(msg.senderBotId)
          if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
        }
        if (unread.size > 0) lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(', ')}`)
      }
    }
    return lines.join('; ')
  }

  // Records a Bot-to-Bot message in `pair-*.jsonl` (consumed by `exchangesOf` / UI history)
  // when messages flow directly through `rt.coordDb` + `rt.kickScheduler()` instead of `rt.deliver()`.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  function recordPairExchange({
    id,
    from,
    to,
    role,
    text,
    sessionId,
    workRef,
    follows,
    length,
    files,
    replyTo,
    audience,
    roomId,
    work,
  }) {
    if (!writes() || typeof rt.ledger?.append !== 'function') return undefined
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '' || from === to) return undefined
    if (rt.botOf(from) === undefined || rt.botOf(to) === undefined) return undefined
    const entryId = typeof id === 'string' && id !== '' ? id : randomUUID()
    const book = pairBook(from, to)
    const now = Date.now()
    rt.ledger.append(book, {
      id: entryId,
      from,
      to,
      role,
      text: String(text ?? ''),
      time: now,
      ...(workRef ? { workRef } : {}),
      ...(follows ? { follows } : {}),
      ...(length !== undefined ? { length, ...(Array.isArray(files) ? { files } : {}) } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(roomId ? { roomId } : {}),
    })
    rt.ledger.append(book, {
      event: 'delivered',
      id: entryId,
      sessionId: sessionId ?? rt.chatOf?.(to),
      time: now,
      ...(typeof work === 'string' && work !== '' ? { work } : {}),
    })
    const written = rt.ledger.written?.(book)
    if (written && typeof written.then === 'function') {
      return written.then(() => entryId)
    }
    return entryId
  }

  // Subagent sub-work lifecycle helpers backed by `coordDb` (`meta.child`).
  const findSubWork = (childId, { activeOnly = false, exclude } = {}) => {
    if (!hasCoordDb() || typeof childId !== 'string' || childId === '') return undefined
    const candidates = rt.coordDb.listWorks({ activeOnly, limit: 500 })
      .filter(w => w.meta?.child === childId && !(exclude?.has?.(w.workId)))
    return candidates.at(-1)
  }
  const settleSubWork = (id, text, child) => {
    const work = findDbWork(id) ?? findSubWork(child, { activeOnly: true }) ?? findSubWork(child, { activeOnly: false })
    if (work === undefined) return undefined
    if (TERMINAL_STATUSES.has(work.status)) {
      const abandoned = takeAbandoned(work.workId)
      if (abandoned !== undefined) {
        const subName = abandoned.name ?? work.apiMeta?.name ?? work.meta?.name ?? work.title ?? 'subagent'
        const parentWork = work.parentWorkId ? rt.coordDb?.getWork?.(work.parentWorkId) : undefined
        const targetBot = abandoned.waiting ?? abandoned.from ?? parentWork?.botId ?? work.botId
        const body = String(text ?? '').trim()
        if (targetBot !== undefined && body !== '' && typeof rt.deliver === 'function') {
          const targetSession = parentWork?.sessionId ?? rt.chatOf?.(targetBot)
          void rt.deliver({
            fromName: subName,
            toId: targetBot,
            ...(targetSession ? { sessionId: targetSession } : {}),
            role: 'reply',
            text: `${LATE_ANSWER}${body}`,
            replyTo: work.workId,
          }).catch(error => rt.warn?.('ds-bot: late subagent answer not sent: %s', error))
        }
      }
      return undefined
    }
    return closeWork(work.workId, work.apiMeta?.name ?? work.meta?.name ?? 'subagent', text, { deliverDirect: true })
  }
  const subWorkRun = (childId, seen) => {
    const work = findSubWork(childId, { activeOnly: false, exclude: seen })
    if (work === undefined) return undefined
    seen?.add?.(work.workId)
    return {
      id: work.workId,
      parent: work.parentWorkId ?? undefined,
      name: work.apiMeta?.name ?? work.meta?.name ?? work.title ?? 'subagent',
    }
  }
  const nameSubWork = (childId, label) => {
    if (!writableCoordDb() || typeof label !== 'string' || label.trim() === '') return
    const work = findSubWork(childId, { activeOnly: true }) ?? findSubWork(childId, { activeOnly: false })
    if (work === undefined) return
    try { rt.coordDb.updateApiMeta?.(work.workId, { name: label.trim() }) } catch {}
  }

  const offWorkSettled = rt.onWorkSettled?.(({ work, outcome, settledCalls, summary, error } = {}) => {
    if (work) void pruneOrphanResultFiles().catch(() => {})
    if (!work || !Array.isArray(settledCalls) || settledCalls.length === 0) return
    const replyText = summary
      || work.resultSummary
      || (outcome === 'failed' ? (error?.message ?? work.error?.message ?? 'Work failed.') : outcome === 'stopped' ? (error?.message ?? 'Work stopped.') : '(no reply text)')
    for (const call of settledCalls) {
      if (!call?.callerBotId || !call?.calleeBotId || call.callerBotId === call.calleeBotId) continue
      ;(rt.recordPairExchange ?? recordPairExchange)({
        id: `reply:${call.callId ?? work.workId}`,
        from: call.calleeBotId,
        to: call.callerBotId,
        role: 'reply',
        text: replyText,
        sessionId: rt.resolveLogicalSession?.(call.returnAddress) ?? rt.chatOf?.(call.callerBotId),
        workRef: work.workRef ?? undefined,
        replyTo: work.workId,
        ...(call.roomId ? { roomId: call.roomId } : {}),
        ...(call.parentWorkId ? { work: call.parentWorkId } : {}),
      })
    }
  })

  const offAdopted = rt.onAdopted?.(() => {
    whole.clear()
    heldAnswers.clear()
    resetWorkRefSeq()
  })
  ctx?.effect?.(() => {
    const timer = setTimeout(() => {
      void (typeof rt.adoptLiveWork === 'function' ? rt.adoptLiveWork() : rt.load())
        .then(() => {
          reconcileLostWorks()
          rt.pruneOrphanRequests?.()
          return pruneOrphanResultFiles()
        })
        .catch(error => rt.warn?.('ds-bot: lost waits not settled: %s', error))
    }, 0)
    timer.unref?.()
    return () => {
      clearTimeout(timer)
      offWorkSettled?.()
      offAdopted?.()
      whole.clear()
      heldAnswers.clear()
      transientImOrigins.clear()
      abandonedCache.clear()
    }
  }, 'ds-bot: lost hand-offs')

  Object.assign(rt, {
    workOf,
    openCall: createCall,
    createCall,
    openWork,
    setWorkTargetSession,
    closeWork,
    dropWork,
    takenWork: taken,
    lateWork,
    answerMissed,
    ownsWork: owns,
    waitsWork: waits,
    holdWork: hold,
    hasHeldWork,
    workAsker: askedBy,
    workImOrigin,
    mergeWorkImOrigin,
    rememberImReplyOrigin,
    imReplyOrigin,
    answerText,
    upstreamOf,
    sameWork,
    forgetBotWork: forgetBot,
    statusOf,
    waitingView,
    pausedWorksView,
    settleSubWork,
    subWorkRun,
    nameSubWork,
    abandonWork,
    abandonedWork: takeAbandoned,
    reconcileLostWorks,
    resolveWork,
    resolveWorkForSession,
    ensureForegroundWorkForBot,
    closedWorkOf,
    workRefOf,
    workStateOf,
    markWorkWorked,
    askBackWork,
    answerWork,
    cancelWork,
    pauseWork,
    resumeWork,
    recordWorkProgress,
    needInputWorksFor,
    openWorksBetween,
    noteWorkCompleted,
    checkPairLoop,
    resetPairLoop,
    resetBotLoops,
    keepResultFile: keepResult,
    readResultFile,
    ...(typeof rt.recordPairExchange === 'function' ? {} : { recordPairExchange }),
  })
}
