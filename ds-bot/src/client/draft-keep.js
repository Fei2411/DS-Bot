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
 * Drop the kept draft only when it belongs to `part`, leaving an earlier part's waiting
 * draft untouched.
 * @param {{ chatId: string, part: string }} where
 * @param {Storage} [storage]
 */
export function dropPartDraft({ chatId, part }, storage = globalThis.localStorage) {
  if (keptFiles.get(chatId)?.part === part) keptFiles.delete(chatId)
  const texts = readTexts(storage)
  if (texts[chatId]?.part !== part) return
  delete texts[chatId]
  writeTexts(storage, texts)
}

/**
 * Whether shared storage currently holds a live unsent draft for `part` (for example
 * written in another tab after this page cleared its own draft on send).
 * @param {{ chatId: string, part: string }} where
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function hasLivePartDraft({ chatId, part }, storage = globalThis.localStorage) {
  const entry = readTexts(storage)[chatId]
  return textEntry(entry) && entry.part === part && entry.text !== ''
}

const contentText = content => (Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : '')

const nodeSeq = node => (typeof node?.data?.seq === 'number'
  ? node.data.seq
  : (typeof node?.anchorSeq === 'number' ? node.anchorSeq : 0))

function chatUserNodes(chat) {
  if (chat?.nodes === undefined) return []
  if (typeof chat.nodes.values === 'function') {
    return chat.nodes.values().filter(node => node?.kind === 'user' || node?.kind === 'steering')
  }
  if (Array.isArray(chat.order) && typeof chat.nodes.get === 'function') {
    const out = []
    for (const key of chat.order) {
      const node = chat.nodes.get(key)
      if (node?.kind === 'user' || node?.kind === 'steering') out.push(node)
    }
    return out
  }
  return []
}

/**
 * Highest durable event seq among user/steering nodes currently in a Chat snapshot.
 * @param {object | undefined} chat
 * @returns {number}
 */
export function maxUserSeqOf(chat) {
  if (chat?.nodes === undefined) return 0
  if (Array.isArray(chat.order) && typeof chat.nodes.get === 'function') {
    for (let i = chat.order.length - 1; i >= 0; i -= 1) {
      const node = chat.nodes.get(chat.order[i])
      if (node?.kind === 'user' || node?.kind === 'steering') return nodeSeq(node)
    }
    return 0
  }
  let max = 0
  for (const node of chatUserNodes(chat)) {
    const seq = nodeSeq(node)
    if (seq > max) max = seq
  }
  return max
}

/**
 * Snapshot the Session's already-admitted user messages at the start of a send attempt
 * so a later check only counts admissions that happened after this send began.
 * @param {{ chat?: object, pendingSubmissions?: readonly object[], queue?: readonly object[] }} [state]
 */
export function captureAdmissionBaseline({ chat, pendingSubmissions, queue } = {}) {
  const pendingIds = new Set()
  for (const item of pendingSubmissions ?? []) {
    if (typeof item?.requestId === 'string') pendingIds.add(item.requestId)
  }
  const queueIds = new Set()
  for (const item of queue ?? []) {
    if (typeof item?.id === 'string') queueIds.add(item.id)
  }
  return { maxUserSeq: maxUserSeqOf(chat), pendingIds, queueIds }
}

/**
 * Whether Host admission is confirmed for a remembered send watch: an accepted
 * pendingSubmission echo, a new user queue item, or a durable user/steering message
 * after the send's baseline whose text matches what was sent (trimmed like DSH's
 * serializeDraftPrompt).
 * @param {{ text: string, baseline?: { maxUserSeq: number, pendingIds: Set<string>, queueIds: Set<string> }, admitted?: boolean } | undefined} watch
 * @param {{ chat?: object, pendingSubmissions?: readonly object[], queue?: readonly object[] }} [state]
 * @returns {boolean}
 */
