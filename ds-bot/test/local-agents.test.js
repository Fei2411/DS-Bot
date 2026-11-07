import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { JsonRpcPeer } from '../src/host/local-agents/jsonrpc.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { LoopbackMcp, flattenSchema } from '../src/host/local-agents/mcp.js'
import { cleanEnv } from '../src/host/local-agents/discover.js'
import { validateCustom, isLocalAgentRoute, cliMode } from '../src/host/local-agents/engines.js'
import { install as partsInstall } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const FIXTURES = { acp: FIXTURE('fake-acp.mjs'), codex: FIXTURE('fake-codex.mjs'), claude: FIXTURE('fake-claude.mjs') }

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
const toolResult = (id, callId, text, isError = false) => ({ id, role: 'tool', content: [{ type: 'text', text }], toolCallId: callId, isError, source: { kind: 'tool', callId } })

// An adapter wired to the fake CLIs: every engine route spawns `node fixture`.
function makeAdapter({ records = {}, preset = 'workspace-write' } = {}) {
  const files = { acp: FIXTURES.acp, codex: FIXTURES.codex, claude: FIXTURES.claude }
  const spawned = []
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }, { id: 'fake2', name: 'Fake ACP 2', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = kind === 'acp' ? new AcpEngine(route, { ...spec, command: process.execPath, args: [files.acp] }, { findExecutable: path => path })
        : kind === 'codex' ? new CodexEngine(route, { ...spec, command: process.execPath, args: [files.codex] }, { findExecutable: path => path })
          : new ClaudeEngine(route, { ...spec, command: process.execPath, args: [files.claude] }, { findExecutable: path => path })
      spawned.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => preset,
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [{ name: 'message_bot', description: 'Message another Bot', parameters: { type: 'object', properties: { bot: { type: 'string' }, text: { type: 'string' } } } }],
  })
  adapter._spawned = spawned
  return adapter
}

// Collect a stream into {text, thinking, calls, finish} for assertions.
async function collect(stream) {
  const out = { text: '', thinking: '', calls: [], finish: undefined, usage: undefined }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'reasoning-delta') out.thinking += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.calls.push(chunk.block)
    else if (chunk.type === 'usage') out.usage = chunk.usage
    else if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}

const options = (sessionId, messages, extra = {}) => ({ provider: 'acp-fake', model: 'default', sessionId, messages, tools: [{ name: 'message_bot' }], signal: AbortSignal.timeout(60_000), ...extra })

test('session-title and compaction stay deterministic, no CLI is started', async () => {
  const adapter = makeAdapter()
  const title = await collect(adapter.stream(options('s1', [user('m1', 'Please review the auth changes')], { purpose: 'session-title' })))
  assert.equal(title.text, 'Please review the auth changes')
  assert.equal(title.finish.kind, 'stop')
  const digest = await collect(adapter.stream(options('s1', [user('m1', 'hello')], { purpose: 'compaction' })))
  assert.match(digest.text, /condensed/)
  assert.equal(adapter.engines.size, 0)
  await adapter.dispose()
})

test('a first turn replays the conversation, a later one sends only the delta', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records })
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [system('sys', 'You are Kai, a coder.'), user('m1', 'hello')])))
  assert.match(first.text, /^ok: /)
  assert.match(first.thinking, /thought about/)
  assert.equal(first.finish.kind, 'stop')
  // The record remembers the CLI session and how far it was handed.
  assert.ok(records.s1.cliSessionId?.startsWith('acp-'))
  assert.equal(records.s1.handedId, 'm1')
  const second = await collect(adapter.stream(options('s1', [system('sys', 'You are Kai, a coder.'), user('m1', 'hello'), user('m2', 'again')])))
  assert.match(second.text, /ok: again/)
  assert.equal(records.s1.handedId, 'm2')
})

test('each DS Bot Session maps to its own CLI session', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records })
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('own', [user('m1', 'one')])))
  await collect(adapter.stream(options('group', [user('m1', 'two')])))
  assert.notEqual(records.own.cliSessionId, records.group.cliSessionId)
})

