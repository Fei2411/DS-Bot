// PR-2 contract tests: unified context-only classification (R1), skipping model-switch
// compaction on local parts (R2), overflow vs rate-limit classification (L5), local
// canMakeRoom + bare overflow recovery escape hatch (L6), formal runtime-lost part
// switching on CLI resume loss (D2), local note pre-dispatch backoff (D1), handedId
// pre-confirm rollback (L1), Codex instruct retry, and Claude long system prompt file.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isContextOnlyMessage, isContextOnlySource } from '../src/host/context-messages.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { install as partsInstall } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const user = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })

async function collect(stream) {
  let text = ''
  const calls = []
  let finish
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls.push(chunk.block)
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, calls, finish }
}

function makeScriptAdapter(kind, script, { records = {}, engines = [], switchOnResumeLost, systemFileThreshold, toolsFor = () => [] } = {}) {
  const Ctor = kind === 'claude' ? ClaudeEngine : kind === 'codex' ? CodexEngine : AcpEngine
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => {
      const args = kind === 'claude' ? ['-e', script, '--'] : ['-e', script]
      const engine = new Ctor(route, { ...spec, command: process.execPath, args }, {
        findExecutable: path => path,
        ...(systemFileThreshold !== undefined ? { systemFileThreshold } : {}),
      })
      engines.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    patchRecord: (sessionId, patch) => { if (records[sessionId]) Object.assign(records[sessionId], patch) },
    recordUsage: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    probeCwd: () => tmpdir(),
    toolsFor,
    ...(switchOnResumeLost !== undefined ? { switchOnResumeLost } : {}),
  })
}

function makeFixtureAdapter({ records = {}, acpArgs = [], codexArgs = [], claudeArgs = [], claude, switchOnResumeLost, toolsFor = () => [] } = {}) {
  const spawned = []
  return {
    spawned,
    adapter: new LocalAgentAdapter({
      rt: { warn: () => {} },
      customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
      findExecutable: path => path,
      spawnEngine: (kind, route, spec) => {
        const engine = kind === 'acp'
          ? new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE('fake-acp.mjs'), ...acpArgs] }, { findExecutable: p => p })
          : kind === 'codex'
            ? new CodexEngine(route, { ...spec, command: process.execPath, args: [FIXTURE('fake-codex.mjs'), ...codexArgs] }, { findExecutable: p => p })
            : new ClaudeEngine(route, { ...spec, command: process.execPath, args: [claude ?? FIXTURE('fake-claude.mjs'), ...claudeArgs] }, { findExecutable: p => p })
        spawned.push(engine)
        return engine
      },
      record: sessionId => records[sessionId],
      saveRecord: (sessionId, record) => { records[sessionId] = record },
      patchRecord: (sessionId, patch) => { if (records[sessionId]) Object.assign(records[sessionId], patch) },
      recordUsage: () => {},
      presetFor: () => 'workspace-write',
      cwdFor: async () => tmpdir(),
      probeCwd: () => tmpdir(),
      toolsFor,
      ...(switchOnResumeLost !== undefined ? { switchOnResumeLost } : {}),
    }),
  }
}

