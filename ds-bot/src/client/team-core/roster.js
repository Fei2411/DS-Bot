// Roster indexing & lookup helpers for team-core, building on the dependency-free
// source primitives in `../sources.js`.
export {
  createSource,
  EMPTY_ROSTER,
  isMainOf,
  sectionCollapsed,
  indexRoster,
  isAgentSession,
  heldCardKey,
  countCards,
} from '../sources.js'

// A Bot id or a group chat id, or any part of either's chat, resolves to its current part.
export function partForRoster(roster, id) {
  const bot = roster?.byId?.[id]
  if (bot !== undefined) return bot.sessionId ?? bot.id
  const room = roster?.roomsById?.[id]
  return room === undefined ? id : (room.sessionId ?? room.id)
}

// Resolve the Bot or group entry owning any session or part id.
export function ownerOfSession(roster, sessionId) {
  if (!roster || !sessionId) return undefined
  if (roster.byId?.[sessionId] !== undefined) return roster.byId[sessionId]
  if (roster.roomsById?.[sessionId] !== undefined) return roster.roomsById[sessionId]
  return Object.values(roster.byId ?? {}).find(bot => (bot.sessionId ?? bot.id) === sessionId)
    ?? Object.values(roster.roomsById ?? {}).find(room => (room.sessionId ?? room.id) === sessionId)
}

// Canonical visit-tracking key: Bots and group chats span parts, so last-left timestamps
// are keyed by the stable Bot or room id rather than an ephemeral segment id.
export function seenKeyOf(roster, id) {
  return roster?.byId?.[id]?.id ?? roster?.roomsById?.[id]?.id ?? id
}
