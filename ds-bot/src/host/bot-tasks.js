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
import { join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HANDOFF_ACK, HISTORY_TIMEOUT_MS, STEER_CUT } from './constants.js'
import { textOf } from './text.js'
import { activeTasksOf, isActiveTask, threadCurrentOfPart, threadOfPart } from './threads.js'
import { output } from './tools.js'
import { cutOffText, turnFailure } from './turns.js'

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
  const listeners = new Set()

  const onTaskEvent = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const emitTaskEvent = (type, bot, task, extra = {}) => {
    const payload = {
      type,
      botId: bot.id,
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
  const findTask = (bot, ref) => {
    const key = oneLine(ref, TITLE_MAX)
    if (key === '') return undefined
    const list = tasksOf(bot)
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
    return `\n\n[Recent context from your own chat]\n${clipped}`
  }

  const lastReplyOf = (session) => {
    const all = session?.snapshotEvents?.() ?? []
    const inherited = Number.isInteger(session?.inheritedEventCount) && session.inheritedEventCount > 0 ? session.inheritedEventCount : 0
    const events = inherited > 0 ? all.slice(inherited) : all
    const lastTurnStart = events.findLastIndex(event => event.type === 'turn/start')
    const slice = lastTurnStart === -1 ? events : events.slice(lastTurnStart)
    const replies = []
    for (const event of slice) {
      if (event.type !== 'assistant/message') continue
      const text = textOf(event.data?.message?.content ?? []).trim()
      if (text !== '') replies.push(text)
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

      if (!notifyForeground && parentWork === undefined) return
      const targetSession = threadCurrentOfPart(bot, task.from) ?? rt.chatOf(bot.id)
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

      await rt.deliver({
        toId: bot.id,
        sessionId: targetSession,
        text: body,
        role: 'task-report',
        note,
        taskId: task.id,
        recordExchange: false,
        ...(parentWork !== undefined ? { work: parentWork, replyTo: task.workId } : {}),
      })
    } finally {
      settling.delete(task.id)
    }
  }

  // Starts a background task for the Bot whose foreground own chat `fromSessionId` is.
  async function startTask(fromSessionId, { title, brief, workdir }, exec) {
    if (rt.taskOwners?.has(fromSessionId)) {
      throw Object.assign(new Error('Background tasks cannot start nested background tasks. Finish this task and report back to your own chat instead.'), { code: 'bot/invalid' })
    }
    const botId = rt.chatOwners.get(fromSessionId)
    const bot = botId === undefined || rt.groupOwners.has(fromSessionId) ? undefined : rt.botOf(botId)
    if (bot === undefined) {
      throw Object.assign(new Error('Only a Bot\'s own chat can start background tasks.'), { code: 'bot/invalid' })
    }
    const name = oneLine(title, TITLE_MAX)
    const detail = String(brief ?? '').trim()
    if (name === '' || detail === '') {
      throw Object.assign(new Error('A task needs both a title and a brief.'), { code: 'bot/invalid' })
    }

    let resolvedDir
    if (workdir !== undefined && String(workdir).trim() !== '') {
      const cleaned = await rt.cleanWorkDir?.(String(workdir).trim())
      if (cleaned !== undefined) {
        if (await rt.inData?.(cleaned)) {
          throw Object.assign(new Error('A task cannot work inside the DSH or DS Bot data folder.'), { code: 'bot/invalid' })
        }
        const clash = await rt.privateClash?.(cleaned, { except: bot.id })
        if (clash !== undefined) {
          throw Object.assign(new Error(`${cleaned} is in or around the folder of ${clash.name}, a private Bot, so this task cannot work there.`), { code: 'bot/invalid' })
        }
        if (bot.private === true && bot.workDir !== undefined) {
          const realCleaned = resolve(cleaned)
          const realOwn = resolve(bot.workDir)
          if (realCleaned !== realOwn && !realCleaned.startsWith(realOwn + sep)) {
            throw Object.assign(new Error(`${bot.name} is a private Bot and its background tasks must stay inside ${bot.workDir}.`), { code: 'bot/invalid' })
          }
        }
        if (exec !== undefined && typeof rt.approveFolder === 'function') {
          await rt.approveFolder(exec, {
            path: cleaned,
            sessions: [fromSessionId],
            who: { en: `${bot.name}'s background task`, zh: `${bot.name} 的后台任务` },
          })
        }
        resolvedDir = cleaned
      }
    }

    const id = newId()
    const now = Date.now()
    const imOrigin = rt.captureImOrigin?.(fromSessionId)
    // Link into the handoff tree when the foreground turn is answering another Bot.
    const liveEntry = rt.live.get(fromSessionId)
    const parentWork = rt.workOf?.(liveEntry?.info)
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
      ...(taskWorkId !== undefined ? { workId: taskWorkId, parentWorkId: parentWork } : {}),
      ...(imOrigin !== undefined ? { imOrigin } : {}),
    }

    const { sessionId, forked, task } = await rt.openTaskPart(bot, fromSessionId, baseTask, { workDir: resolvedDir })
    if (taskWorkId !== undefined) {
      rt.openWork?.(taskWorkId, { from: bot.id, parent: parentWork, name: `task "${name}"`, child: id })
    }

    const isLocal = rt.localAgentBadge?.(bot.model ?? bot.appliedModel) !== undefined
    const contextNote = forked ? '' : fallbackContextSummary(fromSessionId)
    const localNote = isLocal ? '\nNote: You are running in a separate local CLI session that does not share in-memory state with the foreground chat.' : ''
    const dirNote = resolvedDir ? `\nWorking directory: ${resolvedDir}` : ''
    const prompt = `${detail}${dirNote}${localNote}${contextNote}\n\nDo this work here. The user does not chat directly in this task session; do not call ask_user, show_view, request_secret, or task_* tools. When you finish, your final reply is sent back to your own chat, so make it complete and self-contained.`

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
    if (wasActive) {
      // Mark stopped and save before cancelling so the ensuing turn/end never
      // misclassifies the cancellation as a completed task.
      await settleTask(bot, task, 'stopped', { error: reason, notifyForeground })
    }
    rt.cancelApprovals?.(sessionId)
    const jobs = ctx.get?.('jobs')
    for (const job of rt.runningJobs?.(sessionId) ?? []) {
      try { jobs?.kill(job.id, sessionId, reason) } catch { /* already ended */ }
    }
    ctx.get('agents')?.get(sessionId)?.cancel({ kind: 'hook', reason: 'ds-bot: task stopped' })
    return wasActive
  }

  async function stopAllTasksOfBot(bot, reason = 'stopped') {
    for (const task of activeTasksOf(bot)) {
      await stopTask(bot, task, reason, { notifyForeground: false })
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
    const said = slice
      .filter(event => event?.type === 'assistant/message')
      .map(event => textOf(event.data?.message?.content ?? []).trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    const failure = reason?.kind === 'error' ? turnFailure(reason.error) : undefined
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
        const pendingInbox = (agent?.inbox?.nextStep?.length ?? 0) + (agent?.inbox?.nextTurn?.length ?? 0)
        if (agent?.status === 'running' || pendingInbox > 0) continue
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

  // Strict turn/end state machine guard.
  ctx.on('session/event', (session, event) => {
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
    const said = lastReplyOf(session)
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

  const foregroundBotOf = (exec) => {
    const id = exec.agent?.id
    if (id === undefined || rt.groupOwners.has(id) || rt.taskOwners?.has(id)) return undefined
    const botId = rt.chatOwners.get(id)
    return botId === undefined ? undefined : rt.botOf(botId)
  }
  const rejectIfTask = (exec) => (rt.taskOwners?.has(exec.agent?.id)
    ? 'Background tasks cannot manage other background tasks. Finish your work and report back to your own chat.'
    : undefined)

  rt.teamTools.push(defineTool({
    name: 'task_start',
    description: 'Start a background task in a separate Session of your own chat while this chat stays free to talk. It inherits your chat context when possible (on local CLI agents it starts a fresh CLI session with a recent summary). Its final reply comes back here when it finishes. Only available in your own foreground chat.',
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
        return `Started background task "${task.title}" (${task.id}) ${mode}. Its result will come back here when it finishes; tell the user it is running and do not wait for it.`
      } catch (error) {
        return error.message
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_send',
    description: 'Send a follow-up instruction to one of your active background tasks. Only available in your own foreground chat.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task id or title from task_list' },
      text: { type: 'string', required: true, description: 'Follow-up message for the task' },
    },
    output,
    async execute({ task: ref, text }, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const bot = foregroundBotOf(exec)
      const task = findTask(bot, ref)
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
      const bot = foregroundBotOf(exec)
      const task = findTask(bot, ref)
      if (task === undefined) return 'No such task of yours. See task_list.'
      if (!isActiveTask(task)) return `Task "${task.title}" (${task.id}) is already ${task.status}.`
      await stopTask(bot, task, 'stopped by the Bot', { notifyForeground: false })
      return `Stopped task "${task.title}" (${task.id}).`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_list',
    description: 'List your background tasks with id, title, status, and start time.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const list = tasksOf(foregroundBotOf(exec))
      if (list.length === 0) return 'No background tasks.'
      return list.map(task => `${task.id} · ${task.title} · ${statusOf(task)} · started ${new Date(task.startedAt).toISOString()}`).join('\n')
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'task_read',
    description: 'Read the full report or latest reply of one of your background tasks.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task id or title from task_list' },
    },
    output,
    async execute({ task: ref }, exec) {
      await rt.load()
      const blocked = rejectIfTask(exec)
      if (blocked !== undefined) return blocked
      const bot = foregroundBotOf(exec)
      const task = findTask(bot, ref)
      if (task === undefined) return 'No such task of yours. See task_list.'
      const header = `${task.id} · ${task.title} · ${statusOf(task)}`
      const saved = readReportFile(task.reportFile)
      if (saved !== undefined) return `${header}\n\n${saved}`
      const agent = ctx.get('agents')?.get(task.sessionId)
      const latest = agent !== undefined ? lastReplyOf(agent.session) : ''
      if (latest !== '') return `${header}\n\n${latest}`
      if (task.summary) return `${header}\n\n${task.summary}`
      if (task.error) return `${header}\n\nError: ${task.error}`
      return `${header}\n\n(No output recorded yet.)`
    },
  }))

  Object.assign(rt, {
    startTask,
    stopTask: async (botId, taskId, reason = 'cancelled by the user') => {
      const bot = rt.botOf(botId)
      const task = findTask(bot, taskId)
      if (task === undefined) throw Object.assign(new Error('Unknown task'), { code: 'bot/not-found' })
      return stopTask(bot, task, reason, { notifyForeground: false })
    },
    stopAllTasksOfBot,
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
