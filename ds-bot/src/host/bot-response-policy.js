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
// Returning a result and starting a model turn to process it are separate operations.
// User messages always pass. An automatic continuation counts against the task budget.
//
// Nothing here reads message text to guess at authority. A trigger is allowed because of
// who sent it, whom it names and, for review fixes, the structured finding it carries.

import { createHash, randomUUID } from 'node:crypto'

export const RESPONSE_MODES = ['off', 'selected', 'all']
// Automatic fix attempts per structured finding (PR, commit SHA, finding ID).
export const FINDING_ATTEMPT_LIMIT = 2

const LOG_MAX = 200
const LOGGED_MAX = 2000
export const BOT_TURN_LIMIT = 8
export const BOT_HOP_LIMIT = 6
const WARN_EVERY_MS = 60_000

// Bounded retention for the saved admission tables. Pending admissions (true or
// 'dispatched') are never dropped: a restart must still be able to finish work that was
// already authorized. A 'taken' event has served its purpose inside one turn, and a
// routing whose event is gone is refused by permitted(), so dropping the oldest terminal
// events cannot admit the same work again. Task budgets are kept across a wider window
// than events, and a task is touched on every admission, so a task whose event survives
// survives with its count. Findings are old commits and problem IDs; the newest window
// keeps the attempts that could still plausibly be retried.
export const BOT_ROUTING_KEEP = { events: 1000, tasks: 4000, findings: 2000 }

export function compactRouting(state, keep = BOT_ROUTING_KEEP) {
  const routing = state?.botRouting
  if (routing === null || typeof routing !== 'object' || Array.isArray(routing)) return 0
  const table = name => {
    const value = routing[name]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    routing[name] = {}
    return routing[name]
  }
  const events = table('events')
  const tasks = table('tasks')
  const findings = table('findings')
  let removed = 0
  const taken = Object.keys(events).filter(key => events[key] === 'taken')
  for (const key of taken.slice(0, Math.max(0, taken.length - keep.events))) {
    delete events[key]
    removed += 1
  }
  const taskKeys = Object.keys(tasks)
  for (const key of taskKeys.slice(0, Math.max(0, taskKeys.length - keep.tasks))) {
    delete tasks[key]
    removed += 1
  }
  const findingKeys = Object.keys(findings)
  for (const key of findingKeys.slice(0, Math.max(0, findingKeys.length - keep.findings))) {
    delete findings[key]
    removed += 1
  }
  return removed
}

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
export function decideBotResponse({ sender, recipient, room }) {
  if (sender === undefined || sender === null) return { allow: true, reason: 'human', explicit: false }
  if (recipient === undefined) return { allow: false, reason: 'unknown-recipient', explicit: false }
  if (sender === recipient.id) return { allow: false, reason: 'self-reply', explicit: false }
  const mine = ruleOf(recipient.botResponse, sender)
  const group = room === undefined ? { allow: true, rule: 'legacy' } : ruleOf(room.botResponse, sender)
  const explicit = recipient.botResponse !== undefined || (room !== undefined && room.botResponse !== undefined)
  if (!mine.allow) return { allow: false, reason: `recipient-${mine.rule}`, explicit, by: 'recipient' }
  if (!group.allow) return { allow: false, reason: `group-${group.rule}`, explicit, by: 'group' }
  return { allow: true, reason: explicit ? `allowed-${mine.rule === 'legacy' ? group.rule : mine.rule}` : 'legacy', explicit }
}

const digest = text => createHash('sha256').update(String(text ?? '')).digest('hex')
const findingKey = finding => (finding?.pr && finding.commit && finding.id ? digest(JSON.stringify([finding.pr, finding.commit, finding.id])) : undefined)
export const findingOf = ({ pr, commit, id } = {}) => {
  const clean = value => (typeof value === 'string' && value.trim() !== '' && value.trim().length <= 120 ? value.trim() : undefined)
  const sha = clean(commit)
  if (!/^[0-9a-f]{7,64}$/i.test(sha ?? '')) return undefined
  const finding = { pr: clean(pr)?.toLowerCase(), commit: sha.toLowerCase(), id: clean(id) }
  return findingKey(finding) === undefined ? undefined : finding
}

