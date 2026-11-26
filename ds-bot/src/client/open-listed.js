// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation — through here or
// elsewhere — drops the wait. `begin`/`done` report that wait, so the caller can show the
// Session it asked for instead of leaving the previous one on screen.
export function listedOpener({ list, open, refresh, current, begin, done }) {
  let drop = () => {}
  let waitingTarget = null
  return (target) => {
    // Re-requesting the Session we are already waiting for keeps the wait and its
    // cover steady instead of tearing them down and flashing them back in.
    if (waitingTarget === target) return
    drop()
    drop = () => {}
    if (current?.() === target) return
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    if (listed()) { open(target); return }
    const from = current?.()
    waitingTarget = target
    begin?.(target)
    let waiting = true
    // The wait ends either way: it opened, or a newer navigation took it over.
    const settle = () => {
      if (!waiting) return
      waiting = false
      waitingTarget = null
      drop = () => {}
      done?.(target)
    }
    const off = list.subscribe(() => {
      const now = current?.()
      if (now === target) { off(); settle(); return }
      // Clearing `from` (e.g. an archived earlier part during a part switch) is not a
      // navigation elsewhere; only landing on another real Session drops the wait.
      if (now !== undefined && now !== from) { off(); settle(); return }
      if (!listed()) return
      off()
      settle()
      open(target)
    })
    drop = () => { off(); settle() }
    refresh?.()
  }
}
