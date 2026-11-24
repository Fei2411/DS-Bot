// A Bot's own chat has one foreground thread (`bot.sessionId` with its earlier parts in
// `bot.segments`), plus Bot-owned background tasks in `bot.tasks`, each with a stable
// taskId across part switches and never swapped into `bot.sessionId` (#783).
// Parts never share a chain: a handoff reads only the thread it belongs to, so
// background work and the foreground chat cannot leak into each other.
// A Bot that never ran yet has no stored session id: its first Session is the Bot id
// (store.js chatOf falls back to it).
export const currentSession = bot => bot?.sessionId ?? bot?.id

export const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting_work', 'waiting_approval'])

export const isActiveTask = task => task !== undefined && ACTIVE_TASK_STATUSES.has(task.status)

export const activeTasksOf = bot => (bot?.tasks ?? []).filter(isActiveTask)

export const taskOfSession = (bot, sessionId) => (bot === undefined || sessionId === undefined
  ? undefined
  : (bot.tasks ?? []).find(task => task?.sessionId === sessionId))

export const isTaskSession = (bot, sessionId) => taskOfSession(bot, sessionId) !== undefined

export function threadOf(bot, sessionId) {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current', segments: bot.segments ?? [] }
  const taskAt = (bot.tasks ?? []).findIndex(task => task?.sessionId === sessionId)
  return taskAt === -1 ? undefined : { thread: 'task', index: taskAt, taskId: bot.tasks[taskAt].id, segments: bot.tasks[taskAt].segments ?? [] }
}

export const threadSegments = (bot, sessionId) => threadOf(bot, sessionId)?.segments ?? []

// A thread's current session: the part that a handoff or a kept input belongs to.
export function threadCurrent(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  if (thread.thread === 'current') return currentSession(bot)
  return bot.tasks[thread.index].sessionId
}

// The thread a part belongs to, whether it is that thread's current part or one of its
// earlier parts. A Session outside the Bot's own chat (a group Session) belongs to none.
// `threadOf` alone knows only the current part of each thread; the earlier parts are
// still readable, and their history belongs to the thread they came from.
export function threadOfPart(bot, sessionId) {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some(segment => segment.sessionId === sessionId)) return { thread: 'current', segments: bot.segments }
  const taskAt = (bot.tasks ?? []).findIndex(task => (task.segments ?? []).some(segment => segment.sessionId === sessionId))
  return taskAt === -1 ? undefined : { thread: 'task', index: taskAt, taskId: bot.tasks[taskAt].id, segments: bot.tasks[taskAt].segments ?? [] }
}

// The live session a part's thread goes on in: a reply to, or input given to, an
// earlier part of a thread reaches the part that thread has now. A settled background
// task is no longer a live delivery target, so it returns undefined and callers fall
// back to the Bot's foreground chat instead of re-entering a settled pastOwners session.
export function threadCurrentOfPart(bot, sessionId) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  if (thread.thread === 'current') return currentSession(bot)
  const task = bot.tasks[thread.index]
  return isActiveTask(task) ? task.sessionId : undefined
}

// A fresh part replaces a thread's current one; the part it replaces joins that thread's
// own earlier parts. Returns false for a session that belongs to no thread.
export function pushThreadPart(bot, sessionId, freshId, segment) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return false
  if (thread.thread === 'current') {
    ;(bot.segments ??= []).push(segment)
    bot.sessionId = freshId
  } else {
    const task = bot.tasks[thread.index]
    ;(task.segments ??= []).push(segment)
    task.sessionId = freshId
    task.updatedAt = Date.now()
  }
  return true
}

// Every session this Bot keeps outside its current thread, for cleanup, memory and usage.
export const openSessions = bot => (bot?.tasks ?? [])
  .flatMap(task => [task.sessionId, ...(task.segments ?? []).map(segment => segment.sessionId)])
  .filter(Boolean)

// A part that just moved on records a successor only when it belongs to a task thread:
// the foreground chat keeps its current part in `bot.sessionId`.
export const successorOfMovedPart = (bot, freshId) => (threadOf(bot, freshId)?.thread === 'task' ? freshId : undefined)

// Whether two Session ids belong to the same Bot conversation thread or group membership.
// Stays stable across part switches while isolating the foreground chat, background tasks
// and groups.
export function sameConversation(state, botId, sessionA, sessionB) {
  if (sessionA === sessionB) return true
  if (sessionA === undefined || sessionB === undefined || botId === undefined) return false
  for (const room of Object.values(state?.rooms ?? {})) {
    const current = room?.sessions?.[botId]
    const segments = room?.segments?.[botId] ?? []
    const hasA = current === sessionA || segments.some(segment => segment?.sessionId === sessionA)
    const hasB = current === sessionB || segments.some(segment => segment?.sessionId === sessionB)
    if (hasA || hasB) return hasA && hasB
  }
  const bot = state?.bots?.[botId]
  if (bot === undefined) return false
  const threadA = threadOfPart(bot, sessionA)
  const threadB = threadOfPart(bot, sessionB)
  if (threadA === undefined || threadB === undefined) return false
  return threadA.thread === threadB.thread && threadA.index === threadB.index
}

// Every live thread's current session (foreground and active tasks only). Settled tasks
// are excluded so folder/engine/model sweeps do not wake them.
export const ownChatSessions = bot => [
  currentSession(bot),
  ...activeTasksOf(bot).map(task => task.sessionId),
].filter((id, index, list) => id !== undefined && list.indexOf(id) === index)
