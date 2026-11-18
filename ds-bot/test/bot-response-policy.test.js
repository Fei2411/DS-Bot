import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOT_ROUTING_KEEP, BotResponseRefusal, cleanResponsePolicy, compactRouting, decideBotResponse, FINDING_ATTEMPT_LIMIT, findingOf, install, newTaskContext, normalizeResponsePolicies, policyPatch, reviewFixOf } from '../src/host/bot-response-policy.js'

const bot = (id, botResponse) => ({ id, name: id.toUpperCase(), ...(botResponse ? { botResponse } : {}) })

test('the user and the legacy default always pass; self-replies never do', () => {
  assert.deepEqual(decideBotResponse({ sender: undefined, recipient: bot('b', { mode: 'off' }) }).allow, true)
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b') }).reason, 'legacy')
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b') }).explicit, false)
  assert.deepEqual(decideBotResponse({ sender: 'b', recipient: bot('b', { mode: 'all' }) }), { allow: false, reason: 'self-reply', explicit: false })
})

test('off, selected and all decide by stable Bot ID', () => {
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'off' }) }).reason, 'recipient-off')
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'selected', allow: ['c'] }) }).reason, 'recipient-not-selected')
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'selected', allow: ['a'] }) }).allow, true)
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'all' }) }).allow, true)
  // A Bot's name is never a key: a Bot called like another's ID gets nothing.
  assert.equal(decideBotResponse({ sender: 'A', recipient: bot('b', { mode: 'selected', allow: ['a'] }) }).allow, false)
})

test('a group call needs both the recipient and the group to allow the sender', () => {
  const room = botResponse => ({ id: 'r', name: 'R', ...(botResponse ? { botResponse } : {}) })
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'all' }), room: room({ mode: 'off' }) }).reason, 'group-off')
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'off' }), room: room({ mode: 'all' }) }).reason, 'recipient-off')
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'selected', allow: ['a'] }), room: room({ mode: 'selected', allow: ['a'] }) }).allow, true)
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b'), room: room({ mode: 'selected', allow: [] }) }).reason, 'group-not-selected')
})

test('a model turn to process a result still requires permission', () => {
  assert.equal(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'off' }) }).allow, false)
})

test('policies are validated strictly from the user and read leniently from disk', () => {
  const live = new Set(['a', 'b'])
  assert.equal(cleanResponsePolicy(undefined, live), undefined)
  assert.equal(policyPatch(undefined, live), undefined)
  assert.equal(policyPatch(null, live), null)
  assert.deepEqual(policyPatch({ mode: 'selected', allow: ['a', 'a', 'b'] }, live, 'b'), { mode: 'selected', allow: ['a'] })
  assert.throws(() => policyPatch({ mode: 'maybe' }, live), /Response mode must be one of off, selected, all/)
  assert.throws(() => policyPatch({ mode: 'selected', allow: ['zzz'] }, live), /Unknown Bot zzz/)
  assert.throws(() => policyPatch({ mode: 'selected', allow: 'a' }, live), /list of Bot IDs/)
  assert.equal(cleanResponsePolicy({ mode: 'maybe' }, live), undefined)
  assert.deepEqual(cleanResponsePolicy({ mode: 'selected', allow: ['zzz', 'a', 7] }, live), { mode: 'selected', allow: ['a'] })
})

test('loading drops corrupt policies and deleted Bot IDs, and keeps the rest byte for byte', () => {
  const state = {
    bots: { a: { id: 'a' }, b: { id: 'b', botResponse: { mode: 'selected', allow: ['a', 'gone'] } }, c: { id: 'c', botResponse: 'nope' } },
    rooms: { r: { id: 'r', botResponse: { mode: 'all' } }, s: { id: 's', botResponse: { mode: 'selected', allow: ['gone'] } } },
  }
  assert.equal(normalizeResponsePolicies(state), true)
  assert.deepEqual(state.bots.b.botResponse, { mode: 'selected', allow: ['a'] })
  assert.equal(state.bots.c.botResponse, undefined)
  assert.deepEqual(state.rooms.r.botResponse, { mode: 'all' })
  assert.deepEqual(state.rooms.s.botResponse, { mode: 'selected', allow: [] })
  assert.equal(normalizeResponsePolicies(state), false, 'a clean state is left alone')
})

