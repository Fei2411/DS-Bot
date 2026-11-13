// Notifications for a window the user is not looking at (#1504): which events deserve
// one, what it may say, and the switches that keep it quiet. The shell decides whether
// the window is in front; this decides whether the event is the user's to see.

/** The stored switches: notifications on, and the conversations kept quiet. */
export const NOTIFY_KEY = 'ds-bot:notify'

/**
 * Whether a session status change deserves a notification.
 * @param {object} state
 * @param {{ running?: boolean, completionUnread?: boolean, pendingInteraction?: unknown }} [state.before]
 * @param {{ running?: boolean, completionUnread?: boolean, pendingInteraction?: unknown }} [state.after]
 * @param {boolean} state.viewing is the user looking at this conversation right now
 * @param {boolean} state.focused is the window in front
 * @param {boolean} state.enabled the global switch
 * @param {boolean} state.muted this conversation is muted
 * @param {boolean} state.group is this a group chat
 * @returns {'reply' | 'question' | undefined} what to say, or undefined for nothing
 */
export function notifyKind({ before, after, viewing, focused, enabled, muted, group }) {
  if (enabled !== true || muted === true) return undefined
  // The user is looking at this conversation in a focused window: the screen already says it.
  if (viewing === true && focused === true) return undefined
  const wasPending = before?.pendingInteraction !== undefined
  const isPending = after?.pendingInteraction !== undefined
  if (isPending && !wasPending) return 'question'
  // A group says nothing for an ordinary reply: only what waits on the user is worth a
  // system notification there. @-mentions are #945's, later on this same channel.
  if (group === true) return undefined
  if (after?.completionUnread === true && before?.completionUnread !== true) return 'reply'
  return undefined
}

/**
 * What a notification may say: the conversation's name and one short line. The body goes
 * to a lock screen, so it never carries the message itself (#1504).
 * @param {{ title: string, kind: 'reply' | 'question' }} notice
 * @returns {{ title: string, body: string }}
 */
export function noticeText({ title, kind }) {
  const name = String(title ?? '').trim().slice(0, 60)
  const body = kind === 'question' ? 'Waiting for your answer' : 'A new reply is waiting'
  return { title: name === '' ? 'DS Bot' : name, body }
}

/**
 * The switches as stored, with the defaults: on, nothing muted.
 * @param {string | null} raw what localStorage holds
 * @returns {{ enabled: boolean, muted: Record<string, true> }}
 */
export function readNotifyPrefs(raw) {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value === null || typeof value !== 'object') return { enabled: true, muted: {} }
    const muted = value.muted !== null && typeof value.muted === 'object' ? Object.fromEntries(Object.entries(value.muted).filter(([, on]) => on === true)) : {}
    return { enabled: value.enabled !== false, muted }
  } catch {
    return { enabled: true, muted: {} }
  }
}

/**
 * The switches to store after one change.
 * @param {{ enabled: boolean, muted: Record<string, true> }} prefs
 * @param {{ enabled?: boolean, mute?: { id: string, on: boolean } }} change
 * @returns {{ enabled: boolean, muted: Record<string, true> }}
 */
export function writeNotifyPrefs(prefs, change) {
  const enabled = typeof change.enabled === 'boolean' ? change.enabled : prefs.enabled
  const muted = { ...prefs.muted }
  if (change.mute !== undefined) {
    if (change.mute.on === true) muted[change.mute.id] = true
    else delete muted[change.mute.id]
  }
  return { enabled, muted }
}

/**
 * How many conversations carry something new, for the dock badge: unread replies and
 * cards waiting on the user.
 * @param {Array<{ unread?: boolean, pending?: boolean }>} rows
 * @returns {number}
 */
export function badgeOf(rows) {
  let count = 0
  for (const row of rows ?? []) if (row.unread === true || row.pending === true) count += 1
  return count
}
