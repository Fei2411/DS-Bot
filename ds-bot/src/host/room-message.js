// Pure 3-way group message protocol helpers:
//   - `visible` (legacy alias `note`): written to the group ledger; 0 model wakes, 0 calls, 0 waits.
//   - `invite`: user message / kickoff / goal cue; grants 1 speaking opportunity (may [PASS]), no owed deliverable.
//   - `call` (legacy alias `request`): explicit Bot-to-Bot delegation in a group; opens SQLite room_work + call + wait.
//   - `result`: settles an open `call` back to its fixed caller; never creates a new delegation edge.
//
// Invariant: The transcript is public to the room (`visible`). Only explicit protocol
// envelopes address recipients. Body `@Name` text written by a Bot is display-only and
// never parsed into new `call` edges or automatic wakes.

export const ROOM_MESSAGE_KINDS = Object.freeze(['visible', 'invite', 'call'])

const uniqueIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id !== ''))]

export const roomVisible = () => ({ kind: 'visible' })
// Backward-compatible alias: legacy callers/tests using `roomNote()` emit zero-wake visible routes.
export const roomNote = () => ({ kind: 'note' })

export const roomInvite = (ids, { ordered = false, reason } = {}) => ({
  kind: 'invite',
  to: uniqueIds(ids),
  ...(ordered ? { ordered: true } : {}),
  ...(reason ? { reason } : {}),
})

export const roomCall = (ids, { expectsResult = true, follows, callId, parentWorkId } = {}) => ({
  kind: 'call',
  to: uniqueIds(ids),
  ...(expectsResult ? { expectsResult: true } : {}),
  ...(follows ? { follows } : {}),
  ...(callId ? { callId } : {}),
  ...(parentWorkId ? { parentWorkId } : {}),
})

// Backward-compatible alias for explicit Bot-to-Bot delegation envelopes.
export const roomRequest = (ids, opts = {}) => ({
  kind: 'request',
  to: uniqueIds(ids),
  ...(opts.expectsResult === true ? { expectsResult: true } : {}),
  ...(opts.follows ? { follows: opts.follows } : {}),
  ...(opts.callId ? { callId: opts.callId } : {}),
  ...(opts.parentWorkId ? { parentWorkId: opts.parentWorkId } : {}),
})

export const roomResult = (caller, callId) => ({
  kind: 'result',
  to: typeof caller === 'string' && caller !== '' ? [caller] : [],
  ...(callId ? { callId, batch: callId } : {}),
})

export const isVisibleRoute = route => route === undefined || route === null || route.kind === 'visible' || route.kind === 'note'
export const isInviteRoute = route => route?.kind === 'invite'
export const isCallRoute = route => route?.kind === 'call' || route?.kind === 'request'
export const isResultRoute = route => route?.kind === 'result'

// Resolves explicit envelope recipients (`invite` / `call` / `request` / `result`),
// excluding the sender and any non-member id. Always returns `[]` for `visible` / `note`.
export function addressedMembers(route, members, senderId) {
  if (!route || isVisibleRoute(route) || !Array.isArray(route.to)) return []
  if (!['invite', 'call', 'request', 'result'].includes(route.kind)) return []
  const byId = new Map((members ?? []).map(member => [member.id, member]))
  return uniqueIds(route.to)
    .filter(id => id !== senderId && byId.has(id))
    .map(id => byId.get(id))
}

// Explicit Bot-to-Bot delegation targets ONLY. Never infers callees from body text,
// invites, or result envelopes.
export function explicitCallees(route, members, senderId) {
  if (!isCallRoute(route)) return []
  return addressedMembers(route, members, senderId)
}

// Strict zero-echo replacement for legacy `newCallees`: only an explicit `call`/`request`
// route may create delegation edges. Never falls back to body `@Name` (`named`).
export function newCallees(route, speakers = []) {
  if (!isCallRoute(route)) return []
  const allowed = new Set(uniqueIds(route.to))
  return (speakers ?? []).filter(member => member !== undefined && allowed.has(typeof member === 'string' ? member : member.id))
}

