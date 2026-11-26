import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

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

test('mid-turn condense uses compactRegion with retained tail instead of wiping all recent context, and falls back cleanly on errors', async (t) => {
  const runCase = async ({ onRegion, onOverflow }) => {
    const home = mkdtempSync(join(tmpdir(), 'dsb-midturn-condense-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

    const calls = { region: [], overflow: [] }
    let tokens = 96_000
    const events = [
      { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 1' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 1' }] } } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 2' }] } },
      { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 2' }] } } },
      { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'step 3' }] } },
      { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply 3' }] } } },
    ]
    const setTokens = next => { tokens = next }
    const compaction = {
      async compactIfNeeded(_agent, trigger) {
        calls.overflow.push(trigger)
        return onOverflow(setTokens)
      },
      async compactNow() { return { ok: true } },
      async compactRegion(start, end) {
        calls.region.push([start, end])
        return onRegion(setTokens)
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
    const rt = createRuntime(ctx, { home })
    t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

    let renewed = 0
    const origRenew = rt.renewMemory
    rt.renewMemory = (...args) => { renewed += 1; return origRenew?.(...args) }
    let condensedLogged = 0
    const origInfo = ctx.logger.info
    ctx.logger.info = (...args) => { if (String(args[0]).includes('condensed from')) condensedLogged += 1; return origInfo(...args) }

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
    const stepResult = await preStep({ agent, step: 2, messages: [], signal: new AbortController().signal }, async () => 'continued')
    return { calls, renewed, condensedLogged, stepResult }
  }

  // 1) Retained-tail compactRegion runs: usable=96k, check=76.8k, hard=91.2k -> shrinking
  //    to 80k (still >= check, but safely < hard) keeps the retained tail intact and lets the
  //    active turn continue on the same part without clobbering it via context-overflow!
  const retained = await runCase({
    onRegion: (setTokens) => { setTokens(80_000); return { ok: true } },
    onOverflow: (setTokens) => { setTokens(30_000); return { ok: true } },
  })
  assert.deepEqual(retained.calls.region, [[1, 2]], 'mid-turn condense must compact older prefix via compactRegion while retaining recent turns')
  assert.deepEqual(retained.calls.overflow, [], 'context-overflow must not clobber retained tail once mid-turn tokens drop below hard line')
  assert.equal(retained.stepResult, 'continued', 'active turn must continue on same part when mid-turn condense drops below hard line')
  assert.equal(retained.renewed, 1)

  // 2) If compactRegion throws a shrink error, condense falls back to context-overflow ONCE
  //    (never running context-overflow twice even when tokens stay >= hard line).
  const fallback = await runCase({
    onRegion: () => { throw new Error('replacement did not shrink') },
    onOverflow: (setTokens) => { setTokens(93_000); return { ok: true } },
  })
  assert.deepEqual(fallback.calls.region, [[1, 2]])
  assert.deepEqual(fallback.calls.overflow, ['context-overflow'], 'fallback context-overflow must not run twice in a row')
  assert.equal(fallback.renewed, 1)

  // 3) If compactRegion commits (leaving tokens >= hard) and follow-up context-overflow throws,
  //    renewMemory/partBase still runs because the retained-tail compaction already mutated the session.
  const followUpFail = await runCase({
    onRegion: (setTokens) => { setTokens(92_000); return { ok: true } },
    onOverflow: () => { throw new Error('follow-up overflow failed') },
  })
  assert.deepEqual(followUpFail.calls.region, [[1, 2]])
  assert.deepEqual(followUpFail.calls.overflow, ['context-overflow'])
  assert.equal(followUpFail.renewed, 1, 'already-committed compactRegion must still run renewMemory even if follow-up overflow fails')
  assert.equal(followUpFail.condensedLogged, 1, 'already-committed compactRegion must still finish partBase/log even if follow-up overflow fails')
})

