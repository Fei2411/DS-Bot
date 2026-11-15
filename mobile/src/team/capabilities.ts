import type { CapabilityItem, CapabilityStatus } from '../connection.ts'

export type CapabilityStatuses = Record<string, Record<string, CapabilityStatus> | CapabilityStatus>

const STATE_RANK: Record<string, number> = {
  error: 4,
  'needs-approval': 3,
  connecting: 2,
  ready: 1,
}

const isStatus = (value: unknown): value is CapabilityStatus =>
  value !== null && typeof value === 'object' && typeof (value as CapabilityStatus).state === 'string'

function pickHigher(best: CapabilityStatus | undefined, next: CapabilityStatus | undefined): CapabilityStatus | undefined {
  if (next === undefined || typeof next.state !== 'string') return best
  if (best === undefined || typeof best.state !== 'string') return next
  return (STATE_RANK[next.state] ?? 0) > (STATE_RANK[best.state] ?? 0) ? next : best
}

// Resolve a capability's overall status from either per-bot maps
// (`capabilityStatuses[botId][name]`) or a flat map (`capabilityStatuses[name]`).
export function capabilityStatusFor(
  statuses: CapabilityStatuses | null | undefined,
  name: string,
  options?: { bots?: { id: string }[]; item?: Pick<CapabilityItem, 'approved' | 'status'> },
): CapabilityStatus | undefined {
  let best: CapabilityStatus | undefined
  if (statuses !== null && statuses !== undefined && name !== '') {
    const direct = statuses[name]
    if (isStatus(direct)) best = pickHigher(best, direct)

    const seen = new Set<string>()
    for (const bot of options?.bots ?? []) {
      if (!bot?.id) continue
      seen.add(bot.id)
      const map = statuses[bot.id]
      if (map !== null && typeof map === 'object' && !isStatus(map)) {
        best = pickHigher(best, isStatus(map[name]) ? map[name] : undefined)
      }
    }
    for (const [key, map] of Object.entries(statuses)) {
      if (seen.has(key) || map === null || typeof map !== 'object' || isStatus(map)) continue
      best = pickHigher(best, isStatus(map[name]) ? map[name] : undefined)
    }
  }
  if (best === undefined && (options?.item?.approved === false || options?.item?.status === 'needs-approval')) {
    return { state: 'needs-approval' }
  }
  return best
}

// Host `capability-approve` approves only stdio MCP servers by name, never packs.
export function unapprovedCapabilitiesFor(
  items: CapabilityItem[],
  statuses: CapabilityStatuses | null | undefined,
  item: CapabilityItem,
  bots?: { id: string }[],
): string[] {
  if (item.kind === 'mcp' && item.transport === 'stdio') {
    return capabilityStatusFor(statuses, item.name, { bots, item })?.state === 'needs-approval' ? [item.name] : []
  }
  if (item.kind !== 'pack') return []
  const byName = new Map(items.map(entry => [entry.name, entry]))
  const targets: string[] = []
  const seen = new Set<string>()
  for (const childName of item.items ?? []) {
    if (seen.has(childName)) continue
    seen.add(childName)
    const child = byName.get(childName)
    if (child?.kind !== 'mcp' || child.transport !== 'stdio') continue
    if (child.approved === false || capabilityStatusFor(statuses, child.name, { bots, item: child })?.state === 'needs-approval') {
      targets.push(child.name)
    }
  }
  return targets
}
