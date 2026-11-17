import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextRuns } from '../src/client/schedule-next.js'

const HOUR = 3600_000
// A local wall clock on a given day, which is what a task keeps.
const localDay = (offsetDays, hours = 9, minutes = 0) => {
  const date = new Date(2026, 0, 5 + offsetDays, hours, minutes, 0, 0)
  return date.getTime()
}

test('a daily task previews the next three mornings', () => {
  const from = localDay(0, 10)
  const task = { kind: 'daily', status: 'active', time: '09:00', scheduledAt: new Date(localDay(1, 9)).toISOString() }
  assert.deepEqual(nextRuns(task, from), [localDay(1, 9), localDay(2, 9), localDay(3, 9)])
})

test('a weekly task skips the days it does not run', () => {
  // 2026-01-05 is a Monday.
  const from = localDay(0, 10)
  const task = { kind: 'weekly', status: 'active', time: '09:00', weekdays: [3], scheduledAt: new Date(localDay(0, 9)).toISOString() }
  const runs = nextRuns(task, from).map(at => new Date(at).getDay())
  assert.deepEqual(runs, [3, 3, 3])
  assert.ok(nextRuns(task, from)[0] > from)
})

test('a repeating task counts from its step', () => {
  const from = localDay(0, 10)
  const task = { kind: 'every', status: 'active', everySeconds: 3600, scheduledAt: new Date(from + HOUR).toISOString() }
  assert.deepEqual(nextRuns(task, from), [from + HOUR, from + 2 * HOUR, from + 3 * HOUR])
})

test('a paused or gone task previews nothing, and so does another zone', () => {
  const from = localDay(0, 10)
  const task = { kind: 'daily', status: 'active', time: '09:00', scheduledAt: new Date(localDay(1, 9)).toISOString() }
  assert.deepEqual(nextRuns({ ...task, status: 'paused' }, from), [])
  assert.deepEqual(nextRuns({ ...task, timeZone: 'Pacific/Kiritimati' }, from), [])
  assert.deepEqual(nextRuns({ kind: 'at', status: 'active', scheduledAt: new Date(localDay(2)).toISOString() }, from).length, 1)
})
