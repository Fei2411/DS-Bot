// "Responding to Bots": whether a message from one Bot may start another Bot's model turn.
//
// Every Bot and every group has a response policy for Bot-originated messages:
//   off       bot messages never start new work here
//   selected  only the Bots in `allow` (stable Bot IDs, never names) may
//   all       any Bot may, still under the loop safeguards below
// No policy at all is the legacy behavior, which allows everything the existing
// guards allow, so a team saved before this setting behaves as it did until the user
// picks one. A group-triggered response needs both the recipient's policy and the
// group's policy to allow the sender.
//
// The user's own messages never come through here, and neither does the result of a
// task the recipient itself handed out (a reply, a completion, a late answer): that
// goes back to its requester and is not new work. What the requester then does with
// the result is a call like any other and is decided again.
//
// Nothing here reads message text to guess at authority. A trigger is allowed because of
// who sent it, whom it names and, for review fixes, the structured finding it carries.

import { createHash } from 'node:crypto'

export const RESPONSE_MODES = ['off', 'selected', 'all']
// Automatic fix attempts per structured finding (PR, commit SHA, finding ID).
export const FINDING_ATTEMPT_LIMIT = 2

const LOG_MAX = 200
const SEEN_MAX = 2000
const FINDINGS_MAX = 2000
const WARN_EVERY_MS = 60_000

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// A policy as the user saved it, or undefined for the legacy default. `live` is the set
// of Bot IDs that exist; `selfId` is left out of a Bot's own list. Strict is for what the
// user sends (a bad value is an error); the loader is lenient and drops what it cannot
// read, so one corrupt entry never blocks the team.
export function cleanResponsePolicy(value, live, { selfId, strict = false } = {}) {
  if (value === undefined || value === null || value === '') return undefined
  const fail = (message) => {
    if (strict) throw new Error(message)
    return undefined
  }
  if (!isObject(value)) return fail('A response policy is an object with a mode')
  if (!RESPONSE_MODES.includes(value.mode)) return fail(`Response mode must be one of ${RESPONSE_MODES.join(', ')}`)
  if (value.allow !== undefined && !Array.isArray(value.allow)) return fail('The allowed Bots are a list of Bot IDs')
  const ids = []
  for (const id of value.allow ?? []) {
    if (typeof id !== 'string') { fail('The allowed Bots are a list of Bot IDs'); continue }
    if (id === selfId || ids.includes(id)) continue
    if (live !== undefined && !live.has(id)) { fail(`Unknown Bot ${id} in the allowed list`); continue }
    ids.push(id)
  }
  return value.mode === 'selected' ? { mode: 'selected', allow: ids } : { mode: value.mode, ...(ids.length > 0 ? { allow: ids } : {}) }
}

// Brings every saved policy up to date: unreadable ones go (back to legacy) and deleted
// Bots leave the allowed lists. Returns whether anything changed.
export function normalizeResponsePolicies(state) {
  const live = new Set(Object.keys(state.bots ?? {}))
  let changed = false
  const fix = (owner, selfId) => {
    if (owner.botResponse === undefined) return
    const next = cleanResponsePolicy(owner.botResponse, live, { selfId })
    if (next === undefined) delete owner.botResponse
    else if (JSON.stringify(next) === JSON.stringify(owner.botResponse)) return
    else owner.botResponse = next
    changed = true
  }
  for (const [id, bot] of Object.entries(state.bots ?? {})) if (isObject(bot)) fix(bot, id)
  for (const room of Object.values(state.rooms ?? {})) if (isObject(room)) fix(room)
  return changed
}

// The new policy value for a patch: undefined leaves it, null clears it back to the
// legacy default.
export const policyPatch = (patch, live, selfId) => (patch === undefined ? undefined : patch === null ? null : cleanResponsePolicy(patch, live, { selfId, strict: true }))

// One policy's answer for a sender.
function ruleOf(policy, senderId) {
  if (policy === undefined) return { allow: true, rule: 'legacy' }
  if (policy.mode === 'all') return { allow: true, rule: 'all' }
  if (policy.mode === 'off') return { allow: false, rule: 'off' }
  return (policy.allow ?? []).includes(senderId) ? { allow: true, rule: 'selected' } : { allow: false, rule: 'not-selected' }
}

// The decision, from the policies alone.
//   sender     the Bot ID that wrote the message; undefined is the user
//   recipient  the Bot that would start a turn
//   room       the group, when the message is a group call
//   result     the message answers work the recipient itself handed out
export function decideBotResponse({ sender, recipient, room, result = false }) {
  if (sender === undefined || sender === null) return { allow: true, reason: 'human', explicit: false }
  if (recipient === undefined) return { allow: false, reason: 'unknown-recipient', explicit: false }
  if (sender === recipient.id) return { allow: false, reason: 'self-reply', explicit: false }
  if (result) return { allow: true, reason: 'result-to-requester', explicit: false }
  const mine = ruleOf(recipient.botResponse, sender)
  const group = room === undefined ? { allow: true, rule: 'legacy' } : ruleOf(room.botResponse, sender)
  const explicit = recipient.botResponse !== undefined || (room !== undefined && room.botResponse !== undefined)
  if (!mine.allow) return { allow: false, reason: `recipient-${mine.rule}`, explicit, by: 'recipient' }
  if (!group.allow) return { allow: false, reason: `group-${group.rule}`, explicit, by: 'group' }
  return { allow: true, reason: explicit ? `allowed-${mine.rule === 'legacy' ? group.rule : mine.rule}` : 'legacy', explicit }
}

