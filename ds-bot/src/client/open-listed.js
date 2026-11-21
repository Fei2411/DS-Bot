// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation — through here or
// elsewhere — drops the wait. `begin`/`done` report that wait, so the caller can show the
// Session it asked for instead of leaving the previous one on screen.
// A Session that never arrives ends the wait as a failure instead of covering the
// conversation forever: the roster already knows its Bot lost it, or the wait runs past
// `waitMs`. `fail` gets the target, so the caller can offer a way out of it.

// Long enough for a Session the Host just made to reach the shell's list (a refresh or
// two), short enough that a Session gone from the library does not read as still opening.
export const OPENING_FAIL_MS = 10_000

export function listedOpener({ list, open, refresh, current, begin, done, fail, gone, waitMs = OPENING_FAIL_MS, schedule = setTimeout, clear = clearTimeout }) {
  let drop = () => {}
  return (target) => {
    drop()
    drop = () => {}
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    if (listed()) { open(target); return }
    const from = current?.()
    begin?.(target)
    let waiting = true
    let failed = false
    let timer
    let off = () => {}
    const stop = () => {
      off()
      if (timer !== undefined) { clear(timer); timer = undefined }
    }
    // Every wait ends once: opened, failed, or taken over by a newer navigation. A
    // failed wait leaves the caller's card up until the next navigation lifts it.
    const end = (asFailure) => {
      if (!waiting) return false
      waiting = false
      stop()
      if (asFailure) { failed = true; fail?.(target) } else done?.(target)
      return true
    }
    drop = () => {
      if (waiting) end(false)
      else if (failed) { failed = false; done?.(target) }
    }
    off = list.subscribe(() => {
      if (current?.() !== from) { end(false); return }
      if (!listed()) return
      end(false)
      open(target)
    })
    if (gone?.(target) === true) { end(true); return }
    timer = schedule(() => {
      if (!waiting || listed()) return
      end(true)
    }, waitMs)
    refresh?.()
  }
}
