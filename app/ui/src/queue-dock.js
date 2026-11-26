// Desktop adapter over DS Bot's shared `QueueDockPresenter` (`ds-bot/src/client/queue-dock.js`).
// Adapts live `sessionQueues` + `/api/bot` image preview + withdraw-to-composer into the
// same presenter used by DSH Web plugin mode so defaults, labels, and Escape handling stay aligned.
import { createElement as h, useCallback, useMemo } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { OWN_QUEUE_KINDS, QueueDockPresenter, queueRowText } from '../../../ds-bot/src/client/queue-dock.js'

export { queueRowText }

const EMPTY_ROWS = Object.freeze([])

export function DesktopQueueDock({
  sessionId,
  running = false,
  readOnly = false,
  useSessionQueues,
  pendingQueue = EMPTY_ROWS,
  actions,
  onWithdraw,
  classic = false,
}) {
  const rawQueue = useSessionQueues?.(map => map?.[sessionId] ?? EMPTY_ROWS) ?? EMPTY_ROWS
  const queue = useMemo(
    () => rawQueue.filter(row => row && typeof row.id === 'string' && OWN_QUEUE_KINDS.has(row.source?.kind)),
    [rawQueue],
  )

  const updateQueue = useCallback(async (itemId, action) => {
    const wireAction = action?.kind === 'edit'
      ? { kind: 'edit', text: queueRowText(action.content) }
      : action
    const res = await actions.updateSessionQueue(sessionId, itemId, wireAction)
    if (res?.accepted === false) {
      return { ok: false, error: { code: res.code ?? 'session/queue-item-not-found' } }
    }
    return { ok: true, accepted: res?.accepted !== false }
  }, [actions, sessionId])

  const loadImage = useCallback(async (attachment) => {
    const id = attachment?.attachmentId
    if (!sessionId || !id) return null
    const res = await call('image', { sessionId, attachmentId: id, preview: true })
    return res?.mime && res?.data ? `data:${res.mime};base64,${res.data}` : null
  }, [sessionId])

  return h(QueueDockPresenter, {
    queue,
    pendingQueue,
    running,
    queueMutable: !readOnly,
    updateQueue,
    loadImage,
    actions,
    onWithdraw,
    className: classic ? 'bt-queue-dock dsb-queue-dock dsb-queue-classic' : 'bt-queue-dock dsb-queue-dock',
    actionsClassName: 'bt-queue-actions dsb-queue-actions',
  })
}
