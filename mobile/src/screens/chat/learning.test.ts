import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { learningForChat } from './learning.ts'

const proposals = [{ id: 'skill', botId: 'b' }, { id: 'agents', botId: 'b', kind: 'agents' }]
test('current chat keeps every pending learning proposal, even after follow-ups', () => {
  assert.deepEqual(learningForChat({ b: proposals }, 'b', 'part', 'part'), proposals)
})
test('handled, absent and historical proposals take no pending space', () => {
  assert.deepEqual(learningForChat({ b: [] }, 'b', 'part', 'part'), [])
  assert.deepEqual(learningForChat(undefined, 'b', 'part', 'part'), [])
  assert.deepEqual(learningForChat({ b: proposals }, 'b', 'part', 'old'), [])
  assert.deepEqual(learningForChat({ b: proposals }, undefined, undefined, 'room'), [])
})
test('learning proposals are wired into the pending dock and refresh gate', () => {
  const chat = readFileSync(new URL('../Chat.tsx', import.meta.url), 'utf8')
  assert.match(chat, /hasChatPending[^\n]*learning.length > 0/)
  assert.match(chat, /<Dock[^\n]*learning=\{learning\}/)
  const dock = readFileSync(new URL('./dock.tsx', import.meta.url), 'utf8')
  assert.match(dock, /call\('learning-answer', \{ id: proposal.id, approve \}\)/)
  assert.match(dock, /catch \(failure\).*setError/)
})
