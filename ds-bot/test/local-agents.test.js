import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { JsonRpcPeer, wireProcess } from '../src/host/local-agents/jsonrpc.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { LoopbackMcp, flattenSchema } from '../src/host/local-agents/mcp.js'
import { cleanEnv } from '../src/host/local-agents/discover.js'
import { validateCustom, isLocalAgentRoute, cliMode, acpMode } from '../src/host/local-agents/engines.js'
import { install as partsInstall } from '../src/host/parts.js'
import { install as modelsInstall } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const FIXTURES = { acp: FIXTURE('fake-acp.mjs'), codex: FIXTURE('fake-codex.mjs'), claude: FIXTURE('fake-claude.mjs') }

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
const toolResult = (id, callId, text, isError = false) => ({ id, role: 'tool', content: [{ type: 'text', text }], toolCallId: callId, isError, source: { kind: 'tool', callId } })

// An adapter wired to the fake CLIs: every engine route spawns `node fixture`.
function makeAdapter({ records = {}, preset = 'workspace-write', acp = FIXTURES.acp, acpArgs = [], codex = FIXTURES.codex, codexArgs = [], claude = FIXTURES.claude, claudeArgs = [] } = {}) {
  const files = { acp, codex, claude }
  const spawned = []
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }, { id: 'fake2', name: 'Fake ACP 2', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = kind === 'acp' ? new AcpEngine(route, { ...spec, command: process.execPath, args: [files.acp, ...acpArgs] }, { findExecutable: path => path })
        : kind === 'codex' ? new CodexEngine(route, { ...spec, command: process.execPath, args: [files.codex, ...codexArgs] }, { findExecutable: path => path })
          : new ClaudeEngine(route, { ...spec, command: process.execPath, args: [files.claude, ...claudeArgs] }, { findExecutable: path => path })
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

// Wait for the agent process behind a live session to exit.
async function waitForDead(adapter, sessionId = 's1') {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (adapter.live.get(sessionId)?.engineSession?.dead === true) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the agent process did not exit')
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

const options = (sessionId, messages, extra = {}) => ({ provider: 'local-acp-fake', model: 'default', sessionId, messages, tools: [{ name: 'message_bot' }], signal: AbortSignal.timeout(60_000), ...extra })

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
test('a call to the dsbot server is allowed once without asking; other servers still ask', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const team = await collect(adapter.stream(options('s1', [user('m1', 'team-permission')])))
  // The MCP call itself reaches DS Bot's tools; no approval card in between.
  assert.equal(team.calls[0]?.name, 'message_bot', JSON.stringify(team))
  const done = await collect(adapter.stream(options('s1', [user('m1', 'team-permission'), toolResult('m2', team.calls[0].id, 'River: pong')])))
  assert.match(done.text, /allowed via allow-once; tool said: River: pong/)
  const other = await collect(adapter.stream(options('s2', [user('m1', 'other-permission')])))
  assert.equal(other.calls[0]?.name, 'approve_agent_action')
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
  assert.ok(env.PATH.startsWith(process.env.PATH))
})

// A Dock-launched app has PATH=/usr/bin:/bin:…; a CLI found in ~/.local/bin or
// Homebrew must also find its `#!/usr/bin/env node` there.
test('agent env PATH includes the folders CLIs are found in', { skip: process.platform === 'win32' }, () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
  const home = mkdtempSync(join(tmpdir(), 'dsbot-home-'))
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  process.env.HOME = home
  process.env.PATH = '/usr/bin:/bin'
  try {
    const dirs = cleanEnv().PATH.split(':')
    assert.deepEqual(dirs.slice(0, 2), ['/usr/bin', '/bin'])
    assert.ok(dirs.includes(join(home, '.local', 'bin')))
    assert.equal(cleanEnv({ PATH: '/only' }).PATH, '/only')
  } finally {
    Object.assign(process.env, saved)
  }
})

