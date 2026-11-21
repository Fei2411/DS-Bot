// Background tasks of a Bot (#783).
//
// Each task is a dedicated Session stored in `bot.tasks[]` (kept separate from
// user-opened parallel sessions in `bot.openParts[]` so viewing a task never swaps
// it into `bot.sessionId`). A task keeps a stable `id` across context part switches,
// runs an explicit lifecycle state machine, delivers all messages through `rt.deliver`
// (capabilities + inflight durability), integrates with handoff works and IM origins,
// bubbles approvals to the foreground/mobile/IM, and exposes hooks for v0.4.0 events.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HANDOFF_ACK, HISTORY_TIMEOUT_MS, SOURCE_KIND, STEER_CUT } from './constants.js'
import { within } from './folders.js'
import { absoluteLinks } from './links.js'
import { textOf } from './text.js'
import { activeTasksOf, isActiveTask, threadCurrentOfPart, threadOfPart } from './threads.js'
import { output } from './tools.js'
import { answerSender, cutOffText, turnFailure } from './turns.js'

const TITLE_MAX = 80
const BRIEF_KEPT = 500
const SUMMARY_MAX = 300
const REPORT_MAX = 4000
const CONTEXT_FALLBACK_MAX = 4000
const CONTEXT_FALLBACK_ITEMS = 8
const MAX_SETTLED_TASKS = 50

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const newId = () => `k_${randomBytes(3).toString('hex')}`
const safeFileName = id => `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`

