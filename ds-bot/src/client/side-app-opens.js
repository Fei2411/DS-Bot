// Opens the host registered for this window: an `open_canvas` / `open_reader` call that
// just finished in a conversation the user is looking at. Each open is claimed once
// (`side-app-opened`), so a second window or a later poll never repeats it. An open for
// a conversation the window is not showing is left alone: it stays a card in that chat.
import { useEffect, useRef } from 'react'
import { call } from './api.js'
import { parseDescriptor } from './side-apps.js'

// The opens worth claiming now: the window is in front, and each belongs to the
// conversation in the main view (or the open panel's subject).
export function opensToClaim({ opens, current, hidden, claimed }) {
  if (hidden || current === null || opens === null || typeof opens !== 'object') return []
  const entry = opens[current]
  if (entry === undefined || typeof entry.openId !== 'string' || claimed.has(entry.openId)) return []
  const descriptor = parseDescriptor({ v: 1, ...entry })
  return descriptor === undefined ? [] : [{ openId: entry.openId, descriptor, sessionId: current }]
}

/**
 * Whether a claimed open may still open the panel: the window is in front and the
 * conversation it belongs to is still the one in the main view. The claim is a round trip,
 * and the user may have moved on while it was out; the open then stays a chat card.
 */
export const stillInFront = ({ sessionId, current, hidden }) => hidden !== true && current === sessionId

export function SideAppOpens({ useRoster, useSessions, actions }) {
  const opens = useRoster(state => state.sideAppOpens ?? null)
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const claimed = useRef(new Set())
  const front = useRef(current)
  front.current = current
  useEffect(() => {
    const hidden = typeof document !== 'undefined' && document.hidden === true
    for (const open of opensToClaim({ opens, current, hidden, claimed: claimed.current })) {
      claimed.current.add(open.openId)
      // The host drops the open when it is claimed, so claim first and open only if this
      // window got it and the user is still looking at that conversation.
      void call('side-app-opened', { openId: open.openId }).then((answer) => {
        if (answer?.consumed !== true) return undefined
        if (!stillInFront({ sessionId: open.sessionId, current: front.current, hidden: typeof document !== 'undefined' && document.hidden === true })) return undefined
        return actions.openSideApp(open.sessionId, open.descriptor, { auto: true })
      }).catch(error => actions.reportError?.(error, 'side-app-open'))
    }
  }, [opens, current])
  return null
}
