import { STORAGE } from './storage.js'
import { currentPart } from './text.js'

// -------------------------------------------------------------------------
// An unsent draft stays with its chat (#1248). The shell keeps a draft's text under the
// Session it was typed in, but it lets go of the attached images and files when that
// Session's composer closes, and a chat that moves to a fresh part opens with an empty
// box. So the current part's composer keeps the latest draft per chat (a Bot or a
// group): the text in browser storage, the files in memory for as long as the page
// lives. When the chat's composer opens again with nothing attached, the files go
// back in through the shell's own draft intake; when it opens on a newer part with no
// text of its own, the text goes too. An earlier part opened to read keeps its own.

const NO_FILES = []

// Files live only in this page: browser storage cannot hold them, and a reload ends the
// shell's own images too.
const keptFiles = new Map()

const readTexts = (storage) => {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE.drafts) ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const writeTexts = (storage, value) => {
  try { storage?.setItem(STORAGE.drafts, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const textEntry = value => value !== null && typeof value === 'object' && typeof value.part === 'string' && typeof value.text === 'string'

/**
 * The chat a Session belongs to, with the part its composer is current on.
 * @param {{ byId?: object, roomsById?: object }} roster
 * @param {string} sessionId
 * @returns {{ id: string, part: string } | undefined}
 */
export function chatOfSession(roster, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const bots = Object.values(roster?.byId ?? {})
  const rooms = Object.values(roster?.roomsById ?? {})
  const bot = roster?.byId?.[sessionId] ?? bots.find(item => currentPart(item) === sessionId || item.parts?.includes(sessionId))
  if (bot !== undefined) return { id: bot.id, part: currentPart(bot) }
  const room = roster?.roomsById?.[sessionId] ?? rooms.find(item => (item.sessionId ?? item.id) === sessionId || item.ownParts?.includes(sessionId))
  if (room !== undefined) return { id: room.id, part: room.sessionId ?? room.id }
  return undefined
}

/**
 * Keep the draft of a chat's current part. A send or a cleared box leaves nothing.
 * @param {{ chatId: string, part: string, text: string, files: readonly { kind: string, file: File }[] }} draft
 * @param {Storage} [storage]
 */
export function keepDraft({ chatId, part, text, files }, storage = globalThis.localStorage) {
  if (files.length === 0) keptFiles.delete(chatId)
  else keptFiles.set(chatId, { part, files: [...files] })
  const texts = readTexts(storage)
  const before = texts[chatId]
  if (text === '') {
    if (before === undefined) return
    delete texts[chatId]
  } else {
    if (before?.part === part && before?.text === text) return
    texts[chatId] = { part, text }
  }
  writeTexts(storage, texts)
}

/**
 * What a chat's current part takes back when its composer opens: the files when it has
 * none attached, and the text when the draft was typed in an earlier part and the box
 * is empty (the shell keeps the text of the same part itself).
 * @param {{ chatId: string, part: string, text: string, attached: number }} where
 * @param {Storage} [storage]
 * @returns {{ text: string, files: readonly { kind: string, file: File }[], from: string | undefined }}
 */
export function takeDraft({ chatId, part, text, attached }, storage = globalThis.localStorage) {
  const kept = keptFiles.get(chatId)
  const files = attached === 0 && kept !== undefined ? kept.files : NO_FILES
  const entry = readTexts(storage)[chatId]
  const carried = textEntry(entry) && entry.part !== part && text.trim() === '' ? entry.text : ''
  return { text: carried, files, from: files.length > 0 ? kept.part : (carried === '' ? undefined : entry.part) }
}

/**
 * Forget the drafts of chats that were deleted, so a deleted Bot's text does not stay
 * in browser storage. Only the chats named go: the storage is shared by every team this
 * browser has opened (another data location of the desktop app, another DSH), whose
 * chats this roster does not list.
 * @param {readonly string[]} gone
 * @param {Storage} [storage]
 */
export function pruneDrafts(gone, storage = globalThis.localStorage) {
  if (gone.length === 0) return
  for (const chatId of gone) keptFiles.delete(chatId)
  const texts = readTexts(storage)
  const listed = gone.filter(chatId => texts[chatId] !== undefined)
  if (listed.length === 0) return
  for (const chatId of listed) delete texts[chatId]
  writeTexts(storage, texts)
}

/** Test seam: start from an empty page. */
export function forgetKeptFiles() {
  keptFiles.clear()
}