test('custom agent validation', () => {
  assert.deepEqual(validateCustom({ name: 'Mine', command: 'my-agent', args: ['acp', '--fast'] }), { name: 'Mine', command: 'my-agent', args: ['acp', '--fast'] })
  assert.throws(() => validateCustom({ name: 'X', command: 'a b' }))
  assert.throws(() => validateCustom({ name: 'X', command: 'agent; rm -rf /' }))
  assert.throws(() => validateCustom({ name: '', command: 'a' }))
})

test('routes and modes', () => {
  assert.equal(isLocalAgentRoute('local-devin-cli'), true)
  assert.equal(isLocalAgentRoute('local-acp-custom'), true)
  assert.equal(isLocalAgentRoute('deepseek'), false)
  assert.equal(acpMode('read-only', [{ id: 'ask' }, { id: 'bypass' }]), 'ask')
  assert.equal(acpMode('danger-full-access', [{ id: 'ask' }, { id: 'bypass' }]), 'bypass')
  // Config options name a mode by `value`; an agent without a match keeps its own.
  assert.equal(acpMode('read-only', [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }]), 'ask')
  assert.equal(acpMode('workspace-write', [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }]), undefined)
  assert.equal(cliMode('claude', 'workspace-write'), 'acceptEdits')
  assert.equal(cliMode('acp', 'workspace-write'), undefined)
})

test('acp: a resumed session that lists no modes keeps the ones its CLI listed', async (t) => {
  const records = { s2: { route: 'local-acp-fake', cliSessionId: 'acp-old', model: 'default' } }
  const adapter = makeAdapter({ records, preset: 'workspace-write', acpArgs: ['--cursor-modes'] })
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('s1', [user('m1', 'show-mode')])))
  // session/load lists nothing; without what session/new listed, the guess
  // accept-edits would be sent and refused twice.
  const resumed = await collect(adapter.stream(options('s2', [user('m1', 'show-mode')])))
  assert.match(resumed.text, /mode: agent; refused: 0/)
})

test('acp: full access allows and read-only refuses a change without a card', async (t) => {
  const full = makeAdapter({ preset: 'danger-full-access', acpArgs: ['--cursor-modes'] })
  const readOnly = makeAdapter({ preset: 'read-only', acpArgs: ['--cursor-modes'] })
  t.after(() => Promise.all([full, readOnly].map(adapter => adapter.dispose())))
  // Cursor has no bypass mode: the preset is kept by DS Bot's own answer.
  const allowed = await collect(full.stream(options('s1', [user('m1', 'ask-permission')])))
  assert.equal(allowed.calls.length, 0)
  assert.match(allowed.text, /allowed via allow-once/)
  const refused = await collect(readOnly.stream(options('s1', [user('m1', 'ask-permission')])))
  assert.equal(refused.calls.length, 0)
  assert.match(refused.text, /denied/)
})

test('devin: a call to the dsbot server is allowed once without asking; other servers still ask', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const team = await collect(adapter.stream(options('s1', [user('m1', 'devin-team')])))
  assert.equal(team.calls[0]?.name, 'message_bot', JSON.stringify(team))
  const done = await collect(adapter.stream(options('s1', [user('m1', 'devin-team'), toolResult('m2', team.calls[0].id, 'River: pong')])))
  assert.match(done.text, /allowed via allow_once; tool said: River: pong/)
  const other = await collect(adapter.stream(options('s2', [user('m1', 'devin-other')])))
  assert.equal(other.calls[0]?.name, 'approve_agent_action')
})

test('acp: a dsbot call with no one-time allow still asks', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const asked = await collect(adapter.stream(options('s1', [user('m1', 'team-permission always-only')])))
  assert.equal(asked.calls[0]?.name, 'approve_agent_action')
})

