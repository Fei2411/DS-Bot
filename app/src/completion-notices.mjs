// What each Host event kind says in the notification body. Kinds come from the Host
// plugin; the bodies never quote task content.
const BODIES = {
  completion: 'Task completed',
  approval: 'Waiting for your approval',
  question: 'Waiting for your answer',
  view: 'A view waits for your answer',
  secret: 'Waiting for a secret',
  failure: 'The task failed',
}

export function completionNotices({ Notification, window, open, navigate }) {
  const shown = new Set()
  const live = new Set()
  let current = null
  return {
    supported: () => Notification.isSupported(),
    current: id => { current = id },
    show(event) {
      if (shown.has(event.id)) return false
      shown.add(event.id)
      if (shown.size > 500) shown.delete(shown.values().next().value)
      const win = window()
      if (win && win.isVisible() && win.isFocused() && current === event.sessionId) return false
      if (!Notification.isSupported()) return false
      const note = new Notification({ title: event.name, body: BODIES[event.kind] ?? BODIES.completion, silent: false })
      live.add(note)
      note.on('click', () => { open(); navigate(event.roomId ?? event.botId) })
      note.on('close', () => live.delete(note))
      note.on('failed', () => live.delete(note))
      note.show()
      return true
    },
  }
}
