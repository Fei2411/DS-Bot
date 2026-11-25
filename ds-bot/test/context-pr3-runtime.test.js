import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { capabilitiesForKind } from '../src/host/context-runtime.js'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { fakeContext } from './fake-ctx.js'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')
const FAKE_ACP = join(FIXTURES, 'fake-acp.mjs')
const FAKE_CODEX = join(FIXTURES, 'fake-codex.mjs')
const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs')

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('')
const user = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }] })
const toolResult = (id, toolCallId, text) => ({ id, role: 'tool', toolCallId, content: [{ type: 'text', text }] })

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Lead', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Docs', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Code', model: 'local-codex-cli/gpt-5.1-codex', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1',
      name: 'Launch',
      named: true,
      members: ['m1', 'b2', 'b3'],
      admin: 'm1',
      mode: 'admin',
      notice: 'Always include benchmark numbers, exact file paths, and rollout steps in every Launch review.',
      sessions: { m1: 'gm1', b2: 'gb2', b3: 'gb3' },
      seen: {},
      seq: 0,
      log: [],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function startHost({ home = mkdtempSync(join(tmpdir(), 'dsb-pr3-')), state = TEAM, modelInfo, sessionHeaders = {}, localContext = {} } = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const warnings = []
  const projections = {
    snapshot: () => ({
      values: {
        contextPressure: { pressureTokens: 9_000, projectedTokens: 9_000, contextWindow: 128_000 },
      },
    }),
  }
  const ctx = fakeContext({
    services: {
      sessionProjections: projections,
    },
  })
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  let apiRoute
  const origReg = ctx.connection.fetch.register
  ctx.connection.fetch.register = (opts) => {
    apiRoute = opts
    return origReg(opts)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async (provider, model) => (modelInfo ? modelInfo(provider, model) : { context: { contextWindow: 128_000 }, defaultMaxTokens: 8_000 }),
      async* stream() {
        yield { type: 'text-delta', index: 0, text: '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          session: {
            id: sessionId,
            seq: 1,
            requestHeader: () => ({ config: sessionHeaders[sessionId] ?? { provider: 'deepseek', model: 'v4' } }),
            deriveMessages: () => [],
          },
          inbox: { nextStep: [], nextTurn: [] },
        },
      }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessions: { messageProjections: [], flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, memoryReview: false })
  if (Object.keys(localContext).length > 0) {
    rt.localAgentContext = sid => localContext[sid]
  }
  const call = async (endpoint, payload = {}) => {
    const res = await apiRoute.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return res.json()
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, call, tool, warnings, stop }
}

async function runMemoryPreStep(ctx, sessionId, { history = [], messages = [] } = {}) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => history } }
  return step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages }))
}

async function collectStream(stream) {
  const calls = []
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls.push(chunk.block)
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { calls, text, finish }
}

// ---------------------------------------------------------------------------
// 1. ContextRuntime capabilities, unified window resolution, working vs log
//    measurement, B9 prefix warning, and persisted state.contextParts.