test('idle writeCheckpoint preserves reasoning effort on attempt 1, retries without tools at lower effort on tool-call output, and keeps recent replies + redacted tool trail without duplicating tail', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-idle-ckpt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const llmCalls = []
  const replies = [
    { toolCall: 'read_file' }, // First attempt mistakenly tries to call a tool
    { text: '- Done: inspected auth.js and proposed options A/B/C' }, // Retry without tools succeeds
  ]
  const checkpoints = []
  const frozenInputMessages = deepFreeze([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current time: 10:00' }] },
    { role: 'user', content: [{ type: 'text', text: `Fix bug in auth\n${'Earlier detailed trace. '.repeat(400)}` }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'src/auth.js' } }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'auth.js body' }] },
    { role: 'assistant', content: [{ type: 'text', text: `Options are A (cache) and B (refresh).\n${'Long analysis output. '.repeat(400)}` }] },
    { role: 'user', content: [{ type: 'text', text: 'Also check config.js' }] },
  ])
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow(agent, signal) {
      checkpoints.push(await this.summarize({
        messages: frozenInputMessages,
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
      deriveMessages: () => deepFreeze([
        ...frozenInputMessages,
        { role: 'assistant', content: [{ type: 'text', text: 'config.js is clean.' }] }, // tail[0] kept on surface
      ]),
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  // Call engine.summarize directly as compactNow does (bypassing user /compact refusal via compactNow inside test)
  const originalNow = compaction[Symbol.for('ds-bot/compaction')].compactNow
  await originalNow.call(compaction, agent, new AbortController().signal)

  assert.equal(llmCalls.length, 2, 'must retry once without tools when first attempt returns tool-calls')
  assert.equal(llmCalls[0].reasoningEffort, 'high', 'checkpoint attempt 1 must preserve route reasoningEffort for KV prefix cache reuse')
  assert.equal(llmCalls[1].reasoningEffort, 'off', 'withoutTools retry lowers reasoningEffort since tools were stripped')
  assert.ok(Array.isArray(llmCalls[0].tools) && llmCalls[0].tools.length === 1)
  assert.equal(llmCalls[1].tools, undefined, 'retry must omit tools')
  assert.equal(frozenInputMessages[1].content[0].text, 'Current time: 10:00', 'stripToolBlocks must not mutate frozen DSH input messages')
  assert.match(llmCalls[1].messages[1].content[0].text, /Current time: 10:00[\s\S]*Fix bug in auth/, 'adjacent same-role frozen messages must merge into a fresh object')
  assert.equal(llmCalls[1].messages.some(m => m.role === 'tool'), false, 'withoutTools retry must not send raw role:tool messages')
  assert.equal(
    llmCalls[1].messages.some(m => Array.isArray(m.content) && m.content.some(b => b?.type === 'tool-call' || b?.type === 'tool-result')),
    false,
    'withoutTools retry must strip raw tool-call/tool-result blocks for strict providers',
  )

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
    data: {
      source: { kind: 'schedule' },
      content: [{ type: 'text', text: 'A scheduled reminder fired.\nreminder_prompt_json: "Check build status"' }],
    },
  }
  const parsedSchedule = historyEntry(scheduled, false)
  assert.equal(parsedSchedule?.who, 'bot')
  assert.equal(parsedSchedule?.keepAnswers, true)
  assert.equal(parsedSchedule?.text, '[Scheduled reminder] Check build status')

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
  const runSwitch = async ({ replies, events = [], capped = false }) => {
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
        deriveMessages: () => deepFreeze([
          { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current time: 11:00' }] },
          { role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] },
          { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'read_file', arguments: { path: 'a.js' } }] },
          { role: 'tool', toolCallId: 'tc1', content: [{ type: 'text', text: 'file contents' }] },
        ]),
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
        if (read) {
          read.capped = capped
          read.complete = !capped
        }
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

  // 2) Tool-call finish on attempt 1 retries without tools AND strips raw tool blocks on attempt 2.
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
  assert.equal(toolRetry.requests[1].messages.some(m => m.role === 'tool'), false, 'noteThrough withoutTools retry must strip role:tool messages')
  assert.equal(
    toolRetry.requests[1].messages.some(m => Array.isArray(m.content) && m.content.some(b => b?.type === 'tool-call' || b?.type === 'tool-result')),
    false,
    'noteThrough withoutTools retry must strip raw tool blocks',
  )
  assert.match(toolRetry.packageText, /## Goals\n- g/)

  // 3) Unrelated 4-heading reply with 0 canonical headings and empty-heading skeletons are rejected.
  const unrelated = '## Overview\n- Here is an essay about bananas.\n## History\n- Grown in tropical climates.\n## Nutrition\n- High in potassium.\n## Conclusion\n- Very tasty fruit indeed.'
  const emptySkeleton = '## Goals\n- (none)\n## Constraints and preferences\n- (none)\n## Progress\n- (none)\n## Decisions\n- (none)'
  for (const bad of [unrelated, emptySkeleton]) {
    const rejected = await runSwitch({ replies: [{ text: bad }, { text: bad }] })
    assert.match(rejected.packageText, /STALE NOTE FROM PART 1/, 'unrelated/empty partial reply must not be accepted as a handoff note')
  }

  // 4) When paging hits the page cap before an initiating user message, partLines flushes real
  //    assistant replies while filtering HANDOFF_ACK; on a complete scan, orphan replies are not flushed.
  const orphanEvents = [
    { seq: 1, time: 1000, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } } },
    { seq: 2, time: 1100, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Milestone 42 finished.' }] } } },
  ]
  const cappedRes = await runSwitch({ replies: [{ text: fullNote }], events: orphanEvents, capped: true })
  assert.match(cappedRes.packageText, /You: Milestone 42 finished\./, 'capped scan must flush real buffered replies')
  assert.doesNotMatch(cappedRes.packageText, /Noted\. I have my handoff note/, 'capped scan must not leak HANDOFF_ACK')

  const completeRes = await runSwitch({ replies: [{ text: fullNote }], events: orphanEvents, capped: false })
  assert.doesNotMatch(completeRes.packageText, /Milestone 42 finished/, 'complete scan must not flush orphan assistant messages with no initiating user message')
  assert.doesNotMatch(completeRes.packageText, /Noted\. I have my handoff note/)
})