// Resolves who a user message invites to speak (`invite` only, never a Bot `call`).
export function resolveUserInvite({ members = [], adminId = null, mode = 'admin', mentions = { all: false, found: [] } } = {}) {
  const admin = adminId ? members.find(bot => bot.id === adminId) : undefined
  const found = (mentions?.found ?? []).filter(Boolean)
  if (found.length > 0 && mentions?.all !== true) {
    return roomInvite(found.map(bot => bot.id), { ordered: false, reason: 'user_mention' })
  }
  if (mentions?.all !== true && mode === 'admin' && admin !== undefined) {
    return roomInvite([admin.id], { ordered: false, reason: 'user_admin' })
  }
  const orderedMembers = admin !== undefined
    ? [admin, ...members.filter(bot => bot.id !== admin.id)]
    : [...members]
  return roomInvite(orderedMembers.map(bot => bot.id), {
    ordered: mentions?.all !== true && orderedMembers.length > 1,
    reason: mentions?.all === true ? 'user_all' : 'user_everyone',
  })
}

// Classifies a Bot's speech inside a group turn under the 3-way protocol:
// - Answering a completed result (`resultRef`) -> `visible` (zero echo).
// - Answering an open delegated `call` (`activeCallId` / `askedBy`) -> `result` to fixed caller.
// - Otherwise (answering a user `invite` or posting a status/progress update) -> `visible` (0 wakes).
// Body `@Name` mentions written by a Bot are strictly display-only and never create `call` edges.
export function classifyBotGroupSpeech({ resultRef, activeCallId, askedBy } = {}) {
  if (resultRef) return roomVisible()
  if (activeCallId && askedBy) return roomResult(askedBy, activeCallId)
  if (askedBy) return roomResult(askedBy)
  return roomVisible()
}

// Directed wait-cycle check for group Bot-to-Bot delegations:
// Returns true if `targetBotId` is already (directly or transitively) waiting on `callerBotId`
// in `roomId`, so `callerBotId -> targetBotId` would form a wait cycle.
//
// Accepts either a `coordination-db.js` handle (primary path) or a legacy `roomBatches` map.
export function waitsOnMember(coordDbOrBatches, roomId, callerBotId, targetBotId, { callerWorkId } = {}) {
  if (!coordDbOrBatches || !roomId || !callerBotId || !targetBotId) return false
  if (callerBotId === targetBotId) return true

  // SQLite coordination ledger path: inspect open `call` wait graph via `detectWaitCycle`.
  if (typeof coordDbOrBatches.detectWaitCycle === 'function' && typeof coordDbOrBatches.listWorks === 'function') {
    const callerWorks = callerWorkId
      ? [{ workId: callerWorkId }]
      : coordDbOrBatches.listWorks({ botId: callerBotId, kind: 'room_work', roomId, activeOnly: true })
    if (callerWorks.length === 0) return false
    const targetWorks = coordDbOrBatches.listWorks({ botId: targetBotId, kind: 'room_work', roomId, activeOnly: true })
    if (targetWorks.length === 0) return false
    for (const cw of callerWorks) {
      for (const tw of targetWorks) {
        if (cw.workId === tw.workId) continue
        if (coordDbOrBatches.detectWaitCycle(cw.workId, tw.workId, { kinds: ['call'] }).hasCycle) {
          return true
        }
      }
    }
    return false
  }

  // Legacy plain-object `batches` fallback (kept only for legacy unit tests).
  const parents = new Map()
  for (const batch of Object.values(coordDbOrBatches ?? {})) {
    if (batch?.roomId !== roomId) continue
    for (const child of batch.pending ?? []) {
      if (!parents.has(child)) parents.set(child, [])
      parents.get(child).push(batch.by)
    }
  }
  const seen = new Set([callerBotId])
  for (const id of seen) {
    for (const parent of parents.get(id) ?? []) {
      if (parent === targetBotId) return true
      seen.add(parent)
    }
  }
  return false
}