function gate(state = {}) {
  const warnings = []
  const rt = { state, warn: (...args) => warnings.push(args), botOf: id => ({ id, name: id.toUpperCase() }) }
  install(rt)
  return { check: rt.botResponse.check, reserve: rt.botResponse.reserve, claim: rt.botResponse.claim, log: rt.botResponse.log, warnings }
}

test('under a chosen policy the call must name its recipient and not be thanks or a status echo', () => {
  const { check } = gate()
  const recipient = bot('b', { mode: 'all' })
  assert.equal(check({ sender: 'a', recipient, named: false, text: 'x' }).reason, 'no-designated-recipient')
  assert.equal(check({ sender: 'a', recipient, idle: true, text: 'thanks!' }).reason, 'acknowledgment-or-status')
  assert.equal(check({ sender: 'a', recipient, text: 'please look' }).allow, true)
  // The legacy default is left to the guards that were always there.
  assert.equal(check({ sender: 'a', recipient: bot('b'), named: false, idle: true, text: 'thanks!' }).allow, true)
})

test('a chain that already includes the recipient is circular, and a Bot never answers itself', () => {
  const { check } = gate()
  const recipient = bot('a', { mode: 'all' })
  assert.equal(check({ sender: 'b', recipient, chain: ['a', 'b'], text: 'back to you' }).reason, 'circular-chain')
  assert.equal(check({ sender: 'a', recipient, text: 'me' }).reason, 'self-reply')
})

test('two changed attempts per finding survive a restart and missing identity is rejected', async () => {
  const state = {}
  let { check, reserve } = gate(state)
  const recipient = bot('b', { mode: 'all' })
  const finding = findingOf({ pr: '1', commit: 'abc1234', id: 'F' })
  const send = async text => (await reserve({ sender: 'a', recipient, finding, text })).reason
  assert.equal(await send('fix F'), 'allowed-all')
  ;({ check, reserve } = gate(JSON.parse(JSON.stringify(state))))
  assert.equal(await send('fix F'), 'unchanged-finding')
  assert.equal(await send('fix F with a null check'), 'allowed-all')
  assert.equal(await send('one more way'), 'finding-attempt-limit')
  assert.equal(FINDING_ATTEMPT_LIMIT, 2)
  assert.equal(findingOf({ pr: '1', commit: 'abc1234' }), undefined)
  assert.equal(check({ sender: 'a', recipient, reviewFix: true, text: 'fix F, PR 1 commit abc, again' }).reason, 'finding-identity-required')
})

test('an event runs once, and the log keeps reasons and a digest, not the message', async () => {
  const { check, reserve, log, warnings } = gate()
  const recipient = bot('b', { mode: 'all' })
  assert.equal(check({ sender: 'a', recipient, event: 'request:r1', text: 'secret plan: rm -rf' }).allow, true)
  await reserve({ sender: 'a', recipient, event: 'request:r1' })
  assert.equal(check({ sender: 'a', recipient, event: 'request:r1', text: 'secret plan: rm -rf' }).reason, 'duplicate-event')
  check({ sender: 'a', recipient: bot('c', { mode: 'off' }), text: 'secret plan: rm -rf' })
  assert.doesNotMatch(JSON.stringify(log()), /secret|rm -rf/)
  assert.doesNotMatch(JSON.stringify(warnings), /secret|rm -rf/)
  assert.ok(log().some(entry => entry.allow && entry.reason === 'allowed-all'))
  assert.ok(log().some(entry => !entry.allow && entry.reason === 'recipient-off'))
  // Looking at one message twice logs it once.
  const before = log().length
  check({ sender: 'a', recipient: bot('c', { mode: 'off' }), text: 'secret plan: rm -rf' })
  assert.equal(log().length, before)
})