test('the MCP bridge suspends the turn and the next stream answers it', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [user('m1', 'please call-tool now')])))
  assert.equal(first.finish.kind, 'tool-calls')
  assert.equal(first.calls.length, 1)
  assert.equal(first.calls[0].name, 'message_bot')
  const second = await collect(adapter.stream(options('s1', [user('m1', 'please call-tool now'), toolResult('m2', first.calls[0].id, 'Kai says hi back')])))
  assert.equal(second.finish.kind, 'stop')
  assert.match(second.text, /tool said: Kai says hi back/)
})

test('queued calls finish later streams', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [user('m1', 'two-calls')])))
  assert.equal(first.finish.kind, 'tool-calls')
  assert.equal(first.calls.length, 1)
  const seen = [user('m1', 'two-calls'), toolResult('m2', first.calls[0].id, 'one back')]
  const second = await collect(adapter.stream(options('s1', seen)))
  // The second queued call is emitted (or the agent already got both answered).
  assert.ok(second.finish.kind === 'tool-calls' || /tool said/.test(second.text), JSON.stringify(second))
})

test('a permission prompt bridges to approve_agent_action and fails closed', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission')])))
  assert.equal(ask.finish.kind, 'tool-calls')
  assert.equal(ask.calls[0].name, 'approve_agent_action')
  // The request named the call only by id; the card still says what it runs.
  const asked = JSON.parse(ask.calls[0].arguments ?? JSON.stringify(ask.calls[0].args))
  assert.equal(asked.action, 'Run `rm -rf /tmp/x`')
  assert.equal(asked.detail ?? '', '')
  // An allowed answer picks the agent's allow option: the tool returns its
  // structured decision, and only {"decision":"allow"} counts.
  const allowed = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission'), toolResult('m2', ask.calls[0].id, JSON.stringify({ decision: 'allow' }))])))
  assert.match(allowed.text, /allowed via allow-once/)
})
test('a permission answer that is not the structured allow fails closed', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission')])))
  // Free text that reads like an approval is not an approval.
  const loose = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission'), toolResult('m2', ask.calls[0].id, 'yes, allow it')])))
  assert.match(loose.text, /denied/)
})
test('a denied answer rejects the agent\'s action', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission')])))
  const denied = await collect(adapter.stream(options('s1', [user('m1', 'ask-permission'), toolResult('m2', ask.calls[0].id, 'denied', true)])))
  assert.match(denied.text, /denied/)
})

test('abort cancels the turn and the pending calls', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const control = new AbortController()
  const stream = collect(adapter.stream(options('s1', [user('m1', 'hang')], { signal: control.signal })))
  setTimeout(() => control.abort(), 300)
  const out = await stream
  assert.equal(out.finish.kind, 'aborted')
})

test('env sanitization drops agent and key variables', () => {
  process.env.ACP_BACKEND = 'windsurf'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.DS_BOT_HOME = '/x'
  const env = cleanEnv({ EXTRA: '1' })
  assert.equal(env.ACP_BACKEND, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.DS_BOT_HOME, undefined)
  assert.equal(env.EXTRA, '1')
  assert.equal(env.PATH, process.env.PATH)
})

test('custom agent validation', () => {
  assert.deepEqual(validateCustom({ name: 'Mine', command: 'my-agent', args: ['acp', '--fast'] }), { name: 'Mine', command: 'my-agent', args: ['acp', '--fast'] })
  assert.throws(() => validateCustom({ name: 'X', command: 'a b' }))
  assert.throws(() => validateCustom({ name: 'X', command: 'agent; rm -rf /' }))
  assert.throws(() => validateCustom({ name: '', command: 'a' }))
})

