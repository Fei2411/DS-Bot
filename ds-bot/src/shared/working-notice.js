// One "started on it" row per working episode. A member called again in the same
// round, or a later round while it still works, must not add another; the row is
// cleared when the member reports (a post, a failure or an approval request), so a
// genuinely new episode is noted again.
export function createWorkingNotices({ ttlMs = 10 * 60_000 } = {}) {
  const seenAt = new Map()
  const keyOf = (roomId, botId) => `${roomId}:${botId}`
  return {
    seen(roomId, botId, now = Date.now()) {
      const at = seenAt.get(keyOf(roomId, botId))
      return at !== undefined && now - at <= ttlMs
    },
    note(roomId, botId, now = Date.now()) {
      seenAt.set(keyOf(roomId, botId), now)
    },
    clear(roomId, botId) {
      seenAt.delete(keyOf(roomId, botId))
    },
  }
}
