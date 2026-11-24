import { chatOfSession } from './draft-keep.js'
import { createSource } from './sources.js'
import { STORAGE } from './storage.js'

// -------------------------------------------------------------------------
// Unsubmitted custom text from an interrupted question card moves back into
// the chat's main composer draft instead of disappearing. Reconciliation runs
// against pending state (roster / sessionStatus), never component unmount, so
// scrolling away, switching chats, dock-to-inline handoffs, and part rollovers
// never trigger false rescues.

const SEPARATOR = '\n\n'

const normalizePieces = (value) => {
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

const alreadyAtEnd = (base, piece) => {
  const tail = base.trimEnd()
  return tail === piece || tail.endsWith(`${SEPARATOR}${piece}`) || tail.endsWith(`\n${piece}`)
}

/**
 * Append rescued custom answer text to an existing composer draft without
 * overwriting it or duplicating an identical trailing block.
 * @param {string} existing
 * @param {string | readonly string[]} rescued
 * @returns {string}
 */
export function mergeRescuedDraft(existing, rescued) {
  const pieces = normalizePieces(rescued)
  let current = typeof existing === 'string' ? existing : ''
  for (const piece of pieces) {
    if (current.trim() === '') {
      current = piece
    } else if (!alreadyAtEnd(current, piece)) {
      current = `${current.trimEnd()}${SEPARATOR}${piece}`
    }
  }
  return current
}

/**
 * Read pending rescued draft text for a chat (checking chatId first, then sessionId).
 * @param {Record<string, string> | undefined} map
 * @param {string | undefined} chatId
 * @param {string | undefined} sessionId
 * @returns {string}
 */
export function readRescuedForChat(map, chatId, sessionId) {
  if (!map || typeof map !== 'object') return ''
  const first = typeof chatId === 'string' && chatId !== '' ? map[chatId] : ''
  const second = typeof sessionId === 'string' && sessionId !== '' && sessionId !== chatId ? map[sessionId] : ''
  return mergeRescuedDraft(first ?? '', second ?? '')
}

const readSaved = (storage, key) => {
  try {
    const raw = JSON.parse(storage?.getItem(key) ?? '{}')
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const clean = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim() !== '') clean[k] = v.trim()
    }
    return clean
  } catch {
    return {}
  }
}

const writeSaved = (storage, key, value) => {
  try {
    if (Object.keys(value).length === 0) storage?.removeItem?.(key)
    else storage?.setItem(key, JSON.stringify(value))
  } catch { /* storage unavailable */ }
}

const entryKey = (kind, id) => `${kind}:${id}`

const hasRosterChats = roster => Object.keys(roster?.byId ?? {}).length > 0 || Object.keys(roster?.roomsById ?? {}).length > 0

/**
 * Track unsubmitted custom answers on active question cards and move them to
 * the chat's composer draft queue when a question disappears externally.
 */
