import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runStatsOf } from '../src/client/text.js'
import { runStatsValues } from '../src/host/channel.js'

const texts = values => runStatsOf(values).map(entry => entry.text)

test('the figures read as DSH counts them', () => {
  const values = {
    sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
    tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
    contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
  }
  assert.deepEqual(texts(values), ['12 turns', '38 tok/s', 'Cache hit 90%', 'Context 41%'])
  assert.equal(runStatsOf(values).at(-1).title, '41.0K of 100.0K tokens of context in use')
})

test('a slow speed keeps a decimal, and a projected count wins over the last measure', () => {
  const values = {
    sessionStats: { turns: 1, decodeMs: 2000, decodeTokens: 9 },
    contextPressure: { pressureTokens: 10, projectedTokens: 30, contextWindow: 100 },
  }
  assert.deepEqual(texts(values), ['1 turn', '4.5 tok/s', 'Context 30%'])
})

test('a cache hit short of whole never reads 100%', () => {
  const hit = cacheReadTokens => texts({ tokenUsage: { uncachedInputTokens: 1000 - cacheReadTokens, cacheReadTokens } })
  assert.deepEqual(hit(996), ['Cache hit 99.6%'])
  assert.deepEqual(hit(1000), ['Cache hit 100%'])
  assert.deepEqual(hit(0), ['Cache hit 0%'])
})

test('nothing to count leaves the line empty', () => {
  assert.deepEqual(runStatsOf(null), [])
  assert.deepEqual(runStatsOf({ sessionStats: { turns: 0, decodeMs: 0, decodeTokens: 0 }, tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), [])
  assert.deepEqual(texts({ contextPressure: { contextWindow: 100 } }), [])
})

test('runStatsValues replaces cumulative DSH contextPressure with CLI per-step occupancy without mutating (#1896)', () => {
  const snapshot = {
    sessionStats: { turns: 1, decodeMs: 1000, decodeTokens: 50 },
    contextPressure: { pressureTokens: 6_000_000, projectedTokens: 6_000_000, contextWindow: 200_000, staleExtra: true },
  }
  const replaced = runStatsValues(snapshot, { used: 242_746, size: 1_048_576, compactions: 0 })
  assert.notEqual(replaced, snapshot)
  assert.equal(snapshot.contextPressure.contextWindow, 200_000)
  assert.deepEqual(replaced.contextPressure, {
    pressureTokens: 242_746,
    projectedTokens: 242_746,
    contextWindow: 1_048_576,
  })
  assert.equal(runStatsOf(replaced).at(-1).text, 'Context 23%')

  // When CLI reported used without size, fall back to the resolved/persisted snapshot contextWindow.
  const usedOnly = runStatsValues(
    { ...snapshot, contextPressure: { pressureTokens: 6_000_000, projectedTokens: 6_000_000, contextWindow: 1_048_576 } },
    { used: 104_858, compactions: 0 },
  )
  assert.deepEqual(usedOnly.contextPressure, {
    pressureTokens: 104_858,
    projectedTokens: 104_858,
    contextWindow: 1_048_576,
  })

  // When CLI has no fresh occupancy (stale after compaction or before first report), drop cumulative DSH pressure.
  assert.equal(runStatsValues(snapshot, { used: undefined, size: 1_048_576, compactions: 1 }).contextPressure, undefined)
  assert.equal(runStatsValues(snapshot, { used: 123, size: 1_048_576, stale: true }).contextPressure, undefined)
  assert.equal(runStatsValues(snapshot, undefined).contextPressure, undefined)
  assert.equal(runStatsValues(snapshot, { used: -10, size: 1_048_576 }).contextPressure, undefined)
  assert.equal(runStatsValues(snapshot, { used: 100.5, size: 1_048_576 }).contextPressure, undefined)
  assert.equal(runStatsValues(snapshot, { used: Number.MAX_SAFE_INTEGER + 1, size: 1_048_576 }).contextPressure, undefined)
  assert.deepEqual(runStatsValues(snapshot, { used: 0, size: 1_048_576 }).contextPressure, {
    pressureTokens: 0,
    projectedTokens: 0,
    contextWindow: 1_048_576,
  })
  assert.equal(runStatsValues(null, { used: 10, size: 1_048_576 }), null)
})
