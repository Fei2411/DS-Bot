import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
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
  checkRatio = 0.4,
  withPruner = true,
  prunerConfig,
  onTurn,
  onSteward,
  onCheckpoint,
  onNote,
  toolExecute,
  config = {},
} = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsb-pr1-ctx-')))
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
      if (plan.error) {
        yield { type: 'finish', reason: { kind: 'error', failure: plan.error } }
        return
      }
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
        agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens, reasoningEffort: 'high' },
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
    agentOptions: { provider: 'mock', model: 'm', maxTokens: defaultMaxTokens, reasoningEffort: 'high' },
    meta: { cwd: home },
  })
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
// B1: Cache-safe pruning order — skip pruning before steward when it cannot drop
//     below check line so writeNote runs on the unmutated KV prefix cache.
// -----------------------------------------------------------------------------
test('B1: idle checkContext skips pruning when savings cannot drop below check line, preserving unmutated prefix for writeNote', async (t) => {
  const mediumToolOut = 'PREFIX_KEEP_MARKER '.repeat(600) // ~11,400 chars (>8192 threshold, saves ~1.5k tokens)
  const { rt, agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46k, check=18.4k
    withPruner: true,
    toolExecute: async () => mediumToolOut,
    onSteward: async () => ({ text: JSON.stringify({ action: 'switch', reason: 'done' }) }),
    onNote: async () => ({ text: validNote('cached-prefix-note') }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-b1', name: 'inspect_file', args: { path: 'spec.md' } }, usage: { inputTokens: 16_000, outputTokens: 100 } }
      return { text: 'DONE_B1', usage: { inputTokens: 25_000, outputTokens: 100 } }
    },
  })

  await runTurn('Read spec.md and summarize')
  assert.equal(await waitFor(() => rt.chatOf('m1') === 'part-1' && !rt.isSwitchingPart('m1')), true, 'should switch parts')

  // No compaction/prune event was written to the archived part!
  assert.equal(agent.session.snapshotEvents().some(ev => ev.type === 'compaction/prune'), false, 'must not mutate history with prune when switching')
  const noteCall = calls.find(c => c.kind === 'note')
  assert.ok(noteCall, 'handoff note must be written')
  const noteTextAll = noteCall.messages.map(m => (m.content ?? []).map(b => b.text ?? '').join('')).join('\n')
  assert.doesNotMatch(noteTextAll, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'writeNote must see unpruned prefix for KV cache hit')
  assert.match(noteTextAll, /PREFIX_KEEP_MARKER/, 'original tool result stays intact in note prefix')
})

// -----------------------------------------------------------------------------
// B2: Mid-turn pruning protects current turn's tool outputs when pruning older
//     tool outputs already brings the session below hard line.
// -----------------------------------------------------------------------------
test('B2: mid-turn pruning prunes older oversized tool results first and leaves current turn tool output intact', async (t) => {
  const oldHugeOutput = 'OLD_BUILD_LOG_CHUNK '.repeat(5_000) // ~100,000 chars (~25k tokens)
  const freshOutput = `FRESH_HEAD ${'FRESH_MIDDLE_KEEP '.repeat(600)} FRESH_TAIL` // ~10,800 chars (>8192)
  const { rt, agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.7, // usable=46k, check=32.2k, hard=43.7k
    withPruner: true,
    toolExecute: async ({ path }) => (path === 'old.log' ? oldHugeOutput : freshOutput),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-old', name: 'inspect_file', args: { path: 'old.log' } }, usage: { inputTokens: 2_000, outputTokens: 100 } }
      if (step === 2) return { text: 'Checked old.log', usage: { inputTokens: 28_000, outputTokens: 100 } } // below check=32.2k
      if (step === 3) return { toolCall: { id: 'tc-fresh', name: 'inspect_file', args: { path: 'fresh.log' } }, usage: { inputTokens: 44_500, outputTokens: 100 } }
      return { text: 'USED_FRESH_LOG_INTACT', usage: { inputTokens: 20_000, outputTokens: 100 } }
    },
  })

  await runTurn('Inspect old.log')
  assert.equal(agent.session.snapshotEvents().some(ev => ev.type === 'compaction/prune'), false)

  await runTurn('Now inspect fresh.log')
  assert.equal(rt.chatOf('m1'), 'm1')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0, 'pruning older result avoided steward LLM call')

  const step4Messages = calls.filter(c => c.kind === 'turn')[3]?.messages ?? []
  const toolMessages = step4Messages.filter(m => m.role === 'tool')
  const oldToolText = toolMessages.find(m => m.source?.callId === 'tc-old' || m.toolCallId === 'tc-old' || (m.content?.[0]?.text ?? '').includes('OLD_BUILD_LOG_CHUNK'))?.content?.map(b => b.text ?? '').join('') ?? ''
  const freshToolText = toolMessages.find(m => (m.content?.[0]?.text ?? '').includes('FRESH_HEAD'))?.content?.map(b => b.text ?? '').join('') ?? ''
  assert.match(oldToolText, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'older tool output must be pruned')
  assert.doesNotMatch(freshToolText, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'current turn tool output must remain protected and unpruned')
  assert.match(freshToolText, /FRESH_MIDDLE_KEEP/, 'middle of current turn tool output must be intact')
})

// -----------------------------------------------------------------------------
// B11: Structured active-work signals short-circuit steward to compact and defer
//      non-hard switches while running shell jobs or subagents are active.
// -----------------------------------------------------------------------------
test('B11: active runningJobs short-circuit steward with 0 LLM calls and defer switch when compaction cannot clear check line', async (t) => {
  let jobs = [{ id: 'bg-shell-1' }]
  const { rt, calls, archived, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // check=18.4k, hard=43.7k
    withPruner: false,
    onCheckpoint: async () => ({ error: { code: 'TRANSIENT', message: 'compaction skipped' } }),
    onTurn: () => ({ text: 'Started long build in background.', usage: { inputTokens: 25_000, outputTokens: 100 } }),
  })
  rt.runningJobs = () => jobs

  await runTurn('Start background build')
  await new Promise(resolve => setTimeout(resolve, 120))

  // Zero steward LLM calls (short-circuited), and NO switch / archive while bg job runs!
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0, 'runningJobs must short-circuit steward without LLM call')
  assert.equal(rt.chatOf('m1'), 'm1', 'must defer switch below hard line while background job is running')
  assert.deepEqual(archived, [], 'must not archive session and kill active background job')

  // Once job finishes, next idle turn asks steward and switches cleanly.
  jobs = []
  await runTurn('Build finished')
  assert.equal(await waitFor(() => calls.filter(c => c.kind === 'steward').length >= 1), true)
})

// -----------------------------------------------------------------------------
// B12: Mid-turn steward failure defaults to tail-preserving compact, not switch.
// -----------------------------------------------------------------------------
test('B12: mid-turn steward failure defaults to in-place compact instead of tearing down active turn with a switch', async (t) => {
  const big = 'Active turn context block. '.repeat(1_500)
  const { rt, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // hard=43.7k
    withPruner: false,
    onSteward: async () => ({ error: { code: 'SERVER_ERROR', message: 'steward unavailable' } }),
    onCheckpoint: async () => ({ text: '- Done: compacted cleanly on steward failure' }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-b12', name: 'inspect_file', args: { path: 'a.js' } }, usage: { inputTokens: 44_500, outputTokens: 100 } }
      return { text: 'FINISHED_WITHOUT_SWITCH', usage: { inputTokens: 8_000, outputTokens: 100 } }
    },
  })

  await runTurn(`Continue work: ${big}`)
  assert.equal(rt.chatOf('m1'), 'm1', 'mid-turn steward failure should compact in-place rather than switch')
  assert.ok(calls.some(c => c.kind === 'checkpoint'), 'checkpoint condensation must run as mid-turn fallback')
  assert.equal(calls.filter(c => c.kind === 'note').length, 0)
})

// -----------------------------------------------------------------------------
// B7: Mid-turn compaction landing between check and hard forces one idle recheck
//     bypassing the C/4 growth gate when the turn ends.
// -----------------------------------------------------------------------------
test('B7: mid-turn compaction landing between check and hard triggers forced idle checkContext without waiting for C/4 growth', async (t) => {
  const big = 'Retained tail working context. '.repeat(2_200) // ~17k tokens
  let stewardCount = 0
  const { rt, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46k, check=18.4k (check/4=4.6k), hard=43.7k
    withPruner: false,
    onSteward: async () => {
      stewardCount += 1
      // Mid-turn says compact; end-of-turn forced recheck says switch.
      return { text: JSON.stringify({ action: stewardCount === 1 ? 'compact' : 'switch', reason: stewardCount === 1 ? 'mid-turn' : 'done' }) }
    },
    onCheckpoint: async () => ({ text: '- Done: condensed earlier prefix while keeping large active tail' }),
    onNote: async () => ({ text: validNote('post-midturn-recheck') }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-b7', name: 'inspect_file', args: { path: 'big.txt' } }, usage: { inputTokens: 44_500, outputTokens: 100 } }
      // After mid-turn compaction lands around ~22k (between check=18.4k and hard=43.7k),
      // step 2 reports 22,500 tokens — only +500 growth, far below C/4 (4,600)!
      return { text: 'TURN_DONE_BETWEEN_CHECK_AND_HARD', usage: { inputTokens: 22_500, outputTokens: 100 } }
    },
  })

  await runTurn(`Large active task:\n${big}`)
  assert.equal(await waitFor(() => rt.chatOf('m1') === 'part-1' && !rt.isSwitchingPart('m1')), true, 'end-of-turn forced recheck must run steward and switch even below C/4 growth')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 2, 'steward called once mid-turn and once on forced idle recheck')
})