test('ContextRuntime exposes unified capabilities, window resolution, working vs log measurement, and persists state across restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr3-rt-'))
  const localContext = {
    b3: { used: 42_000, size: 200_000, compactions: 1 },
  }
  const host = startHost({
    home,
    modelInfo: (provider, model) => {
      if (provider === 'deepseek' && model === 'v4') return { context: { contextWindow: 128_000 }, defaultMaxTokens: 8_000 }
      if (provider === 'local-codex-cli') return { context: { contextWindow: 256_000 } }
      return {}
    },
    sessionHeaders: {
      b2: { provider: 'deepseek', model: 'v4' },
      b3: { provider: 'local-codex-cli', model: 'gpt-5.1-codex' },
    },
    localContext,
  })
  let active = host
  t.after(() => active.stop())
  await host.rt.load()

  // Capability matrix across all 4 runtime kinds.
  assert.deepEqual(capabilitiesForKind('model'), {
    kind: 'model',
    isLocal: false,
    midTurnHook: true,
    compactionMode: 'checkpoint',
    selfCompacts: false,
    canFork: true,
    canMoveToBackground: true,
    instructionChannel: 'system',
    prunesToolResults: true,
    sessionCanBeLost: false,
  })
  assert.equal(capabilitiesForKind('codex').instructionChannel, 'developer')
  assert.equal(capabilitiesForKind('codex').compactionMode, 'command')
  assert.equal(capabilitiesForKind('claude').instructionChannel, 'system')
  assert.equal(capabilitiesForKind('claude').compactionMode, 'command')
  assert.equal(capabilitiesForKind('acp').instructionChannel, 'prompt')
  assert.equal(capabilitiesForKind('acp').compactionMode, 'self')

  const modelSession = { id: 'b2', requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) }
  const codexSession = { id: 'b3', requestHeader: () => ({ config: { provider: 'local-codex-cli', model: 'gpt-5.1-codex' } }) }
  assert.equal(host.rt.contextRuntime.capabilitiesFor(modelSession).kind, 'model')
  assert.equal(host.rt.contextRuntime.capabilitiesFor(codexSession).kind, 'codex')

  // Unified window resolution: CLI-reported wins for local, model-declared for API,
  // and falls back to model-declared for local when CLI hasn't reported size yet.
  const modelWin = await host.rt.contextRuntime.resolveWindow(modelSession)
  assert.deepEqual(modelWin, { window: 128_000, reserve: 8_000, source: 'model-declared', reported: false })
  const codexWin = await host.rt.contextRuntime.resolveWindow(codexSession)
  assert.equal(codexWin.source, 'cli-reported')
  assert.equal(codexWin.window, 200_000)

  // channel.js run-stats uses the same ContextRuntime measure + window resolution.
  const stats = (await host.call('run-stats', { botId: 'b3' })).value
  assert.deepEqual([stats.contextPressure.pressureTokens, stats.contextPressure.contextWindow], [42_000, 200_000])

  // Working tokens vs log tokens are explicitly separated for local CLI sessions.
  const measured = host.rt.contextRuntime.measure(codexSession, { logTokens: 310_000 })
  assert.equal(measured.workingTokens, 42_000)
  assert.equal(measured.logTokens, 310_000)
  assert.equal(measured.isLocal, true)

  // B9: high fixed-prefix share logs a one-time diagnostic warning.
  host.rt.contextRuntime.checkPrefixShare('b2', { prefixTokens: 16_000, usable: 32_000 })
  host.rt.contextRuntime.checkPrefixShare('b2', { prefixTokens: 16_000, usable: 32_000 })
  const prefixWarns = host.warnings.filter(line => line.includes('fixed prefix for b2'))
  assert.equal(prefixWarns.length, 1, 'prefix share warning must fire once per session')

  // Persisted contextParts state survives host restart.
  assert.equal(host.rt.contextRuntime.bumpEpoch('b3', 'cli-self-compact'), 1)
  host.rt.contextRuntime.setPartBase('b3', 42_000)
  host.rt.contextRuntime.setCliCompactions('b3', 2)
  await host.rt.save({ required: true })
  await host.stop({ keep: true })

  const restarted = startHost({ home, state: JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), localContext })
  active = restarted
  await restarted.rt.load()
  assert.equal(restarted.rt.contextRuntime.epochOf('b3'), 1)
  assert.equal(restarted.rt.contextRuntime.partBaseOf('b3'), 42_000)
  assert.equal(restarted.rt.contextRuntime.cliCompactionsOf('b3'), 2)

  restarted.rt.contextRuntime.forget('b3')
  assert.equal(restarted.rt.contextRuntime.epochOf('b3'), 0)
  assert.equal(restarted.rt.contextRuntime.partBaseOf('b3'), undefined)
})

// ---------------------------------------------------------------------------
// 2. R3: Epoch-based post-compaction redelivery (own memory, group memory,
//    autoRecall) even when DSH history retains pre-compaction messages (CLI self-compaction).