function makePartsHarness({ local = true, context = { used: 220_000, size: 262_000, compactions: 0 }, messages = [], note, decision = 'switch', lastEnd, services = {} } = {}) {
  const warnings = []
  const followed = []
  const notes = []
  let current = context === undefined ? undefined : { ...context }
  const ctx = fakeContext({ services })
  ctx.logger = { warn: (...args) => warnings.push(format(...args)), info: () => {} }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 8_192 }) }
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: local ? 'local-devin-cli/default' : 'deepseek-official/deepseek-chat', segments: [] }
  const header = { config: local ? { provider: 'local-devin-cli', model: 'default' } : { provider: 'deepseek-official', model: 'deepseek-chat' }, tools: [] }
  const session = {
    id: 's1',
    header: { cwd: '/tmp/team' },
    seq: lastEnd ? 2 : 1,
    eventAt: seq => (lastEnd && seq === 1 ? lastEnd : undefined),
    requestHeader: () => header,
    deriveMessages: () => messages,
    toolHistory: () => [],
  }
  const agent = {
    id: 's1',
    session,
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const fresh = {
    id: 's2',
    session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const liveEntries = new Map()
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: (...args) => warnings.push(format(...args)),
    async save() {
      if (bot.sessionId) rt.chatOwners.set(bot.sessionId, bot.id)
    },
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    chatOf: () => bot.sessionId,
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-'),
    isLocalAgentRoute: route => typeof route === 'string' && route.startsWith('local-'),
    engineOf: ref => (ref?.startsWith('local-') ? ref.split('/')[0] : 'model'),
    engineOfBot: subject => rt.engineOf(subject?.model),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: liveEntries,
    liveOf: (id) => {
      let entry = liveEntries.get(id)
      if (entry === undefined) { entry = {}; liveEntries.set(id, entry) }
      return entry
    },
    groupSessionsOf: () => [],
    partLines: async function* () {
      yield { who: 'user', text: 'User: Port the parser', seq: 1, time: 1 }
    },
    eventsBackwards: async function* () {},
    historyEntry: () => undefined,
    resolveAgent: async id => (id === 's2' ? fresh : agent),
    createSession: async () => 's2',
    desiredModel: async subject => subject.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    closeLocalAgentSession: async () => {},
    teamFolder: () => '/tmp/team',
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    tagUsage: list => list,
    defaultModel: async () => undefined,
    localAgentContext: () => current,
    localAgentAsk: async () => JSON.stringify({ action: decision, reason: 'test' }),
    localAgentNote: async (id, prompt) => {
      notes.push(prompt)
      if (typeof note === 'function') return note(prompt)
      if (note instanceof Error) throw note
      return note
    },
    localAgentCompact: async () => 'done',
  }
  partsInstall(rt)
  const settle = async () => {
    for (let i = 0; i < 100 && (bot.sessionId !== 's2' || rt.isSwitchingPart('s1')); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { ctx, rt, bot, agent, fresh, warnings, followed, notes, settle, setContext: next => { current = next } }
}

// ---------------------------------------------------------------------------
// R1: Unified context-only classification & idle/pending-call clock handling
// ---------------------------------------------------------------------------

test('R1: isContextOnlyMessage classifies clocks, memory snapshots/updates/recalls, snapshots, and silent notices', () => {
  for (const kind of ['runtime-context', 'time-context', 'ds-bot-time-context', 'ds-bot-group-memory', 'ds-bot-memory-update', 'ds-bot-memory-recall', 'working-directory', 'compact-checkpoint', 'snapshot']) {
    assert.equal(isContextOnlyMessage(user('u', 'ctx', { kind })), true, kind)
  }
  assert.equal(isContextOnlyMessage(user('u', 'snap', { kind: 'custom', form: 'snapshot' })), true)
  for (const role of ['note', 'cancelled', 'stopped']) {
    assert.equal(isContextOnlyMessage(user('u', 'notice', { kind: 'bot', role })), true, role)
  }
  assert.equal(isContextOnlyMessage(user('u', 'silent', { kind: 'bot', role: 'request', silent: true })), true)
  assert.equal(isContextOnlyMessage(user('u', 'real user', { kind: 'user' })), false)
  assert.equal(isContextOnlyMessage(user('u', 'handoff', { kind: 'bot', role: 'handoff', handoff: true })), false)
  assert.equal(isContextOnlySource({ kind: 'user' }), false)
})

test('R1: idle clock-only steps do not prompt ACP; latest snapshot rides with the next real user message and never hijacks ask_user', async (t) => {
  const record = join(mkdtempSync(join(tmpdir(), 'dsb-pr2-r1-')), 'rpc.jsonl')
  t.after(() => rmSync(dirname(record), { recursive: true, force: true }))
  const records = {}
  const { adapter } = makeFixtureAdapter({
    records,
    acpArgs: ['--record', record],
    toolsFor: () => [{ name: 'ask_user', description: 'Ask user', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
  })
  t.after(() => adapter.dispose())

  const history = [system('sys', 'You are Kai.'), user('m1', 'hello')]
  await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: history, tools: [], signal: AbortSignal.timeout(15_000) }))
  const promptsAfterFirst = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === 'session/prompt')
  assert.equal(promptsAfterFirst.length, 1)

  // Two idle clock snapshots arrive without user input: zero new CLI prompts should fire,
  // and only the newest time-context snapshot is retained.
  const clk1 = user('c1', 'Current time: 10:00', { kind: 'time-context', form: 'snapshot' })
  const clk2 = user('c2', 'Current time: 10:10', { kind: 'time-context', form: 'snapshot' })
  const idle1 = await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: [...history, clk1], tools: [], signal: AbortSignal.timeout(15_000) }))
  const idle2 = await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: [...history, clk1, clk2], tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(idle1.finish?.kind, 'stop')
  assert.equal(idle2.finish?.kind, 'stop')
  const promptsAfterClocks = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === 'session/prompt')
  assert.equal(promptsAfterClocks.length, 1, 'idle clock-only updates must not start an extra CLI prompt')

  // Next real user message carries only the newest clock snapshot (10:10, not stale 10:00).
  const u2 = user('m2', 'what time is it?')
  await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: [...history, clk1, clk2, u2], tools: [], signal: AbortSignal.timeout(15_000) }))
  const promptsAfterU2 = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === 'session/prompt')
  assert.equal(promptsAfterU2.length, 2)
  const prompt2Text = promptsAfterU2[1].params.prompt.map(b => b.text ?? '').join('\n')
  assert.match(prompt2Text, /Current time: 10:10/)
  assert.doesNotMatch(prompt2Text, /Current time: 10:00/)
  assert.match(prompt2Text, /what time is it\?/)

  // Now simulate an open bridged MCP call (`ask_user`): a ds-bot-time-context message arriving
  // before the user's answer must NOT resolve the pending call!
  const live = adapter.live.get('s1')
  let resolvedAnswer
  live.pending.set('call-ask-1', { name: 'ask_user', resolve: (val) => { resolvedAnswer = val } })
  live.state = 'suspended'
  const clk3 = user('c3', 'Current time: 10:20', { kind: 'ds-bot-time-context', form: 'snapshot' })
  const answerMsg = user('m3', 'Use option B')
  const fullMsgs = [...history, clk1, clk2, u2, clk3, answerMsg]
  // Push a done event so drain settles once the open call resolves.
  setTimeout(() => live.push({ type: 'done', reason: 'end_turn' }), 20)
  await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: fullMsgs, tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(resolvedAnswer?.text, 'Use option B', 'clock message must not hijack open ask_user call')
})

