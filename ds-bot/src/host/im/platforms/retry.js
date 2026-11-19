// Waits between attempts to open an IM connection when the network is down (#1119).
// The first wait is short so a brief drop recovers quickly; it grows to a cap and
// repeats, so a long outage is retried at a steady pace instead of a request loop.
export const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000, 30_000]

export const retryDelay = attempt => RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)]

// A wait a stopped adapter leaves behind: it does not hold the process, and every
// retry loop checks `stopped` once it returns.
export const retryWait = ms => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})