test('acp: the preset picks among the modes the session lists', async (t) => {
  const plain = makeAdapter({ preset: 'workspace-write' })
  const readOnly = makeAdapter({ preset: 'read-only', acpArgs: ['--cursor-modes'] })
  const write = makeAdapter({ preset: 'workspace-write', acpArgs: ['--cursor-modes'] })
  t.after(() => Promise.all([plain, readOnly, write].map(adapter => adapter.dispose())))
  assert.match((await collect(plain.stream(options('s1', [user('m1', 'show-mode')])))).text, /mode: accept-edits; refused: 0/)
  assert.match((await collect(readOnly.stream(options('s1', [user('m1', 'show-mode')])))).text, /mode: ask; refused: 0/)
  // Cursor has no accept-edits: it stays in its own agent mode and asks before acting.
  assert.match((await collect(write.stream(options('s1', [user('m1', 'show-mode')])))).text, /mode: agent; refused: 0/)
})

test('probeModels reports the probe session\'s model options plus CLI default', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const models = await adapter.probeModels('local-acp-fake')
  assert.deepEqual(models.map(model => model.id), ['default', 'fake-large', 'fake-small'])
  assert.equal(models[0].name, 'CLI default')
})

test('codex app-server: thread per session, models from model/list', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const models = await adapter.probeModels('local-codex-cli')
  assert.deepEqual(models.map(model => model.id), ['default', 'gpt-5.1-codex'])
  const out = await collect(adapter.stream(options('s1', [user('m1', 'fix it')], { provider: 'local-codex-cli' })))
  assert.match(out.text, /fix it/)
  assert.match(out.thinking, /▸/)
})

