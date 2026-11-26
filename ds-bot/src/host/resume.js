// Startup recovery & one-time legacy state migration backed by `coordination.sqlite` and DSH D2.
//
// Replaces the legacy `inflight.json` dual-file persistence and backward event-log guessing.
// Holds `state.lock` (RW) before running migration or reconciliation; read-only windows never
// write to SQLite and never kick the scheduler.
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isWorkTool, STEER_CUT } from './constants.js'
import { textOf } from './text.js'

export const RESUME_DELAY_MS = 3000

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record?.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// Pure session-event helpers retained for diagnostics and unit tests.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], messages: {}, messageSeqs: {}, texts: [], toolCount: 0, reason: undefined, end: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      if (isWorkTool(String(event.data?.name ?? ''))) current.toolCount += 1
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) {
        current.took.push(source)
        current.messages[source.exchangeId] = { content: event.data?.content }
        if (event.seq !== undefined) current.messageSeqs[source.exchangeId] = event.seq
      }
      if (Array.isArray(source?.joined)) {
        for (const item of source.joined) {
          const info = item?.info
          if (info?.exchangeId === undefined) continue
          current.took.push(info)
          if (current.messages[info.exchangeId] === undefined) {
            current.messages[info.exchangeId] = { text: typeof item.text === 'string' ? item.text : '' }
          }
          if (event.seq !== undefined && current.messageSeqs[info.exchangeId] === undefined) {
            current.messageSeqs[info.exchangeId] = event.seq
          }
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') {
      current.reason = event.data?.reason
      current.end = event.seq
    }
  }
  return turns
}

const isSteerCutTurn = turn => turn?.reason?.kind === 'aborted'
  && turn.reason.reason?.kind === 'hook'
  && turn.reason.reason?.reason === STEER_CUT

function chainSteerCuts(turns, startAt) {
  let found = turns[startAt]
  let next = startAt + 1
  const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
  while (isSteerCutTurn(found) && next < turns.length) {
    const follow = turns[next]
    const kept = finished(found)
    found = {
      ...follow,
      took: [...found.took, ...follow.took],
      messages: { ...found.messages, ...follow.messages },
      messageSeqs: { ...found.messageSeqs, ...follow.messageSeqs },
      texts: [...kept, ...follow.texts],
      toolCount: (found.toolCount ?? 0) + (follow.toolCount ?? 0),
      stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length),
    }
    next += 1
  }
  return isSteerCutTurn(found) ? { ...found, texts: finished(found), reason: undefined } : found
}

export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    return chainSteerCuts(turns, at)
  }
  return undefined
}

export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

const readJsonSafe = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

