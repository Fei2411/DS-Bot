import { botState, toolState } from '../../../ds-bot/src/client/mark-states.js'
import type { Bot, TeamState } from '../connection.ts'

// What a Bot's mark shows, from the team's state as the desktop sidebar reads it
// (sidebar.js BotRow): what it is doing, and waiting for you.

// Whether the Bot runs a turn now, in its own chat or in a group.
export function botRunning(team: TeamState | null, botId: string): boolean {
  const work = team?.work
  if (work?.bots?.[botId] !== undefined) return true
  return Object.values(work?.rooms ?? {}).some(list => Array.isArray(list) && list.some(entry => entry?.botId === botId))
}

type Requests = Record<string, { status?: string }[] | undefined> | undefined
const hasPending = (list: { status?: string }[] | undefined) => Array.isArray(list) && list.some(request => request?.status === 'pending')

export function botMarkState(team: TeamState | null, bot: Bot): string {
  const id = bot.id
  const part = bot.sessionId ?? id
  // Group approvals show on the group, not on the Bot (#1623).
  const own = (team?.work?.approvals ?? []).filter(entry => entry?.roomId === undefined && entry?.botId === id && entry?.answerable !== false)
  const mail = (team as { mailRequests?: Requests } | null)?.mailRequests
  const browserHolds = (team as { browserHolds?: Record<string, { callId?: string } | undefined> } | null)?.browserHolds
  const card = hasPending(team?.secretRequests?.[id]) || hasPending(team?.connectorRequests?.[id]) || hasPending(mail?.[id])
  const question = team?.questions?.[part] !== undefined || team?.views?.[part] !== undefined
  // A turn stops on these until you answer; a background task's approval, a skill to
  // learn, or a browser handoff waits without stopping anything.
  const blocking = own.some(entry => entry.taskId === undefined) || card || question
  const browserHold = browserHolds?.[id]?.callId !== undefined
  const waits = blocking || own.some(entry => entry.taskId !== undefined) || (team?.learning?.[id]?.length ?? 0) > 0 || browserHold
  // The computer's own word for what the Bot does (thinking, searching, waiting…).
  const said: unknown = team?.activity?.[id]
  const activity = typeof said === 'string' ? said : undefined
  const doing = blocking ? 'alert' : activity === 'alert' ? undefined : activity
  return botState(botRunning(team, id), doing, waits)
}

// A running turn's own mark (the chat's activity row): thinking until a tool runs, then
// what the tool does, as the desktop's activity row shows it (cells.js).
export const workMarkState = (doing: { tool?: string; switching?: boolean } | undefined) => (doing?.switching || !doing?.tool ? 'thinking' : toolState(doing.tool))
