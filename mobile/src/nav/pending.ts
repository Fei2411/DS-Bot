import type { TeamState } from '../connection.ts'

// Everything the Needs you page lists: questions, approvals, secret requests,
// browser handoffs and cards waiting for an answer. The count and the page agree.
export function pendingCountOf(team: TeamState | null): number {
  const questions = Object.keys(team?.questions ?? {}).length
  const approvals = (team?.work?.approvals ?? []).filter(a => a.answerable !== false).length
  const secrets = Object.values(team?.secretRequests ?? {}).flat().filter(r => r.status === 'pending').length
  const holds = Object.values((team as { browserHolds?: Record<string, { callId?: string }> } | null)?.browserHolds ?? {}).filter(hold => hold.callId !== undefined).length
  const views = Object.keys(team?.views ?? {}).length
  return questions + approvals + secrets + holds + views
}
