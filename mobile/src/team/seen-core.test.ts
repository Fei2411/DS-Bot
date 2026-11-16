import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSeen, seenKey } from './seen-core.ts'

test('read marks are keyed per computer', () => {
  assert.notEqual(seenKey('a'), seenKey('b'))
  assert.match(seenKey('a'), /^dsbot\.seenAt\./)
})

test('parseSeen tolerates bad and partial data', () => {
  assert.deepEqual(parseSeen(null), {})
  assert.deepEqual(parseSeen('not json'), {})
  assert.deepEqual(parseSeen('[1,2]'), {})
  assert.deepEqual(parseSeen('{"b1":1,"b2":"x","b3":null}'), { b1: 1 })
})
