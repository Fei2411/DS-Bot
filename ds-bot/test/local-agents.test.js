import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine, stdioBridgePath } from '../src/host/local-agents/acp.js'
import { CodexEngine, unwrapShellCommand } from '../src/host/local-agents/codex.js'
import { JsonRpcPeer, wireProcess } from '../src/host/local-agents/jsonrpc.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { LoopbackMcp, flattenSchema } from '../src/host/local-agents/mcp.js'
import { cleanEnv } from '../src/host/local-agents/discover.js'
import { ENGINES, validateCustom, isLocalAgentRoute, cliMode, acpMode } from '../src/host/local-agents/engines.js'
import { AGENT_BADGES, agentAvatar, badgeOf, isLocalRoute } from '../src/client/agent-routes.js'
import { INKS } from '../src/client/inks.js'
import { install as partsInstall } from '../src/host/parts.js'
import { install as modelsInstall } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const FIXTURES = { acp: FIXTURE('fake-acp.mjs'), codex: FIXTURE('fake-codex.mjs'), claude: FIXTURE('fake-claude.mjs') }

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
const toolResult = (id, callId, text, isError = false) => ({ id, role: 'tool', content: [{ type: 'text', text }], toolCallId: callId, isError, source: { kind: 'tool', callId } })

// An adapter wired to the fake CLIs: every engine route spawns `node fixture`.
function makeAdapter({ records = {}, preset = 'workspace-write', acp = FIXTURES.acp, acpArgs = [], cancelAckTimeoutMs, codex = FIXTURES.codex, codexArgs = [], claude = FIXTURES.claude, claudeArgs = [], cwdFor, attachments, fs, rt } = {}) {
  const files = { acp, codex, claude }
  const spawned = []
  const adapter = new LocalAgentAdapter({
    rt: rt ?? { warn: () => {} },
    attachments,
    fs,
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }, { id: 'fake2', name: 'Fake ACP 2', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = kind === 'acp' ? new AcpEngine(route, { ...spec, command: process.execPath, args: [files.acp, ...acpArgs] }, { findExecutable: path => path, cancelAckTimeoutMs })
        : kind === 'codex' ? new CodexEngine(route, { ...spec, command: process.execPath, args: [files.codex, ...codexArgs] }, { findExecutable: path => path })
          : new ClaudeEngine(route, { ...spec, command: process.execPath, args: [files.claude, ...claudeArgs] }, { findExecutable: path => path })
      spawned.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: typeof preset === 'function' ? preset : () => preset,
    cwdFor: cwdFor ?? (async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-'))),
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

test('acp: a stopped prompt cannot fail or finish the following turns', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const control = new AbortController()
  const engine = adapter.engine('local-acp-fake')
  const prompt = engine.prompt.bind(engine)
  let started
  const ready = new Promise(resolve => { started = resolve })
  engine.prompt = async (...args) => {
    const result = prompt(...args)
    // ensure() and the write happen before the test stops this turn.
    await new Promise(resolve => setImmediate(resolve))
    started()
    return result
  }
  const stopped = collect(adapter.stream(options('s1', [user('m1', 'hang')], { signal: control.signal })))
  await ready
  control.abort()
  assert.equal((await stopped).finish.kind, 'aborted')
  const messages = [user('m1', 'hang')]
  for (const text of ['second', 'third']) {
    messages.push(user(text, text))
    const out = await collect(adapter.stream(options('s1', messages)))
    assert.equal(out.text, `ok: ${text}`)
    assert.equal(out.finish.kind, 'stop')
  }
})

test('acp: a missing cancel acknowledgement cannot freeze subsequent turns', async (t) => {
  for (const late of [false, true]) await t.test(late ? 'late reply is ignored' : 'no reply', async (t) => {
    const adapter = makeAdapter({ acpArgs: ['--no-cancel-ack', ...(late ? ['--late-cancel-reply'] : [])], cancelAckTimeoutMs: 20 })
    t.after(() => adapter.dispose())
    await collect(adapter.stream(options('s1', [user('m0', 'hello')])))
    const engine = adapter.engine('local-acp-fake')
    const peer = engine.peer
    const control = new AbortController()
    const stopped = collect(adapter.stream(options('s1', [user('m0', 'hello'), user('m1', 'hang')], { signal: control.signal })))
    // The fake CLI has received the hung prompt before Stop is pressed.
    const request = peer.request.bind(peer)
    let sent
    const ready = new Promise(resolve => { sent = resolve })
    peer.request = (...args) => {
      const result = request(...args)
      if (args[0] === 'session/prompt') sent()
      return result
    }
    await ready
    const oldId = peer.nextId
    control.abort()
    assert.equal((await stopped).finish.kind, 'aborted')
    const messages = [user('m0', 'hello'), user('m1', 'hang'), user('m2', 'second')]
    const next = await collect(adapter.stream(options('s1', messages, { signal: AbortSignal.timeout(1000) })))
    assert.equal(next.finish.kind, 'stop')
    assert.equal(next.text, 'ok: second')
    assert.equal(peer.pending.has(oldId), false)
    messages.push(user('m3', 'third'))
    const third = await collect(adapter.stream(options('s1', messages)))
    assert.equal(third.text, 'ok: third')
    assert.equal(third.finish.kind, 'stop')
  })
})

test('acp: Stop interrupts a new prompt waiting for a missing cancel acknowledgement', async (t) => {
  const adapter = makeAdapter({ acpArgs: ['--no-cancel-ack'], cancelAckTimeoutMs: 10_000 })
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('s1', [user('m0', 'hello')])))
  const engine = adapter.engine('local-acp-fake')
  const session = adapter.live.get('s1').engineSession
  const control = new AbortController()
  const first = engine.prompt(session, [{ type: 'text', text: 'hang' }], { signal: control.signal })
  await new Promise(resolve => setImmediate(resolve))
  const oldId = engine.peer.nextId
  control.abort()
  engine.cancel(session)
  const nextControl = new AbortController()
  const second = engine.prompt(session, [{ type: 'text', text: 'must not send' }], { signal: nextControl.signal })
  const rejected = assert.rejects(second, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  nextControl.abort()
  await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error('Stop did not release the waiting prompt')), 200))])
  assert.equal(engine.peer.nextId, oldId)
  await adapter.dispose()
  await first
})

test('after Stop the next turn receives its first text or permission event', async (t) => {
  for (const type of ['text', 'permission']) await t.test(type, async (t) => {
    const adapter = makeAdapter()
    t.after(() => adapter.dispose())
    const live = await adapter.liveFor(options('s1', []), 'workspace-write')
    live.engineSession = {}
    live.engine.prompt = async () => {}
    live.engine.cancel = () => {}
    const control = new AbortController()
    await adapter.startTurn(live, 'first', control.signal)
    const first = collect(adapter.drain(live, { signal: control.signal }))
    await new Promise(resolve => setImmediate(resolve))
    control.abort()
    assert.equal((await first).finish.kind, 'aborted')
    await adapter.startTurn(live, 'second')
    live.push(type === 'text' ? { type, text: 'first reply' } : {
      type, id: 'first-permission', action: 'Run a command', changes: false,
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }], reply: () => {},
    })
    live.push({ type: 'done', reason: 'end_turn' })
    const second = await collect(adapter.drain(live, {}))
    if (type === 'text') assert.equal(second.text, 'first reply')
    else {
      assert.equal(second.finish.kind, 'tool-calls')
      assert.equal(second.calls[0]?.id, 'first-permission')
    }
    assert.equal(live.waiters.length, 0)
  })
})

test('acp: cancelled wire replies and notices are isolated until the next prompt', async (t) => {
  for (const fails of [false, true]) await t.test(fails ? 'late error' : 'late success', async () => {
    const engine = new AcpEngine('local-acp-fake', {}, {})
    const sent = []
    const peer = new JsonRpcPeer(message => sent.push(message))
    engine.ensure = async () => peer
    engine.peer = peer
    const session = engine.sessionFor('s1')
    session.acpSessionId = 'acp-1'
    const events = []
    session.push = event => events.push(event)
    const notice = text => engine.onNotice('session/update', { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    const control = new AbortController()
    const first = engine.prompt(session, [{ type: 'text', text: 'first' }], { signal: control.signal }).catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    control.abort()
    engine.cancel(session)
    const second = engine.prompt(session, [{ type: 'text', text: 'second' }])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sent.filter(message => message.method === 'session/prompt').length, 1)
    notice('late output')
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, ...(fails ? { error: { code: -32603, message: 'cancelled' } } : { result: { stopReason: 'cancelled' } }) }))
    await first
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, [])
    const request = sent.filter(message => message.method === 'session/prompt').at(-1)
    notice('second answer')
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }))
    await second
    assert.deepEqual(events, [{ type: 'text', text: 'second answer' }, { type: 'done', reason: 'end_turn' }])
    const count = sent.length
    await assert.rejects(engine.prompt(session, [], { signal: control.signal }), { name: 'AbortError' })
    assert.equal(sent.length, count)
  })
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
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH')
  assert.ok(pathKey)
  assert.ok(env[pathKey].startsWith(process.env[pathKey]))
})

