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
 * @param {{ byId?: object, roomsById?: object, agentOf?: object, agents?: readonly { sessions?: readonly string[] }[] }} roster
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
  if (roster?.agentOf?.[sessionId] !== undefined || roster?.agents?.some?.(agent => agent?.sessions?.includes?.(sessionId))) {
    return { id: sessionId, part: sessionId }
  }
  return undefined
}

/**
 * Keep only this page's in-memory attachment draft for `part` without touching shared
 * text storage (for example when another tab owns a newer live text draft).
 * @param {{ chatId: string, part: string, files: readonly { kind: string, file: File }[] }} draft
 */
export function keepDraftFiles({ chatId, part, files }) {
  if (files.length === 0) keptFiles.delete(chatId)
  else keptFiles.set(chatId, { part, files: [...files] })
}

/**
 * Update only the stored text draft for a chat while keeping any in-memory files
 * already held for that chat intact (e.g. a queued-message withdrawal that finishes
 * after the user switched to another chat).
 * @param {{ chatId: string, part: string, text: string }} draft
 * @param {Storage} [storage]
 */
export function keepDraftText({ chatId, part, text }, storage = globalThis.localStorage) {
  const entry = entryFor(storage, { sync: true })
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
  if (changed) {
    entry.dirtyKeys.add(chatId)
    writeEntry(storage, entry)
  }
}

/**
 * Keep the draft of a chat's current part. A send or a cleared box leaves nothing.
 * @param {{ chatId: string, part: string, text: string, files: readonly { kind: string, file: File }[] }} draft
 * @param {Storage} [storage]
 * @param {{ deferMs?: number }} [options]
 */
