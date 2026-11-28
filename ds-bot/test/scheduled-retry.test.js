import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installModels } from '../src/host/models.js'

const fastBackoff = { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }

async function run(t, { code = 'TRANSPORT', failures = 2, source = 'schedule', stop = false } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: fastBackoff }, 'mock')
  let attempts = 0
  class MockAdapter extends LlmAdapter {
    providerRetryPolicy = () => policy
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream() {
      if (++attempts <= failures) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Mock provider error' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Scheduled work completed' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Scheduled work completed' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  await ctx.plugin(llmRetry).await()
  const sessionId = SessionId('scheduled-retry')
  installModels({
    ctx, state: { bots: {} }, chatOwners: new Map([[sessionId, sessionId]]), isBotSession: () => true,
    config: { llmRetryBackoff: stop ? { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 } : fastBackoff },
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(sessionId, { provider: 'mock', model: 'mock' })
  if (stop) {
    ctx.on('agent/request-error', (_, next) => {
      if (attempts === 2) setImmediate(() => agent.cancel({ kind: 'user' }))
      return next()
    }, { prepend: true })
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do the scheduled work' }], source: { kind: source } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  return { attempts, events, ends: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind) }
}

for (const code of ['TRANSPORT', 'SERVER']) {
  test(`a scheduled turn recovers from ${code} after ordinary provider retries are exhausted`, async t => {
    const { attempts, events, ends } = await run(t, { code })
    assert.deepEqual(ends, ['completed'])
    assert.equal(attempts, 3)
    assert.equal(events.filter(event => event.type === 'llm/retry').length, 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule').length, 1)
  })
}

test('a scheduled turn keeps a terminal error when its retry budget runs out', async t => {
  const { attempts, events, ends } = await run(t, { failures: 10 })
  assert.deepEqual(ends, ['error'])
  assert.equal(attempts, 4)
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.error.code, 'TRANSPORT')
})

test('a manual turn gets no scheduled retries', async t => {
  const { attempts, ends } = await run(t, { source: 'user' })
  assert.deepEqual(ends, ['error'])
  assert.equal(attempts, 2)
})

test('a scheduled turn does not retry a non-transport failure', async t => {
  const { attempts, ends } = await run(t, { code: 'AUTH' })
  assert.deepEqual(ends, ['error'])
  assert.equal(attempts, 1)
})

test('an error-free scheduled turn makes just one model request', async t => {
  const { attempts, ends } = await run(t, { failures: 0 })
  assert.deepEqual(ends, ['completed'])
  assert.equal(attempts, 1)
})

test('stopping a scheduled turn during backoff cancels the retry', async t => {
  const { attempts, ends } = await run(t, { stop: true })
  assert.deepEqual(ends, ['aborted'])
  assert.equal(attempts, 2)
})