test('R1/continuation: staged context arriving during a bridged tool continuation is preserved for the next prompt when the turn replies normally', async (t) => {
  const record = join(mkdtempSync(join(tmpdir(), 'dsb-pr2-tool-ctx-')), 'rpc.jsonl')
  t.after(() => rmSync(dirname(record), { recursive: true, force: true }))
  const acpScript = `
    const { appendFileSync } = require('node:fs')
    const rec = ${JSON.stringify(record)}
    let buf = '', prompts = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        appendFileSync(rec, line + '\\n')
        const { id, method } = msg
        if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
        else if (method === 'session/new') send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-c1' } })
        else if (method === 'session/load') send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-c1' } })
        else if (method === 'session/set_config_option' || method === 'session/set_mode' || method === 'session/set_model') send({ jsonrpc: '2.0', id, result: {} })
        else if (method === 'session/prompt') {
          prompts += 1
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-c1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply-' + prompts } } } })
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
        }
      }
    })
  `
  const records = {}
  const adapter = makeScriptAdapter('acp', acpScript, { records })
  t.after(() => adapter.dispose())

  const h1 = [system('sys', 'You are Kai.'), user('m1', 'first question')]
  await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: h1, tools: [], signal: AbortSignal.timeout(15_000) }))

  // Suspend the live ACP session on a bridged MCP tool call; while waiting, a memory update
  // arrives alongside the tool result (no new user message). The CLI replies normally.
  const live = adapter.live.get('s1')
  let resolvedTool
  live.pending.set('call-1', { name: 'check_status', resolve: val => { resolvedTool = val } })
  live.state = 'suspended'
  live.engineSession.running = true
  const memUpdate = user('mem-1', '[Memory update] User prefers Bun over npm.', { kind: 'ds-bot-memory-update' })
  const toolRes = { id: 'tr-1', role: 'tool', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'status ok' }] }
  const h2 = [...h1, toolRes, memUpdate]
  setTimeout(() => {
    live.push({ type: 'text', text: 'handled tool result' })
    live.push({ type: 'done', reason: 'end_turn' })
  }, 20)
  const contOut = await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: h2, tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(resolvedTool?.text, 'status ok')
  assert.equal(contOut.text, 'handled tool result')
  assert.equal(live.pendingContext.length, 1, 'staged memory update must stay pending when turn replied without a new prompt')
  assert.equal(records.s1.pendingContext?.length, 1, 'staged memory update must be persisted on record across idle close / restart')

  // Simulate IDLE_CLOSE_MS closing the warm worker before the next user message arrives:
  // resuming the CLI session must restore pendingContext from the saved record and deliver it.
  await adapter.closeLive(live, { idle: true })
  assert.equal(adapter.live.has('s1'), false)

  // Next real user message carries the preserved memory update into the resumed CLI prompt.
  const h3 = [...h2, user('m2', 'which package manager should we use?')]
  await collect(adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: h3, tools: [], signal: AbortSignal.timeout(15_000) }))
  const prompts = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === 'session/prompt')
  assert.equal(prompts.length, 2)
  const prompt2Text = prompts[1].params.prompt.map(b => b.text ?? '').join('\n')
  assert.match(prompt2Text, /User prefers Bun over npm/)
  assert.match(prompt2Text, /which package manager should we use\?/)
  assert.equal(records.s1.pendingContext, undefined, 'persisted pendingContext must be cleared once delivered and confirmed')
})

// ---------------------------------------------------------------------------
// R2: Skip adoptEngine model-switch compaction on local parts
// ---------------------------------------------------------------------------

test('R2: adoptEngine skips compactPressure and compactRegion on local parts without mutating DSH log', async () => {
  let pressureCalls = 0
  let regionCalls = 0
  const fakeCompaction = {
    compactIfNeeded: async () => null,
    compactNow: async () => null,
    compactPressure: async () => { pressureCalls += 1; throw new Error('should not run on local part') },
    compactRegion: async () => { regionCalls += 1; throw new Error('should not run on local part') },
    summarize: async () => ({ blocks: [{ type: 'text', text: 'summary' }] }),
  }
  const run = makePartsHarness({ local: true, services: { compaction: fakeCompaction } })
  // Trigger agent/created so adoptCompaction wraps fakeCompaction.
  for (const listener of run.ctx.listeners.get('agent/created') ?? []) listener({ agent: run.agent })

  const pRes = await fakeCompaction.compactPressure(run.agent, { config: { provider: 'local-devin-cli', model: 'other-model' } }, AbortSignal.timeout(5_000), true)
  const rRes = await fakeCompaction.compactRegion(0, 1, run.agent, AbortSignal.timeout(5_000))
  assert.equal(pRes, null)
  assert.equal(rRes, null)
  assert.equal(pressureCalls, 0)
  assert.equal(regionCalls, 0)
})

// ---------------------------------------------------------------------------
// L5: Overflow vs rate-limit classification in LocalAgentAdapter
// ---------------------------------------------------------------------------

