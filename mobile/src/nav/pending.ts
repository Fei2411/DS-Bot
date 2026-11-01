import type { TeamState } from '../connection.ts'

export function pendingCountOf(team: TeamState | null): number {
  const questions = Object.keys(team?.questions ?? {}).length
  const approvals = (team?.work?.approvals ?? []).filter(a => a.answerable !== false).length
  const secrets = Object.values(team?.secretRequests ?? {}).flat().filter(r => r.status !== 'settled').length
  return questions + approvals + secrets
}