test('R3 + B3: advancing context epoch after CLI self-compaction re-injects own memory, group memory, and resets autoRecall dedup while keeping system prompt byte-identical', async (t) => {
  const host = startHost()
  t.after(() => host.stop())
  await host.rt.load()

  const promptBefore = host.ctx.sections.get('bot-memory').text({ agent: { id: 'gb3' } })
  const ownPromptBefore = host.ctx.sections.get('bot-memory').text({ agent: { id: 'b3' } })
  assert.equal(promptBefore, ownPromptBefore, 'own chat and group chat of same Bot must share byte-identical bot-memory system prompt')

  await host.tool('bot_remember', { text: 'Coder uses Rust 1.85' }, 'b3')
  await host.tool('bot_remember', { text: 'Launch ships every Tuesday' }, 'gb3')
  await host.tool('bot_remember', { text: 'Deploy script runs cargo test --release first', topic: 'deploy' }, 'b3')

  // System prompt stays byte-identical after memory writes (B3 cross-session prefix cache).
  assert.equal(host.ctx.sections.get('bot-memory').text({ agent: { id: 'gb3' } }), promptBefore)
  assert.equal(host.ctx.sections.get('bot-memory').text({ agent: { id: 'b3' } }), ownPromptBefore)

  // Epoch 0 step 1: injects own snapshot, group snapshot, and autoRecall.
  const trigger = user('u1', 'How do we run the deploy script with cargo test?')
  const step1 = await runMemoryPreStep(host.ctx, 'gb3', { history: [], messages: [trigger] })
  const own0 = step1.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  const group0 = step1.messages.find(m => m.source?.kind === 'ds-bot-group-memory')
  const recall0 = step1.messages.find(m => m.source?.kind === 'ds-bot-memory-recall')
  assert.ok(own0 && group0 && recall0, 'epoch 0 must inject own, group, and recall snapshots')
  assert.equal(own0.source.epoch, 0)
  assert.equal(group0.source.epoch, 0)
  assert.equal(recall0.source.epoch, 0)

  // Epoch 0 step 2 (same epoch, DSH history has epoch-0 snapshots): NONE re-injected.
  const historyWithEpoch0 = [own0, group0, recall0, trigger]
  const step2 = await runMemoryPreStep(host.ctx, 'gb3', { history: historyWithEpoch0, messages: [user('u2', 'Run the deploy script cargo test again')] })
  assert.equal(step2.messages.find(m => m.source?.kind === 'ds-bot-own-memory'), undefined)
  assert.equal(step2.messages.find(m => m.source?.kind === 'ds-bot-group-memory'), undefined)
  assert.equal(step2.messages.find(m => m.source?.kind === 'ds-bot-memory-recall'), undefined)

  // Simulate CLI self-compaction: DSH history STILL holds the epoch-0 messages,
  // but ContextRuntime epoch bumps to 1. All three MUST re-inject with epoch: 1!
  await host.tool('bot_remember', { text: 'Launch moved to Wednesday' }, 'gb3')
  host.rt.contextRuntime.bumpEpoch('gb3', 'cli-self-compact')
  const step3 = await runMemoryPreStep(host.ctx, 'gb3', { history: historyWithEpoch0, messages: [user('u3', 'Check deploy script cargo test')] })
  const own1 = step3.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  const group1 = step3.messages.find(m => m.source?.kind === 'ds-bot-group-memory')
  const recall1 = step3.messages.find(m => m.source?.kind === 'ds-bot-memory-recall')
  assert.equal(own1?.source?.epoch, 1)
  assert.equal(group1?.source?.epoch, 1)
  assert.match(textOf(group1), /Launch moved to Wednesday/)
  assert.equal(recall1?.source?.epoch, 1)
  assert.match(textOf(recall1), /cargo test --release/)

  // Step 4 in epoch 1 (history now has epoch-1 snapshots): suppressed again.
  const step4 = await runMemoryPreStep(host.ctx, 'gb3', { history: [...historyWithEpoch0, own1, group1, recall1], messages: [user('u4', 'deploy script cargo test')] })
  assert.equal(step4.messages.find(m => m.source?.kind === 'ds-bot-own-memory'), undefined)
  assert.equal(step4.messages.find(m => m.source?.kind === 'ds-bot-group-memory'), undefined)
  assert.equal(step4.messages.find(m => m.source?.kind === 'ds-bot-memory-recall'), undefined)
})

// ---------------------------------------------------------------------------
// 3. B4: Group prompt boilerplate snapshot + incremental delta + epoch reset.

