// A Bot's own chat is one or more threads:
//  - the current thread is `bot.sessionId` with its earlier parts in `bot.segments`;
//  - user-opened parallel threads while busy live in `bot.openParts` (#1548);
//  - Bot-owned background tasks live separately in `bot.tasks`, each with a stable
//    taskId across part switches and never swapped into `bot.sessionId` (#783).
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
  const openAt = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (openAt !== -1) return { thread: 'open', index: openAt, segments: bot.openParts[openAt].segments ?? [] }
  const taskAt = (bot.tasks ?? []).findIndex(task => task?.sessionId === sessionId)
  return taskAt === -1 ? undefined : { thread: 'task', index: taskAt, taskId: bot.tasks[taskAt].id, segments: bot.tasks[taskAt].segments ?? [] }
}

export const threadSegments = (bot, sessionId) => threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot, sessionId) => threadOf(bot, sessionId)?.thread === 'open'

// A thread's current session: the part that a handoff or a kept input belongs to.
export function threadCurrent(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  if (thread.thread === 'current') return currentSession(bot)
  if (thread.thread === 'open') return bot.openParts[thread.index].sessionId
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
  const openAt = (bot.openParts ?? []).findIndex(part => (part.segments ?? []).some(segment => segment.sessionId === sessionId))
  if (openAt !== -1) return { thread: 'open', index: openAt, segments: bot.openParts[openAt].segments ?? [] }
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
  if (thread.thread === 'open') return bot.openParts[thread.index].sessionId
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
  } else if (thread.thread === 'open') {
    const part = bot.openParts[thread.index]
    ;(part.segments ??= []).push(segment)
    part.sessionId = freshId
  } else {
    const task = bot.tasks[thread.index]
    ;(task.segments ??= []).push(segment)
    task.sessionId = freshId
    task.updatedAt = Date.now()
  }
  return true
}

// A fresh part starts in the foreground while the part it replaces stays live in the
// background with its own chain, so its running turn is not interrupted. It starts with
// no earlier parts and no handoff note: the user asked for a new conversation.
export function startOpenPart(bot, freshId, startedAt = Date.now()) {
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], startedAt })
  bot.sessionId = freshId
  bot.segments = []
}

// Makes a live user-opened background part current. Tasks in `bot.tasks` are never
// swapped into `bot.sessionId`; the user reads them in read-only views.
export function focusOpenPart(bot, sessionId) {
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts.splice(at, 1)
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [] })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  return true
}

// Every session this Bot keeps outside its current thread, for cleanup, memory and usage.
export const openSessions = bot => [
  ...(bot?.openParts ?? []).flatMap(part => [part.sessionId, ...(part.segments ?? []).map(segment => segment.sessionId)]),
  ...(bot?.tasks ?? []).flatMap(task => [task.sessionId, ...(task.segments ?? []).map(segment => segment.sessionId)]),
].filter(Boolean)

// A part that just moved on records a successor only when it belongs to an open or task
// thread: the foreground chat keeps its current part in `bot.sessionId`.
export const successorOfMovedPart = (bot, freshId) => {
  const kind = threadOf(bot, freshId)?.thread
  return kind === 'open' || kind === 'task' ? freshId : undefined
}

// Every live thread's current session (foreground, user-opened parallel parts, and active
// tasks only). Settled tasks are excluded so folder/engine/model sweeps do not wake them.
export const ownChatSessions = bot => [
  currentSession(bot),
  ...(bot?.openParts ?? []).map(part => part.sessionId),
  ...activeTasksOf(bot).map(task => task.sessionId),
].filter((id, index, list) => id !== undefined && list.indexOf(id) === index)