export function isSentAdmitted(watch, { chat, pendingSubmissions, queue } = {}) {
  if (watch === undefined || watch.text === '') return false
  if (watch.admitted === true) return true
  const wanted = watch.text.trim()
  if (wanted === '') return false
  const baseline = watch.baseline
  for (const sub of pendingSubmissions ?? []) {
    if (typeof sub?.requestId === 'string' && baseline?.pendingIds?.has(sub.requestId)) continue
    if (typeof sub?.text === 'string' && sub.text.trim() === wanted) return true
  }
  for (const item of queue ?? []) {
    if (typeof item?.id === 'string' && baseline?.queueIds?.has(item.id)) continue
    if (item?.source?.kind !== undefined && item.source.kind !== 'user') continue
    if (contentText(item?.content).trim() === wanted) return true
  }
  const minSeq = baseline?.maxUserSeq ?? 0
  for (const node of chatUserNodes(chat)) {
    if (nodeSeq(node) <= minSeq) continue
    if (contentText(node?.data?.content).trim() === wanted) return true
  }
  return false
}

// The text of a message that was already sent is not a draft. The shell may close its
// composer before it commits the emptied draft and hand the sent text back on the next
// visit; this page remembers the send attempt with its pre-send admission baseline so
// that visit clears the box only once Host admission is confirmed (#1891). The note
// lives in this page's memory, never in browser storage: storage is shared by every
// tab, and a mark another tab left is not this page's to act on (#2003). It belongs
// to the Session that sent it, so a parallel Session of the same chat, which the user
// may switch to, neither reads it nor consumes it (#2003 review).
const sentTexts = new Map()

const sentKey = (chatId, sessionId) => `${chatId}:${sessionId ?? ''}`

/**
 * Remember an in-flight message send for one Session of a chat, along with its
 * pre-send admission baseline.
 * @param {{ chatId: string, sessionId: string, text: string, baseline?: object }} sent
 */
export function keepSentDraft({ chatId, sessionId, text, baseline }) {
  const key = sentKey(chatId, sessionId)
  if (text === '') sentTexts.delete(key)
  else sentTexts.set(key, { text, baseline, admitted: false })
}

/**
 * Inspect the pending send watch for this Session without consuming it.
 * @param {{ chatId: string, sessionId: string }} where
 */
export function peekSentDraft({ chatId, sessionId }) {
  return sentTexts.get(sentKey(chatId, sessionId))
}

/**
 * Latch confirmed Host admission on an in-flight send watch for this Session.
 * @param {{ chatId: string, sessionId: string }} where
 */
export function markSentAdmitted({ chatId, sessionId }) {
  const entry = sentTexts.get(sentKey(chatId, sessionId))
  if (entry !== undefined) entry.admitted = true
}

/**
 * Consume the remembered send watch for this Session.
 * @param {{ chatId: string, sessionId: string }} where
 */
export function takeSentDraft({ chatId, sessionId }) {
  const key = sentKey(chatId, sessionId)
  const entry = sentTexts.get(key)
  sentTexts.delete(key)
  return entry
}

/**
 * The composer is open and the send has settled: the shell can no longer hand the text
 * back, so the mark is no longer needed.
 * @param {{ chatId: string, sessionId: string }} where
 */
export function dropSentDraft({ chatId, sessionId }) {
  sentTexts.delete(sentKey(chatId, sessionId))
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
  for (const chatId of gone) {
    keptFiles.delete(chatId)
    const prefix = `${chatId}:`
    for (const key of sentTexts.keys()) if (key.startsWith(prefix)) sentTexts.delete(key)
  }
  const texts = readTexts(storage)
  const listed = gone.filter(chatId => texts[chatId] !== undefined)
  if (listed.length === 0) return
  for (const chatId of listed) delete texts[chatId]
  writeTexts(storage, texts)
}

/** Test seam: start from an empty page. */
export function forgetKeptFiles() {
  keptFiles.clear()
  sentTexts.clear()
}
