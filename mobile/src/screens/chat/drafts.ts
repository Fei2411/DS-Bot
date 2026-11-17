import type { Photo } from './composer.tsx'

// An unsent draft belongs to its chat: switching to another chat and back keeps the
// text and the picked photos, and sending or clearing the box leaves nothing behind
// (#1248). The map lives for the app run; a killed app starts empty.
export interface ComposerDraft { text: string; photos: Photo[] }

const drafts = new Map<string, ComposerDraft>()

export function readDraft(chatKey: string): ComposerDraft | undefined {
  const draft = drafts.get(chatKey)
  return draft === undefined ? undefined : { text: draft.text, photos: [...draft.photos] }
}

export function writeDraft(chatKey: string, draft: ComposerDraft): void {
  if (draft.text === '' && draft.photos.length === 0) {
    drafts.delete(chatKey)
    return
  }
  drafts.set(chatKey, { text: draft.text, photos: [...draft.photos] })
}
