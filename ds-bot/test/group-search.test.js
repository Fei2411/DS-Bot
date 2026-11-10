import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchGroupBook } from '../src/host/group-search.js'

const line = (seq, text, extra = {}) => ({ seq, time: 1_000 + seq, text, ...extra })

test('every word must match a line, newest first, with its neighbours', () => {
  const records = [
    line(1, 'The rollout plan is ready', { botId: 'b1', who: 'Kai' }),
    line(2, 'nothing here'),
    line(3, 'Plan: rollout review tomorrow', { botId: 'b2', who: 'Mira' }),
    line(4, 'PLAN only'),
  ]
  const { results, capped } = searchGroupBook(records, 'plan rollout')
  assert.equal(capped, false)
  assert.deepEqual(results.map(hit => hit.seq), [3, 1])
  assert.equal(results[0].name, 'Mira')
  assert.equal(results[0].botId, 'b2')
  assert.equal(results[0].before?.text, 'nothing here')
  assert.equal(results[0].after?.text, 'PLAN only')
  assert.equal(results[1].before, undefined)
  assert.equal(results[1].after?.text, 'nothing here')
})

test('matching ignores case and skips records without text', () => {
  const records = [
    line(1, 'Release Checklist done', { botId: 'b1' }),
    { seq: 2, time: 2, kind: 'notice', reason: 'paused' },
    line(3, 'review release checklist'),
  ]
  const { results } = searchGroupBook(records, 'RELEASE checklist')
  assert.deepEqual(results.map(hit => hit.seq), [3, 1])
  assert.equal(results[0].after, undefined)
})

test('an empty query finds nothing and the cap keeps the newest hits', () => {
  assert.deepEqual(searchGroupBook([line(1, 'hello')], '   '), { results: [], capped: false })
  const records = Array.from({ length: 25 }, (_, index) => line(index + 1, `match number ${index + 1}`))
  const { results, capped } = searchGroupBook(records, 'match')
  assert.equal(capped, true)
  assert.equal(results.length, 20)
  assert.equal(results[0].seq, 25)
  assert.equal(results.at(-1).seq, 6)
})

test('a very long line is cut for the reply', () => {
  const { results } = searchGroupBook([line(1, `${'x'.repeat(4_100)} needle`)], 'needle')
  assert.equal(results[0].text.length, 4_001)
  assert.ok(results[0].text.endsWith('…'))
})