export function install(rt) {
  const { home } = rt
  const inflightPath = join(home, 'inflight.json')
  const apiRunsPath = join(home, 'api-runs.json')
  let adopting = null
  let migratedLegacy = false

  function migrateLegacyToCoordDb() {
    if (migratedLegacy) return false
    if (rt.readOnly?.() !== undefined) return false
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.readonly || coordDb.isClosed()) return false

    const inflight = existsSync(inflightPath) ? readJsonSafe(inflightPath) : undefined
    const apiRuns = existsSync(apiRunsPath) ? readJsonSafe(apiRunsPath) : undefined
    const hasLegacyState = Object.keys(rt.state?.bots ?? {}).length > 0
      || Object.keys(rt.state?.works ?? {}).length > 0
      || Object.keys(rt.state?.roomBatches ?? {}).length > 0
      || Object.keys(rt.state?.roomReports ?? {}).length > 0

    if (!hasLegacyState && !inflight && !apiRuns) {
      migratedLegacy = true
      return false
    }

    coordDb.importLegacyState({
      state: rt.state,
      inflight,
      apiRuns,
    })

    if (existsSync(inflightPath)) {
      try {
        renameSync(inflightPath, `${inflightPath}.migrated`)
      } catch (error) {
        rt.warn?.('ds-bot: backing up migrated inflight.json failed: %s', error?.message ?? error)
      }
    }
    migratedLegacy = true
    return true
  }

  // Single startup/reload reconciler:
  // 1. Adopts live running DSH agents into `turns.js` UI maps (safe in read-only windows too).
  // 2. When holding `state.lock` (RW): runs idempotent legacy migration, ensures foreground works,
  //    reconciles every interrupted work against DSH D2 `queryDeliveryStatus` (never routing
  //    failed/unstarted background tasks into foreground private chat), and kicks the scheduler.
  function adoptLiveWork() {
    if (adopting !== null) return adopting
    adopting = (async () => {
      await rt.load()
      rt.refreshCoordDb?.()
      await rt.adoptLiveTurnMaps?.()

      if (rt.readOnly?.() !== undefined) return
      const coordDb = rt.coordDb
      if (!coordDb || coordDb.readonly || coordDb.isClosed()) return

      migrateLegacyToCoordDb()

      // Ensure every known Bot has its permanent foreground work bound to its latest session.
      for (const [id, bot] of Object.entries(rt.state?.bots ?? {})) {
        if (!bot || typeof bot !== 'object') continue
        const botId = typeof bot.id === 'string' && bot.id !== '' ? bot.id : id
        const fgSession = rt.chatOf?.(botId) ?? bot.sessionId ?? botId
        const { work } = coordDb.ensureForegroundWork({
          botId,
          sessionId: fgSession,
          workspaceDir: bot.workDir,
          privacyScoped: bot.private === true || bot.privacy === true,
        })
        if (fgSession && work.sessionId !== fgSession) {
          coordDb.rebindSession(work.workId, fgSession)
        }
      }

      const interrupted = coordDb.listInterruptedWorks()
      for (const work of interrupted) {
        if (rt.readOnly?.() !== undefined) return
        // Group-relay-managed room_call / room_caller works are reconciled via `groups.js` (`settleRoomBatches`),
        // never requeued into raw `dsh-adapter` dispatch bypassing `group_relay`.
        if (work.kind === 'room_work' && work.originKind === 'group') continue
        const sessionId = rt.resolveLogicalSession?.(work.logicalAddress) ?? work.sessionId
        if (!sessionId) {
          if (work.kind !== 'foreground') {
            const settled = coordDb.settleWork({
              workId: work.workId,
              outcome: 'failed',
              force: true,
              error: { code: 'coordination/session_missing', message: `Session for ${work.logicalAddress} is gone after restart` },
            })
            if (settled.settled) rt.emitWorkSettled?.({ outcome: 'failed', ...settled })
          }
          continue
        }

        const query = work.activeDeliveryKey
          ? { idempotencyKey: work.activeDeliveryKey }
          : (Number.isInteger(work.activeTurn) ? { turn: work.activeTurn } : undefined)

        if (!query) {
          coordDb.requeueInterruptedWork(work.workId, { reason: 'restart_no_delivery_key' })
          continue
        }

        let deliveryStatus
        try {
          deliveryStatus = await rt.queryDeliveryStatus(sessionId, query)
        } catch (error) {
          rt.warn?.('ds-bot: delivery status check for %s failed: %s', work.workId, error?.message ?? error)
          coordDb.pauseWork(work.workId, {
            status: 'needs_verification',
            reason: 'delivery_status_unreadable',
            detail: {
              sessionId,
              query,
              code: error?.code ?? null,
              message: String(error?.message ?? error),
            },
          })
          continue
        }
        const reconciled = coordDb.reconcileDeliveryStatus({
          workId: work.workId,
          deliveryStatus,
          autoSettle: true,
        })
        if (reconciled.action === 'adopt_live') {
          await rt.adoptActiveDelivery?.(reconciled.work ?? work, sessionId, deliveryStatus)
        } else if (reconciled.action === 'settled' || reconciled.action === 'failed' || reconciled.action === 'stopped') {
          if (reconciled.settled) {
            rt.emitWorkSettled?.({
              outcome: reconciled.action === 'settled' ? 'done' : reconciled.action,
              ...reconciled,
            })
          }
        }
      }

      await rt.settleRoomBatches?.()
      await rt.reconcileApiRuns?.()
      await rt.kickScheduler?.()
    })().finally(() => {
      adopting = null
    })
    return adopting
  }

  // Process-local tracker for direct `rt.deliver()` messages (e.g. `role: 'kickoff'`)
  // queued in DSH awaiting `user/message`, so `greetingOut()` / `unreadOf()` stays exact
  // without writing any `inflight.json` file.
  /** @type {Map<string, Map<string, {exchangeId:string, role?:string, work?:string, replyTo?:string}>>} */
  const pendingDirectBySession = new Map()
  /** @type {Map<string, string>} exchangeId -> sessionId */
  const pendingDirectIndex = new Map()

  const notePendingDelivery = (sessionId, entry) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !entry?.exchangeId) return
    let map = pendingDirectBySession.get(sessionId)
    if (map === undefined) pendingDirectBySession.set(sessionId, map = new Map())
    map.set(entry.exchangeId, entry)
    pendingDirectIndex.set(entry.exchangeId, sessionId)
  }

  const forgetDelivery = (exchangeId) => {
    if (typeof exchangeId !== 'string' || exchangeId === '') return
    const sessionId = pendingDirectIndex.get(exchangeId)
    if (sessionId === undefined) return
    pendingDirectIndex.delete(exchangeId)
    const map = pendingDirectBySession.get(sessionId)
    map?.delete(exchangeId)
    if (map !== undefined && map.size === 0) pendingDirectBySession.delete(sessionId)
  }

  const forgetWorkDeliveries = (workId) => {
    if (typeof workId !== 'string' || workId === '') return
    for (const [sessionId, map] of pendingDirectBySession.entries()) {
      for (const [exchangeId, entry] of map.entries()) {
        if (entry.work === workId || entry.exchangeId === workId) {
          map.delete(exchangeId)
          pendingDirectIndex.delete(exchangeId)
        }
      }
      if (map.size === 0) pendingDirectBySession.delete(sessionId)
    }
  }

  // Compatibility helpers backed by `rt.coordDb` + process-local pending direct deliveries (zero `inflight.json`).
  const hasPendingRecovery = (sessionId) => {
    if (!sessionId) return false
    if ((pendingDirectBySession.get(sessionId)?.size ?? 0) > 0) return true
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.isClosed()) return false
    const work = coordDb.getWorkBySessionId(sessionId)
    if (!work) return false
    return work.status === 'queued' || work.status === 'running' || work.activeDeliveryKey !== null
  }
  const hasPendingTaskReport = (taskId) => {
    if (!taskId) return false
    for (const map of pendingDirectBySession.values()) {
      for (const entry of map.values()) {
        if (entry.role === 'task-report' && (entry.taskId === taskId || entry.exchangeId === `task-report:${taskId}`)) {
          return true
        }
      }
    }
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.isClosed()) return false
    const work = coordDb.getWork(`task:${taskId}`) ?? coordDb.getWork(taskId)
    if (!work) return false
    return coordDb.listCalls({ childWorkId: work.workId, deliveryStatus: 'pending' }).length > 0
  }
  const unreadOf = (sessionId) => {
    if (!sessionId) return []
    const out = []
    const direct = pendingDirectBySession.get(sessionId)
    if (direct !== undefined) {
      for (const entry of direct.values()) out.push(entry)
    }
    const coordDb = rt.coordDb
    if (coordDb && !coordDb.isClosed()) {
      const work = coordDb.getWorkBySessionId(sessionId)
      if (work) {
        for (const msg of coordDb.listInbox(work.workId, { unreadOnly: true, includeNotes: false })) {
          out.push({
            ...msg,
            role: msg.payload?.role ?? msg.kind,
          })
        }
      }
    }
    return out
  }

  Object.assign(rt, {
    adoptLiveWork,
    migrateLegacyToCoordDb,
    hasPendingRecovery,
    hasPendingTaskReport,
    unreadOf,
    notePendingDelivery,
    forgetDelivery,
    forgetWorkDeliveries,
  })
}
