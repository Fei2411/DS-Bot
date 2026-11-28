import type { Bot, InboxItem, Question, Room, ShownView, TeamState } from '../connection.ts'
import { inboxSummary } from '../../../ds-bot/src/client/inbox-text.js'
import { t } from '../ui/i18n.ts'

export type PendingGroup = 'decide' | 'fix' | 'suggest'

/** One thing that waits for the user, in the order the Needs you page lists it. */
export interface PendingItem {
  key: string
  kind: string
  group: PendingGroup
  ref?: string
  botId?: string
  roomId?: string
  sessionId?: string
  summary: string
}

const GROUPS: PendingGroup[] = ['decide', 'fix', 'suggest']

// Everything the Needs you page lists. The count, the drawer badge, the team-list marks
// and the page all derive from this one list. A host that sends its inbox (src/host/
// inbox.js) decides it, so the phone lists what the computer lists; an older host's
// team is read the way it was before.
export function pendingItemsOf(team: TeamState | null): PendingItem[] {
  if (team === null) return []
  if (Array.isArray(team.inbox?.items)) return fromInbox(team, team.inbox.items)
  return fromTeam(team)
}

function fromInbox(team: TeamState, items: InboxItem[]): PendingItem[] {
  const names = new Map((Array.isArray(team.bots) ? team.bots : []).map(bot => [bot.id, bot.name]))
  return items
    .filter(item => typeof item?.id === 'string' && GROUPS.includes(item.group))
    .map(item => ({
      key: item.id,
      kind: item.kind,
      group: item.group,
      ...(typeof item.ref === 'string' && item.ref !== '' ? { ref: item.ref } : {}),
      ...(item.botId !== undefined ? { botId: item.botId } : {}),
      ...(item.roomId !== undefined ? { roomId: item.roomId } : {}),
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
      summary: inboxSummary(item, t, (id: string) => names.get(id)),
    }))
}

// An older host: questions, views, approvals, secret and connector requests, browser
// handoffs and learning proposals, from the team as it sends them.
function fromTeam(team: TeamState): PendingItem[] {
  const bots = Array.isArray(team.bots) ? team.bots : []
  const botById = new Map(bots.map(bot => [bot.id, bot]))
  const botBySession = new Map(bots.map(bot => [bot.sessionId ?? bot.id, bot]))
  const items: PendingItem[] = []

  for (const [sessionId, question] of Object.entries(team.questions ?? {})) {
    const bot = botBySession.get(sessionId)
    if (bot !== undefined && question !== undefined) {
      items.push({ kind: 'question', group: 'decide', key: `q-${question.id}`, ref: question.id, botId: bot.id, sessionId, summary: question.question })
    }
  }
  for (const approval of team.work?.approvals ?? []) {
    if (approval.answerable === false || !botById.has(approval.botId)) continue
    items.push({
      kind: 'approval',
      group: 'decide',
      key: `a-${approval.id}`,
      ref: approval.id,
      botId: approval.botId,
      sessionId: approval.sessionId,
      ...(approval.roomId !== undefined ? { roomId: approval.roomId } : {}),
      summary: [approval.taskTitle, approval.tool, approval.reason].filter(Boolean).join(' · '),
    })
  }
  for (const [botId, list] of Object.entries(team.secretRequests ?? {})) {
    if (!botById.has(botId)) continue
    for (const req of list ?? []) {
      if (req.status === 'pending') {
        items.push({ kind: 'secret', group: 'decide', key: `s-${req.id}`, ref: req.id, botId, summary: req.name ? t('Asks for the secret {name}', { name: req.name }) : t('A secret is needed') })
      }
    }
  }
  for (const [botId, list] of Object.entries(team.connectorRequests ?? {})) {
    const bot = botById.get(botId)
    if (bot === undefined) continue
    for (const req of list ?? []) {
      if (req.status !== 'pending') continue
      const name = req.name || req.connectorId
      items.push({
        kind: 'connector',
        group: 'decide',
        key: `c-${req.id}`,
        ref: req.id,
        botId,
        summary: req.purpose ? `${name} · ${req.purpose}` : t('{bot} needs {name}', { bot: bot.name, name }),
      })
    }
  }
  const holds = team.browserHolds ?? {}
  for (const [botId, hold] of Object.entries(holds)) {
    if (hold.callId !== undefined && botById.has(botId)) {
      items.push({ kind: 'handoff', group: 'decide', key: `h-${hold.callId}`, ref: hold.callId, botId, summary: hold.note ?? hold.reason ?? t('Browser handoff') })
    }
  }
  for (const [sessionId, view] of Object.entries(team.views ?? {})) {
    const bot = botBySession.get(sessionId)
    if (bot !== undefined && view !== undefined) {
      items.push({ kind: 'view', group: 'decide', key: `v-${view.id ?? sessionId}`, ref: view.id ?? sessionId, botId: bot.id, sessionId, summary: view.title ?? 'View' })
    }
  }
  for (const [botId, proposals] of Object.entries(team.learning ?? {})) {
    if (!botById.has(botId)) continue
    for (const proposal of proposals) {
      items.push({ kind: 'learning', group: 'suggest', key: `learning-${proposal.id}`, ref: proposal.id, botId, summary: proposal.kind === 'agents' ? `${proposal.folder}/AGENTS.md` : `skills/${proposal.name}/SKILL.md` })
    }
  }
  return items
}