// -----------------------------------------------------------------------------
// B10: canMakeRoom returning false sets backoff so steward is not spammed every turn.
// -----------------------------------------------------------------------------
test('B10: repeated idle turns when canMakeRoom is false back off instead of calling steward every turn', async (t) => {
  const { rt, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.4, // usable=46k, check=18.4k, hard=43.7k
    withPruner: false,
    onSteward: async () => ({ text: JSON.stringify({ action: 'switch', reason: 'done' }) }),
    onNote: async () => ({ text: validNote('k') }),
    onTurn: (step) => {
      if (step === 1) return { text: 'ok', usage: { inputTokens: 24_000, outputTokens: 5 } }
      return { text: 'ok', usage: { inputTokens: 40_000, outputTokens: 5 } }
    },
  })

  // First turn triggers normal switch to part-1 (which opens with a handoff message).
  await runTurn('hi')
  assert.equal(await waitFor(() => rt.chatOf('m1') === 'part-1' && !rt.isSwitchingPart('m1')), true)
  const part1Agent = rt.ctx.get('agents').get('part-1')
  await part1Agent.whenIdle()
  // Simulate an MCP-heavy Bot whose system prompt + tool definitions consume 40k of the 46k usable window
  // while conversation history is tiny (200 tokens), so replacement >= history -> canMakeRoom === false.
  const meter = rt.ctx.get('tokenMeter')
  const origMeasure = meter.measure.bind(meter)
  meter.measure = (session) => {
    if (session.id === 'part-1') {
      const nodes = [...session.surface.nodes]
      return {
        totalTokens: 40_200,
        nodes: nodes.map((seq, i) => ({ seq, tokens: i === 0 ? 40_000 : 10 })),
      }
    }
    return origMeasure(session)
  }
  const stewardsBefore = calls.filter(c => c.kind === 'steward').length

  await runTurn('p1', part1Agent)
  await new Promise(resolve => setTimeout(resolve, 120))
  const stewardsAfterFirst = calls.filter(c => c.kind === 'steward').length
  assert.equal(rt.chatOf('m1'), 'part-1', 'part-1 stays put when canMakeRoom is false')
  assert.equal(stewardsAfterFirst, stewardsBefore + 1, 'first turn past check asks steward once')

  await runTurn('p2', part1Agent)
  await new Promise(resolve => setTimeout(resolve, 120))
  const stewardsAfterSecond = calls.filter(c => c.kind === 'steward').length
  assert.equal(stewardsAfterSecond, stewardsAfterFirst, 'roomRetry cooldown must prevent spamming steward on consecutive turns')
})

// -----------------------------------------------------------------------------
// B18 + B19 + B20: Crash-safe switch durability (handoffPending recovery,
//                  durable pre-switch carry parking, automatic heldBack retry)
// -----------------------------------------------------------------------------
function makeSwitchFixture({ fail = {}, home: reuse } = {}) {
  const root = reuse === undefined
    ? realpathSync.native(mkdtempSync(join(tmpdir(), 'dsb-pr1-dur-')))
    : join(reuse, '..', '..')
  const home = reuse ?? join(root, 'dsh', 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  if (reuse === undefined) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1,
      mainBotIds: ['a'],
      workspaceId: 'w1',
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
        b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, workDir: project },
      },
      rooms: {},
      exchanges: [],
      exchangeTurns: {},
      questions: {},
      prefs: {},
      revision: 0,
    }))
  }

  const inboxPath = join(home, 'fake-inbox.json')
  const readInbox = () => { try { return JSON.parse(readFileSync(inboxPath, 'utf8')) } catch { return {} } }
  const saved = readInbox()
  const persist = (agents) => {
    const all = { ...saved }
    for (const [id, agent] of agents) all[id] = { nextStep: agent.inbox.nextStep, nextTurn: agent.inbox.nextTurn }
    writeFileSync(inboxPath, JSON.stringify(all))
  }

  const ctx = fakeContext({
    services: {
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
      approval: { request: async () => 'allowed-once' },
    },
  })
  let flushes = 0
  const archived = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const nextStep = [...saved[sessionId]?.nextStep ?? []]
      const nextTurn = [...saved[sessionId]?.nextTurn ?? []]
      const tools = new Map()
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, seq: 0, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } } },
        tools,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]); nextTurn.push(message); persist(agents) },
        steer(message) { calls.push(['steer', message]); nextStep.push(message); persist(agents) },
        inject(message) { calls.push(['inject', message]); nextStep.push(message); persist(agents) },
        send(message, target, wakeup) {
          ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
          calls.push(['send', message, target, wakeup])
          persist(agents)
        },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message); persist(agents) },
          append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message); persist(agents) },
          remove(id) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(m => m.id === id)
              if (at !== -1) { list.splice(at, 1); persist(agents); return true }
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }

  let createdCount = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [{ id: 'w1', path: team }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async (options) => {
        if (typeof fail.onCreate === 'function') await fail.onCreate()
        const sessionId = `s${++createdCount}`
        cwds.set(sessionId, options.cwd ?? team)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      flush: async (session) => {
        flushes += 1
        if (typeof fail.onFlush === 'function') await fail.onFlush(session, flushes)
        if (fail.flush === true || fail.flush === flushes) throw new Error('transient flush error')
      },
    },
  })

  const rt = createRuntime(ctx, { home })
  const preStep = (sessionId, messages = [], step = 2) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  return { ctx, rt, home, root, archived, agentOf, preStep, state, fail, stop }
}

test('B18: crash between pointer flip and handoff flush #1 recovers missing handoff package with original reply routing on restart', async (t) => {
  // Flush #1 checkpoints parked input on old part b; Flush #2 fails on s1 handoff after pointer flip.
  const fail = { flush: 2 }
  const host = makeSwitchFixture({ fail })
  await host.rt.load()
  const msg = { id: 'm-b18', role: 'user', content: [{ type: 'text', text: 'important task' }], source: { kind: 'user', exchangeId: 'ex-b18' } }
  const entry = host.rt.liveOf('b')
  entry.info = { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-peer-route', rpcId: 'stale-rpc-1', senderName: 'Kai' }
  entry.joined = [{ info: { kind: SOURCE_KIND, role: 'request', exchangeId: 'ex-joined-1' }, text: 'also check this' }]
  host.agentOf('b').status = 'running'
  await host.preStep('b', [msg], 2)
  assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1'), true)
  await new Promise(resolve => setTimeout(resolve, 40))

  // Pointer flipped to s1, handoffPending remained true in state.switching!
  assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending must stay persisted when handoff flush fails')
  // Simulate crash where s1 lost its unflushed handoff message on disk before handoff flush completed.
  const inboxFile = join(host.home, 'fake-inbox.json')
  const onDisk = JSON.parse(readFileSync(inboxFile, 'utf8'))
  onDisk.s1 = { nextStep: [], nextTurn: [] }
  writeFileSync(inboxFile, JSON.stringify(onDisk))
  await host.stop({ keep: true })

  // Restart and run heldBack(): must reconstruct & deliver [Handoff · part 2] preserving
  // original reply routing (exchangeId, role, joined, no stale rpcId) BEFORE held user input.
  const second = makeSwitchFixture({ home: host.home })
  t.after(second.stop)
  await second.rt.load()
  await second.rt.heldBack()

  const followups = second.agentOf('s1').calls.filter(([kind]) => kind === 'followup').map(([, m]) => m)
  assert.ok(followups.length >= 2, 'must deliver reconstructed handoff AND held user message')
  assert.equal(followups[0].source?.handoff, true, 'first message on s1 must be reconstructed handoff package')
  assert.equal(followups[0].source?.exchangeId, 'ex-peer-route', 'recovered handoff must preserve original exchangeId for turn settlement')
  assert.equal(followups[0].source?.role, 'request', 'recovered handoff must preserve original reply role')
  assert.equal(followups[0].source?.rpcId, undefined, 'recovered handoff must strip stale rpcId')
  assert.equal(followups[0].source?.joined?.length, 1, 'recovered handoff must preserve joined requests')
  assert.match(followups[0].content[0].text, /^\[Handoff · part 2\]/)
  assert.equal(followups[1].content[0].text, 'important task', 'held user message must follow handoff')
  assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(second.state().switching, {})
})

test('B19: claimed mid-turn step messages are durably parked AND flushed on old session before new part creation', async (t) => {
  const order = []
  let releaseCreate
  const createPaused = new Promise(resolve => { releaseCreate = resolve })
  let atCreateResolve
  const atCreate = new Promise(resolve => { atCreateResolve = resolve })
  const host = makeSwitchFixture({
    fail: {
      onFlush: (session) => { order.push(`flush:${session.id}`) },
      onCreate: async () => {
        order.push('create')
        atCreateResolve()
        await createPaused
      },
    },
  })
  t.after(async () => { releaseCreate(); await host.stop() })
  await host.rt.load()

  const claimed = { id: 'm-b19', role: 'user', content: [{ type: 'text', text: 'do not drop me mid-switch' }], source: { kind: 'user', exchangeId: 'ex-b19' } }
  host.agentOf('b').status = 'running'
  await host.preStep('b', [claimed], 2)
  await atCreate

  // Old session flush MUST complete before create() starts!
  assert.deepEqual(order, ['flush:b', 'create'], 'old session durability flush must precede new part creation')
  const persistedInbox = JSON.parse(readFileSync(join(host.home, 'fake-inbox.json'), 'utf8'))
  const texts = (persistedInbox.b?.nextTurn ?? []).map(m => m.content?.[0]?.text)
  assert.deepEqual(texts, ['do not drop me mid-switch'], 'claimed input must be durable in old inbox before switch completes')

  releaseCreate()
  assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1' && Object.keys(host.state().switching).length === 0), true)
  const userDeliveries = host.agentOf('s1').calls.filter(([kind, m]) => kind === 'followup' && m.content?.[0]?.text === 'do not drop me mid-switch')
  assert.equal(userDeliveries.length, 1, 'durably parked message must be forwarded exactly once')
})

test('B20: failed post-move forward retries automatically via backoff without duplicating prompts already claimed by target', async (t) => {
  const realSetTimeout = globalThis.setTimeout
  const waitReal = async (predicate, timeoutMs = 3_000) => {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (predicate()) return true
      await new Promise(resolve => realSetTimeout(resolve, 15))
    }
    return predicate()
  }
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() })
  t.after(() => t.mock.timers.reset())

  // Flush #1 (park on b) & Flush #2 (handoff on s1) succeed; Flush #3 (forward to s1) fails
  // AFTER s1 has already claimed the forwarded message out of its inbox into its session events!
  const targetEvents = []
  const fail = {
    flush: 3,
    onFlush: (session, n) => {
      if (n === 3 && session.id === 's1') {
        // Simulate target agent claiming the forwarded prompt out of s1.inbox right before flush fails.
        const s1 = host.agentOf('s1')
        const claimed = s1.inbox.nextTurn.splice(0).find(m => m.content?.[0]?.text === 'append line once')
        if (claimed) {
          targetEvents.push({ type: 'user/message', data: { id: claimed.id, source: claimed.source, content: claimed.content } })
        }
      }
    },
  }
  const host = makeSwitchFixture({ fail })
  t.after(host.stop)
  await host.rt.load()

  // Expose snapshotEvents on s1 once created so collectTargetSeenKeys sees admitted events.
  const origResolve = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async (sid) => {
    const res = await origResolve(sid)
    if (sid === 's1' && res.agent?.session) res.agent.session.snapshotEvents = () => targetEvents
    return res
  }

  // Prompt without exchangeId (only message.id) — must still deduplicate via transferId!
  const msg = { id: 'm-b20-no-exid', role: 'user', content: [{ type: 'text', text: 'append line once' }], source: { kind: 'user' } }
  host.agentOf('b').status = 'running'
  await host.preStep('b', [msg], 2)

  assert.equal(await waitReal(() => host.state().bots.b.sessionId === 's1' && host.state().switching.b !== undefined && targetEvents.length === 1 && !host.rt.isSwitchingPart('b')), true)
  // Yield one real microtask/tick so startSwitch.finally has registered the 5s retry timer.
  await new Promise(resolve => realSetTimeout(resolve, 10))
  assert.deepEqual(host.archived, [], 'old part stays unarchived after transient forward flush error')

  // Clear transient error and advance timer 5s: backoff retry runs heldBack() automatically,
  // sees the prompt was already admitted on s1, flushes s1, archives b, and NEVER duplicates it!
  fail.flush = false
  t.mock.timers.tick(5_000)

  assert.equal(await waitReal(() => host.archived.some(([id]) => id === 'b') && Object.keys(host.state().switching).length === 0), true, 'automatic backoff retry must settle and archive old part without restart')
  const sentToTarget = host.agentOf('s1').calls.filter(([kind, m]) => kind === 'followup' && m.content?.[0]?.text === 'append line once')
  assert.equal(sentToTarget.length, 1, 'already-claimed prompt must NOT be forwarded a second time on retry')
})

