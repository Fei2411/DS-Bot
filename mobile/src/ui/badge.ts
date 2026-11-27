import { avatarBadge } from '../../../ds-bot/src/client/mark-states.js'

// A Bot avatar wears one badge at a time, derived from the same state rule as the desktop
// (mark-states.js avatarBadge): waiting for you > working > Main Bot star.
export type Badge = 'alert' | 'working' | 'main' | null

export function badgeOf({ state, waiting = false, working = false, main = false, badge = true }: {
  state?: string
  waiting?: boolean
  working?: boolean
  main?: boolean
  badge?: boolean
}): Badge {
  const effective = state ?? (waiting ? 'alert' : working ? 'working' : 'idle')
  const kind = avatarBadge(effective, { main, badge })
  return kind === 'admin' ? null : (kind as Badge)
}
