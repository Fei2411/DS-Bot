// Background tasks of a Bot (#783).
//
// Each task is a dedicated Session stored in `bot.tasks[]`, never swapped into
// `bot.sessionId`. A task keeps a stable `id` across context part switches,
// runs an explicit lifecycle state machine, delivers all messages through `rt.deliver`
// (capabilities + inflight durability), integrates with handoff works and IM origins,
// bubbles approvals to the foreground/mobile/IM, and exposes hooks for v0.4.0 events.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HANDOFF_ACK, HISTORY_TIMEOUT_MS, SOURCE_KIND, STEER_CUT, TASK_FORK_MAX_EVENTS } from './constants.js'
import { within } from './folders.js'
import { absoluteLinks } from './links.js'
import { textOf } from './text.js'
import { activeTasksOf, isActiveTask, retiredTaskSessionIds, taskSessionIds, threadCurrentOfPart, threadOfPart } from './threads.js'
import { output } from './tools.js'
import { answerSender, cutOffText, turnFailure } from './turns.js'

const TITLE_MAX = 80
const MOVED_PROMPT_MAX = 2000
const BRIEF_KEPT = 500
const SUMMARY_MAX = 300
const REPORT_MAX = 4000
const CONTEXT_FALLBACK_MAX = 8000
const CONTEXT_FALLBACK_NOTE_MIN = 5000
const CONTEXT_FALLBACK_ITEMS = 16
const MAX_SETTLED_TASKS = 50
const MAX_REPLACED_IDS = 1000
const PEER_BUSY_WAIT_MS = 5000

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
// Keep only session anchors for read_own_chat history lookups; omit multi-KB segment.note
// bodies so bot.tasks[] does not duplicate historical handoff notes in state.json.
const slimSegments = (bot) => (bot?.segments ?? [])
  .filter(seg => typeof seg?.sessionId === 'string' && seg.sessionId !== '')
  .map(seg => ({
    sessionId: seg.sessionId,
    ...(seg.endedAt !== undefined ? { endedAt: seg.endedAt } : {}),
  }))