test('env sanitization matches the explicit denylist and host prefixes case-insensitively', () => {
  const keys = ['openai_api_key', 'anthropic_auth_token', 'acp_backend', 'ds_bot_fixture_variable', 'dsh_fixture_variable', 'antigravity_fixture_variable', 'agy_fixture_variable', 'deepseek_fixture_variable']
  const before = keys.map(key => [key, process.env[key]])
  try {
    for (const key of keys) process.env[key] = 'fake-env-value'
    const env = cleanEnv({ OPENAI_API_KEY: 'fake-explicit-value', DSH_FIXTURE_VARIABLE: 'fake-explicit-host-value' })
    for (const key of keys) assert.equal(Object.hasOwn(env, key), false, key)
    // An engine's explicit environment is passed in, not inherited, so it stays.
    assert.equal(env.OPENAI_API_KEY, 'fake-explicit-value')
    assert.equal(env.DSH_FIXTURE_VARIABLE, 'fake-explicit-host-value')
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
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

// #1503: a live CLI keeps the permission mode it opened with. Changing the
// Bot's preset must reopen the CLI for the next turn, not wait for a restart.
test('a changed permission preset reopens the local agent for the next turn', async () => {
  let preset = 'workspace-write'
  const adapter = makeAdapter({ preset: () => preset })
  try {
    const first = await collect(adapter.stream(options('s1', [user('m1', 'show-mode')])))
    assert.match(first.text, /mode: accept-edits/)
    preset = 'danger-full-access'
    const second = await collect(adapter.stream(options('s1', [user('m2', 'show-mode')])))
    assert.match(second.text, /mode: bypass/)
  } finally {
    await adapter.dispose()
  }
})

test('codex: a changed permission preset resumes the thread with the new sandbox and approval', async () => {
  let preset = 'workspace-write'
  const record = join(mkdtempSync(join(tmpdir(), 'dsb-codex-preset-')), 'params.jsonl')
  const records = {}
  const adapter = makeAdapter({ preset: () => preset, records, codexArgs: ['--record', record] })
  try {
    const request = (id, text) => options('s1', [user(id, text)], { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })
    await collect(adapter.stream(request('m1', 'hello')))
    preset = 'danger-full-access'
    await collect(adapter.stream(request('m2', 'again')))
  } finally {
    await adapter.dispose()
  }
  const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const resumed = calls.filter(call => call.method === 'thread/resume')
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].params.sandbox, 'danger-full-access')
  assert.equal(resumed[0].params.approvalPolicy, 'never')
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
// A CLI condenses on its own inside a running turn: its part is checked when the turn
// ends (test/local-agent-context.test.js), never before a step.
test('a running turn of a local-agent part is not checked before its steps', async () => {
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
    isLocalAgentRoute: route => route.startsWith('local-acp-'),
    localAgentContext: () => ({ used: 999_999, size: 200_000, compactions: 0 }),
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
  const agent = { id: 's1', session: { id: 's1', deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'local-acp-fake', model: 'default' } }) }, status: 'idle' }
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

test('an aborted JSON-RPC request is removed and its late reply is ignored', async () => {
  const peer = new JsonRpcPeer(() => {})
  const control = new AbortController()
  const first = peer.request('session/prompt', {}, { signal: control.signal, timeout: 0 })
  control.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(peer.pending.size, 0)
  const second = peer.request('session/prompt', {}, { timeout: 0 })
  peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } }))
  peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'late failure' } }))
  assert.equal(peer.pending.size, 1)
  peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }))
  assert.deepEqual(await second, { stopReason: 'end_turn' })
  assert.equal(peer.pending.size, 0)
})

// #1513: a card that suspends the stream can outlive the CLI's turn. The answer must
// start a turn of its own, and the finished turn's leftover events must not answer it.
test('codex app-server: an answer whose turn already ended starts a new turn', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'late-ask')]
  const first = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  const call = first.calls.find(entry => entry.name === 'approve_agent_action')
  assert.ok(call, 'the approval came as a card')
  // The CLI's turn completed while the card was open: its `done` is still queued.
  await new Promise(resolve => setTimeout(resolve, 100))
  const second = await collect(adapter.stream(options('s1', [...messages, toolResult('t1', call.id, '{"decision":"allow"}', false)], { provider: 'local-codex-cli' })))
  // The answer opened a turn of its own, and the stream says what that turn said.
  assert.match(second.text, /ok: /, JSON.stringify(second))
  assert.equal(second.finish?.kind, 'stop')
})

test('codex app-server: a steer refused while the turn ends still gets a turn of its own', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'hold-ask')]
  const first = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  assert.ok(first.calls.some(entry => entry.name === 'approve_agent_action'), 'the card came through')
  // The CLI refuses the steer and completes the turn in the same breath.
  const second = await collect(adapter.stream(options('s1', [...messages, user('m2', 'race')], { provider: 'local-codex-cli' })))
  assert.match(second.text, /ok: race/, JSON.stringify(second))
})

test('codex app-server: text answering a bridged call after the turn ended starts one', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'late-ask')]
  const first = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  assert.ok(first.calls.some(entry => entry.name === 'approve_agent_action'), 'the card came through')
  // A loopback call is still open — browser_handoff and friends look like this — and
  // the user answers it with plain text after the CLI's turn already ended.
  const live = adapter.live.get('s1')
  const answered = []
  live.pending.set('bridged-1', { name: 'browser_handoff', resolve: result => answered.push(result) })
  const second = await collect(adapter.stream(options('s1', [...messages, user('m2', 'yes, go ahead')], { provider: 'local-codex-cli' })))
  assert.deepEqual(answered, [{ text: 'yes, go ahead' }], 'the answer reached the bridged call')
  assert.match(second.text, /ok: The calls that were waiting on the user are settled/, JSON.stringify(second))
})

test('codex app-server: a late notice for an earlier turn keeps the running turn steerable', async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'dsb-late-')), 'record.jsonl')
  const engine = new CodexEngine('local-codex-cli', { name: 'Codex', command: process.execPath, args: [FIXTURES.codex, '--record', recordPath] }, { findExecutable: path => path })
  t.after(() => { engine.close?.() })
  const thread = await engine.open('s1', { cwd: mkdtempSync(join(tmpdir(), 'dsb-late-cwd-')), mode: 'workspace-write' })
  const first = await engine.prompt(thread, [{ type: 'text', text: 'hold' }], {})
  const second = await engine.prompt(thread, [{ type: 'text', text: 'hold' }], {})
  assert.notEqual(first, second)
  // The turn a steer replaced finishes late: its notice must not clear the live turn.
  await engine.steer(thread, `emit-stale ${first}`)
  assert.equal(engine.canSteer(thread), true, 'the running turn stays steerable')
  await engine.steer(thread, 'next input')
  const lines = readFileSync(recordPath, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  const starts = lines.filter(entry => entry.method === 'turn/start')
  assert.equal(starts.length, 2, 'no turn was started to replace the live one')
  const steer = lines.filter(entry => entry.method === 'turn/steer').at(-1)
  assert.equal(steer.params.expectedTurnId, second, 'the next input steers the running turn')
})

test('codex app-server: the approval answer rides along with runtime context in the new turn', async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'dsb-settled-')), 'record.jsonl')
  const adapter = makeAdapter({ codexArgs: ['--record', recordPath] })
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'late-ask')]
  const first = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  const call = first.calls.find(entry => entry.name === 'approve_agent_action')
  assert.ok(call, 'the approval came as a card')
  // The CLI's turn is over. The answer arrives in the same call as runtime context, which
  // used to become the whole prompt and leave the decision behind.
  const context = { id: 'c1', role: 'user', content: [{ type: 'text', text: 'workspace note: the folder is /team' }], source: { kind: 'runtime-context' } }
  await collect(adapter.stream(options('s1', [...messages, toolResult('t1', call.id, '{"decision":"allow"}', false), context], { provider: 'local-codex-cli' })))
  const lines = readFileSync(recordPath, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  const starts = lines.filter(entry => entry.method === 'turn/start')
  const last = starts.at(-1)
  const text = (last?.params?.input ?? []).map(item => item.text ?? '').join('\n')
  assert.match(text, /\{"decision":"allow"\}/, `the decision reached the turn: ${text}`)
  assert.match(text, /workspace note: the folder is \/team/, `the context reached the turn: ${text}`)
})

test('codex app-server: a steer names the turn it steers, and a finished turn cannot be steered', async (t) => {
  const recordPath = join(mkdtempSync(join(tmpdir(), 'dsb-steer-')), 'record.jsonl')
  const engine = new CodexEngine('local-codex-cli', { name: 'Codex', command: process.execPath, args: [FIXTURES.codex, '--record', recordPath] }, { findExecutable: path => path })
  t.after(() => { engine.close?.() })
  const thread = await engine.open('s1', { cwd: mkdtempSync(join(tmpdir(), 'dsb-steer-cwd-')), mode: 'workspace-write' })
  const turnId = await engine.prompt(thread, [{ type: 'text', text: 'hold' }], {})
  assert.equal(engine.canSteer(thread), true, 'the turn is live')
  await engine.steer(thread, 'steer me')
  const lines = readFileSync(recordPath, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  const steer = lines.find(entry => entry.method === 'turn/steer')
  assert.ok(steer, 'a steer was sent')
  assert.equal(steer.params.expectedTurnId, turnId, 'the steer names the turn it steers')
  assert.equal(steer.params.input[0].text, 'steer me')
  // A turn the CLI ends has nothing to steer: it says so instead of dropping the input.
  await engine.prompt(thread, [{ type: 'text', text: 'bye' }], {})
  // The CLI's own turn/completed is the signal: read until it arrives, not for a clock.
  const deadline = Date.now() + 30_000
  for (;;) {
    const event = await Promise.race([
      thread.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no turn/completed')), 30_000)),
    ])
    if (event.type === 'done') break
    if (Date.now() > deadline) throw new Error(`no turn/completed: ${JSON.stringify(event)}`)
  }
  // The engine clears its turn off the same notice; poll that, never wait for a second
  // event that will not come.
  for (let attempt = 0; attempt < 300 && engine.canSteer(thread); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(engine.canSteer(thread), false, 'turn/completed cleared the live turn')
  await assert.rejects(() => engine.steer(thread, 'too late'), /already ended/)
})


test('Codex completion in the same JSON-RPC batch cannot resurrect a live turn', async () => {
  const engine = new CodexEngine('local-codex-cli', {}, { findExecutable: value => value })
  const thread = engine.threadFor('s1')
  thread.threadId = 'thread'
  const peer = new JsonRpcPeer(message => {
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'completed' } } }))
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'completed', status: 'completed' } } }))
  })
  peer.notificationHandler = (method, params) => engine.onNotice(method, params)
  engine.ensure = async () => peer
  assert.equal(await engine.prompt(thread, [{ type: 'text', text: 'go' }], {}), 'completed')
  assert.equal(engine.canSteer(thread), false)
})

