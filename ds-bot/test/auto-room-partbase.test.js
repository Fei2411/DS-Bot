// Real DSH loop + TokenMeter + BasicCompactionEngine contract tests for Issue #1409.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { output } from '../src/host/tools.js'

const GOOD_NOTE = [
  '## Goals', 'Build widget',
  '## Constraints and preferences', 'None',
  '## Progress', 'Step 2 done',
  '## Decisions', 'Use A',
  '## Facts to keep', 'Path /a',
  '## Open threads', 'Step 3',
  '## Next step', 'Finish step 3',
  '## Where to look', 'a.js',
].join('\n')

const CHECKPOINT_TEXT = [
  '- Done: early steps',
  '- Tried: test',
  '- Current: step 2',
  '- Decisions: ok',
  '- Open: more',
].join('\n')

const until = async (check, label, ms = 4000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`until timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function bootBot(t, { provider, model, contextWindow, defaultMaxTokens, onTurn, stewardAction }) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-1409-'))
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  await root.plugin(BasicCompactionEngine)

  const calls = []
  let partCounter = 0

  class MockAdapter extends LlmAdapter {
    providerInfo() { return { id: provider, name: provider } }
    async listModels() { return [{ id: model, name: model, inputModalities: ['text'] }] }
    async resolveModel(p, id) {
      return {
        provider: p,
        id,
        name: id,
        inputModalities: ['text'],
        context: { contextWindow },
        defaultMaxTokens,
      }
    }
    async *stream(req) {
      const sys = req.system ?? ''
      if (req.purpose === 'compaction') {
        const isSteward = sys.includes('context steward')
        const isNote = sys.includes('handoff') || (req.messages ?? []).some(m => JSON.stringify(m).includes('## Goals'))
        const kind = isSteward ? 'steward' : isNote ? 'note' : 'checkpoint'
        calls.push({ kind, sessionId: String(req.sessionId) })
        const text = isSteward
          ? JSON.stringify({ action: stewardAction(calls.filter(c => c.kind === 'steward').length), reason: 'test' })
          : isNote ? GOOD_NOTE : CHECKPOINT_TEXT
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const turnCalls = calls.filter(c => c.kind === 'turn').length + 1
      calls.push({ kind: 'turn', step: turnCalls, sessionId: String(req.sessionId) })
      const plan = onTurn(turnCalls, req)
      if (plan.toolCall) {
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'tool-call',
          id: plan.toolCall.id,
          name: plan.toolCall.name,
        }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: plan.toolCall.id,
            name: plan.toolCall.name,
            arguments: JSON.stringify(plan.toolCall.args ?? {}),
          },
        }
      } else {
        const text = plan.text ?? `reply ${turnCalls}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      }
      yield { type: 'usage', usage: plan.usage }
      yield { type: 'finish', reason: { kind: plan.toolCall ? 'tool-use' : 'stop' } }
    }
  }

  root.llm.registerAdapter([provider], new MockAdapter())
  await mountAgentLoopTestHarness(root)

  const { agents, tokenMeter, tools } = await new Promise(resolve => root.inject(['agents', 'tokenMeter', 'tools'], resolve))
  tools.register(defineTool({
    name: 'echo_step',
    description: 'Echo a value',
    parameters: {},
    output,
    execute: async () => 'done',
  }))

  root.provide('sessionTitle', { setTitle: async () => {}, rename: async () => {} })
  root.provide('workspaceRegistry', {
    archiveSession: async () => {},
    unarchiveSession: async () => {},
    resolveByPath: async () => ({ id: 'ws-1', rootPath: home }),
    create: async () => ({ id: 'ws-1', rootPath: home }),
    get: async () => ({ id: 'ws-1', rootPath: home }),
    listAll: async () => [{ id: 'ws-1', rootPath: home }],
  })
  root.provide('connection', { fetch: { register: () => () => {} } })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
    create: async ({ cwd }) => {
      const id = `part-${++partCounter}`
      const created = await agents.create({
        sessionId: id,
        agentOptions: { provider, model, maxTokens: defaultMaxTokens },
        meta: { cwd },
      })
      return { sessionId: id, agent: created.agent }
    },
  })
  await new Promise(resolve => root.inject(['sessionTitle', 'workspaceRegistry', 'connection', 'sessionController'], resolve))

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1, model: `${provider}/${model}` } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const warnings = []
  const rt = createRuntime(root, { home })
  rt.warn = (...args) => warnings.push(args.join(' '))
  await rt.load()
  const { agent } = await agents.create({
    sessionId: 'm1',
    agentOptions: { provider, model, maxTokens: defaultMaxTokens },
    meta: { cwd: home },
  })

  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const runTurn = async (text, waitIdleOn = () => agents.get(rt.chatOf('m1'))) => {
    const active = waitIdleOn()
    const done = new Promise((resolve) => {
      const off = root.on('agent/status', ({ agent: subject, status }) => {
        if (subject === active && status === 'idle') {
          off()
          resolve()
        }
      })
    })
    active.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
  }

  return { root, rt, agents, tokenMeter, agent, calls, warnings, runTurn }
}

