// Plain Enter on an empty composer while the Bot works submits nothing in the
// shell. DS Bot reads it as "steer my queued messages into the running turn" —
// the queue dock's steer button for every queued row at once (#839).

// The composer is empty and idle (no text, no attachments, plain editing phase).
export const emptyPlainDraft = input => input !== undefined
  && input.phase === 'plain'
  && input.draft.trim() === ''
  && input.attachmentIds.length === 0

// The composer can steer: idle draft, no text, no attachments, and at least one
// queued message of the user's own. Team deliveries and replies also sit in the
// queue and stay there.
export const steerable = input => emptyPlainDraft(input)
  && input.queue.some(message => message.source?.kind === 'user')

// Plain Enter steers queued user messages only when Enter-to-send is enabled.
export const enterSteers = (event, input, enterToSend = true) => enterToSend === true
  && event.key === 'Enter'
  && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  && !event.getModifierState?.('AltGraph')
  && !event.isComposing && event.keyCode !== 229 && !event.repeat
  && steerable(input)

// Empty-draft Cmd+Enter / Ctrl+Enter accelerator: DSH's built-in handler walks the
// entire `next-turn` queue (including Bot relays, task reports, and answer cards).
// Intercept it whenever an empty Bot composer has any queued items so only user
// messages can be promoted.
export const emptyAccelQueueKey = (event, input) => event.key === 'Enter'
  && (event.metaKey || event.ctrlKey)
  && !(event.metaKey && event.ctrlKey)
  && !event.shiftKey && !event.altKey
  && !event.getModifierState?.('AltGraph')
  && !event.isComposing && event.keyCode !== 229 && !event.repeat
  && emptyPlainDraft(input)
  && Array.isArray(input.queue) && input.queue.length > 0

// Steers the user's queued messages in FIFO order. When the host supports atomic
// batch steering (`steerBatch`), every queued user row moves together in one
// step so multiple messages never race or cascade-cut across per-row RPCs.
// Otherwise falls back to the queue dock's per-row steer verb; an Agent that
// stopped between read and steer (`session/steer-unavailable`) or a row it
// already claimed (`session/queue-item-not-found`) converges silently.
export const steerQueued = async (session, steerBatch) => {
  try {
    const queued = session.projections.faceOf('inbox').getSnapshot()?.['next-turn'] ?? []
    const userItems = queued.filter(item => item.source?.kind === 'user')
    if (userItems.length === 0) return 'done'
    if (typeof steerBatch === 'function') {
      const outcome = await steerBatch(userItems.map(item => item.id))
      if (outcome === 'done' || outcome === 'failed') return outcome
    }
    for (const item of userItems) {
      const result = await session.updateQueue(item.id, { kind: 'steer' })
      if (result.ok) continue
      return result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found' ? 'done' : 'failed'
    }
    return 'done'
  } catch {
    return 'failed'
  }
}