test('a late ACP decision discards old output and drains a continuation that asks again', { timeout: 5000 }, async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'late-permission')]
  const first = await collect(adapter.stream(options('s1', messages)))
  await new Promise(resolve => setTimeout(resolve, 50))
  messages.push(toolResult('m2', first.calls[0].id, '{"decision":"allow"}'))
  const second = await collect(adapter.stream(options('s1', messages)))
  assert.equal(second.finish.kind, 'tool-calls')
  assert.equal(second.calls[0].name, 'approve_agent_action')
  assert.doesNotMatch(second.text, /old output/)
  messages.push(toolResult('m3', second.calls[0].id, '{"decision":"allow"}'))
  const third = await collect(adapter.stream(options('s1', messages)))
  assert.match(third.text, /allowed via allow-once/)
})

test('replacing a completed Codex turn retains another queued approval', { timeout: 5000 }, async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const messages = [user('m1', 'late-double')]
  const first = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  await new Promise(resolve => setTimeout(resolve, 50))
  messages.push(toolResult('m2', first.calls[0].id, '{"decision":"allow"}'))
  const second = await collect(adapter.stream(options('s1', messages, { provider: 'local-codex-cli' })))
  assert.equal(second.calls[0].name, 'approve_agent_action')
  assert.notEqual(second.calls[0].id, first.calls[0].id)
})

test('antigravity route, badge, avatar, modes, sign-in hint, and env stripping', async (t) => {
  const spec = ENGINES['local-antigravity']
  assert.equal(spec.command, 'agy')
  assert.deepEqual(spec.args, ['acp'])
  assert.equal(spec.signIn, 'agy acp --login')
  assert.equal(spec.cwdPerProcess, true)
  const listedModes = ['default', 'accept-edits', 'auto', 'plan'].map(id => ({ id }))
  assert.equal(acpMode('read-only', listedModes, spec.modes), 'default')
  assert.equal(acpMode('workspace-write', listedModes, spec.modes), 'accept-edits')
  assert.equal(acpMode('danger-full-access', listedModes, spec.modes), 'auto')
  assert.equal(isLocalRoute('local-antigravity/gemini-4-carbon'), true)
  assert.deepEqual(badgeOf('local-antigravity'), ['AG', 'sky'])
  assert.match(agentAvatar('local-antigravity').image, /^data:image\/png;base64,/)

  const prevAlias = process.env.ANTIGRAVITY_CLI_ALIAS
  const prevAcc = process.env.AGY_ACCOUNT
  process.env.ANTIGRAVITY_CLI_ALIAS = 'custom'
  process.env.AGY_ACCOUNT = 'secret'
  t.after(() => {
    if (prevAlias === undefined) delete process.env.ANTIGRAVITY_CLI_ALIAS; else process.env.ANTIGRAVITY_CLI_ALIAS = prevAlias
    if (prevAcc === undefined) delete process.env.AGY_ACCOUNT; else process.env.AGY_ACCOUNT = prevAcc
  })
  const cleaned = cleanEnv()
  assert.equal(cleaned.ANTIGRAVITY_CLI_ALIAS, undefined)
  assert.equal(cleaned.AGY_ACCOUNT, undefined)

  const adapter = makeAdapter({ acpArgs: ['--omit-mcp-caps', '--auth-required'] })
  t.after(() => adapter.dispose())
  await assert.rejects(
    collect(adapter.stream(options('s1', [user('m1', 'hi')], { provider: 'local-antigravity' }))),
    err => err.code === 'LOCAL_AGENT_SIGNIN' && /agy acp --login/.test(err.message),
  )
})

test('acp tries HTTP MCP when mcpCapabilities is omitted (#1073), bridges stdio MCP when HTTP is unsupported/rejected, and falls back to plain on total rejection (#1463)', async (t) => {
  const omit = makeAdapter({ acpArgs: ['--omit-mcp-caps'] })
  t.after(() => omit.dispose())
  const call = await collect(omit.stream(options('s1', [user('m1', 'call-tool')])))
  assert.equal(call.calls[0]?.name, 'message_bot')
  const withTool = await collect(omit.stream(options('s1', [user('m1', 'call-tool'), toolResult('m2', call.calls[0].id, 'delivered to Chief')])))
  assert.match(withTool.text, /tool said: delivered to Chief/)

  const stdioOnly = makeAdapter({ acpArgs: ['--no-http-mcp'] })
  t.after(() => stdioOnly.dispose())
  const stdio1 = await collect(stdioOnly.stream(options('s-stdio', [user('m1', 'two-calls')])))
  assert.equal(stdio1.calls.length, 1)
  assert.equal(stdio1.calls[0]?.name, 'message_bot')
  const msg1 = JSON.parse(stdio1.calls[0].arguments).message
  const reply1 = msg1 === 'hi 0' ? 'zero' : 'one'
  const stdio2 = await collect(stdioOnly.stream(options('s-stdio', [
    user('m1', 'two-calls'),
    toolResult('m2', stdio1.calls[0].id, reply1),
  ])))
  assert.equal(stdio2.calls.length, 1)
  const msg2 = JSON.parse(stdio2.calls[0].arguments).message
  assert.notEqual(msg1, msg2)
  const reply2 = msg2 === 'hi 0' ? 'zero' : 'one'
  const stdioDone = await collect(stdioOnly.stream(options('s-stdio', [
    user('m1', 'two-calls'),
    toolResult('m2', stdio1.calls[0].id, reply1),
    toolResult('m3', stdio2.calls[0].id, reply2),
  ])))
  assert.match(stdioDone.text, /tool said: zero \| one/)

  const records = {}
  const httpRejected1 = makeAdapter({ records, acpArgs: ['--omit-mcp-caps', '--reject-http-mcp'] })
  t.after(() => httpRejected1.dispose())
  const fbCall = await collect(httpRejected1.stream(options('s-fb', [user('m1', 'call-tool')])))
  assert.equal(fbCall.calls[0]?.name, 'message_bot')
  const fbDone = await collect(httpRejected1.stream(options('s-fb', [user('m1', 'call-tool'), toolResult('m2', fbCall.calls[0].id, 'via stdio fallback')])))
  assert.match(fbDone.text, /tool said: via stdio fallback/)
  await httpRejected1.dispose()

  const httpRejected2 = makeAdapter({ records, acpArgs: ['--omit-mcp-caps', '--reject-http-mcp'] })
  t.after(() => httpRejected2.dispose())
  const resumedCall = await collect(httpRejected2.stream(options('s-fb', [
    user('m1', 'call-tool'),
    toolResult('m2', fbCall.calls[0].id, 'via stdio fallback'),
    user('m3', 'call-tool'),
  ])))
  assert.equal(resumedCall.calls[0]?.name, 'message_bot')
  const resumedDone = await collect(httpRejected2.stream(options('s-fb', [
    user('m1', 'call-tool'),
    toolResult('m2', fbCall.calls[0].id, 'via stdio fallback'),
    user('m3', 'call-tool'),
    toolResult('m4', resumedCall.calls[0].id, 'resumed stdio'),
  ])))
  assert.match(resumedDone.text, /tool said: resumed stdio/)

  const rejected = makeAdapter({ acpArgs: ['--omit-mcp-caps', '--reject-mcp'] })
  t.after(() => rejected.dispose())
  const fallback = await collect(rejected.stream(options('s2', [user('m1', 'hello')])))
  assert.match(fallback.text, /^ok: [\s\S]*hello/)
})

test('LoopbackMcp answers JSON-RPC notifications with 202 and an empty body', async (t) => {
  const mcp = new LoopbackMcp(() => [], async () => ({ text: 'ok' }))
  await mcp.listen()
  t.after(() => mcp.close())
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }
  for (const payload of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
    [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
  ]) {
    const res = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify(payload) })
    assert.equal(res.status, 202)
    assert.equal(await res.text(), '')
  }
})

