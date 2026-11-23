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
import { parseReview } from '../src/host/memory-entries.js'
import { historyEntry, install as installParts } from '../src/host/parts.js'
import { checkpointText, selectRetainedRange } from '../src/host/steward.js'
import { output } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'

const meter = { estimateMessage: message => TokenMeter.prototype.estimateMessage(message) }

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function makeStream(reply) {
  return async function* () {
    if (reply.error) throw reply.error
    if (reply.toolCall) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'tc1', name: reply.toolCall, arguments: {} } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (reply.text !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    }
    yield { type: 'finish', reason: { kind: reply.kind ?? 'stop', ...(reply.failure ? { failure: reply.failure } : {}) } }
  }
}

test('selectRetainedRange keeps a balanced ~16% verbatim tail, pairs user+assistant, and skips tiny prefixes', () => {
  const mkEvents = (defs) => defs.map((d, seq) => ({ seq, ...d }))
  // [0: system, 1: user1, 2: asst1(tool), 3: toolRes1, 4: asst1, 5: user2, 6: asst2(tool), 7: toolRes2, 8: asst2]
  const events = mkEvents([
    { type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'u1' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'read_file' }] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', ok: true, content: [] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a1' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'u2' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'edit_file' }] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'c2', ok: true, content: [] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a2' }] } } },
  ])
  const session = {
    surface: { nodes: events.map(e => e.seq) },
    eventAt: seq => events[seq],
  }
  const measurement = {
    nodes: [
      { seq: 0, tokens: 5000 },
      { seq: 1, tokens: 4000 },
      { seq: 2, tokens: 4000 },
      { seq: 3, tokens: 4000 },
      { seq: 4, tokens: 4000 },
      { seq: 5, tokens: 1000 },
      { seq: 6, tokens: 1000 },
      { seq: 7, tokens: 1000 },
      { seq: 8, tokens: 1000 },
    ],
  }
  // Retain 1,500 tokens: raw cut lands on seq 7 (tool/result), backs up to seq 6 (tool-call)
  // so the c2 tool pair stays balanced, then pairs with seq 5 (u2) -> compacts seq 1..4!
  const rangeMidTool = selectRetainedRange(session, measurement, 1500)
  assert.deepEqual(rangeMidTool, { start: 1, end: 4 }, 'must keep the entire latest turn + balanced tool-call/result pair intact')

  // Retain 500 tokens: raw cut lands on seq 8 (assistant reply). Pairing check keeps user+assistant if directly preceded by user.
  const simpleEvents = mkEvents([
    { type: 'system/message', data: {} },
    { type: 'user/message', data: {} },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { type: 'user/message', data: {} },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'latest' }] } } },
  ])
  const simpleSession = { surface: { nodes: [0, 1, 2, 3, 4] }, eventAt: seq => simpleEvents[seq] }
  const simpleMeasure = { nodes: [{ seq: 0, tokens: 5000 }, { seq: 1, tokens: 5000 }, { seq: 2, tokens: 5000 }, { seq: 3, tokens: 1000 }, { seq: 4, tokens: 1000 }] }
  assert.deepEqual(selectRetainedRange(simpleSession, simpleMeasure, 500), { start: 1, end: 2 }, 'must pair retained assistant reply with its preceding user message')

  // Single giant turn dominating surface -> prefix < 25% of body -> returns null to fall back cleanly.
  const giantMeasure = { nodes: [{ seq: 0, tokens: 5000 }, { seq: 1, tokens: 500 }, { seq: 2, tokens: 500 }, { seq: 3, tokens: 10000 }, { seq: 4, tokens: 10000 }] }
  assert.equal(selectRetainedRange(simpleSession, giantMeasure, 5000), null)
})

