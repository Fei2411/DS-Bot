import { currentPart, turnOutlineOf } from './text.js'

export function watchBotCompletions({ roster, sessions, statuses, unread, ui }) {
  const seen = new Map()
  let lastTarget = null
  let pendingTarget = null
  const sync = () => {
    const team = roster.getSnapshot()
    const list = sessions.getSnapshot()
    const statusMap = statuses?.getSnapshot()
    const uiSnap = ui?.getSnapshot?.()
    const inboxOpen = uiSnap?.inbox === true
    const rawTarget = typeof uiSnap?.inboxTarget === 'string' && uiSnap.inboxTarget !== '' ? uiSnap.inboxTarget : null
    if (inboxOpen) {
      lastTarget = null
      pendingTarget = null
    } else if (rawTarget !== lastTarget) {
      lastTarget = rawTarget
      pendingTarget = rawTarget
    }
    if (pendingTarget !== null && (list.byId[pendingTarget]?.retainedBy?.mainView ?? 0) > 0) pendingTarget = null
    const previous = unread.getSnapshot()
    const next = {}
    const parts = new Set()
    for (const bot of team.bots) {
      const id = currentPart(bot)
      parts.add(id)
      const row = list.byId[id]
      const active = (row?.retainedBy?.mainView ?? 0) > 0 && !inboxOpen && (pendingTarget === null || pendingTarget === id)
      const status = statusMap?.get(id)
      const hidden = team.exchangeTurns?.[id] ?? []
      const outline = turnOutlineOf(list, id)
      if (!Array.isArray(outline)) {
        if (!active && (previous[id] === true || (!seen.has(id) && hidden.length === 0 && status?.completionUnread === true))) next[id] = true
        continue
      }
      const latest = outline.at(-1)
      const running = status?.running === true || row?.running === true
      const end = running && !latest?.response ? outline.length - 2 : outline.length - 1
      const closed = outline[end]?.turn ?? -1
      if (active) {
        seen.set(id, Math.max(seen.get(id) ?? -1, closed))
        continue
      }
      if (!seen.has(id)) {
        const unreadLatest = status?.completionUnread === true
          && end === outline.length - 1 && !hidden.includes(closed)
        seen.set(id, unreadLatest ? (outline[end - 1]?.turn ?? -1) : closed)
      }
      // DSH clears its flag when any new turn starts. Keep the read boundary
      // instead, so later private completions cannot erase an earlier reply.
      for (let i = end; i >= 0 && outline[i].turn > seen.get(id); i -= 1) {
        if (hidden.includes(outline[i].turn)) continue
        next[id] = true
        break
      }
    }
    for (const id of seen.keys()) if (!parts.has(id)) seen.delete(id)
    if (Object.keys(next).length !== Object.keys(previous).length || Object.keys(next).some(id => previous[id] !== true)) unread.set(next)
  }
  const offRoster = roster.subscribe(sync)
  const offSessions = sessions.subscribe(sync)
  const offStatus = statuses?.subscribe(sync)
  const offUi = ui?.subscribe?.(sync)
  sync()
  return () => { offRoster(); offSessions(); offStatus?.(); offUi?.() }
}