test('acp exposes per-model thought_level efforts, maps Antigravity presets, and switches/restores them per turn', async (t) => {
  let currentPreset = 'workspace-write'
  const adapter = makeAdapter({ acpArgs: ['--agy-modes', '--thought-levels'], preset: () => currentPreset })
  t.after(() => adapter.dispose())
  const catalog = await adapter.probeModels('local-antigravity')
  const large = catalog.find(m => m.id === 'fake-large')
  const small = catalog.find(m => m.id === 'fake-small')
  assert.deepEqual(large.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(large.reasoning.defaultEffort, undefined)
  assert.equal(small.reasoning, undefined)

  const modeWrite = await collect(adapter.stream(options('m0', [user('m1', 'show-mode')], { provider: 'local-antigravity', model: 'fake-large' })))
  assert.match(modeWrite.text, /mode: accept-edits; refused: 0/)
  currentPreset = 'read-only'
  const modeRead = await collect(adapter.stream(options('m0', [user('m1', 'show-mode'), user('m2', 'show-mode')], { provider: 'local-antigravity', model: 'fake-large' })))
  assert.match(modeRead.text, /mode: default; refused: 0/)
  currentPreset = 'danger-full-access'
  const modeAuto = await collect(adapter.stream(options('m0', [user('m1', 'show-mode'), user('m2', 'show-mode'), user('m3', 'show-mode')], { provider: 'local-antigravity', model: 'fake-large' })))
  assert.match(modeAuto.text, /mode: auto; refused: 0/)

  const high = await collect(adapter.stream(options('s1', [user('m1', 'show-state')], {
    provider: 'local-antigravity',
    model: 'fake-large',
    reasoningEffort: 'high',
  })))
  assert.match(high.text, /effort: high/)

  const restored = await collect(adapter.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state')], {
    provider: 'local-antigravity',
    model: 'fake-large',
    reasoningEffort: undefined,
  })))
  assert.match(restored.text, /effort: medium/)
})