test('mid-turn condense uses compactRegion with retained tail instead of wiping all recent context, and falls back on error', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-midturn-condense-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const calls = { region: [], overflow: [] }
  let tokens = 96_000
  let failRegion = false
  const events = [
    { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 1' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 1' }] } } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 2' }] } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 2' }] } } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 3' }] } },
    { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 3' }] } } },
  ]
  const compaction = {
    async compactIfNeeded(_agent, trigger) {
      calls.overflow.push(trigger)
      tokens = 30_000
      return { ok: true }
    },
    async compactNow() { return { ok: true } },
    async compactRegion(start, end) {
      calls.region.push([start, end])
      if (failRegion) throw new Error('replacement did not shrink')
      tokens = 35_000
      return { ok: true }
    },
    async summarize() { return { summary: [{ type: 'text', text: 'ok' }] } },
  }
  const ctx = fakeContext({
    services: {
      compaction,
      tokenMeter: {
        ...meter,
        measure: () => ({
          totalTokens: tokens,
          nodes: [
            { seq: 0, tokens: 10_000 },
            { seq: 1, tokens: 20_000 },
            { seq: 2, tokens: 20_000 },
            { seq: 3, tokens: 18_000 },
            { seq: 4, tokens: 18_000 },
            { seq: 5, tokens: 5_000 },
            { seq: 6, tokens: 5_000 },
          ],
        }),
      },
    },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 4_000 }),
      stream: () => makeStream({ text: JSON.stringify({ action: 'compact', reason: 'still working' }) })(),
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: events.length } } }),
      page: async () => ({ records: events.map(event => ({ event })), hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const agent = {
    id: 'b2',
    status: 'running',
    inbox: { nextStep: [], nextTurn: [] },
    session: {
      id: 'b2',
      seq: events.length,
      surface: { nodes: events.map(e => e.seq) },
      eventAt: seq => events[seq],
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  const preStep = ctx.listeners.get('agent/pre-step').find(listener => /adoptCompaction/.test(String(listener)))

  // 1) Retained-tail compactRegion runs: usable=96k -> retainTokens=15,360, so nodes 5+6 (10k)
  //    plus paired turn 2 (nodes 3+4) stay verbatim while older prefix seq 1..2 is compacted!
  await preStep({ agent, step: 2, messages: [], signal: new AbortController().signal }, async () => 'continued')
  assert.deepEqual(calls.region, [[1, 2]], 'mid-turn condense must compact older prefix via compactRegion while retaining recent turns')
  assert.deepEqual(calls.overflow, [], 'context-overflow must not run when retained-tail compaction succeeded below check line')

  // 2) If compactRegion throws a shrink error, condense gracefully falls back to context-overflow.
  failRegion = true
  tokens = 96_000
  await preStep({ agent, step: 3, messages: [], signal: new AbortController().signal }, async () => 'continued')
  assert.equal(calls.region.length, 2)
  assert.deepEqual(calls.overflow, ['context-overflow'])
})

test('idle writeCheckpoint lowers reasoning effort, retries without tools on tool-call output, and keeps recent replies + redacted tool trail without duplicating tail', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-idle-ckpt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const llmCalls = []
  const replies = [
    { toolCall: 'read_file' }, // First attempt mistakenly tries to call a tool
    { text: '- Done: inspected auth.js and proposed options A/B/C' }, // Retry without tools succeeds
  ]
  const checkpoints = []
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow(agent, signal) {
      checkpoints.push(await this.summarize({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
          { role: 'user', content: [{ type: 'text', text: `Fix bug in auth\n${'Earlier detailed trace. '.repeat(400)}` }] },
          { role: 'assistant', content: [{ type: 'text', text: `Options are A (cache) and B (refresh).\n${'Long analysis output. '.repeat(400)}` }] },
          { role: 'user', content: [{ type: 'text', text: 'Also check config.js' }] },
        ],
        tools: [{ name: 'read_file' }],
      }, agent, signal))
      return { ok: true }
    },
    async compactRegion() { return { ok: true } },
    async summarize() { return { summary: [] } },
  }
  const history = [
    { seq: 1, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix bug in auth' }] } },
    { seq: 2, time: 1100, type: 'tool/call', data: { callId: 'c1', name: 'read_file', arguments: { path: 'src/auth.js' } } },
    { seq: 3, time: 1200, type: 'tool/result', data: { message: { toolCallId: 'c1', ok: true, content: [] } } },
    { seq: 4, time: 1300, type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: { command: 'curl -H "Bearer SUPER_SECRET_999" https://api.test' } } },
    { seq: 5, time: 1400, type: 'tool/result', data: { message: { toolCallId: 'c2', ok: false, content: [{ type: 'text', text: '401 failed with SUPER_SECRET_999' }] } } },
    { seq: 6, time: 1500, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Options are A (cache) and B (refresh).' }] } } },
    { seq: 7, time: 1600, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Also check config.js' }] } },
    { seq: 8, time: 1700, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'config.js is clean.' }] } } },
  ]
  const ctx = fakeContext({
    services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 85_000 }) } },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'reasoner' }],
      resolveModelInfo: async () => ({
        context: { contextWindow: 100_000 },
        defaultMaxTokens: 8_000,
        reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      }),
      stream(options) {
        llmCalls.push(options)
        return makeStream(replies.shift())()
      },
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: history.length + 1 } } }),
      page: async () => ({ records: history.map(event => ({ event })), hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.redactSecrets = text => String(text).replaceAll('SUPER_SECRET_999', '[REDACTED]')

  const agent = {
    id: 'b2',
    status: 'idle',
    session: {
      id: 'b2',
      seq: history.length + 1,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } }),
      deriveMessages: () => [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'Fix bug in auth' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Options are A (cache) and B (refresh).' }] },
        { role: 'user', content: [{ type: 'text', text: 'Also check config.js' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'config.js is clean.' }] }, // tail[0] kept on surface
      ],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  // Call engine.summarize directly as compactNow does (bypassing user /compact refusal via compactNow inside test)
  const originalNow = compaction[Symbol.for('ds-bot/compaction')].compactNow
  await originalNow.call(compaction, agent, new AbortController().signal)

  assert.equal(llmCalls.length, 2, 'must retry once without tools when first attempt returns tool-calls')
  assert.equal(llmCalls[0].reasoningEffort, 'off', 'checkpoint summary must lower reasoningEffort instead of inheriting high')
  assert.ok(Array.isArray(llmCalls[0].tools) && llmCalls[0].tools.length === 1)
  assert.equal(llmCalls[1].tools, undefined, 'retry must omit tools')

  const text = checkpoints[0].summary[0].text
  assert.match(text, /## Recent exchanges, word for word \(oldest first\)/)
  assert.match(text, /You: Options are A \(cache\) and B \(refresh\)\./, 'must preserve Bot recent reply verbatim')
  assert.doesNotMatch(text, /You: config\.js is clean\./, 'must not duplicate the single tail reply kept on surface')
  assert.match(text, /## Recent tool activity \(oldest first\)/)
  assert.match(text, /read_file\(src\/auth\.js\) -> ok/)
  assert.match(text, /bash\(curl -H "Bearer \[REDACTED\]" https:\/\/api\.test\) -> error: 401 failed with \[REDACTED\]/)
  assert.doesNotMatch(text, /SUPER_SECRET_999/, 'tool trail must redact secrets')
})

test('model-switch compaction retries target route with trimmed transcript when target overflows on full history', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-switch-trim-'))
  const team = { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, model: 'small/mini' } } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const calls = []
  const checkpoints = []
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow() { return null },
    async compactRegion(_start, _end, agent, signal) {
      checkpoints.push(await this.summarize({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
          { role: 'user', content: [{ type: 'text', text: 'Big history '.repeat(300) }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Detailed analysis '.repeat(300) }] },
        ],
      }, agent, signal))
    },
    async summarize() { return { summary: [] } },
  }
  const ctx = fakeContext({
    services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 50_000 }) } },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'old', name: 'Old' }, { id: 'small', name: 'Small' }],
      listModels: async () => [{ id: 'mini' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4_000 }),
      stream(options) {
        calls.push({ model: `${options.provider}/${options.model}`, msgCount: options.messages.length, text: options.messages.at(-1).content[0].text })
        if (options.provider === 'old') return makeStream({ error: new Error('429: quota exhausted') })()
        if (calls.filter(c => c.model === 'small/mini').length === 1) {
          return makeStream({ error: Object.assign(new Error('context_length_exceeded: prompt too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' }) })()
        }
        return makeStream({ text: '- Summary from trimmed transcript on target model' })()
      },
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 2 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  rt.desiredModel = async () => 'small/mini'

  const agent = {
    id: 'b2',
    session: {
      id: 'b2',
      seq: 2,
      requestHeader: () => ({ config: { provider: 'old', model: 'big' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  await compaction.compactRegion(1, 2, agent, new AbortController().signal)

  assert.deepEqual(calls.map(c => c.model), ['old/big', 'small/mini', 'small/mini'])
  assert.match(calls[2].text, /Recent conversation excerpt \(oldest first\):/)
  assert.match(checkpoints[0].summary[0].text, /Summary from trimmed transcript on target model/)
  assert.doesNotMatch(checkpoints[0].summary[0].text, /No summary was written/)
})

test('partLines flushes replies past page cap, askSteward scans past 2 pages on tool-heavy turns, and historyEntry keeps schedules', async (t) => {
  const scheduled = {
    type: 'user/message',
    data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[Scheduled task]\nPrompt: Check build status' }] },
  }
  const parsedSchedule = historyEntry(scheduled, false)
  assert.equal(parsedSchedule?.who, 'bot')
  assert.equal(parsedSchedule?.keepAnswers, true)
  assert.match(parsedSchedule?.text ?? '', /Check build status/)

  // Simulate a 450-event tool turn: user message at seq 1, 448 tool events, assistant reply at seq 450.
  const events = [
    { seq: 1, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the 200-step migration' }] } },
    ...Array.from({ length: 448 }, (_, i) => ({ seq: i + 2, time: 1000 + i, type: 'tool/call', data: { callId: `c${i}`, name: 'read_file', arguments: { path: `f${i}.js` } } })),
    { seq: 450, time: 2000, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Halfway through migration, 100 files left.' }] } } },
  ]
  const stewardPrompts = []
  const home = mkdtempSync(join(tmpdir(), 'dsb-steward-pages-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow() { return { ok: true } },
    async compactRegion() { return { ok: true } },
    async summarize() { return { summary: [{ type: 'text', text: 'summary' }] } },
  }
  const ctx = fakeContext({
    services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 85_000 }) } },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 4_000 }),
      stream(options) {
        if (options.system?.includes('context steward')) {
          stewardPrompts.push(options.messages[0].content[0].text)
          return makeStream({ text: '{"action":"compact","reason":"still running"}' })()
        }
        return makeStream({ text: '- summary' })()
      },
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: events.length + 1 } } }),
      page: async ({ beforeSeq, maxMessages = 200 }) => {
        const end = beforeSeq === undefined ? events.length : events.findIndex(e => e.seq >= beforeSeq)
        const sliceEnd = end === -1 ? events.length : end
        const sliceStart = Math.max(0, sliceEnd - maxMessages)
        return { records: events.slice(sliceStart, sliceEnd).map(event => ({ event })), hasMore: sliceStart > 0 }
      },
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const agent = {
    id: 'b2',
    status: 'idle',
    session: {
      id: 'b2',
      seq: events.length + 1,
      eventAt: () => undefined,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  ctx.emit('agent/status', { agent, status: 'idle' })
  for (let i = 0; i < 40 && stewardPrompts.length === 0; i += 1) await new Promise(r => setTimeout(r, 15))
  assert.equal(stewardPrompts.length, 1)
  assert.match(stewardPrompts[0], /User: Run the 200-step migration/, 'steward must see initiating user message past 2 pages of tool events')
  assert.match(stewardPrompts[0], /Assistant: Halfway through migration, 100 files left\./)
  assert.doesNotMatch(stewardPrompts[0], /Latest messages, oldest first:\n\(none\)/)
})

