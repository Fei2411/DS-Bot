import { currentPart } from './text.js'

// What the sidebar lists, most recent first; a pinned row stays above the rest.
// A room's activity lives in its Session, whose id is not always the room's own, so
// reading `stamps[room.id]` left every group sorted by when it was created.
export function sidebarEntries(roster, stamps) {
  const at = (id, fallback = 0) => stamps[id] ?? fallback
  const entries = [
    ...roster.bots.filter(bot => bot.id !== roster.mainBotId).map(bot => ({ kind: 'bot', item: bot, at: at(currentPart(bot), bot.createdAt) })),
    ...roster.rooms.map(room => ({ kind: 'room', item: room, at: at(room.sessionId ?? room.id, room.createdAt) })),
    // An Agent sorts by its most recent Session, falling back to when it was added.
    ...(roster.agents ?? []).map(agent => ({ kind: 'agent', item: agent, at: Math.max(0, ...agent.sessions.map(id => at(id))) || agent.createdAt })),
  ]
  return entries.sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)
}

// How the list can be narrowed; 'all' keeps the sections the user made.
export const SIDEBAR_KINDS = ['all', 'bot', 'room']

export function filterSidebarEntries(entries, kind) {
  if (kind === undefined || kind === 'all') return entries
  return entries.filter(entry => entry.kind === kind)
}

// A section rises with its busiest member: the list is ordered by what was said
// last, so a group holding the newest reply belongs at the top too.
export function sectionsByActivity(sections, entries) {
  const newest = new Map()
  for (const entry of entries) {
    const id = entry.item.sectionId
    if (id === undefined) continue
    newest.set(id, Math.max(newest.get(id) ?? 0, entry.at))
  }
  return [...sections].sort((a, b) => (newest.get(b.id) ?? b.createdAt ?? 0) - (newest.get(a.id) ?? a.createdAt ?? 0))
}
