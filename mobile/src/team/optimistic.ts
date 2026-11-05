import type { Bot, Room, TeamState } from '../connection.ts'

// The write's effect on the team state, guessed before the reply lands, so a
// remote edit feels instant. Only the writes the screens fire often are
// mirrored here; anything else (or an unknown id) returns the same object.
// The reply's state, or a full reload after a failure, always wins afterwards.
export function optimistic(team: TeamState | null, endpoint: string, payload: Record<string, unknown>): TeamState | null {
  if (team === null) return null
  switch (endpoint) {
    case 'update-bot': {
      const index = team.bots.findIndex(bot => bot.id === payload.id)
      if (index === -1) return team
      const { id: _id, ...patch } = payload
      const bot: Bot = { ...team.bots[index], ...patch }
      // The computer reads `null`/`''` as "clear"; the state omits the key.
      if (patch.effort === null) delete bot.effort
      if (patch.workDir === '') delete bot.workDir
      const bots = [...team.bots]
      bots[index] = bot
      return { ...team, bots }
    }
    case 'set-main': {
      const id = String(payload.id ?? '')
      if (!team.bots.some(bot => bot.id === id)) return team
      const mains = new Set(team.mainBotIds ?? [])
      if (payload.main === false) mains.delete(id)
      else mains.add(id)
      const mainBotIds = [...mains]
      return { ...team, mainBotIds, mainBotId: mainBotIds[0] ?? null }
    }
    case 'bot-capability': {
      const index = team.bots.findIndex(bot => bot.id === payload.botId)
      if (index === -1) return team
      const attached = new Set(team.bots[index].capabilities ?? [])
      if (payload.attached === true) attached.add(String(payload.name))
      else attached.delete(String(payload.name))
      const bots = [...team.bots]
      bots[index] = { ...team.bots[index], capabilities: [...attached] }
      return { ...team, bots }
    }
    case 'update-room': {
      const rooms = team.rooms ?? []
      const index = rooms.findIndex(room => room.id === payload.id)
      if (index === -1) return team
      const { id: _id, ...patch } = payload
      const next: Room[] = [...rooms]
      next[index] = { ...rooms[index], ...patch }
      return { ...team, rooms: next }
    }
    default:
      return team
  }
}