test('routes and modes', () => {
  assert.equal(isLocalAgentRoute('devin-cli'), true)
  assert.equal(isLocalAgentRoute('acp-custom'), true)
  assert.equal(isLocalAgentRoute('deepseek'), false)
  assert.equal(cliMode('acp', 'read-only', [{ id: 'ask' }, { id: 'bypass' }]), 'ask')
  assert.equal(cliMode('acp', 'danger-full-access', [{ id: 'ask' }, { id: 'bypass' }]), 'bypass')
  assert.equal(cliMode('claude', 'workspace-write'), 'acceptEdits')
})

test('listModels reports the probe session\'s model options plus CLI default', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const models = await adapter.listModels('acp-fake')
  assert.deepEqual(models.map(model => model.id), ['default', 'fake-large', 'fake-small'])
  assert.equal(models[0].name, 'CLI default')
})

test('codex app-server: thread per session, models from model/list', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const models = await adapter.listModels('codex-cli')
  assert.deepEqual(models.map(model => model.id), ['default', 'gpt-5.1-codex'])
  const out = await collect(adapter.stream(options('s1', [user('m1', 'fix it')], { provider: 'codex-cli' })))
  assert.match(out.text, /fix it/)
  assert.match(out.thinking, /▸/)
})

test('claude stream-json: thinking, activity line, usage', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const out = await collect(adapter.stream(options('s1', [user('m1', 'fix it')], { provider: 'claude-code' })))
  assert.match(out.text, /fix it/)
  assert.match(out.thinking, /thought about/)
  assert.match(out.thinking, /▸ Read/)
  assert.ok(out.usage.inputTokens === 10)
})

test('MCP: bad token gets 401, tools/list flattens schemas', async () => {
  const mcp = new LoopbackMcp(() => [{ name: 'message_bot', description: 'd', parameters: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['x'] } }], async () => ({ text: 'done' }))
  await mcp.listen()
  const url = mcp.url
  const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' })
  assert.equal(bad.status, 401)
  const good = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  const list = (await good.json()).result
  assert.equal(list.tools[0].name, 'message_bot')
  assert.equal(list.tools[0].inputSchema.properties.x.type, 'string')
  mcp.close()
})

test('the adapter\'s MCP server lists the current turn\'s tools (#1061)', async () => {
  const adapter = makeAdapter()
  const live = { pending: new Map(), push: () => {} }
  const list = async (mcp) => {
    const response = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    assert.equal(response.status, 200)
    return (await response.json()).result.tools.map(tool => tool.name)
  }
  const mcp = await adapter.ensureMcp(live, () => [{ name: 'message_bot', parameters: { type: 'object', properties: {} } }])
  try {
    assert.deepEqual(await list(mcp), ['message_bot'])
    const again = await adapter.ensureMcp(live, () => [{ name: 'post_to_group', parameters: { type: 'object', properties: {} } }])
    assert.equal(again, mcp, 'one server per live session')
    assert.deepEqual(await list(mcp), ['post_to_group'])
  } finally {
    mcp.close()
    // fetch keeps the socket alive; on Windows a forced exit with it still
    // closing trips a libuv assertion.
    mcp.server.closeAllConnections()
  }
})

test('flattenSchema removes unions, refs and const', () => {
  const flat = flattenSchema({ type: 'object', $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a' }, q: { const: 'x' }, r: { oneOf: [{ type: 'null' }, { type: 'number' }] } } })
  assert.equal(flat.$defs, undefined)
  assert.equal(flat.properties.p.$ref, undefined)
  assert.equal(flat.properties.q.const, undefined)
  assert.equal(flat.properties.r.type, 'number')
})

// The steward must never touch an abot's Session: the pre-step listener returns
// early for a local-agent Bot, and checkContext leaves too.
test('the steward leaves a local-agent Session alone', async () => {
  const ctx = fakeContext()
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'acp-fake/default' }
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [] },
    warnings: [],
    warn() {},
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    chatOf: () => 's1',
    isBotSession: id => id === 's1',
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('acp-'),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    partsOf: () => [],
    resolveAgent: async id => ({ id, session: { id, deriveMessages: () => [] }, status: 'idle' }),
    teamTools: [],
  }
  partsInstall(rt)
  const listener = ctx.listeners.get('agent/pre-step')?.[0]
  assert.ok(listener !== undefined)
  const agent = { id: 's1', session: { id: 's1', deriveMessages: () => [] }, status: 'idle' }
  const next = async () => 'next-called'
  const result = await listener({ agent, messages: [] }, next)
  assert.equal(result, 'next-called')
})

