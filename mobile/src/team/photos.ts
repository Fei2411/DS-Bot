import type { Bot, Room, TeamState } from '../connection.ts'

// Keep the previous photo while its replacement loads; no ref means it was removed.
export function fillTeamPhotos(team: TeamState, prev: TeamState | null, cache: Map<string, string>, fetch: (id: string, ref: string, group: boolean) => void): TeamState {
  const fill = <T extends Bot | Room>(entries: T[], previous: T[], group: boolean): T[] => entries.map(entry => {
    const ref = entry.avatar?.imageRef
    if (ref === undefined) return entry
    const cached = cache.get(ref)
    if (cached !== undefined) return entry.avatar?.image === cached ? entry : { ...entry, avatar: { ...entry.avatar, image: cached } }
    fetch(entry.id, ref, group)
    const kept = previous.find(item => item.id === entry.id)?.avatar?.image
    return kept !== undefined && kept !== entry.avatar?.image ? { ...entry, avatar: { ...entry.avatar, image: kept } } : entry
  })
  const bots = fill(team.bots, prev?.bots ?? [], false)
  const rooms = team.rooms === undefined ? undefined : fill(team.rooms, prev?.rooms ?? [], true)
  return bots.every((bot, index) => bot === team.bots[index]) && (rooms === undefined || rooms.every((room, index) => room === team.rooms?.[index])) ? team : { ...team, bots, rooms }
}