test('concurrent admissions cannot exceed eight turns, and six hops is enforced after restarting', async () => {
  const state = {}
  const { reserve } = gate(state)
  const parent = newTaskContext()
  const decisions = await Promise.all(Array.from({ length: 12 }, (_, i) => reserve({ sender: 'a', recipient: bot('b'), parent, event: `child:${i}` })))
  assert.equal(decisions.filter(result => result.allow).length, 8)
  assert.deepEqual(decisions.slice(8).map(result => result.reason), Array(4).fill('task-turn-limit'))
  let chain = newTaskContext()
  for (let i = 0; i < 6; i += 1) {
    const decision = await reserve({ sender: 'a', recipient: bot('b'), parent: chain })
    assert.equal(decision.allow, true)
    chain = decision.routing
  }
  const reloaded = gate(JSON.parse(JSON.stringify(state)))
  assert.equal((await reloaded.reserve({ sender: 'a', recipient: bot('b'), parent: chain })).reason, 'chain-hop-limit')
  assert.equal((await reloaded.reserve({ sender: 'a', recipient: bot('b'), parent, event: 'after-restart' })).reason, 'task-turn-limit')
})

test('a persisted event can be dispatched once across restarts', async () => {
  const state = {}
  const first = gate(state)
  const options = { sender: 'a', recipient: bot('b'), event: 'persisted' }
  const { routing } = await first.reserve(options)
  assert.equal(await first.claim(routing), true)
  const second = gate(JSON.parse(JSON.stringify(state)))
  assert.equal(await second.claim(routing), false)
  assert.equal((await second.reserve(options)).reason, 'duplicate-event')
})

test('routing retention keeps pending admissions and bounds completed ones', () => {
  const state = { botRouting: { events: {}, tasks: {}, findings: {} } }
  const { events, tasks, findings } = state.botRouting
  for (let i = 0; i < BOT_ROUTING_KEEP.events + 2; i += 1) events[`done-${i}`] = 'taken'
  events.pending = true
  events.waiting = 'dispatched'
  for (let i = 0; i < BOT_ROUTING_KEEP.tasks + 2; i += 1) tasks[`task-${i}`] = 1
  for (let i = 0; i < BOT_ROUTING_KEEP.findings + 2; i += 1) findings[`finding-${i}`] = { count: 1, digest: 'x' }
  assert.ok(compactRouting(state) > 0)
  const terminal = Object.keys(events).filter(key => events[key] === 'taken')
  assert.equal(terminal.length, BOT_ROUTING_KEEP.events)
  assert.equal(events.pending, true, 'a reservation not yet dispatched survives')
  assert.equal(events.waiting, 'dispatched', 'a dispatched reservation survives')
  assert.equal(events['done-0'], undefined)
  assert.equal(events[`done-${BOT_ROUTING_KEEP.events + 1}`], 'taken')
  assert.equal(Object.keys(tasks).length, BOT_ROUTING_KEEP.tasks)
  assert.equal(tasks['task-0'], undefined)
  assert.equal(Object.keys(findings).length, BOT_ROUTING_KEEP.findings)
  assert.equal(findings['finding-0'], undefined)
  assert.equal(compactRouting({}), 0)
  assert.equal(compactRouting({ botRouting: null }), 0)
})