test('B4: group prompt sends full boilerplate once per epoch, shrinks unchanged rounds, sends deltas on change, and refreshes after compaction', async (t) => {
  const host = startHost()
  t.after(() => host.stop())
  await host.rt.load()

  const delivered = []
  host.rt.deliver = async (args) => {
    delivered.push(args)
    setImmediate(() => host.rt.roomWaiters.get(args.exchangeId)?.resolve('Got it.'))
  }
  host.rt.ensureCapabilities = async () => {}
  // Flush ledger before stop() removes the temp dir.
  t.after(() => host.rt.ledger.flush())

  const room = host.rt.roomOf('r1')
  let eventSeq = 0
  const emitUser = (text) => {
    for (const listener of host.ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: 'r1' }, { type: 'user/message', seq: ++eventSeq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
    }
  }
  const runRound = async (callId, userText) => {
    emitUser(userText)
    await host.tool('group_relay', {}, 'r1', { callId, signal: AbortSignal.timeout(5_000) })
    const deadline = Date.now() + 3_000
    while ((delivered.length === 0 || host.rt.roomActive('r1')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  // Round 1: full boilerplate (members, ROOM_CALLS, Group notice, adminNote, ROOM_REPLY).
  await runRound('c1', 'Kick off Launch planning')
  const r1 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.match(r1, /Members: the user, Writer, Coder and you \(admin\)\./)
  assert.match(r1, /Writing "@Name" calls that member at once/)
  assert.match(r1, /Group notice \(shared instructions for every member\):\nAlways include benchmark numbers/)
  assert.match(r1, /You are this group's admin\./)
  assert.match(r1, /Reply with your message for the group, no name prefix/)

  // Round 2 (same epoch, unchanged group metadata): compact prompt without repeated boilerplate.
  delivered.length = 0
  await runRound('c2', 'Status check on Launch?')
  const r2 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.doesNotMatch(r2, /Writing "@Name" calls that member at once/)
  assert.doesNotMatch(r2, /Group notice \(shared instructions for every member\):/)
  assert.doesNotMatch(r2, /You are this group's admin\./)
  assert.match(r2, /Reply for the group \(no name prefix; \[PASS\] to stay silent\)\./)
  assert.ok(r2.length < r1.length * 0.5, `round 2 (${r2.length} chars) should shrink dramatically vs round 1 (${r1.length} chars)`)

  // Round 3 after notice changes: emits ONLY the changed notice delta.
  room.notice = 'New notice: attach CI logs to every Launch update.'
  delivered.length = 0
  await runRound('c3', 'Share the updated checklist')
  const r3 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.match(r3, /Updated group notice \(shared instructions for every member\):\nNew notice: attach CI logs/)
  assert.doesNotMatch(r3, /Updated group members:/)
  assert.doesNotMatch(r3, /You are this group's admin\./)

  // Round 4 after compaction bumps epoch: full boilerplate is re-delivered!
  host.rt.contextRuntime.bumpEpoch('gm1', 'dsh-checkpoint')
  delivered.length = 0
  await runRound('c4', 'Final sign-off')
  const r4 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.match(r4, /Members: the user, Writer, Coder and you \(admin\)\./)
  assert.match(r4, /Group notice \(shared instructions for every member\):\nNew notice: attach CI logs/)
  assert.match(r4, /Reply with your message for the group, no name prefix/)
})

// ---------------------------------------------------------------------------
// 4. L2: Strip DSH-only tool sections for local CLIs & stop duplicating system
//    instructions in Codex/Claude replay while keeping ACP prompt instructions.

test('L2: system-prompt/assemble strips DSH-only tool sections for local CLIs while preserving team tool sections and API Bot sections', async (t) => {
  const host = startHost()
  t.after(() => host.stop())
  await host.rt.load()

  const assembleHook = host.ctx.listeners.get('system-prompt/assemble').find(fn => fn.name === 'scopeTeamTools')
  assert.ok(assembleHook)
  const sampleAssembled = {
    sections: [
      { name: 'bot-team-rules', text: 'team rules' },
      { name: 'tool:read', text: 'DSH built-in read tool instructions' },
      { name: 'tool:bash', text: 'DSH built-in bash tool instructions' },
      { name: 'tool:list_bots', text: 'Bridged team tool list_bots' },
      { name: 'bot-identity', text: 'identity' },
    ],
    tools: [],
  }

  // Local CLI Bot (b3 -> local-codex-cli): DSH-only tool:read / tool:bash stripped, bridged tool:list_bots kept.
  const localOut = await assembleHook(
    {},
    { agent: { id: 'b3', session: { id: 'b3', requestHeader: () => ({ config: { provider: 'local-codex-cli', model: 'gpt-5.1-codex' } }) } } },
    async () => sampleAssembled,
  )
  assert.deepEqual(localOut.sections.map(s => s.name), ['bot-team-rules', 'tool:list_bots', 'bot-identity'])

  // API model Bot (b2 -> deepseek/v4): keeps DSH built-in tool sections intact.
  const modelOut = await assembleHook(
    {},
    { agent: { id: 'b2', session: { id: 'b2', requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }) } } },
    async () => sampleAssembled,
  )
  assert.deepEqual(modelOut.sections.map(s => s.name), ['bot-team-rules', 'tool:read', 'tool:bash', 'tool:list_bots', 'bot-identity'])
})

test('L2: Codex and Claude receive instructions via their native channel without duplicating them in replay prompt, while ACP keeps prompt instructions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-pr3-l2-'))
  const codexRec = join(dir, 'codex.jsonl')
  const acpRec = join(dir, 'acp.jsonl')

  const make = () => new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => process.execPath,
    spawnEngine: (kind, route, spec) => (kind === 'codex'
      ? new CodexEngine(route, { ...spec, command: process.execPath, args: [FAKE_CODEX, '--record', codexRec] }, { findExecutable: () => process.execPath })
      : kind === 'claude'
        ? new ClaudeEngine(route, { ...spec, command: process.execPath, args: [FAKE_CLAUDE] }, { findExecutable: () => process.execPath })
        : new AcpEngine(route, { ...spec, command: process.execPath, args: [FAKE_ACP, '--record', acpRec] }, { findExecutable: () => process.execPath })),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => dir,
    toolsFor: () => [],
  })

  const adapter = make()
  t.after(async () => {
    await adapter.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const sysText = 'UNIQUE_TEAM_INSTRUCTIONS_L2_MARKER'
  const msgs = [system('sys', sysText), user('m1', 'Say hello')]

  await collectStream(adapter.stream({ sessionId: 's-codex', provider: 'local-codex-cli', model: 'gpt-5.1-codex', messages: msgs }))
  const claudeOut = await collectStream(adapter.stream({ sessionId: 's-claude', provider: 'local-claude-code', model: 'sonnet', messages: msgs }))
  await collectStream(adapter.stream({ sessionId: 's-acp', provider: 'local-devin-cli', model: 'default', messages: msgs }))

  // Codex: developerInstructions carries sysText, turn/start input does NOT duplicate it.
  const codexCalls = readFileSync(codexRec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const codexStart = codexCalls.find(c => c.method === 'thread/start')
  const codexTurn = codexCalls.find(c => c.method === 'turn/start')
  assert.equal(codexStart.params.developerInstructions, sysText)
  const codexInput = codexTurn.params.input.map(b => b.text ?? '').join('\n')
  assert.doesNotMatch(codexInput, /UNIQUE_TEAM_INSTRUCTIONS_L2_MARKER/)
  assert.doesNotMatch(codexInput, /The team instructions for this conversation:/)

  // Claude: --append-system-prompt(-file) carries sysText; fake-claude echoes the first
  // 60 chars of the user prompt, proving it starts with conversation history and NOT
  // a duplicated "The team instructions for this conversation:" block.
  assert.match(claudeOut.text, /^ok: The conversation so far \(oldest first\):/)
  assert.doesNotMatch(claudeOut.text, /The team instructions for this conversation:/)
  assert.doesNotMatch(claudeOut.text, /UNIQUE_TEAM_INSTRUCTIONS_L2_MARKER/)

  // ACP: prompt DOES carry team instructions since ACP has no dedicated system channel.
  const acpCalls = readFileSync(acpRec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const acpPrompt = acpCalls.find(c => c.method === 'session/prompt').params.prompt.map(b => b.text ?? '').join('\n')
  assert.match(acpPrompt, /The team instructions for this conversation:\nUNIQUE_TEAM_INSTRUCTIONS_L2_MARKER/)
})

// ---------------------------------------------------------------------------
// 5. L3: MCP tools.listChanged capability + SSE notification + parallel call batching.

test('L3: LoopbackMcp advertises tools.listChanged, streams notifications/tools/list_changed over GET SSE, and adapter batches parallel MCP calls into one DSH step', async (t) => {
  const mcp = new LoopbackMcp(
    () => [{ name: 'list_bots', description: 'List bots', parameters: { type: 'object', properties: {} } }],
    async ({ name }) => ({ text: `ok:${name}`, isError: false }),
  )
  await mcp.listen()
  t.after(() => mcp.close())

  // Unauthenticated GET is refused with 401.
  const unauth = await fetch(mcp.url, { method: 'GET' })
  assert.equal(unauth.status, 401)

  // initialize declares tools.listChanged: true.
  const initRes = await fetch(mcp.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  const initBody = await initRes.json()
  assert.equal(initBody.result.capabilities.tools.listChanged, true)

  // Authenticated GET SSE receives notifications/tools/list_changed when notifyToolsChanged() fires.
  const ac = new AbortController()
  t.after(() => ac.abort())
  const sseRes = await fetch(mcp.url, {
    method: 'GET',
    headers: { authorization: `Bearer ${mcp.token}`, accept: 'text/event-stream' },
    signal: ac.signal,
  })
  assert.equal(sseRes.status, 200)
  const reader = sseRes.body.getReader()
  mcp.notifyToolsChanged()
  const { value } = await reader.read()
  const chunk = Buffer.from(value).toString('utf8')
  assert.match(chunk, /"method":"notifications\/tools\/list_changed"/)
  ac.abort()

  // Parallel MCP tools/call batching in LocalAgentAdapter: 3 concurrent POSTs -> 1 DSH tool-calls step.
  let mcpHandle
  const eventQueue = []
  let eventWaiter
  const pushEngineEvent = (ev) => {
    if (eventWaiter !== undefined) {
      const resolve = eventWaiter
      eventWaiter = undefined
      resolve(ev)
    } else {
      eventQueue.push(ev)
    }
  }
  const fakeEngine = {
    async open(_sid, { mcp: server }) {
      mcpHandle = server
      return {
        cliSessionId: 'batch-cli-1',
        resumed: false,
        next: () => (eventQueue.length > 0 ? Promise.resolve(eventQueue.shift()) : new Promise(resolve => { eventWaiter = resolve })),
      }
    },
    prompt() { return Promise.resolve('turn-1') },
    canSteer: () => true,
    close: async () => {},
  }
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => process.execPath,
    spawnEngine: () => fakeEngine,
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    toolsFor: () => [{ name: 'list_bots', description: 'List bots', parameters: { type: 'object', properties: {} } }],
  })
  t.after(() => adapter.dispose())

  const step1Promise = collectStream(adapter.stream({
    sessionId: 's-batch',
    provider: 'local-codex-cli',
    model: 'gpt-5.1-codex',
    messages: [user('m1', 'run 3 parallel tools')],
  }))
  let step1Failed
  step1Promise.catch(err => { step1Failed = err })
  // Wait for open() to receive mcpHandle without hanging if stream rejects early.
  while (mcpHandle === undefined && step1Failed === undefined) await new Promise(r => setTimeout(r, 5))
  if (step1Failed !== undefined) throw step1Failed

  const postCall = (id, arg) => fetch(mcpHandle.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcpHandle.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_bots', arguments: { tag: arg } } }),
  }).then(r => r.text())

  const p1 = postCall(10, 'a')
  const p2 = postCall(11, 'b')
  const p3 = postCall(12, 'c')

  const step1 = await step1Promise
  assert.equal(step1.finish?.kind, 'tool-calls')
  assert.equal(step1.calls.length, 3, 'all 3 concurrent MCP tools/call requests must batch into 1 DSH step')

  // Return all 3 tool results in step 2; all 3 MCP HTTP SSE calls resolve cleanly.
  const step2Promise = collectStream(adapter.stream({
    sessionId: 's-batch',
    provider: 'local-codex-cli',
    model: 'gpt-5.1-codex',
    messages: [
      user('m1', 'run 3 parallel tools'),
      ...step1.calls.map((c, i) => toolResult(`tr-${i}`, c.id, `res-${i}`)),
    ],
  }))
  const responses = await Promise.all([p1, p2, p3])
  assert.equal(responses.filter(body => body.includes('res-')).length, 3)
  pushEngineEvent({ type: 'text', text: 'all 3 batched' })
  pushEngineEvent({ type: 'done', reason: 'stop' })
  const step2 = await step2Promise
  assert.equal(step2.finish?.kind, 'stop')
  assert.equal(step2.text, 'all 3 batched')
})

// ---------------------------------------------------------------------------
// 6. Review regressions: restart group-only memoryUpdate with empty seenAtIds,
//    delegation-first epoch delivering ROOM_CALLS on first ordinary turn, and
//    mcp-stdio.js forwarding notifications/tools/list_changed over stdout.

test('regression: group-only memoryUpdate after restart succeeds when .seen has no in-memory seenAtIds', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr3-restart-group-'))
  const first = startHost({ home })
  let active = first
  t.after(() => active.stop())
  await first.rt.load()

  await first.tool('bot_remember', { text: 'Rollout requires canary check' }, 'gb2')
  const s1 = await runMemoryPreStep(first.ctx, 'gb3', { history: [] })
  const ownSnap = s1.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  const groupSnap = s1.messages.find(m => m.source?.kind === 'ds-bot-group-memory')
  assert.ok(ownSnap && groupSnap)
  // Simulate legacy/post-restart state where .seen exists on disk but ownSnap had no watermark ids.
  const ownSnapNoIds = { ...ownSnap, source: { kind: 'ds-bot-own-memory', form: 'snapshot', epoch: 0 } }

  await first.stop({ keep: true })
  const second = startHost({ home, state: JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) })
  active = second
  await second.rt.load()

  // Group-only edit after restart (zero own/team rows matched, seenAtIds empty in memory).
  await second.tool('bot_remember', { text: 'Rollout window is 14:00 UTC' }, 'gb2')
  const s2 = await runMemoryPreStep(second.ctx, 'gb3', { history: [ownSnapNoIds, groupSnap] })
  const upd = s2.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.ok(upd, 'group-only memory update after restart must succeed without throwing')
  assert.match(textOf(upd), /Rollout window is 14:00 UTC/)
  // Next step must not replay the delivered group edit.
  const s3 = await runMemoryPreStep(second.ctx, 'gb3', { history: [ownSnapNoIds, groupSnap, upd] })
  assert.equal(s3.messages.find(m => m.source?.kind === 'ds-bot-memory-update'), undefined)
})

