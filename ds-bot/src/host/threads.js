// A Bot's own chat is one or more threads. The current thread is `bot.sessionId` with
// its earlier parts in `bot.segments`; a thread opened while the Bot was busy keeps its
// own session and its own earlier parts in `bot.openParts`. Parts never share a chain:
// a handoff reads only the thread it belongs to, so background work and the foreground
// chat cannot leak into each other.
// A Bot that never ran yet has no stored session id: its first Session is the Bot id
// (store.js chatOf falls back to it).
export const currentSession = bot => bot?.sessionId ?? bot?.id

export function threadOf(bot, sessionId) {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current', segments: bot.segments ?? [] }
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts[at].segments ?? [] }
}

export const threadSegments = (bot, sessionId) => threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot, sessionId) => threadOf(bot, sessionId)?.thread === 'open'

// A thread's current session: the part that a handoff or a kept input belongs to.
export function threadCurrent(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
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
    const part = bot.openParts[thread.index]
    ;(part.segments ??= []).push(segment)
    part.sessionId = freshId
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

// Makes a live background part current. Each chain travels with its parts.
export function focusOpenPart(bot, sessionId) {
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts.splice(at, 1)
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [] })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  return true
}

// Every session this Bot keeps outside its current thread, for cleanup, memory and the
// session list.
export const openSessions = bot => (bot?.openParts ?? []).flatMap(part => [part.sessionId, ...(part.segments ?? []).map(segment => segment.sessionId)])

// Every live thread's current session. A change that must reach all of a Bot's own
// chats (its run mode) walks these, so no thread can be left on the other side.
export const ownChatSessions = bot => [currentSession(bot), ...(bot?.openParts ?? []).map(part => part.sessionId)].filter((id, index, list) => id !== undefined && list.indexOf(id) === index)