// #1144: Codex 0.166 reads ThreadStartParams at the top level and the MCP servers from
// `config`; keys it does not know are dropped silently. With the old snake_case shape
// the team tools never registered and the permission preset never applied.
test('codex app-server: thread start and resume send the fields Codex reads', async () => {
  for (const [preset, sandbox, approvalPolicy] of [
    ['read-only', 'read-only', 'on-request'],
    ['workspace-write', 'workspace-write', 'on-request'],
    ['danger-full-access', 'danger-full-access', 'never'],
  ]) {
    const record = join(mkdtempSync(join(tmpdir(), 'dsb-codex-params-')), 'params.jsonl')
    const records = {}
    const messages = [system('sys', 'You are Kai, a coder.'), user('m1', 'hello')]
    const first = makeAdapter({ preset, records, codexArgs: ['--record', record] })
    try {
      await collect(first.stream(options('s1', messages, { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
    } finally {
      await first.dispose()
    }
    // A new host resumes the thread the first one saved.
    const second = makeAdapter({ preset, records, codexArgs: ['--record', record] })
    try {
      await collect(second.stream(options('s1', [...messages, user('m2', 'again')], { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
    } finally {
      await second.dispose()
    }
    const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const start = calls.find(call => call.method === 'thread/start')?.params
    const resume = calls.find(call => call.method === 'thread/resume')?.params
    assert.ok(start !== undefined, `${preset}: a thread starts`)
    assert.ok(resume !== undefined, `${preset}: the saved thread resumes`)
    // The team instructions travel on the new thread; a resumed one keeps its own.
    assert.equal(start.developerInstructions, 'You are Kai, a coder.')
    assert.equal(resume.developerInstructions, undefined, `${preset} resume: keeps the instructions it started with`)
    assert.equal(resume.threadId, records.s1.cliSessionId, `${preset} resume: resumes the saved thread`)
    assert.equal('threadId' in start, false, `${preset} start: no thread id`)
    for (const [phase, params] of [['start', start], ['resume', resume]]) {
      assert.equal(params.sandbox, sandbox, `${preset} ${phase}: sandbox`)
      assert.equal(params.approvalPolicy, approvalPolicy, `${preset} ${phase}: approvalPolicy`)
      assert.equal(params.cwd, records.s1.cwd, `${preset} ${phase}: cwd`)
      assert.equal(params.model, 'gpt-5.1-codex', `${preset} ${phase}: model`)
      const server = params.config?.mcp_servers?.dsbot
      assert.match(server?.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\//, `${preset} ${phase}: MCP url`)
      assert.match(server?.http_headers?.Authorization ?? '', /^Bearer \S+$/, `${preset} ${phase}: MCP auth`)
      for (const wrong of ['sandbox_mode', 'approval_policy', 'developer_instructions', 'mcp_servers']) {
        assert.equal(wrong in params, false, `${preset} ${phase}: ${wrong} must not be sent`)
      }
    }
  }
})

// Codex 0.166 takes camelCase fields on thread/start and drops any other one
// without a word: the Bot's permission preset, the team instructions and DS
// Bot's tool server must arrive in the fields it reads.
test('codex: a thread opens with the permission preset, instructions and tool server it reads', async (t) => {
  const adapter = makeAdapter({ preset: 'read-only' })
  t.after(() => adapter.dispose())
  const out = await collect(adapter.stream(options('s1', [system('p1', 'Team rule: be brief.'), user('m1', 'show-thread')], { provider: 'local-codex-cli' })))
  const params = JSON.parse(out.text)
  assert.equal(params.sandbox, 'read-only')
  assert.equal(params.approvalPolicy, 'on-request')
  assert.match(params.developerInstructions, /be brief/)
  const server = params.config.mcp_servers.dsbot
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:/)
  assert.match(server.http_headers.Authorization, /^Bearer /)
})

// The level goes on the request that starts the turn, so a Bot's choice travels
// with every turn and a Bot without one keeps the CLI's own default.
test('codex: the chosen thinking level reaches the turn', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const chosen = await collect(adapter.stream(options('s1', [user('m1', 'fix it')], { provider: 'local-codex-cli', reasoningEffort: 'high' })))
  assert.match(chosen.text, /effort=high/)
  const none = await collect(adapter.stream(options('s2', [user('m1', 'fix it')], { provider: 'local-codex-cli' })))
  assert.match(none.text, /effort=none/)
})

// What the model catalog shows for a codex ref is what model/list advertises.
test('the catalog carries the thinking levels a codex model serves', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  // The menu lists a CLI's models once it has been asked for them.
  await adapter.probeModels('local-codex-cli')
  const rt = {
    ctx: {
      llm: {
        listProviders: () => [{ id: 'local-codex-cli' }],
        listModels: async () => adapter.listModels('local-codex-cli'),
        resolveModelInfo: (provider, model) => adapter.resolveModel(provider, model),
      },
    },
    state: { bots: { b1: { model: 'local-codex-cli/gpt-5.1-codex' } } },
  }
  modelsInstall(rt)
  const entry = (await rt.catalog()).find(candidate => candidate.ref === 'local-codex-cli/gpt-5.1-codex')
  assert.deepEqual(entry.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  // The CLI's own default is not advertised: a Bot without a level keeps the
  // one the user set in their Codex config.
  assert.equal(entry.reasoning.defaultEffort, undefined)
})

// An engine that advertises no level keeps today's behaviour: none, no error.
test('an engine without levels reports none', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  assert.equal((await adapter.resolveModel('local-claude-code', 'default')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('local-acp-fake', 'default')).reasoning, undefined)
})

// Codex 0.153+ asks before every MCP tool call under on-request (#1089).
test('codex app-server: approves tool calls on DS Bot\'s own MCP server, refuses others', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const answer = async (sessionId, text) => JSON.parse((await collect(adapter.stream(options(sessionId, [user('m1', text)], { provider: 'local-codex-cli' })))).text)
  assert.deepEqual(await answer('s1', 'elicit dsbot mcp_tool_call'), { action: 'accept', content: null, _meta: null })
  assert.deepEqual(await answer('s2', 'elicit github mcp_tool_call'), { error: -32601 })
  assert.deepEqual(await answer('s3', 'elicit dsbot form'), { error: -32601 })
})

test('claude stream-json: thinking, activity line, usage', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const out = await collect(adapter.stream(options('s1', [user('m1', 'fix it')], { provider: 'local-claude-code' })))
  assert.match(out.text, /fix it/)
  assert.match(out.thinking, /thought about/)
  assert.match(out.thinking, /▸ Read/)
  assert.ok(out.usage.inputTokens === 10)
})

test('a write to a CLI that has exited does not throw out of DS Bot', async () => {
  const unheard = []
  const hear = error => unheard.push(error)
  process.on('uncaughtException', hear)
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['pipe', 'pipe', 'inherit'] })
    const peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    // A cancel that goes out as the process is let go of, as closing a Session does.
    child.kill('SIGTERM')
    for (let i = 0; i < 20; i += 1) peer.notify('session/cancel', { sessionId: 'x'.repeat(65536) })
    await new Promise(resolve => child.on('exit', resolve))
    const claude = new ClaudeEngine('local-claude-code', { name: 'Claude Code', command: process.execPath, args: [FIXTURES.claude] }, { findExecutable: path => path })
    const session = await claude.open('s1', { cwd: tmpdir() })
    const cli = session.child
    cli.kill('SIGTERM')
    for (let i = 0; i < 20; i += 1) session.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(65536) }] } })
    await new Promise(resolve => cli.on('exit', resolve))
    await new Promise(resolve => setTimeout(resolve, 200))
  } finally {
    process.off('uncaughtException', hear)
  }
  assert.deepEqual(unheard.map(error => error.code), [])
})