export function createQuestionDrafts({ storage = globalThis.localStorage, storageKey = STORAGE.rescuedDrafts } = {}) {
  const rescued = createSource(readSaved(storage, storageKey))
  const active = new Map()

  const enqueueRescue = (targetKey, text) => {
    const clean = mergeRescuedDraft('', text)
    if (typeof targetKey !== 'string' || targetKey === '' || clean === '') return null
    rescued.set((state) => {
      const nextText = mergeRescuedDraft(state[targetKey] ?? '', clean)
      if (state[targetKey] === nextText) return state
      const next = { ...state, [targetKey]: nextText }
      writeSaved(storage, storageKey, next)
      return next
    })
    return { targetKey, text: clean }
  }

  const rescueEntry = (entry) => {
    const text = mergeRescuedDraft('', [...entry.parts.values()])
    if (text === '') return null
    const targetKey = entry.chatId || entry.sessionId
    const enqueued = enqueueRescue(targetKey, text)
    return enqueued === null ? null : { targetKey, chatId: entry.chatId, sessionId: entry.sessionId, text: enqueued.text }
  }

  const noteDraft = ({ kind, id, subId = id, sessionId, chatId = null, text }) => {
    if (typeof kind !== 'string' || kind === '' || typeof id !== 'string' || id === '' || typeof sessionId !== 'string' || sessionId === '') return
    const key = entryKey(kind, id)
    const existing = active.get(key)
    const raw = typeof text === 'string' ? text : ''
    if (raw === '') {
      if (existing === undefined) return
      existing.parts.delete(subId)
      if (existing.parts.size === 0 && existing.inFlight === null) active.delete(key)
      return
    }
    const entry = existing ?? {
      kind,
      id,
      sessionId,
      chatId,
      parts: new Map(),
      inFlight: null,
      missing: false,
    }
    entry.sessionId = sessionId
    if (typeof chatId === 'string' && chatId !== '') entry.chatId = chatId
    entry.parts.set(subId, raw)
    active.set(key, entry)
  }

  const readDraft = (kind, id, subId = id) => {
    if (typeof kind !== 'string' || typeof id !== 'string') return ''
    return active.get(entryKey(kind, id))?.parts.get(subId) ?? ''
  }

  const beginSettle = (kind, id, outcome) => {
    if (outcome !== 'answered' && outcome !== 'dismissed') return
    const entry = active.get(entryKey(kind, id))
    if (entry !== undefined) entry.inFlight = outcome
  }

  const finishSettle = (kind, id, succeeded) => {
    const key = entryKey(kind, id)
    const entry = active.get(key)
    if (entry === undefined) return null
    if (succeeded) {
      active.delete(key)
      return null
    }
    const outcome = entry.inFlight
    entry.inFlight = null
    if (entry.missing) {
      active.delete(key)
      if (outcome === 'dismissed') return null
      return rescueEntry(entry)
    }
    return null
  }

  const reconcileRoster = (roster) => {
    if (!roster?.ready) return []
    const pendingById = new Map()
    for (const [sessionId, question] of Object.entries(roster.questions ?? {})) {
      if (typeof question?.id === 'string' && question.id !== '') {
        pendingById.set(question.id, { sessionId, chatId: chatOfSession(roster, sessionId)?.id ?? null })
      }
    }
    const knownChats = hasRosterChats(roster)
    const results = []
    for (const [key, entry] of active) {
      if (entry.kind !== 'ask_user') continue
      const live = pendingById.get(entry.id)
      if (live !== undefined) {
        entry.sessionId = live.sessionId
        if (live.chatId !== null) entry.chatId = live.chatId
        entry.missing = false
        continue
      }
      const resolvedChat = chatOfSession(roster, entry.sessionId)?.id ?? null
      if (resolvedChat !== null) entry.chatId = resolvedChat
      const chatAlive = !knownChats || resolvedChat !== null || (entry.chatId !== null && chatOfSession(roster, entry.chatId) !== undefined)
      if (!chatAlive) {
        active.delete(key)
        continue
      }
      if (entry.inFlight !== null) {
        entry.missing = true
        continue
      }
      active.delete(key)
      const item = rescueEntry(entry)
      if (item !== null) results.push(item)
    }
    return results
  }

  const reconcileBlocking = (sessionStatus, roster) => {
    if (!sessionStatus || typeof sessionStatus.get !== 'function') return []
    const results = []
    for (const [key, entry] of active) {
      if (entry.kind !== 'blocking') continue
      const interaction = sessionStatus.get(entry.sessionId)?.pendingInteraction
      if (interaction?.kind === 'question' && interaction.key === entry.id) {
        entry.missing = false
        continue
      }
      if (roster?.ready) {
        const resolvedChat = chatOfSession(roster, entry.sessionId)?.id ?? null
        if (resolvedChat !== null) entry.chatId = resolvedChat
      }
      if (entry.inFlight !== null) {
        entry.missing = true
        continue
      }
      active.delete(key)
      const item = rescueEntry(entry)
      if (item !== null) results.push(item)
    }
    return results
  }

  const consumeRescue = (chatId, sessionId, taken) => {
    const keys = [chatId, sessionId].filter((value, index, list) => typeof value === 'string' && value !== '' && list.indexOf(value) === index)
    if (keys.length === 0) return
    rescued.set((state) => {
      const present = keys.filter(key => state[key] !== undefined)
      if (present.length === 0) return state
      const current = readRescuedForChat(state, chatId, sessionId)
      if (taken !== undefined && current !== taken) return state
      const next = { ...state }
      for (const key of present) delete next[key]
      writeSaved(storage, storageKey, next)
      return next
    })
  }

  const pruneChats = (gone) => {
    if (!Array.isArray(gone) || gone.length === 0) return
    const goneSet = new Set(gone)
    for (const [key, entry] of active) {
      if (goneSet.has(entry.chatId) || goneSet.has(entry.sessionId)) active.delete(key)
    }
    rescued.set((state) => {
      const listed = gone.filter(id => state[id] !== undefined)
      if (listed.length === 0) return state
      const next = { ...state }
      for (const id of listed) delete next[id]
      writeSaved(storage, storageKey, next)
      return next
    })
  }

  return {
    rescued,
    noteDraft,
    readDraft,
    beginSettle,
    finishSettle,
    reconcileRoster,
    reconcileBlocking,
    enqueueRescue,
    consumeRescue,
    pruneChats,
  }
}
