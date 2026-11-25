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
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
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
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr1-ctx-'))
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
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, seq: 0, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: () => () => {} } },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]); nextTurn.push(message); persist(agents) },
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
      flush: async () => {
        flushes += 1
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
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, root, archived, agentOf, preStep, state, fail, stop }
}

test('B18: crash between pointer flip and handoff flush #1 recovers missing handoff package on restart via handoffPending', async (t) => {
  // Flush #1 fails right after rt.save() flipped bot.sessionId to s1.
  const fail = { flush: 1 }
  const host = makeSwitchFixture({ fail })
  await host.rt.load()
  const msg = { id: 'm-b18', role: 'user', content: [{ type: 'text', text: 'important task' }], source: { kind: 'user', exchangeId: 'ex-b18' } }
  host.agentOf('b').status = 'running'
  await host.preStep('b', [msg], 2)
  assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1'), true)
  await new Promise(resolve => setTimeout(resolve, 40))

  // Pointer flipped to s1, handoffPending remained true in state.switching!
  assert.equal(host.state().switching.b?.handoffPending, true, 'handoffPending must stay persisted when flush #1 fails')
  // Simulate crash where s1 lost its unflushed handoff message on disk before flush #1 completed.
  const inboxFile = join(host.home, 'fake-inbox.json')
  const onDisk = JSON.parse(readFileSync(inboxFile, 'utf8'))
  onDisk.s1 = { nextStep: [], nextTurn: [] }
  writeFileSync(inboxFile, JSON.stringify(onDisk))
  await host.stop({ keep: true })

  // Restart and run heldBack(): must reconstruct & deliver [Handoff · part 2] BEFORE held user input.
  const second = makeSwitchFixture({ home: host.home })
  t.after(second.stop)
  await second.rt.load()
  await second.rt.heldBack()

  const followups = second.agentOf('s1').calls.filter(([kind]) => kind === 'followup').map(([, m]) => m)
  assert.ok(followups.length >= 2, 'must deliver reconstructed handoff AND held user message')
  assert.equal(followups[0].source?.handoff, true, 'first message on s1 must be reconstructed handoff package')
  assert.match(followups[0].content[0].text, /^\[Handoff · part 2\]/)
  assert.equal(followups[1].content[0].text, 'important task', 'held user message must follow handoff')
  assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(second.state().switching, {})
})

test('B19: claimed mid-turn step messages are durably parked in old inbox immediately while switch awaits creation', async (t) => {
  let releaseCreate
  const createPaused = new Promise(resolve => { releaseCreate = resolve })
  let atCreateResolve
  const atCreate = new Promise(resolve => { atCreateResolve = resolve })
  const host = makeSwitchFixture({
    fail: {
      onCreate: async () => {
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

  // While moveOn is still paused in create(), claimed message is ALREADY persisted on disk in old inbox!
  const persistedInbox = JSON.parse(readFileSync(join(host.home, 'fake-inbox.json'), 'utf8'))
  const texts = (persistedInbox.b?.nextTurn ?? []).map(m => m.content?.[0]?.text)
  assert.deepEqual(texts, ['do not drop me mid-switch'], 'claimed input must be durable in old inbox before switch completes')

  releaseCreate()
  assert.equal(await waitFor(() => host.state().bots.b.sessionId === 's1' && Object.keys(host.state().switching).length === 0), true)
  const userDeliveries = host.agentOf('s1').calls.filter(([kind, m]) => kind === 'followup' && m.content?.[0]?.text === 'do not drop me mid-switch')
  assert.equal(userDeliveries.length, 1, 'durably parked message must be forwarded exactly once')
})

test('B20: failed post-move forward retries automatically via backoff without waiting for restart', async (t) => {
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

  // Flush #1 (handoff) succeeds; Flush #2 (held user message) fails transiently.
  const fail = { flush: 2 }
  const host = makeSwitchFixture({ fail })
  t.after(host.stop)
  await host.rt.load()

  const msg = { id: 'm-b20', role: 'user', content: [{ type: 'text', text: 'retry me automatically' }], source: { kind: 'user', exchangeId: 'ex-b20' } }
  host.agentOf('b').status = 'running'
  await host.preStep('b', [msg], 2)

  assert.equal(await waitReal(() => host.state().bots.b.sessionId === 's1' && host.state().switching.b !== undefined), true)
  assert.deepEqual(host.archived, [], 'old part stays unarchived after transient flush #2 error')

  // Clear transient error and advance timer 5s: backoff retry runs heldBack() automatically!
  fail.flush = false
  t.mock.timers.tick(5_000)

  assert.equal(await waitReal(() => host.archived.some(([id]) => id === 'b') && Object.keys(host.state().switching).length === 0), true, 'automatic backoff retry must forward held input and archive old part without restart')
  assert.ok(host.agentOf('s1').calls.some(([kind, m]) => kind === 'followup' && m.content?.[0]?.text === 'retry me automatically'))
})
