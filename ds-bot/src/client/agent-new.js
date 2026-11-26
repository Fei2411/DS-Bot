// Until the DSH list catches up, the create result is the only record of
// the Session we just opened. Once listed, use DSH's blank flag.
export function agentSessionToReuse(list, latest, pending) {
  if (pending !== undefined && list.byId[pending] === undefined) return pending
  return latest !== undefined && list.byId[latest]?.blank === true ? latest : undefined
}

/**
 * Run one call per key at a time: a second caller while the first is in flight gets the
 * same promise instead of asking the host again (two clicks in one go made two
 * Sessions). The entry clears when the call settles, so the next click starts over.
 * @param {Map<string, Promise<unknown>>} map in-flight calls, by key
 * @param {string} key
 * @param {() => Promise<unknown>} run
 * @returns {Promise<unknown>}
 */
export function singleFlight(map, key, run) {
  const running = map.get(key)
  if (running !== undefined) return running
  const call = Promise.resolve().then(run)
  const tracked = call.finally(() => { if (map.get(key) === tracked) map.delete(key) })
  map.set(key, tracked)
  return tracked
}
