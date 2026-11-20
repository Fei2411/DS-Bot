import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
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

const meter = { estimateMessage: message => TokenMeter.prototype.estimateMessage(message) }

function start({ summarize = true, outlet = false, stream, messages = [{ role: 'user', content: [{ type: 'text', text: 'Earlier work. '.repeat(2000) }] }] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-compaction-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const bench = { regions: [], nows: [], summarised: 0, checkpoints: [] }
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow(target, signal, commandId) { bench.nows.push([target?.session?.id, commandId]) },
    // `outlet` is compaction-basic's own shape: the range is condensed through the
    // engine's summarize, which is the hook DS Bot wraps.
    async compactRegion(start, end, agent, signal) {
      bench.regions.push([start, end, agent?.session?.id])
      if (outlet) bench.checkpoints.push(await this.summarize({ messages }, agent, signal))
    },
  }
  if (summarize) compaction.summarize = () => { bench.summarised += 1; return { summary: [] } }
  const ctx = fakeContext({
    services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 10 }) } },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8_000 }),
      stream(options) {
        if (stream !== undefined) return stream(options)
        throw new Error('the checkpoint model is not called by these tests')
      },
    },
    sessions: { messageProjections: [] },
    // The checkpoint carries the latest messages of the part word for word.
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 2 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
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

test('a checkpoint reads past ten pages to keep the latest initiating request', async (t) => {
  const { ctx, bench, compaction, adoptFor, agentOf, stop } = start({ outlet: true, stream: () => { throw new Error('offline') } })
  t.after(stop)
  const history = Array.from({ length: 2202 }, (_, seq) => ({
    seq, time: 1,
    ...(seq === 0 || seq === 1
      ? { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: seq === 1 ? 'Keep the initiating request' : 'Older request' }] } }
      : { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working' }] } } }),
  }))
  let pages = 0
  ctx.sessionController.resolveAgent = async () => ({ agent: { id: 'b2', session: { seq: history.length } } })
  ctx.sessionController.page = async ({ beforeSeq, maxMessages }) => {
    pages += 1
    const end = beforeSeq ?? history.length
    const start = Math.max(0, end - maxMessages)
    return { records: history.slice(start, end).map(event => ({ event })), hasMore: start > 0 }
  }
  adoptFor('b2')
  await compaction.compactRegion(0, 1, agentOf('b2'), new AbortController().signal)
  const text = bench.checkpoints[0].summary[0].text
  assert.match(text, /Keep the initiating request/)
  assert.match(text, /Older messages are not shown here/)
  assert.doesNotMatch(text, /User: Older request/)
  assert.ok(pages > 10)
})

for (const size of [3000, 600, 480]) {
  test(`a switch checkpoint fits a ${size}-character range even without a summary model`, async (t) => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'System instructions. '.repeat(2000) }] },
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(size) }] },
    ]
    const { bench, compaction, adoptFor, agentOf, stop } = start({ outlet: true, messages })
    t.after(stop)
    adoptFor('b2')
    await compaction.compactRegion(1, 2, agentOf('b2'), new AbortController().signal)
    const summary = bench.checkpoints[0].summary
    const framed = meter.estimateMessage({ role: 'user', content: [
      { type: 'text', text: ' '.repeat(340) }, ...summary, { type: 'text', text: '</compacted-summary>' },
    ] })
    assert.ok(framed < meter.estimateMessage(messages[1]), `${framed} framed tokens must be smaller than ${meter.estimateMessage(messages[1])}`)
  })
}

for (const summary of ['Progress recorded.', 'Long summary. '.repeat(1000), '']) {
  test(`a switch bounds kept messages and ${summary.length}-character model output`, async (t) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Work. '.repeat(400) }] }]
    const { ctx, bench, compaction, adoptFor, agentOf, stop } = start({
      outlet: true, messages,
      stream: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: summary }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    t.after(stop)
    ctx.sessionController.page = async () => ({ records: [{ event: {
      seq: 1, time: 1, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this request. '.repeat(200) }] },
    } }], hasMore: false })
    adoptFor('b2')
    await compaction.compactRegion(1, 2, agentOf('b2'), new AbortController().signal)
    const text = bench.checkpoints[0].summary[0].text
    assert.ok(meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] }) + 112 < meter.estimateMessage(messages[0]))
    assert.doesNotMatch(text, /Keep this request/)
    if (summary === 'Progress recorded.') assert.match(text, /Progress recorded\./)
  })
}

for (const type of ['image', 'file']) {
  for (const routeTokens of [180, 2000]) {
    test(`a switch uses the selected ${type} node's ${routeTokens} route-priced tokens`, async (t) => {
      const summary = 'Important progress. '.repeat(100)
      const attachment = {
        attachmentId: 'a'.repeat(64), bytes: 1000,
        name: 'attachment'.repeat(routeTokens === 180 ? 1000 : 1),
        ...(type === 'image' ? { mediaType: 'image/png', width: 100, height: 100 } : {}),
      }
      const messages = [{ role: 'user', content: [{ type, attachment }] }]
      const { ctx, bench, compaction, adoptFor, agentOf, stop } = start({
        outlet: true, messages,
        stream: async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: summary }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })
      t.after(stop)
      ctx.get('tokenMeter').measure = () => ({ totalTokens: 10000 + routeTokens, nodes: [
        { seq: 0, tokens: 5000 }, { seq: 3, tokens: routeTokens }, { seq: 9, tokens: 0 }, { seq: 10, tokens: 5000 },
      ] })
      adoptFor('b2')
      await compaction.compactRegion(3, 9, agentOf('b2'), new AbortController().signal)
      const text = bench.checkpoints[0].summary[0].text
      const framed = meter.estimateMessage({ role: 'user', content: [
        { type: 'text', text: ' '.repeat(340) }, { type: 'text', text }, { type: 'text', text: '</compacted-summary>' },
      ] })
      assert.ok(framed < routeTokens, `${framed} framed tokens must be smaller than ${routeTokens} route-priced tokens`)
      if (routeTokens === 2000) assert.ok(text.includes(summary.trim()), 'retain the summary when route pricing leaves enough room')
    })
  }
}

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

test('a checkpoint the route cannot write does not fail the switch', async (t) => {
  // The reason for switching can be the route itself: a model out of quota answers every
  // request with 429, the summary included. The range must still condense.
  const asked = []
  const { bench, compaction, adoptFor, agentOf, stop } = start({
    outlet: true,
    stream: options => {
      asked.push(`${options.provider}/${options.model}`)
      throw new Error('429: rate limited')
    },
  })
  t.after(stop)
  adoptFor('b2')
  await compaction.compactRegion(3, 9, agentOf('b2'), new AbortController().signal)
  assert.deepEqual(bench.regions, [[3, 9, 'b2']])
  assert.deepEqual(asked, ['deepseek/v4'])
  assert.equal(bench.checkpoints.length, 1)
  assert.match(bench.checkpoints[0].summary[0].text, /^\[Checkpoint 1\]/)
  assert.match(bench.checkpoints[0].summary[0].text, /No summary was written/)
})

test('a checkpoint the route cannot write still fails outside a switch', async (t) => {
  // The steward's own condense path keeps its old behaviour: a model that cannot answer
  // makes the part move on instead of leaving a checkpoint without a summary.
  const { compaction, adoptFor, agentOf, stop } = start({
    outlet: true,
    stream: () => {
      throw new Error('429: rate limited')
    },
  })
  t.after(stop)
  adoptFor('b2')
  const session = agentOf('b2')
  await assert.rejects(
    () => compaction.compactNow(session, new AbortController().signal, 'command-1'),
    undefined,
  )
})
