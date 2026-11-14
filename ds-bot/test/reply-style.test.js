import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_REPLY_STYLE, REPLY_STYLES, isReplyStyle, replyStyleOf, replyStyleText } from '../src/shared/reply-style.js'

test('every style has its own prompt section, and an unknown one falls back', () => {
  const texts = REPLY_STYLES.map(style => replyStyleText(style))
  assert.equal(new Set(texts).size, REPLY_STYLES.length)
  for (const text of texts) assert.match(text, /^## How you write\n/)
  assert.equal(replyStyleText('nonsense'), replyStyleText(DEFAULT_REPLY_STYLE))
  assert.equal(replyStyleText(undefined, 'formal'), replyStyleText('formal'))
})

test('a Bot follows the team unless it chose its own', () => {
  assert.equal(replyStyleOf(undefined, 'concise'), 'concise')
  assert.equal(replyStyleOf('detailed', 'concise'), 'detailed')
  assert.equal(replyStyleOf(undefined, undefined), DEFAULT_REPLY_STYLE)
  assert.equal(replyStyleText('formal', 'concise'), replyStyleText('formal'))
  assert.equal(isReplyStyle('natural'), true)
  assert.equal(isReplyStyle('inherit'), false)
})