test('regression: epoch opening on delegated wake still sends ROOM_CALLS on the first ordinary discussion turn', async (t) => {
  const host = startHost()
  t.after(async () => {
    await host.rt.ledger.flush()
    await host.stop()
  })
  await host.rt.load()

  const delivered = []
  host.rt.deliver = async (args) => {
    delivered.push(args)
    setImmediate(() => host.rt.roomWaiters.get(args.exchangeId)?.resolve('Done.'))
  }
  host.rt.ensureCapabilities = async () => {}

  // Pre-seed epoch-0 metadata as recorded by an opening delegated wake (full: true, hasCallRules: false).
  const room = host.rt.roomOf('r1')
  const membersList = 'Members: the user, Writer, Coder and you (admin).'
  const adminText = [
    'You are this group\'s admin.',
    'Plain messages come to you first: answer them, or call the members who should answer with @Name.',
    '"@all" calls every member. When the user asks, change the group with update_group.',
    'When the user wants this group to reach a goal, set it with group_goal: align with the user first (goal-grill skill), then start it.',
  ].join(' ')
  const { createHash } = await import('node:crypto')
  const payload = { membersList, notice: room.notice, adminText }
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
  host.rt.contextRuntime.setGroupMeta('gm1', { hash, epoch: 0, full: true, hasCallRules: false, ...payload })

  let eventSeq = 0
  const runRound = async (callId, userText) => {
    for (const listener of host.ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: 'r1' }, { type: 'user/message', seq: ++eventSeq, data: { content: [{ type: 'text', text: userText }], source: { kind: 'user' } } })
    }
    await host.tool('group_relay', {}, 'r1', { callId, signal: AbortSignal.timeout(5_000) })
    const deadline = Date.now() + 3_000
    while ((delivered.length === 0 || host.rt.roomActive('r1')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  // First ordinary discussion turn after delegated opener MUST receive ROOM_CALLS.
  await runRound('d1', 'Let us discuss the release')
  const ordinary1 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.match(ordinary1, /Writing "@Name" calls that member at once/)

  // Subsequent ordinary turn omits ROOM_CALLS again.
  delivered.length = 0
  await runRound('d2', 'Any other thoughts?')
  const ordinary2 = delivered.find(d => d.sessionId === 'gm1')?.text ?? ''
  assert.doesNotMatch(ordinary2, /Writing "@Name" calls that member at once/)
})

test('regression: mcp-stdio.js subscribes to GET SSE after initialize and forwards notifications/tools/list_changed to stdout', async (t) => {
  const mcp = new LoopbackMcp(
    () => [{ name: 'list_bots', description: 'List bots', parameters: { type: 'object', properties: {} } }],
    async () => ({ text: 'ok', isError: false }),
  )
  await mcp.listen()
  t.after(() => mcp.close())

  const bridgePath = join(__dirname, '..', 'src', 'host', 'local-agents', 'mcp-stdio.js')
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, DSBOT_MCP_URL: mcp.url, DSBOT_MCP_TOKEN: mcp.token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => { try { child.kill() } catch {} })

  const lines = []
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    let at
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at).trim()
      rest = rest.slice(at + 1)
      if (line !== '') lines.push(JSON.parse(line))
    }
  })

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  const waitUntil = async (pred, label) => {
    const end = Date.now() + 5_000
    while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 15))
    assert.ok(pred(), `timed out waiting for ${label}`)
  }
  await waitUntil(() => lines.some(m => m.id === 1), 'initialize response')
  assert.equal(lines.find(m => m.id === 1).result.capabilities.tools.listChanged, true)
  // Wait for the background GET SSE stream to register on LoopbackMcp.
  await waitUntil(() => mcp.streams.size === 1, 'stdio bridge SSE registration')

  mcp.notifyToolsChanged()
  await waitUntil(() => lines.some(m => m.method === 'notifications/tools/list_changed'), 'tools/list_changed over stdio')

  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  child.stdin.end()
  assert.equal(await exited, 0, 'stdio bridge must exit cleanly on stdin close even with notification SSE active')
})