// A CLI that exists but cannot run (a broken install, a missing interpreter)
// fails spawn with 'error', not 'exit'; unheard it took the whole host down.
test('a CLI that cannot start fails its probe as a typed error, not the host', async () => {
  const broken = join(mkdtempSync(join(tmpdir(), 'dsb-broken-')), 'broken-cli')
  writeFileSync(broken, '#!/missing/interpreter/never\nexit 1\n', { mode: 0o755 })
  const unheard = []
  const hear = error => unheard.push(error)
  process.on('uncaughtException', hear)
  try {
    for (const Engine of [AcpEngine, CodexEngine]) {
      const engine = new Engine('local-broken', { name: 'Broken CLI', command: broken, args: [] }, { findExecutable: () => broken })
      await assert.rejects(() => engine.ensure(), error => error.code === 'LOCAL_AGENT_EXIT' && /could not start/.test(error.message))
      // The failed process is let go of: the next ensure() tries a fresh one.
      assert.equal(engine.peer, undefined)
      assert.equal(engine.child, undefined)
    }
  } finally {
    process.off('uncaughtException', hear)
  }
  assert.deepEqual(unheard, [])
})

test('claude: another model restarts only that conversation\'s process, with its new tool server', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const claude = (id, messages, extra = {}) => adapter.stream(options(id, messages, { provider: 'local-claude-code', ...extra }))
  await collect(claude('s1', [user('m1', 'one')]))
  await collect(claude('s2', [user('m1', 'two')]))
  const engine = adapter.engines.get('local-claude-code')
  const [first, other] = [engine.sessions.get('s1').child, engine.sessions.get('s2').child]
  const out = await collect(claude('s1', [user('m1', 'one'), user('m2', 'again')], { model: 'sonnet' }))
  assert.match(out.text, /again/)
  const args = engine.sessions.get('s1').child.spawnargs
  assert.notEqual(engine.sessions.get('s1').child, first)
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
  assert.match(args[args.indexOf('--mcp-config') + 1], new RegExp(adapter.live.get('s1').mcp.url))
  assert.equal(engine.sessions.get('s2').child, other)
  assert.equal(other.killed, false)
})