test('parseReview handles fenced JSON and JSON surrounded by prose with stray braces or unmatched quotes', () => {
  assert.deepEqual(
    parseReview('Reviewed {session} notes:\n```json\n{"changes": [{"op": "add", "text": "User uses pnpm"}]}\n```'),
    { changes: [{ op: 'add', text: 'User uses pnpm' }], leftOut: [] },
  )
  assert.deepEqual(
    parseReview('For {user}, here is the result: {"changes": [{"op": "add", "text": "Keep concise"}]} done.'),
    { changes: [{ op: 'add', text: 'Keep concise' }], leftOut: [] },
  )
  assert.deepEqual(
    parseReview('Discussed 5" screen and opening { character before result: {"changes": [{"op": "add", "text": "Use {pnpm} \\"fast\\""}]}'),
    { changes: [{ op: 'add', text: 'Use {pnpm} "fast"' }], leftOut: [] },
  )
  assert.equal(parseReview('Just prose with {braces} and 5" quote and no JSON'), undefined)
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
  assert.equal(ckptCall.reasoningEffort, 'high', 'real checkpoint attempt 1 must preserve route reasoningEffort for KV prefix cache reuse')

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

test('freshMemoryView rebuilds current authorized memory snapshot and advances seen cursor cleanly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-fresh-mem-view-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  const memFile = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
  writeFileSync(memFile, '- Deploy to staging\n- Keep replies concise\n')

  const ctx = fakeContext()
  Object.assign(ctx, {
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()

  const memSection = ctx.sections.get('bot-memory')
  assert.ok(memSection, 'bot-memory section must be registered')
  const staticBefore = memSection.text({ agent: { id: 'b2' } })
  assert.match(staticBefore, /^# Your memory\n/)
  const preSteps = ctx.listeners.get('agent/pre-step') ?? []
  const runPreSteps = async (decision, history = []) => {
    let idx = 0
    const next = async () => (idx < preSteps.length ? preSteps[idx++]({ agent: { id: 'b2', session: { deriveMessages: () => history } }, signal: new AbortController().signal }, next) : decision)
    return next()
  }
  const initialDecision = await runPreSteps({ kind: 'continue', messages: [createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } })] })
  const ownSnap = initialDecision.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  assert.ok(ownSnap, 'part-opening own memory snapshot must be injected')
  assert.match(ownSnap.content[0].text, /Deploy to staging/)

  // Delete "Deploy to staging" and add a new memory entry via the real memory API.
  await rt.memoryEndpoint('memory-forget', { botId: 'b2', scope: 'own', text: 'Deploy to staging' })
  await rt.memoryAdd({ botId: 'b2', scope: 'own', text: 'Always run lint' })
  // System prompt stays byte-identical across memory changes (prefix-cache invariant).
  assert.equal(memSection.text({ agent: { id: 'b2' } }), staticBefore)

  // Refresh for CLI replay: returns current authorized view without deleted entry,
  // and advances watermark so subsequent edits still deliver as deltas.
  const view = rt.freshMemoryView('b2')
  assert.ok(view, 'freshMemoryView must return current snapshot')
  assert.doesNotMatch(view.own, /Deploy to staging/, 'freshMemoryView must not contain deleted entry')
  assert.match(view.own, /Always run lint/, 'freshMemoryView must include latest memory entry')

  // Any memory edit AFTER freshMemoryView must still be delivered as a delta on the next turn.
  await new Promise(r => setTimeout(r, 15))
  await rt.memoryAdd({ botId: 'b2', scope: 'own', text: 'Use pnpm workspaces' })
  const decision = await runPreSteps({ kind: 'continue', messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })] }, [ownSnap])
  const delta = decision.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.ok(delta, 'memory edit after freshMemoryView must still emit a memory-update delta')
  assert.match(delta.content[0].text, /Use pnpm workspaces/)
})

test('summaryThrough retries shorter on max-tokens, keeps substantial truncated summary, and rejects tiny fragments', async (t) => {
  const runSummary = async ({ replies, defaultMaxTokens = 4_096, routeMaxTokens }) => {
    const home = mkdtempSync(join(tmpdir(), 'dsb-ckpt-maxtok-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const llmCalls = []
    const checkpoints = []
    const queue = [...replies]
    const compaction = {
      async compactIfNeeded() { return null },
      async compactNow(agent, signal) {
        checkpoints.push(await this.summarize({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'sys' }] },
            { role: 'user', content: [{ type: 'text', text: 'Audit details. '.repeat(300) }] },
          ],
          tools: [{ name: 'read_file' }],
        }, agent, signal))
        return { ok: true }
      },
      async compactRegion() { return { ok: true } },
      async summarize() { return { summary: [] } },
    }
    const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 85_000 }) } } })
    Object.assign(ctx, {
      llm: {
        listProviders: () => [{ id: 'custom', name: 'Custom' }],
        listModels: async () => [{ id: 'flash' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens }),
        stream(options) {
          llmCalls.push(options)
          return makeStream(queue.shift())()
        },
      },
      sessions: { messageProjections: [] },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
        page: async () => ({ records: [], hasMore: false }),
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
        seq: 1,
        requestHeader: () => ({ config: { provider: 'custom', model: 'flash', ...(routeMaxTokens === undefined ? {} : { maxTokens: routeMaxTokens }) } }),
        deriveMessages: () => [],
        toolHistory: () => [],
      },
    }
    const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
    adopt({ agent })
    const originalNow = compaction[Symbol.for('ds-bot/compaction')].compactNow
    await originalNow.call(compaction, agent, new AbortController().signal)
    return { llmCalls, checkpointText: checkpoints[0].summary[0].text }
  }

  // 1) First attempt hits max-tokens -> retries once shorter and succeeds cleanly.
  const recovered = await runSummary({
    replies: [
      { text: 'Cut off early', kind: 'max-tokens' },
      { text: '- Done: batch 1 & 2 audited\n- Decision: Option B\n- Next: batch 3', kind: 'stop' },
    ],
    defaultMaxTokens: 8_192,
  })
  assert.equal(recovered.llmCalls.length, 2, 'must retry once shorter after max-tokens')
  assert.match(recovered.llmCalls[1].messages.at(-1).content[0].text, /much shorter.*thinking minimal/i)
  assert.equal(recovered.llmCalls[1].maxTokens, 8_192, 'shorter retry must respect declared defaultMaxTokens')
  assert.match(recovered.checkpointText, /Decision: Option B/)

  // 2) Both attempts hit max-tokens, but attempt 1 wrote a substantial summary (>= 200 chars) -> keep longest substantial summary!
  const substantialA = [
    '- Done: audited batch1.md (ISSUE_B1_REFUND_OVERFLOW), batch2.md (ISSUE_B2_JWT_SKEW, OWNER_NAME LinWei), and batch3.md (ISSUE_B3_RACE_LOCK, CUTOVER_DATE 2026-12-15).',
    '- Decision: chose Option B (versioned optimistic lock); never drop table billing_ledger.',
    '- Next: await batches 4 and 5 from user.',
  ].join('\n')
  const keptTruncated = await runSummary({
    replies: [
      { text: substantialA, kind: 'max-tokens' },
      { text: 'Short cut', kind: 'max-tokens' },
    ],
    routeMaxTokens: 4_096,
  })
  assert.equal(keptTruncated.llmCalls.length, 2)
  assert.equal(keptTruncated.llmCalls[1].maxTokens, 4_096, 'shorter retry must stay inside explicit route.maxTokens')
  assert.match(keptTruncated.checkpointText, /ISSUE_B1_REFUND_OVERFLOW/)
  assert.match(keptTruncated.checkpointText, /Option B/)

  // 3) Both attempts hit max-tokens with tiny fragments (< 200 chars) -> still rejects so garbage is never committed.
  await assert.rejects(
    () => runSummary({
      replies: [
        { text: 'Tiny cut', kind: 'max-tokens' },
        { text: 'Still tiny', kind: 'max-tokens' },
      ],
    }),
    /cut off at the output limit/,
  )
})

