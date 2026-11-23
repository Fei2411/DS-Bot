import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { HANDOFF_ACK, REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'
import { install as installParts } from '../src/host/parts.js'
import { output } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'

const NOTE_SECTIONS = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
const validNote = marker => NOTE_SECTIONS.map(name => `## ${name}\n- ${marker}`).join('\n\n')

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return predicate()
}

async function bootRealDshBot(t, {
  contextWindow = 50_000,
  defaultMaxTokens = 4_000,
  checkRatio = 0.5,
  withPruner = true,
  prunerConfig,
  onTurn,
  onSteward,
  onCheckpoint,
  onNote,
  toolExecute,
  config = {},
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-ctx-switch-'))
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  if (withPruner) await root.plugin(ToolResultPruner, prunerConfig ?? {})
  await root.plugin(BasicCompactionEngine)

  const calls = []
  const archived = []
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
        const lastText = (req.messages?.at(-1)?.content ?? []).map(b => b.text ?? '').join('\n')
        const isSteward = sys.includes('context steward')
        const isNote = !isSteward && /handoff note/i.test(lastText)
        const kind = isSteward ? 'steward' : isNote ? 'note' : 'checkpoint'
        const record = {
          kind,
          reasoningEffort: req.reasoningEffort,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          tools: req.tools,
          messages: req.messages,
        }
        calls.push(record)
        let reply
        if (isSteward && onSteward) reply = await onSteward(record, calls)
        else if (isNote && onNote) reply = await onNote(record, calls)
        else if (!isSteward && !isNote && onCheckpoint) reply = await onCheckpoint(record, calls)
        else if (isSteward) reply = { text: JSON.stringify({ action: 'compact', reason: 'continue' }) }
        else if (isNote) reply = { text: validNote('real-note') }
        else reply = { text: '- Done: earlier turns summarized cleanly\n- Remaining: continue active task' }

        if (reply?.error) {
          yield { type: 'finish', reason: { kind: 'error', failure: reply.error } }
          return
        }
        const text = reply?.text ?? ''
        yield { type: 'block-start', index: 0, blockType: 'text' }
        if (text !== '') yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        if (reply?.usage) yield { type: 'usage', usage: reply.usage }
        yield { type: 'finish', reason: { kind: reply?.finishKind ?? 'stop' } }
        return
      }
      const step = calls.filter(c => c.kind === 'turn').length + 1
      calls.push({ kind: 'turn', step, sessionId: req.sessionId, messages: req.messages })
      const plan = await onTurn(step, req)
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
    execute: async args => (toolExecute ? toolExecute(args) : `inspected ${args.path}: ok`),
  }))

  root.provide('sessionTitle', { setTitle: async () => {}, rename: async () => {} })
  root.provide('workspaceRegistry', {
    archiveSession: async id => { archived.push(String(id)) },
    unarchiveSession: async () => {},
    resolveByPath: async () => ({ id: 'ws-1', path: home }),
    create: async () => ({ id: 'ws-1', path: home }),
    get: () => ({ id: 'ws-1', path: home }),
    list: () => [{ id: 'ws-1', path: home }],
    listAll: async () => [{ id: 'ws-1', path: home }],
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
        agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens, reasoningEffort: 'high', temperature: 0.3 },
        meta: { cwd: cwd ?? home },
      })
      return { sessionId: id, agent: created.agent }
    },
  })
  await new Promise(resolve => root.inject(['sessionTitle', 'workspaceRegistry', 'connection', 'sessionController'], resolve))

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    workspaceId: 'ws-1',
    mainBotIds: ['m1'],
    revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1, model: 'mock/m' } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const rt = createRuntime(root, { home, checkRatio, scheduleAttachWaitMs: 0, ...config })
  await rt.load()
  const { agent } = await agents.create({
    sessionId: 'm1',
    agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens, reasoningEffort: 'high', temperature: 0.3 },
    meta: { cwd: home },
  })
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const runTurn = async (text, targetAgent = agent) => {
    const done = new Promise((resolve) => {
      const off = root.on('agent/status', ({ agent: a, status }) => {
        if (a.id === targetAgent.id && status === 'idle') { off(); resolve() }
      })
    })
    targetAgent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
  }

  return { root, rt, agent, agents, calls, archived, runTurn, home }
}

// -----------------------------------------------------------------------------
// P0-1A: Async idle switch race must not kill an already-running turn mid-flight
// -----------------------------------------------------------------------------
test('P0-1: slow idle steward deciding switch while a new multi-step turn runs does not kill or drop the turn', async (t) => {
  let stewardCalls = 0
  let releaseSteward
  const stewardStarted = new Promise(resolve => { releaseSteward = resolve })
  let finishSteward
  const stewardGate = new Promise(resolve => { finishSteward = resolve })
  let toolStarted
  const toolEntered = new Promise(resolve => { toolStarted = resolve })
  let releaseTool
  const toolGate = new Promise(resolve => { releaseTool = resolve })

  const big = 'Background specification block. '.repeat(2_600) // ~20k tokens
  const { rt, agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 100_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.25, // usable=96k, check=24k (fresh part opens well below check)
    withPruner: false,
    onSteward: async () => {
      stewardCalls += 1
      if (stewardCalls === 1) {
        releaseSteward()
        await stewardGate
      }
      return { text: JSON.stringify({ action: 'switch', reason: 'topic finished' }) }
    },
    toolExecute: async ({ path }) => {
      toolStarted()
      await toolGate
      return `inspected ${path}: complete`
    },
    onTurn: async (step) => {
      if (step === 1) return { text: `TURN1_DONE\n${big}`, usage: { inputTokens: 6_000, outputTokens: 20_000 } }
      if (step === 2) return { toolCall: { id: 'tc-race-1', name: 'inspect_file', args: { path: 'src/app.js' } }, usage: { inputTokens: 27_000, outputTokens: 200 } }
      return { text: 'TURN2_FINAL_ANSWER', usage: { inputTokens: 27_500, outputTokens: 200 } }
    },
  })

  await runTurn('Finish task 1')
  await stewardStarted

  // Start Turn 2 while Turn 1's idle steward call is still awaiting!
  const turn2Done = runTurn('Run step 2 tool work')
  await toolEntered

  // Steward finishes now with action:'switch' WHILE Turn 2 is executing its tool!
  finishSteward()
  await new Promise(resolve => setTimeout(resolve, 40))

  // Atomic idle guard in startSwitch must have refused to register a switch job mid-turn.
  assert.equal(rt.isSwitchingPart('m1'), false, 'idle switch must bail out while a turn is running')

  releaseTool()
  await turn2Done

  // Verify Turn 2 finished cleanly on m1 with its real answer (not rejected/blocked or dropped).
  const turnEnds = agent.session.snapshotEvents().filter(ev => ev.type === 'turn/end')
  assert.equal(turnEnds.length, 2)
  assert.equal(turnEnds[1].data.reason.kind, 'completed', 'Turn 2 must complete normally without being rejected mid-flight')
  const assistantTexts = agent.session.snapshotEvents()
    .filter(ev => ev.type === 'assistant/message')
    .map(ev => ev.data.message.content.map(b => b.text ?? '').join(''))
  assert.ok(assistantTexts.some(text => text.includes('TURN2_FINAL_ANSWER')), 'Turn 2 final answer must land intact')

  // After Turn 2 returns to idle, the next idle context check switches cleanly to part-1.
  assert.equal(await waitFor(() => rt.chatOf('m1') === 'part-1' && !rt.isSwitchingPart('m1')), true, 'subsequent idle check should switch cleanly after Turn 2 ends')
  assert.ok(calls.some(c => c.kind === 'note'), 'subsequent idle switch writes its handoff note cleanly')
  await new Promise(resolve => setTimeout(resolve, 30))
})

