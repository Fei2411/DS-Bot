// The phone's avatar badges follow the desktop's rule (ds-bot/src/client/mark.js
// BotAvatar: alert, then working, then admin, then main; the phone has no admin badge
// on a Bot's own avatar).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { badgeOf } from './badge.ts'

test('one badge at a time: waiting for you, then working, then the Main Bot star', () => {
  assert.equal(badgeOf({}), null)
  assert.equal(badgeOf({ main: true }), 'main')
  assert.equal(badgeOf({ working: true }), 'working')
  assert.equal(badgeOf({ waiting: true }), 'alert')
  // A Main Bot waiting for you shows the "?", not the star over it.
  assert.equal(badgeOf({ main: true, waiting: true }), 'alert')
  assert.equal(badgeOf({ main: true, working: true }), 'working')
  assert.equal(badgeOf({ main: true, working: true, waiting: true }), 'alert')
  assert.equal(badgeOf({ working: true, waiting: true }), 'alert')
})
