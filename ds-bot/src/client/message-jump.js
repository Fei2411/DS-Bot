const HIGHLIGHT_MS = 1800
const HIGHLIGHT_CLASS = 'bt-message-jump'

export const messageJumpTarget = (sessionId, target) => Number.isInteger(target?.turn)
  ? { sessionId, turn: target.turn, snippet: target.snippet, synthetic: target.synthetic === true, role: target.role }
  : null

export const messageAnchor = (sessionId, turn, role) => sessionId !== undefined
  ? { 'data-bt-message-session': sessionId, 'data-bt-message-turn': Number.isInteger(turn) ? turn : undefined, 'data-bt-message-role': role }
  : undefined

const normalized = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

export function findMessageRow(root, { sessionId, turn, snippet, synthetic, role }, allowFallback = true) {
  const selector = synthetic ? '[data-bt-message-session]' : `[data-bt-message-turn="${turn}"]`
  const rows = [...(root?.querySelectorAll(selector) ?? [])]
    .filter(row => row.getAttribute('data-bt-message-session') === sessionId)
  const match = normalized(snippet).replace(/^…/, '')
  const matches = match ? rows.filter(row => normalized(row.textContent).includes(match)) : []
  const preferred = role === undefined ? matches : matches.filter(row => row.getAttribute('data-bt-message-role') === role)
  if (synthetic) return preferred.length === 1 ? preferred[0] : undefined
  return preferred[0] ?? (allowFallback ? (matches[0] ?? rows[0]) : undefined)
}

const highlights = new WeakMap()

export function highlightMessage(row) {
  highlights.get(row)?.()
  row.scrollIntoView({ block: 'center', behavior: 'instant' })
  row.classList.add(HIGHLIGHT_CLASS)
  const clear = () => {
    clearTimeout(timer)
    row.classList.remove(HIGHLIGHT_CLASS)
    highlights.delete(row)
  }
  const timer = setTimeout(clear, HIGHLIGHT_MS)
  highlights.set(row, clear)
}

export function jumpToMountedMessage(root, target, currentSession, isCurrent) {
  const started = Date.now()
  const find = () => {
    if (!isCurrent() || Date.now() - started >= 2000) return
    const row = currentSession() === target.sessionId ? findMessageRow(root, target) : undefined
    if (row) highlightMessage(row)
    else setTimeout(find, 50)
  }
  setTimeout(find, 0)
}

export function messageJumpStep({ row, waiting, failed, cursor }, triedCursors) {
  if (row) return 'found'
  if (waiting) return 'wait'
  if (failed || cursor == null || triedCursors.has(cursor)) return 'stop'
  return 'load'
}
