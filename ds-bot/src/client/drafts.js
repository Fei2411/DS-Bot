// -------------------------------------------------------------------------
// The draft each chat holds while its composer is off the screen (#1248). Kept in
// memory only, like the phone's kept pages: a reload drops it (DSH's own store
// carries the text across one), and a chat with nothing in the box keeps nothing.
// Attachment ids are runtime-only (DSH keeps the files with their input), so a
// return restores the text and says so about the files rather than dropping them
// silently.

const KEPT = 32
const drafts = new Map()

// The chat's draft as its composer last showed it. An empty box deletes the entry,
// so a draft the user sent does not come back.
export function keepDraft(sessionId, snapshot) {
  const draft = typeof snapshot?.draft === 'string' ? snapshot.draft : ''
  const attachmentIds = Array.isArray(snapshot?.attachmentIds) ? snapshot.attachmentIds.filter(id => typeof id === 'string' && id !== '') : []
  if (draft === '' && attachmentIds.length === 0) { drafts.delete(sessionId); return }
  drafts.delete(sessionId)
  drafts.set(sessionId, { draft, attachmentIds })
  if (drafts.size > KEPT) drafts.delete(drafts.keys().next().value)
}

// The draft the chat kept, or undefined while it has none.
export function keptDraft(sessionId) {
  return drafts.get(sessionId)
}

// A kept draft is consumed on its one restore attempt, so a notice never repeats.
export function dropDraft(sessionId) {
  drafts.delete(sessionId)
}
