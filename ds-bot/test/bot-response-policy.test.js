import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanResponsePolicy, decideBotResponse, FINDING_ATTEMPT_LIMIT, findingOf, install, normalizeResponsePolicies, policyPatch } from '../src/host/bot-response-policy.js'

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

test('a result for the Bot that asked is not a new call, whatever the policy', () => {
  assert.deepEqual(decideBotResponse({ sender: 'a', recipient: bot('b', { mode: 'off' }), room: { id: 'r', botResponse: { mode: 'off' } }, result: true }).allow, true)
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

function gate() {
  const warnings = []
  const rt = { warn: (...args) => warnings.push(args), botOf: id => ({ id, name: id.toUpperCase() }) }
  install(rt)
  return { check: rt.botResponse.check, commit: rt.botResponse.commit, log: rt.botResponse.log, warnings }
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

test('a finding gets two automatic attempts and an unchanged one none; free text never counts as one', () => {
  const { check, commit } = gate()
  const recipient = bot('b', { mode: 'all' })
  const finding = findingOf({ pr: '1', commit: 'abc', id: 'F' })
  const send = text => {
    const decision = check({ sender: 'a', recipient, finding, text })
    if (decision.allow) commit({ sender: 'a', recipient, finding, text })
    return decision.reason
  }
  assert.equal(send('fix F'), 'allowed-all')
  assert.equal(send('fix F'), 'unchanged-finding')
  assert.equal(send('fix F with a null check'), 'allowed-all')
  assert.equal(send('one more way'), 'finding-attempt-limit')
  assert.equal(FINDING_ATTEMPT_LIMIT, 2)
  // Without all three parts there is no finding, so nothing is inferred from the words.
  assert.equal(findingOf({ pr: '1', commit: 'abc' }), undefined)
  assert.equal(check({ sender: 'a', recipient, text: 'fix F, PR 1 commit abc, again' }).allow, true)
})

test('an event runs once, and the log keeps reasons and a digest, not the message', () => {
  const { check, commit, log, warnings } = gate()
  const recipient = bot('b', { mode: 'all' })
  assert.equal(check({ sender: 'a', recipient, event: 'request:r1', text: 'secret plan: rm -rf' }).allow, true)
  commit({ sender: 'a', recipient, event: 'request:r1' })
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
