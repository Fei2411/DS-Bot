import type { Bot, Room, TeamState } from '../connection.ts'

export type PendingItem =
  | { kind: 'question'; key: string; botId: string; summary: string }
  | { kind: 'approval'; key: string; botId: string; roomId?: string; summary: string }
  | { kind: 'secret'; key: string; botId: string; name?: string }
  | { kind: 'connector'; key: string; botId: string; connectorId: string; name: string; purpose?: string }
  | { kind: 'handoff'; key: string; botId: string; note?: string; reason?: string }
  | { kind: 'view'; key: string; botId: string; title?: string }

// Everything the Needs you page lists: questions, approvals, secret requests,
// browser handoffs and cards waiting for an answer. The count, the drawer badge,
// the team-list indicators and the page all derive from this single list.
export function pendingItemsOf(team: TeamState | null): PendingItem[] {
  if (team === null) return []
  const bots = Array.isArray(team.bots) ? team.bots : []
  const botById = new Map(bots.map(bot => [bot.id, bot]))
  const botBySession = new Map(bots.map(bot => [bot.sessionId ?? bot.id, bot]))
  const items: PendingItem[] = []

  for (const [botId, proposals] of Object.entries(team.learning ?? {})) {
    if (!botById.has(botId)) continue
    for (const proposal of proposals) {
      items.push({ kind: 'approval', key: `learning-${proposal.id}`, botId, summary: proposal.kind === 'agents' ? `${proposal.folder}/AGENTS.md` : `skills/${proposal.name}/SKILL.md` })
    }
  }

  for (const [sessionId, question] of Object.entries(team.questions ?? {})) {
    const bot = botBySession.get(sessionId)
    if (bot !== undefined && question !== undefined) {
      items.push({ kind: 'question', key: `q-${question.id}`, botId: bot.id, summary: question.question })
    }
  }
  for (const approval of team.work?.approvals ?? []) {
    if (approval.answerable === false || !botById.has(approval.botId)) continue
    items.push({
      kind: 'approval',
      key: `a-${approval.id}`,
      botId: approval.botId,
      roomId: approval.roomId,
      summary: [approval.taskTitle, approval.tool, approval.reason].filter(Boolean).join(' · '),
    })
  }
  for (const [botId, list] of Object.entries(team.secretRequests ?? {})) {
    if (!botById.has(botId)) continue
    for (const req of list ?? []) {
      if (req.status === 'pending') items.push({ kind: 'secret', key: `s-${req.id}`, botId, name: req.name })
    }
  }
  for (const [botId, list] of Object.entries(team.connectorRequests ?? {})) {
    if (!botById.has(botId)) continue
    for (const req of list ?? []) {
      if (req.status === 'pending') {
        items.push({
          kind: 'connector',
          key: `c-${req.id}`,
          botId,
          connectorId: req.connectorId,
          name: req.name || req.connectorId,
          purpose: req.purpose,
        })
      }
    }
  }
  const holds = (team as { browserHolds?: Record<string, { callId?: string; note?: string; reason?: string }> }).browserHolds ?? {}
  for (const [botId, hold] of Object.entries(holds)) {
    if (hold.callId !== undefined && botById.has(botId)) {
      items.push({ kind: 'handoff', key: `h-${hold.callId}`, botId, note: hold.note, reason: hold.reason })
    }
  }
  for (const [sessionId, view] of Object.entries(team.views ?? {})) {
    const bot = botBySession.get(sessionId)
    if (bot !== undefined && view !== undefined) {
      items.push({ kind: 'view', key: `v-${view.id ?? sessionId}`, botId: bot.id, title: view.title })
    }
  }
  return items
}

export function pendingCountOf(team: TeamState | null): number {
  return pendingItemsOf(team).length
}

export function botHasPending(team: TeamState | null, bot: Bot): boolean {
  return pendingItemsOf(team).some(item => item.botId === bot.id)
}

export function roomHasPending(team: TeamState | null, room: Room): boolean {
  return pendingItemsOf(team).some(item => item.kind === 'approval' && item.roomId === room.id)
}
