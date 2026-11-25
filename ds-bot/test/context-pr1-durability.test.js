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
  assert.equal(await waitFor(() => bAgent.calls.some(([kind, m]) => kind === 'followup' && (m.content?.[0]?.text ?? '').includes('DS Bot paused your turn'))), true, 'PAUSE_NOTE must not be dropped as a duplicate of the logged ex-42 request')

  const pauseMsg = bAgent.calls.find(([kind, m]) => kind === 'followup' && (m.content?.[0]?.text ?? '').includes('DS Bot paused your turn'))[1]
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

  const inflight = JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8'))
  const journalEntry = inflight.queued?.b?.find(item => item.args?.exchangeId === 'ex-dup-restart')
  assert.equal(journalEntry?.args?.transferId, stableTransferId, 'inflight journal persists the exact same transferId')

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

test('merging a successor unread request before retrying a failed forward flush preserves transferId and prevents duplicate delivery', async (t) => {
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
  const origExchangeId = original.source?.exchangeId
  assert.ok(typeof origTransferId === 'string' && origTransferId.length > 0, 'original request carries transferId')

  // Simulate pointer flip b -> s1 and a forward that queues on s1 before its flush fails,
  // leaving the original in b.inbox and state.switching.b pending for retry.
  const bot = host.rt.state.bots.b
  bot.sessionId = 's1'
  bot.parts = [{ sessionId: 'b', at: Date.now() - 1_000, reason: 'full' }, { sessionId: 's1', at: Date.now() }]
  host.rt.state.switching = { b: { botId: 'b', next: 's1' } }
  await host.rt.save()

  failForwardFlush = true
  await host.rt.heldBack()
  const s1Agent = host.agentOf('s1')
  assert.equal(s1Agent.inbox.nextTurn.length, 1, 's1 received forwarded copy before flush failed')
  assert.equal(bAgent.inbox.nextTurn.length, 1, 'old part retained original after flush failure')
  assert.ok(host.rt.state.switching.b !== undefined, 'switching marker kept for retry')

  // Before retry runs, Chief delegates "check invoice B", merging into s1's unread copy.
  await delegateTool.execute({ to: 'Writer', goal: 'check invoice B', when: 'queue' }, { agent: { id: 'a' } })
  const mergedOnS1 = [...s1Agent.inbox.nextStep, ...s1Agent.inbox.nextTurn]
  assert.equal(mergedOnS1.length, 1, 'merged replacement replaced unread copy on s1')
  assert.equal(mergedOnS1[0].source?.exchangeId, origExchangeId, 'merged request keeps original exchangeId')
  assert.equal(mergedOnS1[0].source?.transferId, origTransferId, 'merged request preserves original transferId')
  assert.match(mergedOnS1[0].content[0].text, /check invoice A/)
  assert.match(mergedOnS1[0].content[0].text, /check invoice B/)

  // Also test when s1 has ALREADY claimed & logged the merged request before heldBack retries.
  const loggedMerged = mergedOnS1[0]
  s1Agent.inbox.nextTurn.splice(0)
  s1Agent.inbox.nextStep.splice(0)
  s1Agent.session.snapshotEvents = () => [
    { type: 'user/message', data: { id: loggedMerged.id, source: loggedMerged.source, content: loggedMerged.content } },
  ]
  const followupsBefore = s1Agent.calls.filter(([kind]) => kind === 'followup').length

  await host.rt.heldBack()

  assert.equal(s1Agent.calls.filter(([kind]) => kind === 'followup').length, followupsBefore, 'heldBack retry must not re-queue the superseded original beside the merged request')
  assert.equal(bAgent.inbox.nextTurn.length, 0, 'old part inbox cleared after retry')
  assert.equal(host.rt.state.switching.b, undefined, 'switching marker cleared after retry')
})

