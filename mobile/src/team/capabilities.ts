/**
 * Capability statuses as the computer sends them with a `state` answer
 * (ds-bot/src/host/capabilities.js, `capabilityStatusesView`): one map per Bot id,
 * then the capability name, then its status. The phone drew `statuses[item.name]`
 * off the outer object, so it never found the Bot's layer and no status ever showed
 * (#1523). The desktop reads the same answer as `capabilityStatuses?.[bot.id]`.
 */
export interface CapabilityStatus { state?: string; error?: string }

export type CapabilityStatuses = Record<string, CapabilityStatus>

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The statuses of one Bot out of `state.capabilityStatuses`. A missing Bot layer, an
 * empty one, or an answer of another shape gives no entries — every capability is
 * then unknown — instead of a value keyed by a Bot id.
 */
export function capabilityStatusesFor(view: unknown, botId: string | null | undefined): CapabilityStatuses {
  const layers = isObject(view) ? view : {}
  const layer = typeof botId === 'string' && botId !== '' ? layers[botId] : undefined
  if (!isObject(layer)) return {}
  const statuses: CapabilityStatuses = {}
  for (const [name, status] of Object.entries(layer)) {
    // The host writes only objects here; anything else is not a status.
    if (isObject(status)) statuses[name] = status
  }
  return statuses
}

/** One capability's status for one Bot. `undefined` means the phone knows no state. */
export function capabilityStatusOf(view: unknown, botId: string | null | undefined, name: string): CapabilityStatus | undefined {
  const statuses = capabilityStatusesFor(view, botId)
  return Object.hasOwn(statuses, name) ? statuses[name] : undefined
}