test('noteAttempts keeps substantial truncated partial note when retries hit max-tokens, prefers non-truncated partial, and askSteward lowers reasoning effort', async (t) => {
  const runNote = async (replies, info = {}) => {
    const warnings = []
    const requests = []
    const queue = [...replies]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_000_000 }) } } })
    ctx.logger = { warn: (fmt, ...a) => warnings.push(`${fmt} ${a.join(' ')}`), info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async (provider, model) => info[`${provider}/${model}`] ?? {},
      stream(options) {
        requests.push(options)
        return makeStream(queue.shift())()
      },
    }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'custom/flash', segments: [] }
    const messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Continue AUD-7710' }], source: { kind: 'user' } },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Audited batch 1-4.' }] },
    ]
    const session = {
      id: 's1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'custom', model: 'flash' } }),
      deriveMessages: () => messages,
      toolHistory: () => [],
    }
    const followed = []
    const agent = {
      id: 's1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(new AbortController().signal),
      inbox: { nextStep: [], nextTurn: [] },
      followup: msg => followed.push(msg),
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle', whenIdle: async () => {}, runMaintenance: async job => job(new AbortController().signal),
      inbox: { nextStep: [], nextTurn: [] }, followup: msg => followed.push(msg), send: async () => {},
    }
    const rt = {
      ctx, home: '/unused', config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: (fmt, ...a) => warnings.push(`${fmt} ${a.join(' ')}`),
      async save() {}, async load() {}, readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: () => undefined, selfOf: () => 'b1', isMain: () => false,
      chatOf: () => 's1', sessionOfRoom: () => undefined, isBotSession: id => ['s1', 's2'].includes(id),
      isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
      chatOwners: new Map([['s1', 'b1']]), groupOwners: new Map(), pastOwners: new Map(), roomOwners: new Map(),
      teamTools: [], live: new Map(), groupSessionsOf: () => [], unreadOf: () => [], clock: () => 'now',
      partsOf: () => [], partLines: async function* () {}, eventsBackwards: async function* () {},
      historyEntry: () => undefined, displayItems: async () => [], earlierPage: async () => ({}), chatPage: async () => ({}),
      followFolder: async () => {}, heldBack: () => [],
      resolveAgent: async id => (id === 's2' ? fresh : agent), createSession: async () => 's2',
      desiredModel: async subject => subject.model, desiredEffort: async () => undefined,
      selectSessionModel: async () => {}, applyModel: async () => {}, applyPermission: async () => {},
      ensureCapabilities: async () => {}, renewMemory: () => {}, moveSchedules: async () => {},
      sessionTitle: { rename: async () => {} }, deliver: async () => {}, teamFolder: () => '/tmp/team',
      workDirOf: () => '/tmp/team', isFolder: async () => true, uiLanguage: () => 'en', roomProgress: new Map(),
      defaultModel: async () => undefined,
    }
    installParts(rt)
    ctx.emit('agent/status', { agent, status: 'idle' })
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) await new Promise(r => setTimeout(r, 10))
    return { bot, requests, warnings, packageText: followed.map(m => m?.content?.map?.(b => b.text).join('') ?? '').join('\n') }
  }

  const fiveSectionCut = [
    '## Goals\n- Complete the AUD-7710 ledger audit across all 6 workspace batches.',
    '## Constraints and preferences\n- Never drop table `billing_ledger`.',
    '## Progress\n- Done: batch1.md through batch4.md audited.',
    '## Decisions\n- Chose Option B (versioned optimistic lock) over Option A.',
    '## Facts to keep\n- OWNER_NAME: LinWei, CUTOVER_DATE: 2026-12-15, ISSUE_B1_REFUND_OVERFLOW',
  ].join('\n\n')

  // 1) Both attempts hit max-tokens, but attempt 1 wrote 5 canonical sections -> keep it instead of discarding!
  const kept = await runNote([
    { text: fiveSectionCut, kind: 'max-tokens' },
    { text: '## Goals\n- truncated tiny', kind: 'max-tokens' },
  ])
  assert.equal(kept.bot.sessionId, 's2')
  assert.equal(kept.requests.length, 2)
  assert.match(kept.requests[1].messages.at(-1).content[0].text, /minimal internal thinking/i)
  assert.match(kept.packageText, /ISSUE_B1_REFUND_OVERFLOW/)
  assert.match(kept.packageText, /versioned optimistic lock/)
  assert.doesNotMatch(kept.packageText, /put this note together without the model/)

  // 2) Attempt 1 truncated (5 sections), attempt 2 non-truncated partial (4 sections) -> non-truncated partial wins!
  const fourSectionClean = [
    '## Goals\n- Clean partial goal for AUD-7710 audit completion.',
    '## Constraints and preferences\n- Never drop table `billing_ledger`.',
    '## Progress\n- Done: clean partial progress record.',
    '## Decisions\n- Selected Option B cleanly.',
  ].join('\n\n')
  const preferClean = await runNote([
    { text: fiveSectionCut, kind: 'max-tokens' },
    { text: fourSectionClean, kind: 'stop' },
  ])
  assert.equal(preferClean.bot.sessionId, 's2')
  assert.match(preferClean.packageText, /Clean partial goal for AUD-7710/)

  // 3) askSteward picks lowest reasoning effort ('minimal' when 'off' is absent) and caps maxTokens to route limit;
  //    condense logs wrapped error.cause so root cause is never hidden.
  const home = mkdtempSync(join(tmpdir(), 'dsb-steward-cause-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const stewardReqs = []
  const warnLogs = []
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow() {
      const err = new Error('manual compaction could not produce a smaller summary', { cause: new Error('the checkpoint was cut off at the output limit') })
      throw err
    },
    async compactRegion() { return { ok: true } },
    async summarize() { return { summary: [] } },
  }
  const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 30_000 }) } } })
  ctx.logger = { warn: (fmt, ...a) => warnLogs.push([fmt, ...a].join(' ')), info: () => {} }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'custom', name: 'Custom' }],
      listModels: async () => [{ id: 'small' }],
      resolveModelInfo: async () => ({
        context: { contextWindow: 40_000 },
        defaultMaxTokens: 2_048,
        reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] },
      }),
      stream(options) {
        stewardReqs.push(options)
        return makeStream({ text: JSON.stringify({ action: 'compact', reason: 'still working' }) })()
      },
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, checkRatio: 0.5 })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const origWarn = rt.warn
  rt.warn = (fmt, ...a) => { warnLogs.push([fmt, ...a].join(' ')); origWarn?.(fmt, ...a) }

  const agent = {
    id: 'b2', status: 'idle', inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {}, runMaintenance: async job => job(new AbortController().signal),
    session: {
      id: 'b2', seq: 1, header: { cwd: home },
      requestHeader: () => ({ config: { provider: 'custom', model: 'small' } }),
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  ctx.emit('agent/status', { agent, status: 'idle' })
  for (let i = 0; i < 100 && !warnLogs.some(l => l.includes('cause: the checkpoint was cut off')); i += 1) {
    await new Promise(r => setTimeout(r, 15))
  }
  assert.ok(stewardReqs.length >= 1, 'askSteward must have run')
  assert.equal(stewardReqs[0].reasoningEffort, 'minimal', 'askSteward must pick lowest declared reasoning effort when off is unavailable')
  assert.equal(stewardReqs[0].maxTokens, 2_048, 'askSteward must cap maxTokens to route/model limit')
  assert.ok(warnLogs.some(l => l.includes('cause: the checkpoint was cut off at the output limit')), `condense warning must include error.cause: ${warnLogs.join(' | ')}`)
})