const cleanStructuredNote = (raw, { handoff = false } = {}) => {
  const source = typeof raw === 'string' ? raw : Array.isArray(raw) ? textOf(raw) : ''
  let text = source.replace(/\r\n?/g, '\n').trim()
  if (text === '') return ''
  if (handoff) {
    const firstLine = text.split('\n', 1)[0] ?? ''
    const noteAt = text.indexOf('\n## Handoff note')
    if (noteAt !== -1) {
      const rest = text.slice(noteAt + 1).trim()
      text = firstLine.startsWith('[Handoff') ? `${firstLine}\n${rest}` : rest
    }
  }
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
const clipStructuredNote = (text, max) => {
  if (text.length <= max) return text
  const slice = text.slice(0, Math.max(0, max - 1))
  const nl = slice.lastIndexOf('\n')
  const cut = nl >= Math.floor(max * 0.6) ? slice.slice(0, nl) : slice
  return `${cut.trimEnd()}…`
}
const newId = () => `k_${randomBytes(3).toString('hex')}`
const safeFileName = id => `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`

export function install(rt) {
  const { ctx, state } = rt
  const reportsDir = join(rt.home, 'task-reports')
  const settling = new Set()
  const delivering = new Set()
  // Message IDs currently being restored to an old foreground Agent (pre-commit failure)
  // or forwarded onto a newly forked foreground Agent, so `interceptForegroundUserMessage`
  // never re-intercepts its own writes.
  const skipInterceptIds = new Set()
  // Message IDs replaced in-place by `inbox.replace()` (e.g. QueueDock Edit); tagged
  // during `session/event` (`agent/inbox/spliced` with removedCount > 0 && inserted.length > 0)
  // and consumed immediately on the paired `agent/inbox/inserted` notification.
  const replacedIds = new Set()
  // Idle `taskOwners` sessions whose stale user prompt was pulled during `agent/inbox/inserted`:
  // reject the phantom empty wake that `ReactLoopAgent.send()` still triggers right afterward.
  const rejectEmptyTaskWake = new Set()
  // Transfer IDs created and actively handled by this host process so startup
  // `reconcileTasksAfterRestart()` only replays entries left on disk by a prior crash.
  const inFlightTransferIds = new Set()
  // Monotonic transfer generation token per transferId so an older transfer's flush()
  // can never clear or unlock a newer transfer of the same input.
  let transferTokenSeq = 0
  const transferOwnerToken = new Map()
  // Transfer rpcIds already admitted onto a destination session during this process
  // (covers the window after `inbox.claim()` removes the item from inbox and before
  // `step()` appends `user/message` to the session log).
  const admittedRpcIds = new Map()
  // Logical chat (bot:<id> / room:<id>) admission cache so send retries with the same
  // `requestId` stay idempotent across foreground-to-background handoffs.
  const admittedLogicalRpcIds = new Map()
  // In-flight foreground-to-background handoffs per Bot:
  // botId -> { oldSid, committed, aborted, saved, newSid, taskId, explicit, operationIds, savedOperationIds, promise, messages }.
  const handoffing = new Map()
  // Monotonic foreground epoch per Bot (incremented on foreground handoff commit).
  const foregroundEpochs = new Map()
  // Bounded idempotency caches for explicit moveForegroundToBackground operations:
  // `completedMoveOps` (mirrored to `state.completedMoveOps` on durable save) records
  // operations whose team state was durably saved (or terminal no-op/stale) so retries
  // stay idempotent across restarts; `stagedMoveOps` & `inFlightSaveMoveOps` ensure
  // concurrent retries join an outstanding save instead of reading a staged receipt early;
  // `pendingSaveMoveOps` holds committed-in-memory moves whose `rt.save({ required: true })`
  // failed so retries finish saving instead of falsely succeeding.
  const MAX_MOVE_OPS = 64
  const completedMoveOps = new Map()
  // Refcounted map (`operationId -> active stage count`) so overlapping saves on the same
  // key never clear the staged flag while another save still owns it.
  const stagedMoveOps = new Map()
  const addStagedMoveOp = (id) => {
    if (typeof id !== 'string' || id === '') return
    stagedMoveOps.set(id, (stagedMoveOps.get(id) ?? 0) + 1)
  }
  const removeStagedMoveOp = (id) => {
    const next = (stagedMoveOps.get(id) ?? 0) - 1
    if (next <= 0) stagedMoveOps.delete(id)
    else stagedMoveOps.set(id, next)
  }
  const isStagedMoveOp = id => (stagedMoveOps.get(id) ?? 0) > 0
  const inFlightSaveMoveOps = new Map()
  const pendingSaveMoveOps = new Map()
  // Bounded retry timer when `reconcilePendingHandoffInputs` defers an unreadable/unflushed session.
  let reconcileRetryTimer
  let reconcileRetryDelayMs = 1000
  // Cache of rpcIds/messageIds scanned from immutable cold (settled) sessions after restart.
  const MAX_INSPECTED_SESSIONS = 128
  const inspectedSettledSessionRpcIds = new Map()
  const readCompletedMoveOp = (operationId) => {
    if (typeof operationId !== 'string' || operationId === '') return undefined
    if (isStagedMoveOp(operationId) || inFlightSaveMoveOps.has(operationId) || pendingSaveMoveOps.has(operationId)) {
      return undefined
    }
    const mem = completedMoveOps.get(operationId)
    if (mem !== undefined) return mem
    const persisted = rt.own(state.completedMoveOps, operationId)
    if (persisted && typeof persisted === 'object' && typeof persisted.sessionId === 'string') {
      const normalized = {
        sessionId: persisted.sessionId,
        taskId: persisted.taskId ?? null,
        moved: Boolean(persisted.moved),
        ...(persisted.stale === true ? { stale: true } : {}),
      }
      completedMoveOps.set(operationId, normalized)
      return normalized
    }
    return undefined
  }
  // Stages one or more operation receipts using per-key identity-checked rollback tracking
  // so rolling back a failed save NEVER clobbers a concurrent Bot's receipt or a newer
  // overlapping stage on the same key, while still restoring capacity-evicted entries.
  const stagePersistedMoveOps = (entries) => {
    // entries: Array<{ id: string, result: { sessionId, taskId, moved, stale? } }>
    const valid = entries.filter(item => typeof item?.id === 'string' && item.id !== '')
    if (valid.length === 0) return { active: false, prevById: new Map(), writtenById: new Map(), evicted: [] }
    if (state.completedMoveOps === null || typeof state.completedMoveOps !== 'object' || Array.isArray(state.completedMoveOps)) {
      state.completedMoveOps = {}
    }
    const prevById = new Map()
    const writtenById = new Map()
    const stagedNow = new Set()
    const at = Date.now()
    for (const { id, result } of valid) {
      if (!prevById.has(id)) prevById.set(id, rt.own(state.completedMoveOps, id))
      stagedNow.add(id)
      delete state.completedMoveOps[id]
      const recordObj = {
        sessionId: result.sessionId,
        taskId: result.taskId ?? null,
        moved: Boolean(result.moved),
        ...(result.stale === true ? { stale: true } : {}),
        at,
      }
      state.completedMoveOps[id] = recordObj
      writtenById.set(id, recordObj)
    }
    const evicted = []
    const keys = Object.keys(state.completedMoveOps)
    for (const key of keys) {
      if (Object.keys(state.completedMoveOps).length <= MAX_MOVE_OPS) break
      if (stagedNow.has(key) || isStagedMoveOp(key)) continue
      evicted.push([key, state.completedMoveOps[key]])
      delete state.completedMoveOps[key]
    }
    return { active: true, prevById, writtenById, evicted }
  }
  const unstagePersistedMoveOps = (staged) => {
    if (!staged?.active) return
    if (state.completedMoveOps === null || typeof state.completedMoveOps !== 'object' || Array.isArray(state.completedMoveOps)) {
      state.completedMoveOps = {}
    }
    for (const [id, prev] of staged.prevById) {
      // Only undo this key if nobody else overwrote it with a newer staged/committed entry.
      if (state.completedMoveOps[id] !== staged.writtenById.get(id)) continue
      if (prev === undefined) delete state.completedMoveOps[id]
      else state.completedMoveOps[id] = prev
    }
    if (staged.evicted.length > 0) {
      // Restore evicted oldest entries at the front without touching any concurrent entries.
      const rebuilt = {}
      for (const [key, val] of staged.evicted) {
        if (!Object.hasOwn(state.completedMoveOps, key)) rebuilt[key] = val
      }
      for (const [key, val] of Object.entries(state.completedMoveOps)) {
        rebuilt[key] = val
      }
      state.completedMoveOps = rebuilt
    }
    if (Object.keys(state.completedMoveOps).length === 0) delete state.completedMoveOps
  }
  const rememberMoveOp = (operationId, result) => {
    if (typeof operationId !== 'string' || operationId === '') return
    completedMoveOps.delete(operationId)
    completedMoveOps.set(operationId, result)
    while (completedMoveOps.size > MAX_MOVE_OPS) {
      completedMoveOps.delete(completedMoveOps.keys().next().value)
    }
  }
  const rememberPendingSaveMoveOp = (operationId, entry) => {
    if (typeof operationId !== 'string' || operationId === '') return
    pendingSaveMoveOps.delete(operationId)
    pendingSaveMoveOps.set(operationId, entry)
    while (pendingSaveMoveOps.size > MAX_MOVE_OPS) {
      pendingSaveMoveOps.delete(pendingSaveMoveOps.keys().next().value)
    }
  }
  // Atomically stages & persists one or more operation receipts via `rt.save({ required: true })`,
  // ensuring concurrent retries join the same in-flight save and failures roll back per-key cleanly.
  const persistMoveReceipts = (opIds, result) => {
    const validIds = [...new Set(opIds.filter(id => typeof id === 'string' && id !== ''))]
    if (validIds.length === 0) return Promise.resolve(result)
    const p = (async () => {
      for (const id of validIds) addStagedMoveOp(id)
      const staged = stagePersistedMoveOps(validIds.map(id => ({ id, result })))
      try {
        await rt.save({ required: true })
      } catch (error) {
        unstagePersistedMoveOps(staged)
        throw error
      } finally {
        for (const id of validIds) {
          removeStagedMoveOp(id)
          if (inFlightSaveMoveOps.get(id) === p) inFlightSaveMoveOps.delete(id)
        }
      }
      for (const id of validIds) {
        pendingSaveMoveOps.delete(id)
        rememberMoveOp(id, result)
      }
      return result
    })()
    for (const id of validIds) inFlightSaveMoveOps.set(id, p)
    return p
  }
  const listeners = new Set()

  const isLocalCliBot = (bot, session) => {
    const ref = bot?.model ?? bot?.appliedModel ?? rt.cachedDefault?.()
    if (rt.localAgentBadge?.(ref) !== undefined || rt.isLocalAgentRef?.(ref) === true) return true
    const provider = session?.requestHeader?.()?.config?.provider
    return provider !== undefined && rt.isLocalAgentRoute?.(provider) === true
  }
  const isLocalCliSession = (sessionId) => {
    if (sessionId === undefined) return false
    const botId = rt.chatOwners.get(sessionId) ?? rt.groupOwners.get(sessionId)?.botId ?? rt.taskOwners?.get(sessionId)?.botId
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    const session = ctx.get('agents')?.get(sessionId)?.session
    return isLocalCliBot(bot, session)
  }
  const hasPendingUserInbox = (agent) =>
    (agent?.inbox?.nextStep ?? []).some(msg => msg?.source?.kind === 'user')
    || (agent?.inbox?.nextTurn ?? []).some(msg => msg?.source?.kind === 'user')
  const hasBlockingInteractiveCard = (bot, sessionId) => {
    if (state.questions?.[sessionId] !== undefined || state.views?.[sessionId] !== undefined) return true
    if (bot === undefined) return false
    const pendingOn = (map) => (map?.[bot.id] ?? []).some(
      entry => entry?.status === 'pending' && (entry.sessionId === undefined || entry.sessionId === sessionId),
    )
    return pendingOn(state.secretRequests) || pendingOn(state.connectorRequests) || pendingOn(state.mailRequests)
  }

  const onTaskEvent = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const emitTaskEvent = (type, bot, task, extra = {}) => {
    const payload = {
      type,
      botId: bot.id,
      ...(task.roomId !== undefined ? { roomId: task.roomId } : {}),
      taskId: task.id,
      sessionId: task.sessionId,
      title: task.title,
      status: task.status,
      timestamp: Date.now(),
      ...extra,
    }
    for (const listener of listeners) {
      try { listener(payload) } catch (error) { rt.warn('ds-bot: task event listener failed: %s', error) }
    }
  }

  const tasksOf = bot => (Array.isArray(bot?.tasks) ? bot.tasks : [])
  const scopedTasksOf = (bot, roomId) => tasksOf(bot).filter(task => (task?.roomId ?? undefined) === roomId)
  const findTask = (bot, ref, roomId) => {
    const key = oneLine(ref, TITLE_MAX)
    if (key === '') return undefined
    const list = roomId === null ? tasksOf(bot) : scopedTasksOf(bot, roomId)
    return list.find(task => task?.id === key) ?? list.filter(task => task?.title === key).at(-1)
  }
  const findTaskGlobal = (taskId) => {
    for (const bot of Object.values(state.bots)) {
      const task = tasksOf(bot).find(item => item?.id === taskId)
      if (task !== undefined) return { bot, task }
    }
    return undefined
  }
  const taskBySession = (sessionId) => {
    const owned = sessionId === undefined ? undefined : rt.taskOwners?.get(sessionId)
    if (owned === undefined) return undefined
    const bot = rt.botOf(owned.botId)
    const task = tasksOf(bot).find(item => item?.id === owned.taskId)
    return bot === undefined || task === undefined ? undefined : { bot, task }
  }

  const writeReportFile = (taskId, text) => {
    if (rt.readOnly?.() !== undefined) return undefined
    const name = safeFileName(taskId)
    const target = join(reportsDir, name)
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(reportsDir, { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, target)
      return name
    } catch (error) {
      rt.warn('ds-bot: report of task %s not written: %s', taskId, error)
      try { rmSync(temp, { force: true }) } catch {}
      return undefined
    }
  }
  const readReportFile = (file) => {
    if (typeof file !== 'string' || !/^[A-Za-z0-9_-]+\.txt$/.test(file)) return undefined
    try { return readFileSync(join(reportsDir, file), 'utf8') } catch { return undefined }
  }
  const dropReportFile = (file) => {
    if (typeof file !== 'string' || !/^[A-Za-z0-9_-]+\.txt$/.test(file)) return true
    if (rt.readOnly?.() !== undefined) return false
    try {
      rmSync(join(reportsDir, file), { force: true })
      return true
    } catch {
      return false
    }
  }

  const forgetTaskSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    admittedRpcIds.delete(sessionId)
    rejectEmptyTaskWake.delete(sessionId)
  }

  const cleanPrunedSession = (id) => {
    for (const entries of [state.closedCards, state.exchangeTurns, state.questions, state.views, state.switching]) {
      if (entries !== undefined) delete entries[id]
    }
    forgetTaskSession(id)
    rt.renewMemory?.(id)
    rt.forgetSessionParts?.(id)
    rt.forgetSessionTurn?.(id)
    rt.forgetSessionModel?.(id)
    return rt.deleteSegmentNotes?.([id])
  }

  const sessionBusy = (id) => {
    const agent = ctx.get('agents')?.get(id)
    return agent?.status === 'running' || hasWakingInboxInput(agent) || rt.live.get(id)?.turn !== undefined
      || rt.hasPendingRecovery(id) || rt.isSwitchingPart?.(id) || state.switching?.[id] !== undefined
      || (rt.runningJobs?.(id)?.length ?? 0) > 0
  }

  const hasSessionOwner = id => rt.agentOf(id) !== undefined
    || rt.chatOwners.has(id) || rt.pastOwners.has(id) || rt.groupOwners.has(id) || rt.roomOwners.has(id)
  const isInherited = id => Object.values(state.bots).some(bot => tasksOf(bot).some(task =>
      task.from === id || task.inheritedSegments?.some(segment => segment.sessionId === id)))

  const retiredTasks = () => Array.isArray(state.retiredTasks) ? state.retiredTasks : []
  const hasExcessSettledTasks = bot => tasksOf(bot).filter(task => !isActiveTask(task)).length > MAX_SETTLED_TASKS
  const pendingHandoff = botId => Array.isArray(state.pendingHandoffInputs)
    && state.pendingHandoffInputs.some(item => item?.botId === botId)
  const reportPending = (taskId) => {
    const report = info => info?.role === 'task-report' && info.taskId === taskId
    return rt.hasPendingTaskReport(taskId) || [...rt.live.values()].some(entry =>
      report(entry.info) || report(entry.pending) || report(entry.carry?.info) || entry.claimed?.some(report)
      || entry.later?.some(item => report(item.info)) || entry.carry?.later?.some(item => report(item.info)))
  }

  const retirementTarget = ({ botId, roomId }) => {
    if (rt.botOf(botId) === undefined) return undefined
    if (roomId === undefined) return rt.chatOf(botId)
    const room = rt.roomOf(roomId)
    return room?.members.includes(botId) ? room.sessions?.[botId] : undefined
  }

  const ownedTaskSessionIds = (task) => {
    const inherited = new Set((task.inheritedSegments ?? []).map(segment => segment?.sessionId))
    return taskSessionIds(task).filter(id => id !== task.from && !inherited.has(id))
  }

  function pruneSettledTasks(bot, keepSessions) {
    const settled = tasksOf(bot).filter(task => !isActiveTask(task))
    const excess = settled.length - MAX_SETTLED_TASKS
    if (excess <= 0) return []
    const dropped = new Set()
    for (const task of settled.slice(0, excess)) {
      const ids = taskSessionIds(task)
      if (settling.has(task.id) || delivering.has(task.id) || reportPending(task.id)
        || hasOpenOutgoingWorks(bot, task) || ids.some(id => keepSessions.has(id) || sessionBusy(id))
        || (task.origin === 'fg-handoff' && (handoffing.has(bot.id) || pendingHandoff(bot.id)))) continue
      state.retiredTasks = [...retiredTasks(), { botId: bot.id, roomId: task.roomId, sessionIds: ownedTaskSessionIds(task), reportFile: task.reportFile }]
      // The logs can outlive both the task and the Bot. Preserve ownership for the
      // privacy checks, including if the user turns privacy on after pruning.
      bot.retiredTaskSessions = [...new Set([...retiredTaskSessionIds(bot), ...ids])]
      dropped.add(task)
    }
    if (dropped.size > 0) bot.tasks = tasksOf(bot).filter(task => !dropped.has(task))
    return [...dropped]
  }

  let retirement = Promise.resolve()
  let retirementStopped = false
  let retirementRetryTimer
  let retirementRetryDelay = 1000
  const writeAccess = () => retirementStopped || rt.readOnly() !== undefined ? undefined : rt.teamWriteAccess()
  const ownsRetirement = () => writeAccess() === 'locked'

  function resetRetirementRetry() {
    clearTimeout(retirementRetryTimer)
    retirementRetryTimer = undefined
    retirementRetryDelay = 1000
  }

  function retryRetirement() {
    if (retirementRetryTimer !== undefined || !ownsRetirement()) return
    retirementRetryTimer = setTimeout(() => {
      retirementRetryTimer = undefined
      if (ownsRetirement()) void retireTasks()
    }, retirementRetryDelay)
    retirementRetryTimer.unref?.()
    retirementRetryDelay = Math.min(retirementRetryDelay * 2, 15_000)
  }

  async function updateRetirement(entry, next) {
    const before = retiredTasks()
    const after = before.flatMap(item => item === entry ? (next === undefined ? [] : [next]) : [item])
    state.retiredTasks = after
    try {
      await rt.save({ required: true })
    } catch (error) {
      if (state.retiredTasks === after) state.retiredTasks = before
      throw error
    }
  }

  function retireTasks(bots = [], keepSessions = new Set()) {
    retirement = retirement.then(async () => {
      const access = writeAccess()
      if (access === undefined) return
      const pruned = bots.filter(bot => rt.botOf(bot.id) === bot)
        .flatMap(bot => pruneSettledTasks(bot, keepSessions))
      const pending = retiredTasks().slice()
      if (pruned.length === 0 && (access !== 'locked' || pending.length === 0)) return
      await rt.save({ required: true })
      if (access !== 'locked') return
      let retry = false
      for (const entry of pending) {
        const current = () => ownsRetirement() && retiredTasks().includes(entry)
        if (!current()) return
        const remaining = []
        for (const id of entry.sessionIds) {
          if (!current()) return
          if (hasSessionOwner(id)) continue
          if (keepSessions.has(id) || sessionBusy(id) || isInherited(id) || pendingHandoff(entry.botId) || handoffing.has(entry.botId)) {
            remaining.push(id)
            continue
          }
          try {
            const target = retirementTarget(entry)
            if (target !== undefined) await rt.moveSchedules(id, target)
            if (!current()) return
            if (hasSessionOwner(id)) continue
            if (sessionBusy(id) || isInherited(id) || pendingHandoff(entry.botId) || handoffing.has(entry.botId)
              || retirementTarget(entry) !== target) {
              remaining.push(id)
              continue
            }
            await ctx.workspaceRegistry.archiveSession(id)
          } catch (error) {
            if (error?.name !== 'WorkspaceUnknownSessionError' || error.sessionId !== id) {
              remaining.push(id)
              if (error?.code !== 'schedule/pending') {
                rt.warn('ds-bot: task Session %s not archived yet: %s', id, error)
                retry = true
              }
              continue
            }
          }
          if (!current()) return
          if (!hasSessionOwner(id)) await cleanPrunedSession(id)
        }
        if (!current()) return
        if (remaining.length > 0 && remaining.length === entry.sessionIds.length) continue
        let completed = entry
        if (entry.sessionIds.length > 0) {
          completed = { ...entry, sessionIds: remaining }
          await updateRetirement(entry, completed)
        }
        if (remaining.length > 0 || !ownsRetirement() || !retiredTasks().includes(completed)) continue
        // An empty entry records completed archiving before removing the report.
        // If the host stops between these writes, cleanup can be tried again.
        if (dropReportFile(completed.reportFile)) await updateRetirement(completed, undefined)
      }
      if (retry) retryRetirement()
      else resetRetirementRetry()
    }).catch(error => rt.warn('ds-bot: retiring background task Sessions failed: %s', error))
    return retirement
  }

  function stopRetiringTasks() {
    retirementStopped = true
    resetRetirementRetry()
    return retirement
  }

  function retireSettledTasksAfterIdle(sessionId) {
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (hasExcessSettledTasks(bot)) void retireTasks([bot])
    else if (retiredTasks().some(entry => entry.sessionIds.includes(sessionId))) void retireTasks()
  }

  // Checks whether any outgoing Bot-to-Bot or group report-back work originated from
  // this task's thread is still open and waiting for a reply.
  const hasOpenOutgoingWorks = (bot, task) => {
    const works = state.works ?? {}
    for (const work of Object.values(works)) {
      if (work?.from !== bot.id || work.fromPart === undefined) continue
      const thread = threadOfPart(bot, work.fromPart)
      if (thread?.thread === 'task' && thread.taskId === task.id) return true
    }
    return false
  }

  // Measures parent-session size in O(1) via DSH `session.seq`, falling back to
  // snapshot length for test stubs without `seq`.
  const sourceSessionOf = (sessionId) => ctx.get?.('agents')?.get(sessionId)?.session
    ?? ctx.get?.('sessions')?.get(sessionId)
    ?? ctx.sessions?.get?.(sessionId)
  const sourceEventCountOf = (sessionId) => {
    const session = sourceSessionOf(sessionId)
    if (session === undefined) return 0
    const seq = session.seq
    if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq
    const events = session.snapshotEvents?.()
    return Array.isArray(events) ? events.length : 0
  }
  const lastSeqOf = (session) => {
    if (session === undefined || session === null) return undefined
    const seq = session.seq
    if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq - 1
    const events = session.snapshotEvents?.()
    if (Array.isArray(events)) {
      if (events.length === 0) return -1
      const last = events.at(-1)?.seq
      return Number.isInteger(last) ? last : events.length - 1
    }
    return undefined
  }
  const resolveTaskForkMaxEvents = (options) => {
    for (const candidate of [options?.taskForkMaxEvents, rt.config?.taskForkMaxEvents]) {
      if (candidate !== undefined && candidate !== null) {
        const limit = Number(candidate)
        if (Number.isInteger(limit) && limit >= 0) return limit
      }
    }
    return TASK_FORK_MAX_EVENTS
  }

  // Builds a bounded recent-context note when the task could not fork directly
  // (e.g. first turn with no turn/end, different workdir, local CLI agent, or
  // parent session above TASK_FORK_MAX_EVENTS).
  // Preserves the latest [Handoff] or [Checkpoint] structured note with headings
  // intact instead of flattening and clipping it to 1,000 characters.
  const fallbackContextSummary = (fromSessionId) => {
    const sourceSession = sourceSessionOf(fromSessionId)
    const events = sourceSession?.snapshotEvents?.() ?? []
    if (events.length === 0) return ''
    let latestNote = ''
    let shadowedEnd = -1
    for (const event of events) {
      if (event.type === 'compaction/summary') {
        const cleaned = cleanStructuredNote(event.data?.summary)
        if (cleaned !== '') latestNote = cleaned
        if (Number.isInteger(event.data?.shadowedRange?.end) && event.data.shadowedRange.end > shadowedEnd) {
          shadowedEnd = event.data.shadowedRange.end
        }
      } else if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.handoff === true) {
        const raw = textOf(event.data?.message?.content ?? event.data?.content ?? '').trim()
        const cleaned = cleanStructuredNote(raw, { handoff: true })
        if (cleaned !== '') latestNote = cleaned
      }
    }
    const lines = []
    for (const event of events) {
      if (shadowedEnd >= 0 && Number.isInteger(event.seq) && event.seq <= shadowedEnd) continue
      if (event.type === 'user/message') {
        const source = event.data?.source
        if (source?.kind === 'runtime-context' || source?.kind === 'compact-checkpoint') continue
        if (source?.kind === SOURCE_KIND && (source.handoff === true || source.role === 'task-handoff' || (source.role === 'request' && source.audience !== 'user'))) continue
        const text = textOf(event.data?.message?.content ?? event.data?.content ?? '').trim()
        if (text !== '') lines.push(`User: ${oneLine(text, 1000)}`)
      } else if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content ?? []).trim()
        if (text !== '' && text !== HANDOFF_ACK) lines.push(`Assistant: ${oneLine(text, 1000)}`)
      }
    }
    if (latestNote === '' && lines.length === 0) return ''
    const tailBudget = latestNote === ''
      ? CONTEXT_FALLBACK_MAX
      : Math.max(0, CONTEXT_FALLBACK_MAX - Math.min(latestNote.length, CONTEXT_FALLBACK_NOTE_MIN) - 2)
    const selected = []
    let chars = 0
    let truncated = false
    const tail = lines.slice(-CONTEXT_FALLBACK_ITEMS)
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const line = tail[i]
      const extra = selected.length === 0 ? line.length : line.length + 1
      if (tailBudget === 0) {
        truncated = true
        break
      }
      if (selected.length > 0 && chars + extra > tailBudget) {
        truncated = true
        break
      }
      const kept = selected.length === 0 && line.length > tailBudget
        ? `${line.slice(0, tailBudget)}…`
        : line
      selected.push(kept)
      chars += selected.length === 1 ? kept.length : kept.length + 1
    }
    truncated ||= lines.length > CONTEXT_FALLBACK_ITEMS
    const tailBody = selected.reverse().join('\n')
    const clippedTail = tailBody === '' ? '' : (truncated ? `…\n${tailBody}` : tailBody)
    let body
    if (latestNote !== '') {
      const noteBudget = clippedTail === ''
        ? CONTEXT_FALLBACK_MAX
        : Math.max(CONTEXT_FALLBACK_NOTE_MIN, CONTEXT_FALLBACK_MAX - clippedTail.length - 2)
      const keptNote = clipStructuredNote(latestNote, noteBudget)
      body = clippedTail === '' ? keptNote : `${keptNote}\n\n${clippedTail}`
    } else {
      body = clippedTail
    }
    const room = rt.roomOf(rt.groupOwners.get(fromSessionId)?.roomId)
    const label = room !== undefined ? `group "${room.name}"` : 'your own chat'
    return `\n\n[Recent context from ${label}]\n${body}`
  }

  const lastReplyOf = (session, workDir) => {
    const all = session?.snapshotEvents?.() ?? []
    const inherited = Number.isInteger(session?.inheritedEventCount) && session.inheritedEventCount > 0 ? session.inheritedEventCount : 0
    const events = inherited > 0 ? all.slice(inherited) : all
    const lastTurnStart = events.findLastIndex(event => event.type === 'turn/start')
    const slice = lastTurnStart === -1 ? events : events.slice(lastTurnStart)
    const folder = rt.sessionFolder?.(session) ?? workDir
    const replies = []
    for (const event of slice) {
      if (event.type !== 'assistant/message') continue
      const text = textOf(event.data?.message?.content ?? []).trim()
      if (text !== '') replies.push(folder ? absoluteLinks(text, folder) : text)
    }
    return replies.join('\n\n').trim()
  }

  const statusOf = (task) => {
    if (task === undefined) return undefined
    if (!isActiveTask(task)) return task.status
    if (rt.waitsForApproval?.(task.sessionId)) return 'waiting_approval'
    const bot = Object.values(state.bots).find(item => tasksOf(item).includes(task))
    if (bot !== undefined && hasOpenOutgoingWorks(bot, task)) return 'waiting_work'
    return task.status
  }

  const taskViewOf = (bot) => tasksOf(bot).map(task => ({
    id: task.id,
    title: task.title,
    status: statusOf(task),
    sessionId: task.sessionId,
    ...(task.roomId ? { roomId: task.roomId } : {}),
    ...(task.origin ? { origin: task.origin } : {}),
    ...(Array.isArray(task.segments) && task.segments.length > 0 ? { parts: task.segments.map(segment => segment.sessionId) } : {}),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt ?? task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.workDir ? { workDir: task.workDir } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.error ? { error: task.error } : {}),
    running: isActiveTask(task) && (rt.live.get(task.sessionId)?.turn !== undefined || (rt.runningJobs?.(task.sessionId)?.length ?? 0) > 0),
  }))

  // Settles a task into a terminal state (`completed`, `failed`, `stopped`, `interrupted`),
  // closes any parent handoff sub-work, notifies the foreground chat via `rt.deliver`
  // (restoring IM origin if captured), and fires `onTaskEvent`.
  async function settleTask(bot, task, outcome, { text = '', error, notifyForeground = true, settleWork = true } = {}) {
    if (settling.has(task.id) || !isActiveTask(task)) return
    settling.add(task.id)
    let settled = false
    try {
      const now = Date.now()
      task.status = outcome
      task.updatedAt = now
      task.endedAt = now
      if (error !== undefined && error !== '') task.error = oneLine(error, 300)

      const fullText = String(text ?? '').trim()
      if (fullText !== '') {
        task.summary = oneLine(fullText, SUMMARY_MAX)
        if (fullText.length > REPORT_MAX) {
          const file = writeReportFile(task.id, fullText)
          if (file !== undefined) task.reportFile = file
        }
      }

      // Close child work on the handoff tree before waking the foreground so
      // `turns.js` knows this branch is settled when the foreground runs next.
      let parentWork
      if (task.workId !== undefined) {
        const resultSummary = outcome === 'completed'
          ? (fullText || '(completed with no reply text)')
          : outcome === 'failed'
            ? `Background task "${task.title}" failed: ${task.error ?? 'model call failed'}`
            : outcome === 'interrupted'
              ? `Background task "${task.title}" was interrupted by a restart.`
              : `Background task "${task.title}" was stopped.`
        parentWork = rt.closeWork?.(task.workId, `task "${task.title}"`, resultSummary)
      }

      if (task.roomId !== undefined && outcome !== 'completed') {
        const cause = outcome === 'interrupted' ? { cause: 'restarted' }
          : outcome === 'stopped' ? { cause: 'stopped' }
          : { cause: 'failed', code: 'TASK' }
        rt.blockTasks?.(task.roomId, bot.id, cause)
      }

      await rt.save()
      settled = true
      emitTaskEvent(`task.${outcome}`, bot, task, {
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.error ? { error: task.error } : {}),
      })

      // A `bot-handoff` task answers the asking Bot through turns.js/handoffs.js and
      // never posts a task-report into the user's foreground chat. If the work is still
      // open (stopped via stopTask or interrupted by restart before turns.js closed it),
      // answer the asking Bot once here and clear `liveEntry.info` so any ensuing
      // `turn/end (aborted)` from `agent.cancel()` can never emit a duplicate reply.
      if (task.origin === 'bot-handoff') {
        // On `completed`, `turns.js` owns the reply delivery (including async `attachLong`
        // for >20k replies); only send the fallback notice on non-completed outcomes so we
        // never race `attachLong` with a false "stopped" reply.
        if (settleWork && outcome !== 'completed' && task.exchangeId !== undefined && rt.ownsWork?.(bot.id, task.exchangeId)) {
          const asker = rt.workAsker?.(task.exchangeId)
          if (asker !== undefined) {
            const liveEntry = rt.live.get(task.sessionId)
            if (liveEntry?.info !== undefined && rt.workOf?.(liveEntry.info) === task.exchangeId) {
              liveEntry.info = undefined
            }
            const notice = outcome === 'interrupted'
              ? `${bot.name} was interrupted by a restart before it could answer your message.`
              : outcome === 'failed'
                ? `${bot.name} could not answer your message: ${task.error ?? 'model call failed'}.`
                : `${bot.name} was stopped before it could answer your message.`
            answerSender(rt, task.sessionId, asker, notice, undefined, { aborted: true })
          }
        }
        return
      }

      if (!notifyForeground && parentWork === undefined) return
      let targetSession
      if (task.roomId !== undefined) {
        const room = rt.roomOf(task.roomId)
        if (room === undefined || !room.members.includes(bot.id)) return
        targetSession = room.sessions?.[bot.id]
        if (targetSession === undefined) {
          await rt.reconcileStoppedRoomTask?.(task.roomId, bot.id).catch(() => {})
          return
        }
      } else {
        // Keep moved-foreground reports targeting the latest foreground chat even if
        // `task.from` was later moved into a second successive background task.
        targetSession = task.origin === 'fg-handoff' || threadOfPart(bot, task.from)?.thread === 'task'
          ? rt.chatOf(bot.id)
          : (threadCurrentOfPart(bot, task.from) ?? rt.chatOf(bot.id))
      }
      let body
      let note
      if (outcome === 'completed') {
        note = `"${task.title}" (${task.id}) finished`
        body = fullText.length > REPORT_MAX
          ? `${fullText.slice(0, REPORT_MAX)}…\n[Truncated at ${REPORT_MAX} characters. Call task_read(task: "${task.id}") for the full report.]`
          : (fullText || '(no reply text)')
      } else if (outcome === 'failed') {
        note = `"${task.title}" (${task.id}) failed`
        body = `This background task failed: ${task.error ?? 'unknown error'}.${fullText ? `\n\nLast output:\n${fullText.slice(0, REPORT_MAX)}` : ''}`
      } else if (outcome === 'interrupted') {
        note = `"${task.title}" (${task.id}) interrupted by restart`
        body = 'DeepSeek Harness restarted while this background task was waiting on an in-memory background command or pending step, so it did not finish. Tell the user or start a new task if needed.'
      } else {
        note = `"${task.title}" (${task.id}) stopped`
        body = task.error ? `Stopped: ${task.error}` : 'This background task was stopped.'
      }

      try {
        await rt.deliver({
          toId: bot.id,
          sessionId: targetSession,
          text: body,
          role: 'task-report',
          note,
          taskId: task.id,
          ...(task.roomId !== undefined ? { roomId: task.roomId } : {}),
          recordExchange: false,
          ...(parentWork !== undefined ? { work: parentWork, replyTo: task.workId } : {}),
        })
      } catch (error) {
        if (task.roomId !== undefined) {
          await rt.reconcileStoppedRoomTask?.(task.roomId, bot.id).catch(() => {})
        }
        throw error
      }
    } catch (error) {
      settled = false
      throw error
    } finally {
      for (const sid of taskSessionIds(task)) {
        forgetTaskSession(sid)
        rt.renewMemory?.(sid)
        rt.forgetSessionParts?.(sid)
        rt.forgetSessionTurn?.(sid)
      }
      settling.delete(task.id)
      if (settled && (hasExcessSettledTasks(bot) || retiredTasks().length > 0)) await retireTasks([bot])
    }
  }

  // Starts a background task for a Bot from either its foreground own chat or a group member Session.
  async function startTask(fromSessionId, { title, brief, workdir }, exec, options = {}) {
    if (rt.taskOwners?.has(fromSessionId)) {
      throw Object.assign(new Error('Background tasks cannot start nested background tasks. Finish this task and report back to your chat instead.'), { code: 'bot/invalid' })
    }
    const groupOwner = rt.groupOwners.get(fromSessionId)
    const room = groupOwner === undefined ? undefined : rt.roomOf(groupOwner.roomId)
    const botId = groupOwner !== undefined ? groupOwner.botId : rt.chatOwners.get(fromSessionId)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (bot === undefined || (groupOwner !== undefined && (room === undefined || !room.members.includes(bot.id)))) {
      throw Object.assign(new Error('Only a Bot\'s own chat or a group chat member can start background tasks.'), { code: 'bot/invalid' })
    }
    const name = oneLine(title, TITLE_MAX)
    const detail = String(brief ?? '').trim()
    if (name === '' || detail === '') {
      throw Object.assign(new Error('A task needs both a title and a brief.'), { code: 'bot/invalid' })
    }

    let resolvedDir
    if (workdir !== undefined && String(workdir).trim() !== '') {
      const cleaned = await rt.cleanWorkDir?.(String(workdir).trim())
      const candidate = cleaned ?? rt.teamFolder?.()
      if (candidate !== undefined) {
        if (room?.workDir !== undefined) {
          const realCandidate = await (rt.real ? rt.real(candidate) : Promise.resolve(resolve(candidate)))
          const realRoom = await (rt.real ? rt.real(room.workDir) : Promise.resolve(resolve(room.workDir)))
          if (!within(realCandidate, realRoom)) {
            throw Object.assign(new Error(`Every member of "${room.name}" works in ${room.workDir} here, so background tasks in this group must stay inside it.`), { code: 'bot/invalid' })
          }
        }
        if (bot.private === true && bot.workDir !== undefined) {
          const realCandidate = await (rt.real ? rt.real(candidate) : Promise.resolve(resolve(candidate)))
          const realOwn = await (rt.real ? rt.real(bot.workDir) : Promise.resolve(resolve(bot.workDir)))
          if (!within(realCandidate, realOwn)) {
            throw Object.assign(new Error(`${bot.name} is a private Bot and its background tasks must stay inside ${bot.workDir}.`), { code: 'bot/invalid' })
          }
        }
      }
      if (cleaned !== undefined) {
        if (await rt.inData?.(cleaned)) {
          throw Object.assign(new Error('A task cannot work inside the DSH or DS Bot data folder.'), { code: 'bot/invalid' })
        }
        const clash = await rt.privateClash?.(cleaned, { except: bot.id })
        if (clash !== undefined) {
          throw Object.assign(new Error(`${cleaned} is in or around the folder of ${clash.name}, a private Bot, so this task cannot work there.`), { code: 'bot/invalid' })
        }
        if (exec !== undefined && typeof rt.approveFolder === 'function') {
          await rt.approveFolder(exec, {
            path: cleaned,
            sessions: [fromSessionId],
            who: { en: `${bot.name}'s background task`, zh: `${bot.name} 的后台任务` },
          })
        }
        resolvedDir = cleaned
      } else {
        resolvedDir = null
      }
    }

    const id = newId()
    const now = Date.now()
    const imOrigin = room !== undefined ? rt.captureImOrigin?.(rt.sessionOfRoom(room)) : rt.captureImOrigin?.(fromSessionId)
    // When a group has no direct IM binding/origin of its own, capture an untainted
    // IM dispatch approval route separately so task approvals reach the IM caller
    // without claiming the group's own Session or streaming unrelated group lines.
    const dispatchApprovalOrigin = room !== undefined && imOrigin === undefined
      ? rt.roomReportImOrigin?.(room.id, bot.id)
      : undefined
    // Link into the DM handoff tree when a foreground DM turn is answering another Bot.
    // Group tasks participate in group dispatch batches via `hasRoomTasks` instead.
    const liveEntry = rt.live.get(fromSessionId)
    const parentWork = room === undefined ? rt.workOf?.(liveEntry?.info) : undefined
    const linkWork = parentWork !== undefined && rt.ownsWork?.(bot.id, parentWork)
    const taskWorkId = linkWork ? `task:${id}` : undefined

    const inherited = room === undefined ? slimSegments(bot) : []
    const baseTask = {
      id,
      title: name,
      brief: oneLine(detail, BRIEF_KEPT),
      from: fromSessionId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      ...(room !== undefined ? { roomId: room.id } : {}),
      ...(inherited.length > 0 ? { inheritedSegments: inherited } : {}),
      ...(taskWorkId !== undefined ? { workId: taskWorkId, parentWorkId: parentWork } : {}),
      ...(imOrigin !== undefined ? { imOrigin } : {}),
      ...(dispatchApprovalOrigin !== undefined ? { dispatchApprovalOrigin } : {}),
    }

    const shouldFork = sourceEventCountOf(fromSessionId) <= resolveTaskForkMaxEvents(options)
    const fromThroughSeq = room === undefined ? lastSeqOf(sourceSessionOf(fromSessionId)) : undefined
    const { sessionId, forked, task } = await rt.openTaskPart(bot, fromSessionId, baseTask, { workDir: resolvedDir, fork: shouldFork, throughSeq: fromThroughSeq })
    if (taskWorkId !== undefined) {
      rt.openWork?.(taskWorkId, { from: bot.id, parent: parentWork, toSession: sessionId, toTaskId: id, name: `task "${name}"`, child: id })
    }
    if (room !== undefined) rt.workRoomTurn?.(fromSessionId, 'task')

    const isLocal = isLocalCliBot(bot, ctx.get('agents')?.get(fromSessionId)?.session)
    const contextNote = forked ? '' : fallbackContextSummary(fromSessionId)
    const localNote = isLocal ? '\nNote: You are running in a separate local CLI session that does not share in-memory state with the foreground chat.' : ''
    const dirNote = resolvedDir ? `\nWorking directory: ${resolvedDir}` : ''
    const reportDest = room !== undefined ? `your session in group "${room.name}"` : 'your own chat'
    const prompt = `${detail}${dirNote}${localNote}${contextNote}\n\nDo this work here. The user does not chat directly in this task session; do not call ask_user, show_view, request_secret, or task_* tools. When you finish, your final reply is sent back to ${reportDest}, so make it complete and self-contained.`

    try {
      await rt.deliver({
        toId: bot.id,
        sessionId,
        text: prompt,
        role: 'task',
        note: `"${name}" (${id})`,
        taskId: id,
        recordExchange: false,
      })
    } catch (error) {
      await settleTask(bot, task, 'failed', { error: error?.message ?? String(error), notifyForeground: false })
      throw error
    }

    emitTaskEvent('task.started', bot, task)
    return { ...task, sessionId, forked }
  }

  async function stopTask(bot, task, reason = 'stopped', { notifyForeground = false } = {}) {
    if (bot === undefined || task === undefined) return false
    const wasActive = isActiveTask(task)
    const sessionId = task.sessionId
    try {
      if (wasActive) {
        // Mark stopped and save before cancelling so the ensuing turn/end never
        // misclassifies the cancellation as a completed task.
        await settleTask(bot, task, 'stopped', { error: reason, notifyForeground })
      }
    } finally {
      // Always cancel approvals, shell jobs, and the running agent even if saving or
      // foreground delivery failed (e.g. disk full).
      rt.cancelApprovals?.(sessionId)
      const jobs = ctx.get?.('jobs')
      for (const job of rt.runningJobs?.(sessionId) ?? []) {
        try { jobs?.kill(job.id, sessionId, reason) } catch { /* already ended */ }
      }
      ctx.get('agents')?.get(sessionId)?.cancel({ kind: 'hook', reason: 'ds-bot: task stopped' })
    }
    return wasActive
  }

  async function stopAllTasksOfBot(bot, reason = 'stopped') {
    const rooms = new Set()
    for (const task of activeTasksOf(bot)) {
      if (task.roomId !== undefined) rooms.add(task.roomId)
      await stopTask(bot, task, reason, { notifyForeground: false })
    }
    for (const roomId of rooms) {
      await rt.reconcileStoppedRoomTask?.(roomId, bot.id)
        .catch(error => rt.warn('ds-bot: reconciling stopped group task for %s in %s failed: %s', bot.name, roomId, error))
    }
  }

  // Stable-ID direct delivery for task_send and v0.4.0 event-driven subscriptions.
  async function deliverToTask(taskId, { text, role = 'task-followup', note, steer = true } = {}) {
    const found = findTaskGlobal(taskId)
    if (found === undefined) throw Object.assign(new Error(`Unknown task ${taskId}`), { code: 'bot/not-found' })
    const { bot, task } = found
    if (!isActiveTask(task) || settling.has(task.id)) {
      throw Object.assign(new Error(`Task "${task.title}" is ${task.status} and cannot receive messages.`), { code: 'bot/invalid' })
    }
    delivering.add(task.id)
    try {
      task.status = 'running'
      task.updatedAt = Date.now()
      await rt.save()
      if (!isActiveTask(task) || settling.has(task.id)) {
        throw Object.assign(new Error(`Task "${task.title}" is ${task.status} and cannot receive messages.`), { code: 'bot/invalid' })
      }
      await rt.deliver({
        toId: bot.id,
        sessionId: task.sessionId,
        text: String(text ?? ''),
        role,
        note: note ?? `"${task.title}" (${task.id})`,
        taskId: task.id,
        steer,
        recordExchange: false,
      })
      return { botId: bot.id, taskId: task.id, sessionId: task.sessionId }
    } finally {
      delivering.delete(task.id)
    }
  }

  // Cleanup reports when a Bot is deleted.
  const forgetBotTasks = (bot) => {
    forgetTaskSession(bot?.id)
    forgetTaskSession(rt.chatOf?.(bot?.id))
    for (const task of tasksOf(bot)) {
      rt.cancelApprovals?.(task.sessionId)
      dropReportFile(task.reportFile)
      for (const sid of taskSessionIds(task)) forgetTaskSession(sid)
    }
  }

  // In real DSH (`dsh-agent-loop`), `agent.inject()` enqueues into `inbox.nextStep`
  // with `wake = false`, so non-waking injections (`note_bot`, `cancel_work`, `stop_bot`,
  // `task-handoff`, runtime snapshots, etc.) sit in `nextStep` while idle and will NEVER
  // start a turn. Only waking inbox entries keep a background task waiting for another turn.
  const isNonWakingNextStep = (msg) => {
    const source = msg?.source
    if (source === undefined || source === null) return false
    if (source.silent === true) return true
    if (source.kind === SOURCE_KIND && ['note', 'cancelled', 'stopped', 'task-handoff'].includes(source.role)) return true
    if (source.form === 'snapshot') return true
    return ['working-directory', 'runtime-context', 'time-context', 'ds-bot-time-context', 'bot-memory', 'skill-catalog', 'compact-checkpoint'].includes(source.kind)
  }
  const hasWakingInboxInput = agent => Boolean(
    agent?.inbox?.nextTurn?.length
    || agent?.inbox?.nextStep?.some(msg => !isNonWakingNextStep(msg)),
  )
  const activeTurnInfo = entry => entry?.info ?? entry?.claimed?.find(item => item?.silent !== true)
  // Pending non-opening deliveries (follow-ups, deferred peer requests, answers, replies)
  // still queued for a task session after a turn finishes. Excludes the opening `role: 'task'`
  // prompt itself, which already started the completed turn.
  const hasPendingTaskUnread = sessionId => (rt.unreadOf?.(sessionId) ?? []).some(args => args?.role !== 'task')

  // Settles a task whose turn ended while the plugin was reloading (durable log).
  async function reconcileEndedTask(sessionId, ended) {
    if (rt.readOnly?.() !== undefined) return false
    const found = taskBySession(sessionId)
    if (found === undefined || !isActiveTask(found.task)) return false
    const { bot, task } = found
    const reason = ended?.reason
    if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return false
    if (reason?.kind === 'blocked') return false
    const inspect = ctx.sessionController?.inspect
    const seen = typeof inspect === 'function' ? await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined) : undefined
    const events = Array.isArray(seen?.events) ? seen.events : []
    const lastStart = events.findLastIndex(event => event?.type === 'turn/start')
    const slice = lastStart === -1 ? events : events.slice(lastStart)
    const folder = task.workDir !== undefined ? (task.workDir ?? rt.teamFolder?.()) : rt.workDirOf?.({ botId: bot.id, ...(task.roomId ? { roomId: task.roomId } : {}) })
    const said = slice
      .filter(event => event?.type === 'assistant/message')
      .map(event => textOf(event.data?.message?.content ?? []).trim())
      .filter(Boolean)
      .map(text => (folder ? absoluteLinks(text, folder) : text))
      .join('\n\n')
      .trim()
    const failure = reason?.kind === 'error' ? turnFailure(reason.error) : undefined
    if (reason?.kind !== 'error' && reason?.kind !== 'aborted') {
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      // A child work can already be closed while its reply still waits for replay.
      if (hasWakingInboxInput(agent) || rt.unreadOf?.(sessionId)?.length > 0) return false
    }
    await handleTurnEnd(bot, task, reason, failure, said)
    return true
  }

  const isAwaitingHandoffInput = (task) => task?.origin === 'bot-handoff'
    && task.exchangeId !== undefined
    && ['need_input', 'paused'].includes(rt.workStateOf?.(task.exchangeId))

  // Reconciles active tasks after a host restart:
  //  - tasks still running, resumed, resent, switching parts, or holding queued inbox items stay active;
  //  - tasks waiting on outgoing Bot/group works or ask_back input keep waiting;
  //  - tasks that were idle waiting on in-memory shell jobs or dropped approvals
  //    are marked `interrupted` and reported to the foreground (no zombie tasks).
  async function reconcileTasksAfterRestart(keepSessions = new Set()) {
    if (rt.readOnly?.() !== undefined) return
    const keep = keepSessions instanceof Set ? keepSessions : new Set(Object.keys(keepSessions ?? {}))
    for (const bot of Object.values(state.bots)) {
      for (const task of activeTasksOf(bot)) {
        const sid = task.sessionId
        if (keep.has(sid)) continue
        if (rt.live.get(sid)?.turn !== undefined) continue
        if (state.switching?.[sid] !== undefined || rt.isSwitchingPart?.(sid)) continue
        if ((rt.runningJobs?.(sid)?.length ?? 0) > 0) continue
        if ((rt.unreadOf?.(sid)?.length ?? 0) > 0) continue
        const agent = await rt.resolveAgent(sid).catch(() => undefined)
        if (agent?.status === 'running' || hasWakingInboxInput(agent)) continue
        if (hasOpenOutgoingWorks(bot, task) || isAwaitingHandoffInput(task)) {
          if (task.status !== 'waiting_work') {
            task.status = 'waiting_work'
            task.updatedAt = Date.now()
            await rt.save()
          }
          continue
        }
        await settleTask(bot, task, 'interrupted', { notifyForeground: true })
      }
    }
    // Replay any foreground handoff inputs left on disk by a prior host crash/restart.
    await reconcilePendingHandoffInputs()
    const bots = Object.values(state.bots).filter(hasExcessSettledTasks)
    if (bots.length > 0 || retiredTasks().length > 0) await retireTasks(bots, keep)
  }

  // Replays pending handoff transfer journal entries without re-running the one-shot
  // startup orphan-task sweeper, so deferred retry timers never disturb live tasks.
  async function reconcilePendingHandoffInputs() {
    if (rt.readOnly?.() !== undefined) return
    if (Array.isArray(state.pendingHandoffInputs) && state.pendingHandoffInputs.length > 0) {
      const valid = state.pendingHandoffInputs.filter(entry => entry !== null && typeof entry === 'object')
      if (valid.length !== state.pendingHandoffInputs.length) {
        if (valid.length === 0) delete state.pendingHandoffInputs
        else state.pendingHandoffInputs = valid
        await rt.save().catch(() => {})
      }
      const pending = [...valid]
      const stillPending = id => Array.isArray(state.pendingHandoffInputs)
        && state.pendingHandoffInputs.some(item => item?.id === id)
      let deferredAny = false
      for (const entry of pending) {
        const id = (entry.id ??= entry.source?.rpcId ?? newId())
        if (!stillPending(id)) continue
        if (inFlightTransferIds.has(id)) continue
        const token = ++transferTokenSeq
        entry.token = token
        transferOwnerToken.set(id, token)
        inFlightTransferIds.add(id)
        try {
          const movedSids = new Set()
          while (entry.botId !== undefined && handoffing.has(entry.botId)) {
            const active = handoffing.get(entry.botId)
            if (active?.oldSid !== undefined) movedSids.add(active.oldSid)
            await active?.promise?.catch(() => {})
          }
          if (!stillPending(id)) continue
          let targetSid
          let label
          let bot
          if (entry.roomId !== undefined) {
            const room = rt.roomOf(entry.roomId)
            targetSid = room === undefined ? undefined : rt.sessionOfRoom(room)
            label = room?.name
          } else if (entry.botId !== undefined) {
            bot = rt.botOf(entry.botId)
            targetSid = bot === undefined ? undefined : rt.chatOf(bot.id)
            label = bot?.name
            for (const task of bot?.tasks ?? []) {
              if (task?.origin !== 'fg-handoff') continue
              if (task.sessionId !== undefined) movedSids.add(task.sessionId)
              for (const seg of task.segments ?? []) {
                if (seg?.sessionId !== undefined) movedSids.add(seg.sessionId)
              }
            }
          }
          if (entry.originalSessionId !== undefined && entry.originalSessionId !== targetSid) {
            movedSids.add(entry.originalSessionId)
          }
          if (entry.recipientSessionId !== undefined && entry.recipientSessionId !== targetSid) {
            movedSids.add(entry.recipientSessionId)
          }
          for (const visited of entry.visitedSessionIds ?? []) {
            if (visited !== undefined && visited !== targetSid) movedSids.add(visited)
          }
          if (targetSid === undefined || rt.taskOwners?.has(targetSid)) {
            await clearPendingTransfers([{ id, token }])
            continue
          }
          let matchedAgent
          let anyMovedUnreadable = false
          for (const sid of movedSids) {
            if (sid === targetSid) continue
            const movedAgent = ctx.get('agents')?.get(sid) ?? await rt.resolveAgent(sid).catch(() => undefined)
            if (movedAgent === undefined) {
              anyMovedUnreadable = true
              continue
            }
            if (isAdmittedOn(movedAgent, id)
              || (entry.messageId !== undefined && isAdmittedOn(movedAgent, entry.messageId))
              || (entry.source?.rpcId !== undefined && isAdmittedOn(movedAgent, entry.source.rpcId))) {
              matchedAgent = movedAgent
              break
            }
          }
          if (matchedAgent !== undefined) {
            let flushed = false
            try {
              if (typeof ctx.sessions?.flush === 'function' && matchedAgent.session !== undefined) {
                flushed = (await ctx.sessions.flush(matchedAgent.session)) === true
              }
            } catch {
              flushed = false
            }
            if (flushed) await clearPendingTransfers([{ id, token }])
            else deferredAny = true
            continue
          }
          if (anyMovedUnreadable) {
            deferredAny = true
            continue
          }
          await forwardPulledMessages(targetSid, [{
            msg: { id: entry.messageId ?? id, content: entry.content, source: entry.source },
            target: entry.target === 'next-step' ? 'next-step' : 'next-turn',
            transferId: id,
            transferToken: token,
          }], label, {
            ...(entry.botId !== undefined ? { botId: entry.botId } : {}),
            ...(entry.roomId !== undefined ? { roomId: entry.roomId } : {}),
          })
          if (stillPending(id)) deferredAny = true
        } finally {
          releaseTransferLock(id, token)
        }
      }
      if (deferredAny && Array.isArray(state.pendingHandoffInputs) && state.pendingHandoffInputs.length > 0) {
        if (reconcileRetryTimer === undefined) {
          const delay = reconcileRetryDelayMs
          reconcileRetryDelayMs = Math.min(reconcileRetryDelayMs * 2, 15_000)
          reconcileRetryTimer = setTimeout(() => {
            reconcileRetryTimer = undefined
            void reconcilePendingHandoffInputs().catch(() => {})
          }, delay)
          reconcileRetryTimer.unref?.()
        }
      } else if (!Array.isArray(state.pendingHandoffInputs) || state.pendingHandoffInputs.length === 0) {
        reconcileRetryDelayMs = 1000
      }
    }
  }

  // Approval state bridge: mark task as waiting_approval while an approval card is open.
  const offApproval = rt.onApproval?.((kind, data) => {
    if (data?.taskId === undefined) return
    const found = findTaskGlobal(data.taskId)
    if (found === undefined || !isActiveTask(found.task)) return
    const { bot, task } = found
    if (kind === 'open') {
      task.status = 'waiting_approval'
      task.updatedAt = Date.now()
      void rt.save().catch(() => {})
      emitTaskEvent('task.waiting_approval', bot, task, { approvalId: data.id, tool: data.tool })
    } else if (kind === 'settled' && task.status === 'waiting_approval') {
      task.status = 'running'
      task.updatedAt = Date.now()
      void rt.save().catch(() => {})
      emitTaskEvent('task.resumed', bot, task, { approvalId: data.id, outcome: data.outcome })
    }
  })
  ctx.effect?.(() => () => {
    offApproval?.()
    if (reconcileRetryTimer !== undefined) {
      clearTimeout(reconcileRetryTimer)
      reconcileRetryTimer = undefined
    }
    admittedRpcIds.clear()
    admittedLogicalRpcIds.clear()
    stagedMoveOps.clear()
    inFlightSaveMoveOps.clear()
    pendingSaveMoveOps.clear()
    completedMoveOps.clear()
    inspectedSettledSessionRpcIds.clear()
    transferOwnerToken.clear()
    rejectEmptyTaskWake.clear()
    replacedIds.clear()
    skipInterceptIds.clear()
    inFlightTransferIds.clear()
  }, 'ds-bot: bot-tasks approval bridge')

  // Audience isolation: a hidden peer-Bot work turn running on a Bot's foreground
  // chat must move to background immediately when human input arrives, so the user's
  // message never injects into or leaks out of the hidden peer-Bot turn (#2139).
  // Also true while an explicit/isolation handoff for `sessionId` is already in flight.
  function mustIsolateHiddenWork(bot, sessionId) {
    if (bot === undefined || sessionId === undefined || rt.readOnly?.() !== undefined) return false
    if (sessionId !== rt.chatOf(bot.id)) return false
    if (rt.groupOwners.has(sessionId) || rt.taskOwners?.has(sessionId)) return false
    if (rt.isSwitchingPart?.(sessionId)) return false
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (isLocalCliBot(bot, session)) return false
    const activeHandoff = handoffing.get(bot.id)
    if (activeHandoff !== undefined && !activeHandoff.aborted && activeHandoff.oldSid === sessionId) return true
    const entry = rt.live.get(sessionId)
    if (entry?.turn === undefined || entry.cut !== undefined) return false
    return rt.isHiddenBotWorkTurn?.(bot.id, activeTurnInfo(entry)) === true
  }

  // Peer-Bot background spawn: when another Bot delegates/messages a busy Bot, spawn a
  // lightweight `bot-handoff` task without disturbing the user's foreground session.
  function shouldSpawnPeerTask(bot, sessionId) {
    if (bot === undefined || sessionId === undefined || rt.readOnly?.() !== undefined) return false
    if (sessionId !== rt.chatOf(bot.id)) return false
    if (rt.groupOwners.has(sessionId) || rt.taskOwners?.has(sessionId)) return false
    if (rt.isSwitchingPart?.(sessionId)) return false
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (isLocalCliBot(bot, session)) return false
    const activeHandoff = handoffing.get(bot.id)
    if (activeHandoff !== undefined && !activeHandoff.aborted && activeHandoff.oldSid === sessionId) return true
    const entry = rt.live.get(sessionId)
    if (entry?.turn === undefined || entry.cut !== undefined) return false
    if ((entry.toolCount ?? 0) > 0 || (entry.calls?.size ?? 0) > 0) return true
    if ((rt.runningJobs?.(sessionId)?.length ?? 0) > 0) return true
    return typeof entry.since === 'number' && Date.now() - entry.since >= PEER_BUSY_WAIT_MS
  }

  // Explains why an explicit user-triggered move-to-background is currently unavailable,
  // or returns `undefined` when the current foreground turn can safely move.
  function foregroundMoveBlockReason(bot, sessionId) {
    if (bot === undefined || sessionId === undefined) return { code: 'bot/not-found', message: 'Unknown Bot' }
    if (rt.readOnly?.() !== undefined) return { code: 'bot/read-only', message: 'This window is read-only' }
    if (sessionId !== rt.chatOf(bot.id) || rt.groupOwners.has(sessionId) || rt.taskOwners?.has(sessionId)) {
      return { code: 'bot/stale', message: 'This conversation has already moved on' }
    }
    if (rt.isSwitchingPart?.(sessionId)) return { code: 'bot/busy', message: 'Switching conversation part' }
    const agent = ctx.get('agents')?.get(sessionId)
    if (isLocalCliBot(bot, agent?.session)) {
      return { code: 'bot/unsupported', message: 'Local agent Bots cannot move running turns to the background' }
    }
    if (handoffing.get(bot.id)?.oldSid === sessionId) return { code: 'bot/busy', message: 'Already moving to the background' }
    const entry = rt.live.get(sessionId)
    if (entry?.turn === undefined || entry.cut !== undefined) return { code: 'bot/idle', message: 'Nothing is running right now' }
    if (hasBlockingInteractiveCard(bot, sessionId)) {
      return { code: 'bot/card-open', message: 'Answer or dismiss the open card first' }
    }
    if (hasPendingUserInbox(agent)) {
      return { code: 'bot/pending-input', message: 'Clear or send pending queued messages first' }
    }
    return undefined
  }

  function canMoveForeground(bot, sessionId) {
    return foregroundMoveBlockReason(bot, sessionId) === undefined
  }

  function canBackgroundView() {
    const out = {}
    for (const bot of Object.values(state.bots)) {
      const sid = rt.chatOf(bot.id)
      if (canMoveForeground(bot, sid)) {
        out[sid] = { botId: bot.id, turn: rt.live.get(sid)?.turn ?? null }
      }
    }
    return out
  }

  // Back-compat wrapper: peer callers use `shouldSpawnPeerTask`; foreground human paths
  // only auto-move for hidden peer-Bot audience isolation (`mustIsolateHiddenWork`).
  function shouldMoveForeground(bot, sessionId, { forPeer = false } = {}) {
    return forPeer ? shouldSpawnPeerTask(bot, sessionId) : mustIsolateHiddenWork(bot, sessionId)
  }

  // Extracts the bounded user prompt from the currently running foreground turn,
  // preferring `source.kind === 'user'` messages inside the current turn.
  const promptFromRunningTurn = (session, entry) => {
    const events = session?.snapshotEvents?.() ?? []
    const lastStart = events.findLastIndex(ev => ev.type === 'turn/start')
    const currentTurn = lastStart === -1 ? events : events.slice(lastStart)
    const extract = (ev) => textOf(ev?.data?.message?.content ?? ev?.data?.content ?? '')
      .replace(/^\[[^\r\n]*\]\r?\n?/, '')
      .trim()
    const clipPrompt = (raw) => (raw.length > MOVED_PROMPT_MAX ? `${raw.slice(0, MOVED_PROMPT_MAX)}…` : raw)
    for (let i = currentTurn.length - 1; i >= 0; i -= 1) {
      const ev = currentTurn[i]
      if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') {
        const raw = extract(ev)
        if (raw !== '') return clipPrompt(raw)
      }
    }
    for (let i = currentTurn.length - 1; i >= 0; i -= 1) {
      const ev = currentTurn[i]
      if (ev?.type !== 'user/message') continue
      if (ev.data?.source?.kind === SOURCE_KIND && ev.data.source.role === 'task-handoff') continue
      const raw = extract(ev)
      if (raw !== '') return clipPrompt(raw)
    }
    if (lastStart > 0) {
      for (let i = lastStart - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') {
          const raw = extract(ev)
          if (raw !== '') return clipPrompt(raw)
        }
      }
    }
    if (entry?.info?.senderName) return `Request from ${entry.info.senderName}`
    return ''
  }

  // Derives a short human-readable task title from the currently running foreground turn.
  const titleFromRunningTurn = (session, entry) => {
    const raw = promptFromRunningTurn(session, entry)
    return raw !== '' ? oneLine(raw, TITLE_MAX) : 'Background task'
  }

  const transferIdOf = (item) => {
    if (item.transferId === undefined) {
      item.transferId = item.msg?.source?.rpcId ?? item.msg?.id ?? newId()
    }
    return item.transferId
  }

  const recordPendingTransfers = (items, owner) => {
    if (rt.readOnly?.() !== undefined || items.length === 0) return
    const list = Array.isArray(state.pendingHandoffInputs) ? state.pendingHandoffInputs : (state.pendingHandoffInputs = [])
    let changed = false
    for (const item of items) {
      const id = transferIdOf(item)
      const token = ++transferTokenSeq
      item.transferToken = token
      transferOwnerToken.set(id, token)
      inFlightTransferIds.add(id)
      const originalSessionId = item.originalSessionId ?? item.oldAgent?.id ?? item.oldAgent?.session?.id
      const existing = list.find(entry => entry?.id === id)
      if (existing !== undefined) {
        existing.token = token
        existing.target = item.target === 'next-step' ? 'next-step' : 'next-turn'
        if (originalSessionId !== undefined) {
          existing.originalSessionId = originalSessionId
          const visited = Array.isArray(existing.visitedSessionIds) ? existing.visitedSessionIds : (existing.visitedSessionIds = [])
          if (!visited.includes(originalSessionId)) visited.push(originalSessionId)
        }
        if (owner?.botId !== undefined) { existing.botId = owner.botId; delete existing.roomId }
        if (owner?.roomId !== undefined) { existing.roomId = owner.roomId; delete existing.botId }
        existing.at = Date.now()
        changed = true
        continue
      }
      list.push({
        id,
        token,
        ...(item.msg?.id !== undefined ? { messageId: item.msg.id } : {}),
        ...(originalSessionId !== undefined ? { originalSessionId, visitedSessionIds: [originalSessionId] } : {}),
        target: item.target === 'next-step' ? 'next-step' : 'next-turn',
        ...(owner?.botId !== undefined ? { botId: owner.botId } : {}),
        ...(owner?.roomId !== undefined ? { roomId: owner.roomId } : {}),
        content: item.msg.content,
        source: item.msg.source,
        at: Date.now(),
      })
      changed = true
    }
    if (changed) void rt.save().catch(() => {})
  }

  const noteTransferRecipient = (transferId, sessionId) => {
    if (transferId === undefined || sessionId === undefined || rt.readOnly?.() !== undefined) return
    if (!Array.isArray(state.pendingHandoffInputs)) return
    const entry = state.pendingHandoffInputs.find(item => item?.id === transferId)
    if (entry === undefined) return
    let changed = false
    if (entry.recipientSessionId !== sessionId) {
      entry.recipientSessionId = sessionId
      changed = true
    }
    const visited = Array.isArray(entry.visitedSessionIds) ? entry.visitedSessionIds : (entry.visitedSessionIds = [])
    if (!visited.includes(sessionId)) {
      visited.push(sessionId)
      changed = true
    }
    if (changed) void rt.save().catch(() => {})
  }

  const releaseTransferLock = (id, token) => {
    if (id === undefined) return
    if (token !== undefined && transferOwnerToken.get(id) !== token) return
    inFlightTransferIds.delete(id)
  }

  const clearPendingTransfers = async (entries) => {
    const drop = new Map() // id -> token | undefined (undefined = unconditional)
    for (const raw of entries) {
      if (raw === undefined || raw === null) continue
      const id = typeof raw === 'object' ? raw.id : raw
      const token = typeof raw === 'object' ? raw.token : undefined
      if (id === undefined) continue
      if (token !== undefined && transferOwnerToken.get(id) !== token) continue
      drop.set(id, token)
    }
    if (drop.size === 0) return
    for (const [id, token] of drop) {
      if (token === undefined || transferOwnerToken.get(id) === token) {
        inFlightTransferIds.delete(id)
        transferOwnerToken.delete(id)
      }
    }
    if (rt.readOnly?.() !== undefined || !Array.isArray(state.pendingHandoffInputs)) return
    const next = state.pendingHandoffInputs.filter((entry) => {
      if (entry === null || typeof entry !== 'object') return false
      if (!drop.has(entry.id)) return true
      const token = drop.get(entry.id)
      if (token !== undefined && entry.token !== undefined && entry.token !== token) return true
      return false
    })
    if (next.length === state.pendingHandoffInputs.length) return
    if (next.length === 0) delete state.pendingHandoffInputs
    else state.pendingHandoffInputs = next
    await rt.save().catch(() => {})
  }

  const logicalOwnerOf = (ref) => {
    if (ref === undefined) return undefined
    const botId = rt.chatOwners.get(ref)
    if (botId !== undefined) return `bot:${botId}`
    const groupOwner = rt.groupOwners.get(ref)
    if (groupOwner !== undefined) return `room:${groupOwner.roomId}`
    const taskOwner = rt.taskOwners?.get(ref)
    if (taskOwner !== undefined) return taskOwner.roomId !== undefined ? `room:${taskOwner.roomId}` : `bot:${taskOwner.botId}`
    const past = rt.pastOwners?.get(ref)
    if (past !== undefined) return past.roomId !== undefined ? `room:${past.roomId}` : `bot:${past.botId}`
    if (rt.botOf(ref) !== undefined) return `bot:${ref}`
    if (rt.roomOf(ref) !== undefined) return `room:${ref}`
    return undefined
  }

  const noteSessionAdmittedRpc = (sessionId, rpcId) => {
    if (sessionId === undefined || rpcId === undefined) return
    let set = admittedRpcIds.get(sessionId)
    if (set === undefined) {
      set = new Set()
      admittedRpcIds.set(sessionId, set)
    }
    set.add(rpcId)
    if (set.size > 200) set.delete(set.values().next().value)
  }

  const noteLogicalAdmittedRpc = (sessionId, rpcId) => {
    if (sessionId === undefined || rpcId === undefined) return
    const ownerKey = logicalOwnerOf(sessionId)
    if (ownerKey === undefined) return
    let logical = admittedLogicalRpcIds.get(ownerKey)
    if (logical === undefined) {
      logical = new Set()
      admittedLogicalRpcIds.set(ownerKey, logical)
    }
    logical.add(rpcId)
    if (logical.size > 400) logical.delete(logical.values().next().value)
  }

  const noteAdmittedRpc = (sessionId, rpcId) => {
    noteSessionAdmittedRpc(sessionId, rpcId)
    noteLogicalAdmittedRpc(sessionId, rpcId)
  }

  // Records a completed `sendUser` prompt acknowledgement without polluting the per-session
  // admission map of an old session whose inbox hook already pulled the message into transit.
  const noteSendPrompted = (sessionId, rpcId) => {
    if (sessionId === undefined || rpcId === undefined) return
    noteLogicalAdmittedRpc(sessionId, rpcId)
    if (rt.taskOwners?.has(sessionId)) return
    if (inFlightTransferIds.has(rpcId)) return
    if (Array.isArray(state.pendingHandoffInputs)
      && state.pendingHandoffInputs.some(entry => entry?.id === rpcId || entry?.source?.rpcId === rpcId)) {
      return
    }
    noteSessionAdmittedRpc(sessionId, rpcId)
  }

  // Collects every user message ID / rpcId either consumed into a turn (`user/message`)
  // OR still pending in the durable DSH inbox (`agent/inbox/spliced` fold). Messages that
  // were inserted and later removed/pulled out of the inbox do NOT remain in the result.
  const collectAdmittedIdsFromEvents = (events) => {
    const found = new Set()
    if (!Array.isArray(events)) return found
    const pending = { 'next-turn': [], 'next-step': [] }
    for (const ev of events) {
      if (ev?.type === 'user/message') {
        if (ev.data?.id !== undefined) found.add(ev.data.id)
        if (ev.data?.message?.id !== undefined) found.add(ev.data.message.id)
        if (ev.data?.source?.rpcId !== undefined) found.add(ev.data.source.rpcId)
      } else if (ev?.type === 'agent/inbox/spliced' && ev.data) {
        const inbox = pending[ev.data.target]
        if (inbox !== undefined) {
          const start = ev.data.start
          const removedCount = ev.data.removedCount ?? 0
          const inserted = Array.isArray(ev.data.inserted) ? ev.data.inserted : []
          if (Number.isSafeInteger(start) && start >= 0 && start <= inbox.length
            && Number.isSafeInteger(removedCount) && removedCount >= 0 && start + removedCount <= inbox.length) {
            inbox.splice(start, removedCount, ...inserted)
          }
        }
      }
    }
    for (const list of [pending['next-turn'], pending['next-step']]) {
      for (const msg of list) {
        if (msg?.id !== undefined) found.add(msg.id)
        if (msg?.source?.rpcId !== undefined) found.add(msg.source.rpcId)
      }
    }
    return found
  }

  const isAdmittedOnEvents = (events, rpcId) => {
    if (rpcId === undefined || !Array.isArray(events)) return false
    return collectAdmittedIdsFromEvents(events).has(rpcId)
  }

  const isAdmittedOnSession = (session, rpcId) => {
    if (rpcId === undefined || session === undefined) return false
    return isAdmittedOnEvents(session.snapshotEvents?.(), rpcId)
  }

  const isAdmittedOn = (agent, rpcId) => {
    if (rpcId === undefined || agent === undefined) return false
    const sid = agent.id ?? agent.session?.id
    if (sid !== undefined && admittedRpcIds.get(sid)?.has(rpcId)) return true
    for (const list of [agent.inbox?.nextStep ?? [], agent.inbox?.nextTurn ?? []]) {
      if (list.some(msg => msg?.id === rpcId || msg?.source?.rpcId === rpcId)) return true
    }
    return isAdmittedOnSession(agent.session, rpcId)
  }

  // Confirms that the live session currently handling `ref` has flushed to disk (`flush() === true`).
  const confirmSessionFlushed = async (ref) => {
    if (typeof ctx.sessions?.flush !== 'function') return false
    const sid = rt.botOf(ref) !== undefined
      ? rt.chatOf(ref)
      : rt.roomOf(ref) !== undefined
        ? rt.sessionOfRoom(rt.roomOf(ref))
        : ref
    if (sid === undefined) return false
    const session = ctx.sessions?.get?.(sid) ?? ctx.get('agents')?.get(sid)?.session
    if (session === undefined) return false
    try {
      return (await ctx.sessions.flush(session)) === true
    } catch {
      return false
    }
  }

  // Reads events of a cold (unloaded) Session using the real DSH `sessionQuery` service
  // (`inspectSession` / `readSession`), distinguishing missing sessions from I/O errors
  // so admission checks fail closed when a stored session cannot be read.
  const isMissingSessionError = (error) => error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
    || error?.code === 'ENOENT'
    || /not found/i.test(String(error?.message ?? ''))

  const readColdSessionEvents = async (sid, signal) => {
    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
    if (typeof query?.inspectSession === 'function') {
      try {
        const events = await query.inspectSession(sid, session => session?.snapshotEvents?.() ?? [], signal)
        return { status: 'ok', events: Array.isArray(events) ? events : [] }
      } catch (error) {
        if (isMissingSessionError(error)) return { status: 'not_found', events: [] }
        return { status: 'error', error }
      }
    }
    if (typeof query?.readSession === 'function') {
      try {
        const seen = await query.readSession(sid)
        return { status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] }
      } catch (error) {
        if (isMissingSessionError(error)) return { status: 'not_found', events: [] }
        return { status: 'error', error }
      }
    }
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect === 'function') {
      try {
        const seen = await inspect(sid, signal)
        return { status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] }
      } catch (error) {
        if (isMissingSessionError(error)) return { status: 'not_found', events: [] }
        return { status: 'error', error }
      }
    }
    return { status: 'unavailable' }
  }

  // Checks whether `requestId` was already admitted on the target logical chat —
  // including across a foreground-to-background move where `ref` moved into `bot.tasks[]`,
  // after a host restart when completed handoff sessions are unloaded on disk, and across
  // IM chat rebindings for globally unique `im:` platform message IDs.
  const isAdmittedForSend = async ({ ref, sessionId, requestId, callerSupplied = true } = {}) => {
    if (requestId === undefined) return false
    const ownerKey = logicalOwnerOf(sessionId) ?? logicalOwnerOf(ref)
    if (ownerKey !== undefined && admittedLogicalRpcIds.get(ownerKey)?.has(requestId)) return true
    const isImRequest = typeof requestId === 'string' && requestId.startsWith('im:')
    if (isImRequest) {
      for (const set of admittedLogicalRpcIds.values()) {
        if (set.has(requestId)) return true
      }
    }
    if (Array.isArray(state.pendingHandoffInputs)
      && state.pendingHandoffInputs.some(entry => entry?.id === requestId || entry?.source?.rpcId === requestId)) {
      return true
    }
    // Ordered newest-first candidate sessions: live target, caller ref, fg-handoff tasks, ended segments.
    const candidates = new Map() // sid -> { immutable: boolean }
    const addCandidate = (sid, immutable = false) => {
      if (typeof sid !== 'string' || sid === '') return
      const existing = candidates.get(sid)
      if (existing === undefined) candidates.set(sid, { immutable })
      else if (immutable) existing.immutable = true
    }
    const addBotCandidates = (bot) => {
      if (bot === undefined) return
      addCandidate(rt.chatOf(bot.id), false)
      const tasks = [...(bot.tasks ?? [])].reverse()
      for (const task of tasks) {
        if (task?.origin !== 'fg-handoff') continue
        const settled = !isActiveTask(task)
        addCandidate(task.sessionId, settled)
        for (const seg of [...(task.segments ?? [])].reverse()) {
          addCandidate(seg?.sessionId, true)
        }
      }
      for (const seg of [...(bot.segments ?? [])].reverse().slice(0, 6)) {
        addCandidate(seg?.sessionId, true)
      }
    }
    addCandidate(sessionId, false)
    if (ref !== undefined && rt.botOf(ref) === undefined && rt.roomOf(ref) === undefined) {
      addCandidate(ref, false)
    }
    if (ownerKey !== undefined && ownerKey.startsWith('bot:')) {
      addBotCandidates(rt.botOf(ownerKey.slice(4)))
    }
    // An IM platform message ID (`im:<platform>:<connId>:<chatKey>:<msgId>`) belongs to a
    // single inbound platform event even if the chat was rebound to another Bot/group after restart.
    if (isImRequest) {
      for (const bot of Object.values(state.bots)) addBotCandidates(bot)
      for (const room of Object.values(state.rooms ?? {})) {
        addCandidate(rt.sessionOfRoom?.(room), false)
        // A group chat's own earlier session parts live in `room.parts` (array), whereas
        // `room.segments` is a plain object `Record<botId, Segment[]>` of member rollovers.
        if (Array.isArray(room?.parts)) {
          for (const part of [...room.parts].reverse().slice(0, 4)) {
            addCandidate(typeof part === 'string' ? part : part?.sessionId, true)
          }
        }
        if (room?.segments !== null && typeof room?.segments === 'object') {
          const segLists = Array.isArray(room.segments) ? [room.segments] : Object.values(room.segments)
          for (const list of segLists) {
            if (!Array.isArray(list)) continue
            for (const seg of [...list].reverse().slice(0, 4)) {
              addCandidate(seg?.sessionId, true)
            }
          }
        }
      }
    }
    const agents = ctx.get('agents')
    const coldCandidates = []
    for (const [sid, meta] of candidates) {
      if (admittedRpcIds.get(sid)?.has(requestId)) {
        noteLogicalAdmittedRpc(sessionId ?? sid, requestId)
        return true
      }
      const agent = agents?.get(sid)
      if (agent !== undefined) {
        if (isAdmittedOn(agent, requestId)) {
          noteAdmittedRpc(sid, requestId)
          return true
        }
        continue
      }
      const session = ctx.sessions?.get?.(sid)
      if (session !== undefined) {
        if (isAdmittedOnSession(session, requestId)) {
          noteAdmittedRpc(sid, requestId)
          return true
        }
        continue
      }
      coldCandidates.push([sid, meta])
    }
    if (!callerSupplied || coldCandidates.length === 0) return false
    let readFailure
    for (const [sid, meta] of coldCandidates) {
      const cached = inspectedSettledSessionRpcIds.get(sid)
      if (cached !== undefined) {
        if (cached.has(requestId)) {
          noteLogicalAdmittedRpc(sessionId ?? sid, requestId)
          return true
        }
        continue
      }
      const read = await readColdSessionEvents(sid, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      if (read.status === 'unavailable') return false
      if (read.status === 'error') {
        readFailure ??= read.error
        continue
      }
      const foundIds = collectAdmittedIdsFromEvents(read.events)
      if (meta.immutable && read.status === 'ok') {
        inspectedSettledSessionRpcIds.set(sid, foundIds)
        while (inspectedSettledSessionRpcIds.size > MAX_INSPECTED_SESSIONS) {
          inspectedSettledSessionRpcIds.delete(inspectedSettledSessionRpcIds.keys().next().value)
        }
      }
      if (foundIds.has(requestId)) {
        noteAdmittedRpc(sid, requestId)
        return true
      }
    }
    // Fail closed if any cold session could not be read so a duplicate is never silently admitted.
    if (readFailure !== undefined) throw readFailure
    return false
  }

  // Pulls earlier pending user-authored messages in FIFO order (next-step before
  // next-turn, matching DSH claim order) so queued foreground prompts travel with
  // a foreground handoff instead of being stranded on the background task.
  const pullPendingUserMessages = (agent, excludeId) => {
    if (agent?.inbox?.remove === undefined) return []
    const pending = [
      ...(agent.inbox.nextStep ?? []).map(msg => ({ msg, target: 'next-step' })),
      ...(agent.inbox.nextTurn ?? []).map(msg => ({ msg, target: 'next-turn' })),
    ].filter(item => item.msg?.source?.kind === 'user'
      && item.msg.id !== excludeId
      && !skipInterceptIds.has(item.msg.id))
    const pulled = []
    const sid = agent.id ?? agent.session?.id
    const sidSet = sid === undefined ? undefined : admittedRpcIds.get(sid)
    for (const item of pending) {
      if (agent.inbox.remove(item.msg.id)) {
        if (sidSet !== undefined) {
          sidSet.delete(item.msg.id)
          if (item.msg.source?.rpcId !== undefined) sidSet.delete(item.msg.source.rpcId)
        }
        pulled.push({ msg: item.msg, target: item.target, oldAgent: agent })
      }
    }
    return pulled
  }

  // Restores pulled user messages back to their original Agent (pre-commit failure only)
  // without triggering `interceptForegroundUserMessage`, waking an idle Agent if needed.
  // If the original session has since moved to background (e.g. a second move committed
  // while the first move was aborting), reroutes those items to the live foreground instead
  // of writing user prompts into a background task. Only clears journal entries whose
  // receiving session confirmed `sessions.flush() === true` (#2087).
  const restorePulledMessages = async (items, { forceNextTurn = false, botId } = {}) => {
    const byAgent = new Map()
    const reroutedByBot = new Map()
    const failedIds = []
    for (const item of items) {
      const oldSid = item.oldAgent?.id ?? item.oldAgent?.session?.id
      const ownerBotId = botId
        ?? (oldSid !== undefined ? (rt.chatOwners.get(oldSid) ?? rt.taskOwners?.get(oldSid)?.botId ?? rt.pastOwners?.get(oldSid)?.botId) : undefined)
      const currentFgSid = ownerBotId === undefined ? oldSid : rt.chatOf(ownerBotId)
      const activeHandoff = ownerBotId === undefined ? undefined : handoffing.get(ownerBotId)
      const movedAway = oldSid !== undefined && (
        rt.taskOwners?.has(oldSid)
        || (ownerBotId !== undefined && currentFgSid !== oldSid)
        || (activeHandoff !== undefined && !activeHandoff.aborted && activeHandoff.oldSid === oldSid)
      )
      if (movedAway) {
        const key = ownerBotId ?? '__unknown__'
        let list = reroutedByBot.get(key)
        if (list === undefined) { list = []; reroutedByBot.set(key, list) }
        list.push(item)
        continue
      }
      const key = item.msg?.id
      if (key !== undefined) skipInterceptIds.add(key)
      const target = forceNextTurn ? 'next-turn' : item.target
      let accepted = false
      try {
        if (typeof item.oldAgent?.send === 'function') {
          item.oldAgent.send(item.msg, target, true)
          accepted = true
        } else if (typeof item.oldAgent?.followup === 'function') {
          item.oldAgent.followup(item.msg)
          accepted = true
        }
      } catch {
        accepted = false
      } finally {
        if (key !== undefined) skipInterceptIds.delete(key)
      }
      if (accepted && item.oldAgent !== undefined) {
        if (item.msg?.source?.rpcId !== undefined) noteAdmittedRpc(oldSid, item.msg.source.rpcId)
        let group = byAgent.get(item.oldAgent)
        if (group === undefined) { group = []; byAgent.set(item.oldAgent, group) }
        group.push(item)
      } else if (item.transferId !== undefined) {
        failedIds.push({ id: item.transferId, token: item.transferToken })
      }
    }
    const confirmedEntries = []
    for (const [oldAgent, group] of byAgent) {
      let flushed = false
      try {
        if (typeof ctx.sessions?.flush === 'function' && oldAgent.session !== undefined) {
          flushed = (await ctx.sessions.flush(oldAgent.session)) === true
        }
      } catch {
        flushed = false
      }
      for (const item of group) {
        if (item.transferId === undefined) continue
        if (flushed) confirmedEntries.push({ id: item.transferId, token: item.transferToken })
        else failedIds.push({ id: item.transferId, token: item.transferToken })
      }
    }
    for (const entry of failedIds) {
      if (typeof entry === 'object') releaseTransferLock(entry.id, entry.token)
      else releaseTransferLock(entry, undefined)
    }
    if (confirmedEntries.length > 0) await clearPendingTransfers(confirmedEntries)
    for (const [key, rerouted] of reroutedByBot) {
      if (key === '__unknown__') {
        for (const item of rerouted) releaseTransferLock(item.transferId, item.transferToken)
        continue
      }
      const ownerBot = rt.botOf(key)
      if (ownerBot === undefined) {
        await clearPendingTransfers(rerouted.map(item => ({ id: item.transferId, token: item.transferToken })))
        continue
      }
      const active = handoffing.get(key)
      if (active !== undefined && !active.aborted) {
        await handoffForeground(ownerBot, active.oldSid, rerouted).catch(() => {})
        continue
      }
      const fgSid = rt.chatOf(ownerBot.id)
      if (fgSid !== undefined && !rt.taskOwners?.has(fgSid)) {
        await forwardPulledMessages(fgSid, rerouted, ownerBot.name, { botId: ownerBot.id })
      } else {
        for (const item of rerouted) releaseTransferLock(item.transferId, item.transferToken)
      }
    }
  }

  // Delivers pulled user messages onto a target foreground Session, retrying transient
  // destination failures without duplicating already-admitted items. Revalidates the live
  // foreground after every async step so concurrent moves never strand inputs on a moved
  // background task, and clears each item's journal entry ONLY when the exact session that
  // received it confirms `sessions.flush() === true` AND this transfer still owns the entry (#2087).
  const forwardPulledMessages = async (initialTargetSid, items, botName, owner = {}) => {
    if (items.length === 0) return
    const resolveOwner = (sid) => {
      if (owner.roomId !== undefined) return { roomId: owner.roomId }
      if (owner.botId !== undefined) return { botId: owner.botId }
      const taskOwner = rt.taskOwners?.get(sid)
      if (taskOwner !== undefined) return taskOwner.roomId !== undefined ? { roomId: taskOwner.roomId } : { botId: taskOwner.botId }
      const groupOwner = rt.groupOwners.get(sid)
      if (groupOwner !== undefined) return { roomId: groupOwner.roomId }
      const botId = rt.chatOwners.get(sid)
      if (botId !== undefined) return { botId }
      const past = rt.pastOwners?.get(sid)
      if (past !== undefined) return past.roomId !== undefined ? { roomId: past.roomId } : { botId: past.botId }
      return {}
    }
    const currentTargetFor = (sid, resolvedOwner) => {
      if (resolvedOwner.roomId !== undefined) {
        const room = rt.roomOf(resolvedOwner.roomId)
        return room === undefined ? undefined : rt.sessionOfRoom(room)
      }
      if (resolvedOwner.botId !== undefined) {
        const bot = rt.botOf(resolvedOwner.botId)
        return bot === undefined ? undefined : rt.chatOf(bot.id)
      }
      return sid
    }
    const resolvedOwner = resolveOwner(initialTargetSid)
    let targetSid = initialTargetSid
    let nextIndex = 0
    // Sessions that have accepted items in this batch and still await a positive flush() === true.
    const pendingFlushBySession = new Map() // sid -> { session, items: Map<transferId, token> }
    const trackForFlush = (sid, session, transferId, transferToken) => {
      let bucket = pendingFlushBySession.get(sid)
      if (bucket === undefined) {
        bucket = { session, items: new Map() }
        pendingFlushBySession.set(sid, bucket)
      } else if (session !== undefined) {
        bucket.session = session
      }
      if (transferId !== undefined) bucket.items.set(transferId, transferToken)
    }
    const flushPendingBuckets = async () => {
      const confirmed = []
      let hadFalse = false
      let firstError
      for (const [sid, bucket] of [...pendingFlushBySession.entries()]) {
        try {
          const ok = typeof ctx.sessions?.flush === 'function' && bucket.session !== undefined
            ? (await ctx.sessions.flush(bucket.session)) === true
            : false
          if (ok) {
            pendingFlushBySession.delete(sid)
            for (const [id, token] of bucket.items) confirmed.push({ id, token })
          } else {
            hadFalse = true
          }
        } catch (error) {
          firstError ??= error
        }
      }
      if (confirmed.length > 0) await clearPendingTransfers(confirmed)
      if (firstError !== undefined) throw firstError
      return !hadFalse
    }
    const releaseUnconfirmed = () => {
      for (const bucket of pendingFlushBySession.values()) {
        for (const [id, token] of bucket.items) releaseTransferLock(id, token)
      }
      for (let i = nextIndex; i < items.length; i += 1) {
        releaseTransferLock(items[i]?.transferId, items[i]?.transferToken)
      }
    }
    const delays = [50, 250]
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        if (nextIndex < items.length) {
          let freshAgent
          let hops = 0
          while (true) {
            if (resolvedOwner.botId !== undefined) {
              const active = handoffing.get(resolvedOwner.botId)
              if (active !== undefined && !active.aborted && active.oldSid === targetSid) {
                await active.promise.catch(() => {})
              }
            }
            const latestBefore = currentTargetFor(targetSid, resolvedOwner)
            if (latestBefore === undefined) {
              await clearPendingTransfers(items.slice(nextIndex).map(item => ({ id: item.transferId, token: item.transferToken })))
              nextIndex = items.length
              break
            }
            if (latestBefore !== targetSid) targetSid = latestBefore
            await rt.ensureCapabilities(targetSid)
            freshAgent = await rt.resolveAgent(targetSid)
            if (resolvedOwner.botId !== undefined) {
              const activeAfter = handoffing.get(resolvedOwner.botId)
              if (activeAfter !== undefined && !activeAfter.aborted && activeAfter.oldSid === targetSid) {
                await activeAfter.promise.catch(() => {})
                hops += 1
                if (hops <= 8) continue
              }
            }
            const latestAfter = currentTargetFor(targetSid, resolvedOwner)
            if (latestAfter === undefined) {
              await clearPendingTransfers(items.slice(nextIndex).map(item => ({ id: item.transferId, token: item.transferToken })))
              nextIndex = items.length
              break
            }
            if (latestAfter !== targetSid || rt.taskOwners?.has(targetSid)) {
              targetSid = latestAfter
              hops += 1
              if (hops <= 8) continue
              throw new Error(`foreground target ${targetSid} moved repeatedly while forwarding`)
            }
            if (resolvedOwner.botId !== undefined) {
              const ownerBot = rt.botOf(resolvedOwner.botId)
              if (mustIsolateHiddenWork(ownerBot, targetSid)) {
                const remaining = items.slice(nextIndex).map(item => ({ ...item, oldAgent: freshAgent }))
                nextIndex = items.length
                await flushPendingBuckets().catch(() => {})
                releaseUnconfirmed()
                await handoffForeground(ownerBot, targetSid, remaining)
                return
              }
            }
            break
          }
          if (nextIndex < items.length && freshAgent !== undefined) {
            // Snapshot whether `targetSid` was ALREADY running a non-hidden foreground turn
            // before this batch begins, so forwarding multiple pulled messages onto a freshly
            // forked idle session delivers all of them as FIFO `followup` turns instead of
            // letting item 2 steer-cut item 1.
            const initialEntry = rt.live.get(targetSid)
            const targetBotId = rt.chatOwners.get(targetSid)
            const targetWasRunning = initialEntry?.turn !== undefined
              && freshAgent.status === 'running'
              && typeof freshAgent.send === 'function'
              && !rt.isHiddenBotWorkTurn?.(targetBotId, activeTurnInfo(initialEntry))
            while (nextIndex < items.length) {
              const item = items[nextIndex]
              const rpcId = item.transferId ?? item.msg?.source?.rpcId
              if (rpcId === undefined || !isAdmittedOn(freshAgent, rpcId)) {
                const baseSource = item.msg.source ?? { kind: 'user' }
                const source = baseSource.rpcId !== undefined || rpcId === undefined
                  ? baseSource
                  : { ...baseSource, rpcId }
                const forwarded = createUserMessage({ content: item.msg.content, source })
                const keepSteer = targetWasRunning && item.target === 'next-step'
                skipInterceptIds.add(forwarded.id)
                try {
                  if (keepSteer) freshAgent.send(forwarded, 'next-step', true)
                  else freshAgent.followup(forwarded)
                  noteAdmittedRpc(targetSid, rpcId)
                } finally {
                  skipInterceptIds.delete(forwarded.id)
                }
              }
              noteTransferRecipient(item.transferId, targetSid)
              trackForFlush(targetSid, freshAgent.session, item.transferId, item.transferToken)
              nextIndex += 1
            }
          }
        }
        const allFlushed = await flushPendingBuckets()
        if (!allFlushed) releaseUnconfirmed()
        return
      } catch (error) {
        if (attempt < delays.length) {
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
          continue
        }
        releaseUnconfirmed()
        rt.warn('ds-bot: forwarding queued input to new foreground %s for %s failed: %s', targetSid, botName ?? '?', error)
      }
    }
  }

  // Moves a busy foreground Session intact into `bot.tasks[]`, forks a fresh foreground
  // Session from the pre-turn completed boundary, updates `bot.sessionId`, drains any
  // concurrent intercepted Desktop/Web messages onto the new foreground, and returns
  // the new foreground sessionId. Serialized per Bot so rapid messages share one handoff.
  async function handoffForeground(bot, oldSid, initialMessages = [], { explicit = false, operationId, expectedTurn } = {}) {
    const existing = handoffing.get(bot.id)
    if (existing !== undefined && existing.oldSid === oldSid && !existing.aborted) {
      if (initialMessages.length > 0) {
        recordPendingTransfers(initialMessages, { botId: bot.id })
        if (existing.committed && existing.newSid !== undefined) {
          void forwardPulledMessages(existing.newSid, initialMessages, bot.name, { botId: bot.id })
        } else {
          existing.messages.push(...initialMessages)
        }
      }
      return existing.promise
    }
    const entry = rt.live.get(oldSid)
    const oldAgent = ctx.get('agents')?.get(oldSid)
    const earlier = explicit ? [] : pullPendingUserMessages(oldAgent)
    const seededMessages = [...earlier, ...initialMessages]
    recordPendingTransfers(seededMessages, { botId: bot.id })
    const info = activeTurnInfo(entry)
    const activeWork = rt.workOf?.(info)
    const isBotHandoff = rt.isHiddenBotWorkTurn?.(bot.id, info) === true
    const origin = isBotHandoff ? 'bot-handoff' : 'fg-handoff'
    const movedPrompt = isBotHandoff ? '' : promptFromRunningTurn(oldAgent?.session, entry)
    const title = titleFromRunningTurn(oldAgent?.session, entry)
    const oldEvents = oldAgent?.session?.snapshotEvents?.() ?? []
    const runningTurn = entry?.turn
    const targetTurn = expectedTurn ?? runningTurn
    const { startSeq, handoffCutSeq, priorTurns, priorCallIds } = (() => {
      const turns = new Set()
      const callIds = new Set()
      if (oldEvents.length === 0) {
        const oldSession = oldAgent?.session ?? ctx.sessions?.get?.(oldSid)
        const empty = typeof oldSession?.seq === 'number' && Number.isInteger(oldSession.seq) && oldSession.seq === 0
        return { startSeq: 0, handoffCutSeq: empty ? -1 : undefined, priorTurns: turns, priorCallIds: callIds }
      }
      const lastStart = oldEvents.findLastIndex(ev => ev?.type === 'turn/start')
      const boundary = lastStart >= 0 ? lastStart : oldEvents.length
      let seq = 0
      let lastCompletedSeq
      for (let i = 0; i < boundary; i += 1) {
        const ev = oldEvents[i]
        if (ev?.type === 'turn/end') {
          if (typeof ev.data?.turn === 'number' && Number.isInteger(ev.data.turn)) turns.add(ev.data.turn)
          const endSeq = Number.isInteger(ev.seq) ? ev.seq : i
          seq = endSeq + 1
          lastCompletedSeq = endSeq
        } else if (ev?.type === 'tool/call' && typeof ev.data?.callId === 'string' && ev.data.callId !== '') {
          callIds.add(ev.data.callId)
        }
      }
      // Match DSH's latestCompletedPrefixBoundary: when a turn is in flight (`lastStart >= 0`)
      // and no prior `turn/end` exists, there is no completed prefix before this turn (`-1`),
      // even if Turn 1's initiating `user/message` precedes `turn/start`.
      const cutSeq = lastCompletedSeq !== undefined
        ? lastCompletedSeq
        : lastStart >= 0
          ? -1
          : Number.isInteger(oldEvents.at(-1)?.seq)
            ? oldEvents.at(-1).seq
            : undefined
      return { startSeq: seq, handoffCutSeq: cutSeq, priorTurns: turns, priorCallIds: callIds }
    })()
    const movedImOrigin = isBotHandoff ? undefined : rt.captureImOrigin?.(oldSid)

    const record = {
      oldSid,
      committed: false,
      aborted: false,
      saved: false,
      newSid: undefined,
      taskId: undefined,
      explicit,
      operationIds: new Set(typeof operationId === 'string' && operationId !== '' ? [operationId] : []),
      savedOperationIds: new Set(),
      messages: seededMessages,
      promise: undefined,
    }
    const releaseRecord = () => {
      record.aborted = true
      if (handoffing.get(bot.id) === record) handoffing.delete(bot.id)
    }
    const restoreAll = async (forceNextTurn = isBotHandoff) => {
      releaseRecord()
      while (record.messages.length > 0) {
        await restorePulledMessages(record.messages.splice(0), { forceNextTurn, botId: bot.id })
      }
    }
    const run = (async () => {
      if (record.messages.length > 0) await rt.save().catch(() => {})
      let forkedResult
      try {
        forkedResult = await rt.forkForegroundPart(bot, oldSid)
      } catch (error) {
        await restoreAll(isBotHandoff)
        throw error
      }
      const { sessionId: newSid, forked, syncRoute } = forkedResult
      // Bot might have moved, started a part switch, or been deleted while forking.
      if (rt.botOf(bot.id) !== bot || rt.chatOf(bot.id) !== oldSid || rt.isSwitchingPart?.(oldSid)) {
        releaseRecord()
        const currentSid = rt.chatOf(bot.id)
        while (record.messages.length > 0) {
          const pending = record.messages.splice(0)
          if (currentSid !== undefined && currentSid !== oldSid && !rt.taskOwners?.has(currentSid)) {
            await forwardPulledMessages(currentSid, pending, bot.name, { botId: bot.id })
          } else if (rt.botOf(bot.id) === bot) {
            await restorePulledMessages(pending, { forceNextTurn: isBotHandoff, botId: bot.id })
          } else {
            await clearPendingTransfers(pending.map(item => ({ id: item.transferId, token: item.transferToken })))
          }
        }
        await ctx.workspaceRegistry.archiveSession(newSid, { stopActivity: true }).catch(() => {})
        return currentSid ?? newSid
      }
      // For an explicit move, revalidate the captured turn and open interactive cards
      // right before committing so we never move a newer turn, dismiss an interactive
      // card that opened mid-fork, or create a ghost task for a turn that just finished.
      if (explicit) {
        const curLive = rt.live.get(oldSid)
        const curTurn = curLive?.turn
        const sameTurnActive = targetTurn !== undefined
          ? curTurn === targetTurn && curLive?.cut === undefined
          : (curTurn !== undefined && curLive?.cut === undefined)
        const cardOpened = hasBlockingInteractiveCard(bot, oldSid)
        if (!sameTurnActive || cardOpened) {
          const stillIdle = !cardOpened
            && curTurn === undefined
            && oldAgent?.status !== 'running'
            && (rt.runningJobs?.(oldSid)?.length ?? 0) === 0
            && !rt.waitsForApproval?.(oldSid)
          if (stillIdle) {
            // Register all operationIds in `inFlightSaveMoveOps` BEFORE releasing `handoffing`
            // or awaiting archival/save so a concurrent retry with the same ID joins this
            // no-op outcome instead of racing onto a newly started Turn 2.
            const noOpResult = { sessionId: oldSid, taskId: null, moved: false }
            const opIds = [...record.operationIds]
            const finalizeNoOp = (async () => {
              await restoreAll(false)
              await ctx.workspaceRegistry.archiveSession(newSid, { stopActivity: true }).catch(() => {})
              if (opIds.length > 0) {
                for (const id of opIds) addStagedMoveOp(id)
                const staged = stagePersistedMoveOps(opIds.map(id => ({ id, result: noOpResult })))
                try {
                  await rt.save({ required: true })
                } catch (error) {
                  unstagePersistedMoveOps(staged)
                  throw error
                } finally {
                  for (const id of opIds) removeStagedMoveOp(id)
                }
                for (const id of opIds) {
                  pendingSaveMoveOps.delete(id)
                  record.savedOperationIds.add(id)
                  rememberMoveOp(id, noOpResult)
                }
              }
              return noOpResult
            })().finally(() => {
              for (const id of opIds) {
                if (inFlightSaveMoveOps.get(id) === finalizeNoOp) inFlightSaveMoveOps.delete(id)
              }
            })
            for (const id of opIds) inFlightSaveMoveOps.set(id, finalizeNoOp)
            await finalizeNoOp
            return oldSid
          }
          // Restore/reroute BEFORE awaiting archiveSession so a concurrent second move
          // never races ahead of our rollback and causes user input to land in a task.
          await restoreAll(false)
          await ctx.workspaceRegistry.archiveSession(newSid, { stopActivity: true }).catch(() => {})
          if (cardOpened) {
            throw Object.assign(new Error('Answer or dismiss the open card first'), { code: 'bot/card-open' })
          }
          throw Object.assign(new Error('This turn has already ended'), { code: 'bot/stale' })
        }
      }
      const now = Date.now()
      const forkedSession = forked
        ? (ctx.get('agents')?.get(newSid)?.session ?? ctx.sessions?.get?.(newSid))
        : undefined
      const forkedEvents = forkedSession?.snapshotEvents?.() ?? []
      const lastForkedSeq = forkedEvents.at(-1)?.seq
      const forkedInherited = forkedSession?.inheritedEventCount
      const forkedCutSeq = Number.isInteger(lastForkedSeq)
        ? lastForkedSeq
        : (typeof forkedInherited === 'number' && Number.isInteger(forkedInherited) && forkedInherited >= 0
            ? forkedInherited - 1
            : undefined)
      const effectiveCutSeq = handoffCutSeq !== undefined
        ? handoffCutSeq
        : (forkedCutSeq !== undefined
            ? forkedCutSeq
            : lastSeqOf(oldAgent?.session ?? ctx.sessions?.get?.(oldSid)))
      // Seal any earlier task's inherited ref to `oldSid` so this moved turn and all
      // post-handoff messages on `oldSid` never leak across task threads.
      for (const other of bot.tasks ?? []) {
        if (!Array.isArray(other?.inheritedSegments)) continue
        for (const seg of other.inheritedSegments) {
          if (seg?.sessionId !== oldSid) continue
          if (seg.endedAt === undefined) seg.endedAt = now
          if (seg.throughSeq === undefined && effectiveCutSeq !== undefined) seg.throughSeq = effectiveCutSeq
        }
      }
      const inherited = slimSegments(bot)
      const task = {
        id: newId(),
        title,
        brief: title,
        from: newSid,
        sessionId: oldSid,
        segments: [],
        startSeq,
        ...(inherited.length > 0 ? { inheritedSegments: inherited } : {}),
        origin,
        status: rt.waitsForApproval?.(oldSid) ? 'waiting_approval' : 'running',
        startedAt: entry?.since ?? now,
        updatedAt: now,
        ...(isBotHandoff && activeWork !== undefined ? { exchangeId: activeWork } : {}),
        ...(movedImOrigin !== undefined ? { imOrigin: movedImOrigin } : {}),
      }
      ;(bot.tasks ??= []).push(task)
      bot.sessionId = newSid
      foregroundEpochs.set(bot.id, (foregroundEpochs.get(bot.id) ?? 0) + 1)
      rt.chatOwners.set(newSid, bot.id)
      rt.taskOwners.set(oldSid, { botId: bot.id, taskId: task.id })
      rt.moveSilentNotes?.(oldSid, newSid)
      if (isBotHandoff && activeWork !== undefined) {
        rt.setWorkTargetSession?.(activeWork, oldSid, task.id)
      }
      // A forked foreground Session clones completed turns from `oldSid` with the same
      // turn numbers and callIds; carry over hidden exchange turns and closed cards for
      // those inherited turns so previously hidden [PASS]/Bot-to-Bot turns never leak
      // back into the user's chat after an fg-handoff or bot-handoff fork.
      if (forked) {
        let inheritedTurns = priorTurns
        let inheritedCallIds = priorCallIds
        const hasEventBounds = forkedEvents.length > 0 || oldEvents.length > 0
        if (forkedEvents.length > 0) {
          inheritedTurns = new Set()
          inheritedCallIds = new Set()
          for (const ev of forkedEvents) {
            if (ev?.type === 'turn/end' && typeof ev.data?.turn === 'number' && Number.isInteger(ev.data.turn)) inheritedTurns.add(ev.data.turn)
            else if (ev?.type === 'tool/call' && typeof ev.data?.callId === 'string' && ev.data.callId !== '') inheritedCallIds.add(ev.data.callId)
          }
        }
        const oldHidden = rt.own(state.exchangeTurns, oldSid)
        if (Array.isArray(oldHidden) && oldHidden.length > 0) {
          const carried = oldHidden.filter(t => (hasEventBounds
            ? inheritedTurns.has(t)
            : (runningTurn === undefined || t < runningTurn)))
          if (carried.length > 0) state.exchangeTurns[newSid] = carried
        }
        const oldClosed = rt.own(state.closedCards, oldSid)
        if (oldClosed && typeof oldClosed === 'object') {
          const carriedCards = {}
          for (const [callId, card] of Object.entries(oldClosed)) {
            if (!hasEventBounds || inheritedCallIds.has(callId)) carriedCards[callId] = card
          }
          if (Object.keys(carriedCards).length > 0) (state.closedCards ??= {})[newSid] = carriedCards
        }
      }
      record.committed = true
      record.newSid = newSid
      record.taskId = task.id
      // Clear live IM origin on the moved background session so it never streams raw lines
      // directly to IM; `task.imOrigin` handles approvals and the final `task-report`.
      rt.clearImOrigin?.(oldSid)
      if (state.questions[oldSid] !== undefined) {
        rt.closeCard(oldSid, state.questions[oldSid], 'dismissed')
        delete state.questions[oldSid]
      }
      if (state.views?.[oldSid] !== undefined) {
        rt.closeCard(oldSid, state.views[oldSid], 'dismissed')
        delete state.views[oldSid]
      }
      rt.clearActivity?.(oldSid)
      const liveOld = rt.live.get(oldSid)
      if (liveOld !== undefined) liveOld.steeredAt = undefined

      let postSaveDone = false
      const finishPostSave = async () => {
        if (postSaveDone) return
        postSaveDone = true
        await rt.moveSchedules?.(oldSid, newSid)
          .catch(error => rt.warn('ds-bot: moving schedules for %s after handoff failed: %s', bot.name, error))
        await syncRoute?.().catch(error => rt.warn('ds-bot: route sync for foreground part of %s failed: %s', bot.name, error))
        emitTaskEvent('task.started', bot, task, { origin })

        // Check whether the moved turn already finished during `await forkForegroundPart`
        // BEFORE injecting the "still running" notice, and inspect its actual `turn/end`
        // reason so failed/stopped/max-tokens turns settle with the right status.
        const stillRunning = rt.live.get(oldSid)?.turn !== undefined
          || oldAgent?.status === 'running'
          || hasWakingInboxInput(oldAgent)
          || hasPendingTaskUnread(oldSid)
          || (rt.runningJobs?.(oldSid)?.length ?? 0) > 0
          || rt.waitsForApproval?.(oldSid)
          || hasOpenOutgoingWorks(bot, task)
          || isAwaitingHandoffInput(task)
          || (origin === 'bot-handoff' && activeWork !== undefined && rt.live.get(oldSid)?.lastAskedBackWork === activeWork)

        if (!stillRunning) {
          // When the new foreground could not fork history (e.g. first turn, workdir change,
          // or local CLI), still carry recent context so the fresh foreground is not blank.
          if (!forked && origin === 'fg-handoff') {
            const contextNote = fallbackContextSummary(oldSid)
            if (contextNote !== '') {
              try {
                const notice = `[Background task notice] Your earlier turn ("${task.title}", ${task.id}) just finished in the background; its result is being delivered next.${contextNote}`
                await rt.ensureCapabilities(newSid)
                const freshAgent = await rt.resolveAgent(newSid)
                freshAgent.inject?.(createUserMessage({
                  content: [{ type: 'text', text: notice }],
                  source: { kind: SOURCE_KIND, form: 'relay', role: 'task-handoff', taskId: task.id },
                }))
              } catch (error) {
                rt.warn('ds-bot: injecting fallback context on %s failed: %s', newSid, error)
              }
            }
          }
          if (isActiveTask(task)) {
            const events = oldAgent?.session?.snapshotEvents?.() ?? []
            const lastEnd = events.findLast(ev => ev?.type === 'turn/end')
            const endReason = lastEnd?.data?.reason
            const endFailure = endReason?.kind === 'error' ? turnFailure(endReason.error) : undefined
            const said = lastReplyOf(oldAgent?.session, task.workDir)
            queueMicrotask(() => void handleTurnEnd(bot, task, endReason, endFailure, said)
              .catch(error => rt.warn('ds-bot: post-handoff settle failed for %s: %s', task.id, error)))
          }
        } else if (origin === 'fg-handoff') {
          // Inform the new foreground only when the user's own previous turn moved to
          // background and is still running (never leak hidden Bot-to-Bot work).
          try {
            const contextNote = forked ? '' : fallbackContextSummary(oldSid)
            const movedPromptBlock = movedPrompt !== '' && movedPrompt.length > task.title.length
              ? `\nMoved request: ${movedPrompt}`
              : ''
            const notice = `[Background task notice] Your earlier turn ("${task.title}", ${task.id}) moved to the background and is still running there; its result will come back here when it finishes. Use task_send(task: "${task.id}", ...) if the user's next message corrects or redirects that work.${movedPromptBlock}${contextNote}`
            await rt.ensureCapabilities(newSid)
            const freshAgent = await rt.resolveAgent(newSid)
            freshAgent.inject?.(createUserMessage({
              content: [{ type: 'text', text: notice }],
              source: { kind: SOURCE_KIND, form: 'relay', role: 'task-handoff', taskId: task.id },
            }))
          } catch (error) {
            rt.warn('ds-bot: injecting task-handoff notice on %s failed: %s', newSid, error)
          }
        }

        // Drain any Desktop/Web messages intercepted while the handoff was running
        // (including when `channel.js:sendUser` initiated the handoff).
        while (record.messages.length > 0) {
          const batch = record.messages.splice(0)
          await forwardPulledMessages(newSid, batch, bot.name, { botId: bot.id })
        }
      }

      const moveResult = { sessionId: newSid, taskId: task.id, moved: true }
      const saveOpIds = [...record.operationIds]
      // Any earlier failed pending-save move for this same Bot is now superseded by this
      // newer move: persist stale tombstones for those old operationIds atomically alongside
      // this commit so a host restart never lets an unretried old ID move a later turn.
      const supersededOpIds = []
      for (const [oldOpId, entry] of pendingSaveMoveOps) {
        if (entry.botId === bot.id && !saveOpIds.includes(oldOpId)) supersededOpIds.push(oldOpId)
      }
      const staleResult = { sessionId: newSid, taskId: null, moved: false, stale: true }
      const pendingEntry = {
        botId: bot.id,
        oldSid,
        newSid,
        taskId: task.id,
        operationIds: new Set(saveOpIds),
        savedOperationIds: new Set(),
        finishPostSave,
        savingPromise: undefined,
      }
      const savePromise = (async () => {
        const allStagedIds = [...saveOpIds, ...supersededOpIds]
        for (const id of allStagedIds) addStagedMoveOp(id)
        const staged = stagePersistedMoveOps([
          ...saveOpIds.map(id => ({ id, result: moveResult })),
          ...supersededOpIds.map(id => ({ id, result: staleResult })),
        ])
        try {
          await rt.save({ required: true })
        } catch (error) {
          unstagePersistedMoveOps(staged)
          for (const id of record.operationIds) {
            pendingEntry.operationIds.add(id)
            rememberPendingSaveMoveOp(id, pendingEntry)
          }
          throw error
        } finally {
          for (const id of allStagedIds) {
            removeStagedMoveOp(id)
            if (inFlightSaveMoveOps.get(id) === savePromise) inFlightSaveMoveOps.delete(id)
          }
        }
        record.saved = true
        for (const id of saveOpIds) {
          pendingSaveMoveOps.delete(id)
          record.savedOperationIds.add(id)
          rememberMoveOp(id, moveResult)
        }
        for (const id of supersededOpIds) {
          pendingSaveMoveOps.delete(id)
          rememberMoveOp(id, staleResult)
        }
        await finishPostSave()
        return moveResult
      })()
      for (const id of saveOpIds) inFlightSaveMoveOps.set(id, savePromise)
      await savePromise
      return newSid
    })()

    record.promise = run.finally(() => {
      if (handoffing.get(bot.id) === record) handoffing.delete(bot.id)
      if (record.committed && record.newSid !== undefined && record.messages.length > 0) {
        void forwardPulledMessages(record.newSid, record.messages.splice(0), bot.name, { botId: bot.id })
      } else if (!record.committed && record.messages.length > 0) {
        const leftover = record.messages.splice(0)
        if (rt.botOf(bot.id) === bot) {
          void restorePulledMessages(leftover, { forceNextTurn: isBotHandoff, botId: bot.id })
        } else {
          for (const item of leftover) releaseTransferLock(item.transferId, item.transferToken)
        }
      }
    })
    handoffing.set(bot.id, record)
    return record.promise
  }

  // Explicit user-triggered action: move the Bot's currently running foreground turn
  // to a background task and open a fresh foreground part. Idempotent on `operationId`
  // (persisted in `state.completedMoveOps` across restarts) and concurrent clicks on
  // the same running turn.
  async function moveForegroundToBackground({ botId, expectedSessionId, expectedTurn, operationId } = {}) {
    if (typeof operationId === 'string' && operationId !== '') {
      const activeSave = inFlightSaveMoveOps.get(operationId)
      if (activeSave !== undefined) return activeSave
      const done = readCompletedMoveOp(operationId)
      if (done !== undefined) {
        if (done.stale === true) {
          throw Object.assign(new Error('This conversation has already moved on'), { code: 'bot/stale' })
        }
        return { sessionId: done.sessionId, taskId: done.taskId ?? null, moved: Boolean(done.moved) }
      }
      const pendingSave = pendingSaveMoveOps.get(operationId)
      if (pendingSave !== undefined) {
        const curBot = rt.botOf(pendingSave.botId)
        const stillMatches = curBot !== undefined
          && curBot.sessionId === pendingSave.newSid
          && (curBot.tasks ?? []).some(t => t?.id === pendingSave.taskId)
        if (!stillMatches) {
          const allStaleIds = [...pendingSave.operationIds]
          const staleReceipt = { sessionId: curBot?.sessionId ?? pendingSave.newSid, taskId: null, moved: false, stale: true }
          // Keep superseded entries in `pendingSaveMoveOps` until a required save durably
          // writes their stale tombstones (either here or inside a newer move's retry).
          const unstagedStaleIds = allStaleIds.filter(id => !isStagedMoveOp(id))
          if (unstagedStaleIds.length > 0) {
            for (const id of unstagedStaleIds) addStagedMoveOp(id)
            const staged = stagePersistedMoveOps(unstagedStaleIds.map(id => ({ id, result: staleReceipt })))
            let persisted = false
            try {
              await rt.save({ required: true })
              persisted = true
            } catch {
              unstagePersistedMoveOps(staged)
            } finally {
              for (const id of unstagedStaleIds) removeStagedMoveOp(id)
            }
            if (persisted) {
              for (const id of unstagedStaleIds) {
                pendingSaveMoveOps.delete(id)
                rememberMoveOp(id, staleReceipt)
              }
            }
          }
          throw Object.assign(new Error('This conversation has already moved on'), { code: 'bot/stale' })
        }
        pendingSave.operationIds.add(operationId)
        if (pendingSave.savingPromise === undefined) {
          const retryOpIds = [...pendingSave.operationIds]
          const supersededOpIds = []
          for (const [oldOpId, entry] of pendingSaveMoveOps) {
            if (entry.botId === pendingSave.botId && entry !== pendingSave && !retryOpIds.includes(oldOpId)) {
              supersededOpIds.push(oldOpId)
            }
          }
          const staleResult = { sessionId: pendingSave.newSid, taskId: null, moved: false, stale: true }
          const retryPromise = (async () => {
            const result = { sessionId: pendingSave.newSid, taskId: pendingSave.taskId, moved: true }
            const allStagedIds = [...retryOpIds, ...supersededOpIds]
            for (const id of allStagedIds) addStagedMoveOp(id)
            const staged = stagePersistedMoveOps([
              ...retryOpIds.map(id => ({ id, result })),
              ...supersededOpIds.map(id => ({ id, result: staleResult })),
            ])
            try {
              await rt.save({ required: true })
            } catch (error) {
              unstagePersistedMoveOps(staged)
              throw error
            } finally {
              for (const id of allStagedIds) {
                removeStagedMoveOp(id)
                if (inFlightSaveMoveOps.get(id) === retryPromise) inFlightSaveMoveOps.delete(id)
              }
            }
            for (const id of retryOpIds) {
              pendingSaveMoveOps.delete(id)
              pendingSave.savedOperationIds.add(id)
              rememberMoveOp(id, result)
            }
            for (const id of supersededOpIds) {
              pendingSaveMoveOps.delete(id)
              rememberMoveOp(id, staleResult)
            }
            await pendingSave.finishPostSave()
            return result
          })().finally(() => {
            if (pendingSave.savingPromise === retryPromise) pendingSave.savingPromise = undefined
          })
          pendingSave.savingPromise = retryPromise
          for (const id of retryOpIds) inFlightSaveMoveOps.set(id, retryPromise)
        }
        const res = await pendingSave.savingPromise
        if (!pendingSave.savedOperationIds.has(operationId)) {
          await persistMoveReceipts([operationId], res)
          pendingSave.savedOperationIds.add(operationId)
        }
        return res
      }
    }
    const bot = rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    const oldSid = rt.chatOf(bot.id)
    const joinInFlight = async (inFlight) => {
      if (typeof operationId === 'string' && operationId !== '') inFlight.operationIds.add(operationId)
      const sid = await inFlight.promise
      const result = { sessionId: sid, taskId: inFlight.taskId ?? null, moved: inFlight.committed === true && inFlight.saved === true }
      if (typeof operationId === 'string' && operationId !== '' && !inFlight.savedOperationIds.has(operationId)) {
        await persistMoveReceipts([operationId], result)
        inFlight.savedOperationIds.add(operationId)
      }
      return result
    }
    if (expectedSessionId !== undefined && expectedSessionId !== oldSid) {
      const inFlight = handoffing.get(bot.id)
      if (inFlight !== undefined && !inFlight.aborted && inFlight.oldSid === expectedSessionId) {
        return joinInFlight(inFlight)
      }
      throw Object.assign(new Error('This conversation has already moved on'), { code: 'bot/stale' })
    }
    const inFlight = handoffing.get(bot.id)
    if (inFlight !== undefined && !inFlight.aborted && inFlight.oldSid === oldSid) {
      return joinInFlight(inFlight)
    }
    if (expectedTurn !== undefined && rt.live.get(oldSid)?.turn !== expectedTurn) {
      throw Object.assign(new Error('This turn has already ended'), { code: 'bot/stale' })
    }
    const blocked = foregroundMoveBlockReason(bot, oldSid)
    if (blocked !== undefined) {
      throw Object.assign(new Error(blocked.message), { code: blocked.code })
    }
    const newSid = await handoffForeground(bot, oldSid, [], { explicit: true, operationId, expectedTurn })
    const task = (bot.tasks ?? []).findLast(item => item?.sessionId === oldSid)
    const moved = newSid !== oldSid && task !== undefined
    return { sessionId: newSid, taskId: moved ? task.id : null, moved }
  }

  // Spawns a dedicated background task (`origin: 'bot-handoff'`) for an incoming peer
  // Bot request while the target Bot's foreground chat is busy, without switching the
  // user's visible foreground session or interrupting desktop drafts/IME.
  async function spawnBotHandoffTask(target, fromSessionId, { fromBot, fromPart, parentWork, imOrigin, text, files = [], length, exchangeId, reuseWork = false }) {
    const id = newId()
    const now = Date.now()
    const title = oneLine(`From ${fromBot.name}: ${text}`, TITLE_MAX)
    const inherited = slimSegments(target)
    const baseTask = {
      id,
      title,
      brief: oneLine(text, BRIEF_KEPT),
      from: fromSessionId,
      ...(inherited.length > 0 ? { inheritedSegments: inherited } : {}),
      origin: 'bot-handoff',
      exchangeId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    const { sessionId, task } = await rt.openTaskPart(target, fromSessionId, baseTask, { fork: false })
    const prevWork = reuseWork ? rt.resolveWork?.(exchangeId)?.work : undefined
    const prevToSession = prevWork?.toSession
    const prevToTaskId = prevWork?.toTaskId
    const opened = reuseWork
      ? (rt.setWorkTargetSession?.(exchangeId, sessionId, task.id), rt.resolveWork?.(exchangeId)?.work)
      : rt.openWork?.(exchangeId, { from: fromBot.id, to: target.id, parent: parentWork, ...(fromPart ? { fromPart } : {}), ...(imOrigin ? { imOrigin } : {}), toSession: sessionId, toTaskId: task.id, goal: text })
    const workRef = opened?.ref ?? rt.workRefOf?.(exchangeId)
    try {
      await rt.deliver({
        fromId: fromBot.id,
        toId: target.id,
        sessionId,
        ...(fromPart ? { fromPart } : {}),
        text,
        files,
        ...(length === undefined ? {} : { length }),
        role: 'request',
        steer: false,
        exchangeId,
        ...(workRef ? { workRef } : {}),
      })
    } catch (error) {
      if (error?.delivered !== true) {
        rt.forgetDelivery?.(exchangeId)
        if (reuseWork) rt.setWorkTargetSession?.(exchangeId, prevToSession ?? null, prevToTaskId ?? null)
        else rt.dropWork?.(exchangeId)
        await settleTask(target, task, 'failed', { error: error?.message ?? String(error), notifyForeground: false, settleWork: false })
      }
      throw error
    }
    emitTaskEvent('task.started', target, task, { origin: 'bot-handoff' })
    return { ...task, sessionId }
  }

  // Intercepts Desktop/Web user messages sent to a busy foreground Bot (or landing on a
  // just-moved background task during the UI polling gap). Runs on `agent/inbox/inserted`
  // — after `Session.append()` releases its reentrancy guard and before `wakeDriver()` or
  // the next step claims the inbox — so `inbox.remove()` succeeds synchronously without
  // reentering `Session.append()`.
  const interceptForegroundUserMessage = (agent, msg) => {
    const id = agent?.id ?? agent?.session?.id
    if (replacedIds.delete(msg?.id)) return
    if (id === undefined || msg?.source?.kind !== 'user' || skipInterceptIds.has(msg.id)) return
    const target = agent.inbox?.locate?.(msg.id)?.target
      ?? (agent.inbox?.nextStep?.some(item => item?.id === msg.id) ? 'next-step' : 'next-turn')
    const clearSteeredAt = () => {
      const liveEntry = rt.live.get(id)
      if (liveEntry !== undefined && !(agent.inbox?.nextStep ?? []).some(item => item?.source?.kind === 'user')) {
        liveEntry.steeredAt = undefined
      }
    }

    // Case 1: Post-handoff polling gap — a Desktop/Web composer still pointing at the
    // old sessionId after `bot.sessionId` moved on. Redirect user messages to foreground.
    const taskOwner = rt.taskOwners?.get(id)
    if (taskOwner !== undefined) {
      if (agent?.inbox?.remove === undefined) return false
      const wasIdle = agent.status === 'idle'
      if (!agent.inbox.remove(msg.id)) return false
      if (wasIdle && !hasWakingInboxInput(agent)) rejectEmptyTaskWake.add(id)
      clearSteeredAt()
      const pulled = [{ msg, target, oldAgent: agent }]
      recordPendingTransfers(pulled, taskOwner.roomId !== undefined ? { roomId: taskOwner.roomId } : { botId: taskOwner.botId })
      void (async () => {
        if (taskOwner.roomId !== undefined) {
          const room = rt.roomOf(taskOwner.roomId)
          const roomSid = room === undefined ? undefined : rt.sessionOfRoom(room)
          if (roomSid !== undefined && roomSid !== id) await forwardPulledMessages(roomSid, pulled, room.name, { roomId: taskOwner.roomId })
          else await clearPendingTransfers(pulled.map(item => item.transferId))
          return
        }
        const pending = handoffing.get(taskOwner.botId)
        if (pending !== undefined) await pending.promise.catch(() => {})
        const ownerBot = rt.botOf(taskOwner.botId)
        let fgSid = ownerBot === undefined ? undefined : rt.chatOf(ownerBot.id)
        if (fgSid === undefined || fgSid === id || rt.taskOwners?.has(fgSid)) {
          await clearPendingTransfers(pulled.map(item => item.transferId))
          return
        }
        // Only isolate a hidden peer-Bot turn on the new foreground; never recursively
        // hand off an ordinary user foreground turn during a polling-gap redirect (#2077).
        if (mustIsolateHiddenWork(ownerBot, fgSid)) {
          const fgAgent = ctx.get('agents')?.get(fgSid)
          const rebased = pulled.map(item => ({ ...item, oldAgent: fgAgent }))
          fgSid = await handoffForeground(ownerBot, fgSid, rebased)
          return
        }
        await forwardPulledMessages(fgSid, pulled, ownerBot?.name, { botId: taskOwner.botId })
      })().catch(error => rt.warn('ds-bot: redirecting user input from background task %s failed: %s', id, error))
      return true
    }

    // Case 2: Audience isolation or in-flight handoff — ordinary user messages (`steer`
    // or `queue`) stay on the foreground turn so `steer` and `queue` work as expected.
    // Only hidden peer-Bot work turns (or an explicit handoff already in flight for `id`)
    // intercept human input here.
    const botId = rt.chatOwners.get(id)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (!mustIsolateHiddenWork(bot, id)) {
      // When foreground handoff is unavailable (e.g. local CLI Bot) while a hidden
      // peer-Bot turn is running, demote user `next-step` steers to `next-turn` so the
      // user's message never injects into or leaks out of the hidden peer-Bot turn.
      const liveEntry = rt.live.get(id)
      if (bot !== undefined && target === 'next-step' && liveEntry?.turn !== undefined
        && rt.isHiddenBotWorkTurn?.(bot.id, activeTurnInfo(liveEntry)) && agent?.inbox?.remove !== undefined) {
        if (agent.inbox.remove(msg.id)) {
          clearSteeredAt()
          skipInterceptIds.add(msg.id)
          try {
            if (typeof agent.send === 'function') agent.send(msg, 'next-turn', true)
            else agent.followup?.(msg)
          } finally {
            skipInterceptIds.delete(msg.id)
          }
        }
      }
      return false
    }
    if (agent?.inbox?.remove === undefined) return false
    const earlier = handoffing.get(bot.id)?.oldSid === id ? [] : pullPendingUserMessages(agent, msg.id)
    if (!agent.inbox.remove(msg.id)) {
      if (earlier.length > 0) void restorePulledMessages(earlier)
      return false
    }
    clearSteeredAt()
    const pulled = [...earlier, { msg, target, oldAgent: agent }]
    recordPendingTransfers(pulled, { botId: bot.id })

    void handoffForeground(bot, id, pulled).catch((error) => {
      rt.warn('ds-bot: foreground handoff for %s failed; restored input: %s', bot.name, error)
    })
    return true
  }

  // Desktop/Web foreground busy auto-handoff runs on `agent/inbox/inserted` (outside
  // `Session.append()`), avoiding DSH's reentrancy guard on `session/event`.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const pulled = interceptForegroundUserMessage(agent, message) === true
    if (!pulled && message?.source?.rpcId !== undefined) {
      noteAdmittedRpc(agent?.id ?? agent?.session?.id, message.source.rpcId)
    }
  })

  // Strict turn/end state machine guard + in-place queue edit (`inbox.replace`) tagging.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'user/message') {
      if (event.data?.source?.rpcId !== undefined) noteAdmittedRpc(session?.id, event.data.source.rpcId)
      return
    }
    if (event?.type === 'agent/inbox/spliced') {
      if ((event.data?.removedCount ?? 0) > 0 && (event.data?.inserted?.length ?? 0) > 0
        && (rt.chatOwners.has(session?.id) || rt.taskOwners?.has(session?.id))) {
        for (const msg of event.data.inserted) {
          if (msg?.id === undefined) continue
          if (replacedIds.size >= MAX_REPLACED_IDS) replacedIds.delete(replacedIds.values().next().value)
          replacedIds.add(msg.id)
        }
      }
      return
    }
    if (event?.type !== 'turn/end') return
    const id = session?.id
    const found = taskBySession(id)
    if (found === undefined) return
    const { bot, task } = found
    if (!isActiveTask(task)) return

    const reason = event.data?.reason
    // 1. Host shutdown (`disposed`) or steer cut: keep task active.
    if (reason?.kind === 'aborted' && (reason.reason?.kind === 'disposed' || (reason.reason?.kind === 'hook' && reason.reason?.reason === STEER_CUT))) return
    // 2. Context rollover / part switch: old segment yields to the new segment.
    const liveEntry = rt.live.get(id)
    if (rt.isSwitchingPart?.(id) || liveEntry?.switched === true || liveEntry?.lastSwitched === true || reason?.kind === 'blocked') return

    const failure = reason?.kind === 'error' ? turnFailure(reason.error) : undefined
    const said = lastReplyOf(session, task.workDir)
    queueMicrotask(() => void handleTurnEnd(bot, task, reason, failure, said)
      .catch(error => rt.warn('ds-bot: settling task %s failed: %s', task.id, error)))
  })
  ctx.on?.('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) forgetTaskSession(agent.id)
  })

  async function handleTurnEnd(bot, task, reason, failure, said) {
    if (!isActiveTask(task) || settling.has(task.id)) return
    // 3. Turn cancelled externally (not disposed, not already stopped).
    if (reason?.kind === 'aborted') {
      await settleTask(bot, task, 'stopped', { error: reason.reason?.reason ?? reason.reason?.kind ?? 'cancelled', notifyForeground: true })
      return
    }
    // 4. Turn ended in model/runtime error.
    if (reason?.kind === 'error' || failure !== undefined) {
      const msg = failure?.message || failure?.code || reason?.error?.message || reason?.message || 'model call failed'
      await settleTask(bot, task, 'failed', { text: said, error: msg, notifyForeground: true })
      return
    }
    // 5. Ignore part-switch handoff acknowledgment turns, or a new turn / follow-up / retry already in flight.
    if (said === HANDOFF_ACK || delivering.has(task.id)) return
    const currentLive = rt.live.get(task.sessionId)
    if (currentLive?.turn !== undefined || currentLive?.retrying === true) return
    const currentAgent = ctx.get('agents')?.get(task.sessionId)
    if (hasWakingInboxInput(currentAgent) || hasPendingTaskUnread(task.sessionId)) return
    // 6. Still waiting on background shell jobs inside this task.
    if ((rt.runningJobs?.(task.sessionId)?.length ?? 0) > 0) return
    // 7. Still waiting on an approval card.
    if (rt.waitsForApproval?.(task.sessionId)) {
      if (task.status !== 'waiting_approval') {
        task.status = 'waiting_approval'
        task.updatedAt = Date.now()
        await rt.save()
      }
      return
    }
    // 8. Still waiting on outgoing Bot-to-Bot / group report-back works or ask_back input.
    if (hasOpenOutgoingWorks(bot, task) || isAwaitingHandoffInput(task)
      || (task.origin === 'bot-handoff' && task.exchangeId !== undefined && currentLive?.lastAskedBackWork === task.exchangeId)) {
      if (task.status !== 'waiting_work') {
        task.status = 'waiting_work'
        task.updatedAt = Date.now()
        await rt.save()
      }
      return
    }
    const finalText = reason?.kind === 'max-tokens' ? cutOffText(said) : said
    await settleTask(bot, task, 'completed', { text: finalText, notifyForeground: true })
  }

  const callerScopeOf = (exec) => {
    const id = exec.agent?.id
    if (id === undefined || rt.taskOwners?.has(id)) return undefined
    const groupOwner = rt.groupOwners.get(id)
    if (groupOwner !== undefined) {
      const bot = rt.botOf(groupOwner.botId)
      return bot === undefined ? undefined : { bot, roomId: groupOwner.roomId }
    }
    const botId = rt.chatOwners.get(id)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    return bot === undefined ? undefined : { bot, roomId: undefined }
  }
  const rejectIfTask = (exec) => (rt.taskOwners?.has(exec.agent?.id)
    ? 'Background tasks cannot manage other background tasks. Finish your work and report back to your chat.'
    : undefined)

  const hasRoomTasks = (roomId, botId, ignoreTaskId) => activeTasksOf(rt.botOf(botId))
    .some(task => task.roomId === roomId && (ignoreTaskId === undefined || task.id !== ignoreTaskId))
  const activeRoomTasks = () => {
    const out = []
    for (const bot of Object.values(state.bots)) {
      for (const task of activeTasksOf(bot)) {
        if (task.roomId !== undefined) out.push({ roomId: task.roomId, botId: bot.id, task })
      }
    }
    return out
  }
  async function stopMemberRoomTasks(roomId, botId, reason = 'stopped') {
    const bot = rt.botOf(botId)
    if (bot === undefined) return false
    let stopped = false
    for (const task of activeTasksOf(bot)) {
      if (task.roomId !== roomId) continue
      stopped = (await stopTask(bot, task, reason, { notifyForeground: false })) || stopped
    }
    return stopped
  }
  async function stopRoomTasks(roomId, reason = 'stopped') {
    let stopped = false
    for (const bot of Object.values(state.bots)) {
      stopped = (await stopMemberRoomTasks(roomId, bot.id, reason)) || stopped
    }
    return stopped
  }

  rt.teamTools.push(defineTool({
    name: 'task_start',
    description: 'Start a background task in a separate Session while this chat stays free. Works in your own chat and in group chats (inheriting the group folder, permissions, and memory). It inherits chat context when possible (on local CLI agents it starts a fresh CLI session with a recent summary), and its final reply comes back here when it finishes.',
    parameters: {
      title: { type: 'string', required: true, description: `Short name for the task, at most ${TITLE_MAX} characters, in the user's language` },
      brief: { type: 'string', required: true, description: 'Clear goal, scope, and what to report back' },
      workdir: { type: 'string', description: 'Optional separate working folder (e.g. a git worktree) for this task' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      try {
        const task = await startTask(exec.agent?.id, args, exec)
        const mode = task.forked ? 'with full chat context' : 'in a fresh session with recent summary'
        return `Started background task "${task.title}" (${task.id}) ${mode}. Its result will come back here when it finishes; do not wait for it.`
      } catch (error) {
        return error.message
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_send',
    description: 'Send a follow-up instruction to one of your active background tasks in this chat.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task id or title from task_list' },
      text: { type: 'string', required: true, description: 'Follow-up message for the task' },
    },
    output,
    async execute({ task: ref, text }, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const scope = callerScopeOf(exec)
      const task = scope === undefined ? undefined : findTask(scope.bot, ref, scope.roomId)
      if (task === undefined) return 'No such task of yours. See task_list.'
      if (!isActiveTask(task)) return `Task "${task.title}" (${task.id}) is ${task.status}. Start a new task if more work is needed.`
      await deliverToTask(task.id, { text, steer: true })
      return `Sent follow-up to task "${task.title}" (${task.id}).`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_stop',
    description: 'Stop one of your active background tasks and any background shell jobs it started.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task id or title from task_list' },
    },
    output,
    async execute({ task: ref }, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const scope = callerScopeOf(exec)
      const task = scope === undefined ? undefined : findTask(scope.bot, ref, scope.roomId)
      if (task === undefined) return 'No such task of yours. See task_list.'
      if (!isActiveTask(task)) return `Task "${task.title}" (${task.id}) is already ${task.status}.`
      await stopTask(scope.bot, task, 'stopped by the Bot', { notifyForeground: false })
      return `Stopped task "${task.title}" (${task.id}).`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_list',
    description: 'List your background tasks in this chat with id, title, status, and start time.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const scope = callerScopeOf(exec)
      const list = scope === undefined ? [] : scopedTasksOf(scope.bot, scope.roomId)
      if (list.length === 0) return 'No background tasks.'
      return list.map(task => `${task.id} · ${task.title} · ${statusOf(task)} · started ${new Date(task.startedAt).toISOString()}`).join('\n')
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_read',
    description: 'Read the full report or latest reply of one of your background tasks in this chat.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task id or title from task_list' },
    },
    output,
    async execute({ task: ref }, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const scope = callerScopeOf(exec)
      const task = scope === undefined ? undefined : findTask(scope.bot, ref, scope.roomId)
      if (task === undefined) return 'No such task of yours. See task_list.'
      const header = `${task.id} · ${task.title} · ${statusOf(task)}`
      const saved = readReportFile(task.reportFile)
      if (saved !== undefined) return `${header}\n\n${saved}`
      const agent = ctx.get('agents')?.get(task.sessionId) ?? await rt.resolveAgent(task.sessionId).catch(() => undefined)
      const latest = agent !== undefined ? lastReplyOf(agent.session, task.workDir) : ''
      if (latest !== '') return `${header}\n\n${latest}`
      if (task.summary) return `${header}\n\n${task.summary}`
      if (task.error) return `${header}\n\nError: ${task.error}`
      return `${header}\n\n(No output recorded yet.)`
    },
  }))

  Object.assign(rt, {
    startTask,
    canMoveForeground,
    canBackgroundView,
    mustIsolateHiddenWork,
    shouldSpawnPeerTask,
    shouldMoveForeground,
    isLocalCliSession,
    isAdmittedOn,
    isAdmittedForSend,
    confirmSessionFlushed,
    noteAdmittedRpc,
    noteSendPrompted,
    isHandingOff: id => id !== undefined && [...handoffing.values()].some(record => !record.aborted && record.oldSid === id),
    consumeEmptyTaskWake: id => id !== undefined && rejectEmptyTaskWake.delete(id),
    handoffForeground,
    moveForegroundToBackground,
    spawnBotHandoffTask,
    stopTask: async (botId, taskId, reason = 'cancelled by the user') => {
      const bot = rt.botOf(botId)
      const task = findTask(bot, taskId, null)
      if (task === undefined) throw Object.assign(new Error('Unknown task'), { code: 'bot/not-found' })
      const stopped = await stopTask(bot, task, reason, { notifyForeground: false })
      if (stopped && task.roomId !== undefined) {
        await rt.reconcileStoppedRoomTask?.(task.roomId, bot.id)
      }
      return stopped
    },
    stopAllTasksOfBot,
    hasRoomTasks,
    activeRoomTasks,
    stopMemberRoomTasks,
    stopRoomTasks,
    deliverToTask,
    taskViewOf,
    taskById: findTaskGlobal,
    taskBySession,
    taskStatusOf: statusOf,
    forgetBotTasks,
    reconcileEndedTask,
    reconcileTasksAfterRestart,
    retireTasks,
    stopRetiringTasks,
    retireSettledTasksAfterIdle,
    onTaskEvent,
  })
}