// A manual new part gives the deterministic handoff: verbatim tail + anchors +
// the read_own_chat line, with no model call.
test('a fresh part carries the deterministic handoff', async () => {
  const ctx = fakeContext()
  ctx.workspaceRegistry = { archiveSession: async () => {}, unarchiveSession: async () => {} }
  ctx.sessions = { flush: async () => {} }
  const messages = Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, who: i % 2 ? 'you' : 'user', text: `line ${i + 1}` }))
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'acp-fake/default', segments: [] }
  const followed = []
  const delivered = []
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: (...args) => rt.warnings.push(args.join(' ')),
    warnings: [],
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    isMain: () => false,
    chatOf: () => 's1',
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('acp-'),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: new Map(),
    groupSessionsOf: () => [],
    unreadOf: () => [],
    clock: () => 'now',
    partsOf: () => (bot.segments ?? []).map(segment => segment.sessionId),
    partLines: async function* () { for (const line of messages) yield line },
    eventsBackwards: async function* () {
      for (const line of [...messages].reverse()) {
        yield line.who === 'user'
          ? { type: 'user/message', time: line.seq, seq: line.seq, data: { content: [{ type: 'text', text: line.text }], source: { kind: 'user' } } }
          : { type: 'assistant/message', time: line.seq, seq: line.seq, data: { message: { content: [{ type: 'text', text: line.text }] } } }
      }
    },
    historyEntry: () => undefined,
    displayItems: async () => [],
    earlierPage: async () => ({}),
    chatPage: async () => ({}),
    noteText: () => '',
    followFolder: async () => {},
    heldBack: () => [],
    resolveAgent: async id => ({ id, session: { id, deriveMessages: () => messages.map(line => ({ role: line.who === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text: line.text }] })) }, status: 'idle', followup: (message) => followed.push(message), whenIdle: async () => {}, runMaintenance: async fn => fn(AbortSignal.timeout(5_000)), inbox: { nextStep: [], nextTurn: [] }, send: async () => {} }),
    createSession: async () => 's2',
    desiredModel: async bot => bot.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    sessionTitle: { rename: async () => {} },
    deliver: async (message) => delivered.push(message),
    teamFolder: () => '/tmp/team',
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    uiLanguage: () => 'en',
    roomProgress: new Map(),
    resolveModelInfo: async () => ({}),
    llmRequests: new Map(),
  }
  partsInstall(rt)
  assert.equal(typeof rt.newPart, 'function')
  await rt.newPart('s1')
  // The switch runs as a job; the Bot lands on s2 with s1 kept as an earlier part.
  for (let i = 0; i < 50 && bot.sessionId !== 's2'; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(bot.sessionId, 's2', rt.warnings.join(' | '))
  assert.equal(bot.segments.length, 1)
  assert.equal(bot.segments[0].sessionId, 's1')
  const text = [...followed, ...delivered].map(message => message?.content?.map?.(block => block.text).join('') ?? message?.text ?? String(message)).join('\n')
  assert.match(text, /fresh conversation was started|previous part|read_own_chat/i)
})

test('an open-ended request outlives the default deadline', async () => {
  const peer = new JsonRpcPeer(() => {})
  const open = peer.request('session/prompt', {}, { timeout: 0 })
  const deadline = peer.request('session/load', {}, { timeout: 40 })
  const settled = deadline.then(() => 'ok', () => 'timeout')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(await settled, 'timeout', 'a positive timeout still fires')
  peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }))
  assert.deepEqual(await open, { stopReason: 'end_turn' }, 'a 0 timeout never expires')
})
