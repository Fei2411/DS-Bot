import type { TeamState } from '../connection.ts'
import { t } from '../ui/i18n.ts'

export interface PendingRow { key: string; botId: string; roomId?: string; summary: string }

export interface PendingSections {
  questions: PendingRow[]
  approvals: PendingRow[]
  secrets: PendingRow[]
  handoffs: PendingRow[]
  views: PendingRow[]
}

// Everything the Needs you page lists: questions, approvals, secret requests,
// browser handoffs and cards waiting for an answer. The badge counts these rows,
// not the raw keys, so a question keyed by a session whose Bot is gone cannot
// inflate the count the page then fails to show.
export function pendingSectionsOf(team: TeamState | null): PendingSections {
  const bots = team?.bots ?? []
  const botOfSession = (sessionId: string) => bots.find(bot => bot.sessionId === sessionId || bot.id === sessionId)
  const questions = Object.entries(team?.questions ?? {}).flatMap(([sessionId, question]) => {
    const bot = botOfSession(sessionId)
    return bot === undefined ? [] : [{ key: `q-${question.id}`, botId: bot.id, summary: question.question }]
  })
  const approvals = (team?.work?.approvals ?? []).filter(approval => approval.answerable !== false).map(approval => ({
    key: `a-${approval.id}`, botId: approval.botId, roomId: approval.roomId,
    summary: [approval.tool, approval.reason].filter(Boolean).join(' · '),
  }))
  const secrets = Object.entries(team?.secretRequests ?? {}).flatMap(([botId, list]) =>
    (list ?? []).filter(request => request.status === 'pending').map(request => ({
      key: `s-${request.id}`, botId,
      summary: request.name ? t('Asks for the secret {name}', { name: request.name }) : t('A secret is needed'),
    })))
  const handoffs = Object.entries(team?.browserHolds ?? {})
    .filter(([, hold]) => hold.callId !== undefined)
    .map(([botId, hold]) => ({ key: `h-${hold.callId}`, botId, summary: hold.note ?? hold.reason ?? t('Browser handoff') }))
  const views = Object.entries(team?.views ?? {}).flatMap(([sessionId, view]) => {
    const bot = botOfSession(sessionId)
    return bot === undefined ? [] : [{ key: `v-${view?.id ?? sessionId}`, botId: bot.id, summary: view?.title ?? t('View') }]
  })
  return { questions, approvals, secrets, handoffs, views }
}

export function pendingCountOf(team: TeamState | null): number {
  const sections = pendingSectionsOf(team)
  return sections.questions.length + sections.approvals.length + sections.secrets.length + sections.handoffs.length + sections.views.length
}
