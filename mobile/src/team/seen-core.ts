// Read marks belong to one computer: the same Bot id on another paired
// computer is a different conversation.
export function seenKey(hostDeviceId: string): string {
  return `dsbot.seenAt.${hostDeviceId}`
}

export function parseSeen(text: string | null): Record<string, number> {
  if (text === null) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
    }
    return out
  } catch {
    return {}
  }
}
