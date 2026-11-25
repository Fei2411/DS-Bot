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
const storageCache = new WeakMap()
let listeningStorage = false

const parseTexts = (raw) => {
  try {
    const value = JSON.parse(raw ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const mergeIncoming = (entry, raw) => {
  const incoming = parseTexts(raw)
  if (entry.dirtyKeys.size === 0) {
    entry.raw = raw
    entry.texts = incoming
    return
  }
  const merged = { ...incoming }
  for (const key of entry.dirtyKeys) {
    if (Object.prototype.hasOwnProperty.call(entry.texts, key)) merged[key] = entry.texts[key]
    else delete merged[key]
  }
  entry.raw = raw
  entry.texts = merged
}

const watchStorage = () => {
  if (listeningStorage || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  listeningStorage = true
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE.drafts) return
    const local = globalThis.localStorage
    if (!local) return
    const entry = storageCache.get(local)
    if (entry !== undefined) mergeIncoming(entry, event.newValue ?? null)
  })
}

const entryFor = (storage, { sync = false } = {}) => {
  if (!storage || typeof storage !== 'object') return { texts: {}, raw: null, dirtyKeys: new Set(), timer: 0 }
  if (storage === globalThis.localStorage) watchStorage()
  let entry = storageCache.get(storage)
  if (entry === undefined) {
    let raw = null
    try { raw = storage.getItem(STORAGE.drafts) ?? null } catch { /* storage unavailable */ }
    entry = { texts: parseTexts(raw), raw, dirtyKeys: new Set(), timer: 0 }
    storageCache.set(storage, entry)
    return entry
  }
  if (sync) {
    let raw = null
    try { raw = storage.getItem(STORAGE.drafts) ?? null } catch { /* storage unavailable */ }
    if (raw !== entry.raw) mergeIncoming(entry, raw)
  }
  return entry
}

const writeEntry = (storage, entry) => {
  if (entry.timer && typeof clearTimeout === 'function') {
    clearTimeout(entry.timer)
    entry.timer = 0
  }
  if (entry.dirtyKeys.size === 0) return
  if (storage && typeof storage.getItem === 'function') {
    try {
      const latestRaw = storage.getItem(STORAGE.drafts) ?? null
      if (latestRaw !== entry.raw) mergeIncoming(entry, latestRaw)
    } catch { /* storage unavailable */ }
  }
  const raw = JSON.stringify(entry.texts)
  try { storage?.setItem(STORAGE.drafts, raw) } catch { /* storage unavailable */ }
  entry.raw = raw
  entry.dirtyKeys.clear()
}

const textEntry = value => value !== null && typeof value === 'object' && typeof value.part === 'string' && typeof value.text === 'string'

/**
 * Flush any debounced draft writes to browser storage synchronously.
 * @param {Storage} [storage]
 */
export function flushDrafts(storage = globalThis.localStorage) {
  if (!storage || typeof storage !== 'object') return
  const entry = storageCache.get(storage)
  if (entry === undefined) return
  if (entry.timer && typeof clearTimeout === 'function') {
    clearTimeout(entry.timer)
    entry.timer = 0
  }
  if (entry.dirtyKeys.size > 0) writeEntry(storage, entry)
}

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
 * @param {{ deferMs?: number }} [options]
 */
export function keepDraft({ chatId, part, text, files }, storage = globalThis.localStorage, { deferMs = 0 } = {}) {
  if (files.length === 0) keptFiles.delete(chatId)
  else keptFiles.set(chatId, { part, files: [...files] })
  const entry = entryFor(storage)
  const texts = entry.texts
  const before = texts[chatId]
  let changed = false
  if (text === '') {
    if (before !== undefined) {
      delete texts[chatId]
      changed = true
    }
  } else if (before?.part !== part || before?.text !== text) {
    texts[chatId] = { part, text }
    changed = true
  }
  if (!changed) {
    if (deferMs <= 0 && entry.dirtyKeys.size > 0) writeEntry(storage, entry)
    return
  }
  entry.dirtyKeys.add(chatId)
  if (deferMs > 0 && typeof setTimeout === 'function' && typeof clearTimeout === 'function') {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = 0
      if (entry.dirtyKeys.size > 0) writeEntry(storage, entry)
    }, deferMs)
    return
  }
  writeEntry(storage, entry)
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
  const entry = entryFor(storage, { sync: true }).texts[chatId]
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
  const entry = entryFor(storage, { sync: true })
  const texts = entry.texts
  const listed = gone.filter(chatId => texts[chatId] !== undefined)
  if (listed.length === 0) return
  for (const chatId of listed) {
    delete texts[chatId]
    entry.dirtyKeys.add(chatId)
  }
  writeEntry(storage, entry)
}

/** Test seam: start from an empty page. */
export function forgetKeptFiles() {
  keptFiles.clear()
}