test('B2-steer: mid-turn pruning uses turn/start so a mid-turn steer does not expose earlier tool results of the same turn', async (t) => {
  const oldHugeOutput = 'TURN1_OLD_LOG '.repeat(5_000) // ~70k chars (~17.5k tokens)
  const turn2FirstOutput = `T2_FIRST_HEAD ${'T2_FIRST_KEEP '.repeat(700)} T2_FIRST_TAIL` // ~10k chars (>8192)
  const turn2SecondOutput = `T2_SECOND_HEAD ${'T2_SECOND_KEEP '.repeat(700)} T2_SECOND_TAIL` // ~10k chars (>8192)
  const { rt, agent, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 50_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.7, // usable=46k, check=32.2k, hard=43.7k
    withPruner: true,
    toolExecute: async ({ path }) => (path === 'old.log' ? oldHugeOutput : path === 't2-first.log' ? turn2FirstOutput : turn2SecondOutput),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-t1', name: 'inspect_file', args: { path: 'old.log' } }, usage: { inputTokens: 2_000, outputTokens: 100 } }
      if (step === 2) return { text: 'Done turn 1', usage: { inputTokens: 20_000, outputTokens: 100 } }
      if (step === 3) return { toolCall: { id: 'tc-t2-a', name: 'inspect_file', args: { path: 't2-first.log' } }, usage: { inputTokens: 24_000, outputTokens: 100 } }
      if (step === 4) {
        // User steers mid-turn right before step 4 calls another tool!
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 'also check t2-second.log' }], source: { kind: 'user' } }))
        return { toolCall: { id: 'tc-t2-b', name: 'inspect_file', args: { path: 't2-second.log' } }, usage: { inputTokens: 44_500, outputTokens: 100 } }
      }
      return { text: 'BOTH_TURN2_LOGS_INTACT', usage: { inputTokens: 20_000, outputTokens: 100 } }
    },
  })

  await runTurn('Inspect old.log')
  await runTurn('Inspect t2-first.log')
  assert.equal(rt.chatOf('m1'), 'm1')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 0)

  const lastTurnMsgs = calls.filter(c => c.kind === 'turn').at(-1)?.messages ?? []
  const toolTexts = lastTurnMsgs.filter(m => m.role === 'tool').map(m => (m.content ?? []).map(b => b.text ?? '').join(''))
  const oldTxt = toolTexts.find(s => s.includes('TURN1_OLD_LOG')) ?? ''
  const firstTxt = toolTexts.find(s => s.includes('T2_FIRST_HEAD')) ?? ''
  const secondTxt = toolTexts.find(s => s.includes('T2_SECOND_HEAD')) ?? ''
  assert.match(oldTxt, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'previous turn tool output must be pruned')
  assert.doesNotMatch(firstTxt, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'current turn first tool output before mid-turn steer must stay protected')
  assert.match(firstTxt, /T2_FIRST_KEEP/)
  assert.doesNotMatch(secondTxt, /\[\.\.\. tool result middle pruned \.\.\.\]/, 'current turn second tool output must stay protected')
})

test('B6-nonbinding: an explicit checkTokens above the ratio-based check line does not lower the mid-turn threshold', async (t) => {
  // Window 100k, reserve 4k -> usable 96k, hard 91.2k; checkRatio 0.5 -> ratio check = 48k.
  // Explicit checkTokens=380k is nonbinding (380k > 48k), so mid-turn must NOT condense at 75k (< hard 91.2k).
  const { rt, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 100_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.5,
    withPruner: false,
    config: { checkTokens: 380_000 },
    onSteward: async () => ({ text: JSON.stringify({ action: 'compact', reason: 'stay' }) }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-nb', name: 'inspect_file', args: { path: 'a.js' } }, usage: { inputTokens: 75_000, outputTokens: 100 } }
      return { text: 'FINISHED_WITHOUT_EARLY_MIDTURN_COMPACT', usage: { inputTokens: 30_000, outputTokens: 100 } }
    },
  })

  await runTurn('Run task under nonbinding checkTokens')
  assert.equal(rt.chatOf('m1'), 'm1')
  assert.equal(calls.filter(c => c.kind === 'checkpoint').length, 0, 'nonbinding checkTokens must not trigger early mid-turn compaction below hard line')
})

