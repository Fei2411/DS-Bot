import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerFailure, answerKeepsCard, proposalCards, withoutEntry } from '../src/client/learning-card-model.js'

// A skill proposal card that failed to answer once stays in the chat only while another
// try could work. `bot/stale` says the host no longer holds the proposal, so the card has
// to go instead of being pinned forever (#1339).
const proposal = (id, at = 100) => ({ id, botId: 'bot-1', at, name: `skill-${id}`, kind: 'skill', action: 'create', content: 'Check the tests' })
const stale = () => Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' })
const network = () => Object.assign(new Error('Could not reach DSH. Check that it is still running.'), { code: 'NETWORK' })

test('a stale answer is forgotten instead of being kept for a retry', () => {
  assert.equal(answerKeepsCard(stale()), false)
  const record = answerFailure({}, proposal('p1'), stale())
  assert.deepEqual(record, {})
})

test('a failure that could pass on a retry is recorded on its card', () => {
  assert.equal(answerKeepsCard(network()), true)
  const record = answerFailure({}, proposal('p2'), network())
  assert.deepEqual(Object.keys(record), ['p2'])
  assert.equal(record.p2.error, 'Could not reach DSH. Check that it is still running.')
  assert.equal(record.p2.proposal.id, 'p2')
})

test('a card that failed for a real reason, then went stale, ends up remembered by neither', () => {
  let record = answerFailure({}, proposal('p3'), Object.assign(new Error('A skill named skill-p3 exists now'), { code: 'bot/refused' }))
  assert.deepEqual(Object.keys(record), ['p3'])
  record = answerFailure(record, proposal('p3'), stale())
  assert.deepEqual(record, {})
  assert.deepEqual(proposalCards({ proposals: [], failures: record }), [])
})

test('a stale answer leaves no card behind once the host stops listing the proposal', () => {
  const cards = proposalCards({ proposals: [], settled: [], failures: answerFailure({}, proposal('p4'), stale()) })
  assert.deepEqual(cards, [])
})

test('a failure another try could pass keeps its card even though the host stopped listing it', () => {
  const cards = proposalCards({ proposals: [], settled: [], failures: answerFailure({}, proposal('p5'), network()) })
  assert.deepEqual(cards.map(card => card.id), ['p5'])
})

test('the host’s own proposals and its settled ones are drawn as before', () => {
  const cards = proposalCards({
    proposals: [proposal('p6', 300)],
    settled: [{ ...proposal('p7', 100), outcome: 'approved' }, { ...proposal('p6', 300), outcome: 'declined' }],
  })
  // A waiting copy of the same card wins over its settled row, and the order is by time.
  assert.deepEqual(cards.map(card => card.id), ['p7', 'p6'])
  assert.equal(cards[0].outcome, 'approved')
  assert.equal(cards[1].outcome, undefined)
})

test('a long run of stale answers leaves nothing to remember or draw', () => {
  let record = {}
  const failures = Array.from({ length: 200 }, (_, index) => proposal(`bulk-${index}`, index))
  for (const item of failures) record = answerFailure(record, item, network())
  assert.equal(Object.keys(record).length, 200)
  for (const item of failures) record = answerFailure(record, item, stale())
  assert.deepEqual(record, {})
  assert.deepEqual(proposalCards({ proposals: [], failures: record }), [])
})

test('a record without one entry keeps the rest, and returns itself when nothing changed', () => {
  const record = { a: 1, b: 2 }
  assert.deepEqual(withoutEntry(record, 'a'), { b: 2 })
  assert.equal(withoutEntry(record, 'missing'), record)
})
