import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchGroupBook } from '../src/host/group-search.js'
import { install } from '../src/host/ledger.js'
import { searchTextFor } from '../src/host/search-text.js'

// Frozen search behavior before the lowercase cache.
function oldGroupSearch(records, query, options) {
  const lineOf = record => {
    if (typeof record?.text !== 'string' || record.text.trim() === '') return undefined
    const line = { seq: record.seq, time: record.time, text: record.text }
    if (record.botId !== undefined) line.botId = record.botId
    if (record.who !== undefined) line.name = record.who
    return line
  }
  const terms = [...new Set(String(query ?? '').toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean))].slice(0, 8)
  if (terms.length === 0) return { results: [], hasMore: false }
  const page = options ?? {}
  const offset = Number.isInteger(page.offset) && page.offset > 0 ? page.offset : 0
  const before = Number.isInteger(page.before) ? page.before : undefined
  const results = []
  let skipped = 0
  let hasMore = false
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = records[at]
    if (before !== undefined && !(Number.isInteger(record?.seq) && record.seq < before)) continue
    const text = typeof record?.text === 'string' ? record.text.toLowerCase() : ''
    if (text === '' || !terms.every(term => text.includes(term))) continue
    const hit = lineOf(record)
    if (hit === undefined) continue
    if (skipped < offset) {
      skipped += 1
      continue
    }
    if (results.length === 20) {
      hasMore = true
      break
    }
    results.push({ ...hit, before: at > 0 ? lineOf(records[at - 1]) : undefined, after: at + 1 < records.length ? lineOf(records[at + 1]) : undefined })
  }
  return { results, hasMore }
}

function oldLedgerSearch(records, query, pick = record => record.text) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return records.filter(record => {
    const text = pick(record)
    return typeof text === 'string' && words.every(word => text.toLowerCase().includes(word))
  }).slice(-20).reverse()
}

test('cached group and ledger searches match the old implementations across queries and pages', () => {
  const records = Array.from({ length: 105 }, (_, at) => ({
    seq: at + 1, time: at, botId: 'bot', who: 'Bot',
    text: ['Launch PLAN café 中文 İ Σ 😀', '  ', undefined, 42, 'other launch'][at % 5],
    alternate: at % 2 ? 'Custom TEXT' : undefined,
  }))
  const rt = { home: '/unused-search-cache', readOnly: () => 'read only' }
  install(rt)
  rt.ledger.records('group-test').push(...records)
  const queries = [undefined, '', ' \t ', 'LAUNCH', 'plan launch', 'café', '中文', 'İ', 'Σ', '😀', 'missing', 'launch launch', 'x'.repeat(201), 'a b c d e f g h i']
  for (let pass = 0; pass < 2; pass += 1) {
    for (const query of queries) {
      for (const options of [undefined, { offset: 20 }, { offset: 40 }, { offset: -1 }, { before: 60 }, { before: 1 }, { before: '60' }]) {
        assert.deepEqual(searchGroupBook(records, query, options), oldGroupSearch(records, query, options))
      }
      let before
      do {
        const page = searchGroupBook(records, query, { before })
        assert.deepEqual(page, oldGroupSearch(records, query, { before }))
        before = page.hasMore ? page.results.at(-1).seq : undefined
      } while (before !== undefined)
      assert.deepEqual(rt.ledger.search('group-test', query), oldLedgerSearch(records, query))
      const pick = record => record.alternate
      assert.deepEqual(rt.ledger.search('group-test', query, pick), oldLedgerSearch(records, query, pick))
    }
  }
  records[0].text = 'Changed TEXT'
  records[1].text = 'Changed TEXT'
  records.push({ seq: 106, text: 'Changed TEXT' })
  rt.ledger.append('group-test', records.at(-1))
  for (const query of ['launch', 'changed text', 'custom']) {
    assert.deepEqual(searchGroupBook(records, query), oldGroupSearch(records, query))
    assert.deepEqual(rt.ledger.search('group-test', query), oldLedgerSearch(records, query))
  }
  records[0].text = undefined
  assert.deepEqual(searchGroupBook(records, 'changed'), oldGroupSearch(records, 'changed'))
  assert.deepEqual(rt.ledger.search('group-test', 'changed'), oldLedgerSearch(records, 'changed'))
  assert.deepEqual(searchGroupBook([], 'launch'), oldGroupSearch([], 'launch'))
  assert.deepEqual(rt.ledger.search('group-empty', 'launch'), [])
  assert.throws(() => rt.ledger.search('group-test', 'text', () => { throw new Error('pick failed') }), /pick failed/)
})