// Claude Code 2.1.302 sends `system/init` only once the first message arrives,
// so waiting for it before the first prompt would deadlock every turn.
test('claude: a CLI that sends init only after the first prompt still starts', async (t) => {
  const engine = new ClaudeEngine('local-claude-code', { name: 'Claude Code', kind: 'claude', command: process.execPath, args: [FIXTURE('fake-claude-lazy-init.mjs')] }, { findExecutable: path => path })
  t.after(() => engine.close())
  const session = await Promise.race([
    engine.open('s-lazy', { cwd: mkdtempSync(join(tmpdir(), 'dsb-cwd-')), mode: 'acceptEdits' }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('start() waited for system/init')), 10_000).unref() }),
  ])
  await session.prompt([{ type: 'text', text: 'hello' }])
  const seen = []
  for (;;) {
    const event = await session.next()
    seen.push(event.type)
    if (event.type === 'done') break
  }
  assert.deepEqual(seen, ['text', 'done'])
  assert.match(session.cliSessionId, /^claude-/)
})

// The id arrives with init, after the adapter has already saved its record: the
// saved record is what a restarted host resumes from.
test('claude: the session id from init is saved and the next host resumes it', async (t) => {
  const records = {}
  const lazy = FIXTURE('fake-claude-lazy-init.mjs')
  const first = makeAdapter({ records, claude: lazy })
  t.after(() => first.dispose())
  const out = await collect(first.stream(options('s1', [user('m1', 'hello')], { provider: 'local-claude-code' })))
  assert.match(out.text, /hello/)
  assert.match(records.s1.cliSessionId, /^claude-/)
  // A new adapter is a host restart: the saved record is all it has.
  const second = makeAdapter({ records, claude: lazy })
  t.after(() => second.dispose())
  const resumed = await collect(second.stream(options('s1', [user('m2', 'again')], { provider: 'local-claude-code' })))
  assert.match(resumed.text, new RegExp(`resume=${records.s1.cliSessionId}`))
})

// A write to a CLI that dies while it starts fails asynchronously on stdin; an
// unhandled stream error takes the whole host down instead of failing one turn.
test('claude: a prompt written as the CLI dies becomes a typed error', async (t) => {
  const engine = new ClaudeEngine('local-claude-code', { name: 'Claude Code', kind: 'claude', command: process.execPath, args: [FIXTURE('fake-claude-dead.mjs')] }, { findExecutable: path => path })
  t.after(() => engine.close())
  const session = await engine.open('s-dead', { cwd: mkdtempSync(join(tmpdir(), 'dsb-cwd-')), mode: 'acceptEdits' })
  // Larger than the pipe buffer and written while the CLI is still starting, so
  // the write is pending when the process goes away.
  await session.prompt([{ type: 'text', text: 'x'.repeat(200_000) }])
  const failure = await Promise.race([
    (async () => {
      for (;;) {
        const event = await session.next()
        if (event.type === 'error' && /stopped reading input/.test(event.error.message)) return event
      }
    })(),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('the stdin failure never reached the queue')), 10_000).unref() }),
  ])
  assert.equal(failure.error.code, 'LOCAL_AGENT_EXIT')
})

// A resume that dies before init must not erase the id the record already has:
// the next host would have nothing to resume and would send only the delta.
test('claude: a failed resume keeps the saved session id', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const records = {}
  const claude = FIXTURE('fake-claude-flaky.mjs')
  const host = () => {
    const adapter = makeAdapter({ records, claude, claudeArgs: [runs, '2'] })
    t.after(() => adapter.dispose())
    return adapter
  }
  const first = await collect(host().stream(options('s1', [user('m1', 'hello')], { provider: 'local-claude-code' })))
  assert.match(first.text, /hello/)
  const saved = records.s1.cliSessionId
  assert.match(saved, /^claude-/)
  // The second host resumes, and this CLI run dies before `system/init`.
  await assert.rejects(collect(host().stream(options('s1', [user('m2', 'again')], { provider: 'local-claude-code' }))), error => error.code === 'LOCAL_AGENT_EXIT')
  assert.equal(records.s1.cliSessionId, saved)
  // The third host still resumes the conversation the first one started.
  const third = await collect(host().stream(options('s1', [user('m3', 'third')], { provider: 'local-claude-code' })))
  assert.match(third.text, new RegExp(`resume=${saved}`))
})

