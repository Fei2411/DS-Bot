// A round's result names where its rows start in the group's book of the ledger, and the
// round itself runs on after the call returns. A test waits for the group to go quiet and
// reads the rows the way the group chat does.
const roomOf = (rt, sessionId) => rt.roomOf(sessionId)?.id ?? sessionId
export const withRows = (rt, sessionId, result) => (Number.isInteger(result?.from)
  ? { ...result, replies: rt.groupRows(roomOf(rt, sessionId), result.from, result.to) }
  : result)
const busy = (rt, roomId) => [...rt.roomProgress.values()].some(round => round.roomId === roomId)
// These tests freeze only setTimeout. A one-shot interval stays a real event-loop turn,
// so timer and threadpool work can finish instead of being starved by setImmediate.
export const loopTurn = () => new Promise((resolve) => {
  const timer = setInterval(() => { clearInterval(timer); resolve() }, 1)
})
// Awaits a group_relay + afterRound promise with a real-clock safety bound that ignores
// mocked setTimeout (tests often mock setTimeout to drive group timers).
export function waitForRound(promise, ms = 15_000) {
  let settled = false
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms
    const guard = setInterval(() => {
      if (Date.now() < deadline) return
      clearInterval(guard)
      if (!settled) {
        settled = true
        reject(new Error(`round did not finish within ${ms}ms`))
      }
    }, 50)
    guard.unref?.()
    promise.then(
      (value) => {
        clearInterval(guard)
        if (!settled) { settled = true; resolve(value) }
      },
      (error) => {
        clearInterval(guard)
        if (!settled) { settled = true; reject(error) }
      },
    )
  })
}
export async function afterRound(rt, sessionId, value) {
  const result = JSON.parse(value)
  const roomId = roomOf(rt, sessionId)
  // Rounds run on their own: wait until the group's rounds are all the way done, and for
  // any round one of them opened.
  while (busy(rt, roomId) || rt.roomRounds(roomId).length > 0) {
    await Promise.all(rt.roomRounds(roomId))
    await loopTurn()
  }
  const round = rt.ledger.records(`group-${roomId}`).filter(record => record.event === 'round' && record.to >= result.from - 1).at(-1)
  return { ...withRows(rt, sessionId, result), ...(round === undefined ? {} : { passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) }) }
}