test('max-tokens and overflow retries shrink input to leave output headroom under pi-ai context clamping', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-headroom-fit-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const hugeSystem = 'System rules and tool docs. '.repeat(1_600) // ~12.8k pi-tokens
  const hugeToolOut = 'Bulk audit file line. '.repeat(2_000) // ~12.5k pi-tokens each
  const llmCalls = []
  const checkpoints = []
  const compaction = {
    async compactIfNeeded() { return null },
    async compactNow(agent, signal) {
      checkpoints.push(await this.summarize({
        messages: [
          { role: 'system', content: [{ type: 'text', text: hugeSystem }] },
          { role: 'user', content: [{ type: 'text', text: '[Handoff · part 1] Keep ticket AUD-7710 and rule never drop billing_ledger.' }] },
          { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'batch1.md' } }] },
          { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: hugeToolOut }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Middle analysis. '.repeat(2_500) }] },
          { role: 'user', content: [{ type: 'text', text: 'Latest user turn: verify CUTOVER_DATE 2026-12-15.' }] },
        ],
        tools: [{ name: 'read_file' }, { name: 'bash' }],
      }, agent, signal))
      return { ok: true }
    },
    async compactRegion() { return { ok: true } },
    async summarize() { return { summary: [] } },
  }
  const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 38_000 }) } } })
  const estPiTokens = msgs => msgs.reduce((sum, m) => sum + Math.ceil((m.content ?? []).map(b => b.text ?? '').join('').length / 3.5) + 8, 0)
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'custom', name: 'Custom' }],
      listModels: async () => [{ id: 'flash' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens: 8_192 }),
      stream(options) {
        llmCalls.push(options)
        // Simulate pi-ai clampMaxTokensToContext(40000, context, 8192) -> returns max-tokens with 0 chars when input leaves < 4096 room!
        const est = estPiTokens(options.messages) + (options.tools ? 8_000 : 0)
        const avail = 40_000 - est - 4_096
        if (avail < 2_048) return makeStream({ text: '', kind: 'max-tokens' })()
        return makeStream({ text: '- Ticket AUD-7710; never drop billing_ledger; CUTOVER_DATE 2026-12-15.' })()
      },
    },
    sessions: { messageProjections: [] },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const agent = {
    id: 'b2', status: 'idle',
    session: {
      id: 'b2', seq: 1,
      requestHeader: () => ({ config: { provider: 'custom', model: 'flash' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    },
  }
  const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
  adopt({ agent })
  const originalNow = compaction[Symbol.for('ds-bot/compaction')].compactNow
  await originalNow.call(compaction, agent, new AbortController().signal)

  assert.equal(llmCalls.length, 2, 'must recover in 2nd attempt after pi-ai clamped 1st attempt to max-tokens')
  assert.equal(llmCalls[1].tools, undefined, 'retry after max-tokens must drop tools to free context window')
  for (const msg of llmCalls[1].messages) {
    if (msg.role === 'assistant') {
      assert.equal(msg.source?.kind, 'model', 'synthetic/rewritten assistant message must carry DSH model source')
      assert.equal(typeof msg.source?.provider, 'string')
      assert.equal(typeof msg.source?.model, 'string')
      assert.equal(msg.source?.replayState, undefined, 'rewritten assistant message must omit stale replayState')
    }
  }
  const retryEst = estPiTokens(llmCalls[1].messages)
  assert.ok(40_000 - retryEst - 4_096 >= 8_192, `retry input (${retryEst} pi-tokens) must leave >= 8192 output tokens under pi-ai safety clamp`)
  const retryJoined = llmCalls[1].messages.map(m => (m.content ?? []).map(b => b.text ?? '').join('')).join('\n')
  assert.match(retryJoined, /AUD-7710/, 'trimmed retry must keep earlier handoff/head context')
  assert.match(retryJoined, /2026-12-15/, 'trimmed retry must keep newest user context')
  assert.match(checkpoints[0].summary[0].text, /AUD-7710/)

  // Also test noteThrough recovering from CONTEXT_WINDOW_EXCEEDED via compacted history on attempt 2.
  const noteCalls = []
  const noteCtx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_000_000 }) } } })
  noteCtx.logger = { warn: () => {}, info: () => {} }
  noteCtx.sessions = { flush: async () => {} }
  noteCtx.workspaceRegistry = { archiveSession: async () => {} }
  noteCtx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 20_000 }, defaultMaxTokens: 4_096 }),
    stream(options) {
      noteCalls.push(options)
      const est = estPiTokens(options.messages) + (options.tools ? 8_000 : 0)
      if (est > 12_000) return makeStream({ error: Object.assign(new Error('prompt too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' }) })()
      const sections = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
      return makeStream({ text: sections.map(s => `## ${s}\n- Preserved AUD-7710`).join('\n\n') })()
    },
  }
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'custom/small', segments: [] }
  const bigSessionMsgs = [
    { role: 'system', content: [{ type: 'text', text: hugeSystem }] },
    { role: 'user', content: [{ type: 'text', text: 'Task AUD-7710' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'a.md' } }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: hugeToolOut }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Finished audit for AUD-7710.' }] },
  ]
  const s1 = { id: 's1', header: { cwd: '/tmp/t' }, requestHeader: () => ({ config: { provider: 'custom', model: 'small' }, tools: [{ name: 'read_file' }] }), deriveMessages: () => bigSessionMsgs, toolHistory: () => [] }
  const followed = []
  const a1 = { id: 's1', session: s1, status: 'idle', whenIdle: async () => {}, runMaintenance: async fn => fn(new AbortController().signal), inbox: { nextStep: [], nextTurn: [] }, followup: m => followed.push(m), send: async () => {} }
  const a2 = { id: 's2', session: { id: 's2', header: { cwd: '/tmp/t' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] }, status: 'idle', whenIdle: async () => {}, runMaintenance: async fn => fn(new AbortController().signal), inbox: { nextStep: [], nextTurn: [] }, followup: m => followed.push(m), send: async () => {} }
  const nrt = {
    ctx: noteCtx, home: '/unused', config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
    botOf: id => nrt.state.bots[id], roomOf: () => undefined, selfOf: () => 'b1', isMain: () => false,
    chatOf: () => 's1', sessionOfRoom: () => undefined, isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
    chatOwners: new Map([['s1', 'b1']]), groupOwners: new Map(), pastOwners: new Map(), roomOwners: new Map(),
    teamTools: [], live: new Map(), groupSessionsOf: () => [], unreadOf: () => [], clock: () => 'now',
    partsOf: () => [], partLines: async function* () {}, eventsBackwards: async function* () {},
    historyEntry: () => undefined, displayItems: async () => [], earlierPage: async () => ({}), chatPage: async () => ({}),
    followFolder: async () => {}, heldBack: () => [],
    resolveAgent: async id => (id === 's2' ? a2 : a1), createSession: async () => 's2',
    desiredModel: async subject => subject.model, desiredEffort: async () => undefined,
    selectSessionModel: async () => {}, applyModel: async () => {}, applyPermission: async () => {},
    ensureCapabilities: async () => {}, renewMemory: () => {}, moveSchedules: async () => {},
    sessionTitle: { rename: async () => {} }, deliver: async () => {}, teamFolder: () => '/tmp/t',
    workDirOf: () => '/tmp/t', isFolder: async () => true, uiLanguage: () => 'en', roomProgress: new Map(),
    defaultModel: async () => undefined,
  }
  installParts(nrt)
  noteCtx.emit('agent/status', { agent: a1, status: 'idle' })
  for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) await new Promise(r => setTimeout(r, 10))
  assert.equal(bot.sessionId, 's2')
  assert.equal(noteCalls.length, 2, 'noteThrough must retry with compacted history after input overflow')
  assert.equal(noteCalls[1].tools, undefined)
  assert.ok(estPiTokens(noteCalls[1].messages) <= 12_000, 'tiny-window retry must shrink system prompt + history to fit output budget')
  assert.match(followed.map(m => m.content?.[0]?.text ?? '').join('\n'), /Preserved AUD-7710/)
})

