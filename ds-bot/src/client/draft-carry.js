// A Bot's chat is a chain of Sessions ("parts"), and the shell keeps an unsent draft
// under the part it was typed in. When the chat moves on to a fresh part while nobody
// looks (a context switch while idle), the new part's composer starts empty and the
// draft looks lost. Keep the latest draft per Bot; the current part takes it back.
// A staged image's preview belongs to the part that ends, so only its count comes
// along, to tell the user it could not be kept.
import { STORAGE } from './storage.js'

const KEY = STORAGE.drafts

const readStoredDrafts = (storage) => {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const writeStoredDrafts = (storage, value) => {
  try { storage?.setItem(KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const entryOf = value => value !== null && typeof value === 'object'
  && typeof value.part === 'string' && typeof value.text === 'string'
  && Number.isInteger(value.attachments) && value.attachments >= 0

/**
 * Remember the draft of a Bot's current part. A part the user merely opened earlier
 * is not the current one and keeps its own draft; `currentPart` says which is current.
 * @param {{ botId: string, part: string, currentPart: string, text: string, attachments: number }} draft
 * @param {Storage} [storage]
 */
export function keepCarriedDraft({ botId, part, currentPart, text, attachments }, storage = globalThis.localStorage) {
  if (typeof botId !== 'string' || botId === '' || typeof part !== 'string' || part === '' || part !== currentPart) return
  const value = readStoredDrafts(storage)
  const before = value[botId]
  if (text === '' && attachments === 0) {
    if (before === undefined) return
    delete value[botId]
    writeStoredDrafts(storage, value)
    return
  }
  if (before?.part === part && before?.text === text && before?.attachments === attachments) return
  value[botId] = { part, text, attachments }
  writeStoredDrafts(storage, value)
}

/**
 * The draft a Bot's current part takes back when it opens and has none of its own.
 * Taking removes it, so it is carried once. A part that is not the Bot's current part
 * (an earlier part the user opened from the details panel) takes nothing.
 * @param {{ botId: string, part: string, currentPart: string, text: string }} where
 * @param {Storage} [storage]
 * @returns {{ text: string, attachments: number } | undefined}
 */
export function takeCarriedDraft({ botId, part, currentPart, text }, storage = globalThis.localStorage) {
  if (typeof botId !== 'string' || botId === '' || typeof part !== 'string' || part === '') return undefined
  const value = readStoredDrafts(storage)
  const entry = value[botId]
  if (entry === undefined || !entryOf(entry)) return undefined
  if (entry.part === part || part !== currentPart) return undefined
  if (text.trim() !== '') return undefined
  if (entry.text === '' && entry.attachments === 0) return undefined
  delete value[botId]
  writeStoredDrafts(storage, value)
  return { text: entry.text, attachments: entry.attachments }
}
