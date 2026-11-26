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
  let waitingTarget = null
  return (target) => {
    // Re-requesting the Session we are already waiting for keeps the wait and its
    // cover steady instead of tearing them down and flashing them back in. Once a wait
    // has failed, `waitingTarget` is cleared so clicking the same target retries.
    if (waitingTarget === target) return
    drop()
    drop = () => {}
    if (current?.() === target) return
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    if (listed()) { open(target); return }
    const from = current?.()
    waitingTarget = target
    begin?.(target)
    let state = 'waiting'
    let timer
    let off = () => {}
    const clearTimer = () => {
      if (timer !== undefined) { clear(timer); timer = undefined }
    }
    const unsubscribe = () => {
      const fn = off
      off = () => {}
      fn()
    }
    // Every wait settles once: opened, dismissed by another navigation (through here or
    // via the native shell), or taken over by a newer wait. Entering the failed state stops
    // the deadline timer and clears `waitingTarget` (so clicking the same target retries),
    // while keeping the list listener so external navigation lifts the cover and a Session
    // that arrives late still opens.
    const settle = () => {
      if (state === 'settled') return false
      state = 'settled'
      if (waitingTarget === target) waitingTarget = null
      drop = () => {}
      clearTimer()
      unsubscribe()
      done?.(target)
      return true
    }
    const failWait = (reason) => {
      if (state !== 'waiting') return false
      state = 'failed'
      if (waitingTarget === target) waitingTarget = null
      clearTimer()
      fail?.(target, reason)
      return true
    }
    drop = () => { settle() }
    off = list.subscribe(() => {
      const now = current?.()
      if (now === target) { settle(); return }
      // Clearing `from` (e.g. an archived earlier part during a part switch) is not a
      // navigation elsewhere; only landing on another real Session drops the wait.
      if (now !== undefined && now !== from) { settle(); return }
      if (!listed()) return
      if (settle()) open(target)
    })
    if (gone?.(target) === true) { failWait('missing'); return }
    timer = schedule(() => {
      if (state !== 'waiting' || listed()) return
      failWait('timeout')
    }, waitMs)
    refresh?.()
  }
}
