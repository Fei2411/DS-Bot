import type { TeamState } from '../connection.ts'

export interface ConnectorRow { id: string; name: string; state?: string; account?: string; error?: string }

interface ConnectorView { connectors?: ConnectorRow[]; mail?: unknown }

// The host sends `{ connectors, mail }`; a phone that read it as a bare array
// crashed the Connectors page. An older host may still send the array.
export function connectorList(team: TeamState | null): ConnectorRow[] {
  const view = team?.connectors as ConnectorView | ConnectorRow[] | undefined
  if (Array.isArray(view)) return view
  return Array.isArray(view?.connectors) ? view.connectors : []
}

type Status = { state?: string; error?: string }
const RANK: Record<string, number> = { error: 4, 'needs-approval': 3, connecting: 2, ready: 1 }

// Statuses are nested per Bot on the host. The library page lists one row per
// capability, so it shows the most serious status among the Bots that have it.
export function capabilityStatusFor(team: TeamState | null, name: string): Status | undefined {
  const byBot = team?.capabilityStatuses ?? {}
  let best: Status | undefined
  for (const statuses of Object.values(byBot)) {
    const status = statuses?.[name]
    if (status === undefined) continue
    if (best === undefined || (RANK[status.state ?? ''] ?? 0) > (RANK[best.state ?? ''] ?? 0)) best = status
  }
  return best
}
