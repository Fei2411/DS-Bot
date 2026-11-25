import { botState, toolState } from '../../../ds-bot/src/client/mark-states.js'
import type { Bot, TeamState } from '../connection.ts'
import { botHasPending } from '../nav/pending.ts'

// What a Bot's mark shows, from the team's work as the desktop reads it (sidebar.js,
// header.js): waiting for you wins, then working in its own chat or in a group.

// Whether the Bot runs a turn now, in its own chat or in a group.
export function botRunning(team: TeamState | null, botId: string): boolean {
  const work = team?.work
  if (work?.bots?.[botId] !== undefined) return true
  return Object.values(work?.rooms ?? {}).some(list => Array.isArray(list) && list.some(entry => entry?.botId === botId))
}

export function botMarkState(team: TeamState | null, bot: Bot): string {
  const alert = botHasPending(team, bot)
  return alert ? 'alert' : botState(botRunning(team, bot.id), undefined, false)
}

// A running turn's own mark (the chat's activity row): thinking until a tool runs, then
// what the tool does, as the desktop's activity row shows it (cells.js).
export const workMarkState = (doing: { tool?: string; switching?: boolean } | undefined) => (doing?.switching || !doing?.tool ? 'thinking' : toolState(doing.tool))
