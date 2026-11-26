import assert from 'node:assert/strict'
import test from 'node:test'
import { compact, percent, rankUsage, usageActivity, usageChart, usageRanges, usageReport, type UsageView } from './usage.ts'
import { demoUsage } from './demo-usage.ts'

const range = (id: string) => usageRanges.find(item => item.id === id)!
const view = (): UsageView => ({
  now: '2026-11-23 12',
  owners: [{ key: 'bot:a', id: 'a', name: 'A', kind: 'bot' }, { key: 'room:b', id: 'b', name: 'B', kind: 'room' }],
  models: [{ key: 'm1', name: 'Model 1' }, { key: 'm2', name: 'Model 2' }],
  rows: [
    ['2026-11-09 10', 0, 0, 0, 1000, 0, 0, 0, 1], // Outside both 7-day windows.
    ['2026-11-16 10', 0, 0, 0, 50, 20, 10, 20, 1], // Previous window: 100.
    ['2026-11-17 00', 1, 1, 0, 200, 300, 100, 400, 4],
    ['2026-11-23 12', 0, 0, 0, 100, 600, 100, 200, 6],
    ['2026-11-23 13', 0, 0, 0, 9000, 0, 0, 0, 1], // Future hour is excluded.
  ],
})

test('phone range metrics match web accounting, including cache writes and the comparison boundary', () => {
  const report = usageReport(view(), range('7d'), 'bot')
  assert.deepEqual(report.total, { input: 500, cacheRead: 900, output: 600, total: 2000, calls: 10 })
  assert.equal(report.previous, 100)
  assert.equal(report.buckets.length, 7)
  assert.equal(report.buckets[0].key, '2026-11-17')
  assert.equal(percent(report.total.cacheRead, report.total.input + report.total.cacheRead), '64')
  assert.equal(compact(report.total.total), '2K')
  assert.deepEqual(rankUsage(report.owners).map(([id, sum]) => [id, sum.total]), [[1, 1000], [0, 1000]])
})

test('changing the grouping preserves totals and puts tokens in the right chart stacks', () => {
  const source = view()
  source.rows.push(['2026-11-23 11', 0, 1, 0, 10, 0, 0, 0, 1])
  const owners = usageReport(source, range('24h'), 'bot')
  const models = usageReport(source, range('24h'), 'model')
  assert.deepEqual(owners.total, models.total)
  assert.equal(owners.total.total, 1010)
  assert.equal(owners.buckets.at(-2)?.stacks.get(0), 10)
  assert.equal(models.buckets.at(-2)?.stacks.get(1), 10)
  assert.deepEqual(rankUsage(models.models).map(([id]) => id), [0, 1])
})

test('all preset ranges handle an empty ledger without NaN, missing buckets or false activity', () => {
  const empty = { ...view(), rows: [] }
  for (const preset of usageRanges) {
    const report = usageReport(empty, preset, 'bot')
    assert.equal(report.total.total, 0)
    assert.equal(report.previous, 0)
    assert.equal(report.buckets.length, preset.count)
    assert.deepEqual(rankUsage(report.owners), [])
    assert.equal(percent(report.total.cacheRead, report.total.input), '0')
  }
  assert.equal(usageActivity(empty).active, 0)
})

test('busy charts group smaller series without losing tokens or changing the rankings', () => {
  const source = demoUsage(Array.from({ length: 10 }, (_, id) => ({ id: String(id), name: `Bot ${id}` })), new Date(2026, 10, 23, 12))
  const original = usageReport(source, range('7d'), 'bot')
  const chart = usageChart(original, 'bot')
  assert.equal(chart.ids.length, 8)
  assert.equal(chart.ids.at(-1), -1)
  assert.equal(chart.report.owners.size, 10)
  for (const bucket of chart.report.buckets) {
    assert.equal([...bucket.stacks.values()].reduce((sum, value) => sum + value, 0), bucket.sum.total)
  }
  assert.equal(usageChart(original, 'bot', 10).report, original)
})

test('Bot charts keep group and standalone usage separate from smaller Bots, like web', () => {
  const source = demoUsage(Array.from({ length: 8 }, (_, id) => ({ id: String(id), name: `Bot ${id}` })), new Date(2026, 10, 23, 12))
  source.owners[1].kind = 'agent'
  source.owners.push({ key: 'room', kind: 'room' }, { key: 'outside', kind: 'other' })
  source.rows = source.owners.map((_, id) => ['2026-11-23 12', id, 0, 0, id === 8 ? 50 : id === 9 ? 20000 : 1000 - id * 100, 0, 0, 0, 1])
  const report = usageReport(source, range('24h'), 'bot')
  assert.equal(report.bots.size, 8)
  const chart = usageChart(report, 'bot')
  assert.deepEqual(chart.ids, [0, 1, 2, 3, 4, 5, 6, -1, -2])
  const bucket = chart.report.buckets.at(-1)!
  assert.equal(bucket.stacks.get(-1), 300)
  assert.equal(bucket.stacks.get(-2), 20050)
  assert.equal([...bucket.stacks.values()].reduce((sum, value) => sum + value, 0), bucket.sum.total)
  assert.deepEqual(usageChart(report, 'bot', 10).ids, [0, 1, 2, 3, 4, 5, 6, 7, -2])
  assert.deepEqual(usageChart(usageReport(source, range('24h'), 'model'), 'model').ids, [0])
})

test('activity ignores future and out-of-year rows and places wall-clock days in Monday-first weeks', () => {
  const source = view()
  source.rows = [
    ['2025-11-23 00', 0, 0, 0, 100, 0, 0, 0, 1],
    ['2025-11-24 00', 0, 0, 0, 100, 0, 0, 0, 1],
    ['2026-11-23 00', 0, 0, 0, 200, 0, 0, 0, 1],
    ['2026-11-24 00', 0, 0, 0, 900, 0, 0, 0, 1],
  ]
  const activity = usageActivity(source)
  assert.equal(activity.active, 2)
  assert.equal(activity.weeks.length, 53)
  assert.equal(activity.weeks[52][0].key, '2026-11-23')
  assert.equal(activity.weeks[52][0].level, 4)
  assert.equal(activity.weeks[52][1].outside, true)
})

test('demo usage follows the real host ledger contract and populates every preset without future rows', () => {
  const source = demoUsage([{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }], new Date(2026, 10, 23, 12))
  assert.equal(source.now, '2026-11-23 12')
  assert.equal(source.owners[0].id, 'a')
  assert.ok(source.rows.every(row => row[0] <= source.now))
  for (const preset of usageRanges) {
    const report = usageReport(source, preset, 'bot')
    assert.ok(report.total.total > 0, preset.id)
    assert.ok(report.previous > 0, preset.id)
    assert.equal(report.owners.size, 2)
    assert.equal(report.models.size, 2)
  }
  assert.deepEqual(usageReport(demoUsage([]), range('7d'), 'bot').total.total, 0)
})
