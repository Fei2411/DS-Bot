// The client's idle cost, in one place: how often it asks the host for the team, and
// whether the desktop app has to read the OS idle time right now (#1462). Both used to
// run at a fixed cadence while the window sat still — a state request every 1.5 s and an
// idle-time read plus a host call every 2 s — so an idle window kept the renderer
// serialising values over IPC for nothing.

/**
 * The longest wait between two state requests while nothing changes. Kept short because
 * the same poll carries cards and approvals: a window that sits still should not pay 1.5 s
 * for them, but nothing may appear minutes late either.
 */
export const POLL_MAX_MS = 5_000

/**
 * How long to wait before asking the host again.
 * @param {number} base the cadence while something is changing (1.5 s visible, 10 s hidden)
 * @param {number} unchanged how many answers in a row said nothing changed
 * @returns {number} milliseconds to wait
 */
export function pollDelay(base, unchanged) {
  const steps = Math.min(Math.max(unchanged, 0), 8)
  return Math.min(base * 2 ** steps, Math.max(base, POLL_MAX_MS))
}

/**
 * Whether the desktop app must read the OS idle time now: only a Bot waiting for the
 * user to step away needs it, so nothing is read while no Bot waits.
 * @param {{bots?: Record<string, {waitingFor?: string}>}} computer the computer source
 * @returns {boolean}
 */
export function needsIdleSample(computer) {
  return Object.values(computer?.bots ?? {}).some(entry => entry?.waitingFor === 'user-idle')
}
