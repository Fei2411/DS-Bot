// Background tasks of one Bot. A task is a live part of the Bot's own chat (threads.js)
// that does one piece of work while the chat stays free: the Bot starts it with
// task_start, the task part starts from what the chat knew (parts.js openTaskPart), and
// when a turn of it ends with no background job left, its last reply goes back to the
// chat it came from. The user reads a task but does not write to it; follow-ups go
// through the chat (task_send).
import { randomBytes } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SOURCE_KIND } from './constants.js'
import { textOf } from './text.js'
import { output } from './tools.js'
import { threadCurrentOfPart } from './threads.js'

const TITLE_MAX = 80
const REPORT_MAX = 4000
const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const newId = () => `k_${randomBytes(3).toString('hex')}`

export function install(rt) {
  const { ctx } = rt
  const tasksOf = bot => (bot?.openParts ?? []).filter(part => part.task !== undefined)
  const partOf = (sessionId) => {
    const botId = rt.chatOwners.get(sessionId)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    return { bot, part: (bot?.openParts ?? []).find(item => item.sessionId === sessionId && item.task !== undefined) }
  }
  const find = (bot, ref) => {
    const key = oneLine(ref, TITLE_MAX)
    return tasksOf(bot).find(part => part.task.id === key) ?? tasksOf(bot).filter(part => part.task.title === key).at(-1)
  }
  const running = sessionId => rt.live.get(sessionId)?.turn !== undefined || (rt.runningJobs?.(sessionId)?.length ?? 0) > 0
  const statusOf = part => (part.task.status === 'stopped' ? 'stopped' : running(part.sessionId) ? 'running' : part.task.status ?? 'running')
  const send = async (sessionId, text, extra = {}, now = false) => {
    const agent = await rt.resolveAgent(sessionId)
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: SOURCE_KIND, form: 'task', ...extra } })
    if (now && agent.status !== 'idle') agent.steer(message)
    else agent.followup(message)
    await ctx.sessions.flush(agent.session)
  }

  // Starts a task for the Bot whose chat `fromSessionId` is; returns the task record.
  async function startTask(fromSessionId, { title, brief }) {
    const botId = rt.chatOwners.get(fromSessionId)
    const bot = botId === undefined || rt.groupOwners.has(fromSessionId) ? undefined : rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('Only a Bot\'s own chat starts background tasks.'), { code: 'bot/invalid' })
    const name = oneLine(title, TITLE_MAX)
    if (name === '' || String(brief ?? '').trim() === '') throw Object.assign(new Error('A task needs a title and a brief.'), { code: 'bot/invalid' })
    const task = { id: newId(), title: name, from: fromSessionId, status: 'running', startedAt: Date.now() }
    const sessionId = await rt.openTaskPart(bot, fromSessionId, task)
    await send(sessionId, `[Background task "${name}" (${task.id}) · from your own chat]\n${String(brief).trim()}\nDo this work here. The user does not read this part; when you finish, your last reply goes back to your chat, so make it the result.`, { role: 'task', taskId: task.id })
    return { ...task, sessionId }
  }

  // A turn of a task part ended: once no background job of it runs, its last reply goes
  // back to the chat the task came from (the part that chat has now).
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const { bot, part } = partOf(session?.id)
    if (part === undefined || part.task.status === 'stopped') return
    queueMicrotask(() => void report(bot, part, session).catch(error => rt.warn('ds-bot: the report of task %s did not reach its chat: %s', part.task.title, error)))
  })
  async function report(bot, part, session) {
    if ((rt.runningJobs?.(part.sessionId)?.length ?? 0) > 0) return
    const last = [...(session.snapshotEvents?.() ?? [])].reverse().find(event => event.type === 'assistant/message')
    const said = textOf(last?.data?.message?.content ?? []).trim()
    part.task.status = 'done'
    part.task.endedAt = Date.now()
    await rt.save()
    const to = threadCurrentOfPart(bot, part.task.from) ?? rt.chatOf(bot.id)
    const body = said.length > REPORT_MAX ? `${said.slice(0, REPORT_MAX)}…\n[Cut here; read the whole reply with task_list and read_own_chat]` : said || '(no reply text)'
    await send(to, `[Background task "${part.task.title}" (${part.task.id}) finished]\n${body}`, { role: 'task-report', taskId: part.task.id })
  }

  async function stopTask(bot, part, reason = 'stopped') {
    part.task.status = 'stopped'
    part.task.endedAt = Date.now()
    await rt.save()
    const jobs = ctx.get?.('jobs')
    for (const job of rt.runningJobs?.(part.sessionId) ?? []) {
      try { jobs?.kill(job.id, part.sessionId, reason) } catch { /* already ended */ }
    }
    ctx.get('agents')?.get(part.sessionId)?.cancel({ kind: 'hook', reason: 'ds-bot: task stopped' })
  }

  const callerBot = (exec) => {
    const id = exec.agent?.id
    const botId = rt.groupOwners.has(id) ? undefined : rt.chatOwners.get(id)
    return botId === undefined ? undefined : rt.botOf(botId)
  }
  rt.teamTools.push(defineTool({
    name: 'task_start',
    description: 'Start a background task: another part of your own chat that does one piece of work while this chat stays free to talk. It starts from everything this chat knows; its last reply comes back here as a message when it is done. Use it for work that takes more than a few steps. Only in your own chat.',
    parameters: {
      title: { type: 'string', required: true, description: `A short name for the task, at most ${TITLE_MAX} characters, in the user's language` },
      brief: { type: 'string', required: true, description: 'What to do and what to report back' },
    },
    output,
    async execute(args, exec) {
      const task = await startTask(exec.agent?.id, args)
      return `Started background task "${task.title}" (${task.id}). Its result comes back here when it is done; tell the user it is running, and do not wait for it.`
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'task_send',
    description: 'Pass a follow-up to one of your background tasks: the user changed or added something about that work. It reaches the task at its next step.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task id or title from task_list' },
      text: { type: 'string', required: true, description: 'The follow-up' },
    },
    output,
    async execute({ task: ref, text }, exec) {
      const bot = callerBot(exec)
      const part = find(bot, ref)
      if (part === undefined) return 'No such task of yours. See task_list.'
      if (part.task.status === 'stopped') return `Task "${part.task.title}" was stopped. Start a new one if the work should go on.`
      part.task.status = 'running'
      await rt.save()
      await send(part.sessionId, `[Follow-up from your own chat]\n${text}`, { role: 'task-followup', taskId: part.task.id }, true)
      return `Passed to task "${part.task.title}".`
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'task_stop',
    description: 'Stop one of your background tasks and its background jobs.',
    parameters: { task: { type: 'string', required: true, description: 'The task id or title from task_list' } },
    output,
    async execute({ task: ref }, exec) {
      const bot = callerBot(exec)
      const part = find(bot, ref)
      if (part === undefined) return 'No such task of yours. See task_list.'
      await stopTask(bot, part, 'stopped by the Bot')
      return `Stopped task "${part.task.title}".`
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'task_list',
    description: 'List your background tasks: id, title, status (running, done, stopped) and when each started.',
    parameters: {},
    output,
    async execute(_args, exec) {
      const list = tasksOf(callerBot(exec))
      if (list.length === 0) return 'No background tasks.'
      return list.map(part => `${part.task.id} · ${part.task.title} · ${statusOf(part)} · started ${new Date(part.task.startedAt).toISOString()}`).join('\n')
    },
  }))

  Object.assign(rt, {
    startTask,
    stopTask: async (botId, taskId) => {
      const bot = rt.botOf(botId)
      const part = find(bot, taskId)
      if (part === undefined) throw Object.assign(new Error('Unknown task'), { code: 'bot/not-found' })
      await stopTask(bot, part, 'cancelled by the user')
    },
    taskStatusOf: statusOf,
  })
}
