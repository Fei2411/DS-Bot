import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// DSH asks for an explicit range before a request that would not fit, and a model switch
// is one of those. A Bot conversation is condensed by DS Bot itself, so the range goes
// through DS Bot's checkpoint instead of being refused: a refusal there ended the switch
// with MODEL_SWITCH_COMPACTION_FAILED and the Bot stayed on the model it had.

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', instructions: '', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4 },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ summarize = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-compaction-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const bench = { regions: [], nows: [], summarised: 0 }
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow(target, signal, commandId) { bench.nows.push([target?.session?.id, commandId]) },
    async compactRegion(start, end, target) { bench.regions.push([start, end, target?.session?.id]) },
  }
  if (summarize) compaction.summarize = () => { bench.summarised += 1; return { summary: [] } }
  const ctx = fakeContext({
    services: { compaction, tokenMeter: { measure: () => ({ totalTokens: 10 }) } },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8_000 }),
      stream() {
        throw new Error('the checkpoint model is not called by these tests')
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  const agentOf = sessionId => ({
    id: sessionId,
    session: {
      id: sessionId,
      seq: 2,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    },
  })
  const adoptFor = sessionId => adopt({ agent: agentOf(sessionId) })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, bench, compaction, adoptFor, agentOf, stop }
}

test('a model switch compacts a Bot conversation instead of refusing the range', async (t) => {
  const { bench, compaction, adoptFor, agentOf, stop } = start()
  t.after(stop)
  adoptFor('b2')
  const signal = new AbortController().signal
  // DSH's model-switch pressure calls exactly this entry point.
  await compaction.compactRegion(3, 9, agentOf('b2'), signal)
  assert.deepEqual(bench.regions, [[3, 9, 'b2']])
})

test('a Session outside the team keeps the backend compaction', async (t) => {
  const { bench, compaction, adoptFor, agentOf, stop } = start()
  t.after(stop)
  adoptFor('b2')
  await compaction.compactRegion(1, 2, agentOf('outside'), new AbortController().signal)
  assert.deepEqual(bench.regions, [[1, 2, 'outside']])
})

test('without a summary hook of its own a Bot conversation is still refused', async (t) => {
  const { bench, compaction, adoptFor, agentOf, stop } = start({ summarize: false })
  t.after(stop)
  adoptFor('b2')
  await assert.rejects(
    () => compaction.compactRegion(3, 9, agentOf('b2'), new AbortController().signal),
    /A Bot conversation makes room on its own, and read_own_chat searches all of it\./,
  )
  assert.deepEqual(bench.regions, [])
})

test('an explicit /compact on a Bot conversation is still refused', async (t) => {
  const { bench, compaction, adoptFor, agentOf, stop } = start()
  t.after(stop)
  adoptFor('b2')
  await assert.rejects(
    () => compaction.compactNow(agentOf('b2'), new AbortController().signal, 'command-1'),
    /A Bot conversation makes room on its own/,
  )
  assert.deepEqual(bench.nows, [])
})
