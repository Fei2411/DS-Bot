import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONNECTION_GRACE_MS,
  CONNECTING_MIN_VISIBLE_MS,
  RECOVERY_CONFIRMATION_MS,
  createConnectionFeedback,
} from '../src/client/connection-feedback.js'

function feedbackRig() {
  let current = 0
  const timers = []
  const views = []
  const feedback = createConnectionFeedback(view => views.push(view), {
    now: () => current,
    schedule(run, wait) {
      const timer = { at: current + wait, run, active: true }
      timers.push(timer)
      return timer
    },
    clear(timer) {
      timer.active = false
    },
  })
  const advance = (wait) => {
    const target = current + wait
    for (;;) {
      const next = timers
        .filter(timer => timer.active && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (next === undefined) break
      next.active = false
      current = next.at
      next.run()
    }
    current = target
  }
  return { advance, feedback, timers, views }
}

test('connection feedback keeps the shell timings', () => {
  assert.equal(CONNECTION_GRACE_MS, 2000)
  assert.equal(CONNECTING_MIN_VISIBLE_MS, 800)
  assert.equal(RECOVERY_CONFIRMATION_MS, 2000)
})

test('an outage that recovers inside the grace period never reaches the sidebar', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(CONNECTION_GRACE_MS - 1)
  feedback.update('connected')
  advance(RECOVERY_CONFIRMATION_MS + CONNECTING_MIN_VISIBLE_MS)
  assert.deepEqual(views, [])
})

test('a continuing outage becomes visible after the grace period', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(CONNECTION_GRACE_MS)
  assert.deepEqual(views, ['connecting'])
  feedback.update('disconnected')
  assert.deepEqual(views, ['connecting', 'disconnected'])
})

test('a visible outage stays up briefly before confirming recovery', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(CONNECTION_GRACE_MS + 500)
  feedback.update('connected')
  advance(CONNECTING_MIN_VISIBLE_MS - 501)
  assert.deepEqual(views, ['connecting'])
  advance(1)
  assert.deepEqual(views, ['connecting', 'recovered'])
  advance(RECOVERY_CONFIRMATION_MS)
  assert.deepEqual(views, ['connecting', 'recovered', undefined])
})

test('rapid connecting and disconnected changes share one grace period', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(1500)
  feedback.update('disconnected')
  advance(400)
  feedback.update('connecting')
  advance(99)
  assert.deepEqual(views, [])
  advance(1)
  assert.deepEqual(views, ['connecting'])
})

test('a new outage clears recovery before starting its grace period', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(CONNECTION_GRACE_MS)
  feedback.update('connected')
  advance(CONNECTING_MIN_VISIBLE_MS)
  assert.deepEqual(views, ['connecting', 'recovered'])
  feedback.update('disconnected')
  assert.deepEqual(views, ['connecting', 'recovered', undefined])
  advance(CONNECTION_GRACE_MS - 1)
  assert.deepEqual(views, ['connecting', 'recovered', undefined])
  advance(1)
  assert.deepEqual(views, ['connecting', 'recovered', undefined, 'disconnected'])
})

test('suspending clears the delay and a late callback cannot update the view', () => {
  const pending = feedbackRig()
  pending.feedback.update('connected')
  pending.feedback.update('connecting')
  const delayed = pending.timers.at(-1)
  pending.feedback.suspend()
  delayed.run()
  pending.advance(CONNECTION_GRACE_MS * 2)
  assert.deepEqual(pending.views, [])

  const recovering = feedbackRig()
  recovering.feedback.update('connected')
  recovering.feedback.update('connecting')
  recovering.advance(CONNECTION_GRACE_MS)
  recovering.feedback.update('connected')
  const recovery = recovering.timers.at(-1)
  recovering.feedback.suspend()
  recovery.run()
  recovering.advance(CONNECTING_MIN_VISIBLE_MS + RECOVERY_CONFIRMATION_MS)
  assert.deepEqual(recovering.views, ['connecting'])
})

test('resuming the same connection state continues the original grace period', () => {
  const { advance, feedback, views } = feedbackRig()
  feedback.update('connected')
  feedback.update('connecting')
  advance(1000)
  feedback.suspend()
  feedback.update('connecting')
  advance(999)
  assert.deepEqual(views, [])
  advance(1)
  assert.deepEqual(views, ['connecting'])
})