export class BotResponseRefusal extends Error {
  constructor(reason, recipient, sender, room, { reviewFix = false } = {}) {
    const accepts = recipient?.responsibility?.categories
    const category = reason === 'task-category-required' || reason === 'task-category-not-permitted'
    const accepted = Array.isArray(accepts) && accepts.length > 0 ? accepts.join(', ') : ''
    // A category refusal is only useful if the sender learns what would pass. A review
    // fix is sent as coding whatever the sender writes, so pointing it at task_category
    // would send it round the same refusal again.
    const hint = !category
      ? ''
      : reviewFix
        ? ` A review fix is sent as coding${accepted ? `; ${recipient.name} accepts: ${accepted}` : ''}.`
        : accepted ? ` ${recipient.name} accepts: ${accepted}. Set task_category to one of them.` : ''
    super(`Not sent: ${recipient?.name ?? 'The recipient'}${room ? ` in "${room.name}"` : ''} does not take automatic messages from ${sender?.name ?? 'another Bot'} (${reason}). No turn was started.${hint}`)
    this.reason = reason
  }
}

const reviewerOf = bot => bot?.responsibility?.preset === 'reviewer' || /^(?:code )?review(?:er)?$/i.test(bot?.role ?? '')
const codingOf = bot => bot?.responsibility?.categories.includes('coding') === true || /^(?:coder|coding agent|code)$/i.test(bot?.role ?? '')
const taskKinds = new Set(['message_bot', 'request', 'room', 'group-turn', 'call', 'post'])