const digest = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
const findingKey = finding => (finding?.pr && finding.commit && finding.id ? `${finding.pr}#${finding.commit}#${finding.id}` : undefined)
export const findingOf = ({ pr, commit, id } = {}) => {
  const clean = value => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 120) : undefined)
  const finding = { pr: clean(pr), commit: clean(commit), id: clean(id) }
  return findingKey(finding) === undefined ? undefined : finding
}

export function install(rt) {
  // What was logged and decided, kept in memory: ids, reasons and a digest of the
  // message, never its words.
  const log = []
  const logged = new Set()
  const warned = new Map()
  // Events and findings the gate already let through. Memory only: a restart starts
  // them fresh, and the group guards (the idle relay limit) hold on their own.
  const seen = new Set()
  const attempts = new Map()

  const nameOf = id => rt.botOf?.(id)?.name

  const record = (entry, key) => {
    if (key !== undefined) {
      const mark = `${key}|${entry.allow}|${entry.reason}`
      if (logged.has(mark)) return
      logged.add(mark)
      if (logged.size > SEEN_MAX) logged.delete(logged.values().next().value)
    }
    log.push({ at: Date.now(), ...entry })
    if (log.length > LOG_MAX) log.shift()
    if (!entry.allow) {
      const id = `${entry.from}|${entry.to}|${entry.reason}`
      const last = warned.get(id) ?? 0
      if (Date.now() - last > WARN_EVERY_MS) {
        warned.set(id, Date.now())
        if (warned.size > 200) warned.delete(warned.keys().next().value)
        rt.warn?.('ds-bot: bot message from %s to %s did not start work (%s)%s', nameOf(entry.from) ?? entry.from, nameOf(entry.to) ?? entry.to, entry.reason, entry.room ? ` in ${entry.room}` : '')
      }
    }
  }

  // Whether a Bot-originated message may start `recipient`'s turn. Without side effects
  // beyond the log, which keeps one line per message and decision, so a message looked at
  // twice is logged once.
  //   named    the message names the recipient (@Name, or message_bot's target)
  //   idle     the message is only thanks or a status echo
  //   chain    the Bots that already called the sender in this round or chain
  //   event    the message's own identity (a request name, a log line), for duplicates
  //   finding  structured review finding {pr, commit, id}
  //   text     only digested, to tell a repeat of an unchanged finding
  function check({ sender, recipient, room, result = false, named = true, idle = false, chain = [], event, finding, text, kind = 'message' }) {
    const decision = decideBotResponse({ sender, recipient, room, result })
    let { allow, reason } = decision
    // The safeguards apply once the user chose a policy; the legacy default keeps the
    // behavior that was there before, guarded as before.
    if (allow && decision.explicit && sender !== undefined && sender !== null) {
      const key = findingKey(finding)
      if (!named) { allow = false; reason = 'no-designated-recipient' }
      else if (idle) { allow = false; reason = 'acknowledgment-or-status' }
      else if (chain.includes(recipient.id)) { allow = false; reason = 'circular-chain' }
      else if (event !== undefined && seen.has(`${sender}|${recipient.id}|${event}`)) { allow = false; reason = 'duplicate-event' }
      else if (key !== undefined && (attempts.get(key)?.count ?? 0) >= FINDING_ATTEMPT_LIMIT) { allow = false; reason = 'finding-attempt-limit' }
      else if (key !== undefined && text !== undefined && attempts.get(key)?.digest === digest(text)) { allow = false; reason = 'unchanged-finding' }
    }
    if (sender !== undefined && sender !== null) {
      record({ allow, reason, kind, from: sender, to: recipient?.id, ...(room ? { room: room.name } : {}), ...(finding ? { finding: findingKey(finding) } : {}) }, event === undefined ? `${sender}|${recipient?.id}|${room?.id ?? ''}|${kind}|${digest(text)}` : `${sender}|${recipient?.id}|${event}`)
    }
    return { allow, reason, explicit: decision.explicit }
  }

  // The message goes out: remember its identity and count the finding attempt.
  function commit({ sender, recipient, event, finding, text }) {
    if (sender === undefined || sender === null) return
    if (event !== undefined) {
      seen.add(`${sender}|${recipient.id}|${event}`)
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
    }
    const key = findingKey(finding)
    if (key === undefined) return
    attempts.set(key, { count: (attempts.get(key)?.count ?? 0) + 1, digest: digest(text) })
    if (attempts.size > FINDINGS_MAX) attempts.delete(attempts.keys().next().value)
  }

  rt.botResponse = { check, commit, decide: decideBotResponse, log: () => [...log], attemptsOf: finding => attempts.get(findingKey(finding))?.count ?? 0 }
}
