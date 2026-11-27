// Unified Run coordinator for the external API:
// Maps external `/v1` Runs directly onto `rt.coordDb` (`works(api_run_id)` + `waits` +
// `api_idempotency_key`), without maintaining a duplicate `api-runs.json` state machine,
// duplicate session/room/task index maps, or polling timers.
//   queued -> running -> waiting_human -> running -> completed | stopped | failed
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateViewAnswer } from 'deep-view/core'
import { HANDOFF_ACK } from '../constants.js'
import { viewReply } from '../parts.js'
import { textOf } from '../text.js'
import { turnFailure } from '../turns.js'
import { usageChunk } from '../usage.js'

const EVENT_BUFFER_MAX = 400
const IDEMPOTENCY_MAX_LEN = 200
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed'])

const isTerminal = status => TERMINAL_STATUSES.has(status)
const newRunId = () => `run_${randomBytes(6).toString('hex')}`
const newFileRef = () => `file_${randomBytes(8).toString('hex')}`
const workIdOf = runId => `api:${runId}`

function toIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function fingerprintOf(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function outcomeOfRunStatus(status) {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  return 'stopped'
}

export function createRunCoordinator(rt, auth) {
  const { ctx, state } = rt

  // Live in-memory handles for active/tailing SSE runs, request matching, file refs, and UI badges.
  const active = new Map() // runId -> LiveTracker
  const byRequestId = new Map() // requestId -> runId
  const inflightIdem = new Map() // scopedIdemKey -> { fingerprint, record }
  const pendingGroupLaunches = new Set() // trackers waiting for a busy room to become idle
  let pendingLaunchTimer = null
  const files = new Map() // fileRef -> { kind, sessionId, botId, roomId, seq, index, attachmentId, name, mime, size }

  // Fallback in-memory stores used ONLY when `rt.coordDb` is unavailable (e.g. isolated unit tests).
  const memRuns = new Map()
  const memIdem = new Map()

  // API-originated user messages, keyed by sessionId -> { [seq]: tokenName }, for chat UI badges.
  const apiVia = new Map()
  let reconciled = false
  let disposed = false

  const writes = () => rt.readOnly?.() === undefined
  const readableDb = () => (typeof rt.existingCoordDb === 'function' ? rt.existingCoordDb() : (rt.coordDb && !rt.coordDb.isClosed?.() ? rt.coordDb : null))
  const writableDb = () => (writes() && rt.coordDb && !rt.coordDb.readonly && !rt.coordDb.isClosed?.() ? rt.coordDb : null)

  function serializeMeta(record, extra = {}) {
    return {
      runId: record.runId,
      tokenId: record.tokenId,
      tokenName: record.tokenName,
      target: record.target,
      mode: record.mode,
      runStatus: record.status,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      finishedAtMs: record.finishedAtMs,
      sessionId: record.sessionId,
      partId: record.partId,
      taskId: record.taskId,
      output: record.output,
      pendingAction: record.pendingAction,
      usage: record.usage,
      error: record.error,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(record.idempotencyFingerprint !== undefined ? { idempotencyFingerprint: record.idempotencyFingerprint } : {}),
      ...extra,
    }
  }

  function recordFromWork(work) {
    if (!work || !work.apiRunId) return undefined
    const live = active.get(work.apiRunId)
    if (live !== undefined) return live.run
    const meta = work.apiMeta && typeof work.apiMeta === 'object' ? work.apiMeta : {}
    let status = meta.runStatus
    if (work.status === 'done') status = 'completed'
    else if (work.status === 'failed') status = 'failed'
    else if (work.status === 'stopped') status = 'stopped'
    else if (work.status === 'needs_verification' || work.status === 'paused') status = 'needs_verification'
    else if (typeof status !== 'string') status = 'queued'
    return {
      runId: work.apiRunId,
      tokenId: meta.tokenId ?? null,
      tokenName: meta.tokenName ?? null,
      target: meta.target ?? {
        kind: work.roomId ? 'group' : 'bot',
        id: work.roomId ?? work.botId ?? '',
        name: work.title ?? '',
      },
      mode: meta.mode ?? 'chat',
      status,
      createdAtMs: typeof meta.createdAtMs === 'number' ? meta.createdAtMs : work.createdAt,
      startedAtMs: typeof meta.startedAtMs === 'number' ? meta.startedAtMs : work.startedAt,
      finishedAtMs: typeof meta.finishedAtMs === 'number' ? meta.finishedAtMs : work.finishedAt,
      sessionId: meta.sessionId ?? work.sessionId ?? null,
      partId: meta.partId ?? meta.sessionId ?? work.sessionId ?? null,
      taskId: meta.taskId ?? null,
      output: meta.output ?? { text: work.resultSummary ?? '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
      pendingAction: isTerminal(status) ? null : (meta.pendingAction ?? null),
      usage: meta.usage ?? { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
      error: meta.error ?? work.error ?? null,
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(meta.idempotencyFingerprint !== undefined ? { idempotencyFingerprint: meta.idempotencyFingerprint } : {}),
    }
  }

  function persistCreateWork(record, { idempotencyKey = null, idempotencyFingerprint, inputText = '', attachmentCount = 0 } = {}) {
    if (idempotencyFingerprint !== undefined) record.idempotencyFingerprint = idempotencyFingerprint
    const db = writableDb()
    if (!db) {
      memRuns.set(record.runId, record)
      if (idempotencyKey) memIdem.set(idempotencyKey, { fingerprint: idempotencyFingerprint, runId: record.runId, createdAt: record.createdAtMs })
      return
    }
    const wid = workIdOf(record.runId)
    db.transaction(() => {
      const existing = db.getWork(wid)
      if (existing !== undefined) {
        db.updateApiMeta(wid, serializeMeta(record))
        return
      }
      // Persist the API work, its Idempotency-Key, and its initial request input atomically
      // BEFORE any side-effecting dispatch (`startTask` / `sendUser` / group launch) so a
      // crash in between never drops the Run or permits duplicate execution on client retry.
      db.createWork({
        workId: wid,
        kind: record.target.kind === 'group' ? 'room_work' : 'task',
        botId: record.target.kind === 'bot' ? record.target.id : `group:${record.target.id}`,
        roomId: record.target.kind === 'group' ? record.target.id : null,
        sessionId: null,
        logicalAddress: wid,
        status: 'idle',
        originKind: 'api',
        apiRunId: record.runId,
        apiIdempotencyKey: idempotencyKey,
        apiMeta: serializeMeta(record),
        title: record.target.name || record.runId,
      })
      if (inputText !== '' || attachmentCount > 0) {
        db.receiveMessage({
          workId: wid,
          kind: 'request',
          dedupKey: `api-input:${record.runId}`,
          senderAddress: `api:${record.tokenId ?? 'unknown'}`,
          bodyPreview: inputText.slice(0, 400),
          payload: { text: inputText, attachmentCount },
          dshIdempotencyKey: `api:${record.tokenId ?? 'unknown'}:${record.runId}`,
          wake: false,
        })
      }
    })
  }

  function syncWorkMeta(record) {
    const db = writableDb()
    if (!db) {
      memRuns.set(record.runId, record)
      return
    }
    const wid = workIdOf(record.runId)
    try {
      if (db.getWork(wid) !== undefined) {
        db.updateApiMeta(wid, serializeMeta(record))
      }
    } catch { /* best-effort */ }
  }

  function settlePersistedWork(record) {
    const db = writableDb()
    if (!db) {
      memRuns.set(record.runId, record)
      return
    }
    const wid = workIdOf(record.runId)
    try {
      db.transaction(() => {
        if (db.getWork(wid) === undefined) {
          db.createWork({
            workId: wid,
            kind: record.target.kind === 'group' ? 'room_work' : 'task',
            botId: record.target.kind === 'bot' ? record.target.id : `group:${record.target.id}`,
            roomId: record.target.kind === 'group' ? record.target.id : null,
            sessionId: null,
            logicalAddress: wid,
            status: 'idle',
            originKind: 'api',
            apiRunId: record.runId,
            apiIdempotencyKey: null,
            apiMeta: serializeMeta(record),
            title: record.target.name || record.runId,
          })
        } else {
          db.updateApiMeta(wid, serializeMeta(record))
        }
        db.settleWork({
          workId: wid,
          outcome: outcomeOfRunStatus(record.status),
          force: true,
          summary: record.output?.text ? record.output.text.slice(0, 500) : null,
          error: record.error,
        })
      })
    } catch (error) {
      rt.warn?.('ds-bot: failed to settle API run %s: %s', record.runId, error?.message ?? error)
    }
  }

  function loadRunRecord(runId) {
    if (!reconciled) reconcileInterruptedApiRuns()
    const id = String(runId ?? '')
    const live = active.get(id)
    if (live !== undefined) return live.run
    const db = readableDb()
    if (db) {
      try {
        const work = db.getWorkByApiRunId(id)
        if (work !== undefined) return recordFromWork(work)
      } catch { /* fall through */ }
    }
    return memRuns.get(id)
  }

  function listAllRunRecords() {
    if (!reconciled) reconcileInterruptedApiRuns()
    const byId = new Map()
    const db = readableDb()
    if (db) {
      try {
        const works = db.listWorks({ limit: 1_000 })
        for (const work of works) {
          if (work.apiRunId === null) continue
          const rec = recordFromWork(work)
          if (rec !== undefined) byId.set(rec.runId, rec)
        }
      } catch { /* fall through */ }
    }
    for (const [id, rec] of memRuns) {
      if (!byId.has(id)) byId.set(id, rec)
    }
    for (const [id, tracker] of active) {
      byId.set(id, tracker.run)
    }
    return [...byId.values()]
  }

  // One-time idempotent migration of legacy `api-runs.json` into `rt.coordDb`, followed
  // by settling any in-flight API runs left over from a previous host process.
  function migrateLegacyApiRuns() {
    const legacyPath = join(rt.home, 'api-runs.json')
    if (!existsSync(legacyPath)) return
    let saved
    try { saved = JSON.parse(readFileSync(legacyPath, 'utf8')) } catch { return }
    if (!saved || typeof saved !== 'object') return
    const idemByRun = new Map()
    if (Array.isArray(saved.idempotency)) {
      for (const pair of saved.idempotency) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1].runId === 'string') {
          idemByRun.set(pair[1].runId, { key: pair[0], fingerprint: pair[1].fingerprint })
        }
      }
    }
    const now = Date.now()
    const restartErr = { code: 'api/host-restarted', message: 'Host restarted before the run completed' }
    if (Array.isArray(saved.runs)) {
      for (const item of saved.runs) {
        if (!item || typeof item.runId !== 'string') continue
        let status = item.status ?? 'stopped'
        let finishedAtMs = typeof item.finishedAtMs === 'number' ? item.finishedAtMs : (item.finishedAt ? Date.parse(item.finishedAt) : null)
        let error = item.error ?? null
        if (!isTerminal(status)) {
          status = 'stopped'
          finishedAtMs = now
          error = restartErr
        }
        const idem = idemByRun.get(item.runId)
        const rec = {
          runId: item.runId,
          tokenId: item.tokenId ?? null,
          tokenName: item.tokenName ?? null,
          target: item.target ?? { kind: 'bot', id: '', name: '' },
          mode: item.mode ?? 'chat',
          status,
          createdAtMs: typeof item.createdAtMs === 'number' ? item.createdAtMs : (Date.parse(item.createdAt) || now),
          startedAtMs: typeof item.startedAtMs === 'number' ? item.startedAtMs : (item.startedAt ? Date.parse(item.startedAt) : null),
          finishedAtMs,
          sessionId: item.sessionId ?? null,
          partId: item.partId ?? null,
          taskId: item.taskId ?? null,
          output: item.output ?? { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
          pendingAction: null,
          usage: item.usage ?? { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
          error,
          ...(idem?.fingerprint !== undefined ? { idempotencyFingerprint: idem.fingerprint } : {}),
        }
        persistCreateWork(rec, { idempotencyKey: idem?.key ?? null, idempotencyFingerprint: idem?.fingerprint })
        settlePersistedWork(rec)
      }
    }
    if (writes()) {
      try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* best-effort */ }
    }
  }

  let asyncReconciled = false

  function findLinkedTaskWork(db, rec) {
    if (rec.mode !== 'task') return undefined
    const works = db.listWorks({ limit: 1_000 })
    return works.find(w => w.apiRunId === null && (
      w.meta?.apiRunId === rec.runId
      || (rec.taskId && w.meta?.taskId === rec.taskId)
    ))
  }

  function applyLinkedTaskState(db, apiWork, rec, linked, now) {
    const restartErr = { code: 'api/host-restarted', message: 'Host restarted before the run completed' }
    if (!linked) {
      rec.status = 'stopped'
      rec.finishedAtMs = now
      rec.pendingAction = null
      rec.error = restartErr
      db.updateApiMeta(apiWork.workId, serializeMeta(rec))
      db.settleWork({ workId: apiWork.workId, outcome: 'stopped', force: true, error: restartErr })
      return
    }
    rec.taskId = linked.meta?.taskId ?? rec.taskId
    rec.sessionId = linked.sessionId ?? rec.sessionId
    rec.partId = rec.sessionId
    if (linked.status === 'done') {
      rec.status = 'completed'
      rec.finishedAtMs = linked.finishedAt ?? now
      rec.pendingAction = null
      rec.error = null
      if (linked.resultSummary && !rec.output.text) rec.output.text = linked.resultSummary
      db.updateApiMeta(apiWork.workId, serializeMeta(rec))
      db.settleWork({ workId: apiWork.workId, outcome: 'done', force: true, summary: rec.output.text.slice(0, 500) || null })
      return
    }
    if (linked.status === 'failed') {
      rec.status = 'failed'
      rec.finishedAtMs = linked.finishedAt ?? now
      rec.pendingAction = null
      rec.error = linked.error ?? { code: 'task/failed', message: 'Linked background task failed' }
      db.updateApiMeta(apiWork.workId, serializeMeta(rec))
      db.settleWork({ workId: apiWork.workId, outcome: 'failed', force: true, error: rec.error })
      return
    }
    if (linked.status === 'stopped') {
      rec.status = 'stopped'
      rec.finishedAtMs = linked.finishedAt ?? now
      rec.pendingAction = null
      rec.error = linked.error ?? restartErr
      db.updateApiMeta(apiWork.workId, serializeMeta(rec))
      db.settleWork({ workId: apiWork.workId, outcome: 'stopped', force: true, error: rec.error })
      return
    }
    // Linked task is STILL active in coordination.sqlite (queued / running / waiting / paused / needs_verification):
    // NEVER falsely claim the API Run stopped.
    rec.status = (linked.status === 'paused' || linked.status === 'needs_verification') ? 'needs_verification' : 'running'
    rec.error = linked.status === 'needs_verification'
      ? { code: 'api/needs-verification', message: `Linked background task needs verification (${linked.pauseReason ?? 'interrupted'})` }
      : null
    db.updateApiMeta(apiWork.workId, serializeMeta(rec))
    if (linked.status === 'needs_verification') {
      db.pauseWork(apiWork.workId, {
        status: 'needs_verification',
        reason: linked.pauseReason ?? 'linked_task_needs_verification',
        detail: { linkedWorkId: linked.workId },
      })
    }
  }

  // Synchronous startup reconciliation:
  // - Task-mode API Runs reconcile honestly against their linked task work in `coordination.sqlite`
  //   (preserving live/completed/needs_verification state instead of blindly marking stopped).
  // - Chat/group API Runs with no D2 query hook fall back to `stopped(api/host-restarted)`;
  //   when D2 `rt.queryDeliveryStatus` is present, non-terminal chat Runs wait for async D2 check
  //   (showing `needs_verification` rather than falsely claiming `stopped`).
  function reconcileInterruptedApiRuns() {
    if (typeof rt.hasExistingCoordDb === 'function' && !rt.hasExistingCoordDb() && !existsSync(join(rt.home, 'api-runs.json'))) {
      return
    }
    const db = writableDb()
    if (!db) return
    reconciled = true
    migrateLegacyApiRuns()
    try {
      const stale = db.listWorks({ activeOnly: true, limit: 1_000 }).filter(w => w.apiRunId !== null && !active.has(w.apiRunId))
      if (stale.length === 0) return
      const now = Date.now()
      const err = { code: 'api/host-restarted', message: 'Host restarted before the run completed' }
      const hasD2 = typeof rt.queryDeliveryStatus === 'function'
      db.transaction(() => {
        for (const work of stale) {
          if (work.status === 'needs_verification' || work.status === 'paused') continue
          const rec = recordFromWork(work)
          if (!rec || isTerminal(rec.status)) continue
          if (rec.mode === 'task') {
            const linked = findLinkedTaskWork(db, rec)
            applyLinkedTaskState(db, work, rec, linked, now)
            continue
          }
          if (hasD2 && !asyncReconciled && rec.target.kind === 'bot' && rec.sessionId && rec.requestId) {
            // Defer final classification to async D2 verification rather than fabricating `stopped`.
            rec.status = 'needs_verification'
            rec.error = { code: 'api/needs-verification', message: 'Host restarted; verifying delivery status' }
            db.updateApiMeta(work.workId, serializeMeta(rec))
            continue
          }
          rec.status = 'stopped'
          rec.finishedAtMs = now
          rec.pendingAction = null
          rec.error = err
          db.updateApiMeta(work.workId, serializeMeta(rec))
          db.settleWork({ workId: work.workId, outcome: 'stopped', force: true, error: err })
        }
      })
    } catch { /* best-effort */ }
  }

  // Async startup reconciliation called from `resume.js` (`adoptLiveWork`):
  // Queries cold DSH D2 `queryDeliveryStatus` for interrupted chat-mode API Runs and refreshes
  // task-mode linkage so clients see honest final/needs_verification status instead of fake `stopped`.
  async function reconcileInterruptedApiRunsAsync() {
    if (typeof rt.hasExistingCoordDb === 'function' && !rt.hasExistingCoordDb() && !existsSync(join(rt.home, 'api-runs.json'))) {
      return
    }
    const db = writableDb()
    if (!db) return
    if (!reconciled) reconcileInterruptedApiRuns()
    asyncReconciled = true
    const stale = db.listWorks({ activeOnly: true, limit: 1_000 }).filter(w => w.apiRunId !== null && !active.has(w.apiRunId))
    const now = Date.now()
    const restartErr = { code: 'api/host-restarted', message: 'Host restarted before the run completed' }
    for (const work of stale) {
      const rec = recordFromWork(work)
      if (!rec || isTerminal(rec.status)) continue
      if (rec.mode === 'task') {
        db.transaction(() => {
          const fresh = db.getWork(work.workId)
          if (!fresh || fresh.status === 'done' || fresh.status === 'failed' || fresh.status === 'stopped') return
          const linked = findLinkedTaskWork(db, rec)
          applyLinkedTaskState(db, fresh, rec, linked, now)
        })
        continue
      }
      if (rec.target.kind === 'bot' && rec.sessionId && rec.requestId && typeof rt.queryDeliveryStatus === 'function') {
        let deliveryStatus
        try {
          deliveryStatus = await rt.queryDeliveryStatus(rec.sessionId, { idempotencyKey: rec.requestId })
        } catch (error) {
          const detailErr = { code: 'api/needs-verification', message: `Delivery status unreadable after restart: ${String(error?.message ?? error).slice(0, 240)}` }
          rec.status = 'needs_verification'
          rec.error = detailErr
          db.transaction(() => {
            db.updateApiMeta(work.workId, serializeMeta(rec))
            db.pauseWork(work.workId, { status: 'needs_verification', reason: 'delivery_status_unreadable', detail: { sessionId: rec.sessionId } })
          })
          continue
        }
        if (deliveryStatus?.status === 'completed' && deliveryStatus?.yielded !== true) {
          rec.status = 'completed'
          rec.finishedAtMs = now
          rec.pendingAction = null
          rec.error = null
          const text = String(deliveryStatus.assistantText ?? '').trim()
          if (text !== '' && !rec.output.text) rec.output.text = text
          db.transaction(() => {
            db.updateApiMeta(work.workId, serializeMeta(rec))
            db.settleWork({ workId: work.workId, outcome: 'done', force: true, summary: rec.output.text.slice(0, 500) || null })
          })
          continue
        }
        if (deliveryStatus?.status === 'failed') {
          rec.status = 'failed'
          rec.finishedAtMs = now
          rec.pendingAction = null
          rec.error = { code: 'bot/turn-failed', message: String(deliveryStatus.error ?? 'Turn failed before restart') }
          db.transaction(() => {
            db.updateApiMeta(work.workId, serializeMeta(rec))
            db.settleWork({ workId: work.workId, outcome: 'failed', force: true, error: rec.error })
          })
          continue
        }
        if (deliveryStatus?.status === 'not_found') {
          rec.status = 'stopped'
          rec.finishedAtMs = now
          rec.pendingAction = null
          rec.error = restartErr
          db.transaction(() => {
            db.updateApiMeta(work.workId, serializeMeta(rec))
            db.settleWork({ workId: work.workId, outcome: 'stopped', force: true, error: restartErr })
          })
          continue
        }
        // Consumed / interrupted / queued / running / yielded: NEVER falsely claim stopped.
        const reason = Array.isArray(deliveryStatus?.interruptedTools) && deliveryStatus.interruptedTools.length > 0
          ? 'interrupted_tools'
          : (deliveryStatus?.yielded === true ? 'yielded_before_restart' : 'interrupted_delivery')
        rec.status = 'needs_verification'
        rec.pendingAction = null
        rec.error = {
          code: 'api/needs-verification',
          message: `Run delivery requires verification after restart (${deliveryStatus?.status ?? 'unknown'})`,
        }
        db.transaction(() => {
          db.updateApiMeta(work.workId, serializeMeta(rec))
          db.pauseWork(work.workId, {
            status: 'needs_verification',
            reason,
            detail: {
              sessionId: rec.sessionId,
              deliveryStatus: deliveryStatus?.status ?? null,
              interruptedTools: deliveryStatus?.interruptedTools ?? [],
            },
          })
        })
        continue
      }
      rec.status = 'stopped'
      rec.finishedAtMs = now
      rec.pendingAction = null
      rec.error = restartErr
      db.transaction(() => {
        db.updateApiMeta(work.workId, serializeMeta(rec))
        db.settleWork({ workId: work.workId, outcome: 'stopped', force: true, error: restartErr })
      })
    }
  }

  // Reactive active-tracker helpers (no duplicate bySession/byRoom/byTaskId index maps).
  const activeGroupTrackers = (roomId) => {
    const out = []
    for (const tracker of active.values()) {
      if (!isTerminal(tracker.run.status) && tracker.dispatched !== false
        && tracker.run.target.kind === 'group' && tracker.run.target.id === roomId) {
        out.push(tracker)
      }
    }
    return out
  }
  const hasAnyActiveGroupTracker = () => {
    for (const tracker of active.values()) {
      if (!isTerminal(tracker.run.status) && tracker.dispatched !== false && tracker.run.target.kind === 'group') return true
    }
    return pendingGroupLaunches.size > 0
  }
  const activeSessionTrackers = (sid) => {
    const out = []
    for (const tracker of active.values()) {
      if (!isTerminal(tracker.run.status) && tracker.sessions.has(sid)) out.push(tracker)
    }
    return out
  }
  const activeTaskTracker = (taskId) => {
    if (!taskId) return undefined
    for (const tracker of active.values()) {
      if (!isTerminal(tracker.run.status) && tracker.run.taskId === taskId) return tracker
    }
    return undefined
  }

  let offFeed = null
  const syncRoomFeedTap = () => {
    const need = hasAnyActiveGroupTracker()
    if (need && offFeed === null) {
      offFeed = rt.feedTap?.((event, data) => {
        if (event === 'room' && data?.roomId) {
          tryPendingGroupLaunches(data.roomId)
          for (const tracker of activeGroupTrackers(data.roomId)) {
            tracker.roomHeardActivity = true
            syncRoomLines(tracker)
            scheduleGroupSettleCheck(tracker)
          }
        }
      }) ?? null
    } else if (!need && offFeed !== null) {
      offFeed()
      offFeed = null
    }
  }

  function registerFile(descriptor) {
    const ref = newFileRef()
    files.set(ref, descriptor)
    while (files.size > 4_000) files.delete(files.keys().next().value)
    return ref
  }

  function getFileDescriptor(fileRef) {
    return files.get(String(fileRef ?? ''))
  }

  function toPublicView(record) {
    return {
      runId: record.runId,
      target: { ...record.target },
      mode: record.mode,
      status: record.status,
      createdAt: toIso(record.createdAtMs),
      startedAt: toIso(record.startedAtMs),
      finishedAt: toIso(record.finishedAtMs),
      sessionId: record.sessionId,
      partId: record.partId,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      output: {
        text: record.output.text ?? '',
        truncated: record.output.truncated === true,
        fullFileRef: record.output.fullFileRef ?? null,
        messages: [...(record.output.messages ?? [])],
        deliverables: [...(record.output.deliverables ?? [])],
      },
      pendingAction: record.pendingAction ? { ...record.pendingAction } : null,
      usage: { ...record.usage },
      error: record.error ? { ...record.error } : null,
    }
  }

  function emitRunEvent(tracker, type, data) {
    tracker.eventSeq += 1
    const entry = { id: `${tracker.run.runId}:${tracker.eventSeq}`, event: type, data: { runId: tracker.run.runId, ...data } }
    tracker.events.push(entry)
    if (tracker.events.length > EVENT_BUFFER_MAX) tracker.events.shift()
    for (const listener of tracker.listeners) {
      try { listener(entry) } catch { /* isolate subscriber errors */ }
    }
    rt.apiEmitGlobal?.(type, {
      runId: tracker.run.runId,
      target: tracker.run.target,
      ...data,
    })
  }

  function wakeWaiters(tracker) {
    const status = tracker.run.status
    if (!isTerminal(status) && status !== 'waiting_human') return
    const waiters = tracker.waiters.splice(0, tracker.waiters.length)
    for (const resolve of waiters) resolve(toPublicView(tracker.run))
  }

  function finishRun(tracker, status, { error = null, text } = {}) {
    const { run } = tracker
    if (isTerminal(run.status)) return
    pendingGroupLaunches.delete(tracker)
    if (typeof text === 'string' && text.trim() !== '' && run.output.text.trim() === '') {
      run.output.text = text.trim()
    }
    if (run.output.text.trim() === '' && run.output.messages.length > 0) {
      run.output.text = run.output.messages.map(msg => msg.text).filter(Boolean).join('\n\n')
    }
    run.status = status
    run.finishedAtMs = Date.now()
    run.pendingAction = null
    run.error = error
    tracker.releaseSlot?.()
    tracker.releaseSlot = null

    byRequestId.delete(tracker.requestId)
    syncRoomFeedTap()
    settlePersistedWork(run)

    emitRunEvent(tracker, `run.${status}`, {
      status,
      output: run.output,
      usage: run.usage,
      error: run.error,
    })
    wakeWaiters(tracker)
    // Keep tracker briefly for tail SSE readers, then drop active handle.
    setTimeout(() => { active.delete(run.runId) }, 30_000).unref?.()
    if (run.target.kind === 'group') tryPendingGroupLaunches(run.target.id)
  }

  function setWaitingHuman(tracker, action) {
    const { run } = tracker
    if (isTerminal(run.status)) return
    run.status = 'waiting_human'
    run.pendingAction = action
    syncWorkMeta(run)
    emitRunEvent(tracker, 'human.required', { pendingAction: action })
    wakeWaiters(tracker)
  }

  function clearWaitingHuman(tracker) {
    const { run } = tracker
    if (run.status !== 'waiting_human') return
    run.status = 'running'
    run.pendingAction = null
    syncWorkMeta(run)
    emitRunEvent(tracker, 'run.resumed', { status: 'running' })
  }

  function approvalActionOf(entry) {
    const isPrivacyApproval = rt.isPrivacyApproval?.(entry.id) === true
    return {
      kind: 'approval',
      actionId: entry.id,
      botId: entry.botId,
      sessionId: entry.sessionId,
      summary: `${entry.tool || 'tool'}${entry.reason ? `: ${entry.reason}` : ''}`,
      options: ['allow', 'reject'],
      canRespondViaApi: entry.answerable === true && !isPrivacyApproval,
    }
  }

  // Inspects whether a Bot/session/room currently has any open human-interaction card
  // by reading `rt.coordDb` `waits` alongside live host card state.
  function detectPendingAction(tracker) {
    if (tracker.dispatched === false) return null
    const { run } = tracker
    const botId = run.target.kind === 'bot' ? run.target.id : undefined
    const roomId = run.target.kind === 'group' ? run.target.id : undefined
    const sessionIds = [...tracker.sessions]

    // 1. Open tool approvals (live view, preserving privacy check)
    const approvals = rt.approvalsView?.() ?? []
    for (const entry of approvals) {
      const match = roomId !== undefined
        ? entry.roomId === roomId
        : (sessionIds.includes(entry.sessionId) || (run.taskId && entry.taskId === run.taskId))
      if (!match) continue
      return approvalActionOf(entry)
    }

    // 2. Open ask_user question cards
    for (const sid of sessionIds) {
      const q = rt.own(state.questions, sid)
      if (q !== undefined) {
        return {
          kind: 'question',
          actionId: q.id,
          botId: botId ?? rt.chatOwners.get(sid) ?? null,
          sessionId: sid,
          summary: String(q.question ?? q.title ?? 'Bot asked a question'),
          ...(Array.isArray(q.options) ? { options: q.options } : {}),
          canRespondViaApi: true,
        }
      }
    }

    // 3. Open show_view interactive cards
    for (const sid of sessionIds) {
      const v = rt.own(state.views, sid)
      if (v !== undefined) {
        return {
          kind: 'view',
          actionId: v.id,
          botId: botId ?? rt.chatOwners.get(sid) ?? null,
          sessionId: sid,
          summary: String(v.title ?? 'Bot shared an interactive view'),
          canRespondViaApi: true,
        }
      }
    }

    // 4. Secret request cards (never answerable via API; supports both array-by-botId and object-by-sessionId shapes)
    for (const sid of sessionIds) {
      const raw = rt.own(state.secretRequests, sid)
      if (raw !== undefined) {
        const s = Array.isArray(raw) ? raw.find(item => item?.status === 'pending') : raw
        if (s !== undefined) {
          return {
            kind: 'secret',
            actionId: String(s.id ?? s.name ?? sid),
            botId: botId ?? rt.chatOwners.get(sid) ?? null,
            sessionId: sid,
            summary: `Bot requested secret "${s.name ?? ''}" — complete on computer or phone`,
            canRespondViaApi: false,
          }
        }
      }
    }
    if (botId !== undefined) {
      const byBot = rt.own(state.secretRequests, botId)
      const pendingSecret = Array.isArray(byBot)
        ? byBot.find(item => item?.status === 'pending' && (item.sessionId === undefined || sessionIds.includes(item.sessionId)))
        : (byBot && typeof byBot === 'object' ? byBot : undefined)
      if (pendingSecret !== undefined) {
        return {
          kind: 'secret',
          actionId: String(pendingSecret.id ?? pendingSecret.name ?? botId),
          botId,
          sessionId: pendingSecret.sessionId ?? run.sessionId,
          summary: `Bot requested secret "${pendingSecret.name ?? ''}" — complete on computer or phone`,
          canRespondViaApi: false,
        }
      }
    }

    // 5. Open coordination-db waits (`approval` / `secret` / `user_question`)
    const db = readableDb()
    if (db) {
      try {
        const openWaits = db.listWaits({ status: 'open', limit: 200 })
        for (const wait of openWaits) {
          if (wait.kind !== 'approval' && wait.kind !== 'secret' && wait.kind !== 'user_question') continue
          const meta = wait.meta ?? {}
          const match = roomId !== undefined
            ? meta.roomId === roomId
            : (sessionIds.includes(meta.sessionId)
              || (run.taskId && (meta.taskId === run.taskId || wait.workId === `task:${run.taskId}`)))
          if (!match) continue
          if (wait.kind === 'approval') {
            const approvalId = String(meta.approvalId ?? (wait.targetId.startsWith('approval:') ? wait.targetId.slice(9) : wait.waitId))
            const isPrivacy = meta.privacy === true || rt.isPrivacyApproval?.(approvalId) === true
            return {
              kind: 'approval',
              actionId: approvalId,
              botId: meta.botId ?? botId ?? null,
              sessionId: meta.sessionId ?? run.sessionId,
              summary: `${meta.tool || 'tool'}${meta.reason ? `: ${meta.reason}` : ''}`,
              options: ['allow', 'reject'],
              canRespondViaApi: !isPrivacy && rt.approvalById?.(approvalId)?.answer !== undefined,
            }
          }
          if (wait.kind === 'secret') {
            return {
              kind: 'secret',
              actionId: String(meta.requestId ?? wait.targetId),
              botId: meta.botId ?? botId ?? null,
              sessionId: meta.sessionId ?? run.sessionId,
              summary: `Bot requested secret "${meta.name ?? ''}" — complete on computer or phone`,
              canRespondViaApi: false,
            }
          }
          if (wait.kind === 'user_question') {
            const isView = meta.cardKind === 'view' || wait.targetId.startsWith('view:')
            const actionId = String(meta.questionId ?? meta.viewId ?? meta.cardId ?? wait.targetId.replace(/^(?:question|view):/, ''))
            return {
              kind: isView ? 'view' : 'question',
              actionId,
              botId: meta.botId ?? botId ?? null,
              sessionId: meta.sessionId ?? run.sessionId,
              summary: isView ? 'Bot shared an interactive view' : 'Bot asked a question',
              canRespondViaApi: true,
            }
          }
        }
      } catch { /* best-effort */ }
    }

    // 6. Browser hold / handoff (never answerable via API)
    if (botId !== undefined) {
      const hold = rt.browserChannel?.holdOf?.(botId)
      if (hold && hold.by !== 'user') {
        return {
          kind: 'browser_hold',
          actionId: String(hold.callId ?? botId),
          botId,
          sessionId: hold.sessionId ?? run.sessionId,
          summary: String(hold.note ?? 'Bot requested manual browser takeover'),
          canRespondViaApi: false,
        }
      }
    }
    return null
  }

  function addUsage(run, usage) {
    if (!usage || typeof usage !== 'object') return
    run.usage.inputTokens += Number(usage.inputTokens ?? 0) || 0
    run.usage.cacheReadTokens += Number(usage.cacheReadTokens ?? 0) || 0
    run.usage.outputTokens += Number(usage.outputTokens ?? 0) || 0
    run.usage.calls += 1
  }

  function isRoomSettled(roomId) {
    if (rt.roomActive?.(roomId) === true) return false
    const working = rt.roomWorkView?.()[roomId] ?? []
    if (working.length > 0) return false
    if (rt.hasRoomTasks?.(roomId) === true) return false
    for (const batch of Object.values(state.roomBatches ?? {})) {
      if (batch?.roomId === roomId && Array.isArray(batch.pending) && batch.pending.length > 0) return false
    }
    const db = readableDb()
    if (db) {
      try {
        const activeRoomWorks = db.listWorks({ roomId, activeOnly: true, limit: 50 })
          .filter(w => w.apiRunId === null && w.originKind !== 'request_dedup' && w.status !== 'idle')
        if (activeRoomWorks.length > 0) return false
      } catch { /* best-effort */ }
    }
    return true
  }

  function isRoomBusyForLaunch(roomId, roomSid) {
    const memberBusy = [...rt.groupOwners].some(([sid, owner]) => owner.roomId === roomId && rt.live.get(sid)?.turn !== undefined)
    return rt.roomActive?.(roomId) === true || memberBusy || rt.live.get(roomSid)?.turn !== undefined
  }

  function schedulePendingGroupLaunchRecheck() {
    if (disposed || pendingGroupLaunches.size === 0 || pendingLaunchTimer !== null) return
    pendingLaunchTimer = setTimeout(() => {
      pendingLaunchTimer = null
      tryPendingGroupLaunches()
      if (pendingGroupLaunches.size > 0) schedulePendingGroupLaunchRecheck()
    }, 50)
    pendingLaunchTimer.unref?.()
  }

  function tryPendingGroupLaunches(roomId) {
    if (disposed || pendingGroupLaunches.size === 0) return
    for (const tracker of Array.from(pendingGroupLaunches)) {
      if (roomId !== undefined && tracker.run.target.id !== roomId) continue
      if (isTerminal(tracker.run.status)) {
        pendingGroupLaunches.delete(tracker)
        continue
      }
      if (typeof tracker.tryLaunch === 'function') void tracker.tryLaunch()
    }
    if (pendingGroupLaunches.size === 0 && pendingLaunchTimer !== null) {
      clearTimeout(pendingLaunchTimer)
      pendingLaunchTimer = null
    }
  }

  // Event-driven microtask settlement check (zero polling timers).
  function scheduleGroupSettleCheck(tracker) {
    if (isTerminal(tracker.run.status) || tracker.settleCheckQueued) return
    tracker.settleCheckQueued = true
    queueMicrotask(() => {
      tracker.settleCheckQueued = false
      if (disposed || isTerminal(tracker.run.status)) return
      const roomId = tracker.run.target.id
      const pending = detectPendingAction(tracker)
      if (pending !== null) {
        setWaitingHuman(tracker, pending)
        return
      }
      if (!tracker.roomHeardActivity) return
      if (isRoomSettled(roomId)) {
        syncRoomLines(tracker)
        finishRun(tracker, 'completed')
      }
    })
  }

  function syncRoomLines(tracker) {
    const room = rt.roomOf(tracker.run.target.id)
    if (room === undefined) return
    const rows = Array.isArray(room.log) ? room.log : []
    for (const line of rows) {
      if (typeof line?.seq !== 'number' || line.seq <= tracker.lastRoomSeq) continue
      tracker.lastRoomSeq = line.seq
      if (line.kind !== undefined || line.who === 'User' || !line.botId) continue
      const bot = rt.botOf(line.botId)
      const msg = {
        botId: line.botId,
        name: bot?.name ?? line.who ?? line.botId,
        text: String(line.text ?? ''),
        time: Number.isFinite(line.time) ? line.time : Date.now(),
      }
      tracker.run.output.messages.push(msg)
      tracker.run.output.text = tracker.run.output.messages.map(m => `${m.name}: ${m.text}`).join('\n\n')
      emitRunEvent(tracker, 'group.message', { message: msg })
    }
  }

  // Hook into DSH session/stream events only while the API server is running so an
  // idle/disabled gateway adds zero per-event overhead to normal chats.
  let offSessionEvent = null
  let offStreamEvent = null

  function handleSessionEvent(session, event) {
    const sid = session?.id
    if (!sid || !event) return

    // 1. Match freshly queued user/message by rpcId so we bind exact session/part even after fg-handoff.
    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId
      if (typeof rpcId === 'string' && rpcId.startsWith('api:')) {
        const runId = byRequestId.get(rpcId)
        const tracker = runId ? active.get(runId) : undefined
        if (tracker !== undefined) {
          if (Number.isInteger(event.seq)) {
            apiVia.set(sid, { ...apiVia.get(sid), [event.seq]: tracker.run.tokenName || 'API' })
          }
          tracker.userSeq = event.seq
          tracker.run.sessionId = sid
          tracker.run.partId = sid
          tracker.sessions.add(sid)
          if (tracker.run.target.kind === 'group') {
            const room = rt.roomOf(tracker.run.target.id)
            tracker.lastRoomSeq = Math.max(tracker.lastRoomSeq, Number(room?.seq ?? 0))
            tracker.run.status = 'running'
            tracker.run.startedAtMs ??= Date.now()
            syncWorkMeta(tracker.run)
            emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid })
          }
        }
      }
    }

    // Track group relay activity and member replies.
    const roomDirect = rt.roomOf(sid)
    if (roomDirect !== undefined) {
      if (event.type === 'turn/end' || event.type === 'tool/result') tryPendingGroupLaunches(roomDirect.id)
      const groupTrackers = activeGroupTrackers(roomDirect.id)
      for (const tracker of groupTrackers) {
        if (event.type === 'tool/call') {
          tracker.roomHeardActivity = true
          syncRoomLines(tracker)
        } else if (event.type === 'tool/result' || event.type === 'turn/end') {
          tracker.roomHeardActivity = true
          syncRoomLines(tracker)
          scheduleGroupSettleCheck(tracker)
        }
      }
    }

    // Track member group sessions for usage and tool events during a group run.
    const groupOwner = rt.groupOwners.get(sid)
    if (groupOwner !== undefined) {
      if (event.type === 'turn/end') tryPendingGroupLaunches(groupOwner.roomId)
      const groupTrackers = activeGroupTrackers(groupOwner.roomId)
      for (const tracker of groupTrackers) {
        if (event.type === 'assistant/message') {
          const messageUsage = event.data?.usage ?? usageChunk(event.data?.stream)
          if (messageUsage !== undefined) addUsage(tracker.run, messageUsage)
        } else if (event.type === 'tool/call') {
          tracker.roomHeardActivity = true
          emitRunEvent(tracker, 'tool.call', { botId: groupOwner.botId, callId: event.data?.callId, name: event.data?.name })
        } else if (event.type === 'tool/result') {
          tracker.roomHeardActivity = true
          emitRunEvent(tracker, 'tool.result', { botId: groupOwner.botId, callId: event.data?.message?.toolCallId })
          scheduleGroupSettleCheck(tracker)
        } else if (event.type === 'turn/end') {
          tracker.roomHeardActivity = true
          syncRoomLines(tracker)
          scheduleGroupSettleCheck(tracker)
        }
      }
    }

    // Track single-Bot chat or task runs bound to this session.
    const trackers = activeSessionTrackers(sid)
    if (trackers.length === 0) return
    for (const tracker of trackers) {
      if (isTerminal(tracker.run.status)) continue
      if (tracker.run.target.kind === 'group') continue

      if (event.type === 'turn/start') {
        const turnNum = event.data?.turn
        if (tracker.run.status === 'queued') {
          tracker.run.status = 'running'
          tracker.run.startedAtMs = Date.now()
          tracker.activeTurn = turnNum
          syncWorkMeta(tracker.run)
          emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid, turn: turnNum })
        } else if (tracker.run.status === 'waiting_human') {
          tracker.activeTurn = turnNum
          clearWaitingHuman(tracker)
        } else if (tracker.activeTurn === undefined) {
          tracker.activeTurn = turnNum
        }
      } else if (event.type === 'tool/call') {
        emitRunEvent(tracker, 'tool.call', {
          sessionId: sid,
          callId: event.data?.callId ?? null,
          name: event.data?.name ?? '',
        })
      } else if (event.type === 'tool/result') {
        emitRunEvent(tracker, 'tool.result', {
          sessionId: sid,
          callId: event.data?.message?.toolCallId ?? null,
        })
      } else if (event.type === 'deliverables/presented') {
        const presented = Array.isArray(event.data?.files) ? event.data.files : []
        presented.forEach((file, index) => {
          if (typeof file?.path !== 'string') return
          const ref = registerFile({
            kind: 'presented',
            sessionId: sid,
            botId: tracker.run.target.kind === 'bot' ? tracker.run.target.id : undefined,
            roomId: tracker.run.target.kind === 'group' ? tracker.run.target.id : undefined,
            seq: event.seq,
            index,
            name: file.name || file.path.split(/[\\/]/).pop() || 'file',
            mime: file.mime ?? 'application/octet-stream',
            size: Number.isFinite(file.size) ? file.size : null,
          })
          tracker.run.output.deliverables.push({
            fileRef: ref,
            name: file.name || file.path.split(/[\\/]/).pop() || 'file',
            mime: file.mime ?? 'application/octet-stream',
            size: Number.isFinite(file.size) ? file.size : null,
          })
        })
      } else if (event.type === 'assistant/message') {
        const messageUsage = event.data?.usage ?? usageChunk(event.data?.stream)
        if (messageUsage !== undefined) addUsage(tracker.run, messageUsage)
        const text = textOf(event.data?.message?.content ?? []).trim()
        if (text !== '' && text !== HANDOFF_ACK) {
          const bot = rt.botOf(tracker.run.target.id)
          tracker.run.output.messages.push({
            botId: tracker.run.target.id,
            name: bot?.name ?? tracker.run.target.name,
            text,
            time: Number.isFinite(event.time) ? event.time : Date.now(),
          })
          tracker.run.output.text = tracker.run.output.messages.map(m => m.text).join('\n\n')
        }
      } else if (event.type === 'turn/end') {
        // For task mode, bot-tasks.js / coordDb owns final task settlement.
        if (tracker.run.mode === 'task') continue
        // Ignore a turn/end from an earlier queued turn before our user/message ran.
        if (tracker.run.status === 'queued') continue
        // If the Bot switched to a new part mid-run, follow the new part instead of settling.
        const currentChat = rt.chatOf(tracker.run.target.id)
        if (currentChat && currentChat !== sid && rt.live.get(sid)?.switched === true) {
          tracker.sessions.add(currentChat)
          tracker.run.sessionId = currentChat
          tracker.run.partId = currentChat
          syncWorkMeta(tracker.run)
          continue
        }
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          const fail = turnFailure(reason.error)
          finishRun(tracker, 'failed', { error: { code: fail.code ?? 'bot/turn-failed', message: fail.message ?? 'Turn failed' } })
          continue
        }
        if (reason?.kind === 'aborted') {
          finishRun(tracker, 'stopped', { error: { code: 'api/stopped', message: 'Turn was stopped' } })
          continue
        }
        // Check if this turn paused to wait for a human card (question/view/secret/browser_hold).
        const pending = detectPendingAction(tracker)
        if (pending !== null) {
          setWaitingHuman(tracker, pending)
          continue
        }
        finishRun(tracker, 'completed')
      }
    }
  }

  // Stream text deltas for active Bot chat/task runs.
  function handleAssistantStream({ agent, frame }) {
    const sid = agent?.id
    if (!sid) return
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    const text = frame.chunk.text
    if (typeof text !== 'string' || text === '') return
    for (const tracker of activeSessionTrackers(sid)) {
      if (isTerminal(tracker.run.status) || tracker.run.target.kind === 'group') continue
      if (tracker.run.status === 'queued') {
        tracker.run.status = 'running'
        tracker.run.startedAtMs ??= Date.now()
        syncWorkMeta(tracker.run)
        emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid })
      }
      emitRunEvent(tracker, 'delta', { sessionId: sid, text })
    }
  }

  function attachListeners() {
    if (!reconciled) reconcileInterruptedApiRuns()
    if (offSessionEvent === null) offSessionEvent = ctx.on('session/event', handleSessionEvent)
    if (offStreamEvent === null) offStreamEvent = ctx.on('agent/assistant-stream', handleAssistantStream)
  }

  function detachListeners() {
    offSessionEvent?.()
    offSessionEvent = null
    offStreamEvent?.()
    offStreamEvent = null
  }

  // Track approval open/settled transitions for active runs.
  const offApproval = rt.onApproval?.((kind, data) => {
    for (const tracker of active.values()) {
      if (isTerminal(tracker.run.status) || tracker.dispatched === false) continue
      const match = tracker.run.target.kind === 'group'
        ? data?.roomId === tracker.run.target.id
        : (tracker.sessions.has(data?.sessionId) || (tracker.run.taskId && data?.taskId === tracker.run.taskId))
      if (!match) continue
      if (kind === 'open') {
        setWaitingHuman(tracker, approvalActionOf(data))
      } else if (kind === 'settled') {
        if (tracker.run.pendingAction?.kind === 'approval' && tracker.run.pendingAction.actionId === data?.id) {
          clearWaitingHuman(tracker)
        }
        if (tracker.run.target.kind === 'group') scheduleGroupSettleCheck(tracker)
      }
    }
  })

  // Track background task completion/failure/stop for `mode: 'task'` runs (both live trackers
  // and tasks that survived a host restart without an in-memory tracker).
  const offTaskEvent = rt.onTaskEvent?.((payload) => {
    const tracker = activeTaskTracker(payload?.taskId)
    if (tracker && !isTerminal(tracker.run.status)) {
      if (payload.type === 'task.waiting_approval') {
        const pending = detectPendingAction(tracker)
        if (pending !== null) setWaitingHuman(tracker, pending)
      } else if (payload.type === 'task.resumed') {
        clearWaitingHuman(tracker)
      } else if (payload.type === 'task.completed') {
        finishRun(tracker, 'completed', { text: payload.summary })
      } else if (payload.type === 'task.failed') {
        finishRun(tracker, 'failed', { error: { code: 'task/failed', message: payload.error ?? 'Background task failed' } })
      } else if (payload.type === 'task.stopped' || payload.type === 'task.interrupted') {
        finishRun(tracker, 'stopped', { error: { code: payload.type === 'task.interrupted' ? 'api/host-restarted' : 'api/stopped', message: payload.error ?? 'Background task stopped' } })
      }
      return
    }
    if (!payload?.taskId || !['task.completed', 'task.failed', 'task.stopped', 'task.interrupted'].includes(payload.type)) return
    const db = writableDb()
    if (!db) return
    try {
      const linked = db.listWorks({ limit: 1_000 }).find(w => w.apiRunId === null && (w.meta?.taskId === payload.taskId || w.workId === `task:${payload.taskId}`))
      const linkedApiRunId = linked?.meta?.apiRunId
      if (typeof linkedApiRunId !== 'string' || linkedApiRunId === '' || active.has(linkedApiRunId)) return
      const apiWork = db.getWork(workIdOf(linkedApiRunId))
      const rec = apiWork ? recordFromWork(apiWork) : undefined
      if (!apiWork || !rec || isTerminal(rec.status)) return
      const mappedStatus = payload.type === 'task.completed' ? 'done' : payload.type === 'task.failed' ? 'failed' : 'stopped'
      const mappedError = payload.type === 'task.failed'
        ? { code: 'task/failed', message: String(payload.error ?? 'Background task failed') }
        : payload.type === 'task.interrupted'
          ? { code: 'api/host-restarted', message: String(payload.error ?? 'Background task interrupted') }
          : payload.type === 'task.stopped'
            ? { code: 'api/stopped', message: String(payload.error ?? 'Background task stopped') }
            : undefined
      db.transaction(() => {
        applyLinkedTaskState(db, apiWork, rec, {
          ...linked,
          status: mappedStatus,
          ...(payload.summary !== undefined ? { resultSummary: payload.summary } : {}),
          ...(mappedError !== undefined ? { error: mappedError } : {}),
        }, Date.now())
      })
    } catch { /* best-effort */ }
  })

  // React to coordination-db work settlements (tasks & group room works).
  const offWorkSettled = rt.onWorkSettled?.(({ work, outcome, summary, error }) => {
    if (!work || work.apiRunId !== null) return
    if (work.roomId) {
      tryPendingGroupLaunches(work.roomId)
      for (const tracker of activeGroupTrackers(work.roomId)) {
        tracker.roomHeardActivity = true
        syncRoomLines(tracker)
        scheduleGroupSettleCheck(tracker)
      }
    }
    const legacyTaskId = work.meta?.taskId ?? work.meta?.legacyTaskId ?? (work.workId.startsWith('task:') ? work.workId.slice(5) : undefined)
    const tracker = activeTaskTracker(legacyTaskId)
    if (tracker && !isTerminal(tracker.run.status)) {
      if (outcome === 'done') finishRun(tracker, 'completed', { text: summary ?? work.resultSummary })
      else if (outcome === 'failed') finishRun(tracker, 'failed', { error: { code: error?.code ?? 'task/failed', message: error?.message ?? 'Background task failed' } })
      else finishRun(tracker, 'stopped', { error: { code: error?.code ?? 'api/stopped', message: error?.message ?? 'Background task stopped' } })
      return
    }
    // Reconcile a persisted API Run whose linked task survived restart without an in-memory tracker.
    const linkedApiRunId = work.meta?.apiRunId
    if (typeof linkedApiRunId === 'string' && linkedApiRunId !== '' && !active.has(linkedApiRunId)) {
      const db = writableDb()
      if (db) {
        try {
          const apiWork = db.getWork(workIdOf(linkedApiRunId))
          const rec = apiWork ? recordFromWork(apiWork) : undefined
          if (apiWork && rec && !isTerminal(rec.status)) {
            db.transaction(() => {
              const latestLinked = db.getWork(work.workId) ?? work
              applyLinkedTaskState(db, apiWork, rec, {
                ...latestLinked,
                status: outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : 'stopped',
                ...(summary !== undefined ? { resultSummary: summary } : {}),
                ...(error !== undefined ? { error } : {}),
              }, Date.now())
            })
          }
        } catch { /* best-effort */ }
      }
    }
  })

  // Also watch state saves for card dismissals, question/view settlement, and group progress.
  const offSaved = rt.onSaved?.(() => {
    for (const tracker of active.values()) {
      if (isTerminal(tracker.run.status)) continue
      if (tracker.run.status === 'waiting_human') {
        const current = detectPendingAction(tracker)
        if (current === null) clearWaitingHuman(tracker)
      }
      if (tracker.run.target.kind === 'group' && tracker.dispatched !== false && tracker.roomHeardActivity) {
        scheduleGroupSettleCheck(tracker)
      }
    }
    tryPendingGroupLaunches()
  })

  async function startBotRun({ principal, bot, text, mode = 'chat', title, attachments = [], idempotencyKey }) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { status: 503, code: 'bot/read-only' })
    const cleanMode = mode === 'task' ? 'task' : 'chat'
    const cleanText = String(text ?? '').trim()
    if (cleanText === '' && attachments.length === 0) {
      throw Object.assign(new Error('Message text or attachments required'), { status: 400, code: 'api/invalid' })
    }

    // Idempotency check before acquiring a run slot or sending anything.
    const idemRecord = checkIdempotency({
      tokenId: principal.keyId,
      targetKind: 'bot',
      targetId: bot.id,
      idempotencyKey,
      payload: { targetKind: 'bot', targetId: bot.id, mode: cleanMode, text: cleanText, title: title ?? null, attachments: attachments.map(a => a.id ?? a.name) },
    })
    if (idemRecord.replay !== undefined) return { run: idemRecord.replay, replayed: true }

    const slot = auth.acquireRunSlot(principal)
    if (!slot.ok) throw Object.assign(new Error(slot.message), { status: slot.status, code: slot.code, details: slot.details })

    const runId = newRunId()
    const requestId = `api:${principal.keyId}:${runId}`
    const now = Date.now()
    const record = {
      runId,
      requestId,
      tokenId: principal.keyId,
      tokenName: principal.name,
      target: { kind: 'bot', id: bot.id, name: bot.name },
      mode: cleanMode,
      status: 'queued',
      createdAtMs: now,
      startedAtMs: null,
      finishedAtMs: null,
      sessionId: rt.chatOf(bot.id) ?? null,
      partId: rt.chatOf(bot.id) ?? null,
      taskId: null,
      output: { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
      pendingAction: null,
      usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
      error: null,
    }
    const tracker = {
      run: record,
      requestId,
      sessions: new Set(),
      events: [],
      eventSeq: 0,
      listeners: new Set(),
      waiters: [],
      settleCheckQueued: false,
      lastRoomSeq: 0,
      roomHeardActivity: false,
      activeTurn: undefined,
      userSeq: undefined,
      releaseSlot: slot.release,
    }
    active.set(runId, tracker)
    byRequestId.set(requestId, runId)
    if (idemRecord.key !== undefined) {
      inflightIdem.set(idemRecord.key, { fingerprint: idemRecord.fingerprint, record })
    }

    // Persist API work + Idempotency-Key in SQLite BEFORE any side-effecting dispatch
    // so a crash after `startTask`/`sendUser` never drops the Run or duplicates on retry.
    try {
      persistCreateWork(record, {
        idempotencyKey: idemRecord.key ?? null,
        idempotencyFingerprint: idemRecord.fingerprint,
        inputText: cleanText,
        attachmentCount: attachments.length,
      })
    } catch (error) {
      if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
      byRequestId.delete(requestId)
      active.delete(runId)
      tracker.releaseSlot?.()
      tracker.releaseSlot = null
      throw error
    }

    try {
      if (cleanMode === 'task') {
        const fromSessionId = rt.chatOf(bot.id)
        const taskTitle = String(title ?? '').trim() || cleanText.replace(/\s+/g, ' ').slice(0, 60) || 'API task'
        const started = await rt.startTask(fromSessionId, { title: taskTitle, brief: cleanText }, undefined, { api: true, apiRunId: runId })
        record.taskId = started.id
        record.sessionId = started.sessionId
        record.partId = started.sessionId
        record.status = 'running'
        record.startedAtMs = Date.now()
        tracker.sessions.add(started.sessionId)
        emitRunEvent(tracker, 'run.started', { sessionId: started.sessionId, partId: started.sessionId, taskId: started.id })
      } else {
        const content = [
          ...(cleanText !== '' ? [{ type: 'text', text: cleanText }] : []),
          ...attachments.map(att => att.block),
        ]
        const beforeSid = rt.chatOf(bot.id)
        if (beforeSid) tracker.sessions.add(beforeSid)
        await rt.sendUser({ sessionId: bot.id, content, requestId, idempotencyKey: requestId })
        const afterSid = rt.chatOf(bot.id)
        if (afterSid && !tracker.sessions.has(afterSid)) {
          tracker.sessions.add(afterSid)
          record.sessionId = afterSid
          record.partId = afterSid
        }
      }
      syncWorkMeta(record)
      if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
      return { run: toPublicView(record), replayed: false }
    } catch (error) {
      if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
      finishRun(tracker, 'failed', { error: { code: error?.code ?? 'api/send-failed', message: error?.message ?? String(error) } })
      throw error
    }
  }

  async function startGroupRun({ principal, room, text, mentions = [], attachments = [], idempotencyKey }) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { status: 503, code: 'bot/read-only' })
    let cleanText = String(text ?? '').trim()
    if (cleanText === '' && attachments.length === 0) {
      throw Object.assign(new Error('Message text or attachments required'), { status: 400, code: 'api/invalid' })
    }
    // Prepend explicit @mentions if the caller passed `mentions` not already in the body.
    if (Array.isArray(mentions) && mentions.length > 0) {
      const prefix = []
      for (const ref of mentions) {
        const member = rt.botOf(ref) ?? room.members.map(id => rt.botOf(id)).find(b => b?.name === ref)
        if (member !== undefined && room.members.includes(member.id) && !cleanText.includes(`@${member.name}`)) {
          prefix.push(`@${member.name}`)
        }
      }
      if (prefix.length > 0) cleanText = `${prefix.join(' ')} ${cleanText}`.trim()
    }

    const idemRecord = checkIdempotency({
      tokenId: principal.keyId,
      targetKind: 'group',
      targetId: room.id,
      idempotencyKey,
      payload: { targetKind: 'group', targetId: room.id, text: cleanText, mentions, attachments: attachments.map(a => a.id ?? a.name) },
    })
    if (idemRecord.replay !== undefined) return { run: idemRecord.replay, replayed: true }

    const slot = auth.acquireRunSlot(principal)
    if (!slot.ok) throw Object.assign(new Error(slot.message), { status: slot.status, code: slot.code, details: slot.details })

    const runId = newRunId()
    const requestId = `api:${principal.keyId}:${runId}`
    const now = Date.now()
    const roomSid = rt.sessionOfRoom(room)
    const record = {
      runId,
      requestId,
      tokenId: principal.keyId,
      tokenName: principal.name,
      target: { kind: 'group', id: room.id, name: room.name },
      mode: 'chat',
      status: 'queued',
      createdAtMs: now,
      startedAtMs: null,
      finishedAtMs: null,
      sessionId: roomSid ?? room.id,
      partId: roomSid ?? room.id,
      taskId: null,
      output: { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
      pendingAction: null,
      usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
      error: null,
    }
    let launching = false
    const tracker = {
      run: record,
      requestId,
      sessions: new Set([roomSid ?? room.id]),
      dispatched: false,
      events: [],
      eventSeq: 0,
      listeners: new Set(),
      waiters: [],
      settleCheckQueued: false,
      lastRoomSeq: Number(room.seq ?? 0),
      roomHeardActivity: false,
      activeTurn: undefined,
      userSeq: undefined,
      releaseSlot: slot.release,
      tryLaunch: null,
    }
    active.set(runId, tracker)
    byRequestId.set(requestId, runId)
    if (idemRecord.key !== undefined) {
      inflightIdem.set(idemRecord.key, { fingerprint: idemRecord.fingerprint, record })
    }

    // Persist group API work + Idempotency-Key in SQLite BEFORE launching into the room.
    try {
      persistCreateWork(record, {
        idempotencyKey: idemRecord.key ?? null,
        idempotencyFingerprint: idemRecord.fingerprint,
        inputText: cleanText,
        attachmentCount: attachments.length,
      })
    } catch (error) {
      if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
      byRequestId.delete(requestId)
      active.delete(runId)
      tracker.releaseSlot?.()
      tracker.releaseSlot = null
      throw error
    }

    const launch = async () => {
      if (disposed || launching || tracker.dispatched || isTerminal(record.status)) return
      const currentRoomSid = rt.sessionOfRoom(room) ?? roomSid
      if (isRoomBusyForLaunch(room.id, currentRoomSid)) {
        pendingGroupLaunches.add(tracker)
        syncRoomFeedTap()
        schedulePendingGroupLaunchRecheck()
        return
      }
      launching = true
      pendingGroupLaunches.delete(tracker)
      try {
        tracker.dispatched = true
        tracker.lastRoomSeq = Number(room.seq ?? 0)
        syncRoomFeedTap()
        rt.clearImOrigin?.(currentRoomSid)
        const content = [
          ...(cleanText !== '' ? [{ type: 'text', text: cleanText }] : []),
          ...attachments.map(att => att.block),
        ]
        await rt.sendUser({ sessionId: room.id, content, requestId, idempotencyKey: requestId })
        syncWorkMeta(record)
        if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
      } catch (error) {
        if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
        finishRun(tracker, 'failed', { error: { code: error?.code ?? 'api/send-failed', message: error?.message ?? String(error) } })
      } finally {
        launching = false
      }
    }
    tracker.tryLaunch = launch
    await launch()
    if (!tracker.dispatched && !isTerminal(record.status)) {
      syncWorkMeta(record)
      if (idemRecord.key !== undefined) inflightIdem.delete(idemRecord.key)
    }
    return { run: toPublicView(record), replayed: false }
  }

  function checkIdempotency({ tokenId, targetKind, targetId, idempotencyKey, payload }) {
    if (!reconciled) reconcileInterruptedApiRuns()
    if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') return {}
    const clean = String(idempotencyKey).trim()
    if (clean.length > IDEMPOTENCY_MAX_LEN) {
      throw Object.assign(new Error(`Idempotency-Key must be at most ${IDEMPOTENCY_MAX_LEN} characters`), { status: 400, code: 'api/invalid' })
    }
    const key = `${tokenId}\0${targetKind}\0${targetId}\0${clean}`
    const fingerprint = fingerprintOf(payload)

    const inflight = inflightIdem.get(key)
    if (inflight !== undefined) {
      if (inflight.fingerprint !== fingerprint) {
        throw Object.assign(new Error('Idempotency-Key was already used with a different request payload'), { status: 409, code: 'api/idempotency-conflict' })
      }
      return { replay: toPublicView(inflight.record) }
    }

    const db = readableDb()
    if (db) {
      try {
        const work = db.getWorkByApiIdempotencyKey(key)
        if (work !== undefined) {
          const prev = active.get(work.apiRunId)?.run ?? recordFromWork(work)
          const savedFp = work.apiMeta?.idempotencyFingerprint
          if (savedFp !== undefined && savedFp !== fingerprint) {
            throw Object.assign(new Error('Idempotency-Key was already used with a different request payload'), { status: 409, code: 'api/idempotency-conflict' })
          }
          if (prev !== undefined) return { replay: toPublicView(prev) }
        }
      } catch (error) {
        if (error?.code === 'api/idempotency-conflict') throw error
      }
    } else {
      const existing = memIdem.get(key)
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw Object.assign(new Error('Idempotency-Key was already used with a different request payload'), { status: 409, code: 'api/idempotency-conflict' })
        }
        const prev = memRuns.get(existing.runId)
        if (prev !== undefined) return { replay: toPublicView(prev) }
      }
    }
    return { key, fingerprint }
  }

  function getRunForPrincipal(runId, principal) {
    const record = loadRunRecord(runId)
    if (record === undefined) return { ok: false, status: 404, code: 'run/not-found', message: 'Run not found' }
    // Verify the caller still has access to the target (handles revoked or newly-private Bots).
    if (record.target.kind === 'bot') {
      const access = principal.assertBotAccess(record.target.id)
      if (!access.ok) return access
    } else if (record.target.kind === 'group') {
      const access = principal.assertRoomAccess(record.target.id)
      if (!access.ok) return access
    }
    return { ok: true, run: toPublicView(record), record }
  }

  function listRunsForPrincipal(principal, { limit = 50, targetId, status } = {}) {
    const cap = Math.max(1, Math.min(200, Number(limit) || 50))
    const list = []
    for (const record of listAllRunRecords()) {
      if (targetId && record.target.id !== targetId) continue
      if (status && record.status !== status) continue
      const allowed = record.target.kind === 'bot'
        ? principal.canAccessBot(record.target.id)
        : principal.canAccessRoom(record.target.id)
      if (!allowed) continue
      list.push(record)
    }
    list.sort((a, b) => b.createdAtMs - a.createdAtMs)
    return list.slice(0, cap).map(toPublicView)
  }

  async function waitForRun(runId, waitSeconds) {
    const record = loadRunRecord(runId)
    if (record === undefined) return null
    if (isTerminal(record.status) || record.status === 'waiting_human') return toPublicView(record)
    const tracker = active.get(runId)
    if (tracker === undefined) return toPublicView(record)
    const ms = Math.max(0, Math.min(300_000, Math.round(Number(waitSeconds) * 1_000)))
    if (ms === 0) return toPublicView(record)
    return await new Promise((resolve) => {
      let timer
      const done = (snapshot) => {
        if (timer !== undefined) clearTimeout(timer)
        const idx = tracker.waiters.indexOf(done)
        if (idx >= 0) tracker.waiters.splice(idx, 1)
        resolve(snapshot)
      }
      timer = setTimeout(() => done(toPublicView(record)), ms)
      timer.unref?.()
      tracker.waiters.push(done)
    })
  }

  function subscribeRun(runId, listener, { lastEventId } = {}) {
    const record = loadRunRecord(runId)
    if (record === undefined) return null
    const tracker = active.get(runId)
    if (tracker === undefined) {
      // Already settled and evicted from live buffer: send terminal snapshot directly.
      listener({ id: `${runId}:final`, event: `run.${record.status}`, data: toPublicView(record) })
      return () => {}
    }
    let startIndex = 0
    if (typeof lastEventId === 'string' && lastEventId !== '') {
      const found = tracker.events.findIndex(item => item.id === lastEventId)
      if (found >= 0) startIndex = found + 1
    }
    for (let i = startIndex; i < tracker.events.length; i += 1) {
      listener(tracker.events[i])
    }
    if (isTerminal(record.status)) return () => {}
    tracker.listeners.add(listener)
    return () => tracker.listeners.delete(listener)
  }

  async function cancelRun(runId, principal) {
    const found = getRunForPrincipal(runId, principal)
    if (!found.ok) return found
    const { record } = found
    if (isTerminal(record.status)) return { ok: true, run: toPublicView(record) }
    const tracker = active.get(record.runId)
    if (tracker?.dispatched === false) {
      finishRun(tracker, 'stopped', { error: { code: 'api/cancelled', message: 'Cancelled before dispatch' } })
      return { ok: true, run: toPublicView(record) }
    }
    if (record.target.kind === 'group') {
      await rt.stopRoomWork?.(record.target.id)
    } else if (record.mode === 'task' && record.taskId) {
      await rt.stopTask?.(record.target.id, record.taskId, 'cancelled via API')
    } else {
      await rt.stopChat?.(record.target.id)
    }
    if (tracker !== undefined) {
      finishRun(tracker, 'stopped', { error: { code: 'api/cancelled', message: 'Cancelled via API' } })
    } else {
      record.status = 'stopped'
      record.finishedAtMs = Date.now()
      record.pendingAction = null
      record.error = { code: 'api/cancelled', message: 'Cancelled via API' }
      settlePersistedWork(record)
    }
    return { ok: true, run: toPublicView(record) }
  }

  async function respondToRun(runId, principal, body = {}) {
    if (typeof body.actionId !== 'string' || body.actionId.trim() === '') {
      return { ok: false, status: 400, code: 'api/invalid', message: 'actionId is required' }
    }
    const found = getRunForPrincipal(runId, principal)
    if (!found.ok) return found
    const { record } = found
    const tracker = active.get(record.runId)
    if (record.status !== 'waiting_human' || record.pendingAction === null) {
      return { ok: false, status: 409, code: 'run/not-waiting', message: 'This run is not waiting for human input' }
    }
    const action = record.pendingAction
    if (body.actionId !== action.actionId) {
      return { ok: false, status: 409, code: 'run/stale-action', message: 'Pending action id does not match' }
    }
    if (action.kind === 'approval') {
      const live = (rt.approvalsView?.() ?? []).find(entry => entry.id === action.actionId && entry.sessionId === action.sessionId && entry.botId === action.botId && entry.answerable === true)
      if (!live) return { ok: false, status: 409, code: 'run/stale-action', message: 'This approval is no longer open' }
      if (rt.isPrivacyApproval?.(live.id) === true) {
        return { ok: false, status: 403, code: 'api/action-not-permitted', message: 'Privacy approvals must be completed by the user on the computer or phone' }
      }
    }
    if (action.kind === 'question' && rt.own(state.questions, action.sessionId)?.id !== action.actionId) {
      return { ok: false, status: 409, code: 'run/stale-action', message: 'This question is no longer open' }
    }
    if (action.kind === 'secret' || action.kind === 'browser_hold' || action.canRespondViaApi !== true) {
      return { ok: false, status: 403, code: 'api/action-not-permitted', message: `Action "${action.kind}" must be completed by the user on the computer or phone` }
    }

    if (action.kind === 'approval') {
      if (!principal.hasScope('approval')) {
        return { ok: false, status: 403, code: 'api/scope-required', message: 'The "approval" scope is required to answer tool approvals' }
      }
      const choice = String(body.choice ?? body.answer ?? '').trim()
      if (choice !== 'allow' && choice !== 'reject') {
        return { ok: false, status: 400, code: 'api/invalid', message: 'choice must be "allow" or "reject"' }
      }
      rt.answerApproval(action.actionId, choice)
      if (tracker !== undefined) clearWaitingHuman(tracker)
      return { ok: true, run: toPublicView(record) }
    }

    if (action.kind === 'question') {
      if (!principal.hasScope('message')) {
        return { ok: false, status: 403, code: 'api/scope-required', message: 'The "message" scope is required to answer questions' }
      }
      let normalized = body.answer
      const question = rt.own(state.questions, action.sessionId)
      const labels = new Set((question.options ?? []).map(opt => typeof opt === 'string' ? opt : opt?.label).filter(label => typeof label === 'string'))
      const customAllowed = question.allowCustom === true || labels.size === 0
      if (typeof normalized === 'string') {
        normalized = labels.has(normalized) ? { selected: [normalized] } : { custom: normalized }
      } else if (Array.isArray(normalized)) {
        normalized = { selected: normalized }
      }
      if (!normalized || typeof normalized !== 'object'
        || Object.keys(normalized).some(key => !['selected', 'custom'].includes(key))
        || (normalized.selected !== undefined && (!Array.isArray(normalized.selected)
          || normalized.selected.some(label => typeof label !== 'string' || !labels.has(label))
          || (question.multiSelect !== true && normalized.selected.length > 1)))
        || (normalized.custom !== undefined && (!customAllowed || typeof normalized.custom !== 'string'))
        || (!(normalized.selected?.length) && !(normalized.custom?.trim()))) {
        return { ok: false, status: 400, code: 'api/invalid', message: 'answer must contain valid question choices or permitted custom text' }
      }
      await rt.answerQuestion(action.sessionId, action.actionId, normalized, `api:${principal.keyId}:${record.runId}:q`)
      if (tracker !== undefined) clearWaitingHuman(tracker)
      return { ok: true, run: toPublicView(record) }
    }

    if (action.kind === 'view') {
      if (!principal.hasScope('message')) {
        return { ok: false, status: 403, code: 'api/scope-required', message: 'The "message" scope is required to answer views' }
      }
      const pending = rt.own(state.views, action.sessionId)
      if (pending === undefined || pending.id !== action.actionId) {
        return { ok: false, status: 409, code: 'run/stale-action', message: 'This view is no longer open' }
      }
      const checked = validateViewAnswer(pending.view, body.action, body.values)
      if (checked.error !== undefined) {
        return { ok: false, status: 400, code: 'api/invalid', message: checked.error }
      }
      const reply = viewReply(pending, body.action, body.values)
      if (reply === undefined) {
        return { ok: false, status: 400, code: 'api/invalid', message: 'Invalid view response' }
      }
      delete state.views[action.sessionId]
      try {
        await rt.ensureCapabilities(action.sessionId)
        const agent = await rt.resolveAgent(action.sessionId)
        agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: { ...reply.source, rpcId: `api:${principal.keyId}:${record.runId}:v` } }))
        await ctx.sessions.flush(agent.session)
      } catch (error) {
        state.views[action.sessionId] ??= pending
        throw error
      }
      const db = writableDb()
      if (db) {
        let wakeWorkId
        try {
          const wait = db.listWaits({ kind: 'user_question', status: 'open', targetId: `view:${action.actionId}`, limit: 1 })[0]
          if (wait !== undefined) {
            db.transaction(() => {
              db.resolveWait({
                waitId: wait.waitId,
                status: 'resolved',
                resolution: { kind: 'view', cardId: action.actionId, action: body.action },
                wake: false,
              })
              const openReq = db.listWaits({ workId: wait.workId, status: 'open', limit: 20 })
                .filter(item => item.required)
              if (openReq.length === 0) {
                const work = db.getWork(wait.workId)
                if (work && (work.status === 'waiting' || work.status === 'idle')) {
                  const unreadWaking = db.listInbox(wait.workId, { unreadOnly: true, includeNotes: false, limit: 1 })
                  if (unreadWaking.length > 0) {
                    db.requeueInterruptedWork(wait.workId, { reason: 'pending_inbox_after_user_question' })
                    wakeWorkId = wait.workId
                  }
                }
              }
            })
          }
        } catch { /* best-effort */ }
        if (wakeWorkId) void Promise.resolve(rt.kickScheduler?.({ workId: wakeWorkId })).catch(() => {})
      }
      await rt.save()
      if (tracker !== undefined) clearWaitingHuman(tracker)
      return { ok: true, run: toPublicView(record) }
    }

    return { ok: false, status: 400, code: 'api/invalid', message: 'Unsupported action kind' }
  }

  function apiViaView() {
    for (const sessionId of apiVia.keys()) {
      if (!rt.chatOwners.has(sessionId) && !rt.roomOwners.has(sessionId)) apiVia.delete(sessionId)
    }
    return Object.fromEntries([...apiVia.entries()].map(([sid, seqs]) => [sid, { ...seqs }]))
  }

  function dispose() {
    disposed = true
    if (rt.reconcileApiRuns === reconcileInterruptedApiRunsAsync) rt.reconcileApiRuns = undefined
    detachListeners()
    offApproval?.()
    offTaskEvent?.()
    offWorkSettled?.()
    offFeed?.()
    offSaved?.()
    pendingGroupLaunches.clear()
    if (pendingLaunchTimer !== null) {
      clearTimeout(pendingLaunchTimer)
      pendingLaunchTimer = null
    }
    for (const tracker of active.values()) {
      for (const resolve of tracker.waiters.splice(0, tracker.waiters.length)) resolve(toPublicView(tracker.run))
    }
  }

  rt.reconcileApiRuns = reconcileInterruptedApiRunsAsync
  reconcileInterruptedApiRuns()

  return {
    attachListeners,
    detachListeners,
    reconcileInterruptedApiRunsAsync,
    startBotRun,
    startGroupRun,
    getRunForPrincipal,
    listRunsForPrincipal,
    waitForRun,
    subscribeRun,
    cancelRun,
    respondToRun,
    registerFile,
    getFileDescriptor,
    apiViaView,
    dispose,
  }
}