// -----------------------------------------------------------------------------
// P0-1B: takeOverStep marks entry.switched=true & joinSwitch promotes mid-turn jobs
// -----------------------------------------------------------------------------
test('P0-1: takeOverStep sets entry.switched=true on past/job takeovers so phantom turns never settle, and mid-turn joinSwitch promotes resume', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-takeover-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const ctx = fakeContext()
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  const live = new Map()
  const liveOf = id => {
    let entry = live.get(id)
    if (entry === undefined) live.set(id, entry = {})
    return entry
  }
  const forwarded = []
  const agents = new Map()
  const makeAgent = (id) => ({
    id,
    status: 'running',
    session: { id, header: { cwd: home }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [], remove() {}, prepend() {} },
    whenIdle: async () => {},
    runMaintenance: () => new Promise(() => {}), // hold switch job open
    followup: msg => forwarded.push([id, msg]),
    inject: msg => forwarded.push([id, msg]),
  })
  agents.set('s-old', makeAgent('s-old'))
  agents.set('s-cur', makeAgent('s-cur'))
  agents.set('s-sw', makeAgent('s-sw'))

  const rt = {
    ctx,
    home,
    config: {},
    state: {
      bots: {
        b1: { id: 'b1', name: 'Bot1', sessionId: 's-cur', segments: [{ sessionId: 's-old' }] },
        b2: { id: 'b2', name: 'Bot2', sessionId: 's-sw', segments: [] },
      },
      rooms: {},
      prefs: {},
      exchanges: [],
      capabilities: { items: {} },
      switching: {},
      questions: {},
      views: {},
    },
    live,
    liveOf,
    load: async () => {},
    save: async () => {},
    warn: () => {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: id => (id === 's-sw' ? 'b2' : 'b1'),
    chatOf: id => rt.state.bots[id]?.sessionId,
    sessionOfRoom: () => undefined,
    isBotSession: id => id === 's-cur' || id === 's-sw',
    isLocalAgentRef: () => false,
    isLocalAgentRoute: () => false,
    chatOwners: new Map([['s-cur', 'b1'], ['s-sw', 'b2']]),
    groupOwners: new Map(),
    pastOwners: new Map([['s-old', { botId: 'b1' }]]),
    roomOwners: new Map(),
    teamTools: [],
    groupSessionsOf: () => [],
    unreadOf: () => [],
    ensureCapabilities: async () => {},
    resolveAgent: async id => agents.get(id),
    workDirOf: () => home,
    teamFolder: () => home,
    isFolder: async () => true,
    holdImOrigin: id => `im-origin:${id}`,
    dropImOrigin: () => {},
  }
  installParts(rt)
  const preStep = ctx.listeners.get('agent/pre-step').at(-1)

  // 1) Past-owner takeover on step 1 sets entry.switched=true so turns.js ignores phantom turn/end.
  liveOf('s-old').switched = false
  const pastRes = await preStep({
    agent: agents.get('s-old'),
    step: 1,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'late msg' }], source: { kind: 'user' } })],
    signal: AbortSignal.timeout(5_000),
  }, async () => 'next')
  assert.deepEqual(pastRes, { kind: 'enter', messages: [] })
  assert.equal(liveOf('s-old').switched, true, 'past takeover must set entry.switched=true')
  assert.equal(forwarded.length, 1)

  // 2) Active switch job takeover on step 1 sets entry.switched=true, and step 2 promotes job.resume=true + info/joined.
  const b2 = agents.get('s-sw')
  b2.status = 'idle'
  rt.workDirOf = () => join(home, 'new-dir')
  await rt.followFolder({ botId: 'b2' })
  assert.equal(rt.isSwitchingPart('s-sw'), true)

  liveOf('s-sw').switched = false
  const step1Res = await preStep({
    agent: b2,
    step: 1,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'during switch' }], source: { kind: 'user' } })],
    signal: AbortSignal.timeout(5_000),
  }, async () => 'next')
  assert.deepEqual(step1Res, { kind: 'enter', messages: [] })
  assert.equal(liveOf('s-sw').switched, true, 'active switch job step-1 takeover must set entry.switched=true')

  const job = [...rt.switchJobs()].find(item => item.botId === 'b2')
  assert.equal(job.resume, false)

  // Now simulate a step-2 intercept on the same job: must promote resume=true & capture info/joined/resumeOrigin.
  liveOf('s-sw').switched = false
  liveOf('s-sw').info = { kind: SOURCE_KIND, role: 'request', exchangeId: 'ex-1' }
  liveOf('s-sw').joined = [{ info: { kind: SOURCE_KIND, role: 'request', exchangeId: 'ex-2' }, text: 'joined' }]
  const step2Res = await preStep({
    agent: b2,
    step: 2,
    messages: [],
    signal: AbortSignal.timeout(5_000),
  }, async () => 'next')
  assert.deepEqual(step2Res, { kind: 'reject' })
  assert.equal(liveOf('s-sw').switched, true, 'active switch job step-2 takeover must set entry.switched=true')
  assert.equal(job.resume, true, 'step > 1 intercept must promote job.resume to true')
  assert.equal(job.info?.exchangeId, 'ex-1')
  assert.equal(job.joined?.length, 1)
  assert.equal(job.resumeOrigin, 'im-origin:s-sw')
})