// Claude Code deletes old conversations. Resuming one that is gone fails at
// once; the turn must start a new conversation with the history, not fail on
// the same id every time.
test('claude: a saved conversation the CLI no longer has starts over with the history', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const records = { s1: { route: 'local-claude-code', cliSessionId: 'claude-gone', cwd: tmpdir(), handedId: 'm1' } }
  const adapter = makeAdapter({ records, claude: FIXTURE('fake-claude-flaky.mjs'), claudeArgs: [runs, '', 'claude-gone'] })
  t.after(() => adapter.dispose())
  const history = [user('m1', 'fix the login'), user('m2', 'and the logout')]
  const out = await collect(adapter.stream(options('s1', history, { provider: 'local-claude-code', signal: AbortSignal.timeout(15_000) })))
  assert.equal(out.finish.kind, 'stop')
  assert.match(out.text, /resume=none/)
  assert.equal(readFileSync(runs, 'utf8'), '2')
  const prompts = readFileSync(`${runs}.prompts`, 'utf8')
  assert.match(prompts, /fix the login/, 'the new conversation gets the history')
  assert.match(prompts, /and the logout/)
  for (let i = 0; i < 40 && records.s1.cliSessionId === 'claude-gone'; i += 1) await new Promise(resolve => setTimeout(resolve, 25))
  assert.match(records.s1.cliSessionId, /^claude-(?!gone)/)
})

// A CLI that exits before init for another reason keeps its id (above); only a
// conversation the CLI reports missing is dropped.
test('claude: print mode asks DS Bot for permission and lets team tools through', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('s1', [user('m1', 'hello')], { provider: 'local-claude-code' })))
  const args = adapter.engines.get('local-claude-code').sessions.get('s1').child.spawnargs
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__dsbot')
})

// A CLI that exits before init leaves a dead bridge: the retry must start a
// new process instead of writing into the one that is gone.
test('claude: a retry after a pre-init exit starts a new CLI', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const adapter = makeAdapter({ claude: FIXTURE('fake-claude-flaky.mjs'), claudeArgs: [runs, '1'] })
  t.after(() => adapter.dispose())
  await assert.rejects(collect(adapter.stream(options('s1', [user('m1', 'hello')], { provider: 'local-claude-code' }))), error => error.code === 'LOCAL_AGENT_EXIT')
  const out = await collect(adapter.stream(options('s1', [user('m2', 'again')], { provider: 'local-claude-code', signal: AbortSignal.timeout(15_000) })))
  assert.equal(out.finish.kind, 'stop')
  assert.match(out.text, /again/)
  assert.equal(readFileSync(runs, 'utf8'), '2')
})

// The failed prompt was handed but never read: the retry must send it again,
// not only what came after it.
test('claude: the retry replays the input the dead CLI never read', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const adapter = makeAdapter({ claude: FIXTURE('fake-claude-flaky.mjs'), claudeArgs: [runs, '1'] })
  t.after(() => adapter.dispose())
  const history = [user('m1', 'fix the login')]
  await assert.rejects(collect(adapter.stream(options('s1', history, { provider: 'local-claude-code' }))), error => error.code === 'LOCAL_AGENT_EXIT')
  // The same full history comes back, as DS Bot resends the conversation.
  const out = await collect(adapter.stream(options('s1', history, { provider: 'local-claude-code', signal: AbortSignal.timeout(15_000) })))
  assert.equal(out.finish.kind, 'stop')
  assert.match(readFileSync(`${runs}.prompts`, 'utf8'), /fix the login/)
})