test('regression: incremental memory-update and memory-recall messages with form:snapshot are preserved in order in pendingContext and pruned on compaction', async (t) => {
  const { isSnapshotContextSource, isContextOnlySource } = await import('../src/host/context-messages.js')
  assert.equal(isContextOnlySource({ kind: 'ds-bot-memory-update', form: 'snapshot' }), true)
  assert.equal(isContextOnlySource({ kind: 'ds-bot-memory-recall', form: 'snapshot' }), true)
  assert.equal(isSnapshotContextSource({ kind: 'ds-bot-memory-update', form: 'snapshot' }), false, 'incremental memory updates must not overwrite earlier updates')
  assert.equal(isSnapshotContextSource({ kind: 'ds-bot-memory-recall', form: 'snapshot' }), false, 'per-query auto-recall must not overwrite earlier recalls')
  assert.equal(isSnapshotContextSource({ kind: 'ds-bot-own-memory', form: 'snapshot' }), true)
  assert.equal(isSnapshotContextSource({ kind: 'ds-bot-group-memory', form: 'snapshot' }), true)

  const sentPrompts = []
  let observeFn
  const fakeEngine = {
    async open() {
      return {
        cliSessionId: 'cli-mem-order-1',
        resumed: false,
        next: () => new Promise(() => {}),
      }
    },
    prompt(_session, blocks) {
      sentPrompts.push(blocks.map(b => b.text ?? '').join('\n'))
      return Promise.resolve('t1')
    },
    canSteer: () => true,
    close: async () => {},
  }
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => process.execPath,
    spawnEngine: () => fakeEngine,
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  // Seed a live session with handedId = 'm1'.
  const live = await adapter.liveFor({ sessionId: 's-mem', provider: 'local-codex-cli', model: 'gpt-5.1-codex' }, 'workspace-write')
  live.cliSessionId = 'cli-mem-order-1'
  live.handed = 'm1'
  live.state = 'idle'

  // Two consecutive real memory-update messages (both carry form: 'snapshot') arrive idle:
  // neither wakes the CLI, and BOTH must remain in pendingContext (not overwrite each other).
  const m1 = user('m1', 'initial')
  const updA = user('u-a', 'Memory update A: use pnpm', { kind: 'ds-bot-memory-update', form: 'snapshot' })
  const updB = user('u-b', 'Memory update B: deploy Tuesdays', { kind: 'ds-bot-memory-update', form: 'snapshot' })
  const recA = user('r-a', 'Recalled topic A', { kind: 'ds-bot-memory-recall', form: 'snapshot' })
  const recB = user('r-b', 'Recalled topic B', { kind: 'ds-bot-memory-recall', form: 'snapshot' })
  const noteX = user('n-x', 'Silent FYI note', { kind: 'bot', role: 'note', silent: true })

  await collectStream(adapter.stream({ sessionId: 's-mem', provider: 'local-codex-cli', model: 'gpt-5.1-codex', messages: [m1, updA] }))
  await collectStream(adapter.stream({ sessionId: 's-mem', provider: 'local-codex-cli', model: 'gpt-5.1-codex', messages: [m1, updA, updB, recA, recB, noteX] }))
  assert.deepEqual(
    live.pendingContext.map(e => e.text),
    ['Memory update A: use pnpm', 'Memory update B: deploy Tuesdays', 'Recalled topic A', 'Recalled topic B', 'Silent FYI note'],
  )

  // When CLI self-compaction completes, stale pre-compaction memory entries are pruned
  // from pendingContext while non-memory silent notices stay.
  observeFn = adapter.observe.bind(adapter)
  observeFn(live, { type: 'compaction', status: 'completed' })
  assert.deepEqual(live.pendingContext.map(e => e.text), ['Silent FYI note'])
  assert.equal(sentPrompts.length, 0)
})