test('rollback after failed fresh-part creation still delivers PAUSE_NOTE when the original exchangeId is already in the old session history', async (t) => {
  const host = makeSwitchFixture({
    fail: {
      onCreate: async () => { throw new Error('disk full') },
    },
  })
  t.after(host.stop)
  await host.rt.load()

  // Old session already has the initiating peer-Bot request (exchangeId: 'ex-42', transferId: 'tr-orig-42') in its logged user/message history.
  const bAgent = host.agentOf('b')
  bAgent.session.snapshotEvents = () => [
    { type: 'user/message', data: { id: 'orig-req-42', source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-42', transferId: 'tr-orig-42', senderName: 'Kai' }, content: [{ type: 'text', text: 'Finish ex-42' }] } },
  ]
  const entry = host.rt.liveOf('b')
  entry.info = { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-42', transferId: 'tr-orig-42', senderName: 'Kai' }
  bAgent.status = 'running'

  await host.preStep('b', [], 2)
  assert.equal(await waitFor(() => bAgent.calls.some(([kind, m]) => (kind === 'send' || kind === 'followup') && (m.content?.[0]?.text ?? '').includes('DS Bot paused your turn'))), true, 'PAUSE_NOTE must not be dropped as a duplicate of the logged ex-42 request')

  const pauseMsg = bAgent.calls.find(([kind, m]) => (kind === 'send' || kind === 'followup') && (m.content?.[0]?.text ?? '').includes('DS Bot paused your turn'))[1]
  assert.equal(pauseMsg.source?.exchangeId, 'ex-42', 'PAUSE_NOTE keeps original exchangeId for reply routing')
  assert.ok(typeof pauseMsg.source?.transferId === 'string' && pauseMsg.source.transferId !== 'ex-42' && pauseMsg.source.transferId !== 'tr-orig-42', 'PAUSE_NOTE uses its own distinct transferId')
})

test('startup resend logged on successor before handOnHeld does not duplicate the held Bot request', async (t) => {
  const host = makeSwitchFixture()
  t.after(host.stop)
  await host.rt.load()

  // 1) Deliver a peer-Bot request through the real rt.deliver journal path into part 'b'.
  await host.rt.deliver({
    fromId: 'b',
    fromName: 'Kai',
    toId: 'b',
    sessionId: 'b',
    role: 'request',
    exchangeId: 'ex-dup-restart',
    text: 'Append one line to audit.log',
  })
  const bAgent = host.agentOf('b')
  const heldOriginal = bAgent.inbox.nextTurn.find(m => m?.source?.exchangeId === 'ex-dup-restart')
  assert.ok(heldOriginal, 'original Bot request must be queued in old part inbox')
  const stableTransferId = heldOriginal.source?.transferId
  assert.ok(typeof stableTransferId === 'string' && stableTransferId.length > 0, 'rt.deliver stamps a stable transferId')

  const persisted = host.rt.coordination.loadInitialState()
  const journalEntry = persisted.queued?.b?.find(item => item.args?.exchangeId === 'ex-dup-restart')
  assert.equal(journalEntry?.args?.transferId, stableTransferId, 'coordination store persists the exact same transferId')

  // 2) Simulate crash after saving pointer flip (b -> b-next) before moving b's inbox,
  // and startup resend delivering the journal entry to b-next (new message id, same transferId)
  // which b-next already claimed & logged into user/message before handOnHeld runs.
  const bot = host.rt.state.bots.b
  bot.sessionId = 'b-next'
  bot.parts = [{ sessionId: 'b', at: Date.now() - 1_000, reason: 'full' }, { sessionId: 'b-next', at: Date.now() }]
  host.rt.state.switching = { b: { botId: 'b', next: 'b-next' } }
  await host.rt.save()

  const nextAgent = host.agentOf('b-next')
  // Simulate startup resendQueued calling deliver with the journaled args on the new part.
  await host.rt.deliver({ ...journalEntry.args, sessionId: 'b-next', steer: false, resent: true })
  const resentMsg = nextAgent.inbox.nextTurn.find(m => m?.source?.exchangeId === 'ex-dup-restart')
  assert.ok(resentMsg, 'startup resend reached new part inbox')
  assert.equal(resentMsg.source?.transferId, stableTransferId, 'startup resend carries the same stable transferId')
  assert.notEqual(resentMsg.id, heldOriginal.id, 'startup resend has a distinct message id')

  // Successor claims the resent message out of its inbox and logs it as user/message BEFORE handOnHeld runs.
  nextAgent.inbox.nextTurn.splice(0)
  nextAgent.session.snapshotEvents = () => [
    { type: 'user/message', data: { id: resentMsg.id, source: resentMsg.source, content: resentMsg.content } },
    // Also simulate a legacy pre-upgrade resend without transferId already logged on successor.
    { type: 'user/message', data: { id: 'legacy-resent-id', source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-legacy-restart', senderName: 'Kai' }, content: [{ type: 'text', text: 'Legacy append' }] } },
  ]
  bAgent.inbox.nextTurn.push(createUserMessage({
    id: 'legacy-orig-id',
    content: [{ type: 'text', text: 'Legacy append' }],
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-legacy-restart', senderName: 'Kai' },
  }))
  const followupsBefore = nextAgent.calls.filter(([kind]) => kind === 'followup').length

  await host.rt.heldBack()

  const followupsAfter = nextAgent.calls.filter(([kind]) => kind === 'followup').length
  assert.equal(followupsAfter, followupsBefore, 'handOnHeld must not duplicate either transferId-tagged or legacy exchangeId-only Bot requests already logged by startup resend')
  assert.equal(bAgent.inbox.nextTurn.length, 0, 'old part inbox is cleared after confirming target admission')
  assert.equal(host.rt.state.switching.b, undefined, 'switching marker cleared')
})

test('retrying a failed forward flush deduplicates admitted transferId while keeping separate follow-up delegations intact', async (t) => {
  let failForwardFlush = false
  const host = makeSwitchFixture({
    fail: {
      onFlush: (session) => {
        if (failForwardFlush && session.id === 's1') {
          failForwardFlush = false
          throw new Error('transient forward flush failure')
        }
      },
    },
  })
  t.after(host.stop)
  await host.rt.load()

  // Call real delegate_work tool as Chief ('a') to delegate "check invoice A" to Writer ('b').
  const delegateTool = host.rt.teamTools.find(d => d.name === 'delegate_work')
  assert.ok(delegateTool, 'delegate_work tool registered on runtime')

  await delegateTool.execute({ to: 'Writer', goal: 'check invoice A', when: 'queue' }, { agent: { id: 'a' } })
  const bAgent = host.agentOf('b')
  const original = bAgent.inbox.nextTurn.find(m => (m.content?.[0]?.text ?? '').includes('check invoice A'))
  assert.ok(original, 'original request queued on Writer old part')
  const origTransferId = original.source?.transferId
  assert.ok(typeof origTransferId === 'string' && origTransferId.length > 0, 'original request carries transferId')

  // Simulate pointer flip b -> s1 and a forward that queues on s1 before its flush fails,
  // leaving the original in b.inbox and state.switching.b pending for retry.
  const bot = host.rt.state.bots.b
  bot.sessionId = 's1'
  bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
  host.rt.chatOwners.set('s1', 'b')
  host.rt.state.switching = { b: { botId: 'b' } }
  await host.rt.save()

  failForwardFlush = true
  await host.rt.heldBack()
  const s1Agent = host.agentOf('s1')
  assert.equal(s1Agent.inbox.nextTurn.length, 1, 's1 received forwarded copy before flush failed')
  assert.equal(bAgent.inbox.nextTurn.length, 1, 'old part retained original after flush failure')
  assert.ok(host.rt.state.switching.b !== undefined, 'switching marker kept for retry')

  // Before retry runs, Chief delegates "check invoice B" separately and s1 claims/logs invoice A.
  await delegateTool.execute({ to: 'Writer', goal: 'check invoice B', when: 'queue' }, { agent: { id: 'a' } })
  const forwardedA = s1Agent.inbox.nextTurn.find(m => m.source?.transferId === origTransferId)
  assert.ok(forwardedA, 's1 has forwarded invoice A with matching transferId')
  s1Agent.inbox.remove(forwardedA.id)
  s1Agent.session.snapshotEvents = () => [
    { type: 'user/message', data: { id: forwardedA.id, source: forwardedA.source, content: forwardedA.content } },
  ]
  const followupsBefore = s1Agent.calls.filter(([kind]) => kind === 'followup').length

  await host.rt.heldBack()

  assert.equal(s1Agent.calls.filter(([kind]) => kind === 'followup').length, followupsBefore, 'heldBack retry must not re-queue already-admitted invoice A')
  assert.equal(s1Agent.inbox.nextTurn.some(m => (m.content?.[0]?.text ?? '').includes('check invoice B')), true, 'separate invoice B assignment stays queued on s1')
  assert.equal(bAgent.inbox.nextTurn.length, 0, 'old part inbox cleared after retry')
  assert.equal(host.rt.state.switching.b, undefined, 'switching marker cleared after retry')
})

test('three-part recovery delivers the newest payload for a shared transferId once and never overwrites it with an older retained original', async (t) => {
  const host = makeSwitchFixture()
  t.after(host.stop)
  await host.rt.load()

  const sharedTransferId = 'tr-shared-3part'
  const sharedExchangeId = 'ex-shared-3part'
  const p1 = host.agentOf('b')
  const p2 = host.agentOf('s1')
  p1.inbox.nextTurn.push(createUserMessage({
    id: 'm-p1-orig',
    content: [{ type: 'text', text: 'check invoice A' }],
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: sharedExchangeId, transferId: sharedTransferId, senderName: 'Chief' },
  }))
  p2.inbox.nextTurn.push(createUserMessage({
    id: 'm-p2-updated',
    content: [{ type: 'text', text: 'check invoice A and check invoice B' }],
    source: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: sharedExchangeId, transferId: sharedTransferId, senderName: 'Chief' },
  }))

  // Both b (older) and s1 (newer, with handoffPending) remain in state.switching targeting s2!
  const bot = host.rt.state.bots.b
  bot.sessionId = 's2'
  bot.segments = [
    { sessionId: 'b', endedAt: Date.now() - 2_000 },
    { sessionId: 's1', endedAt: Date.now() - 1_000 },
  ]
  host.rt.chatOwners.set('s1', 'b')
  host.rt.chatOwners.set('s2', 'b')
  host.rt.state.switching = {
    b: { botId: 'b' },
    s1: { botId: 'b', handoffPending: true, handoffMeta: { folder: true } },
  }
  await host.rt.save()

  // Recovery runs: must deliver part 2's handoff + part 2's newer payload ONCE on s2,
  // and never forward part 1's stale original ahead of it.
  await host.rt.heldBack()

  const p3 = host.agentOf('s2')
  const followups = p3.calls.filter(([kind]) => kind === 'followup').map(([, m]) => m)
  assert.equal(followups.length, 2, 'part 3 receives handoff followed by exactly one superseding request')
  assert.equal(followups[0].source?.handoff, true, 'newest handoff delivered first')
  assert.match(followups[1].content[0].text, /check invoice A/)
  assert.match(followups[1].content[0].text, /check invoice B/)
  assert.equal(p1.inbox.nextTurn.length, 0, 'part 1 inbox cleared')
  assert.equal(p2.inbox.nextTurn.length, 0, 'part 2 inbox cleared')
  assert.deepEqual(host.rt.state.switching, {}, 'both switching markers cleared')
})

test('undelivered resume handoff followed by non-resuming folder handoff preserves reply routing and joined requests on recovery', async (t) => {
  const host = makeSwitchFixture()
  t.after(host.stop)
  await host.rt.load()

  const bot = host.rt.state.bots.b
  bot.sessionId = 's2'
  bot.segments = [
    { sessionId: 'b', endedAt: Date.now() - 2_000 },
    { sessionId: 's1', endedAt: Date.now() - 1_000 },
  ]
  host.rt.chatOwners.set('s1', 'b')
  host.rt.chatOwners.set('s2', 'b')
  host.ctx.sessionController.page = async (query) => (
    query?.address?.sessionId === 'b'
      ? { records: [{ kind: 'event', event: { seq: 42, time: 1_700_000_000_000, type: 'user/message', data: { content: [{ type: 'text', text: 'Original Planner prompt in part 1' }], source: { kind: 'user' } } } }], hasMore: false }
      : { records: [], hasMore: false }
  )
  // Part 1 ('b') had an interrupted turn answering Planner ('ex-planner') with a joined request;
  // Part 2 ('s1') then hit an idle folder switch whose handoff was also interrupted.
  host.rt.state.switching = {
    b: {
      botId: 'b',
      handoffPending: true,
      handoffMeta: {
        resume: true,
        overflow: false,
        cutoff: false,
        folder: false,
        engine: false,
        bare: false,
        info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-planner', senderName: 'Planner' },
        joined: [{ info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-joined-2', senderName: 'Reviewer' }, text: 'check appendix' }],
      },
    },
    s1: {
      botId: 'b',
      handoffPending: true,
      handoffMeta: {
        resume: false,
        overflow: false,
        cutoff: false,
        folder: true,
        engine: false,
        bare: false,
      },
    },
  }
  await host.rt.save()

  await host.rt.heldBack()

  const p3 = host.agentOf('s2')
  const handoffs = p3.calls.filter(([kind, m]) => kind === 'followup' && m.source?.handoff === true).map(([, m]) => m)
  assert.equal(handoffs.length, 1, 'delivers one consolidated handoff package to part 3')
  assert.equal(handoffs[0].source?.resume, true, 'consolidated handoff preserves resume flag from earlier interrupted turn')
  assert.equal(handoffs[0].source?.exchangeId, 'ex-planner', 'consolidated handoff preserves original reply exchangeId')
  assert.equal(handoffs[0].source?.role, 'request', 'consolidated handoff preserves original reply role')
  assert.deepEqual(handoffs[0].source?.joined?.map(item => item.info?.exchangeId), ['ex-joined-2'], 'consolidated handoff preserves joined requests')
  assert.match(handoffs[0].content[0].text, /You were in the middle of a turn/)
  assert.match(handoffs[0].content[0].text, /\[part 1 #42/, 'borrowed fallback transcript from part 1 keeps part 1 anchor (not part 2)')
  assert.deepEqual(host.rt.state.switching, {}, 'both switching markers cleared only after consolidated handoff is durable')
})

test('handOnHeld re-checks destination after source resolution and never moves reminders onto a retiring part', async (t) => {
  const host = makeSwitchFixture()
  t.after(host.stop)
  await host.rt.load()

  const bot = host.rt.state.bots.b
  bot.sessionId = 's1'
  bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
  host.rt.chatOwners.set('s1', 'b')
  host.rt.state.switching = { b: { botId: 'b' } }
  await host.rt.save()

  const movedSchedules = []
  host.rt.moveSchedules = async (fromId, toId, opts) => {
    const resolved = typeof opts?.resolveTarget === 'function' ? opts.resolveTarget() : toId
    movedSchedules.push([fromId, resolved])
  }

  // While handOnHeld resolves source part 'b', a concurrent folder edit moves b's current part from s1 -> s2.
  let flippedDuringResolve = false
  const origResolve = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async (sid) => {
    const res = await origResolve(sid)
    if (sid === 'b' && !flippedDuringResolve) {
      flippedDuringResolve = true
      bot.sessionId = 's2'
      bot.segments.push({ sessionId: 's1', endedAt: Date.now() })
      host.rt.chatOwners.set('s2', 'b')
    }
    return res
  }

  await host.rt.heldBack()
  // First pass must defer cleanly instead of moving reminders onto retiring s1!
  assert.deepEqual(movedSchedules, [], 'must NOT move reminders onto retiring part s1 when destination changed mid-resolution')
  assert.ok(host.rt.state.switching.b !== undefined, 'old part remains marked for retry against new destination')

  // Next retry resolves s2 cleanly and moves reminders directly to s2.
  await host.rt.heldBack()
  assert.deepEqual(movedSchedules, [['b', 's2']], 'retry moves reminders directly onto live part s2')
  assert.deepEqual(host.rt.state.switching, {}, 'switching marker cleared after moving to s2')
})

test('same-part rollback after failed create keeps PAUSE_NOTE and claimed input ahead of messages queued in next-step and next-turn during the switch', async (t) => {
  const host = makeSwitchFixture({
    fail: {
      onCreate: async () => {
        // Simulate BOTH a steered next-step follow-up AND a next-turn message arriving while create() awaits.
        host.agentOf('b').inbox.nextStep.push(createUserMessage({
          id: 'm-steered-later',
          content: [{ type: 'text', text: 'steered task follow-up' }],
          source: { kind: SOURCE_KIND, form: 'relay', role: 'task-followup', exchangeId: 'ex-steered-later', senderName: 'Chief' },
        }))
        host.agentOf('b').inbox.nextTurn.push(createUserMessage({
          id: 'm-later-1',
          content: [{ type: 'text', text: 'later follow-up' }],
          source: { kind: 'user', exchangeId: 'ex-later-1' },
        }))
        throw new Error('disk full')
      },
    },
  })
  t.after(host.stop)
  await host.rt.load()

  const bAgent = host.agentOf('b')
  bAgent.status = 'running'
  const claimed = createUserMessage({
    id: 'm-claimed-1',
    content: [{ type: 'text', text: 'earlier claimed input' }],
    source: { kind: 'user', exchangeId: 'ex-claimed-1' },
  })
  await host.preStep('b', [claimed], 2)

  assert.equal(await waitFor(() => bAgent.inbox.nextTurn.length === 4 && !host.rt.isSwitchingPart('b')), true)
  const queuedTexts = bAgent.inbox.nextTurn.map(m => m.content?.[0]?.text ?? '')
  assert.match(queuedTexts[0], /DS Bot paused your turn/, 'PAUSE_NOTE must be first')
  assert.equal(queuedTexts[1], 'earlier claimed input', 'claimed input must precede messages queued during switch')
  assert.equal(queuedTexts[2], 'steered task follow-up', 'steered next-step follow-up must not overtake paused/claimed input')
  assert.equal(queuedTexts[3], 'later follow-up', 'later next-turn message stays behind rolled-back turn input')
})

test('same-part rollback keeps queued prompts durable on disk if host stops before waking', async (t) => {
  let atCapsResolve
  const atCaps = new Promise(resolve => { atCapsResolve = resolve })
  let releaseCaps
  const capsPaused = new Promise(resolve => { releaseCaps = resolve })
  const host = makeSwitchFixture({
    fail: {
      onCreate: async () => {
        host.agentOf('b').inbox.nextTurn.push(createUserMessage({
          id: 'm-later-crash',
          content: [{ type: 'text', text: 'Also check the totals' }],
          source: { kind: 'user', exchangeId: 'ex-later-crash' },
        }))
        throw new Error('disk full')
      },
    },
  })
  await host.rt.load()

  let pausedOnce = false
  const origEnsure = host.rt.ensureCapabilities
  host.rt.ensureCapabilities = async (sid) => {
    if (sid === 'b' && !pausedOnce) {
      pausedOnce = true
      atCapsResolve()
      await capsPaused
    }
    return origEnsure(sid)
  }

  const bAgent = host.agentOf('b')
  bAgent.status = 'running'
  await host.preStep('b', [createUserMessage({
    id: 'm-claimed-crash',
    content: [{ type: 'text', text: 'Finish current draft' }],
    source: { kind: 'user', exchangeId: 'ex-claimed-crash' },
  })], 2)

  // Pause right inside rollback's ensureCapabilities (before waking) and inspect persisted inbox on disk!
  await atCaps
  const persisted = JSON.parse(readFileSync(join(host.home, 'fake-inbox.json'), 'utf8'))
  const diskTexts = (persisted.b?.nextTurn ?? []).map(m => m.content?.[0]?.text ?? '')
  assert.equal(diskTexts.length, 3, 'all three prompts must remain in inbox on disk while rollback awaits')
  assert.match(diskTexts[0], /DS Bot paused your turn/)
  assert.equal(diskTexts[1], 'Finish current draft')
  assert.equal(diskTexts[2], 'Also check the totals')

  releaseCaps()
  await host.stop({ keep: true })

  // Reload from disk and verify handOnHeld wakes all three prompts in exact order.
  const second = makeSwitchFixture({ home: host.home })
  t.after(second.stop)
  await second.rt.load()
  await second.rt.heldBack()
  const wokenTexts = second.agentOf('b').calls.filter(([kind]) => kind === 'send').map(([, m]) => m.content?.[0]?.text ?? '')
  assert.equal(wokenTexts.length, 3)
  assert.match(wokenTexts[0], /DS Bot paused your turn/)
  assert.equal(wokenTexts[1], 'Finish current draft')
  assert.equal(wokenTexts[2], 'Also check the totals')
})

test('failed midTurnSoft compaction throttles further mid-turn retries without suppressing idle checkContext switch', async (t) => {
  // 100k usable (104k window, 4k reserve), explicit checkTokens: 40_000 (< 0.8*100k=80k), hard = 95_000, midTurnSoft = 60_000.
  const { rt, calls, runTurn } = await bootRealDshBot(t, {
    contextWindow: 104_000,
    defaultMaxTokens: 4_000,
    checkRatio: 0.8,
    withPruner: false,
    config: { checkTokens: 40_000 },
    // Compaction engine declines/fails (condense returns false).
    onCheckpoint: async () => { throw new Error('compaction unavailable') },
    onSteward: async () => ({ text: JSON.stringify({ action: 'switch', reason: 'move on after failed soft compact' }) }),
    onNote: async () => ({ text: validNote('SOFT_FALLBACK_SWITCH') }),
    onTurn: (step) => {
      if (step === 1) return { toolCall: { id: 'tc-s1', name: 'inspect_file', args: { path: 'a.js' } }, usage: { inputTokens: 60_000, outputTokens: 100 } }
      if (step === 2) return { toolCall: { id: 'tc-s2', name: 'inspect_file', args: { path: 'b.js' } }, usage: { inputTokens: 61_000, outputTokens: 100 } }
      return { text: 'TURN_ENDED_AT_61K', usage: { inputTokens: 61_000, outputTokens: 100 } }
    },
  })

  await runTurn('Trigger binding soft line with uncondensable history')
  assert.equal(await waitFor(() => rt.chatOf('m1') !== 'm1', 5_000), true, 'idle checkContext must still run after failed midTurnSoft compaction and switch parts')
  assert.equal(calls.filter(c => c.kind === 'checkpoint').length, 1, 'midTurnSoft must not retry compaction on every subsequent mid-turn step')
  assert.equal(calls.filter(c => c.kind === 'steward').length, 1, 'idle steward must be asked once when turn ends')
})

test('recovery clears acknowledged originals after forward flush even when target switches before reminder cleanup, and keeps distinct pending primary handoffs with accurate part anchors', async (t) => {
  // 1) Acknowledged originals are removed immediately after forward flush succeeds, so if
  // target s1 flips to s2 right before reminder cleanup, retry moves reminders to s2 without
  // replaying prompts s1 already answered.
  {
    const host = makeSwitchFixture()
    t.after(host.stop)
    await host.rt.load()

    const bot = host.rt.state.bots.b
    bot.sessionId = 's1'
    bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
    host.rt.chatOwners.set('s1', 'b')
    host.rt.state.switching = { b: { botId: 'b' } }
    await host.rt.save()

    const orig = createUserMessage({
      id: 'm-answered-1',
      content: [{ type: 'text', text: 'already answered on s1' }],
      source: { kind: 'user', transferId: 'tr-answered-1' },
    })
    host.agentOf('b').inbox.nextTurn.push(orig)
    // s1 already answered the prompt (present in s1 session log).
    host.agentOf('s1').session.snapshotEvents = () => [
      { type: 'user/message', data: { id: 'm-answered-s1', source: orig.source, content: orig.content } },
    ]
    // During s1's forward confirmation flush, s1 flips to s2 so cleanup defers.
    const origFlush = host.ctx.sessions.flush
    let flippedOnFlush = false
    host.ctx.sessions.flush = async (session) => {
      await origFlush(session)
      if (session.id === 's1' && !flippedOnFlush) {
        flippedOnFlush = true
        bot.sessionId = 's2'
        bot.segments.push({ sessionId: 's1', endedAt: Date.now() })
        host.rt.chatOwners.set('s2', 'b')
      }
    }

    await host.rt.heldBack()
    assert.equal(host.agentOf('b').inbox.nextTurn.length, 0, 'acknowledged original removed immediately after forward flush')
    assert.ok(host.rt.state.switching.b !== undefined, 'marker kept until schedule/archive finishes on live s2')

    // Next recovery pass points at s2 (which has no transfer record of tr-answered-1) -> must NOT replay!
    await host.rt.heldBack()
    const s2Followups = host.agentOf('s2').calls.filter(([kind]) => kind === 'followup')
    assert.equal(s2Followups.length, 0, 'already-answered prompt must never replay on s2')
    assert.deepEqual(host.rt.state.switching, {}, 'switching marker cleared on s2')
  }

  // 2) Two distinct pending primary handoffs recover as separate full handoffs (no empty-text joined demotion),
  // and borrowing part 1's transcript stamps anchors with part 1 (not part 2).
  {
    const host = makeSwitchFixture()
    t.after(host.stop)
    await host.rt.load()

    const bot = host.rt.state.bots.b
    bot.sessionId = 's2'
    bot.segments = [
      { sessionId: 'b', endedAt: Date.now() - 2_000 },
      { sessionId: 's1', endedAt: Date.now() - 1_000 },
    ]
    host.rt.chatOwners.set('s1', 'b')
    host.rt.chatOwners.set('s2', 'b')
    host.ctx.sessionController.page = async (query) => {
      if (query?.address?.sessionId === 'b') {
        return {
          records: [
            { kind: 'event', event: { seq: 42, time: 1_700_000_000_000, type: 'user/message', data: { content: [{ type: 'text', text: 'Inspect attached report from part 1' }], source: { kind: 'user' } } } },
          ],
          hasMore: false,
        }
      }
      return { records: [], hasMore: false }
    }
    host.rt.state.switching = {
      b: {
        botId: 'b',
        handoffPending: true,
        handoffMeta: {
          resume: true,
          info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-primary-1', senderName: 'Planner' },
        },
      },
      s1: {
        botId: 'b',
        handoffPending: true,
        handoffMeta: {
          resume: true,
          info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-primary-2', senderName: 'Reviewer' },
        },
      },
    }
    await host.rt.save()

    await host.rt.heldBack()
    const p3Handoffs = host.agentOf('s2').calls.filter(([kind, m]) => kind === 'followup' && m.source?.handoff === true).map(([, m]) => m)
    assert.equal(p3Handoffs.length, 2, 'two distinct primary requests recover as separate handoffs without payload-less joined demotion')
    assert.equal(p3Handoffs[0].source?.exchangeId, 'ex-primary-1')
    assert.equal(p3Handoffs[0].source?.joined, undefined, 'primary 1 is not demoted to empty-text joined')
    assert.match(p3Handoffs[0].content[0].text, /\[part 1 #42/, 'anchors from part 1 use part 1 number')
    assert.equal(p3Handoffs[1].source?.exchangeId, 'ex-primary-2')
    assert.equal(p3Handoffs[1].source?.joined, undefined)
    assert.deepEqual(host.rt.state.switching, {}, 'both switching markers cleared')
  }
})

test('ensureHandoffDelivered still flushes fresh.session when handoff already exists in memory (inbox or deriveMessages) with no held input', async (t) => {
  // 1) Handoff sits in fresh.inbox after an initial flush failure, with ZERO held user input.
  {
    let s1Flushes = 0
    let failS1Flushes = 1
    const host = makeSwitchFixture({
      fail: {
        onFlush: (session) => {
          if (session.id !== 's1') return
          s1Flushes += 1
          if (failS1Flushes > 0) {
            failS1Flushes -= 1
            throw new Error('transient s1 handoff flush failure')
          }
        },
      },
    })
    t.after(host.stop)
    await host.rt.load()

    const bot = host.rt.state.bots.b
    bot.sessionId = 's1'
    bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
    host.rt.chatOwners.set('s1', 'b')
    host.rt.state.switching = {
      b: {
        botId: 'b',
        handoffPending: true,
        handoffMeta: {
          resume: false,
          overflow: false,
          cutoff: false,
          folder: true,
          engine: false,
          bare: false,
        },
      },
    }
    await host.rt.save()

    // Seed the unflushed handoff copy in s1.inbox (simulating a failed initial flush #1) with no held input in b.inbox.
    const s1 = host.agentOf('s1')
    s1.followup(createUserMessage({
      content: [{ type: 'text', text: '[Handoff · part 2]\nCarried context' }],
      source: { kind: SOURCE_KIND, form: 'handoff', handoff: true },
    }))
    const followupsBefore = s1.calls.filter(([kind]) => kind === 'followup').length

    // First retry fails flush on s1: must NOT clear handoffPending or archive old part b!
    await host.rt.heldBack()
    assert.equal(s1Flushes, 1, 'retry must attempt ctx.sessions.flush(fresh.session) even when handoff is in fresh.inbox')
    assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending stays persisted while flush fails')
    assert.deepEqual(host.archived, [], 'old part must not be archived before handoff flush succeeds')
    assert.equal(s1.calls.filter(([kind]) => kind === 'followup').length, followupsBefore, 'retry must not duplicate the handoff message')

    // Second retry succeeds flush on s1: clears handoffPending, archives old part b, still no duplicate handoff.
    await host.rt.heldBack()
    assert.equal(s1Flushes, 2, 'second retry flushes fresh.session to confirm durability')
    assert.equal(s1.calls.filter(([kind]) => kind === 'followup').length, followupsBefore, 'still no duplicate handoff message')
    assert.deepEqual(host.archived, [['b', { stopActivity: true }]], 'old part archived only after flush succeeds')
    assert.deepEqual(host.state().switching, {}, 'switching marker cleared only after flush succeeds')
  }

  // 2) Handoff already claimed into fresh.session.deriveMessages() while handoffPending is still true.
  {
    let s1Flushes = 0
    let failOnce = true
    const host = makeSwitchFixture({
      fail: {
        onFlush: (session) => {
          if (session.id !== 's1') return
          s1Flushes += 1
          if (failOnce) {
            failOnce = false
            throw new Error('transient s1 log flush failure')
          }
        },
      },
    })
    t.after(host.stop)
    await host.rt.load()

    const bot = host.rt.state.bots.b
    bot.sessionId = 's1'
    bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
    host.rt.chatOwners.set('s1', 'b')
    host.rt.state.switching = {
      b: {
        botId: 'b',
        handoffPending: true,
        handoffMeta: {
          resume: true,
          info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-claimed-handoff', senderName: 'Chief' },
        },
      },
    }
    await host.rt.save()

    const s1 = host.agentOf('s1')
    s1.session.deriveMessages = () => [{
      role: 'user',
      content: [{ type: 'text', text: '[Handoff · part 2]\nClaimed but unflushed' }],
      source: { kind: SOURCE_KIND, form: 'handoff', handoff: true, exchangeId: 'ex-claimed-handoff' },
    }]

    await host.rt.heldBack()
    assert.equal(s1Flushes, 1, 'retry must flush fresh.session when handoff is in deriveMessages()')
    assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending stays set when flush fails')
    assert.deepEqual(host.archived, [])

    await host.rt.heldBack()
    assert.equal(s1Flushes, 2)
    assert.equal(s1.calls.filter(([kind]) => kind === 'followup').length, 0, 'must not inject duplicate handoff')
    assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
    assert.deepEqual(host.state().switching, {})
  }

  // 3) Handoff already claimed out of fresh.inbox during preStep (logged as agent/inbox/spliced
  // removal before user/message is written) while handoffPending is still true:
  // recovery MUST defer (neither duplicate nor clear handoffPending) until user/message lands.
  {
    let s1Flushes = 0
    let failOnce = true
    const host = makeSwitchFixture({
      fail: {
        onFlush: (session) => {
          if (session.id !== 's1') return
          s1Flushes += 1
          if (failOnce) {
            failOnce = false
            throw new Error('transient s1 claimed-window flush failure')
          }
        },
      },
    })
    t.after(host.stop)
    await host.rt.load()

    const bot = host.rt.state.bots.b
    bot.sessionId = 's1'
    bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 1_000 }]
    host.rt.chatOwners.set('s1', 'b')
    host.rt.state.switching = {
      b: {
        botId: 'b',
        handoffPending: true,
        handoffMeta: {
          resume: true,
          info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'ex-inflight-claim', senderName: 'Chief' },
        },
      },
    }
    await host.rt.save()

    const s1 = host.agentOf('s1')
    const claimedHandoff = createUserMessage({
      content: [{ type: 'text', text: '[Handoff · part 2]\nIn-flight claim window' }],
      source: { kind: SOURCE_KIND, form: 'handoff', handoff: true, exchangeId: 'ex-inflight-claim' },
    })
    const events = [
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [claimedHandoff] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    ]
    s1.session.snapshotEvents = () => events

    // While only the claim exists (no user/message yet), heldBack MUST defer:
    // keep handoffPending=true, do not archive old part, do not inject a duplicate.
    await host.rt.heldBack()
    assert.equal(s1Flushes, 0, 'in-flight claim defers without treating removal flush as durable delivery')
    assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending must stay set while handoff is only claimed')
    assert.equal(s1.calls.filter(([kind]) => kind === 'followup').length, 0, 'must not inject duplicate handoff during preStep claim window')
    assert.deepEqual(host.archived, [], 'old part must stay unarchived while handoff is only claimed')

    // Once user/message lands, retry #1 (flush fails) still keeps handoffPending=true.
    events.push({ type: 'user/message', data: { message: claimedHandoff } })
    await host.rt.heldBack()
    assert.equal(s1Flushes, 1, 'retry after user/message lands must flush fresh.session')
    assert.equal(host.state().switching.b?.handoffPending, true)
    assert.deepEqual(host.archived, [])

    // Retry #2 (flush succeeds): clears handoffPending and archives old part with zero duplicates.
    await host.rt.heldBack()
    assert.equal(s1Flushes, 2)
    assert.equal(s1.calls.filter(([kind]) => kind === 'followup').length, 0, 'must not inject duplicate handoff')
    assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
    assert.deepEqual(host.state().switching, {})
  }
})

test('real DSH JSONL persistence flushes buffered handoff out of drainPaused on retry before clearing handoffPending and archiving old part', async (t) => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsb-pr1-jsonl-')))
  const home = join(rootDir, 'home')
  const sessionsDir = join(rootDir, 'sessions')
  mkdirSync(home, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })

  const root = new Context()
  await root.plugin(JsonlPersistence, { root: sessionsDir, compression: 'none' })
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  await root.plugin(BasicCompactionEngine)

  class MinimalAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'mock' } }
    async listModels() { return [{ id: 'm', name: 'm', inputModalities: ['text'] }] }
    async resolveModel(provider, id) {
      return {
        provider,
        id,
        name: id,
        inputModalities: ['text'],
        context: { contextWindow: 50_000 },
        defaultMaxTokens: 4_000,
      }
    }
    async *stream(req) {
      const text = req.purpose === 'compaction'
        ? (req.system?.includes('context steward')
          ? JSON.stringify({ action: 'switch', reason: 'move on' })
          : validNote('jsonl-handoff-marker'))
        : 'reply ok'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 35_000, outputTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  root.llm.registerAdapter(['mock'], new MinimalAdapter())
  await mountAgentLoopTestHarness(root)
  const { agents, sessionPersistence } = await new Promise(resolve => root.inject(['agents', 'sessionPersistence'], resolve))

  // Inject real persistence write failures inside JsonlSessionHandle.persistContiguous for part-1's
  // handoff batch so JsonlSessionHandle enters genuine `drainPaused = true` and retains buffered events
  // without background 200ms auto-drain until explicit sessions.flush() succeeds.
  let handoffPersistAttempts = 0
  let failHandoffPersists = 2
  let part1Handle
  const origCreate = sessionPersistence.create.bind(sessionPersistence)
  sessionPersistence.create = async (header, options) => {
    const handle = await origCreate(header, options)
    if (header?.id === 'part-1') {
      part1Handle = handle
      const origPersist = handle.persistContiguous.bind(handle)
      handle.persistContiguous = async (batch) => {
        const hasHandoff = Array.isArray(batch) && batch.some(ev =>
          ev.type === 'agent/inbox/spliced'
          && Array.isArray(ev.data?.inserted)
          && ev.data.inserted.some(m => m?.source?.handoff === true))
        if (hasHandoff) {
          handoffPersistAttempts += 1
          if (failHandoffPersists > 0) {
            failHandoffPersists -= 1
            throw new Error('simulated JSONL disk write failure')
          }
        }
        return origPersist(batch)
      }
    }
    return handle
  }

  const readDiskHandoffInserts = async () => {
    const readHandle = await sessionPersistence.open('part-1', 'read')
    try {
      const { events } = await readHandle.read()
      return events.filter(ev =>
        ev.type === 'agent/inbox/spliced'
        && Array.isArray(ev.data?.inserted)
        && ev.data.inserted.some(m => m?.source?.handoff === true))
    } finally {
      await readHandle.close()
    }
  }

  const archived = []
  let partCounter = 0
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
        agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000 },
        meta: { cwd: cwd ?? home },
      })
      return { sessionId: id, agent: created.agent }
    },
  })
  await new Promise(resolve => root.inject(['sessionTitle', 'workspaceRegistry', 'connection', 'sessionController'], resolve))

  t.after(async () => {
    await root.fiber.dispose()
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

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

  const rt = createRuntime(root, { home, checkRatio: 0.4, scheduleAttachWaitMs: 0 })
  await rt.load()
  const { agent: oldAgent } = await agents.create({
    sessionId: 'm1',
    agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000 },
    meta: { cwd: home },
  })

  // Run one idle turn above check line so DS Bot switches m1 -> part-1 with zero held input.
  const turnDone = new Promise((resolve) => {
    const off = root.on('agent/status', ({ agent: a, status }) => {
      if (a.id === 'm1' && status === 'idle') { off(); resolve() }
    })
  })
  oldAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare release notes' }], source: { kind: 'user' } }))
  await turnDone

  // Wait for pointer flip m1 -> part-1, real persistContiguous failure #1, runSwitch cleanup,
  // and part-1 finishing its quick idle turn (so user/message is logged in memory, unflushed).
  assert.equal(await waitFor(() => rt.chatOf('m1') === 'part-1' && handoffPersistAttempts === 1 && !rt.isSwitchingPart('m1') && agents.get('part-1')?.status === 'idle', 5_000), true, 'switch must create part-1 and fail initial JSONL persist')
  assert.equal(part1Handle?.drainPaused, true, 'real JsonlSessionHandle must enter drainPaused=true after persistContiguous fails')
  assert.equal(rt.state.switching.m1?.handoffPending, true, 'handoffPending must remain set after initial JSONL flush failure')
  assert.deepEqual(archived, [], 'old part must not be archived after failed handoff flush')
  assert.equal((await readDiskHandoffInserts()).length, 0, 'disk JSONL must have 0 handoff events while drainPaused after failure #1')

  // Retry #1 (persist attempt #2 also fails): ensureHandoffDelivered MUST invoke sessions.flush(part-1)
  // rather than returning early because the handoff is already in part-1's memory.
  await rt.heldBack()
  assert.equal(handoffPersistAttempts, 2, 'heldBack retry #1 must drive drainBuffered/persistContiguous on part-1')
  assert.equal(part1Handle?.drainPaused, true, 'JsonlSessionHandle stays drainPaused=true after retry #1 fails')
  assert.equal(rt.state.switching.m1?.handoffPending, true, 'handoffPending must remain set while retry flush fails')
  assert.deepEqual(archived, [], 'old part must remain unarchived while retry flush fails')
  assert.equal((await readDiskHandoffInserts()).length, 0, 'disk JSONL must still have 0 handoff events after retry #1 fails')

  // Retry #2 (persist attempt #3 succeeds): drains buffered handoff out of drainPaused to disk,
  // clears handoffPending, archives old part, and persists exactly one handoff in the JSONL file.
  await rt.heldBack()
  assert.equal(handoffPersistAttempts, 3, 'heldBack retry #2 must flush buffered handoff to real JSONL storage')
  assert.equal(part1Handle?.drainPaused, false, 'JsonlSessionHandle leaves drainPaused after durable flush')
  assert.deepEqual(rt.state.switching, {}, 'switching marker cleared after durable JSONL flush')
  assert.deepEqual(archived, ['m1'], 'old part archived after durable JSONL flush')
  assert.equal((await readDiskHandoffInserts()).length, 1, 'real JSONL file on disk must durably persist exactly one handoff message')
})