test('unchanged record text is lowercased once and changed text refreshes the cache', () => {
  const record = { text: 'Original' }
  const lower = searchTextFor([record])
  const original = String.prototype.toLowerCase
  let calls = 0
  String.prototype.toLowerCase = function () { calls += 1; return original.call(this) }
  try {
    assert.equal(lower(0, record.text), 'original')
    assert.equal(lower(0, record.text), 'original')
    assert.equal(calls, 1)
    record.text = 'Updated'
    assert.equal(lower(0, record.text), 'updated')
    assert.equal(calls, 2)
  } finally {
    String.prototype.toLowerCase = original
  }
})

test('cached slots follow reordering, prepends, removed text and changing ledger pickers', () => {
  const rt = { home: '/unused-search-cache-slots', readOnly: () => 'read only' }
  install(rt)
  rt.ledger.append('group-test', { seq: 2, text: 'First MATCH', alternate: 'Other MATCH' })
  rt.ledger.append('group-test', { seq: 3, text: 'Second MATCH', alternate: 42 })
  const check = () => {
    const records = rt.ledger.records('group-test')
    for (const query of ['first', 'second', 'earlier', 'other', 'match']) {
      assert.deepEqual(searchGroupBook(records, query), oldGroupSearch(records, query))
      for (const pick of [record => record.text, record => record.alternate]) {
        assert.deepEqual(rt.ledger.search('group-test', query, pick), oldLedgerSearch(records, query, pick))
      }
    }
  }
  check()
  rt.ledger.records('group-test').reverse()
  check()
  rt.ledger.prepend('group-test', [{ seq: 1, text: 'Earlier MATCH' }])
  check()
  rt.ledger.records('group-test')[0].text = undefined
  rt.ledger.records('group-test')[1].alternate = 'First MATCH'
  check()
  rt.ledger.records('group-test').splice(0, 2)
  check()
  rt.ledger.drop('group-test')
  rt.ledger.append('group-test', { seq: 1, text: 'Other MATCH' })
  check()
})

test('opening, appending and prepending do not lowercase records before a search', () => {
  const rt = { home: '/unused-search-cache-lazy', readOnly: () => 'read only' }
  install(rt)
  const texts = ['Lazy FIRST', 'Lazy SECOND', 'Lazy EARLIER', 'Lazy APPENDED']
  const original = String.prototype.toLowerCase
  let calls = 0
  String.prototype.toLowerCase = function () {
    if (texts.includes(String(this))) calls += 1
    return original.call(this)
  }
  try {
    rt.ledger.records('group-test')
    rt.ledger.append('group-test', { seq: 2, text: texts[0] })
    rt.ledger.append('group-test', { seq: 3, text: texts[1] })
    rt.ledger.prepend('group-test', [{ seq: 1, text: texts[2] }])
    assert.equal(calls, 0)
    searchGroupBook(rt.ledger.records('group-test'), 'lazy')
    assert.equal(calls, 3)
    rt.ledger.search('group-test', 'lazy')
    assert.equal(calls, 3)
    rt.ledger.append('group-test', { seq: 4, text: texts[3] })
    assert.equal(calls, 3)
    rt.ledger.search('group-test', 'lazy')
    assert.equal(calls, 4)
  } finally {
    String.prototype.toLowerCase = original
  }
})