// The repair card's Retry adds a `continue` message; the new CLI must still see
// the user message that never got an answer.
test('claude: the retry flow replays the unanswered message', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const adapter = makeAdapter({ claude: FIXTURE('fake-claude-flaky.mjs'), claudeArgs: [runs, '1'] })
  t.after(() => adapter.dispose())
  const asked = user('m1', 'fix the login')
  await assert.rejects(collect(adapter.stream(options('s1', [asked], { provider: 'local-claude-code' }))), error => error.code === 'LOCAL_AGENT_EXIT')
  const retry = {
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: "[Retry after a failed turn]\nYour last turn failed (LOCAL_AGENT_EXIT) and the user has fixed it. Answer the user's last unanswered message." }],
    source: { kind: 'bot', form: 'relay', role: 'continue' },
  }
  const out = await collect(adapter.stream(options('s1', [asked, retry], { provider: 'local-claude-code', signal: AbortSignal.timeout(15_000) })))
  assert.equal(out.finish.kind, 'stop')
  const prompts = readFileSync(`${runs}.prompts`, 'utf8')
  assert.match(prompts, /fix the login/)
  assert.match(prompts, /last unanswered message/)
})

// The rollback is saved, not only kept in memory: a host that restarts after a
// failed start rebuilds its live state from the record.
test('claude: a host restart after a failed start still replays the unread input', async (t) => {
  const runs = join(mkdtempSync(join(tmpdir(), 'dsb-claude-')), 'runs')
  const records = {}
  const claude = FIXTURE('fake-claude-flaky.mjs')
  const host = () => {
    const adapter = makeAdapter({ records, claude, claudeArgs: [runs, '1'] })
    t.after(() => adapter.dispose())
    return adapter
  }
  const history = [user('m1', 'fix the login')]
  await assert.rejects(collect(host().stream(options('s1', history, { provider: 'local-claude-code' }))), error => error.code === 'LOCAL_AGENT_EXIT')
  // The first host is gone: the saved record is all the new one has.
  const out = await collect(host().stream(options('s1', history, { provider: 'local-claude-code', signal: AbortSignal.timeout(15_000) })))
  assert.equal(out.finish.kind, 'stop')
  assert.match(readFileSync(`${runs}.prompts`, 'utf8'), /fix the login/)
})

// ACP and Codex create their session before the prompt, so a process that exits
// after a turn did read it: reopening sends only the new input, not a replay.
test('acp: a reopen after the process exits sends only the new input', async (t) => {
  const adapter = makeAdapter({ acpArgs: ['--exit-after-turn'] })
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [user('m1', 'alpha-one')])))
  assert.match(first.text, /alpha-one/)
  await waitForDead(adapter)
  const second = await collect(adapter.stream(options('s1', [user('m1', 'alpha-one'), user('m2', 'beta-two')])))
  assert.match(second.text, /beta-two/)
  assert.doesNotMatch(second.text, /alpha-one/)
})

// A reopened Codex thread needs its own queue: a pump still waiting on the dead
// one takes the first event of the new turn, and the reply arrives empty.
test('codex: a resume after the process exits still delivers the reply text', async (t) => {
  const adapter = makeAdapter({ codexArgs: ['--exit-after-turn', '--text-only'] })
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [user('m1', 'alpha-one')], { provider: 'local-codex-cli' })))
  assert.match(first.text, /alpha-one/)
  await waitForDead(adapter)
  const second = await collect(adapter.stream(options('s1', [user('m1', 'alpha-one'), user('m2', 'beta-two')], { provider: 'local-codex-cli' })))
  assert.match(second.text, /beta-two/)
  assert.doesNotMatch(second.text, /alpha-one/)
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
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'local-acp-fake/default' }
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
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-acp-'),
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
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'local-acp-fake/default', segments: [] }
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
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-acp-'),
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