export function reviewFixOf(text, action, finding) {
  return action === 'review_fix' || finding !== undefined
    || /\b(?:fix|address|resolve|remediate|apply)\b[^.!?\n]{0,80}\b(?:findings?|review (?:comments?|feedback)|reviewers?(?:'s)? comments?)\b/i.test(text ?? '')
}

export const newTaskContext = () => ({ task: randomUUID(), hops: 0 })

export function install(rt) {
  const state = rt.state ?? {}
  const safety = () => (state.botRouting ??= { events: {}, findings: {}, tasks: {} })
  const log = []
  const logged = new Set()
  const warned = new Map()
  let writing = Promise.resolve()
  const eventKey = (sender, recipient, room, event) => digest(JSON.stringify([sender, recipient.id, room?.id ?? '', event]))

  const nameOf = id => rt.botOf?.(id)?.name

  const record = (entry, key) => {
    if (key !== undefined) {
      const mark = `${key}|${entry.allow}|${entry.reason}`
      if (logged.has(mark)) return
      logged.add(mark)
      if (logged.size > LOGGED_MAX) logged.delete(logged.values().next().value)
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

  function check({ sender, recipient, room, result = false, named = true, idle = false, chain = [], event, finding, reviewFix = false, category, text, kind = 'message', parent, continuation = false }) {
    const decision = decideBotResponse({ sender, recipient, room })
    let { allow, reason } = decision
    if (allow && sender != null) {
      const key = findingKey(finding)
      const { events, findings, tasks } = safety()
      const prior = findings[key]
      if (!result && decision.explicit && !named) reason = 'no-designated-recipient'
      else if (!result && decision.explicit && idle) reason = 'acknowledgment-or-status'
      else if (!result && decision.explicit && chain.includes(recipient.id)) reason = 'circular-chain'
      else if (event !== undefined && events[eventKey(sender, recipient, room, event)]) reason = 'duplicate-event'
      else if (!continuation && key === undefined
        && (reviewFix || (!result && taskKinds.has(kind) && reviewerOf(rt.botOf?.(sender)) && (category === 'coding' || codingOf(recipient))))) reason = 'finding-identity-required'
      // A responsibility preset names the work its Bot takes. The sender states the
      // category; an omitted one is refused with the accepted list, so it is never
      // silently read as a category the recipient rejects.
      else if (!result && !continuation && recipient.responsibility) {
        if (category === undefined) reason = 'task-category-required'
        else if (!recipient.responsibility.categories.includes(category)) reason = 'task-category-not-permitted'
      }
      else if (key !== undefined && (prior?.count ?? 0) >= FINDING_ATTEMPT_LIMIT) reason = 'finding-attempt-limit'
      else if (key !== undefined && prior?.digest === digest(text)) reason = 'unchanged-finding'
      else if ((parent?.hops ?? 0) + (continuation ? 0 : 1) > BOT_HOP_LIMIT) reason = 'chain-hop-limit'
      else if ((tasks[parent?.task] ?? 0) >= BOT_TURN_LIMIT) reason = 'task-turn-limit'
      allow = reason === decision.reason
    }
    if (sender != null) {
      record({ allow, reason, kind, from: sender, to: recipient?.id, ...(room ? { room: room.name } : {}), ...(finding ? { finding: findingKey(finding) } : {}) },
        JSON.stringify([sender, recipient?.id, room?.id, event ?? [kind, digest(text)]]))
    }
    return { allow, reason, explicit: decision.explicit }
  }

  // Serialize check and write together. A crash after the write burns the reservation,
  // so an outcome that might already have reached an inbox cannot start work twice.
  function reserve(options) {
    const run = writing.then(async () => {
      const { sender, recipient, room, finding, text, parent, continuation } = options
      const event = options.event ?? randomUUID()
      const decision = check({ ...options, event })
      if (!decision.allow || sender == null) return decision
      const { events, findings, tasks } = safety()
      const key = eventKey(sender, recipient, room, event)
      const task = parent?.task ?? randomUUID()
      const priorTrail = parent?.trail ?? []
      const trail = continuation ? priorTrail : options.result ? priorTrail.slice(0, -1) : [...priorTrail, sender]
      const routing = {
        task, key, sender, recipient: recipient.id, trail, hops: (parent?.hops ?? 0) + (continuation ? 0 : 1),
        ...(options.category === undefined ? {} : { category: options.category }), result: options.result === true,
        ...(room ? { roomId: room.id } : {}),
        ...(options.roomMember ? { roomMember: true } : {}),
        ...(continuation ? { continuation: true } : {}),
      }
      const attempt = findingKey(finding)
      events[key] = true
      // Re-insert so insertion order stays last-use order for compaction.
      const turns = (tasks[task] ?? 0) + 1
      delete tasks[task]
      tasks[task] = turns
      if (attempt !== undefined) {
        const prior = findings[attempt]
        delete findings[attempt]
        findings[attempt] = { count: (prior?.count ?? 0) + 1, digest: digest(text) }
      }
      compactRouting(state)
      await rt.save?.({ required: true })
      return { ...decision, routing }
    })
    writing = run.catch(() => {})
    return run
  }

  const permitted = (routing, recipient) => {
    const room = rt.roomOf?.(routing.roomId)
    if (routing.recipient !== recipient?.id || !safety().events[routing.key]) return { allow: false, reason: 'unrecorded-admission' }
    if (routing.roomId !== undefined && (!room || (routing.roomMember && !room.members.includes(recipient.id)))) return { allow: false, reason: 'left-group' }
    const decision = decideBotResponse({ sender: routing.sender, recipient, room })
    // A continuation stays inside the task it already belongs to, so the recipient's
    // categories are not a second gate; the reserve that admitted it checked them for
    // new work, and a goal check or a resumed delivery must still reach its Bot.
    if (decision.allow && !routing.result && routing.continuation !== true && recipient.responsibility) {
      if (routing.category === undefined) return { allow: false, reason: 'task-category-required' }
      if (!recipient.responsibility.categories.includes(routing.category)) return { allow: false, reason: 'task-category-not-permitted' }
    }
    return decision
  }

  function advance(routing, previous, next) {
    const run = writing.then(async () => {
      const events = safety().events
      if (events[routing.key] !== previous) return false
      events[routing.key] = next
      await rt.save?.({ required: true })
      return true
    })
    writing = run.catch(() => {})
    return run
  }

  rt.botResponse = {
    check, reserve, permitted, decide: decideBotResponse, log: () => [...log],
    claim: routing => advance(routing, true, 'dispatched'),
    waiting: routing => safety().events[routing.key] === 'dispatched',
    take: routing => advance(routing, 'dispatched', 'taken'),
    attemptsOf: finding => safety().findings[findingKey(finding)]?.count ?? 0,
  }
}