test('handoff note keeps substantial partial note on final attempt, retries without tools on tool-calls, and handoffPackage carries recent tool trail', async () => {
  const runSwitch = async ({ replies, events = [] }) => {
    const requests = []
    const followups = []
    let seq = 1
    const ctx = fakeContext({
      services: { tokenMeter: { ...meter, measure: () => ({ totalTokens: 90_000 }) } },
    })
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8_000 }) }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    const bot = { id: 'b1', name: 'Writer', sessionId: 's1', segments: [{ sessionId: 's0', endedAt: 1, note: 'STALE NOTE FROM PART 1' }] }
    const agents = new Map()
    const makeAgent = (id) => ({
      id,
      status: 'idle',
      inbox: { nextStep: [], nextTurn: [], remove: () => {} },
      whenIdle: async () => {},
      runMaintenance: async fn => fn(new AbortController().signal),
      followup: msg => followups.push(msg),
      session: {
        id,
        seq: events.length + 1,
        eventAt: () => undefined,
        header: { cwd: '/ws' },
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' }, tools: [{ name: 'read_file' }] }),
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }],
        toolHistory: () => [],
      },
    })
    agents.set('s1', makeAgent('s1'))
    const rt = {
      ctx,
      config: {},
      state: { bots: { b1: bot }, rooms: {}, questions: {}, views: {}, switching: {}, exchangeTurns: {} },
      readOnly: () => undefined,
      isBotSession: id => id === 's1' || id === 's2',
      selfOf: id => (id === 's1' || id === 's2' ? 'b1' : undefined),
      botOf: id => (id === 'b1' ? bot : undefined),
      roomOf: () => undefined,
      chatOf: () => bot.sessionId,
      groupOwners: new Map(),
      roomOwners: new Map(),
      pastOwners: new Map(),
      chatOwners: new Map([['s1', 'b1']]),
      liveOf: () => ({}),
      load: async () => {},
      save: async () => {},
      warn: () => {},
      redactSecrets: text => text,
      renewMemory: () => {},
      workDirOf: () => '/ws',
      teamFolder: () => '/ws',
      isFolder: async () => true,
      desiredModel: async () => 'deepseek/v4',
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {},
      applyPermission: async () => {},
      ensureCapabilities: async () => {},
      moveSchedules: async () => {},
      createSession: async () => { const id = `s${++seq}`; agents.set(id, makeAgent(id)); return id },
      resolveAgent: async id => agents.get(id),
      eventsBackwards: async function* (_sid, _sig, _pages, read) {
        for (const ev of [...events].reverse()) yield ev
        if (read) read.complete = true
      },
      assembleLlm: async (options) => {
        requests.push(options)
        const next = replies.shift()
        return {
          finish: { kind: next.kind ?? 'stop' },
          blocks: () => (next.text ? [{ type: 'text', text: next.text }] : []),
          usage: next.usage,
        }
      },
    }
    installParts(rt)
    ctx.emit('agent/status', { agent: agents.get('s1'), status: 'idle' })
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) await new Promise(r => setTimeout(r, 10))
    return { requests, packageText: followups.at(-1)?.content?.[0]?.text ?? '' }
  }

  // 1) Partial note (6 of 8 headings) on both attempts is kept instead of falling back to STALE NOTE FROM PART 1.
  const partialNote = [
    '## Goals', '- Migrate auth service',
    '## Constraints and preferences', '- Keep zero downtime',
    '## Progress', '- Done: updated src/auth.js',
    '## Decisions', '- Chosen JWT rotation',
    '## Facts to keep', '- Endpoint is /v2/token',
    '## Next step', '- Run integration tests',
  ].join('\n')
  const partial = await runSwitch({
    replies: [{ text: partialNote }, { text: partialNote }],
    events: [
      { seq: 1, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Migrate auth' }] } },
      { seq: 2, time: 1100, type: 'tool/call', data: { callId: 't1', name: 'edit_file', arguments: { path: 'src/auth.js' } } },
      { seq: 3, time: 1200, type: 'tool/result', data: { message: { toolCallId: 't1', ok: true, content: [] } } },
    ],
  })
  assert.equal(partial.requests.length, 2, 'attempt 1 still retries once for missing headings')
  assert.match(partial.packageText, /Migrate auth service/, 'must keep substantial partial note instead of discarding it')
  assert.doesNotMatch(partial.packageText, /STALE NOTE FROM PART 1/, 'must not fall back to stale note when a substantial partial note was written')
  assert.match(partial.packageText, /## Recent tool activity \(oldest first\)/)
  assert.match(partial.packageText, /edit_file\(src\/auth\.js\) -> ok/)

  // 2) Tool-call finish on attempt 1 retries without tools on attempt 2 and succeeds.
  const fullNote = [
    '## Goals\n- g', '## Constraints and preferences\n- c', '## Progress\n- p', '## Decisions\n- d',
    '## Facts to keep\n- f', '## Open threads\n- o', '## Next step\n- n', '## Where to look\n- w',
  ].join('\n\n')
  const toolRetry = await runSwitch({
    replies: [{ text: '', kind: 'tool-calls' }, { text: fullNote }],
  })
  assert.equal(toolRetry.requests.length, 2)
  assert.ok(Array.isArray(toolRetry.requests[0].tools))
  assert.equal(toolRetry.requests[1].tools, undefined, 'retry after tool-calls must omit tools')
  assert.match(toolRetry.packageText, /## Goals\n- g/)
})

test('parseReview handles fenced JSON and JSON surrounded by prose with braces without losing changes', () => {
  assert.deepEqual(
    parseReview('Reviewed {session} notes:\n```json\n{"changes": [{"op": "add", "text": "User uses pnpm"}]}\n```'),
    { changes: [{ op: 'add', text: 'User uses pnpm' }], leftOut: [] },
  )
  assert.deepEqual(
    parseReview('For {user}, here is the result: {"changes": [{"op": "add", "text": "Keep concise"}]} done.'),
    { changes: [{ op: 'add', text: 'Keep concise' }], leftOut: [] },
  )
  assert.equal(parseReview('Just prose with {braces} and no JSON'), undefined)
})

test('checkpointText keeps backward-compatible format when recent/tools are empty and renders them when provided', () => {
  const plain = checkpointText({ number: 1, summary: 'sum', kept: ['User: hi'], more: false })
  assert.doesNotMatch(plain, /Recent exchanges/)
  assert.doesNotMatch(plain, /Recent tool activity/)

  const rich = checkpointText({
    number: 2,
    summary: 'sum',
    recent: ['[part 1 #3] User: choose option', '[part 1 #4] You: A or B'],
    tools: ['- [10:00] read_file(src/a.js) -> ok'],
    kept: ['[part 1 #1] User: start'],
    more: false,
  })
  assert.match(rich, /## Recent exchanges, word for word \(oldest first\)/)
  assert.match(rich, /You: A or B/)
  assert.match(rich, /## Recent tool activity \(oldest first\)/)
  assert.match(rich, /read_file\(src\/a\.js\) -> ok/)
  assert.match(rich, /## Earlier messages to you, word for word \(oldest first\)/)
})

async function bootRealDshBot(t, { contextWindow = 100_000, defaultMaxTokens = 4_000, checkRatio = 0.5, onTurn }) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-real-dsh-ctx-'))
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  await root.plugin(BasicCompactionEngine)

  const calls = []
  let partCounter = 0

  class RealContractAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'mock' } }
    async listModels() { return [{ id: 'm', name: 'm', inputModalities: ['text'] }] }
    async resolveModel(provider, id) {
      return {
        provider,
        id,
        name: id,
        inputModalities: ['text'],
        context: { contextWindow },
        defaultMaxTokens,
        reasoning: {
          defaultEffort: 'high',
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
        },
      }
    }
    async *stream(req) {
      const sys = req.system ?? ''
      if (req.purpose === 'compaction') {
        const isSteward = sys.includes('context steward')
        const kind = isSteward ? 'steward' : 'checkpoint'
        calls.push({ kind, reasoningEffort: req.reasoningEffort, messages: req.messages })
        const text = isSteward
          ? JSON.stringify({ action: 'compact', reason: 'still working on task' })
          : '- Done: earlier turns summarized cleanly\n- Remaining: continue active task'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const step = calls.filter(c => c.kind === 'turn').length + 1
      calls.push({ kind: 'turn', step, messages: req.messages })
      const plan = onTurn(step, req)
      if (plan.toolCall) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: plan.toolCall.id, name: plan.toolCall.name }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: plan.toolCall.id, name: plan.toolCall.name, arguments: JSON.stringify(plan.toolCall.args ?? {}) },
        }
      } else {
        const text = plan.text ?? `reply ${step}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      }
      if (plan.usage) yield { type: 'usage', usage: plan.usage }
      yield { type: 'finish', reason: { kind: plan.toolCall ? 'tool-calls' : 'stop' } }
    }
  }

  root.llm.registerAdapter(['mock'], new RealContractAdapter())
  await mountAgentLoopTestHarness(root)
  const { agents, tools } = await new Promise(resolve => root.inject(['agents', 'tools'], resolve))
  tools.register(defineTool({
    name: 'inspect_file',
    description: 'Inspect a file path',
    parameters: { path: { type: 'string', description: 'File path to inspect' } },
    output,
    execute: async ({ path }) => `inspected ${path}: ok`,
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
    page: async ({ address, beforeSeq, throughSeq, maxMessages = 200 }) => {
      const events = agents.get(address.sessionId)?.session?.snapshotEvents?.() ?? []
      const filtered = events.filter(ev =>
        (throughSeq === undefined || ev.seq <= throughSeq)
        && (beforeSeq === undefined || ev.seq < beforeSeq))
      const slice = filtered.slice(-maxMessages)
      return { records: slice.map(event => ({ event })), hasMore: filtered.length > slice.length }
    },
    create: async ({ cwd }) => {
      const id = `part-${++partCounter}`
      const created = await agents.create({
        sessionId: id,
        agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens },
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
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1, model: 'mock/m' } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const rt = createRuntime(root, { home, checkRatio })
  await rt.load()
  const { agent } = await agents.create({
    sessionId: 'm1',
    agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens, reasoningEffort: 'high' },
    meta: { cwd: home },
  })
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const runTurn = async (text) => {
    const done = new Promise((resolve) => {
      const off = root.on('agent/status', ({ agent: a, status }) => {
        if (a.id === agent.id && status === 'idle') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
  }

  return { rt, agent, calls, runTurn }
}

test('real DSH BasicCompactionEngine: idle compactNow commits checkpoint carrying Bot recent replies and tool trail', async (t) => {
  const big = 'Detailed specification paragraph. '.repeat(1_200) // ~10k tokens
  const { agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.45, // usable=46,000, check=20,700
    onTurn(step) {
      if (step === 1) return { text: `TURN1_PLAN: Option A uses cache, Option B uses refresh.\n${big}`, usage: { inputTokens: 2_000, outputTokens: 10_000 } }
      if (step === 2) return { toolCall: { id: 'tc-real-1', name: 'inspect_file', args: { path: 'src/auth.js' } }, usage: { inputTokens: 13_000, outputTokens: 200 } }
      if (step === 3) return { text: `TURN2_FINAL: src/auth.js verified.\n${big}`, usage: { inputTokens: 14_000, outputTokens: 10_000 } }
      return { text: 'TURN3_OK', usage: { inputTokens: 5_000, outputTokens: 100 } }
    },
  })

  await runTurn('Start auth audit')
  await runTurn('Inspect src/auth.js now')
  // Wait for idle checkContext -> steward -> real BasicCompactionEngine.compactNow to commit.
  const deadline = Date.now() + 5_000
  while (!calls.some(c => c.kind === 'checkpoint') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15))
  }
  await new Promise(r => setTimeout(r, 80))

  const ckptCall = calls.find(c => c.kind === 'checkpoint')
  assert.ok(ckptCall, 'real idle checkpoint must run')
  assert.equal(ckptCall.reasoningEffort, 'off', 'real checkpoint must lower reasoning effort from high to off')

  // Verify the actual committed surface derived by real DSH!
  const derived = agent.session.deriveMessages()
  const checkpointMsg = derived.find(m => m.role === 'user' && (m.content ?? []).some(b => String(b.text ?? '').includes('[Checkpoint 1]')))
  assert.ok(checkpointMsg, 'real DSH surface must hold committed [Checkpoint 1]')
  const ckptText = checkpointMsg.content.map(b => b.text ?? '').join('\n')
  assert.match(ckptText, /## Recent exchanges, word for word \(oldest first\)/)
  assert.match(ckptText, /TURN1_PLAN: Option A uses cache, Option B uses refresh\./, 'idle checkpoint must keep prior Bot reply verbatim')
  assert.match(ckptText, /## Recent tool activity \(oldest first\)/)
  assert.match(ckptText, /inspect_file\(src\/auth\.js\) -> ok/, 'idle checkpoint must record real tool call and result')
  assert.doesNotMatch(ckptText, /You: TURN2_FINAL: src\/auth\.js verified\./, 'idle checkpoint must not duplicate the tail message already kept on surface')
})

test('real DSH BasicCompactionEngine: mid-turn compactRegion keeps recent verbatim tool-call/result tail intact on surface', async (t) => {
  const big = 'Long analysis output block. '.repeat(900) // ~6.3k tokens each (3 turns stay well below check=41.4k)
  const { agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.9, // usable=46,000, check=41,400, hard=43,700
    onTurn(step) {
      if (step === 1) return { text: `STEP1_OLD_WORK\n${big}`, usage: { inputTokens: 2_000, outputTokens: 6_300 } }
      if (step === 2) return { text: `STEP2_OLD_WORK\n${big}`, usage: { inputTokens: 8_500, outputTokens: 6_300 } }
      if (step === 3) return { text: `STEP3_OLD_WORK\n${big}`, usage: { inputTokens: 15_000, outputTokens: 6_300 } }
      // Turn 4 calls a tool and crosses hard line (43,700) BEFORE step 5!
      if (step === 4) return { toolCall: { id: 'tc-mid-1', name: 'inspect_file', args: { path: 'src/session.js' } }, usage: { inputTokens: 44_000, outputTokens: 300 } }
      return { text: 'TURN4_DONE', usage: { inputTokens: 15_000, outputTokens: 200 } }
    },
  })

  await runTurn('Phase 1')
  await runTurn('Phase 2')
  await runTurn('Phase 3')
  await runTurn(`Phase 4 live prompt\n${'Recent context detail. '.repeat(250)}`)

  const finalTurnReq = calls.filter(c => c.kind === 'turn').at(-1)
  assert.ok(calls.some(c => c.kind === 'checkpoint'), 'mid-turn compaction must have run')
  const msgs = finalTurnReq.messages
  const hasCheckpoint = msgs.some(m => m.role === 'user' && (m.content ?? []).some(b => String(b.text ?? '').includes('[Checkpoint 1]')))
  assert.ok(hasCheckpoint, 'next model step must see committed [Checkpoint 1]')
  assert.ok(msgs.some(m => m.role === 'assistant' && (m.content ?? []).some(b => b.type === 'tool-call' && b.name === 'inspect_file')), 'mid-turn retained tail must keep real assistant tool-call message intact on surface')
  assert.ok(msgs.some(m => m.role === 'tool' && (m.content ?? []).some(b => String(b.text ?? '').includes('inspected src/session.js: ok'))), 'mid-turn retained tail must keep real tool result verbatim on surface')
  assert.ok(msgs.some(m => m.role === 'user' && (m.content ?? []).some(b => String(b.text ?? '').includes('Phase 4 live prompt'))), 'mid-turn retained tail must keep current turn user message intact on surface')
  assert.equal(agent.session.id, 'm1', 'bot must stay on same part after mid-turn compaction')
})