test('a routing whose completed event aged out is refused, never dispatched again', async () => {
  const state = {}
  const rt = { state, warn() {}, save: async () => {}, botOf: id => ({ id, name: id.toUpperCase() }), roomOf: () => undefined }
  install(rt)
  const recipient = bot('b')
  const { routing } = await rt.botResponse.reserve({ sender: 'a', recipient, event: 'old', parent: { task: 't', hops: 0 } })
  assert.equal(await rt.botResponse.claim(routing), true)
  assert.equal(await rt.botResponse.take(routing), true)
  for (let i = 0; i < BOT_ROUTING_KEEP.events + 1; i += 1) state.botRouting.events[`later-${i}`] = 'taken'
  compactRouting(state)
  assert.equal(state.botRouting.events[routing.key], undefined)
  assert.equal(rt.botResponse.waiting(routing), false)
  assert.equal(rt.botResponse.permitted(routing, recipient).reason, 'unrecorded-admission')
  assert.equal(await rt.botResponse.take(routing), false)
})

test('a responsibility preset requires a stated category and names the ones it accepts', async () => {
  const rt = { state: {}, save: async () => {}, warn() {}, botOf: id => ({ id, name: id }), roomOf: () => undefined }
  install(rt)
  const recipient = { id: 'b', name: 'Reviewer', responsibility: { preset: 'reviewer', categories: ['review'] } }
  assert.equal((await rt.botResponse.reserve({ sender: 'a', recipient, event: 'missing-category' })).reason, 'task-category-required')
  assert.equal((await rt.botResponse.reserve({ sender: 'a', recipient, event: 'coding-category', category: 'coding' })).reason, 'task-category-not-permitted')
  assert.match(new BotResponseRefusal('task-category-required', recipient, { name: 'Sender' }).message, /Reviewer accepts: review\. Set task_category/)
  // A review fix is sent as coding whatever the sender writes, so the hint names it.
  assert.match(new BotResponseRefusal('task-category-not-permitted', recipient, { name: 'Sender' }, undefined, { reviewFix: true }).message, /A review fix is sent as coding; Reviewer accepts: review\./)
  assert.doesNotMatch(new BotResponseRefusal('task-category-not-permitted', recipient, { name: 'Sender' }, undefined, { reviewFix: true }).message, /Set task_category/)
  const allowed = await rt.botResponse.reserve({ sender: 'a', recipient, event: 'review-category', category: 'review' })
  assert.equal(allowed.allow, true)
  assert.equal(allowed.routing.category, 'review')
  // A routing admitted without a category is refused when it is checked again.
  rt.state.botRouting.events.legacy = 'taken'
  assert.equal(rt.botResponse.permitted({ recipient: 'b', key: 'legacy', sender: 'a' }, recipient).reason, 'task-category-required')
})

test('a continuation is not gated again by the recipient categories', async () => {
  const rt = { state: {}, save: async () => {}, warn() {}, botOf: id => ({ id, name: id }), roomOf: () => undefined }
  install(rt)
  const recipient = { id: 'b', name: 'B', responsibility: { preset: 'coordinator', categories: ['coordination'] } }
  const decision = await rt.botResponse.reserve({ sender: 'a', recipient, event: 'goal-check', continuation: true, parent: { task: 't', hops: 0 } })
  assert.equal(decision.allow, true)
  assert.equal(decision.routing.continuation, true)
  assert.equal(rt.botResponse.permitted(decision.routing, recipient).allow, true)
  const fresh = { id: 'b', name: 'B', responsibility: { preset: 'coordinator', categories: ['coordination'] } }
  const refused = await rt.botResponse.reserve({ sender: 'a', recipient: fresh, event: 'coding-task', category: 'coding', parent: { task: 't', hops: 0 } })
  assert.equal(refused.reason, 'task-category-not-permitted')
})

test('a report of a finished fix is not a review-fix request; an imperative one is', () => {
  assert.equal(reviewFixOf('Fixed the review comments in parser.js'), false)
  assert.equal(reviewFixOf('I addressed the review comments'), false)
  assert.equal(reviewFixOf('Please fix the review findings.'), true)
  assert.equal(reviewFixOf('address the reviewer comments before merging'), true)
})
