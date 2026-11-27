import { botState, isBrowserHandoff, isComputerHandoff, RUNNING_STATES, toolState } from '../../../ds-bot/src/client/mark-states.js'
import type { Bot, TeamState } from '../connection.ts'
import { runningActivityOf, type WorkDetail } from '../ui/phrases.ts'

// What a Bot's mark shows, from the team's state as the desktop sidebar reads it
// (sidebar.js BotRow + mark.js dmMarkState): what it is doing, waiting for you,
// last-turn failure, active background tasks, and unread replies.

const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting_work', 'waiting_approval'])

// Whether the Bot runs a turn now, in its own chat or in a group.
export function botRunning(team: TeamState | null, botId: string): boolean {
  const work = team?.work
  if (work?.bots?.[botId] !== undefined) return true
  return Object.values(work?.rooms ?? {}).some(list => Array.isArray(list) && list.some(entry => entry?.botId === botId))
}

// Foreground DM work for a Bot's own chat (never group work, even though host work.bots
// and activity fall back to group turns when a Bot is only working in a group).
export function ownWorkOf(team: TeamState | null, botId: string): WorkDetail | string | undefined {
  const workBot = team?.work?.bots?.[botId]
  if (workBot !== undefined) return workBot.roomId === undefined ? workBot : undefined
  const inGroup = Object.values(team?.work?.rooms ?? {}).some(list => Array.isArray(list) && list.some(entry => entry?.botId === botId))
  if (inGroup) return undefined
  return runningActivityOf(undefined, team?.activity?.[botId])
}

// Whether a Bot has an unread reply of its own (as opposed to a newer user message
// sent on desktop before the Bot answered).
export const hasUnreadBotReply = (bot: Pick<Bot, 'lastAt' | 'lastBotAt'>, unreadAtBotReply: boolean): boolean => (
  unreadAtBotReply
  && bot.lastBotAt !== undefined
  && (bot.lastAt === undefined || bot.lastBotAt >= bot.lastAt)
)

// Merges an unchanged-revision live state poll into the previous snapshot and projects
// per-Bot live tail metadata (lastAt, lastBotAt, latestTurn, preview) onto bots[].
export function mergeTeamState(prev: TeamState | null, next: TeamState): TeamState {
  const merged = next.unchanged === true && prev !== null ? { ...prev, ...next } : next
  const tails = merged.botTails
  if (tails === undefined || !Array.isArray(merged.bots)) return merged
  let changed = false
  const bots = merged.bots.map((bot) => {
    const tail = tails[bot.id]
    if (tail === undefined) return bot
    const lastAt = tail.lastAt ?? bot.lastAt
    const lastBotAt = tail.lastBotAt ?? bot.lastBotAt
    const latestTurn = tail.latestTurn ?? bot.latestTurn
    const preview = tail.preview ?? bot.preview
    if (lastAt === bot.lastAt && lastBotAt === bot.lastBotAt && latestTurn === bot.latestTurn && preview === bot.preview) return bot
    changed = true
    return {
      ...bot,
      ...(lastAt !== undefined ? { lastAt } : {}),
      ...(lastBotAt !== undefined ? { lastBotAt } : {}),
      ...(latestTurn !== undefined ? { latestTurn } : {}),
      ...(preview !== undefined ? { preview } : {}),
    }
  })
  return changed ? { ...merged, bots } : merged
}

type Requests = Record<string, { status?: string }[] | undefined> | undefined
const hasPending = (list: { status?: string }[] | undefined) => Array.isArray(list) && list.some(request => request?.status === 'pending')

export function botMarkState(
  team: TeamState | null,
  bot: Bot,
  options?: { replied?: boolean; latestTurn?: number },
): string {
  const id = bot.id
  const part = bot.sessionId ?? id
  // Group approvals show on the group, not on the Bot (#1623).
  const own = (team?.work?.approvals ?? []).filter(entry => entry?.roomId === undefined && entry?.botId === id && entry?.answerable !== false)
  const fgComputer = Object.values(team?.computerLive?.asks ?? {}).some(ask => ask?.roomId === undefined && ask?.botId === id)
  const card = hasPending(team?.secretRequests?.[id]) || hasPending(team?.connectorRequests?.[id]) || hasPending((team?.mailRequests as Requests)?.[id])
  const question = team?.questions?.[part] !== undefined || team?.views?.[part] !== undefined
  const handoff = isBrowserHandoff(team?.browserHolds?.[id]) || isComputerHandoff(team?.computerLive?.holds?.[id])
  // Direct-chat background tasks (non-group, mirroring bot-tasks.js tasksForChat).
  const dmTasks = (bot.tasks ?? []).filter(task => task && !task.roomId && ACTIVE_TASK_STATUSES.has(task.status))
  const background = dmTasks.length > 0
  const taskWaitingApproval = dmTasks.some(task => task.status === 'waiting_approval')
  // A turn stops on these until you answer; a background task's approval or a skill to
  // learn waits without stopping foreground work.
  const blocking = own.some(entry => entry.taskId === undefined) || fgComputer || card || question || handoff
  const waits = blocking || own.some(entry => entry.taskId !== undefined) || taskWaitingApproval || (team?.learning?.[id]?.length ?? 0) > 0
  // Last-turn failure or active credential/balance block (mark.js lastTurnFailed).
  const failure = bot.failures?.[part]
  const latestTurn = options?.latestTurn ?? team?.botTails?.[id]?.latestTurn ?? bot.latestTurn
  const failed = bot.blocked !== undefined || (failure !== undefined && !(typeof failure.turn === 'number' && failure.turn >= 1 && typeof latestTurn === 'number' && latestTurn > failure.turn))
  // The computer's own word for what the Bot does (thinking, searching, waiting…).
  const said: unknown = team?.activity?.[id]
  const activity = typeof said === 'string' ? said : undefined
  const doing = blocking ? 'alert' : activity === 'alert' ? undefined : activity
  return botState(botRunning(team, id), doing, waits, {
    failed,
    background,
    replied: options?.replied === true,
  })
}