test('regression: notifyToolsChanged only fires when tool set changes and serves live updated tools over tools/list immediately', async (t) => {
  let currentTools = [{ name: 'list_bots', description: 'List bots', parameters: { type: 'object', properties: {} } }]
  let mcpHandle
  const fakeEngine = {
    async open(_sid, { mcp: server }) {
      mcpHandle = server
      return { cliSessionId: 'cli-tools-1', resumed: false, next: () => new Promise(() => {}) }
    },
    prompt: () => Promise.resolve('t1'),
    canSteer: () => true,
    close: async () => {},
  }
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => process.execPath,
    spawnEngine: () => fakeEngine,
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    toolsFor: () => currentTools,
  })
  t.after(() => adapter.dispose())

  const live = await adapter.liveFor({ sessionId: 's-tools', provider: 'local-codex-cli', model: 'gpt-5.1-codex' }, 'workspace-write')
  const mcp = await adapter.ensureMcp(live, () => adapter.deps.toolsFor({}, 's-tools'))
  mcpHandle = mcp

  const ac = new AbortController()
  t.after(() => ac.abort())
  const sse = await fetch(mcpHandle.url, {
    method: 'GET',
    headers: { authorization: `Bearer ${mcpHandle.token}`, accept: 'text/event-stream' },
    signal: ac.signal,
  })
  const reader = sse.body.getReader()
  const received = []
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received.push(Buffer.from(value).toString('utf8'))
      }
    } catch {}
  })()

  // Unchanged tool set: notifyToolsChanged must NOT send redundant chatter.
  adapter.notifyToolsChanged()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(received.length, 0, 'unchanged tool set must not emit list_changed')

  // Update tool set dynamically -> notifyToolsChanged fires AND tools/list immediately serves the new tool!
  currentTools = [
    ...currentTools,
    { name: 'delegate_work', description: 'Delegate work', parameters: { type: 'object', properties: {} } },
  ]
  adapter.notifyToolsChanged()
  const end = Date.now() + 2_000
  while (received.length === 0 && Date.now() < end) await new Promise(r => setTimeout(r, 15))
  assert.match(received.join(''), /"method":"notifications\/tools\/list_changed"/)

  const listRes = await fetch(mcpHandle.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcpHandle.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const listBody = await listRes.json()
  assert.deepEqual(listBody.result.tools.map(tool => tool.name), ['list_bots', 'delegate_work'])
})
