// "+ New session" on the DSH Agent opens a Session that is already there when it is
// still unused: the Agent's latest blank one, or one this window created whose entry the
// shell's Session list has not shown yet (#1225). Without that, the shell's blank flag
// alone decides, and a Session created a moment ago — not in the list yet, or carrying
// bootstrap events of its own — does not count as blank there, so every click made
// another empty Session.

/**
 * The Session "+ new session" should open instead of creating one.
 * @param {object} state
 * @param {string} [state.draft] the Session this window created and has not seen used
 * @param {{blank?: boolean}} [state.draftRow] that Session's entry in the shell's list
 * @param {string} [state.latest] the Agent's newest Session, as the shell lists them
 * @param {{blank?: boolean}} [state.latestRow] that Session's entry
 * @returns {string | undefined} the Session to open, or undefined to create one
 */
export function agentSessionToReuse({ draft, draftRow, latest, latestRow }) {
  if (draft !== undefined) {
    // Missing from the list, or still blank: it is the new conversation the user wants.
    if (draftRow === undefined) return draft
    if (draftRow.blank === true) return draft
    // A shell that counts a Session's own bootstrap events as content never calls an
    // untouched one blank. A Session with no title has had no turn yet, so it is still
    // the conversation a new click starts (#1225).
    return sessionTitled(draftRow) ? undefined : draft
  }
  return latest !== undefined && latestRow?.blank === true ? latest : undefined
}

// Whether the shell has named the Session, which it does once the first turn runs.
const sessionTitled = row => {
  const title = row?.displayTitle ?? row?.title
  return typeof title === 'string' && title.trim() !== ''
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