test('retries strip frozen reasoning blocks, cap huge defaultMaxTokens, avoid duplicate compact retries, and preserve bestTruncated on retry error', async (t) => {
  const estPiTokensWithReasoning = msgs => msgs.reduce((sum, m) => sum + Math.ceil((m.content ?? []).reduce((chars, b) => chars + (b.type === 'text' || b.type === 'reasoning' ? String(b.text ?? '').length : 4_800), 0) / 3.5) + 8, 0)

  // 1) Frozen [reasoning (40k chars), text] assistant messages (with replayState and with missing source)
  //    plus defaultMaxTokens=128_000: retry strips reasoning, guarantees valid model source without replayState,
  //    leaves full output room, and caps shorter-retry maxTokens <= 16_384 & <= window*0.25.
  {
    const home = mkdtempSync(join(tmpdir(), 'dsb-reasoning-cap-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const llmCalls = []
    const checkpoints = []
    const hugeReasoning = 'Internal chain of thought step. '.repeat(1_300) // ~41.6k chars (~11.9k pi-tokens)
    const frozenMsgs = deepFreeze([
      { role: 'system', content: [{ type: 'text', text: 'System prompt. '.repeat(800) }] },
      { role: 'user', content: [{ type: 'text', text: 'Track ticket RSN-5501' }] },
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'custom', model: 'reasoner', replayState: { response: { api: 'openai-completions' }, blocks: [{ type: 'reasoning' }, { type: 'text' }] } },
        content: [{ type: 'reasoning', text: hugeReasoning }, { type: 'text', text: 'Analyzed RSN-5501 step 1.' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue RSN-5501' }] },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: hugeReasoning }, { type: 'text', text: 'Completed RSN-5501 step 2.' }],
      },
    ])
    const compaction = {
      async compactIfNeeded() { return null },
      async compactNow(agent, signal) {
        checkpoints.push(await this.summarize({ messages: frozenMsgs, tools: [{ name: 'read_file' }] }, agent, signal))
        return { ok: true }
      },
      async compactRegion() { return { ok: true } },
      async summarize() { return { summary: [] } },
    }
    const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 35_000 }) } } })
    Object.assign(ctx, {
      llm: {
        listProviders: () => [{ id: 'custom', name: 'Custom' }],
        listModels: async () => [{ id: 'reasoner' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens: 128_000 }),
        stream(options) {
          llmCalls.push(options)
          if (llmCalls.length === 1) return makeStream({ text: '', kind: 'max-tokens' })()
          return makeStream({ text: '- RSN-5501 steps 1 and 2 done.' })()
        },
      },
      sessions: { messageProjections: [] },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
        page: async () => ({ records: [], hasMore: false }),
      },
      workspaceRegistry: { archiveSession: async () => {} },
    })
    createRuntime(ctx, { home })
    t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

    const agent = {
      id: 'b2', status: 'idle',
      session: {
        id: 'b2', seq: 1,
        requestHeader: () => ({ config: { provider: 'custom', model: 'reasoner' } }),
        deriveMessages: () => [],
        toolHistory: () => [],
      },
    }
    const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
    adopt({ agent })
    await compaction[Symbol.for('ds-bot/compaction')].compactNow.call(compaction, agent, new AbortController().signal)

    assert.equal(llmCalls.length, 2)
    assert.equal(llmCalls[1].maxTokens, 10_000, 'shorter retry must cap 128k defaultMaxTokens to min(16384, floor(window*0.25))')
    for (const msg of llmCalls[1].messages) {
      assert.equal((msg.content ?? []).some(b => b.type === 'reasoning'), false, 'retry must strip historical reasoning blocks')
      const joined = (msg.content ?? []).map(b => b.text ?? '').join('')
      assert.doesNotMatch(joined, /\[non-text attachment omitted\]/, 'reasoning blocks must not turn into attachment placeholders')
      if (msg.role === 'assistant') {
        assert.equal(msg.source?.kind, 'model')
        assert.equal(msg.source?.replayState, undefined)
      }
    }
    assert.ok(40_000 - estPiTokensWithReasoning(llmCalls[1].messages) - 4_096 >= 10_000, 'stripped retry must leave full output headroom under pi-ai math')
    assert.match(checkpoints[0].summary[0].text, /RSN-5501/)
  }

  // 2) Attempt 1 returns substantial max-tokens summary (>=200 chars), Attempt 2 (compactInput)
  //    throws isSizeError -> must NOT duplicate identical compactInput request, and MUST return Attempt 1's bestTruncated!
  {
    const home = mkdtempSync(join(tmpdir(), 'dsb-best-trunc-err-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const llmCalls = []
    const checkpoints = []
    const substantial = [
      '- Ticket ERR-9921: audited ledger write path and confirmed optimistic version CAS is required.',
      '- Decisions: chose Option B (versioned CAS with 3 retries); rejected exclusive table lock.',
      '- Remaining: verify batch4.md and batch5.md before sign-off.',
    ].join('\n')
    const compaction = {
      async compactIfNeeded() { return null },
      async compactNow(agent, signal) {
        checkpoints.push(await this.summarize({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'sys' }] },
            { role: 'user', content: [{ type: 'text', text: 'Work '.repeat(400) }] },
          ],
          tools: [{ name: 'read_file' }],
        }, agent, signal))
        return { ok: true }
      },
      async compactRegion() { return { ok: true } },
      async summarize() { return { summary: [] } },
    }
    const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 50_000 }) } } })
    Object.assign(ctx, {
      llm: {
        listProviders: () => [{ id: 'custom', name: 'Custom' }],
        listModels: async () => [{ id: 'm1' }],
        resolveModelInfo: async () => ({}),
        stream(options) {
          llmCalls.push(options)
          if (llmCalls.length === 1) return makeStream({ text: substantial, kind: 'max-tokens' })()
          return makeStream({ error: Object.assign(new Error('413 payload too large'), { status: 413 }) })()
        },
      },
      sessions: { messageProjections: [] },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
        page: async () => ({ records: [], hasMore: false }),
      },
      workspaceRegistry: { archiveSession: async () => {} },
    })
    createRuntime(ctx, { home })
    t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

    const agent = {
      id: 'b2', status: 'idle',
      session: {
        id: 'b2', seq: 1,
        requestHeader: () => ({ config: { provider: 'custom', model: 'm1' } }),
        deriveMessages: () => [],
        toolHistory: () => [],
      },
    }
    const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
    adopt({ agent })
    await compaction[Symbol.for('ds-bot/compaction')].compactNow.call(compaction, agent, new AbortController().signal)

    assert.equal(llmCalls.length, 2, 'must not send a duplicate identical compactInput retry after max-tokens retry already failed with isSizeError')
    assert.match(checkpoints[0].summary[0].text, /ERR-9921/, 'must preserve substantial truncated summary from attempt 1 when retry throws')
  }

  // 3) Model-switch compaction switching to target route (index > 0) must not inherit old route's huge maxTokens.
  {
    const home = mkdtempSync(join(tmpdir(), 'dsb-switch-maxtok-'))
    const team = { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, model: 'small/mini' } } }
    writeFileSync(join(home, 'state.json'), JSON.stringify(team))
    const llmCalls = []
    const compaction = {
      async compactIfNeeded() { return null },
      async compactNow() { return null },
      async compactRegion(_s, _e, agent, signal) {
        await this.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'History '.repeat(200) }] }] }, agent, signal)
      },
      async summarize() { return { summary: [] } },
    }
    const ctx = fakeContext({ services: { compaction, tokenMeter: { ...meter, measure: () => ({ totalTokens: 50_000 }) } } })
    Object.assign(ctx, {
      llm: {
        listProviders: () => [{ id: 'old', name: 'Old' }, { id: 'small', name: 'Small' }],
        listModels: async () => [{ id: 'mini' }],
        resolveModelInfo: async (provider) => (provider === 'small' ? { context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 } : { context: { contextWindow: 200_000 }, defaultMaxTokens: 64_000 }),
        stream(options) {
          llmCalls.push(options)
          if (options.provider === 'old') return makeStream({ error: new Error('quota exhausted') })()
          return makeStream({ text: '- Compacted on small/mini.' })()
        },
      },
      sessions: { messageProjections: [] },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 } } }),
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
        id: 'b2', seq: 1,
        requestHeader: () => ({ config: { provider: 'old', model: 'big', maxTokens: 64_000 } }),
        deriveMessages: () => [],
        toolHistory: () => [],
      },
    }
    const adopt = ctx.listeners.get('agent/created').find(listener => /adoptCompaction/.test(String(listener)))
    adopt({ agent })
    await compaction.compactRegion(1, 2, agent, new AbortController().signal)

    assert.equal(llmCalls.length, 2)
    assert.equal(llmCalls[0].maxTokens, 64_000)
    assert.equal(llmCalls[1].provider, 'small')
    assert.equal(llmCalls[1].maxTokens, undefined, 'target route on model switch must not inherit old route maxTokens')
  }
})