// -----------------------------------------------------------------------------
// P1-1: Checkpoint preserves KV prefix cache on attempt 1, steps down on max-tokens,
//       and mid-turn size-error condense avoids wasted full-history writeNote retries
// -----------------------------------------------------------------------------
test('P1-1: checkpoint preserves route config on attempt 1 and steps down effort on max-tokens retry', async (t) => {
  let ckptAttempts = 0
  const big = 'Specification context block. '.repeat(1_500)
  const { calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4,
    withPruner: false,
    onCheckpoint: async () => {
      ckptAttempts += 1
      if (ckptAttempts === 1) return { text: 'cut off mid thought', finishKind: 'max-tokens' }
      return { text: '- Done: summarized cleanly after lowering effort' }
    },
    onTurn: (step) => {
      if (step === 1) return { text: `TURN1\n${big}`, usage: { inputTokens: 2_000, outputTokens: 12_000 } }
      return { text: `TURN2\n${big}`, usage: { inputTokens: 14_000, outputTokens: 12_000 } }
    },
  })

  await runTurn('First request')
  await runTurn('Second request')
  assert.equal(await waitFor(() => calls.filter(c => c.kind === 'checkpoint').length === 2), true)

  const ckpts = calls.filter(c => c.kind === 'checkpoint')
  assert.equal(ckpts[0].reasoningEffort, 'high', 'attempt 1 must keep route reasoningEffort for KV cache hit')
  assert.equal(ckpts[0].maxTokens, 4_000, 'attempt 1 must keep full route maxTokens')
  assert.ok(Array.isArray(ckpts[0].tools) && ckpts[0].tools.length > 0, 'attempt 1 must keep tools for KV cache hit')
  assert.equal(ckpts[1].reasoningEffort, 'off', 'max-tokens retry must step down reasoningEffort to off')
  await new Promise(resolve => setTimeout(resolve, 30))
})

test('P1-1: writeCheckpoint spreads extra route config fields (temperature, stop) on attempt 1 and drops them on lowered-effort retry', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-ckpt-cfg-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const llmCalls = []
  let attempt = 0
  const compaction = {
    compactIfNeeded: async () => null,
    compactNow: async function (agent, signal) {
      return this.summarize({ messages: agent.session.deriveMessages().slice(0, 2), tools: [{ name: 'inspect_file' }] }, agent, signal)
    },
    compactRegion: async () => null,
    summarize: async () => { throw new Error('must be intercepted') },
  }
  ctx = fakeContext({ services: { compaction } })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      stream: (options) => {
        llmCalls.push(options)
        attempt += 1
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: attempt === 1 ? 'cut' : 'Summary ok' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: attempt === 1 ? 'cut' : 'Summary ok' } }
          yield { type: 'finish', reason: { kind: attempt === 1 ? 'max-tokens' : 'stop' } }
        })()
      },
    },
    sessions: { messageProjections: [], flush: async () => {} },
    sessionController: {
      resolveAgent: async id => ({ agent: { id, session: { id, seq: 0 } } }),
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()

  const agent = {
    id: 'm1',
    status: 'idle',
    session: {
      id: 'm1',
      seq: 0,
      requestHeader: () => ({ config: { provider: 'mock', model: 'm', reasoningEffort: 'high', maxTokens: 12_000, temperature: 0.25, stop: ['DONE'] } }),
      deriveMessages: () => [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      ],
      toolHistory: () => [],
    },
  }
  ctx.listeners.get('agent/created').find(fn => /adoptCompaction/.test(String(fn)))({ agent })
  const originalNow = compaction[Symbol.for('ds-bot/compaction')].compactNow
  await originalNow.call(compaction, agent, new AbortController().signal)

  assert.equal(llmCalls.length, 2)
  assert.equal(llmCalls[0].reasoningEffort, 'high')
  assert.equal(llmCalls[0].temperature, 0.25)
  assert.deepEqual(llmCalls[0].stop, ['DONE'])
  assert.equal(llmCalls[0].maxTokens, 12_000)
  assert.equal(llmCalls[1].reasoningEffort, 'off')
  assert.equal(llmCalls[1].maxTokens, 12_000)
})

test('P1-1: mid-turn condense recovers via trimmed transcript on size error, and skips full-history writeNote if still overflowing', async (t) => {
  const big = 'Overflow payload block. '.repeat(2_000)

  // Case A: Full-history checkpoint hits CONTEXT_WINDOW_EXCEEDED -> trimmed retry succeeds in-place.
  let ckptCallsA = 0
  const caseA = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46k, hard=43.7k
    withPruner: false,
    onCheckpoint: async () => {
      ckptCallsA += 1
      if (ckptCallsA === 1) return { error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long' } }
      return { text: '- Done: recovered via trimmed transcript' }
    },
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-a1', name: 'inspect_file', args: { path: 'a.js' } }, usage: { inputTokens: 44_500, outputTokens: 200 } }
      return { text: `DONE_A\n${big.slice(0, 100)}`, usage: { inputTokens: 5_000, outputTokens: 200 } }
    },
  })
  await caseA.runTurn(`Work on A: ${big}`)
  const ckptsA = caseA.calls.filter(c => c.kind === 'checkpoint')
  assert.equal(ckptsA.length, 2, 'mid-turn size error must retry once with trimmed transcript')
  assert.equal(ckptsA[1].tools, undefined, 'trimmed retry must omit tools')
  assert.equal(caseA.rt.chatOf('m1'), 'm1', 'recovered in-place without needing a part switch')

  // Case B: Even trimmed checkpoint hits CONTEXT_WINDOW_EXCEEDED -> switch moves on with overflow:true and 0 full-history writeNote calls.
  const caseB = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4,
    withPruner: false,
    onCheckpoint: async () => ({ error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long' } }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-b1', name: 'inspect_file', args: { path: 'b.js' } }, usage: { inputTokens: 44_500, outputTokens: 200 } }
      return { text: 'DONE_B', usage: { inputTokens: 5_000, outputTokens: 200 } }
    },
  })
  await caseB.runTurn(`Work on B: ${big}`)
  assert.equal(await waitFor(() => caseB.rt.chatOf('m1') === 'part-1' && !caseB.rt.isSwitchingPart('m1')), true, 'must switch parts after size-error condense failure')
  assert.equal(caseB.calls.filter(c => c.kind === 'note').length, 0, 'overflow part switch must skip guaranteed-to-fail full-history writeNote calls')
  await new Promise(resolve => setTimeout(resolve, 30))
})

// -----------------------------------------------------------------------------
// P1-4: Model-free toolResultPruner reclaims oversized tool outputs past lines.check
//       and lines.hard with ZERO LLM compaction/steward calls
// -----------------------------------------------------------------------------
test('P1-4: real DSH ToolResultPruner reclaims oversized tool outputs past check line with zero LLM calls and intact dialogue', async (t) => {
  const hugeToolOutput = 'LOG_LINE_0123456789 '.repeat(5_000) // ~100,000 chars (~25k tokens)
  const { agent, calls, runTurn, rt } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46,000, check=18,400
    withPruner: true,
    toolExecute: async () => hugeToolOutput,
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-huge-1', name: 'inspect_file', args: { path: 'huge.log' } }, usage: { inputTokens: 1_500, outputTokens: 100 } }
      return { text: 'DIALOGUE_INTACT: Analyzed huge.log successfully.', usage: { inputTokens: 27_000, outputTokens: 100 } }
    },
  })

  await runTurn('Check huge.log')
  // Wait for idle checkContext to run toolResultPruner.
  assert.equal(await waitFor(() => agent.session.snapshotEvents().some(ev => ev.type === 'compaction/prune')), true, 'real ToolResultPruner must append compaction/prune event')
  await new Promise(resolve => setTimeout(resolve, 100))

  // Zero steward LLM calls, zero checkpoint LLM calls, zero part switches!
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0, 'pruning below check line must skip steward LLM call')
  assert.equal(calls.filter(c => c.kind === 'checkpoint').length, 0, 'pruning below check line must skip checkpoint LLM call')
  assert.equal(calls.filter(c => c.kind === 'note').length, 0, 'pruning below check line must skip part switch')
  assert.equal(rt.chatOf('m1'), 'm1')

  // Verify surface still has full user/assistant dialogue AND pruned tool output marker.
  const derived = agent.session.deriveMessages()
  const allText = derived.map(m => (m.content ?? []).map(b => b.text ?? '').join('\n')).join('\n')
  assert.match(allText, /\[\.\.\. tool result middle pruned \.\.\.\]/)
  assert.match(allText, /DIALOGUE_INTACT: Analyzed huge\.log successfully\./)
  assert.match(allText, /Check huge\.log/)
})