export function keepDraft({ chatId, part, text, files }, storage = globalThis.localStorage, { deferMs = 0 } = {}) {
  keepDraftFiles({ chatId, part, files })
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
 * Drop the kept draft only when it belongs to `part`, leaving an earlier part's waiting
 * draft untouched. Cancels and flushes any pending debounced write for this storage so
 * a stale timer cannot re-persist the dropped draft.
 * @param {{ chatId: string, part: string }} where
 * @param {Storage} [storage]
 */
export function dropPartDraft({ chatId, part }, storage = globalThis.localStorage) {
  if (keptFiles.get(chatId)?.part === part) keptFiles.delete(chatId)
  const entry = entryFor(storage, { sync: true })
  if (entry.texts[chatId]?.part !== part) return
  delete entry.texts[chatId]
  entry.dirtyKeys.add(chatId)
  writeEntry(storage, entry)
}

/**
 * Whether shared storage currently holds a live unsent draft for `part` (for example
 * written in another tab after this page cleared its own draft on send).
 * @param {{ chatId: string, part: string }} where
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function hasLivePartDraft({ chatId, part }, storage = globalThis.localStorage) {
  const entry = entryFor(storage, { sync: true }).texts[chatId]
  return textEntry(entry) && entry.part === part && entry.text !== ''
}

/**
 * Whether shared storage currently holds a live unsent draft for `part` whose text differs
 * from this page's current box text (written by another tab).
 * @param {{ chatId: string, part: string, text: string }} where
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function hasOtherTabPartDraft({ chatId, part, text }, storage = globalThis.localStorage) {
  const entry = entryFor(storage, { sync: true }).texts[chatId]
  return textEntry(entry) && entry.part === part && entry.text !== '' && entry.text !== text
}

const contentText = content => (Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : '')

const isQuoteLine = line => line.startsWith('>')

// DSH's serializeDraftPrompt inserts `\n\n` and trims whitespace around quote blocks,
// whereas InputState.draft exposes the inline clipboard projection (`> quote\nhello` or
// `> quote hello`). Normalize quote boundaries without collapsing blank lines in plain text.
function normalizeQuoteText(text) {
  const normalized = text.replace(/\r\n?/gu, '\n').trim()
  if (!normalized.includes('>')) return normalized
  const lines = normalized.split('\n')
  const out = []
  let prevKind = null
  let pendingBlanks = []
  for (const line of lines) {
    if (line.trim() === '') {
      pendingBlanks.push(line)
      continue
    }
    const kind = isQuoteLine(line) ? 'quote' : 'text'
    if (prevKind !== null) {
      if (prevKind === 'quote' && kind === 'quote') {
        out.push('\n')
      } else if (prevKind === 'quote' || kind === 'quote') {
        if (prevKind === 'text') out[out.length - 1] = out[out.length - 1].trimEnd()
        out.push('\n\n')
      } else {
        for (const blank of pendingBlanks) out.push('\n', blank)
        out.push('\n')
      }
    }
    out.push(prevKind === 'quote' && kind === 'text' ? line.trimStart() : line)
    prevKind = kind
    pendingBlanks = []
  }
  return out.join('')
}

function quoteBoundarySegments(text) {
  const lines = text.replace(/\r\n?/gu, '\n').trim().split('\n')
  const segments = []
  let current = []
  let currentKind = null
  let pendingBlanks = []
  const flush = () => {
    if (current.length === 0) return
    segments.push({ kind: currentKind, text: current.join('\n') })
    current = []
  }
  for (const line of lines) {
    if (line.trim() === '') {
      pendingBlanks.push(line)
      continue
    }
    const kind = isQuoteLine(line) ? 'quote' : 'text'
    if (currentKind === null) {
      currentKind = kind
      current.push(line)
    } else if (kind !== currentKind || (kind === 'quote' && pendingBlanks.length > 0)) {
      flush()
      currentKind = kind
      current.push(line)
    } else {
      if (pendingBlanks.length > 0) current.push(...pendingBlanks)
      current.push(line)
    }
    pendingBlanks = []
  }
  flush()
  return segments
}

function matchesAdmittedText(draft, candidate) {
  if (typeof draft !== 'string' || typeof candidate !== 'string') return false
  const wanted = normalizeQuoteText(draft)
  if (wanted === '') return false
  const actual = normalizeQuoteText(candidate)
  if (actual === wanted) return true
  if (!actual.includes('>') || !draft.includes('>')) return false
  const segments = quoteBoundarySegments(candidate)
  if (segments.length < 2 || !segments.some(seg => seg.kind === 'quote')) return false
  const rawDraft = draft.replace(/\r\n?/gu, '\n').trim()
  let pos = 0
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) {
      while (pos < rawDraft.length && /\s/u.test(rawDraft[pos])) pos += 1
    }
    const seg = segments[i].text
    if (!rawDraft.startsWith(seg, pos)) return false
    pos += seg.length
  }
  return pos === rawDraft.length
}

const nodeSeq = node => (typeof node?.data?.seq === 'number'
  ? node.data.seq
  : (typeof node?.anchorSeq === 'number' ? node.anchorSeq : 0))

function chatUserNodes(chat) {
  if (chat?.nodes === undefined) return []
  const out = []
  if (typeof chat.nodes.values === 'function') {
    for (const node of chat.nodes.values()) {
      if (node?.kind === 'user' || node?.kind === 'steering') out.push(node)
    }
    return out
  }
  if (Array.isArray(chat.order) && typeof chat.nodes.get === 'function') {
    for (const key of chat.order) {
      const node = chat.nodes.get(key)
      if (node?.kind === 'user' || node?.kind === 'steering') out.push(node)
    }
    return out
  }
  return out
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
      if (node?.kind !== 'user' && node?.kind !== 'steering') continue
      const seq = nodeSeq(node)
      if (seq > 0) return seq
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
 * @param {{ chat?: object, maxUserSeq?: number, pendingSubmissions?: readonly object[], queue?: readonly object[], nextStep?: readonly object[] }} [state]
 */
export function captureAdmissionBaseline({ chat, maxUserSeq, pendingSubmissions, queue, nextStep } = {}) {
  const pendingIds = new Set()
  for (const item of pendingSubmissions ?? []) {
    if (typeof item?.requestId === 'string') pendingIds.add(item.requestId)
  }
  const queueIds = new Set()
  const queueTexts = []
  for (const list of [queue, nextStep]) {
    for (const item of list ?? []) {
      const id = typeof item?.id === 'string' ? item.id : undefined
      const rpcId = typeof item?.source?.rpcId === 'string' ? item.source.rpcId : undefined
      if (id !== undefined) queueIds.add(id)
      if (rpcId !== undefined) pendingIds.add(rpcId)
      if (item?.source?.kind === undefined || item.source.kind === 'user') {
        const text = contentText(item?.content)
        if (text !== '') queueTexts.push({ id, rpcId, text })
      }
    }
  }
  return {
    maxUserSeq: typeof maxUserSeq === 'number' ? maxUserSeq : maxUserSeqOf(chat),
    pendingIds,
    queueIds,
    queueTexts,
  }
}

/**
 * Whether Host admission is confirmed for a remembered send watch: an accepted
 * pendingSubmission echo, a new user queue or steering inbox item, or a durable
 * user/steering message after the send's baseline whose text matches what was sent
 * (normalized for DSH's serializeDraftPrompt trimming and quote boundaries).
 * Baseline queued/pending items are excluded across inbox-to-transcript drains via
 * durable messageId / source.rpcId identity, with a drained-count guard for any
 * synthetic transcript nodes lacking those IDs.
 * @param {{ text: string, baseline?: { maxUserSeq: number, pendingIds: Set<string>, queueIds: Set<string>, queueTexts?: readonly { id?: string, rpcId?: string, text: string }[] }, admitted?: boolean } | undefined} watch
 * @param {{ chat?: object, pendingSubmissions?: readonly object[], queue?: readonly object[], nextStep?: readonly object[] }} [state]
 * @returns {boolean}
 */
export function isSentAdmitted(watch, { chat, pendingSubmissions, queue, nextStep } = {}) {
  if (watch === undefined || watch.text === '') return false
  if (watch.admitted === true) return true
  if (watch.text.trim() === '') return false
  const baseline = watch.baseline
  for (const sub of pendingSubmissions ?? []) {
    if (typeof sub?.requestId === 'string' && baseline?.pendingIds?.has(sub.requestId)) continue
    if (matchesAdmittedText(watch.text, sub?.text)) return true
  }
  const liveQueueIds = new Set()
  for (const list of [queue, nextStep]) {
    for (const item of list ?? []) {
      if (typeof item?.id === 'string') liveQueueIds.add(item.id)
      if (typeof item?.id === 'string' && baseline?.queueIds?.has(item.id)) continue
      if (typeof item?.source?.rpcId === 'string' && baseline?.pendingIds?.has(item.source.rpcId)) continue
      if (item?.source?.kind !== undefined && item.source.kind !== 'user') continue
      if (matchesAdmittedText(watch.text, contentText(item?.content))) return true
    }
  }
  const minSeq = baseline?.maxUserSeq ?? 0
  const seenBaselineQueueIds = new Set()
  const seenBaselineRpcIds = new Set()
  let unidentifiedMatches = 0
  for (const node of chatUserNodes(chat)) {
    if (nodeSeq(node) <= minSeq) continue
    if (node?.data?.source?.kind !== undefined && node.data.source.kind !== 'user') continue
    const msgId = typeof node?.data?.messageId === 'string' ? node.data.messageId : undefined
    const rpcId = typeof node?.data?.source?.rpcId === 'string' ? node.data.source.rpcId : undefined
    if (msgId !== undefined && baseline?.queueIds?.has(msgId)) {
      seenBaselineQueueIds.add(msgId)
      continue
    }
    if (rpcId !== undefined && baseline?.pendingIds?.has(rpcId)) {
      seenBaselineRpcIds.add(rpcId)
      continue
    }
    if (!matchesAdmittedText(watch.text, contentText(node?.data?.content))) continue
    if (msgId !== undefined || rpcId !== undefined) return true
    unidentifiedMatches += 1
  }
  if (unidentifiedMatches > 0) {
    let drainedBaselineQueued = 0
    for (const item of baseline?.queueTexts ?? []) {
      if (item.id !== undefined && (liveQueueIds.has(item.id) || seenBaselineQueueIds.has(item.id))) continue
      if (item.rpcId !== undefined && seenBaselineRpcIds.has(item.rpcId)) continue
      if (matchesAdmittedText(watch.text, item.text)) drainedBaselineQueued += 1
    }
    if (unidentifiedMatches > drainedBaselineQueued) return true
  }
  return false
}

// The text of a message that was already sent is not a draft. The shell may close its
// composer before it commits the emptied draft and hand the sent text back on the next
// visit; this page remembers the send attempt with its pre-send admission baseline so
// that visit clears the box only once Host admission is confirmed (#1891). The note
// lives in this page's memory, never in browser storage: storage is shared by every
// tab, and a mark another tab left is not this page's to act on (#2003). It belongs
// to the Session that sent it, so another Session of the same chat neither reads it nor
// consumes it (#2003 review).
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
  for (const chatId of gone) {
    keptFiles.delete(chatId)
    const prefix = `${chatId}:`
    for (const key of sentTexts.keys()) if (key.startsWith(prefix)) sentTexts.delete(key)
  }
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
  sentTexts.clear()
}
