import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatCache } from './chat-cache.ts'
import { memorySummaryText } from './memory.ts'

test('chat cache ignores stale page writes whose ownerKey does not match the active chatKey', () => {
  const cache = createChatCache<{ sessionId: string; items: string[] }, string>(4)
  assert.equal(cache.keep('host:bot:b1', 'host:bot:b1', { page: { sessionId: 's1', items: ['from b1'] }, older: [], cursor: null }), true)
  assert.equal(cache.keep('host:bot:b2', 'host:bot:b2', { page: { sessionId: 's2', items: ['from b2'] }, older: [], cursor: null }), true)

  // Switching Chat route params in place renders once with chatKey=b2 before b1's state resets.
  assert.equal(cache.keep('host:bot:b2', 'host:bot:b1', { page: { sessionId: 's1', items: ['from b1'] }, older: [], cursor: null }), false)
  assert.deepEqual(cache.get('host:bot:b2')?.page.items, ['from b2'])
})

test('chat cache evicts least-recently-used entries past the limit', () => {
  const cache = createChatCache<string, string>(2)
  cache.keep('a', 'a', { page: '1', older: [], cursor: null })
  cache.keep('b', 'b', { page: '2', older: [], cursor: null })
  cache.keep('a', 'a', { page: '1-fresh', older: [], cursor: null })
  cache.keep('c', 'c', { page: '3', older: [], cursor: null })
  assert.equal(cache.has('b'), false)
  assert.equal(cache.get('a')?.page, '1-fresh')
  assert.equal(cache.get('c')?.page, '3')
})

test('memorySummaryText extracts string text from real host { text, at } summary objects', () => {
  // Real memory.js memoryView contract: summary is { text: saved.text, at: saved.at } | null
  const hostResponse = {
    botId: 's1',
    entries: [{ scope: 'own', topic: '沟通', text: '先说结论', id: 'e1', added: '2026-11-12', by: null, source: 'memory panel', until: null, pinned: false, expired: false }],
    summary: { text: 'Chief 负责团队排期与把关。', at: 1794467100000 },
    fresh: true,
    summarizing: false,
    error: null,
  }
  assert.equal(memorySummaryText(hostResponse.summary), 'Chief 负责团队排期与把关。')
  assert.equal(memorySummaryText(null), null)
  assert.equal(memorySummaryText(undefined), null)
  assert.equal(memorySummaryText({ text: '   ', at: 1 }), null)
  assert.equal(memorySummaryText('Plain string fixture'), 'Plain string fixture')
})
