// Unified Run coordinator for the external API:
// Tracks chat turns, background tasks (mode: 'task'), and multi-member group batches
// through a single state machine:
//   queued -> running -> waiting_human -> running -> completed | stopped | failed
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateViewAnswer } from 'deep-view/core'
import { HANDOFF_ACK } from '../constants.js'
import { viewReply } from '../parts.js'
import { textOf } from '../text.js'
import { turnFailure } from '../turns.js'
import { usageChunk } from '../usage.js'

const RUNS_FILE = 'api-runs.json'
const MAX_RUNS = 1_000
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const EVENT_BUFFER_MAX = 400
const IDEMPOTENCY_MAX_LEN = 200
const ROOM_SETTLE_DEBOUNCE_MS = 180
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed'])

const isTerminal = status => TERMINAL_STATUSES.has(status)
const newRunId = () => `run_${randomBytes(6).toString('hex')}`
const newFileRef = () => `file_${randomBytes(8).toString('hex')}`

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch { /* windows */ }
  renameSync(temp, path)
}

function toIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function fingerprintOf(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function createRunCoordinator(rt, auth) {
  const { ctx, state } = rt
  const runsPath = join(rt.home, RUNS_FILE)

  // Persistent run index & idempotency map (survives restarts).
  const runs = new Map() // runId -> RunRecord
  const idempotency = new Map() // `${tokenId}\0${targetKind}\0${targetId}\0${key}` -> { fingerprint, runId, createdAt }

  // Live in-memory tracking for active runs.
  const active = new Map() // runId -> LiveTracker
  const byRequestId = new Map() // requestId -> runId
  const byTaskId = new Map() // taskId -> runId
  const bySession = new Map() // sessionId -> Set<runId>
  const byRoom = new Map() // roomId -> Set<runId>
  const files = new Map() // fileRef -> { kind, sessionId, botId, roomId, seq, index, attachmentId, name, mime, size }

  // API-originated user messages, keyed by sessionId -> { [seq]: tokenName }, for chat UI badges.
  const apiVia = new Map()
  let saveTimer = null
  let disposed = false

  const writes = () => rt.readOnly?.() === undefined

  function indexSession(sessionId, runId) {
    if (!sessionId) return
    let set = bySession.get(sessionId)
    if (set === undefined) {
      set = new Set()
      bySession.set(sessionId, set)
    }
    set.add(runId)
  }

  function unindexSession(sessionId, runId) {
    if (!sessionId) return
    const set = bySession.get(sessionId)
    if (set === undefined) return
    set.delete(runId)
    if (set.size === 0) bySession.delete(sessionId)
  }

  let offFeed = null
  const syncRoomFeedTap = () => {
    if (byRoom.size > 0 && offFeed === null) {
      offFeed = rt.feedTap?.((event, data) => {
        if (event === 'room' && data?.roomId && byRoom.has(data.roomId)) {
          for (const runId of byRoom.get(data.roomId)) {
            const tracker = active.get(runId)
            if (!tracker || isTerminal(tracker.run.status)) continue
            syncRoomLines(tracker)
            scheduleRoomSettleCheck(tracker)
          }
        }
      }) ?? null
    } else if (byRoom.size === 0 && offFeed !== null) {
      offFeed()
      offFeed = null
    }
  }

  function indexRoom(roomId, runId) {
    if (!roomId) return
    let set = byRoom.get(roomId)
    if (set === undefined) {
      set = new Set()
      byRoom.set(roomId, set)
    }
    set.add(runId)
    syncRoomFeedTap()
  }

  function unindexRoom(roomId, runId) {
    if (!roomId) return
    const set = byRoom.get(roomId)
    if (set === undefined) return
    set.delete(runId)
    if (set.size === 0) byRoom.delete(roomId)
    syncRoomFeedTap()
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

  function pruneHistory() {
    const cutoff = Date.now() - RUN_RETENTION_MS
    const list = [...runs.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)
    for (const run of list) {
      if (isTerminal(run.status) && (run.createdAtMs < cutoff || runs.size > MAX_RUNS)) {
        runs.delete(run.runId)
      }
    }
    for (const [key, entry] of idempotency) {
      if (!runs.has(entry.runId) && entry.createdAt < cutoff) idempotency.delete(key)
    }
  }

  function flushSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (!writes()) return
    pruneHistory()
    try {
      const payload = {
        version: 1,
        runs: [...runs.values()].map(serializeRun),
        idempotency: [...idempotency.entries()].map(([key, val]) => [key, val]),
      }
      writeJsonAtomic(runsPath, payload)
    } catch { /* best-effort */ }
  }

  function scheduleSave() {
    if (disposed || !writes()) return
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushSave()
    }, 150)
    saveTimer.unref?.()
  }

  function loadPersisted() {
    const saved = readJson(runsPath, null)
    if (!saved || typeof saved !== 'object') return
    let dirty = false
    if (Array.isArray(saved.runs)) {
      for (const item of saved.runs) {
        if (!item || typeof item.runId !== 'string') continue
        const record = {
          runId: item.runId,
          tokenId: item.tokenId ?? null,
          tokenName: item.tokenName ?? null,
          target: item.target ?? { kind: 'bot', id: '', name: '' },
          mode: item.mode ?? 'chat',
          status: item.status ?? 'stopped',
          createdAtMs: typeof item.createdAtMs === 'number' ? item.createdAtMs : (Date.parse(item.createdAt) || Date.now()),
          startedAtMs: typeof item.startedAtMs === 'number' ? item.startedAtMs : (item.startedAt ? Date.parse(item.startedAt) : null),
          finishedAtMs: typeof item.finishedAtMs === 'number' ? item.finishedAtMs : (item.finishedAt ? Date.parse(item.finishedAt) : null),
          sessionId: item.sessionId ?? null,
          partId: item.partId ?? null,
          taskId: item.taskId ?? null,
          output: item.output ?? { text: '', truncated: false, fullFileRef: null, messages: [], deliverables: [] },
          pendingAction: null,
          usage: item.usage ?? { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 },
          error: item.error ?? null,
        }
        // Any non-terminal run from a previous host process is marked interrupted/stopped.
        if (!isTerminal(record.status)) {
          record.status = 'stopped'
          record.finishedAtMs = Date.now()
          record.pendingAction = null
          record.error = { code: 'api/host-restarted', message: 'Host restarted before the run completed' }
          dirty = true
        }
        runs.set(record.runId, record)
      }
    }
    if (Array.isArray(saved.idempotency)) {
      for (const pair of saved.idempotency) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1].runId === 'string') {
          idempotency.set(pair[0], pair[1])
        }
      }
    }
    if (dirty) scheduleSave()
  }

  function serializeRun(record) {
    return {
      runId: record.runId,
      tokenId: record.tokenId,
      tokenName: record.tokenName,
      target: record.target,
      mode: record.mode,
      status: record.status,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      finishedAtMs: record.finishedAtMs,
      sessionId: record.sessionId,
      partId: record.partId,
      taskId: record.taskId,
      output: record.output,
      usage: record.usage,
      error: record.error,
    }
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
    if (tracker.roomTimer !== null) {
      clearTimeout(tracker.roomTimer)
      tracker.roomTimer = null
    }
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
    if (run.taskId) byTaskId.delete(run.taskId)
    for (const sid of tracker.sessions) unindexSession(sid, run.runId)
    if (run.target.kind === 'group') unindexRoom(run.target.id, run.runId)

    emitRunEvent(tracker, `run.${status}`, {
      status,
      output: run.output,
      usage: run.usage,
      error: run.error,
    })
    wakeWaiters(tracker)
    // Keep tracker briefly for tail SSE readers, then drop active handle.
    setTimeout(() => { active.delete(run.runId) }, 30_000).unref?.()
    scheduleSave()
  }

  function setWaitingHuman(tracker, action) {
    const { run } = tracker
    if (isTerminal(run.status)) return
    run.status = 'waiting_human'
    run.pendingAction = action
    emitRunEvent(tracker, 'human.required', { pendingAction: action })
    wakeWaiters(tracker)
    scheduleSave()
  }

  function clearWaitingHuman(tracker) {
    const { run } = tracker
    if (run.status !== 'waiting_human') return
    run.status = 'running'
    run.pendingAction = null
    emitRunEvent(tracker, 'run.resumed', { status: 'running' })
    scheduleSave()
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

  // Inspects whether a Bot/session currently has any open human-interaction card.
  function detectPendingAction(tracker) {
    if (tracker.dispatched === false) return null
    const { run } = tracker
    const botId = run.target.kind === 'bot' ? run.target.id : undefined
    const roomId = run.target.kind === 'group' ? run.target.id : undefined
    const sessionIds = [...tracker.sessions]

    // 1. Open tool approvals
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

    // 4. Secret request cards (never answerable via API)
    for (const sid of sessionIds) {
      const s = rt.own(state.secretRequests, sid)
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

    // 5. Browser hold / handoff (never answerable via API)
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
    return true
  }

  function scheduleRoomSettleCheck(tracker) {
    if (isTerminal(tracker.run.status)) return
    if (tracker.roomTimer !== null) clearTimeout(tracker.roomTimer)
    tracker.roomTimer = setTimeout(() => {
      tracker.roomTimer = null
      if (isTerminal(tracker.run.status)) return
      const roomId = tracker.run.target.id
      const pending = detectPendingAction(tracker)
      if (pending !== null) {
        setWaitingHuman(tracker, pending)
        return
      }
      if (!tracker.roomHeardActivity) return
      if (isRoomSettled(roomId)) {
        // Collect any final room log lines we haven't seen yet.
        syncRoomLines(tracker)
        finishRun(tracker, 'completed')
      } else {
        // Poll again lightly while members work.
        scheduleRoomSettleCheck(tracker)
      }
    }, ROOM_SETTLE_DEBOUNCE_MS)
    tracker.roomTimer.unref?.()
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
          indexSession(sid, tracker.run.runId)
          if (tracker.run.target.kind === 'group') {
            const room = rt.roomOf(tracker.run.target.id)
            tracker.lastRoomSeq = Math.max(tracker.lastRoomSeq, Number(room?.seq ?? 0))
            tracker.roomHeardActivity = true
            tracker.run.status = 'running'
            tracker.run.startedAtMs ??= Date.now()
            emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid })
            scheduleRoomSettleCheck(tracker)
          }
        }
      }
    }

    // Track group relay activity and member replies.
    const roomDirect = rt.roomOf(sid)
    if (roomDirect !== undefined && byRoom.has(roomDirect.id)) {
      for (const runId of byRoom.get(roomDirect.id)) {
        const tracker = active.get(runId)
        if (!tracker || isTerminal(tracker.run.status)) continue
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          tracker.roomHeardActivity = true
          syncRoomLines(tracker)
          scheduleRoomSettleCheck(tracker)
        }
      }
    }

    // Track member group sessions for usage and tool events during a group run.
    const groupOwner = rt.groupOwners.get(sid)
    if (groupOwner !== undefined && byRoom.has(groupOwner.roomId)) {
      for (const runId of byRoom.get(groupOwner.roomId)) {
        const tracker = active.get(runId)
        if (!tracker || isTerminal(tracker.run.status)) continue
        if (event.type === 'assistant/message') {
          const messageUsage = event.data?.usage ?? usageChunk(event.data?.stream)
          if (messageUsage !== undefined) addUsage(tracker.run, messageUsage)
        } else if (event.type === 'tool/call') {
          emitRunEvent(tracker, 'tool.call', { botId: groupOwner.botId, callId: event.data?.callId, name: event.data?.name })
        } else if (event.type === 'tool/result') {
          emitRunEvent(tracker, 'tool.result', { botId: groupOwner.botId, callId: event.data?.message?.toolCallId })
        } else if (event.type === 'turn/end') {
          syncRoomLines(tracker)
          scheduleRoomSettleCheck(tracker)
        }
      }
    }

    // Track single-Bot chat or task runs bound to this session.
    const runIds = bySession.get(sid)
    if (runIds === undefined) return
    for (const runId of Array.from(runIds)) {
      const tracker = active.get(runId)
      if (!tracker || isTerminal(tracker.run.status)) continue
      if (tracker.run.target.kind === 'group') continue

      if (event.type === 'turn/start') {
        const turnNum = event.data?.turn
        if (tracker.run.status === 'queued') {
          tracker.run.status = 'running'
          tracker.run.startedAtMs = Date.now()
          tracker.activeTurn = turnNum
          emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid, turn: turnNum })
          scheduleSave()
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
        // For task mode, bot-tasks.js owns final task settlement via onTaskEvent.
        if (tracker.run.mode === 'task') continue
        // Ignore a turn/end from an earlier queued turn before our user/message ran.
        if (tracker.run.status === 'queued') continue
        // If the Bot switched to a new part mid-run, follow the new part instead of settling.
        const currentChat = rt.chatOf(tracker.run.target.id)
        if (currentChat && currentChat !== sid && rt.live.get(sid)?.switched === true) {
          tracker.sessions.add(currentChat)
          indexSession(currentChat, tracker.run.runId)
          tracker.run.sessionId = currentChat
          tracker.run.partId = currentChat
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
    if (!sid || !bySession.has(sid)) return
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    const text = frame.chunk.text
    if (typeof text !== 'string' || text === '') return
    for (const runId of bySession.get(sid)) {
      const tracker = active.get(runId)
      if (!tracker || isTerminal(tracker.run.status)) continue
      if (tracker.run.status === 'queued') {
        tracker.run.status = 'running'
        tracker.run.startedAtMs ??= Date.now()
        emitRunEvent(tracker, 'run.started', { sessionId: sid, partId: sid })
      }
      emitRunEvent(tracker, 'delta', { sessionId: sid, text })
    }
  }

  function attachListeners() {
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
          if (data?.outcome === 'cancelled') {
            // Let turn/end decide if stopped or continued.
            clearWaitingHuman(tracker)
          } else {
            clearWaitingHuman(tracker)
          }
        }
      }
    }
  })

  // Track background task completion/failure/stop for `mode: 'task'` runs.
  const offTaskEvent = rt.onTaskEvent?.((payload) => {
    const runId = byTaskId.get(payload?.taskId)
    if (!runId) return
    const tracker = active.get(runId)
    if (!tracker || isTerminal(tracker.run.status)) return
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
  })

  // Also watch state saves for card dismissals or question/view settlement.
  const offSaved = rt.onSaved?.(() => {
    for (const tracker of active.values()) {
      if (tracker.run.status !== 'waiting_human') continue
      const current = detectPendingAction(tracker)
      if (current === null) clearWaitingHuman(tracker)
    }
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
      roomTimer: null,
      lastRoomSeq: 0,
      roomHeardActivity: false,
      activeTurn: undefined,
      userSeq: undefined,
      releaseSlot: slot.release,
    }
    runs.set(runId, record)
    active.set(runId, tracker)
    byRequestId.set(requestId, runId)
    if (idemRecord.key !== undefined) {
      idempotency.set(idemRecord.key, { fingerprint: idemRecord.fingerprint, runId, createdAt: now })
    }

    try {
      if (cleanMode === 'task') {
        const fromSessionId = rt.chatOf(bot.id)
        const taskTitle = String(title ?? '').trim() || cleanText.replace(/\s+/g, ' ').slice(0, 60) || 'API task'
        const started = await rt.startTask(fromSessionId, { title: taskTitle, brief: cleanText }, undefined, { api: true })
        record.taskId = started.id
        record.sessionId = started.sessionId
        record.partId = started.sessionId
        record.status = 'running'
        record.startedAtMs = Date.now()
        byTaskId.set(started.id, runId)
        tracker.sessions.add(started.sessionId)
        indexSession(started.sessionId, runId)
        emitRunEvent(tracker, 'run.started', { sessionId: started.sessionId, partId: started.sessionId, taskId: started.id })
      } else {
        const content = [
          ...(cleanText !== '' ? [{ type: 'text', text: cleanText }] : []),
          ...attachments.map(att => att.block),
        ]
        const beforeSid = rt.chatOf(bot.id)
        if (beforeSid) {
          tracker.sessions.add(beforeSid)
          indexSession(beforeSid, runId)
        }
        await rt.sendUser({ sessionId: bot.id, content, requestId })
        const afterSid = rt.chatOf(bot.id)
        if (afterSid && !tracker.sessions.has(afterSid)) {
          tracker.sessions.add(afterSid)
          indexSession(afterSid, runId)
          record.sessionId = afterSid
          record.partId = afterSid
        }
      }
      scheduleSave()
      return { run: toPublicView(record), replayed: false }
    } catch (error) {
      if (idemRecord.key !== undefined) idempotency.delete(idemRecord.key)
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
    const tracker = {
      run: record,
      requestId,
      sessions: new Set([roomSid ?? room.id]),
      dispatched: false,
      events: [],
      eventSeq: 0,
      listeners: new Set(),
      waiters: [],
      roomTimer: null,
      lastRoomSeq: Number(room.seq ?? 0),
      roomHeardActivity: false,
      activeTurn: undefined,
      userSeq: undefined,
      releaseSlot: slot.release,
    }
    runs.set(runId, record)
    active.set(runId, tracker)
    byRequestId.set(requestId, runId)
    if (idemRecord.key !== undefined) {
      idempotency.set(idemRecord.key, { fingerprint: idemRecord.fingerprint, runId, createdAt: now })
    }

    const launch = async () => {
      if (disposed || isTerminal(record.status)) return
      const memberBusy = [...rt.groupOwners].some(([sid, owner]) => owner.roomId === room.id && rt.live.get(sid)?.turn !== undefined)
      if (rt.roomActive?.(room.id) || memberBusy || rt.live.get(roomSid)?.turn !== undefined) {
        tracker.roomTimer = setTimeout(() => { void launch() }, 100)
        tracker.roomTimer.unref?.()
        return
      }
      try {
        tracker.dispatched = true
        tracker.lastRoomSeq = Number(room.seq ?? 0)
        indexRoom(room.id, runId)
        rt.clearImOrigin?.(roomSid)
        const content = [
          ...(cleanText !== '' ? [{ type: 'text', text: cleanText }] : []),
          ...attachments.map(att => att.block),
        ]
        await rt.sendUser({ sessionId: room.id, content, requestId })
        scheduleSave()
      } catch (error) {
        if (idemRecord.key !== undefined) idempotency.delete(idemRecord.key)
        finishRun(tracker, 'failed', { error: { code: error?.code ?? 'api/send-failed', message: error?.message ?? String(error) } })
      }
    }
    await launch()
    scheduleSave()
    return { run: toPublicView(record), replayed: false }
  }

  function checkIdempotency({ tokenId, targetKind, targetId, idempotencyKey, payload }) {
    if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') return {}
    const clean = String(idempotencyKey).trim()
    if (clean.length > IDEMPOTENCY_MAX_LEN) {
      throw Object.assign(new Error(`Idempotency-Key must be at most ${IDEMPOTENCY_MAX_LEN} characters`), { status: 400, code: 'api/invalid' })
    }
    const key = `${tokenId}\0${targetKind}\0${targetId}\0${clean}`
    const fingerprint = fingerprintOf(payload)
    const existing = idempotency.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw Object.assign(new Error('Idempotency-Key was already used with a different request payload'), { status: 409, code: 'api/idempotency-conflict' })
      }
      const prev = runs.get(existing.runId)
      if (prev !== undefined) return { replay: toPublicView(prev) }
    }
    return { key, fingerprint }
  }

  function getRunForPrincipal(runId, principal) {
    const record = runs.get(String(runId ?? ''))
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
    for (const record of runs.values()) {
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
    const record = runs.get(runId)
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
    const record = runs.get(runId)
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
    detachListeners()
    offApproval?.()
    offTaskEvent?.()
    offFeed?.()
    offSaved?.()
    for (const tracker of active.values()) {
      if (tracker.roomTimer !== null) clearTimeout(tracker.roomTimer)
      for (const resolve of tracker.waiters.splice(0, tracker.waiters.length)) resolve(toPublicView(tracker.run))
    }
    flushSave()
  }

  loadPersisted()

  return {
    attachListeners,
    detachListeners,
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