test('L5: rate limits with "too many tokens per minute" map to LOCAL_AGENT_QUOTA; real context overflows map to CONTEXT_WINDOW_EXCEEDED', async () => {
  const { adapter } = makeFixtureAdapter()
  const live = { spec: { kind: 'acp', name: 'Fake ACP' }, state: 'running', pending: new Map() }
  const runErr = async (error) => {
    const q = [{ type: 'error', error }]
    let caught
    try {
      await adapter.collect(live, () => ({ event: Promise.resolve(q.shift()), drop: () => {} }))
    } catch (e) { caught = e }
    return caught
  }

  for (const rateErr of [
    new Error('Rate limit reached: too many tokens per minute (TPM)'),
    Object.assign(new Error('You have sent too many tokens per minute'), { status: 429 }),
    new Error('HTTP 429: Too Many Requests — TPM limit exceeded'),
  ]) {
    const out = await runErr(rateErr)
    assert.equal(out?.code, 'LOCAL_AGENT_QUOTA', `expected LOCAL_AGENT_QUOTA for: ${rateErr.message}`)
  }

  for (const overflowErr of [
    new Error('Prompt is too long'),
    new Error('This model\'s maximum context length is 200000 tokens'),
    new Error('context_length_exceeded: input is too long for this model'),
    Object.assign(new Error('overflow'), { code: 'context_window_exceeded' }),
  ]) {
    const out = await runErr(overflowErr)
    assert.equal(out?.code, 'CONTEXT_WINDOW_EXCEEDED', `expected CONTEXT_WINDOW_EXCEEDED for: ${overflowErr.message}`)
  }
})

// ---------------------------------------------------------------------------
// D2: CLI resume loss -> formal runtime-lost part switch
// ---------------------------------------------------------------------------

test('D2: ACP, Codex, and Claude resume loss throw LOCAL_AGENT_SESSION_LOST (no silent replay) and parts.js switches with fallback=runtime-lost', async (t) => {
  // 1. ACP --fail-load with switchOnResumeLost=true throws LOCAL_AGENT_SESSION_LOST and creates NO orphan session/new.
  const acpRecPath = join(mkdtempSync(join(tmpdir(), 'dsb-pr2-d2-acp-')), 'rpc.jsonl')
  t.after(() => rmSync(dirname(acpRecPath), { recursive: true, force: true }))
  const acpRecords = { s1: { route: 'local-acp-fake', cliSessionId: 'acp-old', cwd: tmpdir(), handedId: 'm1', model: 'default' } }
  const acpHarness = makeFixtureAdapter({ records: acpRecords, acpArgs: ['--fail-load', '--record', acpRecPath], switchOnResumeLost: () => true })
  t.after(() => acpHarness.adapter.dispose())
  await assert.rejects(
    collect(acpHarness.adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: [user('m1', 'hi'), user('m2', 'next')], tools: [], signal: AbortSignal.timeout(15_000) })),
    err => err instanceof LlmError && err.code === 'LOCAL_AGENT_SESSION_LOST',
  )
  const acpCalls = readFileSync(acpRecPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(acpCalls.filter(c => c.method === 'session/load').length >= 1, 'should attempt session/load')
  assert.equal(acpCalls.filter(c => c.method === 'session/new').length, 0, 'must not spawn orphan session/new when switching parts')

  // 2. Codex --fail-resume with switchOnResumeLost=true throws LOCAL_AGENT_SESSION_LOST and creates NO orphan thread/start.
  const codexRecPath = join(mkdtempSync(join(tmpdir(), 'dsb-pr2-d2-codex-')), 'rpc.jsonl')
  t.after(() => rmSync(dirname(codexRecPath), { recursive: true, force: true }))
  const codexRecords = { c1: { route: 'local-codex-cli', cliSessionId: 'th-old', cwd: tmpdir(), handedId: 'm1', model: 'default' } }
  const codexHarness = makeFixtureAdapter({ records: codexRecords, codexArgs: ['--fail-resume', '--record', codexRecPath], switchOnResumeLost: () => true })
  t.after(() => codexHarness.adapter.dispose())
  await assert.rejects(
    collect(codexHarness.adapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: [user('m1', 'hi'), user('m2', 'next')], tools: [], signal: AbortSignal.timeout(15_000) })),
    err => err instanceof LlmError && err.code === 'LOCAL_AGENT_SESSION_LOST',
  )
  const codexCalls = readFileSync(codexRecPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(codexCalls.filter(c => c.method === 'thread/resume').length, 1)
  assert.equal(codexCalls.filter(c => c.method === 'thread/start').length, 0, 'must not spawn orphan thread/start when switching parts')

  // 3. Claude missing conversation with switchOnResumeLost=true throws LOCAL_AGENT_SESSION_LOST without silent replay.
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-pr2-d2-claude-')), 'runs')
  t.after(() => rmSync(dirname(runs), { recursive: true, force: true }))
  const claudeRecords = { cl1: { route: 'local-claude-code', cliSessionId: 'claude-gone', cwd: tmpdir(), handedId: 'm1', model: 'default' } }
  const claudeHarness = makeFixtureAdapter({
    records: claudeRecords,
    claude: FIXTURE('fake-claude-flaky.mjs'),
    claudeArgs: [runs, '', 'claude-gone'],
    switchOnResumeLost: () => true,
  })
  t.after(() => claudeHarness.adapter.dispose())
  await assert.rejects(
    collect(claudeHarness.adapter.stream({ provider: 'local-claude-code', model: 'default', sessionId: 'cl1', messages: [user('m1', 'hi'), user('m2', 'next')], tools: [], signal: AbortSignal.timeout(15_000) })),
    err => err instanceof LlmError && err.code === 'LOCAL_AGENT_SESSION_LOST',
  )
  assert.equal(readFileSync(runs, 'utf8'), '1', 'must not silently retry in-part on Claude resume loss')

  // 4. parts.js agent/request-error catches LOCAL_AGENT_SESSION_LOST and performs a formal
  // runtime-lost switch that preserves full unread request text and image blocks (and is
  // idempotent across crash recovery via heldBack).
  const longText = `Compare these two controls carefully: ${'X'.repeat(4500)}`
  const imageBlock = { type: 'image', attachment: { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: 1024 } }
  const unreadMsg = {
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: longText }, imageBlock],
    source: { kind: 'user' },
  }
  const parts = makePartsHarness({
    local: true,
    messages: [
      user('m1', 'Earlier question'),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
      unreadMsg,
    ],
  })
  parts.rt.state.localAgents = { custom: [], sessions: { s1: { handedId: 'm1' } } }
  parts.rt.holdImOrigin = () => 'im-tok-live'
  // Make fresh session reflect already-followed messages so heldBack dedup can verify idempotency.
  parts.fresh.session.deriveMessages = () => [...parts.followed]
  const handlers = parts.ctx.listeners.get('agent/request-error') ?? []
  let handled = false
  for (const listener of handlers) {
    const out = await listener({ agent: parts.agent, failure: { code: 'LOCAL_AGENT_SESSION_LOST', message: 'gone' }, signal: AbortSignal.timeout(5_000) }, () => 'next')
    if (out === undefined) { handled = true; break }
  }
  assert.equal(handled, true)
  await parts.settle()
  assert.equal(parts.bot.sessionId, 's2')
  assert.equal(parts.bot.segments.at(-1)?.fallback, 'runtime-lost')
  assert.equal(parts.notes.length, 0, 'must not ask a lost CLI session for a note')
  assert.equal(parts.followed.length, 2, 'fresh part receives silent handoff followed by original unread request')
  assert.equal(parts.followed[0].source?.handoff, true)
  assert.equal(parts.followed[0].source?.resume, undefined, 'handoff stays silent when unread request wakes the fresh part')
  assert.equal(parts.followed[0].source?.imOrigin, undefined, 'silent handoff must not consume the one-use IM origin token')
  assert.match(parts.followed[0].content.map(b => b.text).join(''), /local agent session could no longer be resumed/)
  assert.equal(parts.followed[1].content[0].text, longText, 'full long unread text must not be clipped')
  assert.deepEqual(parts.followed[1].content[1], imageBlock, 'unread image attachment block must be preserved')
  assert.equal(parts.followed[1].source?.transferId, 'runtime-lost:s1:m2')
  assert.equal(parts.followed[1].source?.imOrigin, 'im-tok-live', 'forwarded unread request carries the one-use IM origin token')

  // Simulate a crash before switching cleanup completed: re-running heldBack() must NOT duplicate the unread request.
  parts.rt.state.switching.s1 = { botId: 'b1', next: 's2', runtimeLost: true }
  await parts.rt.heldBack()
  assert.equal(parts.followed.length, 2, 'crash recovery must deduplicate already-forwarded runtime-lost request')

  // Simulate a crash after pointer flip and handoff flush, BEFORE forward() ran: heldBack() delivers the unread request once.
  const crashParts = makePartsHarness({
    local: true,
    messages: [
      user('m1', 'Earlier question'),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
      unreadMsg,
    ],
  })
  crashParts.rt.state.localAgents = { custom: [], sessions: { s1: { handedId: 'm1' } } }
  crashParts.bot.sessionId = 's2'
  crashParts.bot.segments = [{ sessionId: 's1', endedAt: Date.now(), fallback: 'runtime-lost' }]
  crashParts.rt.chatOwners.set('s2', 'b1')
  crashParts.rt.state.switching.s1 = {
    botId: 'b1',
    next: 's2',
    runtimeLost: true,
    runtimeLostContext: { resumeOrigin: 'im-tok-crash' },
    handoffPending: true,
    handoffMeta: { resume: true, runtimeLost: true, runtimeLostHasUnread: true, resumeOrigin: 'im-tok-crash' },
  }
  crashParts.fresh.session.deriveMessages = () => [...crashParts.followed]
  await crashParts.rt.heldBack()
  assert.equal(crashParts.followed.length, 2, 'crash recovery delivers silent handoff and unread request once')
  assert.equal(crashParts.followed[0].source?.handoff, true)
  assert.equal(crashParts.followed[0].source?.resume, undefined)
  assert.equal(crashParts.followed[0].source?.imOrigin, undefined, 'recovered silent handoff must not consume IM origin token')
  assert.equal(crashParts.followed[1].content[0].text, longText)
  assert.deepEqual(crashParts.followed[1].content[1], imageBlock)
  assert.equal(crashParts.followed[1].source?.imOrigin, 'im-tok-crash', 'recovered unread request carries the IM origin token')
})

