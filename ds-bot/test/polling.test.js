import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLL_MAX_MS, needsIdleSample, pollDelay } from '../src/client/polling.js'

// #1462: an idle window kept asking the host every 1.5 s and, in the desktop app, reading
// the OS idle time every 2 s, so the renderer serialised values over IPC for nothing.
test('the state poll stretches while nothing changes and snaps back when something does', () => {
  // Something changed: the visible cadence stays.
  assert.equal(pollDelay(1500, 0), 1500)
  // Then it stretches, and stops at the cap however long the window sits still.
  assert.equal(pollDelay(1500, 1), 3000)
  assert.equal(pollDelay(1500, 2), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 3), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 99), POLL_MAX_MS)
  // A hidden window already polls more slowly than the cap: it keeps its own cadence.
  assert.equal(pollDelay(10_000, 0), 10_000)
  assert.equal(pollDelay(10_000, 5), 10_000)
  // A negative or missing count is the same as none.
  assert.equal(pollDelay(1500, -3), 1500)
})

test('the OS idle time is read while a Bot has foreground control or waits for idle', () => {
  assert.equal(needsIdleSample(undefined, undefined), false)
  assert.equal(needsIdleSample({}, {}), false)
  assert.equal(needsIdleSample({ bots: {} }, { bots: { a: { level: 'background' }, b: { level: 'view' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { appName: 'Finder' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { waitingFor: 'window' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { waitingFor: 'user-idle' } } }), true)
  assert.equal(needsIdleSample({ bots: { a: {}, b: { waitingFor: 'user-idle' } } }), true)
  assert.equal(needsIdleSample({ bots: {} }, { bots: { a: { level: 'background' }, b: { level: 'foreground' } } }), true)
})
