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
  const { results, hasMore } = searchGroupBook(records, 'plan rollout')
  assert.equal(hasMore, false)
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

test('an empty query finds nothing and a longer book keeps the newest page', () => {
  assert.deepEqual(searchGroupBook([line(1, 'hello')], '   '), { results: [], hasMore: false })
  const records = Array.from({ length: 25 }, (_, index) => line(index + 1, `match number ${index + 1}`))
  const { results, hasMore } = searchGroupBook(records, 'match')
  assert.equal(hasMore, true)
  assert.equal(results.length, 20)
  assert.equal(results[0].seq, 25)
  assert.equal(results.at(-1).seq, 6)
})

test('exactly one page is not marked as having more', () => {
  const records = Array.from({ length: 20 }, (_, index) => line(index + 1, `match ${index + 1}`))
  const page = searchGroupBook(records, 'match')
  assert.equal(page.results.length, 20)
  assert.equal(page.hasMore, false)
  assert.equal(page.results[0].seq, 20)
  assert.equal(page.results.at(-1).seq, 1)
  assert.deepEqual(searchGroupBook(records, 'match', { offset: 20 }), { results: [], hasMore: false })
  assert.deepEqual(searchGroupBook(records, 'match', { before: 1 }), { results: [], hasMore: false })
})

test('one older hit past the page loads as a second page', () => {
  const records = Array.from({ length: 21 }, (_, index) => line(index + 1, `match ${index + 1}`))
  const first = searchGroupBook(records, 'match')
  assert.equal(first.results.length, 20)
  assert.equal(first.hasMore, true)
  assert.equal(first.results[0].seq, 21)
  assert.equal(first.results.at(-1).seq, 2)
  const older = searchGroupBook(records, 'match', { before: first.results.at(-1).seq })
  assert.equal(older.hasMore, false)
  assert.deepEqual(older.results.map(hit => hit.seq), [1])
  const byOffset = searchGroupBook(records, 'match', { offset: first.results.length })
  assert.equal(byOffset.hasMore, false)
  assert.deepEqual(byOffset.results.map(hit => hit.seq), [1])
})

test('a long line stays whole so the opened hit can show it', () => {
  const text = `${'x'.repeat(4_100)} needle`
  const beside = 'y'.repeat(4_500)
  const { results } = searchGroupBook([line(1, beside), line(2, text)], 'needle')
  assert.equal(results[0].text, text)
  assert.equal(results[0].before?.text, beside)
  assert.ok(results[0].text.endsWith('needle'))
})