test('real DSH agent-loop paused after inbox.claim() keeps handoffPending set until user/message is durably flushed', async (t) => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsb-pr1-claim-')))
  const home = join(rootDir, 'home')
  const sessionsDir = join(rootDir, 'sessions')
  mkdirSync(home, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })

  const root = new Context()
  await root.plugin(JsonlPersistence, { root: sessionsDir, compression: 'none' })
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  await root.plugin(BasicCompactionEngine)

  class MinimalAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'mock' } }
    async listModels() { return [{ id: 'm', name: 'm', inputModalities: ['text'] }] }
    async resolveModel(provider, id) {
      return {
        provider,
        id,
        name: id,
        inputModalities: ['text'],
        context: { contextWindow: 50_000 },
        defaultMaxTokens: 4_000,
      }
    }
    async *stream(req) {
      const text = req.purpose === 'compaction'
        ? (req.system?.includes('context steward')
          ? JSON.stringify({ action: 'switch', reason: 'move on' })
          : validNote('claim-window-marker'))
        : 'reply ok'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 35_000, outputTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  root.llm.registerAdapter(['mock'], new MinimalAdapter())
  await mountAgentLoopTestHarness(root)
  const { agents, sessionPersistence } = await new Promise(resolve => root.inject(['agents', 'sessionPersistence'], resolve))

  // Pause part-1 right inside real ReactLoopAgent preStep (AFTER inbox.claim() removes the
  // handoff from part-1.inbox and BEFORE step() appends user/message).
  let pausedAtPreStepResolve
  const pausedAtPreStep = new Promise(resolve => { pausedAtPreStepResolve = resolve })
  let releasePreStep
  const preStepGate = new Promise(resolve => { releasePreStep = resolve })
  let preStepPausedOnce = false
  root.on('agent/pre-step', async (payload, next) => {
    if (payload.agent?.id === 'part-1' && !preStepPausedOnce) {
      preStepPausedOnce = true
      pausedAtPreStepResolve()
      await preStepGate
    }
    return next()
  })

  // Block initial handoff persist while part-1 is still paused in preStep so handoffPending
  // stays set regardless of whether runSwitch's flush races ahead of or behind inbox.claim().
  let allowHandoffPersist = false
  const origCreate = sessionPersistence.create.bind(sessionPersistence)
  sessionPersistence.create = async (header, options) => {
    const handle = await origCreate(header, options)
    if (header?.id === 'part-1') {
      const origPersist = handle.persistContiguous.bind(handle)
      handle.persistContiguous = async (batch) => {
        const hasHandoff = Array.isArray(batch) && batch.some(ev =>
          ev.type === 'agent/inbox/spliced'
          && Array.isArray(ev.data?.inserted)
          && ev.data.inserted.some(m => m?.source?.handoff === true))
        if (hasHandoff && !allowHandoffPersist) {
          throw new Error('simulated initial handoff flush failure')
        }
        return origPersist(batch)
      }
    }
    return handle
  }

  const archived = []
  let partCounter = 0
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
        agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000 },
        meta: { cwd: cwd ?? home },
      })
      return { sessionId: id, agent: created.agent }
    },
  })
  await new Promise(resolve => root.inject(['sessionTitle', 'workspaceRegistry', 'connection', 'sessionController'], resolve))

  t.after(async () => {
    releasePreStep()
    await root.fiber.dispose()
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

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

  const rt = createRuntime(root, { home, checkRatio: 0.4, scheduleAttachWaitMs: 0 })
  await rt.load()
  const { agent: oldAgent } = await agents.create({
    sessionId: 'm1',
    agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000 },
    meta: { cwd: home },
  })

  const turnDone = new Promise((resolve) => {
    const off = root.on('agent/status', ({ agent: a, status }) => {
      if (a.id === 'm1' && status === 'idle') { off(); resolve() }
    })
  })
  oldAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Trigger switch into paused preStep' }], source: { kind: 'user' } }))
  await turnDone

  // Wait until part-1 has claimed the handoff and paused in preStep (before user/message) and runSwitch settled.
  await pausedAtPreStep
  assert.equal(await waitFor(() => !rt.isSwitchingPart('m1'), 5_000), true)

  const part1 = agents.get('part-1')
  assert.equal(part1.inbox.nextTurn.length, 0, 'real DSH preStep already claimed handoff out of part-1.inbox')
  assert.equal(part1.session.snapshotEvents().some(ev => ev.type === 'user/message' && (ev.data?.source ?? ev.data?.message?.source)?.handoff === true), false, 'user/message is not logged yet while paused in preStep')
  assert.equal(rt.state.switching.m1?.handoffPending, true, 'handoffPending must remain set after initial flush failure')

  // Recovery runs while part-1 is paused after claim and before user/message:
  // MUST defer — keep handoffPending=true, keep m1 unarchived, and never duplicate handoff!
  await rt.heldBack()
  assert.equal(rt.state.switching.m1?.handoffPending, true, 'handoffPending must stay set while handoff is claimed but not logged as user/message')
  assert.deepEqual(archived, [], 'old part must not be archived before handoff user/message is durable')
  assert.equal(part1.inbox.nextTurn.length, 0, 'recovery must not inject a duplicate handoff during preStep claim window')

  // Release preStep and allow disk persistence so the real agent-loop appends user/message and finishes the turn.
  allowHandoffPersist = true
  const part1Idle = new Promise((resolve) => {
    const off = root.on('agent/status', ({ agent: a, status }) => {
      if (a.id === 'part-1' && status === 'idle') { off(); resolve() }
    })
  })
  releasePreStep()
  await part1Idle

  // Now retry heldBack(): flushes durable user/message to disk, clears handoffPending, archives m1.
  await rt.heldBack()
  assert.deepEqual(rt.state.switching, {}, 'switching marker cleared once user/message is durably flushed')
  assert.deepEqual(archived, ['m1'], 'old part archived once user/message is durably flushed')

  const readHandle = await sessionPersistence.open('part-1', 'read')
  try {
    const { events } = await readHandle.read()
    const handoffUserMsgs = events.filter(ev => ev.type === 'user/message' && (ev.data?.source ?? ev.data?.message?.source)?.handoff === true)
    const handoffInserts = events.filter(ev => ev.type === 'agent/inbox/spliced' && Array.isArray(ev.data?.inserted) && ev.data.inserted.some(m => m?.source?.handoff === true))
    assert.equal(handoffUserMsgs.length, 1, 'real JSONL file on disk durably stores exactly one handoff user/message')
    assert.equal(handoffInserts.length, 1, 'real JSONL file on disk records exactly one handoff insert (no duplicate)')
  } finally {
    await readHandle.close()
  }
})

