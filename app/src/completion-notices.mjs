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
      const note = new Notification({ title: event.name, body: 'Task completed', silent: false })
      live.add(note)
      note.on('click', () => { open(); navigate(event.botId) })
      note.on('close', () => live.delete(note))
      note.on('failed', () => live.delete(note))
      note.show()
      return true
    },
  }
}