test('P1-4: real DSH ToolResultPruner reclaims oversized tool outputs mid-turn past hard line without triggering LLM compaction', async (t) => {
  const hugeToolOutput = 'BUILD_OUTPUT_LINE_9876543210 '.repeat(6_000) // ~174k chars (~43.5k tokens)
  const { agent, calls, runTurn, rt } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46,000, hard=43,700
    withPruner: true,
    toolExecute: async () => hugeToolOutput,
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-mid-1', name: 'inspect_file', args: { path: 'build.log' } }, usage: { inputTokens: 1_500, outputTokens: 100 } }
      return { text: 'MID_TURN_COMPLETED_CLEANLY', usage: { inputTokens: 4_000, outputTokens: 100 } }
    },
  })

  await runTurn('Inspect build.log')
  assert.equal(agent.session.snapshotEvents().some(ev => ev.type === 'compaction/prune'), true, 'mid-turn pre-step must prune oversized tool output')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0, 'mid-turn pruning below hard line must skip steward LLM call')
  assert.equal(calls.filter(c => c.kind === 'checkpoint').length, 0, 'mid-turn pruning below hard line must skip compaction LLM call')
  assert.equal(rt.chatOf('m1'), 'm1')
  const turn2Msg = calls.filter(c => c.kind === 'turn')[1]?.messages ?? []
  const toolText = turn2Msg.filter(m => m.role === 'tool').map(m => (m.content ?? []).map(b => b.text ?? '').join('')).join('\n')
  assert.match(toolText, /\[\.\.\. tool result middle pruned \.\.\.\]/)
})

test('P1-4: mid-turn condense prunes oversized tool result in retained tail before running a second overflow compaction', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tail-prune-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    workspaceId: 'ws-1',
    mainBotIds: ['m1'],
    revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const events = [
    { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'u1' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a1' }] } } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'u2' }], source: { kind: 'user' } } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a2' }] } } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'tc-1', name: 'inspect_file', arguments: '{}' }] } } },
    { seq: 6, type: 'tool/result', data: { message: { toolCallId: 'tc-1', content: [{ type: 'text', text: 'huge' }] } } },
  ]
  let tokens = 48_000 // > hard line (43,700)
  let pruneCalls = 0
  let regionCalls = 0
  let overflowCalls = 0
  const compaction = {
    compactIfNeeded: async () => { overflowCalls += 1; return { ok: true } },
    compactNow: async () => null,
    compactRegion: async () => {
      regionCalls += 1
      tokens = 45_000 // still >= hard target (43,700) because of giant tool result in retained tail
      return { ok: true }
    },
    summarize: async () => ({ summary: [] }),
  }
  const toolResultPruner = {
    pruneSession: () => {
      pruneCalls += 1
      if (pruneCalls === 1) return { pruned: [], charsRemoved: 0 } // nothing prunable before compactRegion
      tokens = 12_000 // pruner shrinks retained tail below check line!
      return { pruned: [{ originalSeq: 6 }], charsRemoved: 60_000 }
    },
  }
  const tokenMeter = {
    measure: () => ({
      totalTokens: tokens,
      nodes: [
        { seq: 0, tokens: 1_000 },
        { seq: 1, tokens: 12_000 },
        { seq: 2, tokens: 12_000 },
        { seq: 3, tokens: 9_000 },
        { seq: 4, tokens: 9_000 },
        { seq: 5, tokens: 1_000 },
        { seq: 6, tokens: 4_000 },
      ],
    }),
  }
  ctx = fakeContext({ services: { compaction, toolResultPruner, tokenMeter } })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ context: { contextWindow: 50_000 }, defaultMaxTokens: 4_000 }),
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ action: 'compact', reason: 'stay' }) }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ action: 'compact', reason: 'stay' }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
    sessions: { messageProjections: [], flush: async () => {} },
    sessionController: {
      resolveAgent: async id => ({ agent: { id, session: { id, seq: events.length } } }),
      page: async () => ({ records: events.map(event => ({ event })), hasMore: false }),
    },
    workspaceRegistry: {
      get: () => ({ id: 'ws-1', path: home }),
      list: () => [{ id: 'ws-1', path: home }],
      resolveByPath: async () => ({ id: 'ws-1', path: home }),
      archiveSession: async () => {},
    },
  })
  const rt = createRuntime(ctx, { home, checkRatio: 0.4 })
  await rt.load()

  const agent = {
    id: 'm1',
    status: 'running',
    inbox: { nextStep: [], nextTurn: [] },
    session: {
      id: 'm1',
      seq: events.length,
      header: { cwd: home },
      surface: { nodes: events.map(e => e.seq) },
      eventAt: seq => events[seq],
      requestHeader: () => ({ config: { provider: 'mock', model: 'm' } }),
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'u1' }] }],
      toolHistory: () => [],
    },
  }
  const preStep = ctx.listeners.get('agent/pre-step').find(fn => /adoptCompaction/.test(String(fn)))
  const decision = await preStep({ agent, step: 2, messages: [], signal: AbortSignal.timeout(5_000) }, async () => ({ kind: 'enter', messages: [] }))

  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(regionCalls, 1, 'retained-tail compactRegion runs once')
  assert.equal(pruneCalls, 2, 'pruner runs again when retained tail remains above check line')
  assert.equal(overflowCalls, 0, 'pruning retained tail below check line must avoid a second LLM overflow compaction')
})