// A running turn's own mark (the chat's activity row): thinking until a tool runs, then
// what the tool does, as the desktop's activity row shows it (cells.js).
export const workMarkState = (doing: { tool?: string; switching?: boolean } | string | undefined) => {
  if (typeof doing === 'string') return RUNNING_STATES.has(doing) ? doing : 'thinking'
  return doing?.switching || !doing?.tool ? 'thinking' : toolState(doing.tool)
}

// Whether a block anchored at the top of a scroll view is still at least partially visible.
export const isTopBlockInView = (scrollY: number, blockBottom: number): boolean => blockBottom <= 0 || scrollY < blockBottom

// Desktop useSettled transition rules (mark.js): leaving work into idle/replied celebrates once;
// leaving alert/failed or switching between idle and replied does not.
const AFTER_WORK = new Set(['idle', 'replied'])
const NOT_WORK = new Set(['alert', 'failed'])
export const isAfterWorkState = (state: string): boolean => AFTER_WORK.has(state)
export const shouldCelebrateSettle = (prevState: string, nextState: string): boolean => (
  AFTER_WORK.has(nextState) && !AFTER_WORK.has(prevState) && !NOT_WORK.has(prevState)
)

// Preview priority for one Bot row (mirroring desktop sidebar.js BotRow):
// foreground blocking questions/approvals > foreground own-chat turn > group work >
// deferred background approvals > waiting on handed-off work > fallback preview/role.
export function botPreviewKind(team: TeamState | null, bot: Bot): { kind: 'answer' | 'approval' | 'doing' | 'group' | 'waiting' | 'idle'; doing?: unknown; roomId?: string; groupEntry?: WorkDetail } {
  const sessionId = bot.sessionId ?? bot.id
  if (team?.questions?.[sessionId] !== undefined || team?.views?.[sessionId] !== undefined) return { kind: 'answer' }
  const approvals = (Array.isArray(team?.work?.approvals) ? team.work.approvals : []).filter(a => a?.answerable !== false && a?.roomId === undefined && a?.botId === bot.id)
  const fgComputer = Object.values(team?.computerLive?.asks ?? {}).some(ask => ask?.roomId === undefined && ask?.botId === bot.id)
  if (approvals.some(a => a.taskId === undefined) || fgComputer) return { kind: 'approval' }
  const workBot = team?.work?.bots?.[bot.id]
  if (workBot !== undefined && workBot.roomId === undefined) return { kind: 'doing', doing: workBot }
  const workRooms = team?.work?.rooms ?? {}
  if (workBot?.roomId !== undefined) {
    const preferred = Array.isArray(workRooms[workBot.roomId]) ? workRooms[workBot.roomId].find(e => e?.botId === bot.id) : undefined
    return { kind: 'group', roomId: workBot.roomId, groupEntry: preferred ?? workBot }
  }
  for (const [roomId, list] of Object.entries(workRooms)) {
    const entry = Array.isArray(list) ? list.find(e => e?.botId === bot.id) : undefined
    if (entry !== undefined) return { kind: 'group', roomId, groupEntry: entry }
  }
  const activity = team?.activity?.[bot.id]
  const activeWord = typeof activity === 'string' && RUNNING_STATES.has(activity) && activity !== 'done' ? activity : undefined
  if (activeWord !== undefined) return { kind: 'doing', doing: activeWord }
  const hasBgApproval = approvals.some(a => a.taskId !== undefined)
    || (bot.tasks ?? []).some(task => task && !task.roomId && task.status === 'waiting_approval')
  if (hasBgApproval) return { kind: 'approval' }
  const waits = team?.work?.waiting?.[bot.id]
  if (waits !== undefined && (waits.bots?.length || waits.rooms?.length)) return { kind: 'waiting' }
  return { kind: 'idle' }
}
