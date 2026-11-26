// Thread & logical-address mapping for DS Bot.
//
// A Bot's own chat has one foreground thread (`bot.sessionId` with its earlier parts in
// `bot.segments`), plus Bot-owned background tasks in `bot.tasks`, each with a stable
// taskId across part switches and never swapped into `bot.sessionId` (#783).
// Parts never share a chain: a handoff reads only the thread it belongs to, so
// background work and the foreground chat cannot leak into each other.
//
// Logical addresses (`foreground:<botId>`, `task:<taskId>`, `room:<roomId>:<botId>`)
// decouple collaboration routing from mutable DSH Session containers: part rollovers
// update the underlying Session mapping without changing logical addresses, and an
// inactive/missing task or room address NEVER falls back to a Bot's foreground DM.
export const currentSession = bot => bot?.sessionId ?? bot?.id

export const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting_work', 'waiting_approval'])

const TERMINAL_WORK_STATUSES = new Set(['done', 'failed', 'stopped'])

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
export function threadOfPart(bot, sessionId) {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some(segment => segment.sessionId === sessionId)) return { thread: 'current', segments: bot.segments }
  const taskAt = (bot.tasks ?? []).findIndex(task => (task.segments ?? []).some(segment => segment.sessionId === sessionId))
  return taskAt === -1 ? undefined : { thread: 'task', index: taskAt, taskId: bot.tasks[taskAt].id, segments: bot.tasks[taskAt].segments ?? [] }
}

// The live session a part's thread goes on in: a reply to, or input given to, an
// earlier part of a thread reaches the part that thread has now. A settled background
// task is no longer a live delivery target, so it returns undefined instead of
// re-entering a settled session.
export function threadCurrentOfPart(bot, sessionId) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  if (thread.thread === 'current') return currentSession(bot)
  const task = bot.tasks[thread.index]
  return isActiveTask(task) ? task.sessionId : undefined
}

// Returns the live session for a structured address object (`{ roomId }`, `{ taskId }`, `{ foreground }`).
export function addressedSession(rt, toId, address) {
  const bot = rt.botOf(toId)
  if (!bot || !address || typeof address !== 'object') return undefined
  if (address.retired === true) return undefined
  if (address.roomId) {
    const room = rt.roomOf(address.roomId)
    return room?.members.includes(toId) ? room.sessions?.[toId] : undefined
  }
  if (address.taskId) {
    return bot.tasks?.find(task => task.id === address.taskId && isActiveTask(task))?.sessionId
  }
  return address.foreground ? (rt.chatOf?.(toId) ?? currentSession(bot)) : undefined
}

export function sessionRoomId(state, botId, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof botId !== 'string' || botId === '') return undefined
  for (const room of Object.values(state?.rooms ?? {})) {
    if (room?.sessions?.[botId] === sessionId) return room.id
    if ((room?.segments?.[botId] ?? []).some(segment => segment?.sessionId === sessionId)) return room.id
  }
  return undefined
}