test('cwdPerProcess isolates ACP child cwd per folder, shares within a folder, and closes probe workers', async (t) => {
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'dsb-agy-a-')))
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'dsb-agy-b-')))
  const cwds = { sA1: dirA, sA2: dirA, sB: dirB }
  const spawned = []
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => {
      const engine = new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURES.acp, '--agy-modes', '--thought-levels'] }, { findExecutable: path => path })
      spawned.push(engine)
      return engine
    },
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async sessionId => cwds[sessionId] ?? dirA,
    probeCwd: () => dirA,
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  // Probe creates a temporary worker and closes it once models are read.
  const models = await adapter.probeModels('local-antigravity')
  assert.ok(models.length >= 2)
  assert.equal(spawned[0].workers.size, 0)

  const outA1 = await collect(adapter.stream(options('sA1', [user('m1', 'show-state')], { provider: 'local-antigravity', model: 'fake-large' })))
  const outB = await collect(adapter.stream(options('sB', [user('m1', 'show-state')], { provider: 'local-antigravity', model: 'fake-large' })))
  const outA2 = await collect(adapter.stream(options('sA2', [user('m1', 'show-state')], { provider: 'local-antigravity', model: 'fake-large' })))
  assert.match(outA1.text, new RegExp(`cwd: ${dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(outB.text, new RegExp(`cwd: ${dirB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(outA2.text, new RegExp(`cwd: ${dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(spawned[0].workers.size, 2)
})

test('every built-in CLI in ENGINES has valid metadata, badge, valid ink, avatar, and mode mapping', () => {
  const routes = Object.keys(ENGINES)
  assert.ok(routes.length >= 24)
  for (const route of routes) {
    const spec = ENGINES[route]
    const cli = route.replace(/^local-/, '')
    assert.ok(['acp', 'claude', 'codex'].includes(spec.kind), `${route} kind`)
    assert.ok(typeof spec.name === 'string' && spec.name.length > 0, `${route} name`)
    assert.ok(typeof spec.command === 'string' && spec.command.length > 0, `${route} command`)
    assert.ok(typeof spec.signIn === 'string' && spec.signIn.length > 0, `${route} signIn`)
    const badge = AGENT_BADGES[cli]
    assert.ok(Array.isArray(badge) && badge.length === 2, `${route} AGENT_BADGES`)
    assert.ok(INKS[badge[1]] !== undefined, `${route} ink ${badge[1]}`)
    assert.ok(isLocalRoute(route), `${route} isLocalRoute`)
    assert.deepEqual(badgeOf(route), badge, `${route} badgeOf`)
    const avatar = agentAvatar(route)
    assert.ok(avatar?.image?.startsWith('data:image/'), `${route} agentAvatar`)
    if (spec.kind === 'acp') {
      assert.equal(typeof acpMode('workspace-write', spec.modes?.['workspace-write'] ?? ['accept-edits'], spec.modes), 'string')
    } else {
      assert.equal(typeof cliMode(spec.kind, 'workspace-write'), 'string')
    }
  }
})

test('AcpEngine.ensure deduplicates concurrent startups and cleans up after failed initialize', async (t) => {
  let findCalls = 0
  const engine = new AcpEngine('local-test', {
    name: 'Test ACP',
    kind: 'acp',
    command: process.execPath,
    args: [FIXTURES.acp, '--fail-first-init'],
  }, {
    findExecutable: (name) => { findCalls += 1; return name },
  })
  t.after(() => engine.close())

  await assert.rejects(() => Promise.all([engine.ensure(), engine.ensure()]), /init boom/)
  assert.equal(findCalls, 1)
  assert.equal(engine.child, undefined)
  assert.equal(engine.peer, undefined)
  assert.equal(engine.starting, undefined)

  engine.engine = { ...engine.engine, args: [FIXTURES.acp] }
  const [peerA, peerB] = await Promise.all([engine.ensure(), engine.ensure()])
  assert.equal(peerA, peerB)
  assert.equal(findCalls, 2)
})

test('ownToolCall auto-approves generic mcp__dsbot__ and dsbot: calls without leaking to unrelated names', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())

  for (const trigger of ['generic-mcp-team', 'generic-mcp-team-colon']) {
    const step1 = await collect(adapter.stream(options(`team-${trigger}`, [user('m1', trigger)])))
    assert.equal(step1.calls[0]?.name, 'message_bot', JSON.stringify(step1))
    const step2 = await collect(adapter.stream(options(`team-${trigger}`, [
      user('m1', trigger),
      toolResult('m2', step1.calls[0].id, 'delivered'),
    ])))
    assert.match(step2.text, /allowed via allow_once; tool said: delivered/)
  }

  for (const trigger of ['generic-mcp-other-github', 'generic-mcp-other-prefix']) {
    const asked = await collect(adapter.stream(options(`other-${trigger}`, [user('m1', trigger)])))
    assert.equal(asked.calls[0]?.name, 'approve_agent_action', JSON.stringify(asked))
  }
})

test('ClaudeEngine can_use_tool deny sends required message string (#1539)', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('c1', [user('m1', 'ask-claude-perm')], { provider: 'local-claude-code' })))
  assert.equal(ask.calls[0]?.name, 'approve_agent_action')
  const denied = await collect(adapter.stream(options('c1', [
    user('m1', 'ask-claude-perm'),
    toolResult('m2', ask.calls[0].id, JSON.stringify({ decision: 'deny' })),
  ], { provider: 'local-claude-code' })))
  assert.equal(denied.text, 'perm:{"behavior":"deny","message":"The user denied this action."}')
})


test('stdioBridgePath extracts .asar bridges into a private directory and leaves unpacked files alone', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-asar-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const asarDir = join(dir, 'app.asar')
  const unpackedDir = join(dir, 'app.asar.unpacked')
  mkdirSync(asarDir, { recursive: true })
  mkdirSync(unpackedDir, { recursive: true })
  const asarSource = join(asarDir, 'mcp-stdio.js')
  const unpackedSource = join(unpackedDir, 'mcp-stdio.js')
  writeFileSync(asarSource, '// bridge\n')
  writeFileSync(unpackedSource, '// unpacked\n')

  const extracted = stdioBridgePath(asarSource)
  t.after(() => rmSync(dirname(extracted), { recursive: true, force: true }))
  assert.notEqual(extracted, asarSource)
  assert.equal(stdioBridgePath(asarSource), extracted)
  assert.equal(readFileSync(extracted, 'utf8'), '// bridge\n')
  if (process.platform !== 'win32') {
    assert.equal(statSync(dirname(extracted)).mode & 0o777, 0o700)
    assert.equal(statSync(extracted).mode & 0o777, 0o600)
  }
  assert.equal(stdioBridgePath(unpackedSource), unpackedSource)
})

test('ACP session/load falls back to stdio or plain sessions without dropping cliSessionId', async (t) => {
  for (const flag of ['--reject-http-mcp', '--reject-mcp']) {
    const records = {}
    const first = makeAdapter({ records, acpArgs: [flag] })
    const second = makeAdapter({ records, acpArgs: [flag] })
    t.after(async () => {
      await first.dispose()
      await second.dispose()
    })

    const turn1 = await collect(first.stream(options('s1', [user('m1', 'first')])))
    assert.equal(turn1.finish.kind, 'stop')
    const cliId = records.s1?.cliSessionId
    assert.ok(cliId)
    await first.dispose()

    const turn2 = await collect(second.stream(options('s1', [user('m1', 'first'), user('m2', 'second')])))
    assert.equal(turn2.finish.kind, 'stop')
    assert.equal(records.s1?.cliSessionId, cliId)
  }
})

test('clearing reasoningEffort restores ACP thought_level after session/load and Host restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-effort-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  for (const [tag, extra] of [['bare', []], ['with-options', ['--load-thought-level']]]) {
    const records = {}
    const stateFile = join(dir, `${tag}.json`)
    const args = ['--thought-levels', `--state-file=${stateFile}`, ...extra]
    const first = makeAdapter({ records, acpArgs: args })
    const second = makeAdapter({ records, acpArgs: args })
    t.after(async () => {
      await first.dispose()
      await second.dispose()
    })

    const t1 = await collect(first.stream(options('s1', [user('m1', 'show-state')], { reasoningEffort: 'high' })))
    assert.match(t1.text, /effort: high/)
    assert.equal(records.s1?.defaultEffort, 'medium')
    assert.equal(records.s1?.effort, 'high')
    await first.dispose()

    const t2 = await collect(second.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state')])))
    assert.match(t2.text, /effort: medium/)
    assert.equal(records.s1?.defaultEffort, 'medium')
    assert.equal(records.s1?.effort, undefined)

    const t3 = await collect(second.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state'), user('m3', 'show-state')], { reasoningEffort: 'low' })))
    assert.match(t3.text, /effort: low/)
    await second.closeSession('s1')

    const t4 = await collect(second.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state'), user('m3', 'show-state'), user('m4', 'show-state')])))
    assert.match(t4.text, /effort: medium/)
    assert.equal(records.s1?.effort, undefined)
  }
})

test('legacy ACP agents switch models via session/set_model and fail on unknown models', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records, acpArgs: ['--legacy-models'] })
  t.after(() => adapter.dispose())

  const probed = await adapter.probeModels('local-acp-fake')
  assert.ok(probed.some(model => model.id === 'legacy-fast'))

  const turn1 = await collect(adapter.stream(options('s1', [user('m1', 'show-state')], { model: 'legacy-fast' })))
  assert.match(turn1.text, /model: legacy-fast/)

  await adapter.closeSession('s1')
  const turn2 = await collect(adapter.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state')], { model: 'legacy-fast' })))
  assert.match(turn2.text, /model: legacy-fast/)

  await assert.rejects(
    collect(adapter.stream(options('s2', [user('m1', 'show-state')], { model: 'legacy-missing' }))),
    err => err?.code === 'LOCAL_AGENT_MODEL',
  )
})

test('switching ACP models resets effort tracking cleanly and ignores unapplied efforts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-model-effort-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const records = {}
  const stateFile = join(dir, 'state.json')
  const adapter = makeAdapter({ records, acpArgs: ['--thought-levels', '--load-thought-level', '--model-resets-thought', `--state-file=${stateFile}`] })
  t.after(() => adapter.dispose())

  const t1 = await collect(adapter.stream(options('s1', [user('m1', 'show-state')], { model: 'fake-large', reasoningEffort: 'high' })))
  assert.match(t1.text, /effort: high/)
  assert.equal(records.s1?.defaultEffort, 'medium')
  assert.equal(records.s1?.effort, 'high')

  const t2 = await collect(adapter.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state')], { model: 'fake-small', reasoningEffort: 'high' })))
  assert.match(t2.text, /effort: high/)
  assert.equal(records.s1?.defaultEffort, 'low')
  assert.equal(records.s1?.effort, 'high')

  const t3 = await collect(adapter.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state'), user('m3', 'show-state')], { model: 'fake-small' })))
  assert.match(t3.text, /effort: low/)
  assert.equal(records.s1?.defaultEffort, 'low')
  assert.equal(records.s1?.effort, undefined)

  const t4 = await collect(adapter.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state'), user('m3', 'show-state'), user('m4', 'show-state')], { model: 'fake-small', reasoningEffort: 'bogus' })))
  assert.match(t4.text, /effort: low/)
  assert.equal(records.s1?.effort, undefined)
})

test('ACP compaction clears persisted effort so Host restart reapplies reasoningEffort cleanly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-compact-effort-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const records = {}
  const stateFile = join(dir, 'state.json')
  const args = ['--thought-levels', `--state-file=${stateFile}`]
  const first = makeAdapter({ records, acpArgs: args })
  const second = makeAdapter({ records, acpArgs: args })
  t.after(async () => {
    await first.dispose()
    await second.dispose()
  })

  const t1 = await collect(first.stream(options('s1', [user('m1', 'show-state')], { reasoningEffort: 'high' })))
  assert.match(t1.text, /effort: high/)
  assert.equal(records.s1?.effort, 'high')

  const compacted = await first.compact('s1')
  assert.equal(compacted, 'done')
  assert.equal(records.s1?.effort, undefined)
  await first.dispose()

  const t2 = await collect(second.stream(options('s1', [user('m1', 'show-state'), user('m2', 'show-state')], { reasoningEffort: 'high' })))
  assert.match(t2.text, /effort: high/)
  assert.equal(records.s1?.effort, 'high')
})

test('resuming an ACP session keeps its saved defaultEffort over another workspace default for the same model', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-ws-effort-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lowWs = join(dir, 'low-ws')
  const normalWs = join(dir, 'normal-ws')
  mkdirSync(lowWs, { recursive: true })
  mkdirSync(normalWs, { recursive: true })
  const records = {}
  const stateFile = join(dir, 'state.json')
  const args = ['--thought-levels', '--load-thought-level', '--preserve-thought-on-model', `--state-file=${stateFile}`]
  const cwdFor = async id => (id === 'sA' ? lowWs : normalWs)
  const first = makeAdapter({ records, acpArgs: args, cwdFor })
  const second = makeAdapter({ records, acpArgs: args, cwdFor })
  t.after(async () => {
    await first.dispose()
    await second.dispose()
  })

  const a1 = await collect(first.stream(options('sA', [user('m1', 'show-state')], { model: 'fake-large', reasoningEffort: 'high' })))
  assert.match(a1.text, /effort: high/)
  assert.equal(records.sA?.defaultEffort, 'low')
  assert.equal(records.sA?.effort, 'high')
  await first.dispose()

  const b1 = await collect(second.stream(options('sB', [user('m1', 'show-state')], { model: 'fake-large' })))
  assert.match(b1.text, /effort: medium/)
  assert.equal(records.sB?.defaultEffort, 'medium')

  const a2 = await collect(second.stream(options('sA', [user('m1', 'show-state'), user('m2', 'show-state')], { model: 'fake-large' })))
  assert.match(a2.text, /effort: low/)
  assert.equal(records.sA?.defaultEffort, 'low')
  assert.equal(records.sA?.effort, undefined)
})

function makeMemoryAttachments(entries = {}) {
  return {
    async readImage(ref) {
      const entry = entries[ref.attachmentId]
      if (entry === undefined) throw new Error(`missing image ${ref.attachmentId}`)
      if (entry instanceof Error) throw entry
      return { ref: { ...ref, mediaType: entry.mediaType ?? ref.mediaType }, data: entry.data }
    },
    imageHostPath(ref) {
      return entries[ref.attachmentId]?.hostPath
    },
  }
}

const imageMsg = (id, text, ref, { offloaded = false } = {}) => ({
  id,
  role: 'user',
  content: [
    ...(text === undefined ? [] : [{ type: 'text', text }]),
    { type: 'image', attachment: ref, ...(offloaded ? { offloaded: true } : {}) },
  ],
  source: { kind: 'user' },
})

test('codex receives image blocks on first replay turn, delta turn, and image-only turns', async (t) => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4])
  const jpgBytes = Buffer.from([255, 216, 255, 5, 6, 7])
  const pngRef = { attachmentId: 'att-png', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1, name: 'photo.png' }
  const jpgRef = { attachmentId: 'att-jpg', mediaType: 'image/jpeg', bytes: jpgBytes.length, width: 2, height: 2 }
  const adapter = makeAdapter({
    attachments: makeMemoryAttachments({
      'att-png': { mediaType: 'image/png', data: pngBytes },
      'att-jpg': { mediaType: 'image/jpeg', data: jpgBytes },
    }),
  })
  t.after(() => adapter.dispose())

  const first = await collect(adapter.stream(options('s1', [imageMsg('m1', 'describe this', pngRef)], { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
  assert.equal(first.finish?.kind, 'stop')
  assert.match(first.text, new RegExp(`data:image/png;base64,${pngBytes.toString('base64')}`))

  const second = await collect(adapter.stream(options('s1', [imageMsg('m1', 'describe this', pngRef), imageMsg('m2', undefined, jpgRef)], { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
  assert.equal(second.finish?.kind, 'stop')
  assert.match(second.text, new RegExp(`data:image/jpeg;base64,${jpgBytes.toString('base64')}`))
})

test('claude receives Anthropic base64 image blocks for text+image and image-only turns', async (t) => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 9, 8, 7, 6])
  const pngRef = { attachmentId: 'att-c1', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1 }
  const adapter = makeAdapter({
    attachments: makeMemoryAttachments({ 'att-c1': { mediaType: 'image/png', data: pngBytes } }),
  })
  t.after(() => adapter.dispose())

  const first = await collect(adapter.stream(options('s1', [imageMsg('m1', 'check screenshot', pngRef)], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(first.finish?.kind, 'stop')
  assert.match(first.text, new RegExp(`"mediaType":"image/png".*"data":"${pngBytes.toString('base64')}"`))

  const second = await collect(adapter.stream(options('s1', [imageMsg('m1', 'check screenshot', pngRef), imageMsg('m2', undefined, pngRef)], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(second.finish?.kind, 'stop')
  assert.match(second.text, new RegExp(`"data":"${pngBytes.toString('base64')}"`))
})

test('ClaudeEngine.steer unwraps block arrays and strings without double-wrapping', async (t) => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 9, 8, 7, 6])
  const pngRef = { attachmentId: 'att-c-steer', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1 }
  const adapter = makeAdapter({
    attachments: makeMemoryAttachments({ 'att-c-steer': { mediaType: 'image/png', data: pngBytes } }),
  })
  t.after(() => adapter.dispose())

  // Put Claude into a running/suspended turn (`session.running === true`) via permission wait,
  // then send a text+image follow-up so sendInput steers via ClaudeEngine.steer(session, blocks).
  const first = await collect(adapter.stream(options('c-steer-img', [user('m1', 'ask-claude-perm')], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(first.finish?.kind, 'tool-calls')
  const steeredImg = await collect(adapter.stream(options('c-steer-img', [
    user('m1', 'ask-claude-perm'),
    imageMsg('m2', 'steer with image', pngRef),
  ], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(steeredImg.finish?.kind, 'stop')
  assert.match(steeredImg.text, /^ok: steer with image/)
  assert.match(steeredImg.text, new RegExp(`"mediaType":"image/png".*"data":"${pngBytes.toString('base64')}"`))

  // Plain-text follow-up while suspended/running also passes blocks through sendInput.
  const askText = await collect(adapter.stream(options('c-steer-txt', [user('m1', 'ask-claude-perm')], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(askText.finish?.kind, 'tool-calls')
  const steeredText = await collect(adapter.stream(options('c-steer-txt', [
    user('m1', 'ask-claude-perm'),
    user('m2', 'steer text only'),
  ], { provider: 'local-claude-code', model: 'sonnet' })))
  assert.equal(steeredText.finish?.kind, 'stop')
  assert.equal(steeredText.text, 'ok: steer text only')

  // Direct string steer via ClaudeEngine.steer keeps working as well.
  const live = adapter.live.get('c-steer-txt')
  await live.engine.steer(live.engineSession, 'direct string steer')
  const evs = []
  while (true) {
    const ev = await live.next()
    evs.push(ev)
    if (ev.type === 'done' || ev.type === 'error') break
  }
  assert.equal(evs.filter(ev => ev.type === 'text').map(ev => ev.text).join(''), 'ok: direct string steer')
})

test('acp receives {type:"image", mimeType, data} when promptCapabilities.image is true', async (t) => {
  const webpBytes = Buffer.from([82, 73, 70, 70, 1, 2, 3])
  const ref = { attachmentId: 'att-a1', mediaType: 'image/webp', bytes: webpBytes.length, width: 1, height: 1 }
  const adapter = makeAdapter({
    attachments: makeMemoryAttachments({ 'att-a1': { mediaType: 'image/webp', data: webpBytes } }),
  })
  t.after(() => adapter.dispose())

  const first = await collect(adapter.stream(options('s1', [imageMsg('m1', 'look', ref)])))
  assert.equal(first.finish?.kind, 'stop')
  assert.match(first.text, new RegExp(`"mimeType":"image/webp","data":"${webpBytes.toString('base64')}"`))

  const second = await collect(adapter.stream(options('s1', [imageMsg('m1', 'look', ref), imageMsg('m2', undefined, ref)])))
  assert.equal(second.finish?.kind, 'stop')
  assert.match(second.text, new RegExp(`"mimeType":"image/webp","data":"${webpBytes.toString('base64')}"`))
})

test('acp without image capability degrades image to text and updates resolveModel inputModalities', async (t) => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 4, 5, 6])
  const ref = { attachmentId: 'att-noimg', mediaType: 'image/png', bytes: pngBytes.length, width: 10, height: 20, name: 'shot.png' }
  const adapter = makeAdapter({
    acpArgs: ['--no-image'],
    attachments: makeMemoryAttachments({
      'att-noimg': { mediaType: 'image/png', data: pngBytes, hostPath: '/tmp/host-shot.png' },
    }),
    fs: { processPathFromHostPath: p => p.replace('/tmp/', '/guest/') },
  })
  t.after(() => adapter.dispose())

  // Before any CLI starts, resolveModel must stay fast/lazy and optimistic.
  const before = await adapter.resolveModel('local-acp-fake', 'default')
  assert.deepEqual(before.inputModalities, ['text', 'image'])
  assert.equal(adapter._spawned.length, 0)

  // First turn sees promptCapabilities.image === false and must degrade instead of sending an invalid image block (-32602).
  const first = await collect(adapter.stream(options('s1', [imageMsg('m1', 'what is this?', ref)])))
  assert.equal(first.finish?.kind, 'stop')
  assert.doesNotMatch(first.text, /"mimeType"/)
  assert.match(first.text, /what is this\?/)

  // Once known, resolveModel excludes 'image' so host OCR takes over on subsequent turns.
  const after = await adapter.resolveModel('local-acp-fake', 'default')
  assert.deepEqual(after.inputModalities, ['text'])
})

test('offloaded or unreadable images degrade cleanly without calling readImage on offloaded blocks', async (t) => {
  let reads = 0
  const ref1 = { attachmentId: 'att-off', mediaType: 'image/png', bytes: 12, width: 2, height: 2, name: 'old.png' }
  const ref2 = { attachmentId: 'att-err', mediaType: 'image/png', bytes: 12, width: 2, height: 2, name: 'broken.png' }
  const adapter = makeAdapter({
    attachments: {
      async readImage(ref) {
        reads += 1
        throw new Error(`read failed for ${ref.attachmentId}`)
      },
    },
  })
  t.after(() => adapter.dispose())

  const out = await collect(adapter.stream(options('s1', [
    imageMsg('m1', 'check both', ref1, { offloaded: true }),
    imageMsg('m2', 'and this', ref2),
  ], { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
  assert.equal(out.finish?.kind, 'stop')
  assert.equal(reads, 1)
  assert.doesNotMatch(out.text, /images=/)
})

test('replay drops images outside the replay window without reading their attachments', async (t) => {
  const readIds = []
  const pngBytes = Buffer.from([137, 80, 78, 71, 1, 2, 3])
  const oldRef = { attachmentId: 'att-too-old', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1 }
  const recentRef = { attachmentId: 'att-recent', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1 }
  const adapter = makeAdapter({
    attachments: {
      async readImage(ref) {
        readIds.push(ref.attachmentId)
        return { ref, data: pngBytes }
      },
    },
  })
  t.after(() => adapter.dispose())

  const msgs = [
    imageMsg('m0', 'ancient image', oldRef),
    ...Array.from({ length: 13 }, (_, i) => user(`m${i + 1}`, `turn ${i + 1}`)),
    imageMsg('m14', 'latest image', recentRef),
  ]
  const out = await collect(adapter.stream(options('s1', msgs, { provider: 'local-codex-cli', model: 'gpt-5.1-codex' })))
  assert.equal(out.finish?.kind, 'stop')
  assert.deepEqual(readIds, ['att-recent'])
})

test('AcpEngine cwdPerProcess does not close a worker while another open is in-flight or a non-ephemeral session shared it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-acp-worker-'))
  const dirA = join(dir, 'ws-a')
  const dirHold = join(dir, 'ws-hold')
  const dirRace = join(dir, 'ws-race')
  const dirFailOne = join(dir, 'ws-fail-one')
  const dirFailBoth = join(dir, 'ws-fail-both')
  for (const d of [dirA, dirHold, dirRace, dirFailOne, dirFailBoth]) mkdirSync(d, { recursive: true })

  const script = `
    let buf = '', next = 0
    const held = [], race = [], failBoth = []
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
        } else if (method === 'session/new') {
          const cwd = String(params.cwd || '')
          if (cwd.endsWith('ws-hold')) { held.push(id); continue }
          if (cwd.endsWith('ws-fail-one')) {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'not signed in' } })
            continue
          }
          if (cwd.endsWith('ws-fail-both')) {
            failBoth.push(id)
            if (failBoth.length === 2) {
              for (const reqId of failBoth.splice(0)) {
                send({ jsonrpc: '2.0', id: reqId, error: { code: -32000, message: 'both failed' } })
              }
            }
            continue
          }
          if (cwd.endsWith('ws-race')) {
            race.push(id)
            if (race.length === 2) {
              const [firstId, secondId] = race
              send({ jsonrpc: '2.0', id: firstId, error: { code: -32000, message: 'first failed' } })
              setTimeout(() => send({ jsonrpc: '2.0', id: secondId, result: { sessionId: 'acp-race-2', configOptions: [] } }), 30)
            }
            continue
          }
          send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-' + (++next), configOptions: [] } })
        } else if (method === 'session/close') {
          send({ jsonrpc: '2.0', id, result: {} })
          if (held.length > 0) {
            const heldId = held.shift()
            setTimeout(() => send({ jsonrpc: '2.0', id: heldId, result: { sessionId: 'acp-' + (++next), configOptions: [] } }), 250)
          }
        } else if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        }
      }
    })
  `
  const engine = new AcpEngine('local-cursor-agent', {
    name: 'Cursor',
    kind: 'acp',
    cwdPerProcess: true,
    command: process.execPath,
    args: ['-e', script],
  }, { findExecutable: p => p })
  const children = new Set()
  const waitExited = child => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker child did not exit')), 2_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
    }))
  const origSpawnWorker = engine.spawnWorker.bind(engine)
  engine.spawnWorker = (key) => {
    const worker = origSpawnWorker(key)
    const origEnsure = worker.ensure.bind(worker)
    worker.ensure = async () => {
      try {
        return await origEnsure()
      } finally {
        if (worker.child) children.add(worker.child)
      }
    }
    return worker
  }
  t.after(async () => {
    await engine.close()
    await Promise.all([...children].map(child => waitExited(child).catch(() => {})))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  // Case 1: first ephemeral session closes while a second ephemeral open on the same worker is still pending.
  const s1 = await engine.open('side-1', { cwd: dirA, ephemeral: true })
  const worker = engine.workerOf(s1)
  const p2 = engine.open('side-2', { cwd: dirHold, ephemeral: true })
  while ((worker.peer?.pending?.size ?? 0) < 1) await new Promise(resolve => setTimeout(resolve, 10))
  await engine.closeSession(s1)
  const s2 = await p2
  assert.ok(s2.acpSessionId)
  await engine.closeSession(s2)
  assert.equal(engine.workers.size, 0)

  // Case 2: a non-ephemeral session shares an existing ephemeral worker and keeps it reusable after closing.
  const s3 = await engine.open('side-3', { cwd: dirA, ephemeral: true })
  const sharedWorker = engine.workerOf(s3)
  const p4 = engine.open('main-4', { cwd: dirA, ephemeral: false })
  await engine.closeSession(s3)
  const s4 = await p4
  assert.equal(engine.workerOf(s4), sharedWorker)
  await engine.closeSession(s4)
  assert.equal(engine.workers.size, 1)

  // Case 3: concurrent opens on a fresh cwd worker where the first fails must not kill the second in-flight open.
  const pFail = engine.open('race-1', { cwd: dirRace })
  const pOk = engine.open('race-2', { cwd: dirRace })
  await assert.rejects(pFail, /first failed/)
  const sOk = await pOk
  assert.equal(sOk.acpSessionId, 'acp-race-2')

  // Case 4: a single failed session/new cleans up the placeholder, removes the worker, and terminates its child.
  const beforeFailOne = new Set(children)
  await assert.rejects(engine.open('fail-1', { cwd: dirFailOne }), /not signed in/)
  assert.equal(engine.workers.has(dirFailOne), false)
  engine.forget('fail-1')
  const failOneChildren = [...children].filter(child => !beforeFailOne.has(child))
  assert.equal(failOneChildren.length, 1)
  await waitExited(failOneChildren[0])

  // Case 5: concurrent opens on a fresh worker that all fail clean up the worker and terminate its child.
  const beforeFailBoth = new Set(children)
  const [rA, rB] = await Promise.allSettled([
    engine.open('fail-both-1', { cwd: dirFailBoth }),
    engine.open('fail-both-2', { cwd: dirFailBoth }),
  ])
  assert.equal(rA.status, 'rejected')
  assert.equal(rB.status, 'rejected')
  assert.equal(engine.workers.has(dirFailBoth), false)
  const failBothChildren = [...children].filter(child => !beforeFailBoth.has(child))
  assert.equal(failBothChildren.length, 1)
  await waitExited(failBothChildren[0])
})

test('AcpEngine cwdPerProcess retires workers when concurrent opens fail after forget or ephemeral close', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-acp-retire-'))
  const dirForget = join(dir, 'ws-forget')
  const dirEph = join(dir, 'ws-eph')
  const dirInFlightForget = join(dir, 'ws-inflight-forget')
  for (const d of [dirForget, dirEph, dirInFlightForget]) mkdirSync(d, { recursive: true })

  // Deterministic fake ACP worker controlled via session/new order per workspace:
  // - ws-forget: 1st session/new succeeds; 2nd session/new delays 80ms then fails.
  // - ws-eph: 1st session/new succeeds; 2nd session/new holds until session/close completes, then fails.
  // - ws-inflight-forget: 1st session/new delays 80ms then succeeds (caller forgets while in flight).
  const script = `
    let buf = '', next = 0
    const counts = Object.create(null)
    let heldEphFail
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
        } else if (method === 'session/new') {
          const cwd = String(params.cwd || '')
          counts[cwd] = (counts[cwd] || 0) + 1
          const n = counts[cwd]
          if (cwd.endsWith('ws-forget')) {
            if (n === 1) send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-f-' + (++next), configOptions: [] } })
            else setTimeout(() => send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'second open failed' } }), 80)
          } else if (cwd.endsWith('ws-eph')) {
            if (n === 1) send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-e-' + (++next), configOptions: [] } })
            else heldEphFail = id
          } else if (cwd.endsWith('ws-inflight-forget')) {
            setTimeout(() => send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-i-' + (++next), configOptions: [] } }), 80)
          } else {
            send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-' + (++next), configOptions: [] } })
          }
        } else if (method === 'session/close') {
          send({ jsonrpc: '2.0', id, result: {} })
          if (heldEphFail !== undefined) {
            const failId = heldEphFail
            heldEphFail = undefined
            setTimeout(() => send({ jsonrpc: '2.0', id: failId, error: { code: -32000, message: 'promoted open failed' } }), 30)
          }
        } else if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        }
      }
    })
  `
  const engine = new AcpEngine('local-cursor-agent', {
    name: 'Cursor',
    kind: 'acp',
    cwdPerProcess: true,
    command: process.execPath,
    args: ['-e', script],
  }, { findExecutable: p => p })
  const children = new Set()
  const waitExited = child => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker child did not exit')), 2_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
    }))
  const origSpawnWorker = engine.spawnWorker.bind(engine)
  engine.spawnWorker = (key) => {
    const worker = origSpawnWorker(key)
    const origEnsure = worker.ensure.bind(worker)
    worker.ensure = async () => {
      try {
        return await origEnsure()
      } finally {
        if (worker.child) children.add(worker.child)
      }
    }
    return worker
  }
  t.after(async () => {
    await engine.close()
    await Promise.all([...children].map(child => waitExited(child).catch(() => {})))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  // Case A: persistent s1 is forgotten while s2's newSession is in-flight; when s2 then fails,
  // the now-empty worker must retire and exit rather than leaking forever.
  const s1 = await engine.open('persist-1', { cwd: dirForget, ephemeral: false })
  const workerA = engine.workerOf(s1)
  const childA = workerA.child
  const p2 = engine.open('persist-2', { cwd: dirForget, ephemeral: false })
  while ((workerA.peer?.pending?.size ?? 0) < 1) await new Promise(resolve => setTimeout(resolve, 10))
  engine.forget('persist-1')
  assert.equal(engine.workers.has(dirForget), true, 'worker stays alive while s2 is still opening')
  await assert.rejects(p2, /second open failed/)
  assert.equal(engine.workers.has(dirForget), false, 'worker is removed once the last in-flight open fails')
  await waitExited(childA)

  // Case B: ephemeral s1 creates a worker, non-ephemeral s2 shares it and starts opening,
  // s1 closes before s2 settles, and s2 then fails; keepWarm must not have been set prematurely.
  const e1 = await engine.open('eph-1', { cwd: dirEph, ephemeral: true })
  const workerB = engine.workerOf(e1)
  const childB = workerB.child
  const pPromoted = engine.open('main-promote', { cwd: dirEph, ephemeral: false })
  while ((workerB.peer?.pending?.size ?? 0) < 1) await new Promise(resolve => setTimeout(resolve, 10))
  await engine.closeSession(e1)
  await assert.rejects(pPromoted, /promoted open failed/)
  assert.equal(engine.workers.has(dirEph), false, 'ephemeral worker is removed when the non-ephemeral open fails')
  await waitExited(childB)

  // Case C: forgetting a session while its only open is still in-flight rejects that open
  // and retires the worker without leaking the process.
  const beforeC = new Set(children)
  const pForgotten = engine.open('inflight-1', { cwd: dirInFlightForget, ephemeral: false })
  while (engine.workers.get(dirInFlightForget)?.peer?.pending?.size !== 1) await new Promise(resolve => setTimeout(resolve, 10))
  engine.forget('inflight-1')
  await assert.rejects(pForgotten, /session closed while opening/)
  assert.equal(engine.workers.has(dirInFlightForget), false)
  const childC = [...children].find(child => !beforeC.has(child))
  assert.ok(childC)
  await waitExited(childC)
})

test('ACP upstream error data preserves code, detail and status (#1806)', async (t) => {
  const detail = "This request was blocked by Factory's usage policy check."
  const cases = [
    { data: { status: 403, code: 'content_policy_rejected', detail }, code: 'content_policy_rejected', text: detail, status: 403 },
    { data: { status: 403, error: { code: 'content_policy_rejected', message: detail } }, code: 'content_policy_rejected', text: detail, status: 403 },
    { data: { error: { status: 403, code: 'content_policy_rejected', message: 'Request rejected', detail } }, code: 'content_policy_rejected', text: detail, status: 403 },
    { data: { message: 'Login required', code: 'auth_failed', status: 401 }, code: 'LOCAL_AGENT_SIGNIN', text: 'Login required', status: 401 },
    { data: { detail: 'Rate limit reached', code: 'rate_limit_exceeded', status: 429 }, code: 'LOCAL_AGENT_QUOTA', text: 'Rate limit reached', status: 429 },
    ...['This request exceeded the allowed usage policy limits.', 'This request contains too many tokens prohibited by policy.', 'Unauthorized content was rejected.'].flatMap(text => ['detail', 'message'].map(field => ({
      data: { status: 403, code: 'content_policy_rejected', [field]: text }, code: 'content_policy_rejected', text, status: 403,
    }))),
    { data: { code: 'context_length_exceeded', detail: 'Request rejected' }, code: 'CONTEXT_WINDOW_EXCEEDED', text: 'Request rejected' },
    { outerCode: 'auth_failed', code: 'LOCAL_AGENT_SIGNIN', text: 'Internal error' },
    { outerCode: 'rate_limit_exceeded', code: 'LOCAL_AGENT_QUOTA', text: 'Internal error' },
    { outerCode: 'NO_ADAPTER', code: 'LOCAL_AGENT_MISSING', text: 'Internal error' },
    { outerCode: 'auth_failed', data: { code: 'upstream_failure', detail }, code: 'upstream_failure', text: detail },
    { outerCode: 'rate_limit_exceeded', data: { code: 'upstream_failure', detail }, code: 'upstream_failure', text: detail },
    { message: 'Unauthorized content was rejected.', data: { status: 403, code: 'content_policy_rejected' }, code: 'content_policy_rejected', text: 'Unauthorized content was rejected.', status: 403 },
    { data: { status: 504, code: 'deadline_exceeded', detail: 'The upstream service timed out.' }, code: 'deadline_exceeded', text: 'The upstream service timed out.', status: 504 },
    { outerCode: 'deadline_exceeded', code: 'deadline_exceeded', text: 'Internal error' },
    ...['auth_failed', 'unauthorized', 'unauthenticated', 'authentication_failed', 'not_logged_in'].map(code => ({
      data: { code }, code: 'LOCAL_AGENT_SIGNIN', text: 'Internal error',
    })),
    ...['rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota', 'usage_limit_exceeded'].map(code => ({
      data: { code }, code: 'LOCAL_AGENT_QUOTA', text: 'Internal error',
    })),
    ...[
      ['Too many tokens', 'CONTEXT_WINDOW_EXCEEDED'],
      ['Login required', 'LOCAL_AGENT_SIGNIN'],
      ['Rate limit reached', 'LOCAL_AGENT_QUOTA'],
    ].flatMap(([text, code]) => [
      { data: { detail: text }, code, text },
      { data: { error: { message: text } }, code, text },
    ]),
    ...[
      ['Login required', 'LOCAL_AGENT_SIGNIN'],
      ['Rate limit reached', 'LOCAL_AGENT_QUOTA'],
      ['Too many tokens', 'CONTEXT_WINDOW_EXCEEDED'],
    ].map(([message, code]) => ({ message, data: { detail }, code, text: detail })),
    { data: { code: '', detail }, code: 'LOCAL_AGENT_ERROR', text: detail },
    { data: { code: 403, detail }, code: 'LOCAL_AGENT_ERROR', text: detail },
    { data: { code: '  ', detail, status: 999 }, code: 'LOCAL_AGENT_ERROR', text: detail },
    { data: null, code: 'LOCAL_AGENT_ERROR', text: 'Internal error (JSON-RPC -32603)' },
    { data: {}, code: 'LOCAL_AGENT_ERROR', text: 'Internal error (JSON-RPC -32603)' },
  ]
  for (const [index, entry] of cases.entries()) {
    await t.test(`upstream data case ${index + 1}`, async (t) => {
      const adapter = makeAdapter()
      t.after(() => adapter.dispose())
      const peer = new JsonRpcPeer(request => peer.handleLine(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        error: { code: entry.outerCode ?? -32603, message: entry.message ?? 'Internal error', data: entry.data },
      })))
      adapter.engine('local-acp-fake').prompt = () => peer.request('session/prompt', {})
      await assert.rejects(collect(adapter.stream(options('s1', [user('m1', 'hello')]))), err => {
        assert.equal(err.code, entry.code)
        assert.ok(err.message.includes(entry.text), err.message)
        assert.equal(err.failure.status, entry.status)
        return true
      })
    })
  }
})

test('ACP errors with numeric, empty or object codes keep their message and get a string code (#1777)', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await assert.rejects(
    collect(adapter.stream(options('s1', [user('m1', 'rpc-error-number')]))),
    err => err.code === 'LOCAL_AGENT_ERROR' && /approval was cancelled \(JSON-RPC -32603\)/.test(err.message),
  )
  await assert.rejects(
    collect(adapter.stream(options('s2', [user('m1', 'rpc-error-empty')]))),
    err => err.code === 'LOCAL_AGENT_ERROR' && /empty code/.test(err.message),
  )
  await assert.rejects(
    collect(adapter.stream(options('s3', [user('m1', 'rpc-error-object')]))),
    err => err.code === 'LOCAL_AGENT_ERROR' && /"reason":"stopped"/.test(err.message) && !/\[object Object\]/.test(err.message),
  )
})


test('stream reports live thoughts, tool activities and end-of-stream idle to the turn tracker', async (t) => {
  const seen = []
  const records = {}
  const adapter = makeAdapter({
    records,
    rt: { warn: () => {}, noteLocalAgentEvent: (sessionId, event) => seen.push([sessionId, event.type, event.text ?? null, event.team === true]) },
  })
  t.after(() => adapter.dispose())
  const out = await collect(adapter.stream(options('s1', [user('m1', 'inspect files')])))
  assert.equal(out.finish.kind, 'stop')
  assert.deepEqual(seen, [
    ['s1', 'thought', 'thought about: The conversation so far (oldest first):\n', false],
    ['s1', 'activity', '▸ Read src/a.js', false],
    ['s1', 'activity', '▸ Run `npm test`', false],
    ['s1', 'text', 'ok: The conversation so far (oldest first):\n\nUser: inspect files', false],
    ['s1', 'idle', null, false],
  ])
  // A request DS Bot makes for itself never reports live turn activity.
  seen.length = 0
  assert.equal(await adapter.compact('s1'), 'done')
  assert.deepEqual(seen, [])
})

test('stream reports idle in finally when a consumer terminates the generator early', async (t) => {
  const seen = []
  const adapter = makeAdapter({
    rt: { warn: () => {}, noteLocalAgentEvent: (sessionId, event) => seen.push([sessionId, event.type, event.text ?? null]) },
  })
  t.after(() => adapter.dispose())
  const gen = adapter.stream(options('s1', [user('m1', 'inspect files')]))
  for await (const chunk of gen) {
    if (chunk.type === 'reasoning-delta' && chunk.text.includes('Read src/a.js')) break
  }
  assert.equal(seen.some(([, type, text]) => type === 'activity' && text === '▸ Read src/a.js'), true)
  assert.deepEqual(seen.at(-1), ['s1', 'idle', null])
})

test('Devin and Cursor recorded ACP team-MCP streams emit only team-marked activities', async (t) => {
  const seen = []
  const adapter = makeAdapter({
    rt: { warn: () => {}, noteLocalAgentEvent: (sessionId, event) => seen.push([sessionId, event.type, event.text ?? null, event.team === true]) },
  })
  t.after(() => adapter.dispose())
  const devin = await collect(adapter.stream(options('s1', [user('m1', 'devin-team')])))
  assert.equal(devin.calls[0]?.name, 'message_bot')
  assert.deepEqual(seen.filter(([, type]) => type === 'activity' || type === 'status'), [
    ['s1', 'activity', '▸ Calling message_bot from dsbot', true],
  ])
  assert.deepEqual(seen.at(-1), ['s1', 'idle', null, false])

  seen.length = 0
  const cursor = await collect(adapter.stream(options('s2', [user('m1', 'team-permission')])))
  assert.equal(cursor.calls[0]?.name, 'message_bot')
  assert.deepEqual(seen.filter(([, type]) => type === 'activity' || type === 'status'), [
    ['s2', 'activity', '▸ dsbot: message_bot', true],
  ])
  assert.deepEqual(seen.at(-1), ['s2', 'idle', null, false])
})

test('codex app-server ignores non-tool items and unwraps shell -lc wrappers', () => {
  assert.equal(unwrapShellCommand('/bin/zsh -lc pwd'), 'pwd')
  assert.equal(unwrapShellCommand('/bin/zsh -lc "python3 -c \'print(\\"hi\\")\'"'), 'python3 -c \'print("hi")\'')
  assert.equal(unwrapShellCommand(['/bin/bash', '-lc', 'git status -sb']), 'git status -sb')
  const engine = new CodexEngine('local-codex-cli', { name: 'Codex' }, { findExecutable: () => undefined })
  const thread = engine.threadFor('s1')
  thread.threadId = 't1'
  const pushed = []
  thread.push = event => pushed.push(event)
  engine.onNotice('item/started', { threadId: 't1', turnId: 'u1', item: { type: 'userMessage', text: 'hi' } })
  engine.onNotice('item/started', { threadId: 't1', turnId: 'u1', item: { type: 'developerMessage', text: 'sys' } })
  engine.onNotice('item/started', { threadId: 't1', turnId: 'u1', item: { type: 'agentMessage', text: '' } })
  engine.onNotice('item/started', { threadId: 't1', turnId: 'u1', item: { type: 'commandExecution', command: '/bin/zsh -lc pwd' } })
  engine.onNotice('item/completed', { threadId: 't1', turnId: 'u1', item: { type: 'agentMessage', text: 'done' } })
  assert.deepEqual(pushed, [
    { type: 'activity', text: '▸ pwd', turnId: 'u1' },
    { type: 'text', text: 'done', turnId: 'u1' },
  ])
})
