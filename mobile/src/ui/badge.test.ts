// The phone's avatar badges follow the desktop's rule (ds-bot/src/client/mark-states.js
// avatarBadge: alert, then working, then admin, then main; the phone has no admin badge
// on a Bot's own avatar).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avatarBadge } from '../../../ds-bot/src/client/mark-states.js'
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

test('state-driven badges match desktop avatarBadge and respect badge=false', () => {
  for (const state of ['thinking', 'searching', 'working', 'sending', 'orbit', 'done']) {
    assert.equal(badgeOf({ state, main: true }), 'working')
    assert.equal(avatarBadge(state, { main: true }), 'working')
  }
  assert.equal(badgeOf({ state: 'alert', main: true }), 'alert')
  for (const quiet of ['idle', 'waiting', 'background', 'failed', 'replied']) {
    assert.equal(badgeOf({ state: quiet, main: true }), 'main')
    assert.equal(badgeOf({ state: quiet, main: false }), null)
  }
  // Details panel and header pill suppress badges completely (ui-standard §8).
  assert.equal(badgeOf({ state: 'alert', main: true, badge: false }), null)
  assert.equal(badgeOf({ state: 'working', main: true, badge: false }), null)
  assert.equal(badgeOf({ state: 'idle', main: true, badge: false }), null)
})
