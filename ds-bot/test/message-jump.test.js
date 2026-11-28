import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findMessageRow, messageJumpTarget } from '../src/client/message-jump.js'

test('a palette response hit prefers the reply when its prompt has the same text', () => {
  const snippet = 'Repeat this phrase'
  const row = role => ({
    textContent: snippet,
    getAttribute: name => name === 'data-bt-message-session' ? 'session' : role,
  })
  const prompt = row('prompt')
  const reply = row('response')
  const root = { querySelectorAll: () => [prompt, reply] }
  const target = messageJumpTarget('session', { turn: 6, snippet, role: 'response' })
  assert.equal(findMessageRow(root, target), reply)
  assert.equal(findMessageRow(root, { ...target, synthetic: true }), reply)
  assert.equal(findMessageRow(root, { ...target, role: 'prompt' }), prompt)
  assert.equal(findMessageRow({ querySelectorAll: () => [prompt] }, target, false), undefined)
  assert.equal(findMessageRow(root, { ...target, snippet: 'not rendered' }), prompt)
  assert.equal(findMessageRow(root, { ...target, snippet: 'not rendered' }, false), undefined)
})