test('three-part recovery delivers the newest merged request once and never overwrites it with an older retained original', async (t) => {
  let failFlushOn
  const host = makeSwitchFixture({
    fail: {
      onFlush: (session) => {
        if (failFlushOn === session.id) {
          failFlushOn = undefined
          throw new Error(`transient flush error on ${session.id}`)
        }
      },
    },
  })
  t.after(host.stop)
  await host.rt.load()

  const delegateTool = host.rt.teamTools.find(d => d.name === 'delegate_work')
  assert.ok(delegateTool, 'delegate_work tool registered')

  // 1) Part 1 ('b') receives "check invoice A".
  await delegateTool.execute({ to: 'Writer', goal: 'check invoice A', when: 'queue' }, { agent: { id: 'a' } })
  const p1 = host.agentOf('b')
  const orig = p1.inbox.nextTurn.find(m => (m.content?.[0]?.text ?? '').includes('check invoice A'))
  assert.ok(orig, 'part 1 holds original invoice A request')

  // 2) Switch 1 (b -> s1) forwards to s1, then flush on s1 fails, leaving b in state.switching.
  const bot = host.rt.state.bots.b
  bot.sessionId = 's1'
  bot.segments = [{ sessionId: 'b', endedAt: Date.now() - 2_000 }]
  host.rt.chatOwners.set('s1', 'b')
  host.rt.state.switching = { b: { botId: 'b' } }
  await host.rt.save()

  failFlushOn = 's1'
  await host.rt.heldBack()
  const p2 = host.agentOf('s1')
  assert.equal(p1.inbox.nextTurn.length, 1, 'part 1 retains original invoice A')
  assert.equal(p2.inbox.nextTurn.length, 1, 'part 2 has forwarded copy of invoice A')

  // 3) Sender delegates "check invoice B", merging into part 2's unread copy under the same transferId.
  await delegateTool.execute({ to: 'Writer', goal: 'check invoice B', when: 'queue' }, { agent: { id: 'a' } })
  const mergedOnP2 = [...p2.inbox.nextStep, ...p2.inbox.nextTurn]
  assert.equal(mergedOnP2.length, 1, 'part 2 holds single merged request')
  assert.equal(mergedOnP2[0].source?.transferId, orig.source?.transferId, 'merged request keeps original transferId')

  // 4) Switch 2 (s1 -> s2) flips pointer to s2, then its handoff flush fails before forwarding p2's merged copy.
  // Both b (older) and s1 (newer, with handoffPending) remain in state.switching!
  bot.sessionId = 's2'
  bot.segments = [
    { sessionId: 'b', endedAt: Date.now() - 2_000 },
    { sessionId: 's1', endedAt: Date.now() - 1_000 },
  ]
  host.rt.chatOwners.set('s2', 'b')
  host.rt.state.switching = {
    b: { botId: 'b' },
    s1: { botId: 'b', handoffPending: true, handoffMeta: { folder: true } },
  }
  await host.rt.save()

  // 5) Recovery runs: must deliver part 2's handoff + the merged body ("invoice A" + "invoice B") ONCE on s2,
  // and never forward part 1's stale original ahead of it.
  await host.rt.heldBack()

  const p3 = host.agentOf('s2')
  const followups = p3.calls.filter(([kind]) => kind === 'followup').map(([, m]) => m)
  assert.equal(followups.length, 2, 'part 3 receives handoff followed by exactly one merged request')
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

test('same-part rollback after failed create keeps PAUSE_NOTE and claimed input ahead of messages queued during the switch', async (t) => {
  const host = makeSwitchFixture({
    fail: {
      onCreate: async () => {
        // Simulate a newer user message arriving while create() awaits before failing.
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

  assert.equal(await waitFor(() => bAgent.inbox.nextTurn.length === 3 && !host.rt.isSwitchingPart('b')), true)
  const queuedTexts = bAgent.inbox.nextTurn.map(m => m.content?.[0]?.text ?? '')
  assert.match(queuedTexts[0], /DS Bot paused your turn/, 'PAUSE_NOTE must be first')
  assert.equal(queuedTexts[1], 'earlier claimed input', 'claimed input must precede messages queued during switch')
  assert.equal(queuedTexts[2], 'later follow-up', 'later message stays behind rolled-back turn input')
})
