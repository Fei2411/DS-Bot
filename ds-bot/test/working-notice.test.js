import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkingNotices } from '../src/shared/working-notice.js'

// A member's "started on it" row is a state: the same episode is noted once, and the
// note ends when the member reports.
test('one notice per working episode', () => {
  const notices = createWorkingNotices({ ttlMs: 60_000 })
  assert.equal(notices.seen('room', 'bot'), false)
  notices.note('room', 'bot', 1000)
  assert.equal(notices.seen('room', 'bot', 2000), true)
  notices.clear('room', 'bot')
  assert.equal(notices.seen('room', 'bot', 2000), false)
})

test('the note lapses on its own, and rooms and members keep their own', () => {
  const notices = createWorkingNotices({ ttlMs: 60_000 })
  notices.note('room-a', 'bot', 1000)
  assert.equal(notices.seen('room-a', 'bot', 61_001), false)
  assert.equal(notices.seen('room-b', 'bot', 2000), false)
  assert.equal(notices.seen('room-a', 'other', 2000), false)
  assert.equal(notices.seen('room-a', 'bot', 60_999), true)
})