export function install(rt) {
  const { ctx, state } = rt
  const reportsDir = join(rt.home, 'task-reports')
  const settling = new Set()
  const delivering = new Set()
  // Message IDs currently being restored to an old foreground Agent after a failed
  // pre-commit handoff, so `interceptForegroundUserMessage` never re-intercepts them.
  const restoringIds = new Set()
  // In-flight foreground-to-background handoffs per Bot:
  // botId -> { oldSid, committed, newSid, promise, messages }.
  const handoffing = new Map()
  const listeners = new Set()

  const isLocalCliBot = (bot, session) => {
    const ref = bot?.model ?? bot?.appliedModel ?? rt.cachedDefault?.()
    if (rt.localAgentBadge?.(ref) !== undefined || rt.isLocalAgentRef?.(ref) === true) return true
    const provider = session?.requestHeader?.()?.config?.provider
    return provider !== undefined && rt.isLocalAgentRoute?.(provider) === true
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
    if (typeof file !== 'string' || !/^[A-Za-z0-9_-]+\.txt$/.test(file) || rt.readOnly?.() !== undefined) return
    try { rmSync(join(reportsDir, file), { force: true }) } catch {}
  }

  const pruneSettledTasks = (bot) => {
    const list = tasksOf(bot)
    const settled = list.filter(task => !isActiveTask(task))
    if (settled.length <= MAX_SETTLED_TASKS) return
    const dropCount = settled.length - MAX_SETTLED_TASKS
    const toDrop = new Set(settled.slice(0, dropCount).map(task => task.id))
    for (const task of settled.slice(0, dropCount)) {
      dropReportFile(task.reportFile)
    }
    bot.tasks = list.filter(task => !toDrop.has(task.id))
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

  // Builds a bounded recent-context note when the task could not fork directly
  // (e.g. first turn with no turn/end, different workdir, or local CLI agent).
  const fallbackContextSummary = (fromSessionId) => {
    const sourceAgent = ctx.get('agents')?.get(fromSessionId)
    const events = sourceAgent?.session?.snapshotEvents?.() ?? []
    if (events.length === 0) return ''
    const lines = []
    for (const event of events) {
      if (event.type === 'user/message') {
        const text = textOf(event.data?.message?.content ?? event.data?.content ?? []).trim()
        if (text !== '') lines.push(`User: ${oneLine(text, 500)}`)
      } else if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content ?? []).trim()
        if (text !== '' && text !== HANDOFF_ACK) lines.push(`Assistant: ${oneLine(text, 500)}`)
      }
    }
    if (lines.length === 0) return ''
    const recent = lines.slice(-CONTEXT_FALLBACK_ITEMS).join('\n')
    const clipped = recent.length > CONTEXT_FALLBACK_MAX ? `${recent.slice(0, CONTEXT_FALLBACK_MAX)}…` : recent
    const room = rt.roomOf(rt.groupOwners.get(fromSessionId)?.roomId)
    const label = room !== undefined ? `group "${room.name}"` : 'your own chat'
    return `\n\n[Recent context from ${label}]\n${clipped}`
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
  async function settleTask(bot, task, outcome, { text = '', error, notifyForeground = true } = {}) {
    if (settling.has(task.id) || !isActiveTask(task)) return
    settling.add(task.id)
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

      pruneSettledTasks(bot)
      await rt.save()
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
        if (outcome !== 'completed' && task.exchangeId !== undefined && rt.ownsWork?.(bot.id, task.exchangeId)) {
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
            answerSender(rt, task.sessionId, asker, notice)
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
    } finally {
      settling.delete(task.id)
    }
  }

  // Starts a background task for a Bot from either its foreground own chat or a group member Session.
  async function startTask(fromSessionId, { title, brief, workdir }, exec) {
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
    // Link into the DM handoff tree when a foreground DM turn is answering another Bot.
    // Group tasks participate in group dispatch batches via `hasRoomTasks` instead.
    const liveEntry = rt.live.get(fromSessionId)
    const parentWork = room === undefined ? rt.workOf?.(liveEntry?.info) : undefined
    const linkWork = parentWork !== undefined && rt.ownsWork?.(bot.id, parentWork)
    const taskWorkId = linkWork ? `task:${id}` : undefined

    const baseTask = {
      id,
      title: name,
      brief: oneLine(detail, BRIEF_KEPT),
      from: fromSessionId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      ...(room !== undefined ? { roomId: room.id } : {}),
      ...(taskWorkId !== undefined ? { workId: taskWorkId, parentWorkId: parentWork } : {}),
      ...(imOrigin !== undefined ? { imOrigin } : {}),
    }

    const { sessionId, forked, task } = await rt.openTaskPart(bot, fromSessionId, baseTask, { workDir: resolvedDir })
    if (taskWorkId !== undefined) {
      rt.openWork?.(taskWorkId, { from: bot.id, parent: parentWork, name: `task "${name}"`, child: id })
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
    for (const task of tasksOf(bot)) {
      rt.cancelApprovals?.(task.sessionId)
      dropReportFile(task.reportFile)
    }
  }

  const hasInboxInput = agent => Boolean(agent?.inbox?.nextStep?.length || agent?.inbox?.nextTurn?.length)

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
      if (hasInboxInput(agent) || rt.unreadOf?.(sessionId)?.length > 0) return false
    }
    await handleTurnEnd(bot, task, reason, failure, said)
    return true
  }

  // Reconciles active tasks after a host restart:
  //  - tasks still running, resumed, resent, switching parts, or holding queued inbox items stay active;
  //  - tasks waiting on outgoing Bot/group works keep waiting;
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
        if (agent?.status === 'running' || hasInboxInput(agent)) continue
        if (hasOpenOutgoingWorks(bot, task)) {
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
  ctx.effect?.(() => () => { offApproval?.() }, 'ds-bot: bot-tasks approval bridge')

  // Determines whether a Bot's foreground chat is busy enough to move its running turn
  // intact into `bot.tasks[]` (or spawn a peer-Bot background task) rather than doing
  // a fast mid-model steer cut. Disabled for local CLI agents in v1.
  function shouldMoveForeground(bot, sessionId) {
    if (bot === undefined || sessionId === undefined || rt.readOnly?.() !== undefined) return false
    if (sessionId !== rt.chatOf(bot.id)) return false
    if (rt.groupOwners.has(sessionId) || rt.taskOwners?.has(sessionId)) return false
    if (rt.isSwitchingPart?.(sessionId)) return false
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (isLocalCliBot(bot, session)) return false
    if (handoffing.get(bot.id)?.oldSid === sessionId) return true
    const entry = rt.live.get(sessionId)
    if (entry?.turn === undefined) return false
    if ((entry.toolCount ?? 0) > 0 || (entry.calls?.size ?? 0) > 0) return true
    if ((rt.runningJobs?.(sessionId)?.length ?? 0) > 0) return true
    const waitMs = rt.backgroundWaitMs?.() ?? 5000
    return typeof entry.since === 'number' && Date.now() - entry.since >= waitMs
  }

  // Derives a short human-readable task title from the currently running foreground turn,
  // preferring `source.kind === 'user'` messages inside the current turn.
  const titleFromRunningTurn = (session, entry) => {
    const events = session?.snapshotEvents?.() ?? []
    const lastStart = events.findLastIndex(ev => ev.type === 'turn/start')
    const currentTurn = lastStart === -1 ? events : events.slice(lastStart)
    const extract = (ev) => textOf(ev?.data?.message?.content ?? ev?.data?.content ?? '')
      .replace(/^\[[^\r\n]*\]\r?\n?/, '')
      .trim()
    for (let i = currentTurn.length - 1; i >= 0; i -= 1) {
      const ev = currentTurn[i]
      if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') {
        const raw = extract(ev)
        if (raw !== '') return oneLine(raw, TITLE_MAX)
      }
    }
    for (let i = currentTurn.length - 1; i >= 0; i -= 1) {
      const ev = currentTurn[i]
      if (ev?.type !== 'user/message') continue
      if (ev.data?.source?.kind === SOURCE_KIND && ev.data.source.role === 'task-handoff') continue
      const raw = extract(ev)
      if (raw !== '') return oneLine(raw, TITLE_MAX)
    }
    if (lastStart > 0) {
      for (let i = lastStart - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') {
          const raw = extract(ev)
          if (raw !== '') return oneLine(raw, TITLE_MAX)
        }
      }
    }
    if (entry?.info?.senderName) return oneLine(`Request from ${entry.info.senderName}`, TITLE_MAX)
    return 'Background task'
  }

  // Restores pulled user messages back to their original Agent (pre-commit failure only)
  // without triggering `interceptForegroundUserMessage`, waking an idle Agent if needed.
  const restorePulledMessages = (items) => {
    for (const item of items) {
      const key = item.msg?.id
      if (key !== undefined) restoringIds.add(key)
      try {
        if (typeof item.oldAgent?.send === 'function') item.oldAgent.send(item.msg, item.target, true)
        else item.oldAgent?.followup?.(item.msg)
      } catch {}
      finally {
        if (key !== undefined) restoringIds.delete(key)
      }
    }
  }

  // Delivers pulled user messages onto a target foreground Session, retrying transient
  // destination failures without duplicating already-admitted items.
  const forwardPulledMessages = async (targetSid, items, botName) => {
    if (items.length === 0) return
    let nextIndex = 0
    const delays = [50, 250]
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        await rt.ensureCapabilities(targetSid)
        const freshAgent = await rt.resolveAgent(targetSid)
        while (nextIndex < items.length) {
          const item = items[nextIndex]
          freshAgent.followup(createUserMessage({ content: item.msg.content, source: item.msg.source }))
          nextIndex += 1
        }
        await ctx.sessions.flush(freshAgent.session)
        return
      } catch (error) {
        if (attempt < delays.length) {
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
          continue
        }
        rt.warn('ds-bot: forwarding queued input to new foreground %s for %s failed: %s', targetSid, botName ?? '?', error)
      }
    }
  }

  // Moves a busy foreground Session intact into `bot.tasks[]`, forks a fresh foreground
  // Session from the pre-turn completed boundary, updates `bot.sessionId`, drains any
  // concurrent intercepted Desktop/Web messages onto the new foreground, and returns
  // the new foreground sessionId. Serialized per Bot so rapid messages share one handoff.
  async function handoffForeground(bot, oldSid, initialMessages = []) {
    const existing = handoffing.get(bot.id)
    if (existing !== undefined && existing.oldSid === oldSid) {
      if (initialMessages.length > 0) {
        if (existing.committed && existing.newSid !== undefined) {
          void forwardPulledMessages(existing.newSid, initialMessages, bot.name)
        } else {
          existing.messages.push(...initialMessages)
        }
      }
      return existing.promise
    }
    const entry = rt.live.get(oldSid)
    const oldAgent = ctx.get('agents')?.get(oldSid)
    const info = entry?.info
    const activeWork = rt.workOf?.(info)
    const isBotHandoff = (info?.role === 'request' && info.audience !== 'user')
      || (activeWork !== undefined && rt.ownsWork?.(bot.id, activeWork))
    const origin = isBotHandoff ? 'bot-handoff' : 'fg-handoff'
    const title = titleFromRunningTurn(oldAgent?.session, entry)
    const startSeq = (() => {
      const events = oldAgent?.session?.snapshotEvents?.() ?? []
      if (events.length === 0) return 0
      const lastStart = events.findLastIndex(ev => ev?.type === 'turn/start')
      const boundary = lastStart >= 0 ? lastStart : events.length
      for (let i = boundary - 1; i >= 0; i -= 1) {
        if (events[i]?.type === 'turn/end') {
          return Number.isInteger(events[i].seq) ? events[i].seq + 1 : i + 1
        }
      }
      return 0
    })()
    const movedImOrigin = isBotHandoff ? undefined : rt.captureImOrigin?.(oldSid)

    const record = { oldSid, committed: false, newSid: undefined, messages: [...initialMessages], promise: undefined }
    const run = (async () => {
      let forkedResult
      try {
        forkedResult = await rt.forkForegroundPart(bot, oldSid)
      } catch (error) {
        restorePulledMessages(record.messages.splice(0))
        throw error
      }
      const { sessionId: newSid, forked, syncRoute } = forkedResult
      // Bot might have moved, started a part switch, or been deleted while forking.
      if (rt.botOf(bot.id) !== bot || rt.chatOf(bot.id) !== oldSid || rt.isSwitchingPart?.(oldSid)) {
        await ctx.workspaceRegistry.archiveSession(newSid, { stopActivity: true }).catch(() => {})
        const currentSid = rt.chatOf(bot.id)
        const pending = record.messages.splice(0)
        if (pending.length > 0) {
          if (currentSid !== undefined && currentSid !== oldSid && !rt.taskOwners?.has(currentSid)) {
            await forwardPulledMessages(currentSid, pending, bot.name)
          } else if (rt.botOf(bot.id) === bot) {
            restorePulledMessages(pending)
          }
        }
        return currentSid ?? newSid
      }
      const now = Date.now()
      const task = {
        id: newId(),
        title,
        brief: title,
        from: newSid,
        sessionId: oldSid,
        segments: [],
        startSeq,
        ...(bot.segments?.length ? { inheritedSegments: bot.segments.map(seg => ({ ...seg })) } : {}),
        origin,
        status: rt.waitsForApproval?.(oldSid) ? 'waiting_approval' : 'running',
        startedAt: entry?.since ?? now,
        updatedAt: now,
        ...(isBotHandoff && activeWork !== undefined ? { exchangeId: activeWork } : {}),
        ...(movedImOrigin !== undefined ? { imOrigin: movedImOrigin } : {}),
      }
      ;(bot.tasks ??= []).push(task)
      bot.sessionId = newSid
      rt.chatOwners.set(newSid, bot.id)
      rt.taskOwners.set(oldSid, { botId: bot.id, taskId: task.id })
      record.committed = true
      record.newSid = newSid
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
      await rt.save()
      await rt.moveSchedules?.(oldSid, newSid)
        .catch(error => rt.warn('ds-bot: moving schedules for %s after handoff failed: %s', bot.name, error))
      await syncRoute?.().catch(error => rt.warn('ds-bot: route sync for foreground part of %s failed: %s', bot.name, error))
      emitTaskEvent('task.started', bot, task, { origin })

      // Check whether the moved turn already finished during `await forkForegroundPart`
      // BEFORE injecting the "still running" notice, and inspect its actual `turn/end`
      // reason so failed/stopped/max-tokens turns settle with the right status.
      const stillRunning = rt.live.get(oldSid)?.turn !== undefined
        || oldAgent?.status === 'running'
        || (rt.runningJobs?.(oldSid)?.length ?? 0) > 0
        || rt.waitsForApproval?.(oldSid)
        || hasOpenOutgoingWorks(bot, task)

      if (!stillRunning && isActiveTask(task)) {
        const events = oldAgent?.session?.snapshotEvents?.() ?? []
        const lastEnd = events.findLast(ev => ev?.type === 'turn/end')
        const endReason = lastEnd?.data?.reason
        const endFailure = endReason?.kind === 'error' ? turnFailure(endReason.error) : undefined
        const said = lastReplyOf(oldAgent?.session, task.workDir)
        queueMicrotask(() => void handleTurnEnd(bot, task, endReason, endFailure, said)
          .catch(error => rt.warn('ds-bot: post-handoff settle failed for %s: %s', task.id, error)))
      } else if (origin === 'fg-handoff') {
        // Inform the new foreground only when the user's own previous turn moved to
        // background and is still running (never leak hidden Bot-to-Bot work).
        try {
          const contextNote = forked ? '' : fallbackContextSummary(oldSid)
          const notice = `[Background task notice] Your earlier turn ("${task.title}", ${task.id}) moved to the background and is still running there; its result will come back here when it finishes.${contextNote}`
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
        await forwardPulledMessages(newSid, batch, bot.name)
      }
      return newSid
    })()

    record.promise = run.finally(() => {
      if (handoffing.get(bot.id) === record) handoffing.delete(bot.id)
      if (record.committed && record.newSid !== undefined && record.messages.length > 0) {
        void forwardPulledMessages(record.newSid, record.messages.splice(0), bot.name)
      }
    })
    handoffing.set(bot.id, record)
    return record.promise
  }

  // Spawns a dedicated background task (`origin: 'bot-handoff'`) for an incoming peer
  // Bot request while the target Bot's foreground chat is busy, without switching the
  // user's visible foreground session or interrupting desktop drafts/IME.
  async function spawnBotHandoffTask(target, fromSessionId, { fromBot, fromPart, parentWork, text, files = [], length, exchangeId }) {
    const id = newId()
    const now = Date.now()
    const title = oneLine(`From ${fromBot.name}: ${text}`, TITLE_MAX)
    const baseTask = {
      id,
      title,
      brief: oneLine(text, BRIEF_KEPT),
      from: fromSessionId,
      ...(target.segments?.length ? { inheritedSegments: target.segments.map(seg => ({ ...seg })) } : {}),
      origin: 'bot-handoff',
      exchangeId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    const { sessionId, task } = await rt.openTaskPart(target, fromSessionId, baseTask)
    rt.openWork?.(exchangeId, { from: fromBot.id, to: target.id, parent: parentWork, ...(fromPart ? { fromPart } : {}) })
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
      })
    } catch (error) {
      rt.forgetDelivery?.(exchangeId)
      rt.dropWork?.(exchangeId)
      await settleTask(target, task, 'failed', { error: error?.message ?? String(error), notifyForeground: false })
      throw error
    }
    emitTaskEvent('task.started', target, task, { origin: 'bot-handoff' })
    return { ...task, sessionId }
  }

  // Intercepts Desktop/Web user messages sent to a busy foreground Bot (or landing on a
  // just-moved background task during the UI polling gap): pulls them synchronously out
  // of the target inbox, moves the busy foreground into `bot.tasks[]` when needed, and
  // forwards the messages to the Bot's active foreground Session.
  const interceptForegroundUserMessage = (session, event) => {
    const id = session?.id
    if (id === undefined) return
    const inserted = (event.data?.inserted ?? []).filter(msg => msg?.source?.kind === 'user' && !restoringIds.has(msg.id))
    if (inserted.length === 0) return
    const target = event.data?.target === 'next-step' ? 'next-step' : 'next-turn'

    // Case 1: Post-handoff polling gap — a Desktop/Web composer still pointing at the
    // old sessionId after `bot.sessionId` moved on. Redirect user messages to foreground.
    const taskOwner = rt.taskOwners?.get(id)
    if (taskOwner !== undefined) {
      const taskAgent = ctx.get('agents')?.get(id)
      if (taskAgent?.inbox?.remove === undefined) return
      const pulled = []
      for (const msg of inserted) {
        if (taskAgent.inbox.remove(msg.id)) pulled.push({ msg, target, oldAgent: taskAgent })
      }
      if (pulled.length === 0) return
      void (async () => {
        if (taskOwner.roomId !== undefined) {
          const room = rt.roomOf(taskOwner.roomId)
          const roomSid = room === undefined ? undefined : rt.sessionOfRoom(room)
          if (roomSid !== undefined && roomSid !== id) await forwardPulledMessages(roomSid, pulled, room.name)
          return
        }
        const pending = handoffing.get(taskOwner.botId)
        if (pending !== undefined) await pending.promise.catch(() => {})
        const ownerBot = rt.botOf(taskOwner.botId)
        let fgSid = ownerBot === undefined ? undefined : rt.chatOf(ownerBot.id)
        if (fgSid === undefined || fgSid === id || rt.taskOwners?.has(fgSid)) return
        if (shouldMoveForeground(ownerBot, fgSid)) {
          const fgAgent = ctx.get('agents')?.get(fgSid)
          const rebased = pulled.map(item => ({ ...item, oldAgent: fgAgent }))
          fgSid = await handoffForeground(ownerBot, fgSid, rebased)
          return
        }
        await forwardPulledMessages(fgSid, pulled, ownerBot?.name)
      })().catch(error => rt.warn('ds-bot: redirecting user input from background task %s failed: %s', id, error))
      return
    }

    // Case 2: Busy foreground — pull user messages synchronously and move the busy
    // turn intact into `bot.tasks[]`.
    const botId = rt.chatOwners.get(id)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (!shouldMoveForeground(bot, id)) return
    const oldAgent = ctx.get('agents')?.get(id)
    if (oldAgent?.inbox?.remove === undefined) return
    const pulled = []
    for (const msg of inserted) {
      if (oldAgent.inbox.remove(msg.id)) pulled.push({ msg, target, oldAgent })
    }
    if (pulled.length === 0) return

    void handoffForeground(bot, id, pulled).catch((error) => {
      rt.warn('ds-bot: foreground handoff for %s failed; restored input: %s', bot.name, error)
    })
  }

  // Strict turn/end state machine guard + Desktop/Web foreground busy auto-handoff.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'agent/inbox/spliced') {
      interceptForegroundUserMessage(session, event)
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
    // 8. Still waiting on outgoing Bot-to-Bot / group report-back works.
    if (hasOpenOutgoingWorks(bot, task)) {
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

  const hasRoomTasks = (roomId, botId) => activeTasksOf(rt.botOf(botId)).some(task => task.roomId === roomId)
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
    shouldMoveForeground,
    handoffForeground,
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
    onTaskEvent,
  })
}