// ---------------------------------------------------------------------------
// D1: Local note failure before reaching CLI stays on part with backoff
// ---------------------------------------------------------------------------

test('D1: local note failure before reaching CLI (LOCAL_AGENT_BUSY) stays on part with backoff instead of forcing switch', async () => {
  const busyErr = new LlmError('the local agent is in the middle of a turn', 'LOCAL_AGENT_BUSY')
  busyErr.reachedCli = false
  const parts = makePartsHarness({
    local: true,
    context: { used: 220_000, size: 262_000, compactions: 0 },
    messages: [user('m1', 'work in progress')],
    note: busyErr,
    decision: 'switch',
  })
  // Trigger idle checkContext (below hard line ~235K, above check line ~209K).
  for (const listener of parts.ctx.listeners.get('agent/status') ?? []) listener({ agent: parts.agent, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(parts.bot.sessionId, 's1', 'LOCAL_AGENT_BUSY before reaching CLI must stay on part')
  assert.equal(parts.notes.length, 1)

  // Second idle trigger right away is throttled by NOTE_COOLDOWN_MS (1 min).
  for (const listener of parts.ctx.listeners.get('agent/status') ?? []) listener({ agent: parts.agent, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(parts.notes.length, 1, 'second attempt during backoff must be skipped')
})

// ---------------------------------------------------------------------------
// L6: Local canMakeRoom ignores DSH tokenMeter & recoverOverflowPart escape hatch
// ---------------------------------------------------------------------------

test('L6: unrecoverable overflow marks CONTEXT_WINDOW_EXCEEDED and recoverOverflowPart starts a clean bare part', async () => {
  // Fresh local part with a handoff and NO post-handoff messages + unreported CLI used:
  // canMakeRoom must return false (cannot shrink) instead of falling back to DSH tokenMeter.
  const handoffMsg = user('h1', '[Handoff · part 2]\n...', { kind: 'bot', role: 'handoff', handoff: true })
  const parts = makePartsHarness({
    local: true,
    context: { size: 200_000, compactions: 0 },
    messages: [handoffMsg],
    lastEnd: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' } } } },
  })

  // Simulate agent/request-error with CONTEXT_WINDOW_EXCEEDED: auto-switch refuses (canMakeRoom=false)
  // and marks entry.overflowFailure = true.
  const handlers = parts.ctx.listeners.get('agent/request-error') ?? []
  let fellThrough = false
  for (const listener of handlers) {
    const out = await listener({ agent: parts.agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' }, signal: AbortSignal.timeout(5_000) }, () => 'next')
    if (out === 'next') fellThrough = true
  }
  assert.equal(fellThrough, true, 'unrecoverable overflow should surface to FailureCell')
  assert.equal(parts.bot.sessionId, 's1')
  assert.equal(parts.rt.liveOf('s1').overflowFailure, true)

  // Now invoke recoverOverflowPart (backed by `new-part` endpoint): switches cleanly to bare part s2.
  parts.bot.failures = { s1: { turn: 1, code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' } }
  const result = await parts.rt.recoverOverflowPart('b1', 's1')
  assert.equal(result.sessionId, 's2')
  assert.equal(parts.bot.sessionId, 's2')
  assert.equal(parts.bot.failures, undefined)
  const handoffText = parts.followed.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.match(handoffText, /starts without the latest messages from the previous part/)
  assert.equal(parts.followed.at(-1)?.source?.resume, undefined, 'bare recovery handoff must not auto-resume failing turn')

  // Calling recoverOverflowPart on a healthy part without an overflow failure is rejected.
  await assert.rejects(parts.rt.recoverOverflowPart('b1', 's2'), /does not need an overflow recovery switch/)

  // Helper to run the agent/request-error middleware chain in reverse-prepend order.
  const dispatchRequestError = async (harness, failure) => {
    const chain = [...(harness.ctx.listeners.get('agent/request-error') ?? [])]
    let idx = 0
    const next = async () => {
      if (idx >= chain.length) return 'next'
      const listener = chain[idx++]
      return listener({ agent: harness.agent, failure, signal: AbortSignal.timeout(5_000) }, next)
    }
    return next()
  }

  // Local part with prior handoff and NO shrinkable post-handoff work:
  // - even when CLI reports a large `used` (fixed CLI overhead + handoff), single huge user
  //   message with no assistant/tool work refuses auto-switch and sets overflowFailure.
  const postHandoffHuge = makePartsHarness({
    local: true,
    context: { used: 195_000, size: 200_000, compactions: 0 },
    messages: [handoffMsg, user('u1', 'huge input')],
  })
  const hugeOut = await dispatchRequestError(postHandoffHuge, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(hugeOut, 'next')
  assert.equal(postHandoffHuge.bot.sessionId, 's1')
  assert.equal(postHandoffHuge.rt.liveOf('s1').overflowFailure, true)

  // - oversized incoming handoff + short first request CAN shrink (replacement < old handoff
  //   and verbatim text preserved in handoff) -> auto-switches to s2.
  const oversizedHandoff = user('h-big', `[Handoff · part 2]\n${'Prior transcript context. '.repeat(2000)}`, { kind: 'bot', role: 'handoff', handoff: true })
  const bigHandoffShortReq = makePartsHarness({
    local: true,
    context: { used: 195_000, size: 200_000, compactions: 0 },
    messages: [oversizedHandoff, user('u-short', 'Summarize the decision.')],
  })
  bigHandoffShortReq.rt.eventsBackwards = async function* () {
    yield { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the decision.' }] } }
  }
  const shrinkOut = await dispatchRequestError(bigHandoffShortReq, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(shrinkOut, undefined)
  await bigHandoffShortReq.settle()
  assert.equal(bigHandoffShortReq.bot.sessionId, 's2')

  // - oversized incoming handoff + short first request WITH an image refuses auto-switch (never drops image).
  const bigHandoffImageReq = makePartsHarness({
    local: true,
    context: { used: 195_000, size: 200_000, compactions: 0 },
    messages: [oversizedHandoff, { id: 'u-img', role: 'user', content: [{ type: 'text', text: 'What does this chart show?' }, { type: 'image', attachment: { attachmentId: 'sha256:img1' } }], source: { kind: 'user' } }],
  })
  bigHandoffImageReq.rt.eventsBackwards = async function* () {
    yield { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'What does this chart show?' }] } }
  }
  const imgReqOut = await dispatchRequestError(bigHandoffImageReq, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(imgReqOut, 'next')
  assert.equal(bigHandoffImageReq.bot.sessionId, 's1')
  assert.equal(bigHandoffImageReq.rt.liveOf('s1').overflowFailure, true)

  // - oversized resume handoff overflowing on its own (no separate post-handoff request) refuses auto-switch.
  const oversizedResumeHandoff = user('h-resume-big', `[Handoff · part 2]\n${'Prior transcript context. '.repeat(2000)}`, { kind: 'bot', role: 'handoff', handoff: true, resume: true })
  const resumeHandoffOverflow = makePartsHarness({
    local: true,
    context: { used: 195_000, size: 200_000, compactions: 0 },
    messages: [oversizedResumeHandoff],
  })
  const resumeHandoffOut = await dispatchRequestError(resumeHandoffOverflow, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(resumeHandoffOut, 'next')
  assert.equal(resumeHandoffOverflow.bot.sessionId, 's1')
  assert.equal(resumeHandoffOverflow.rt.liveOf('s1').overflowFailure, true)

  // - oversized incoming handoff + oversized first user message (> RECENT_LINE_MAX) refuses clipping auto-switch.
  const bigHandoffBigReq = makePartsHarness({
    local: true,
    context: { used: 195_000, size: 200_000, compactions: 0 },
    messages: [oversizedHandoff, user('u-big', 'X'.repeat(5000))],
  })
  const bigReqOut = await dispatchRequestError(bigHandoffBigReq, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(bigReqOut, 'next')
  assert.equal(bigHandoffBigReq.bot.sessionId, 's1')
  assert.equal(bigHandoffBigReq.rt.liveOf('s1').overflowFailure, true)

  // - post-handoff part with real assistant work CAN shrink -> auto-switches to s2.
  const postHandoffMulti = makePartsHarness({
    local: true,
    context: { size: 200_000, compactions: 0 },
    messages: [
      handoffMsg,
      user('u1', 'first question'),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'long earlier answer' }] },
      user('u2', 'follow up'),
    ],
  })
  const multiOut = await dispatchRequestError(postHandoffMulti, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Prompt is too long' })
  assert.equal(multiOut, undefined)
  await postHandoffMulti.settle()
  assert.equal(postHandoffMulti.bot.sessionId, 's2')
})

// ---------------------------------------------------------------------------
// L1: handedId rolls back on pre-confirmation rejection, never after output
// ---------------------------------------------------------------------------

test('L1: Codex turn/start rejection rolls back handedId; ACP pre-event rejection rolls back but post-output failure does not', async (t) => {
  // Codex rejects turn/start on turn 2: handedId must stay at m1 so retry delivers m2.
  const codexScript = `
    let buf = '', starts = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') send({ jsonrpc: '2.0', id, result: {} })
        else if (method === 'thread/start') send({ jsonrpc: '2.0', id, result: { thread: { id: 'th-1' } } })
        else if (method === 'turn/start') {
          starts += 1
          if (starts === 2) {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'temporary busy' } })
          } else {
            const turnId = 't-' + starts
            const text = (params.input ?? []).map(b => b.text ?? '').join(' ')
            send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
            send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th-1', turn: { id: turnId } } })
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId, item: { type: 'agentMessage', text: 'echo:' + text } } })
            send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: turnId, status: 'completed' } } })
          }
        }
      }
    })
  `
  const codexRecords = {}
  const codexAdapter = makeScriptAdapter('codex', codexScript, { records: codexRecords })
  t.after(() => codexAdapter.dispose())
  const h1 = [user('m1', 'first')]
  await collect(codexAdapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: h1, tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(codexRecords.c1.handedId, 'm1')

  const h2 = [...h1, user('m2', 'must-not-be-lost')]
  await assert.rejects(collect(codexAdapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: h2, tools: [], signal: AbortSignal.timeout(15_000) })))
  assert.equal(codexRecords.c1.handedId, 'm1', 'pre-confirm Codex turn/start rejection must roll back handedId')

  const retryOut = await collect(codexAdapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: h2, tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.match(retryOut.text, /must-not-be-lost/)
  assert.equal(codexRecords.c1.handedId, 'm2')

  // ACP: prompt 2 fails immediately with 0 events -> rolls back; prompt 3 emits output then fails -> keeps handedId.
  const acpScript = `
    let buf = '', prompts = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
        else if (method === 'session/new') send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-1' } })
        else if (method === 'session/set_config_option' || method === 'session/set_mode' || method === 'session/set_model') send({ jsonrpc: '2.0', id, result: {} })
        else if (method === 'session/prompt') {
          prompts += 1
          if (prompts === 1) {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok-1' } } } })
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
          } else if (prompts === 2) {
            // Emit a housekeeping context update before rejecting: must NOT count as turn confirmation.
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'usage_update', used: 1000, size: 200000 } } })
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'rejected before start' } })
          } else {
            const seenCount = (params.prompt ?? []).map(b => b.text ?? '').join('\\n').split('Keep this across rollback').length - 1
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial work count=' + seenCount } } } })
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'failed after partial work' } })
          }
        }
      }
    })
  `
  const acpRecords = {}
  const acpAdapter = makeScriptAdapter('acp', acpScript, { records: acpRecords })
  t.after(() => acpAdapter.dispose())
  await collect(acpAdapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 'a1', messages: [user('m1', 'one')], tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(acpRecords.a1.handedId, 'm1')
  // Prompt 2 rejected after only a housekeeping usage_update (no output) -> rolls back handedId AND restores flushedContext.
  // Re-sending the same delta `[stagedMem, m2]` must deduplicate `stagedMem` by message id (never duplicate non-snapshot context).
  const stagedMem = user('mem-rb', '[Memory update] Keep this across rollback', { kind: 'ds-bot-memory-update' })
  await assert.rejects(collect(acpAdapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 'a1', messages: [user('m1', 'one'), stagedMem, user('m2', 'two')], tools: [], signal: AbortSignal.timeout(15_000) })))
  assert.equal(acpRecords.a1.handedId, 'm1', 'ACP rejection with only housekeeping events must roll back handedId')
  assert.equal(acpAdapter.live.get('a1').pendingContext.length, 1, 'pre-confirm rejection must restore flushedContext into pendingContext')
  // Prompt 3 emits output then fails -> must NOT roll back (never auto-replay partial side effects),
  // and `stagedMem` must have been deduplicated by id rather than appended twice.
  let p3Text = ''
  await assert.rejects((async () => {
    for await (const chunk of acpAdapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 'a1', messages: [user('m1', 'one'), stagedMem, user('m2', 'two')], tools: [], signal: AbortSignal.timeout(15_000) })) {
      if (chunk.type === 'text-delta') p3Text += chunk.text
    }
  })())
  assert.equal(p3Text, 'partial work count=1', 'rolled-back non-snapshot context must be deduplicated by id on retry')
  assert.equal(acpRecords.a1.handedId, 'm2', 'ACP failure after partial work must keep handedId')
  assert.equal(acpAdapter.live.get('a1').pendingContext.length, 0)
})

// ---------------------------------------------------------------------------
// Codex instruct failure does not advance promptHash and retries on next turn
// ---------------------------------------------------------------------------

test('Codex thread/inject_items failure leaves promptHash unchanged and retries on next turn', async (t) => {
  const codexScript = `
    let buf = '', injects = 0, turns = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') send({ jsonrpc: '2.0', id, result: {} })
        else if (method === 'thread/start') send({ jsonrpc: '2.0', id, result: { thread: { id: 'th-1' } } })
        else if (method === 'thread/inject_items') {
          injects += 1
          if (injects === 1) send({ jsonrpc: '2.0', id, error: { code: -32001, message: 'transient inject error' } })
          else send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'turn/start') {
          turns += 1
          const turnId = 't-' + turns
          send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
          send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId, item: { type: 'agentMessage', text: 'injects=' + injects } } })
          send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: turnId, status: 'completed' } } })
        }
      }
    })
  `
  const records = {}
  const adapter = makeScriptAdapter('codex', codexScript, { records })
  t.after(() => adapter.dispose())

  await collect(adapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: [system('s', 'rules v1'), user('m1', 'hi')], tools: [], signal: AbortSignal.timeout(15_000) }))
  const hashV1 = records.c1.promptHash
  assert.ok(hashV1)

  // Turn 2 with updated instructions: first inject_items fails -> promptHash must stay hashV1!
  const t2 = await collect(adapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: [system('s', 'rules v2'), user('m1', 'hi'), user('m2', 'next')], tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(t2.text, 'injects=1')
  assert.equal(records.c1.promptHash, hashV1, 'failed thread/inject_items must not advance promptHash')

  // Turn 3 retries inject_items, succeeds, and now advances promptHash!
  const t3 = await collect(adapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: [system('s', 'rules v2'), user('m1', 'hi'), user('m2', 'next'), user('m3', 'again')], tools: [], signal: AbortSignal.timeout(15_000) }))
  assert.equal(t3.text, 'injects=2')
  assert.notEqual(records.c1.promptHash, hashV1, 'succeeded thread/inject_items must advance promptHash')
})

// ---------------------------------------------------------------------------
// Claude Code long system prompt uses --append-system-prompt-file and cleans up
// ---------------------------------------------------------------------------

test('Claude Code writes long system prompts to a temp file via --append-system-prompt-file and cleans up on exit', async (t) => {
  const claudeScript = `
    const { readFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    const fileIdx = args.indexOf('--append-system-prompt-file')
    const inlineIdx = args.indexOf('--append-system-prompt')
    const filePath = fileIdx !== -1 ? args[fileIdx + 1] : ''
    const content = filePath ? readFileSync(filePath, 'utf8') : (inlineIdx !== -1 ? args[inlineIdx + 1] : '')
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    send({ type: 'system', subtype: 'init', session_id: 'cl-file-1' })
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.type !== 'user') continue
        send({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ filePath, len: content.length, hasInline: inlineIdx !== -1 }) }] } })
        send({ type: 'result', subtype: 'success', is_error: false, session_id: 'cl-file-1' })
      }
    })
  `
  const adapter = makeScriptAdapter('claude', claudeScript, { systemFileThreshold: 50 })
  t.after(() => adapter.dispose())
  const longSystem = `Team rules: ${'A'.repeat(200)}`
  const out = await collect(adapter.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 'cl-long',
    messages: [system('sys', longSystem), user('m1', 'hello')],
    tools: [],
    signal: AbortSignal.timeout(15_000),
  }))
  const parsed = JSON.parse(out.text)
  assert.ok(parsed.filePath.endsWith('system-prompt.txt'), 'long system prompt must use --append-system-prompt-file')
  assert.equal(parsed.hasInline, false)
  assert.equal(parsed.len, longSystem.length)
  assert.equal(existsSync(parsed.filePath), true, 'prompt file stays readable while process lives')
  await adapter.dispose()
  assert.equal(existsSync(parsed.filePath), false, 'prompt temp file must be cleaned up when process exits')
})
