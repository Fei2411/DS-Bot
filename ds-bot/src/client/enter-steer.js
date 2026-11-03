// Plain Enter on an empty composer while the Bot works submits nothing in the
// shell. DS Bot reads it as "steer my queued messages into the running turn" —
// the queue dock's steer button for every queued row at once (#839).

// The composer can steer: idle draft, no text, no attachments, and at least one
// queued message of the user's own. Team deliveries and replies also sit in the
// queue and stay there.
export const steerable = input => input !== undefined
  && input.phase === 'plain'
  && input.draft.trim() === ''
  && input.attachmentIds.length === 0
  && input.queue.some(message => message.source?.kind === 'user')

export const enterSteers = (event, input) => event.key === 'Enter'
  && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  && !event.getModifierState?.('AltGraph')
  && !event.isComposing && event.keyCode !== 229 && !event.repeat
  && steerable(input)

// Steers the user's queued messages in FIFO order, like the queue dock's steer
// button per row. An Agent that stopped between read and steer
// (session/steer-unavailable) or a row it already claimed
// (session/queue-item-not-found) converges silently; anything else reports.
export const steerQueued = async (session) => {
  try {
    const queued = session.projections.faceOf('inbox').getSnapshot()?.['next-turn'] ?? []
    for (const item of queued) {
      if (item.source?.kind !== 'user') continue
      const result = await session.updateQueue(item.id, { kind: 'steer' })
      if (result.ok) continue
      return result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found' ? 'done' : 'failed'
    }
    return 'done'
  } catch {
    return 'failed'
  }
}