test('immediate handoff claim during moveOn still forwards parked prompts ahead of newer prompts and preserves IM origin across deferred recovery', async (t) => {
  // 1) Immediate handoff claim on fresh part: moveOn keeps handoffPending=true and skips archive,
  //    yet forwards parked prompts immediately so a newer prompt sent directly to fresh cannot overtake them.
  {
    const host = makeSwitchFixture()
    t.after(host.stop)
    await host.rt.load()

    const s1 = host.agentOf('s1')
    const s1Events = []
    s1.session.snapshotEvents = () => s1Events
    const origFollowup = s1.followup.bind(s1)
    s1.followup = (msg) => {
      origFollowup(msg)
      s1Events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [msg] } })
      if (msg?.source?.handoff === true) {
        // Simulate immediate inbox.claim() before confirmHandoffFlushed runs (no user/message yet).
        s1.inbox.remove(msg.id)
        s1Events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      }
    }

    const parked = createUserMessage({
      id: 'm-parked-first',
      content: [{ type: 'text', text: 'Read the release checklist' }],
      source: { kind: 'user', exchangeId: 'ex-parked-first' },
    })
    host.agentOf('b').status = 'running'
    await host.preStep('b', [parked], 2)
    assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1' && !host.rt.isSwitchingPart('b')), true)

    // handoffPending stays true and old part b is NOT archived while handoff is only claimed.
    assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending must stay set after immediate handoff claim')
    assert.deepEqual(host.archived, [], 'old part must stay unarchived until handoff user/message is durable')

    // A newer prompt arrives directly on s1 BEFORE heldBack() runs: parked prompt MUST already sit ahead of it!
    s1.followup(createUserMessage({
      id: 'm-newer-second',
      content: [{ type: 'text', text: 'Summarize what you found' }],
      source: { kind: 'user', exchangeId: 'ex-newer-second' },
    }))
    const queuedTexts = s1.inbox.nextTurn.map(m => m.content?.[0]?.text ?? '')
    assert.deepEqual(queuedTexts, ['Read the release checklist', 'Summarize what you found'], 'parked prompt must precede newer prompt sent directly to successor')

    // Once handoff user/message lands, heldBack() flushes it, clears handoffPending, and archives b.
    s1Events.push({ type: 'user/message', data: { message: s1Events[0].data.inserted[0] } })
    await host.rt.heldBack()
    assert.deepEqual(host.state().switching, {})
    assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  }

  // 2) Deferred recovery after initial flush failure preserves one-use IM origin token instead of dropping it in finally.
  {
    let failS1Once = true
    const host = makeSwitchFixture({
      fail: {
        onFlush: (session) => {
          if (session.id === 's1' && failS1Once) {
            failS1Once = false
            throw new Error('transient flush error before unread replay')
          }
        },
      },
    })
    t.after(host.stop)
    await host.rt.load()

    const droppedOrigins = []
    host.rt.holdImOrigin = () => 'im-origin-tok-42'
    host.rt.dropImOrigin = (tok) => { if (tok !== undefined) droppedOrigins.push(tok) }

    const bAgent = host.agentOf('b')
    bAgent.session.deriveMessages = () => [
      {
        id: 'u-im-1',
        role: 'user',
        content: [{ type: 'text', text: 'Answer me over IM' }],
        source: { kind: 'user', exchangeId: 'ex-im-1' },
      },
    ]
    host.rt.state.localAgents = { sessions: { b: { handedId: 'earlier-0' } } }
    const reqErrListeners = host.ctx.listeners.get('agent/request-error') ?? []
    const payload = { agent: bAgent, failure: { code: 'LOCAL_AGENT_SESSION_LOST', message: 'session lost' } }
    const dispatch = i => (i < reqErrListeners.length ? reqErrListeners[i](payload, () => dispatch(i + 1)) : Promise.resolve(undefined))
    await dispatch(0)

    assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1' && !host.rt.isSwitchingPart('b')), true)
    assert.equal(host.state().switching.b?.handoffPending, true)
    assert.equal(host.state().switching.b?.runtimeLostContext?.resumeOrigin, 'im-origin-tok-42')
    assert.deepEqual(droppedOrigins, [], 'switch finalizer must not drop IM origin token retained for deferred recovery')

    // Retry succeeds: forwarded unread request carries the intact IM origin token!
    await host.rt.heldBack()
    const s1 = host.agentOf('s1')
    const forwardedUnread = s1.calls
      .filter(([kind, m]) => kind === 'followup' && m?.source?.handoff !== true)
      .map(([, m]) => m)
    assert.equal(forwardedUnread.length, 1, 'deferred recovery forwards unread IM request once')
    assert.equal(forwardedUnread[0].source?.imOrigin, 'im-origin-tok-42', 'forwarded unread request preserves intact IM origin token')
    assert.deepEqual(droppedOrigins, [], 'IM origin token was consumed by replay, never dropped')
    assert.deepEqual(host.state().switching, {})
  }

  // 3) Unconfirmed handoff (immediate claim) keeps runtimeLost replay metadata intact so a clean
  //    shutdown that cancels the successor's queued unread request still replays prompt + attachment once on restart.
  {
    const host = makeSwitchFixture()
    await host.rt.load()

    const bAgent = host.agentOf('b')
    bAgent.session.deriveMessages = () => [
      {
        id: 'u-cli-photo-1',
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot' },
          { type: 'image', attachment: { attachmentId: 'att-shot-9', mimeType: 'image/png' } },
        ],
        source: { kind: 'user', exchangeId: 'ex-cli-photo-1' },
      },
    ]
    const s1 = host.agentOf('s1')
    const s1Events = []
    s1.session.snapshotEvents = () => s1Events
    const origFollowup = s1.followup.bind(s1)
    s1.followup = (msg) => {
      origFollowup(msg)
      s1Events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [msg] } })
      if (msg?.source?.handoff === true) {
        s1.inbox.remove(msg.id)
        s1Events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      }
    }

    host.rt.state.localAgents = { sessions: { b: { handedId: 'earlier-0' } } }
    const reqErrListeners = host.ctx.listeners.get('agent/request-error') ?? []
    const payload = { agent: bAgent, failure: { code: 'LOCAL_AGENT_SESSION_LOST', message: 'session lost' } }
    const dispatch = i => (i < reqErrListeners.length ? reqErrListeners[i](payload, () => dispatch(i + 1)) : Promise.resolve(undefined))
    await dispatch(0)

    assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1' && !host.rt.isSwitchingPart('b')), true)
    assert.equal(host.state().switching.b?.handoffPending, true)
    assert.equal(host.state().switching.b?.runtimeLost, true, 'runtimeLost replay metadata must stay persisted while handoff is unconfirmed')
    await host.stop({ keep: true })

    // Simulate clean shutdown canceling s1's queued unread request before s1 logged user/message,
    // while s1's handoff finished logging user/message.
    const inboxFile = join(host.home, 'fake-inbox.json')
    const onDisk = JSON.parse(readFileSync(inboxFile, 'utf8'))
    onDisk.s1 = { nextStep: [], nextTurn: [] }
    writeFileSync(inboxFile, JSON.stringify(onDisk))

    const second = makeSwitchFixture({ home: host.home })
    t.after(second.stop)
    await second.rt.load()
    second.agentOf('b').session.deriveMessages = () => [
      {
        id: 'u-cli-photo-1',
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot' },
          { type: 'image', attachment: { attachmentId: 'att-shot-9', mimeType: 'image/png' } },
        ],
        source: { kind: 'user', exchangeId: 'ex-cli-photo-1' },
      },
    ]
    const handoffMsg = s1Events[0].data.inserted[0]
    const queuedUnread = s1Events.find(ev => ev.type === 'agent/inbox/spliced' && ev.data.inserted?.[0]?.source?.handoff !== true)?.data.inserted[0]
    second.agentOf('s1').session.snapshotEvents = () => [
      { type: 'user/message', data: { message: handoffMsg } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [queuedUnread] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
    ]

    await second.rt.heldBack()
    const replayed = second.agentOf('s1').calls
      .filter(([kind, m]) => kind === 'followup' && m?.source?.handoff !== true)
      .map(([, m]) => m)
    assert.equal(replayed.length, 1, 'restart recovery must replay canceled unread local-agent request once')
    assert.equal(replayed[0].content[0].text, 'Inspect this screenshot')
    assert.equal(replayed[0].content[1].attachment.attachmentId, 'att-shot-9')
    assert.deepEqual(second.state().switching, {})
    assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  }
})