export function pendingCountOf(team: TeamState | null): number {
  return pendingItemsOf(team).length
}

// A card asked in a group waits in that group, not in the member's own chat (#1623).
export function botHasPending(team: TeamState | null, bot: Bot): boolean {
  return pendingItemsOf(team).some(item => item.botId === bot.id && item.roomId === undefined)
}

export function roomHasPending(team: TeamState | null, room: Room): boolean {
  return pendingItemsOf(team).some(item => item.roomId === room.id)
}

export function dockFocusKeyOf(item: Pick<PendingItem, 'kind' | 'ref' | 'sessionId'>): string | undefined {
  const ref = item.ref
  switch (item.kind) {
    case 'question': return ref ? `question-${ref}` : (item.sessionId ? `question-${item.sessionId}` : undefined)
    case 'view': return ref ? `view-${ref}` : (item.sessionId ? `view-${item.sessionId}` : undefined)
    case 'approval': return ref ? `approval-${ref}` : undefined
    case 'secret': return ref ? `secret-${ref}` : undefined
    case 'connector': return ref ? `connector-${ref}` : undefined
    case 'mail': return ref ? `mail-${ref}` : undefined
    case 'learning': return ref ? `learning-${ref}` : undefined
    case 'handoff': return 'handoff'
    default: return undefined
  }
}

export function chatTargetOf(row: PendingItem): { kind: 'bot' | 'room'; id: string; focus?: string } | null {
  const base = row.roomId ? { kind: 'room' as const, id: row.roomId } : row.botId ? { kind: 'bot' as const, id: row.botId } : null
  if (base === null) return null
  const focus = dockFocusKeyOf(row)
  return focus !== undefined ? { ...base, focus } : base
}

export function questionsForChat(
  team: TeamState | null,
  target: { room?: Room; sessionId: string },
): { sessionId: string; question: Question; botName?: string }[] {
  const result: { sessionId: string; question: Question; botName?: string }[] = []
  const seen = new Set<string>()
  const names = new Map((Array.isArray(team?.bots) ? team.bots : []).map(bot => [bot.id, bot.name]))
  const direct = target.sessionId !== '' ? team?.questions?.[target.sessionId] : undefined
  if (direct !== undefined) {
    seen.add(target.sessionId)
    result.push({ sessionId: target.sessionId, question: direct })
  }
  if (target.room !== undefined) {
    for (const item of team?.inbox?.items ?? []) {
      if (item.roomId !== target.room.id || item.kind !== 'question' || typeof item.sessionId !== 'string') continue
      if (seen.has(item.sessionId)) continue
      const question = team?.questions?.[item.sessionId]
      if (question === undefined) continue
      seen.add(item.sessionId)
      result.push({
        sessionId: item.sessionId,
        question,
        ...(item.botId !== undefined && names.has(item.botId) ? { botName: names.get(item.botId) } : {}),
      })
    }
  }
  return result
}

export function viewsForChat(
  team: TeamState | null,
  target: { room?: Room; sessionId: string },
): { sessionId: string; view: ShownView }[] {
  const result: { sessionId: string; view: ShownView }[] = []
  const seen = new Set<string>()
  const direct = target.sessionId !== '' ? team?.views?.[target.sessionId] : undefined
  if (direct !== undefined) {
    seen.add(target.sessionId)
    result.push({ sessionId: target.sessionId, view: direct })
  }
  if (target.room !== undefined) {
    for (const item of team?.inbox?.items ?? []) {
      if (item.roomId !== target.room.id || item.kind !== 'view' || typeof item.sessionId !== 'string') continue
      if (seen.has(item.sessionId)) continue
      const view = team?.views?.[item.sessionId]
      if (view === undefined) continue
      seen.add(item.sessionId)
      result.push({ sessionId: item.sessionId, view })
    }
  }
  return result
}

export function computerAsksForChat(
  team: TeamState | null,
  target: { bot?: Bot; room?: Room },
): { id: string; botId: string; botName: string; appName?: string; roomId?: string }[] {
  const asks = team?.computerLive?.asks ?? {}
  const names = new Map((Array.isArray(team?.bots) ? team.bots : []).map(bot => [bot.id, bot.name]))
  const list = Object.values(asks).filter(ask => {
    if (target.room !== undefined) return ask.roomId === target.room.id
    if (target.bot !== undefined) return ask.botId === target.bot.id && ask.roomId === undefined
    return false
  })
  return list.map(ask => ({
    ...ask,
    botName: names.get(ask.botId) ?? target.bot?.name ?? '',
  }))
}
