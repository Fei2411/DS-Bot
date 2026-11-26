import assert from 'node:assert/strict'
import test from 'node:test'
import { draftTextOf, keepDraftText } from './draft-text.ts'

test('each chat keeps its own unsent composer text', () => {
  const chief = 'computer-a:bot:chief'
  const coder = 'computer-a:bot:coder'
  const otherChief = 'computer-b:bot:chief'
  const draft = '  First line\nSecond line '

  keepDraftText(chief, draft)
  assert.equal(draftTextOf(coder), '')
  assert.equal(draftTextOf(otherChief), '')
  keepDraftText(coder, 'Coder draft')
  assert.equal(draftTextOf(chief), draft)

  keepDraftText(chief, '')
  assert.equal(draftTextOf(chief), '')
  assert.equal(draftTextOf(coder), 'Coder draft')
})
