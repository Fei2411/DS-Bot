// The group task board: what each member is working on in a group, one line apiece.
// A Bot registers a task when it takes the work and updates it as the work moves; the
// board is read from the group's own overview and never guessed from the chat. Tasks
// live on the room beside its goal, memory and folder, so they go when the group goes.
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

export const TASK_STATUSES = ['active', 'review', 'blocked', 'done', 'cancelled']
const OPEN_STATUSES = ['active', 'review', 'blocked']
const GOAL_MAX = 200
const PROGRESS_MAX = 300
const RESULT_MAX = 2000
const NOTE_MAX = 500
const REASON_MAX = 500

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const tasksOf = room => (room.tasks ??= {})
const listOf = room => Object.values(tasksOf(room)).sort((a, b) => a.startedAt - b.startedAt)
export const openTasksOf = room => listOf(room).filter(task => OPEN_STATUSES.includes(task.status))
export const pastTasksOf = room => listOf(room).filter(task => !OPEN_STATUSES.includes(task.status))
const newId = () => `t_${randomBytes(4).toString('hex')}`

// The task an update names: its id, or the caller's own newest open task when no id is
// given (the common case: one Bot working on one thing).
function pickTask(room, id, botId) {
  if (id !== undefined && String(id).trim() !== '') return tasksOf(room)[String(id).trim()]
  return openTasksOf(room).filter(task => task.botId === botId).at(-1)
}

export function install(rt) {
  const open = (room, botId, goal) => {
    const text = oneLine(goal, GOAL_MAX)
    if (text === '') return { error: 'A task needs a one-line goal.' }
    const at = Date.now()
    const task = { id: newId(), botId, goal: text, status: 'active', startedAt: at, updatedAt: at, progress: '' }
    tasksOf(room)[task.id] = task
    return { task }
  }
  const update = (room, botId, id, { status, progress } = {}) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group. Name one with its id, or open a task first.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    if (status !== undefined && !OPEN_STATUSES.includes(status)) {
      return { error: `A running task\'s status is ${OPEN_STATUSES.join(', ')}; finish it with complete or cancel.` }
    }
    if (status !== undefined) task.status = status
    if (progress !== undefined) task.progress = oneLine(progress, PROGRESS_MAX)
    task.updatedAt = Date.now()
    return { task }
  }
  const complete = (room, botId, id, result) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    const text = oneLine(result, RESULT_MAX)
    if (text === '') return { error: 'A finished task needs a result summary.' }
    task.status = 'done'
    task.result = text
    task.updatedAt = Date.now()
    return { task }
  }
  const cancel = (room, botId, id, reason, isAdmin) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task to cancel.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId && !isAdmin) return { error: `Task ${task.id} belongs to another member; only its owner, the admin or a Main Bot cancels it.` }
    task.status = 'cancelled'
    const why = oneLine(reason, REASON_MAX)
    if (why !== '') task.reason = why
    task.updatedAt = Date.now()
    return { task }
  }
  const note = (room, id, text, by) => {
    const task = tasksOf(room)[String(id ?? '')]
    if (task === undefined) return undefined
    const line = oneLine(text, NOTE_MAX)
    if (line === '') return undefined
    ;(task.notes ??= []).push({ at: Date.now(), by, text: line })
    task.updatedAt = Date.now()
    return task
  }
  const owner = task => rt.botOf(task.botId)

  // What the tool answers with: the current board, not only the task it touched.
  const ledger = (room, self) => {
    const room_ = room
    const open = openTasksOf(room_).map(task => {
      const bot = owner(task)
      const mine = task.botId === self ? ' (yours)' : ''
      const progress = task.progress === '' ? '' : `\n  progress: ${task.progress}`
      return `- ${task.id} · ${bot?.name ?? task.botId} · ${task.status} · ${task.goal}${mine}${progress}`
    })
    const past = pastTasksOf(room_)
    const lines = [`Tasks in "${room_.name}"${open.length === 0 ? ': none open.' : ':'}`, ...open]
    if (past.length > 0) lines.push(`${past.length} finished or cancelled in the history; the group shows them under Tasks.`)
    return lines.join('\n')
  }

  rt.teamTools.push(defineTool({
    name: 'group_task',
    description: 'Register and move a group chat task: the work one member is doing in the group, so the user can see who is on what without reading the chat. Only a group member registers work, and every change is explicit: open when you take the work, update while it runs, complete with a one-line result, cancel when it stops. The group overview shows the board to the user; the history keeps finished and cancelled tasks. Called outside a group it refuses; inside a group the group is implied.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'update', 'complete', 'cancel', 'show'], description: 'What to do' },
      goal: { type: 'string', description: 'open: the task in one line, as the user would say the goal' },
      id: { type: 'string', description: 'update, complete, cancel: the task id; the caller\'s newest open task when left out' },
      status: { type: 'string', enum: ['active', 'review', 'blocked'], description: 'update: active while working, review when the result waits for the user, blocked when something stops you' },
      progress: { type: 'string', description: 'update: the latest one-line progress' },
      result: { type: 'string', description: 'complete: the result summary the board keeps' },
      reason: { type: 'string', description: 'cancel: why the task stops' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_task.'
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) return 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.'
      const isAdmin = rt.isMain(self) || rt.isAdminOf(room, self)
      const action = String(args.action ?? '')
      let result
      switch (action) {
        case 'open': result = open(room, self, args.goal); break
        case 'update': result = update(room, self, args.id, { status: args.status, progress: args.progress }); break
        case 'complete': result = complete(room, self, args.id, args.result); break
        case 'cancel': result = cancel(room, self, args.id, args.reason, isAdmin); break
        case 'show': return ledger(room, self)
        default: return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      const task = result.task
      const done = task.status === 'done' ? ` Finished: "${task.result}"` : task.status === 'cancelled' ? ' Cancelled.' : ''
      await rt.save()
      return `${action === 'open' ? `Opened ${task.id}: ${task.goal}` : `Updated ${task.id} (${task.status}).`}${done}\n\n${ledger(room, self)}`
    },
  }))

  // For the group overview. The endpoint adds the user's note and posts it to the room.
  Object.assign(rt, {
    taskNote: (roomId, id, text) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      const noted = note(room, id, text, 'user')
      return noted === undefined ? { error: 'Write a note first.' } : { task: noted }
    },
    taskCancel: (roomId, id) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      task.status = 'cancelled'
      task.updatedAt = Date.now()
      return { task }
    },
  })
}