// -----------------------------------------------------------------------------
// G-05: Group's own Session preserves room.workDir across system-prompt/assemble
// -----------------------------------------------------------------------------
test('G-05: group own Session preserves configured room.workDir and only falls back to teamFolder when deleted', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsb-g05-')))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const team = join(root, 'team')
  const project = join(root, 'group-project')
  mkdirSync(team, { recursive: true })
  mkdirSync(project, { recursive: true })

  const sets = []
  const notices = []
  const workingDirectory = {
    get: session => session.header.cwd,
    set: async (agent, dir) => {
      sets.push([agent.id, dir])
      agent.session.header.cwd = dir
    },
  }
  const ctx = fakeContext({ services: { workingDirectory } })
  const room = { id: 'r1', name: 'Ops', members: ['a'], workDir: project }
  const roomAgent = { id: 'r1', session: { id: 'r1', header: { cwd: project } } }
  const rt = {
    ctx,
    home: root,
    config: {},
    state: { bots: {}, rooms: { r1: room }, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    live: new Map(),
    liveOf: () => ({}),
    load: async () => {},
    save: async () => {},
    warn: () => {},
    readOnly: () => undefined,
    botOf: () => undefined,
    roomOf: id => (id === 'r1' ? room : undefined),
    selfOf: () => undefined,
    chatOf: () => undefined,
    sessionOfRoom: () => 'r1',
    isBotSession: () => false,
    chatOwners: new Map(),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map([['r1', 'r1']]),
    teamTools: [],
    workDirOf: place => (place?.roomId === 'r1' ? room.workDir : undefined),
    teamFolder: () => team,
    keepTeamFolder: async () => { mkdirSync(team, { recursive: true }); return team },
    isFolder: async dir => {
      try {
        const { statSync } = await import('node:fs')
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    },
    roomFolderNotice: async (roomId, wanted) => { notices.push([roomId, wanted]) },
  }
  installParts(rt)
  const assemble = ctx.listeners.get('system-prompt/assemble').at(-1)

  // 1) Configured room.workDir exists: must NOT be overwritten with teamFolder!
  let nextCalled = false
  await assemble({ contexts: [] }, { agent: roomAgent, signal: AbortSignal.timeout(5_000) }, async () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.deepEqual(sets, [], 'room.workDir must be preserved, not forced back to teamFolder')
  assert.equal(roomAgent.session.header.cwd, project)
  assert.deepEqual(notices, [])

  // 2) Configured room.workDir deleted on disk: emits notice and falls back to teamFolder.
  rmSync(project, { recursive: true, force: true })
  await assemble({ contexts: [] }, { agent: roomAgent, signal: AbortSignal.timeout(5_000) }, async () => {})
  assert.deepEqual(notices, [['r1', project]])
  assert.deepEqual(sets, [['r1', team]])
  assert.equal(roomAgent.session.header.cwd, team)
})

// -----------------------------------------------------------------------------
// F7: Unified isWakingSource in HANDOFF_ACK & forward(), plus schedulesPending()
// -----------------------------------------------------------------------------
test('F7: bare HANDOFF_ACK never swallows REPLY_KIND, schedule, tool-jobs, subagent-settled, or agent-message, handles null source, and forward() wakes them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-f7-sources-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const ctx = fakeContext()
  ctx.sessions = { flush: async () => {} }
  const calls = []
  const currentAgent = {
    id: 's-cur',
    session: { id: 's-cur' },
    inbox: { nextStep: [], nextTurn: [] },
    followup: msg => calls.push(['followup', msg.source?.kind ?? null]),
    inject: msg => calls.push(['inject', msg.source?.kind ?? null]),
  }
  const rt = {
    ctx,
    home,
    config: {},
    state: { bots: { b1: { id: 'b1', name: 'Bot1', sessionId: 's-cur', segments: [{ sessionId: 's-old' }] } }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    live: new Map(),
    liveOf: () => ({}),
    load: async () => {},
    save: async () => {},
    warn: () => {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    chatOf: () => 's-cur',
    sessionOfRoom: () => undefined,
    isBotSession: id => id === 's-cur',
    ownRequest: () => false,
    chatOwners: new Map([['s-cur', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map([['s-old', { botId: 'b1' }]]),
    roomOwners: new Map(),
    teamTools: [],
    ensureCapabilities: async () => {},
    resolveAgent: async () => currentAgent,
  }
  installParts(rt)

  // 1) Check llm/stream bare HANDOFF_ACK interceptor across all waking & non-waking source kinds.
  const llmStream = ctx.listeners.get('llm/stream').at(-1)
  const handoffMsg = { role: 'user', content: [{ type: 'text', text: '[Handoff · part 2]' }], source: { kind: SOURCE_KIND, handoff: true, resume: false } }

  for (const kind of [REPLY_KIND, 'schedule', 'tool-jobs', 'subagent-settled', 'agent-message']) {
    let realCalled = false
    await llmStream({
      sessionId: 's-cur',
      messages: [handoffMsg, { role: 'user', content: [{ type: 'text', text: 'payload' }], source: { kind } }],
    }, () => { realCalled = true; return 'real-stream' })
    assert.equal(realCalled, true, `bare HANDOFF_ACK must NOT swallow source.kind=${kind}`)
  }

  // Non-waking sources (time-context, silent note, null) paired with a bare handoff still get HANDOFF_ACK without throwing.
  for (const extraSource of [{ kind: 'time-context' }, { kind: SOURCE_KIND, role: 'note', silent: true }, null]) {
    let realCalled = false
    const stream = llmStream({
      sessionId: 's-cur',
      messages: [handoffMsg, { role: 'user', content: [{ type: 'text', text: 'ctx' }], source: extraSource }],
    }, () => { realCalled = true; return 'real-stream' })
    assert.equal(realCalled, false, `bare handoff with ${extraSource?.kind ?? 'null'} must still short-circuit`)
    let ack = ''
    for await (const chunk of stream) if (chunk.type === 'text-delta') ack += chunk.text
    assert.equal(ack, HANDOFF_ACK)
  }

  // 2) Check forward() from pastOwners wakes current part via followup() for all waking kinds.
  const preStep = ctx.listeners.get('agent/pre-step').at(-1)
  await preStep({
    agent: { id: 's-old', session: { id: 's-old' } },
    step: 1,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'due' }], source: { kind: 'schedule' } }),
      createUserMessage({ content: [{ type: 'text', text: 'ans' }], source: { kind: REPLY_KIND } }),
      createUserMessage({ content: [{ type: 'text', text: 'job' }], source: { kind: 'tool-jobs' } }),
      createUserMessage({ content: [{ type: 'text', text: 'sub' }], source: { kind: 'subagent-settled' } }),
      createUserMessage({ content: [{ type: 'text', text: 'relay' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' } }),
      createUserMessage({ content: [{ type: 'text', text: 'clk' }], source: { kind: 'time-context' } }),
      { role: 'user', content: [{ type: 'text', text: 'null-src' }], source: null },
    ],
    signal: AbortSignal.timeout(5_000),
  }, async () => 'next')

  assert.deepEqual(calls, [
    ['followup', 'schedule'],
    ['followup', REPLY_KIND],
    ['followup', 'tool-jobs'],
    ['followup', 'subagent-settled'],
    ['followup', 'agent-message'],
    ['inject', 'time-context'],
    ['inject', null],
  ])
})

test('F7: part switch keeps state.switching and defers archiving while schedulesPending() until schedule attaches, then moves and archives', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-f7-sched-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const teamDir = join(home, 'workspace')
  const nextDir = join(home, 'next-folder')
  mkdirSync(teamDir, { recursive: true })
  mkdirSync(nextDir, { recursive: true })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1', createdAt: 1, workDir: nextDir } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  let attachSchedule
  const archived = []
  const moved = []
  const agents = new Map()
  const makeAgent = (id, cwd) => ({
    id,
    status: 'idle',
    session: { id, seq: 0, header: { cwd }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [], remove() {}, prepend() {} },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(AbortSignal.timeout(5_000)),
    followup: () => {},
    inject: () => {},
    send: () => {},
  })
  agents.set('s1', makeAgent('s1', teamDir))

  ctx = fakeContext()
  ctx.inject = (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('schedule')) attachSchedule = cb
  }
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  ctx.workspaceRegistry = {
    get: () => ({ id: 'w1', path: teamDir }),
    list: () => [{ id: 'w1', path: teamDir }],
    resolveByPath: async () => ({ id: 'w1', path: teamDir }),
    create: async path => ({ id: 'w2', path }),
    archiveSession: async id => { archived.push(id) },
  }
  ctx.sessionController = {
    create: async ({ cwd }) => {
      agents.set('s2', makeAgent('s2', cwd ?? nextDir))
      return { sessionId: 's2' }
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  }

  const rt = createRuntime(ctx, { home, scheduleAttachWaitMs: 30_000 })
  await rt.load()
  assert.equal(rt.schedulesPending(), true)

  // Trigger a folder part switch BEFORE schedule attaches.
  await rt.followFolder({ botId: 'b1' })
  assert.equal(await waitFor(() => rt.chatOf('b1') === 's2'), true)
  await new Promise(resolve => setTimeout(resolve, 50))

  // Old part MUST NOT be archived yet and MUST remain marked in state.switching.
  assert.deepEqual(archived, [], 'old part must not be archived while schedule service is pending')
  assert.ok(rt.state.switching.s1 !== undefined, 'state.switching must keep old part until schedules move')

  // Now DSH injects the schedule service: attach() must trigger heldBack(), move tasks, archive s1, and clear switching.
  attachSchedule({
    schedule: {
      catalog: async () => [{ id: 'task-1', status: 'active', target: { kind: 'session', sessionId: 's1' } }],
      edit: async req => { moved.push([req.id, req.patch?.target?.sessionId]); return { id: req.id } },
      list: async () => [],
    },
    effect: () => {},
  })

  assert.equal(await waitFor(() => archived.includes('s1') && rt.state.switching.s1 === undefined), true, 'attaching schedule must move tasks and archive deferred part')
  assert.deepEqual(moved, [['task-1', 's2']])
})

test('F7: when schedule service never attaches (automation disabled), grace timer retires deferred part cleanly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-f7-grace-'))
  let ctx
  t.after(async () => {
    t.mock.timers.reset()
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const teamDir = join(home, 'workspace')
  const nextDir = join(home, 'next-folder')
  mkdirSync(teamDir, { recursive: true })
  mkdirSync(nextDir, { recursive: true })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1', createdAt: 1, workDir: nextDir } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const archived = []
  const agents = new Map()
  const makeAgent = (id, cwd) => ({
    id,
    status: 'idle',
    session: { id, seq: 0, header: { cwd }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [], remove() {}, prepend() {} },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(AbortSignal.timeout(5_000)),
    followup: () => {},
    inject: () => {},
    send: () => {},
  })
  agents.set('s1', makeAgent('s1', teamDir))

  ctx = fakeContext()
  ctx.inject = () => {} // automation disabled: schedule never attaches
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  ctx.workspaceRegistry = {
    get: () => ({ id: 'w1', path: teamDir }),
    list: () => [{ id: 'w1', path: teamDir }],
    resolveByPath: async () => ({ id: 'w1', path: teamDir }),
    create: async path => ({ id: 'w2', path }),
    archiveSession: async id => { archived.push(id) },
  }
  ctx.sessionController = {
    create: async ({ cwd }) => {
      agents.set('s2', makeAgent('s2', cwd ?? nextDir))
      return { sessionId: 's2' }
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  }

  // Drive the grace window with fake Date + setTimeout so slow I/O on loaded CI runners
  // can never race past the attach window before the switch finishes.
  const realSetTimeout = globalThis.setTimeout
  const waitReal = async (predicate, timeoutMs = 5_000) => {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (predicate()) return true
      await new Promise(resolve => realSetTimeout(resolve, 15))
    }
    return predicate()
  }
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })

  const rt = createRuntime(ctx, { home, scheduleAttachWaitMs: 10_000 })
  await rt.load()
  assert.equal(rt.schedulesPending(), true, 'grace window must still be open after load')
  await rt.followFolder({ botId: 'b1' })
  assert.equal(await waitReal(() => rt.chatOf('b1') === 's2' && !rt.isSwitchingPart('b1')), true)
  assert.equal(rt.schedulesPending(), true, 'switch must finish inside grace window')
  assert.deepEqual(archived, [], 'must wait during grace window')
  assert.ok(rt.state.switching.s1 !== undefined, 'state.switching must retain deferred part during grace window')

  // Halfway through the grace window, the deferred part must still remain unarchived.
  t.mock.timers.tick(5_000)
  await new Promise(resolve => realSetTimeout(resolve, 25))
  assert.equal(rt.schedulesPending(), true)
  assert.deepEqual(archived, [])
  assert.ok(rt.state.switching.s1 !== undefined)

  // Once the 10s grace window expires, schedulesPending() flips false and the grace timer finishes retirement.
  t.mock.timers.tick(5_000)
  assert.equal(rt.schedulesPending(), false)
  assert.equal(await waitReal(() => archived.includes('s1') && rt.state.switching.s1 === undefined, 5_000), true, 'grace timer must archive deferred part once attach window expires')
})

// -----------------------------------------------------------------------------
// Review regression coverage: concurrency, joinSwitch failure, real-DSH overflow & busy
// -----------------------------------------------------------------------------
test('handOnHeld skips active switches (no duplicate forwards or premature archive) and finishes retirement after schedule attaches mid-switch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-held-race-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const teamDir = join(home, 'workspace')
  const nextDir = join(home, 'next-folder')
  mkdirSync(teamDir, { recursive: true })
  mkdirSync(nextDir, { recursive: true })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1', createdAt: 1, workDir: nextDir } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  let attachSchedule
  let releaseCreate
  const createPaused = new Promise(resolve => { releaseCreate = resolve })
  let createReached
  const atCreate = new Promise(resolve => { createReached = resolve })

  const archived = []
  const moved = []
  const wakes = []
  const forwarded = []
  const agents = new Map()
  const heldMsg = createUserMessage({ id: 'm-held', content: [{ type: 'text', text: 'held user message' }], source: { kind: 'user' } })
  const makeAgent = (id, cwd, initialHeld = []) => ({
    id,
    status: 'idle',
    session: { id, seq: 0, header: { cwd }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
    inbox: {
      nextStep: [],
      nextTurn: [...initialHeld],
      remove(msgId) { this.nextTurn = this.nextTurn.filter(m => m.id !== msgId) },
      prepend(target, msg) { (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(msg) },
    },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(AbortSignal.timeout(5_000)),
    followup: msg => forwarded.push([id, msg.content?.[0]?.text]),
    inject: () => {},
    send: msg => wakes.push([id, msg.content?.[0]?.text]),
  })
  agents.set('s1', makeAgent('s1', teamDir, [heldMsg]))

  ctx = fakeContext()
  ctx.inject = (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('schedule')) attachSchedule = cb
  }
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  ctx.workspaceRegistry = {
    get: () => ({ id: 'w1', path: teamDir }),
    list: () => [{ id: 'w1', path: teamDir }],
    resolveByPath: async () => ({ id: 'w1', path: teamDir }),
    create: async path => ({ id: 'w2', path }),
    archiveSession: async id => { archived.push(id) },
  }
  ctx.sessionController = {
    create: async ({ cwd }) => {
      createReached()
      await createPaused
      agents.set('s2', makeAgent('s2', cwd ?? nextDir))
      return { sessionId: 's2' }
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  }

  const rt = createRuntime(ctx, { home, scheduleAttachWaitMs: 30_000 })
  await rt.load()

  // Start folder switch: runSwitch marks state.switching.s1 and pauses inside create().
  const switchPromise = rt.followFolder({ botId: 'b1' })
  await atCreate
  assert.ok(rt.state.switching.s1 !== undefined, 'active switch must mark state.switching.s1')

  // Fire heldBack() directly while switch is still active: must skip s1 completely.
  await rt.heldBack()
  assert.deepEqual(wakes, [], 'handOnHeld must not wake a session with an active switch')
  assert.deepEqual(archived, [], 'handOnHeld must not archive an actively switching session')
  assert.ok(rt.state.switching.s1 !== undefined, 'handOnHeld must preserve state.switching for active switch')

  // Now attach schedule while switch is still paused inside create().
  attachSchedule({
    schedule: {
      catalog: async () => [{ id: 'task-race', status: 'active', target: { kind: 'session', sessionId: 's1' } }],
      edit: async req => { moved.push([req.id, req.patch?.target?.sessionId]); return { id: req.id } },
      list: async () => [],
    },
    effect: () => {},
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(wakes, [], 'attach()->heldBack() must not wake s1 mid-switch')
  assert.deepEqual(archived, [], 'attach()->heldBack() must not archive s1 mid-switch')

  // Release create(): the active switch finishes cleanly, forwards heldMsg ONCE, moves schedule, archives s1.
  releaseCreate()
  await switchPromise
  assert.equal(await waitFor(() => archived.includes('s1') && rt.state.switching.s1 === undefined), true)
  const userForwards = forwarded.filter(([sid, text]) => sid === 's2' && text === 'held user message')
  assert.equal(userForwards.length, 1, 'held user message must be forwarded exactly once without duplication')
  assert.deepEqual(moved, [['task-race', 's2']])
})

test('joinSwitch-promoted mid-turn job restores PAUSE_NOTE and routing metadata when the switch fails', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-join-fail-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const teamDir = join(home, 'workspace')
  const nextDir = join(home, 'next-folder')
  mkdirSync(teamDir, { recursive: true })
  mkdirSync(nextDir, { recursive: true })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1', createdAt: 1, workDir: nextDir } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  let failCreate
  const createPaused = new Promise((_, reject) => { failCreate = reject })
  let atCreateResolve
  const atCreate = new Promise(resolve => { atCreateResolve = resolve })
  const forwarded = []
  const s1 = {
    id: 's1',
    status: 'idle',
    session: { id: 's1', seq: 0, header: { cwd: teamDir }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [], remove() {}, prepend() {} },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(AbortSignal.timeout(5_000)),
    followup: msg => forwarded.push(msg),
    inject: msg => forwarded.push(msg),
    send: () => {},
  }

  ctx = fakeContext()
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  ctx.workspaceRegistry = {
    get: () => ({ id: 'w1', path: teamDir }),
    list: () => [{ id: 'w1', path: teamDir }],
    resolveByPath: async () => ({ id: 'w1', path: teamDir }),
    create: async path => ({ id: 'w2', path }),
    archiveSession: async () => {},
  }
  ctx.sessionController = {
    create: async () => {
      atCreateResolve()
      return createPaused
    },
    resolveAgent: async () => ({ agent: s1 }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  }

  const rt = createRuntime(ctx, { home })
  await rt.load()

  // Trigger a folder switch (starts with resume: false) and wait until it enters create().
  const switchPromise = rt.followFolder({ botId: 'b1' })
  await atCreate

  // Simulate an in-flight mid-turn step 2 joining the active switch job -> promotes job.resume = true.
  const entry = rt.liveOf('s1')
  entry.info = { kind: SOURCE_KIND, form: 'relay', role: 'ask', exchangeId: 'ex-join-fail', senderName: 'Peer' }
  entry.joined = ['ex-joined-1']
  const preStep = ctx.listeners.get('agent/pre-step').find(fn => /joinSwitch/.test(String(fn)))
  assert.ok(preStep, 'parts agent/pre-step listener must exist')
  const decision = await preStep({
    agent: s1,
    step: 2,
    messages: [],
    signal: AbortSignal.timeout(5_000),
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'reject')

  // Fail create() so !job.moved: .finally() must check job.resume (not stale closure resume) and restore PAUSE_NOTE.
  failCreate(new Error('disk full'))
  await switchPromise
  assert.equal(await waitFor(() => forwarded.length > 0), true, 'failed promoted switch must forward PAUSE_NOTE back to session')
  const pause = forwarded.find(m => (m.content?.[0]?.text ?? '').includes('DS Bot paused your turn for a context check'))
  assert.ok(pause, 'PAUSE_NOTE must be forwarded for joinSwitch-promoted job')
  assert.equal(pause.source?.exchangeId, 'ex-join-fail')
  assert.deepEqual(pause.source?.joined, ['ex-joined-1'])
})

test('startSwitch .finally kicks heldBack when schedule attaches right after schedule/pending before switches.delete', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-sched-window-'))
  let ctx
  t.after(async () => {
    await ctx?.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const teamDir = join(home, 'workspace')
  const nextDir = join(home, 'next-folder')
  mkdirSync(teamDir, { recursive: true })
  mkdirSync(nextDir, { recursive: true })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1', createdAt: 1, workDir: nextDir } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  let attachSchedule
  const archived = []
  const moved = []
  const agents = new Map()
  const makeAgent = (id, cwd) => ({
    id,
    status: 'idle',
    session: { id, seq: 0, header: { cwd }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [], remove() {}, prepend() {} },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(AbortSignal.timeout(5_000)),
    followup: () => {},
    inject: () => {},
    send: () => {},
  })
  agents.set('s1', makeAgent('s1', teamDir))

  ctx = fakeContext()
  ctx.inject = (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('schedule')) attachSchedule = cb
  }
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  ctx.workspaceRegistry = {
    get: () => ({ id: 'w1', path: teamDir }),
    list: () => [{ id: 'w1', path: teamDir }],
    resolveByPath: async () => ({ id: 'w1', path: teamDir }),
    create: async path => ({ id: 'w2', path }),
    archiveSession: async id => { archived.push(id) },
  }
  ctx.sessionController = {
    create: async ({ cwd }) => {
      agents.set('s2', makeAgent('s2', cwd ?? nextDir))
      return { sessionId: 's2' }
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  }

  const rt = createRuntime(ctx, { home, scheduleAttachWaitMs: 30_000 })
  await rt.load()

  // Intercept moveSchedules so that on the very first schedule/pending throw (while s1 is STILL
  // inside `switches`), attachSchedule fires immediately — simulating the exact race window where
  // attach()->heldBack() skips s1 and only startSwitch's .finally() follow-up kick can retire it.
  const realMoveSchedules = rt.moveSchedules
  let firedMidThrow = false
  rt.moveSchedules = async (...args) => {
    try {
      return await realMoveSchedules(...args)
    } catch (error) {
      if (error?.code === 'schedule/pending' && !firedMidThrow) {
        firedMidThrow = true
        attachSchedule({
          schedule: {
            catalog: async () => [{ id: 'task-win', status: 'active', target: { kind: 'session', sessionId: 's1' } }],
            edit: async req => { moved.push([req.id, req.patch?.target?.sessionId]); return { id: req.id } },
            list: async () => [],
          },
          effect: () => {},
        })
      }
      throw error
    }
  }

  await rt.followFolder({ botId: 'b1' })
  assert.equal(await waitFor(() => firedMidThrow, 3_000), true, 'moveSchedules must throw schedule/pending and trigger mid-switch attach')
  assert.equal(await waitFor(() => archived.includes('s1') && rt.state.switching.s1 === undefined, 3_000), true, 'startSwitch .finally() must kick heldBack() so s1 is not stranded')
  assert.deepEqual(moved, [['task-win', 's2']])
})

test('real DSH runtime: idle compactNow overflow wraps cause in ManualCompactionError, isSizeError unwraps it and switches with 0 writeNote calls', async (t) => {
  const { rt, agent, calls, archived, runTurn } = await bootRealDshBot(t, {
    contextWindow: 30_000,
    defaultMaxTokens: 2_000,
    checkRatio: 0.5,
    withPruner: false,
    onTurn: async (step) => {
      if (step === 1) return { text: 'Initial answer.', usage: { inputTokens: 16_000, outputTokens: 200 } }
      return { text: 'Continued on fresh part.', usage: { inputTokens: 1_500, outputTokens: 100 } }
    },
    onSteward: async () => ({ text: JSON.stringify({ action: 'compact', reason: 'condense' }) }),
    onCheckpoint: async () => ({ error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long for the model' } }),
  })

  const part1 = rt.chatOf('m1')
  await runTurn('Analyze this large spec.', agent)

  // Wait for checkContext -> steward(compact) -> real BasicCompactionEngine.compactNow() -> ManualCompactionError(cause: CONTEXT_WINDOW_EXCEEDED) -> overflow switch.
  assert.equal(await waitFor(() => rt.chatOf('m1') !== part1 && archived.includes(part1), 10_000), true, 'idle compactNow overflow must trigger part switch and archive part 1')
  const part2 = rt.chatOf('m1')
  const agent2 = rt.ctx.get('agents').get(part2)
  if (agent2) await agent2.whenIdle()
  const segment = rt.botOf('m1').segments.find(seg => seg.sessionId === part1)
  assert.ok(segment, 'part 1 must be archived in segments')
  assert.equal(segment.fallback, 'overflow', 'isSizeError must unwrap ManualCompactionError.cause and mark fallback as overflow')
  assert.equal(calls.filter(c => c.kind === 'note').length, 0, 'overflow switch must NOT invoke redundant writeNote LLM call')
})

test('real DSH runtime: pruneToolResults returns busy quietly without steward call when ReactLoopAgent is in maintenance', async (t) => {
  const warnings = []
  let holdMaintenance
  const maintenanceHeld = new Promise(resolve => { holdMaintenance = resolve })
  let releaseMaintenance
  const maintenanceGate = new Promise(resolve => { releaseMaintenance = resolve })

  const { rt, agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 20_000,
    defaultMaxTokens: 2_000,
    checkRatio: 0.5,
    withPruner: true,
    prunerConfig: { thresholdChars: 100, headChars: 20, tailChars: 20 },
    toolExecute: async () => 'DATA '.repeat(600),
    onTurn: async (step) => {
      if (step === 1) return { toolCall: { id: 'tc-maint', name: 'inspect_file', args: { path: 'big.log' } }, usage: { inputTokens: 4_000, outputTokens: 50 } }
      return { text: 'Inspected.', usage: { inputTokens: 12_000, outputTokens: 100 } }
    },
  })

  const origWarn = rt.warn
  rt.warn = (...args) => { warnings.push(args.map(String).join(' ')); return origWarn?.(...args) }

  const part1 = rt.chatOf('m1')

  // Acquire real DSH maintenance lock in a prepend `agent/status` listener right when the turn
  // becomes idle, BEFORE parts.js's `agent/status` listener invokes checkContext(agent).
  // Real ReactLoopAgent.runMaintenance() synchronously enters phase.kind === 'maintenance'
  // (leaving agent.status === 'idle') and rejects concurrent runMaintenance with a plain Error.
  let lockStarted = false
  let maintenancePromise
  rt.ctx.on('agent/status', ({ agent: a, status }, next) => {
    if (!lockStarted && a.id === part1 && status === 'idle' && calls.filter(c => c.kind === 'turn').length >= 2) {
      lockStarted = true
      maintenancePromise = a.runMaintenance(async () => {
        holdMaintenance()
        await maintenanceGate
      })
    }
    return next()
  }, { prepend: true })

  await runTurn('Inspect big.log', agent)
  await maintenanceHeld
  // Give checkContext time to hit runMaintenance while phase.kind === 'maintenance' (agent.status === 'idle').
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(agent.status, 'idle', 'real DSH agent.status stays idle during maintenance')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0, 'checkContext must bail out on maintenance contention without calling steward')
  assert.equal(warnings.some(w => w.includes('pruning tool results')), false, 'synchronous runMaintenance busy rejection must not emit spurious warning')

  releaseMaintenance()
  await maintenancePromise
  await agent.whenIdle()
})