export function isMissingSessionError(error) {
  const code = error?.code
  if (typeof code === 'string' && code !== '') {
    return code === 'session/not-found'
      || code === 'SESSION_QUERY_SESSION_NOT_FOUND'
  }
  if (error?.name === 'SessionPersistenceNotFoundError') return true
  if (error?.name === 'SessionPersistenceCorruptionError') return false
  return /\bsession\b.*\bnot found\b|\bnot found\b.*\bsession\b/i.test(String(error?.message ?? ''))
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
export const taskSessionIds = task => [...new Set([task?.sessionId, ...(task?.segments ?? []).map(segment => segment?.sessionId)]
  .filter(id => typeof id === 'string' && id !== ''))]

export const openSessions = bot => (bot?.tasks ?? []).flatMap(taskSessionIds)

export const retiredTaskSessionIds = bot => Array.isArray(bot.retiredTaskSessions) ? bot.retiredTaskSessions : []

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

// --- Stable Logical Addresses ---

export const foregroundAddress = botId => (typeof botId === 'string' && botId !== '' ? `foreground:${botId}` : undefined)
export const taskAddress = taskId => (typeof taskId === 'string' && taskId !== '' ? (taskId.startsWith('task:') ? taskId : `task:${taskId}`) : undefined)
export const roomMemberAddress = (roomId, botId) => (
  typeof roomId === 'string' && roomId !== '' && typeof botId === 'string' && botId !== ''
    ? `room:${roomId}:${botId}`
    : undefined
)

export function parseLogicalAddress(logicalAddress) {
  if (typeof logicalAddress !== 'string' || logicalAddress === '') return undefined
  if (logicalAddress.startsWith('foreground:')) {
    const botId = logicalAddress.slice('foreground:'.length)
    return botId === '' ? undefined : { kind: 'foreground', botId }
  }
  if (logicalAddress.startsWith('task:')) {
    const taskId = logicalAddress.slice('task:'.length)
    return taskId === '' ? undefined : { kind: 'task', taskId }
  }
  if (logicalAddress.startsWith('room:')) {
    const rest = logicalAddress.slice('room:'.length)
    const sep = rest.indexOf(':')
    if (sep <= 0 || sep >= rest.length - 1) return undefined
    const roomId = rest.slice(0, sep)
    const botId = rest.slice(sep + 1)
    if (roomId === '' || botId === '' || botId.includes(':')) return undefined
    return { kind: 'room', roomId, botId }
  }
  if (logicalAddress.startsWith('api:')) {
    const apiRunId = logicalAddress.slice('api:'.length)
    return apiRunId === '' ? undefined : { kind: 'api', apiRunId }
  }
  return undefined
}

const stateOf = rtOrState => (rtOrState?.state && typeof rtOrState.state === 'object' ? rtOrState.state : rtOrState)
const ownKey = (table, key) => (table != null && typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined)

function findTaskRecord(state, rawTaskId) {
  if (!state?.bots || typeof rawTaskId !== 'string' || rawTaskId === '') return undefined
  const stripped = rawTaskId.startsWith('task:') ? rawTaskId.slice('task:'.length) : rawTaskId
  for (const bot of Object.values(state.bots)) {
    if (!bot || typeof bot !== 'object') continue
    const task = (bot.tasks ?? []).find(item =>
      item?.id === rawTaskId || item?.id === stripped || item?.workId === rawTaskId || item?.workId === stripped)
    if (task !== undefined) return { bot, task }
  }
  return undefined
}

// Resolves a stable logical address to its current live DSH Session container.
// Part rollovers update `bot.sessionId`, `task.sessionId`, or `room.sessions[botId]`
// without changing the logical address.
//
// HARD INVARIANT: A settled/missing task or a deleted/removed room membership NEVER
// falls back to a Bot's foreground private chat — it returns `undefined`.
export function resolveLogicalSession(rtOrState, logicalAddress) {
  const parsed = parseLogicalAddress(logicalAddress)
  if (parsed === undefined) return undefined
  const state = stateOf(rtOrState)
  const coordDb = rtOrState?.coordDb
  const hasStateBots = state?.bots != null && Object.keys(state.bots).length > 0

  if (parsed.kind === 'foreground') {
    const bot = ownKey(state?.bots, parsed.botId)
    if (bot !== undefined) return currentSession(bot)
    if (!hasStateBots && coordDb && !coordDb.isClosed?.()) {
      const fg = coordDb.getForegroundWork?.(parsed.botId)
      if (fg && !TERMINAL_WORK_STATUSES.has(fg.status) && typeof fg.sessionId === 'string' && fg.sessionId !== '') {
        return fg.sessionId
      }
    }
    return undefined
  }

  if (parsed.kind === 'task') {
    const foundTask = findTaskRecord(state, parsed.taskId)
    if (foundTask !== undefined) {
      return isActiveTask(foundTask.task) ? foundTask.task.sessionId : undefined
    }
    if (coordDb && !coordDb.isClosed?.()) {
      const work = coordDb.getWorkByLogicalAddress?.(logicalAddress)
        ?? coordDb.getWork?.(parsed.taskId)
        ?? coordDb.getWork?.(logicalAddress)
      if (work !== undefined) {
        if (TERMINAL_WORK_STATUSES.has(work.status)) return undefined
        const bot = ownKey(state?.bots, work.botId)
        if (hasStateBots && bot === undefined) return undefined
        const metaTaskId = work.meta?.taskId ?? work.apiMeta?.taskId ?? work.meta?.legacyTaskId
        if (typeof metaTaskId === 'string' && metaTaskId !== '' && bot !== undefined) {
          const matched = (bot.tasks ?? []).find(item => item?.id === metaTaskId)
          if (matched !== undefined) return isActiveTask(matched) ? matched.sessionId : undefined
        }
        if (typeof work.sessionId === 'string' && work.sessionId !== '') {
          if (bot !== undefined) {
            const thread = threadOfPart(bot, work.sessionId)
            if (thread?.thread === 'task') {
              const task = bot.tasks[thread.index]
              return isActiveTask(task) ? task.sessionId : undefined
            }
            if (thread?.thread === 'current') {
              return currentSession(bot)
            }
          }
          return work.sessionId
        }
      }
    }
    return undefined
  }

  if (parsed.kind === 'room') {
    const room = ownKey(state?.rooms, parsed.roomId)
    if (room === undefined) return undefined
    if (!Array.isArray(room.members) || !room.members.includes(parsed.botId)) return undefined
    if (hasStateBots && ownKey(state?.bots, parsed.botId) === undefined) return undefined
    const sid = ownKey(room.sessions, parsed.botId)
    return typeof sid === 'string' && sid !== '' ? sid : undefined
  }

  if (parsed.kind === 'api') {
    if (coordDb && !coordDb.isClosed?.()) {
      const work = coordDb.getWorkByApiRunId?.(parsed.apiRunId)
        ?? coordDb.getWorkByLogicalAddress?.(logicalAddress)
      if (!work || TERMINAL_WORK_STATUSES.has(work.status)) return undefined
      if (work.roomId) return resolveLogicalSession(rtOrState, roomMemberAddress(work.roomId, work.botId))
      if (typeof work.sessionId === 'string' && work.sessionId !== '') return work.sessionId
    }
    return undefined
  }

  return undefined
}

// Derives the stable logical address of a live or earlier Session id.
export function logicalAddressOf(rtOrState, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const taskOwner = rtOrState?.taskOwners?.get?.(sessionId)
  if (taskOwner?.taskId) return taskAddress(taskOwner.taskId)
  const groupOwner = rtOrState?.groupOwners?.get?.(sessionId)
  if (groupOwner?.roomId && groupOwner?.botId) return roomMemberAddress(groupOwner.roomId, groupOwner.botId)
  const chatOwner = rtOrState?.chatOwners?.get?.(sessionId)
  if (chatOwner) return foregroundAddress(chatOwner)

  const coordDb = rtOrState?.coordDb
  if (coordDb && !coordDb.isClosed?.()) {
    const work = coordDb.getWorkBySessionId?.(sessionId)
    if (work?.logicalAddress) return work.logicalAddress
  }

  const state = stateOf(rtOrState)
  const past = rtOrState?.pastOwners?.get?.(sessionId)
  if (past !== undefined) {
    if (past.roomId && past.botId) return roomMemberAddress(past.roomId, past.botId)
    if (past.botId) {
      const bot = ownKey(state?.bots, past.botId)
      const thread = threadOfPart(bot, sessionId)
      if (thread?.thread === 'task') return taskAddress(thread.taskId)
      if (thread?.thread === 'current') return foregroundAddress(past.botId)
    }
  }

  for (const room of Object.values(state?.rooms ?? {})) {
    if (!room || typeof room !== 'object') continue
    for (const [botId, sid] of Object.entries(room.sessions ?? {})) {
      if (sid === sessionId) return roomMemberAddress(room.id, botId)
    }
    for (const [botId, segments] of Object.entries(room.segments ?? {})) {
      if ((segments ?? []).some(seg => seg?.sessionId === sessionId)) return roomMemberAddress(room.id, botId)
    }
  }
  for (const bot of Object.values(state?.bots ?? {})) {
    const thread = threadOfPart(bot, sessionId)
    if (thread?.thread === 'task') return taskAddress(thread.taskId)
    if (thread?.thread === 'current') return foregroundAddress(bot.id)
  }
  return undefined
}

// Computes the immutable logical return address for a delegation, ask_back, or task.
export function returnAddress(rtOrState, {
  logicalAddress,
  taskId,
  roomId,
  fromRoom,
  botId,
  workId,
  sessionId,
  fromPart,
} = {}) {
  if (typeof logicalAddress === 'string' && parseLogicalAddress(logicalAddress) !== undefined) return logicalAddress
  if (typeof taskId === 'string' && taskId !== '') return taskAddress(taskId)
  const effectiveRoom = roomId ?? fromRoom
  if (typeof effectiveRoom === 'string' && effectiveRoom !== '' && typeof botId === 'string' && botId !== '') {
    return roomMemberAddress(effectiveRoom, botId)
  }
  const coordDb = rtOrState?.coordDb
  if (typeof workId === 'string' && workId !== '' && coordDb && !coordDb.isClosed?.()) {
    const work = coordDb.getWork?.(workId)
    if (work?.logicalAddress) return work.logicalAddress
  }
  const fromSession = logicalAddressOf(rtOrState, sessionId ?? fromPart)
  if (fromSession !== undefined) return fromSession
  if (typeof botId === 'string' && botId !== '') return foregroundAddress(botId)
  return undefined
}

export function install(rt) {
  Object.assign(rt, {
    parseLogicalAddress,
    foregroundAddress,
    taskAddress,
    roomMemberAddress,
    resolveLogicalSession: address => resolveLogicalSession(rt, address),
    logicalAddressOf: sessionId => logicalAddressOf(rt, sessionId),
    returnAddress: target => returnAddress(rt, target),
  })
}
