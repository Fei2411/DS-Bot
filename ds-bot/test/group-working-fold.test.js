import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stackReplies } from '../src/shared/group-replies.js'

const working = (botId, time) => ({ kind: 'working', botId, name: botId, time })
const approval = botId => ({ kind: 'approval', botId, name: botId })
const done = botId => ({ kind: 'done', botId, name: botId })
const message = (botId, text) => ({ botId, name: botId, text, time: 5 })
const kinds = items => items.map(item => item.reply.kind ?? 'message')

// A busy Bot can start many turns in a row: the group writes one "started on it" row
// per turn, and the chat showed 18 identical rows for one Bot in the real report.
test('consecutive working rows for one Bot fold into the first', () => {
  const rows = Array.from({ length: 18 }, (_, index) => working('pixwee', 100 + index))
  const items = stackReplies(rows)
  assert.equal(items.length, 1)
  assert.equal(items[0].reply.kind, 'working')
  assert.equal(items[0].reply.botId, 'pixwee')
  assert.equal(items[0].reply.time, 100, 'the folded row keeps the first start, not the last wake-up')
})

test('a message between two working rows keeps both starts visible', () => {
  const items = stackReplies([working('pixwee'), message('other', 'hello'), working('pixwee')])
  assert.deepEqual(kinds(items), ['working', 'message', 'working'])
})

test('an approval row is information, so it breaks the working run', () => {
  const items = stackReplies([working('pixwee'), approval('pixwee')])
  assert.deepEqual(kinds(items), ['working', 'approval'])
})

test('two Bots starting one after the other do not fold into one row', () => {
  const items = stackReplies([working('pixwee'), working('writer')])
  assert.deepEqual(kinds(items), ['working', 'working'])
})

test('a finished row between starts ends the run', () => {
  const items = stackReplies([working('pixwee'), done('pixwee'), working('pixwee')])
  assert.deepEqual(kinds(items), ['working', 'done', 'working'])
})

// The live cell re-reads the same round while it works; once the first message lands
// the folded start of the next run must still be one row, not the old stack back again.
test('a later message leaves the following consecutive starts folded', () => {
  const items = stackReplies([
    working('pixwee'), working('pixwee'), message('pixwee', 'one'),
    working('pixwee'), working('pixwee'), working('pixwee'), message('pixwee', 'two'),
  ])
  assert.deepEqual(kinds(items), ['working', 'message', 'working', 'message'])
  assert.equal(items.filter(item => item.reply.kind === 'working').length, 2)
})

test('a start row without a bot id is not folded into another Bot', () => {
  const items = stackReplies([{ kind: 'working', name: 'Writer' }, { kind: 'working', name: 'Writer' }])
  assert.equal(items.length, 2)
})
