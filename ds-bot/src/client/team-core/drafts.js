// Shared draft attachment pool, failed-send recovery state, and removed-chat
// draft cleanup shared by both hosts.
import { pruneDrafts } from '../draft-keep.js'
import { registerReloadGuard } from '../reload-action.js'

// Failed sends held per chat when a send rejects while the user is already typing
// or after switching away to another chat. Keeps their preview URLs alive until
// retried, restored into the composer, dismissed, or the owning chat is deleted.
export const pendingFailedByChat = new Map()
export const heldFailedUrls = new Set()
export const inFlightUrls = new Set()

/**
 * Whether any chat's failed-send recovery bar currently holds unsent attachments
 * in memory that a full window reload would discard.
 * @returns {boolean}
 */
export function hasPendingFailedAttachments() {
  for (const list of pendingFailedByChat.values()) {
    for (const entry of list ?? []) {
      if (Array.isArray(entry?.items) && entry.items.length > 0) return true
    }
  }
  return false
}

// Guard full window reloads whenever failed sends still hold in-memory attachments,
// even if the composer itself is empty (`hasKeptDraftFiles() === false`).
registerReloadGuard(hasPendingFailedAttachments)

export function revokeUrl(url) {
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

export function trackFailedUrls(items, hold) {
  for (const item of items ?? []) {
    if (!item?.previewUrl) continue
    if (hold) heldFailedUrls.add(item.previewUrl)
    else heldFailedUrls.delete(item.previewUrl)
  }
}

export function trackInFlightUrls(items, hold) {
  for (const item of items ?? []) {
    if (!item?.previewUrl) continue
    if (hold) inFlightUrls.add(item.previewUrl)
    else inFlightUrls.delete(item.previewUrl)
  }
}

export function pruneFailedSends(chatIds) {
  for (const chatId of chatIds ?? []) {
    const list = pendingFailedByChat.get(chatId)
    if (!list) continue
    pendingFailedByChat.delete(chatId)
    for (const entry of list) {
      for (const item of entry.items ?? []) {
        if (!item?.previewUrl) continue
        heldFailedUrls.delete(item.previewUrl)
        if (!inFlightUrls.has(item.previewUrl)) revokeUrl(item.previewUrl)
      }
    }
  }
}

export function clearFailedSends() {
  for (const list of pendingFailedByChat.values()) {
    for (const entry of list) {
      for (const item of entry.items ?? []) {
        if (item?.previewUrl) {
          heldFailedUrls.delete(item.previewUrl)
          revokeUrl(item.previewUrl)
        }
      }
    }
  }
  pendingFailedByChat.clear()
  heldFailedUrls.clear()
  inFlightUrls.clear()
}

// Standalone in-memory draft file store matching DSH's conversation draft-file intake.
export function createDraftFiles() {
  const store = new Map()
  let seq = 0
  return {
    draftFiles: (ids) => {
      if (!Array.isArray(ids) || ids.length === 0) return []
      const out = []
      for (const id of ids) {
        const entry = store.get(id)
        if (entry) out.push({ kind: entry.kind, file: entry.file })
      }
      return out
    },
    restoreDraftFiles: (sessionId, files) => {
      if (!Array.isArray(files) || files.length === 0) return []
      const ids = []
      for (const item of files) {
        if (!item || typeof item !== 'object') continue
        const isWrapper = item.file && typeof item.file === 'object'
        const file = isWrapper ? item.file : item
        if (typeof file.name !== 'string' && typeof file.size !== 'number' && typeof file.type !== 'string') continue
        const mime = typeof file.type === 'string' ? file.type : ''
        const kind = isWrapper && typeof item.kind === 'string'
          ? item.kind
          : (mime.startsWith('image/') ? 'image' : 'file')
        const id = `draft-file-${++seq}`
        store.set(id, { sessionId: sessionId ?? null, kind, file })
        ids.push(id)
      }
      return ids
    },
    releaseDraftFiles: (ids) => {
      if (!Array.isArray(ids)) return
      for (const id of ids) store.delete(id)
    },
    pruneBySessions: (keep) => {
      for (const [fileId, entry] of store.entries()) {
        if (entry?.sessionId && !keep(entry.sessionId)) store.delete(fileId)
      }
    },
  }
}

// Prune kept text drafts, rescued question drafts, and failed sends for removed chats.
export function pruneRemovedChatDrafts(gone, questionDrafts, { storage = globalThis.localStorage } = {}) {
  if (!Array.isArray(gone) || gone.length === 0) return
  questionDrafts?.pruneChats(gone)
  pruneDrafts(gone, storage)
  pruneFailedSends(gone)
}