test('a post-compaction TokenMeter overestimate calibrated down by real usage does not block checkContext past lines.check', async (t) => {
  // DeepSeek 1M window + 256K reserve -> check line capped at DEFAULT_CHECK_TOKENS (380,000), check/4 = 95,000.
  const usages = [
    { inputTokens: 1105, cacheReadTokens: 185_000, outputTokens: 874 }, // T1
    { inputTokens: 1105, cacheReadTokens: 390_000, outputTokens: 874 }, // T2 crosses 380K -> compact leaves ~337K overestimate
    { inputTokens: 1105, cacheReadTokens: 100_000, outputTokens: 874 }, // T3 real usage drops to ~102K
    { inputTokens: 1105, cacheReadTokens: 390_000, outputTokens: 874 }, // T4 grows back past 380K (< 337K + 95K = 432K)
  ]
  const { rt, agents, calls, warnings, runTurn, tokenMeter, agent } = await bootBot(t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    contextWindow: 1_048_576,
    defaultMaxTokens: 256_000,
    stewardAction: n => (n === 1 ? 'compact' : 'switch'),
    onTurn: step => ({ usage: usages[step - 1] }),
  })

  // Large CJK turns make CHARS_PER_TOKEN=4 undercount removed content so immediate post-compact totalTokens stays ~337K.
  await runTurn('你'.repeat(200_000))
  await runTurn('好'.repeat(20_000))
  await until(() => calls.some(c => c.kind === 'checkpoint'), 'initial checkpoint')
  assert.equal(rt.chatOf('m1'), 'm1')
  assert.ok(tokenMeter.measure(agent.session).totalTokens > 300_000)

  // Next turn reports true compacted usage (~102K), then conversation grows past 380K again.
  await runTurn('continue after checkpoint')
  await until(() => tokenMeter.measure(agent.session).totalTokens < 150_000, 'recalibrated usage')

  await runTurn('grow back past check line')
  await until(() => rt.chatOf('m1') !== 'm1', 'switch after crossing check line again')
  await until(() => agents.get(rt.chatOf('m1'))?.session.deriveMessages().some(m => m.source?.handoff === true), 'handoff delivered to fresh part')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 2)
  assert.equal(rt.botOf('m1').segments.length, 1)
  assert.deepEqual(warnings, [])
})

test('crossing lines.hard after a compaction whose check/4 growth window exceeds lines.hard still triggers checkContext and agent/pre-step', async (t) => {
  // 500K window, 100K reserve -> usable 400K, check 320K (check/4 = 80K), hard 380K.
  // Compaction leaves ~311K (< 320K), so partBase + check/4 (~391K) exceeds hard (380K).
  const { rt, agents, calls, warnings, runTurn, tokenMeter, agent } = await bootBot(t, {
    provider: 'custom',
    model: 'm500k',
    contextWindow: 500_000,
    defaultMaxTokens: 100_000,
    stewardAction: n => (n === 1 ? 'compact' : 'switch'),
    onTurn: (step) => {
      if (step === 1) return { usage: { inputTokens: 1000, cacheReadTokens: 200_000, outputTokens: 500 } }
      if (step === 2) return { usage: { inputTokens: 1000, cacheReadTokens: 330_000, outputTokens: 500 } }
      if (step === 3) {
        return {
          toolCall: { id: 'call-1', name: 'echo_step', args: {} },
          usage: { inputTokens: 1000, cacheReadTokens: 385_000, outputTokens: 500 },
        }
      }
      return { usage: { inputTokens: 1000, cacheReadTokens: 385_000, outputTokens: 500 } }
    },
  })

  await runTurn('x'.repeat(80_000))
  await runTurn('y'.repeat(4_000))
  await until(() => calls.some(c => c.kind === 'checkpoint'), 'T2 checkpoint')
  assert.ok(tokenMeter.measure(agent.session).totalTokens > 300_000)

  // Step 3 reports 386.5K (>= hard 380K) and requests a tool; step 4's agent/pre-step must intercept and switch before calling the LLM again on m1.
  await runTurn('z'.repeat(4_000), () => agent)
  await until(() => rt.chatOf('m1') !== 'm1', 'hard line switch before second step')
  await until(() => agents.get(rt.chatOf('m1'))?.session.deriveMessages().some(m => m.source?.handoff === true), 'handoff delivered to fresh part')
  await until(() => calls.some(c => c.kind === 'turn' && c.sessionId === rt.chatOf('m1')), 'resumed turn runs on fresh part')
  assert.equal(calls.filter(c => c.kind === 'turn' && c.sessionId === 'm1').length, 3, 'step 4 must not call the model on m1 past lines.hard')
  assert.deepEqual(warnings, [])
})
