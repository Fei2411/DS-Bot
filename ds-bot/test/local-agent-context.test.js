// A local agent Bot's context, the way every other Bot's is handled: DS Bot reads how
// full the CLI session is from what the CLI reports, the steward decides past the
// check line or after the CLI condensed on its own, the CLI condenses on request and
// writes the handoff note, and the part moves on.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { install as partsInstall } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const recorded = name => JSON.parse(readFileSync(FIXTURE(`recorded/${name}`), 'utf8')).messages

// Every event a driver session queues from here on.
const drained = (session) => {
  const queue = []
  session.push = event => queue.push(event)
  return { queue }
}

test('Devin CLI 3000.12.43, as recorded: context, prompt usage, commands, and its compaction', () => {
  const engine = new AcpEngine('local-devin-cli', { name: 'Devin CLI' }, { findExecutable: () => undefined })
  const messages = recorded('devin-acp-3000.12.43.json')
  const id = messages.find(message => message.params?.sessionId)?.params.sessionId
  const session = engine.sessionFor('s1')
  session.acpSessionId = id
  const { queue } = drained(session)
  for (const message of messages) if (message.method !== undefined) engine.onNotice(message.method, message.params)
  const contexts = queue.filter(event => event.type === 'context')
  // One per answer: the copy marked as a subagent's is not the session's.
  assert.deepEqual(contexts, [{ type: 'context', used: 14493, size: 262000 }, { type: 'context', used: 14542, size: 262000 }, { type: 'context', used: 14833, size: 262000 }])
  assert.deepEqual(queue.filter(event => event.type === 'compaction').map(event => event.status), ['started', 'completed'])
  assert.ok(engine.commands.get(id).includes('compact'))
})

test('Codex 0.166, as recorded: the last request is the context, its usage counts apart, compaction is an item', () => {
  const engine = new CodexEngine('local-codex-cli', { name: 'Codex CLI' }, { findExecutable: () => undefined })
  const messages = recorded('codex-app-server-0.166.json')
  const thread = engine.threadFor('s1')
  thread.threadId = messages[0].params.threadId
  const { queue } = drained(thread)
  for (const message of messages) engine.onNotice(message.method, message.params)
  assert.deepEqual(queue.filter(event => event.type === 'context').map(event => [event.used, event.size]), [[25806, 475000], [25824, 475000], [29086, 475000], [26198, 475000]])
  // The compaction's own report spends nothing.
  assert.deepEqual(queue.filter(event => event.type === 'usage')[0].usage, { inputTokens: 25801 - 12288, outputTokens: 5, cacheReadTokens: 12288 })
  assert.equal(queue.filter(event => event.type === 'usage').length, 3)
  assert.deepEqual(queue.filter(event => event.type === 'compaction').map(event => event.status), ['started', 'completed'])
})

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })

function makeAdapter({ kind = 'acp', args = [], records = {}, usage = [] } = {}) {
  const file = FIXTURE(kind === 'acp' ? 'fake-acp.mjs' : 'fake-codex.mjs')
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (engineKind, route, spec) => (engineKind === 'acp'
      ? new AcpEngine(route, { ...spec, command: process.execPath, args: [file, ...args] }, { findExecutable: path => path })
      : new CodexEngine(route, { ...spec, command: process.execPath, args: [file, ...args] }, { findExecutable: path => path })),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    patchRecord: (sessionId, patch) => { if (records[sessionId]) Object.assign(records[sessionId], patch) },
    recordUsage: entry => usage.push(entry),
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [],
  })
}

async function turn(adapter, sessionId, messages, provider = 'local-acp-fake') {
  const out = { text: '', usage: undefined }
  for await (const chunk of adapter.stream({ provider, model: 'default', sessionId, messages, tools: [], signal: AbortSignal.timeout(30_000) })) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'usage') out.usage = chunk.usage
  }
  return out
}

test('an ACP agent: the context it reports, its compaction on request, and nothing of it in the next answer', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records })
  t.after(() => adapter.dispose())
  const history = [system('sys', 'team rules'), user('m1', 'hello grow:100000')]
  const first = await turn(adapter, 's1', history)
  assert.match(first.text, /ok:/)
  assert.deepEqual(first.usage, { inputTokens: 114050 - 30 - 9000, outputTokens: 30, cacheReadTokens: 9000 })
  assert.deepEqual(adapter.contextOf('s1'), { used: 114050, size: 262000, compactions: 0 })

  assert.equal(await adapter.compact('s1', AbortSignal.timeout(10_000)), 'done')
  // Devin says how full it is only with its next answer.
  assert.deepEqual(adapter.contextOf('s1'), { size: 262000, compactions: 1 })
  assert.equal(records.s1.compactions, 1)
  await new Promise(resolve => setTimeout(resolve, 100))

  const next = await turn(adapter, 's1', [...history, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: first.text }] }, user('m2', 'and now')])
  assert.doesNotMatch(next.text, /Context compacted/)
  // The compaction may have dropped the team rules it read as a prompt: they go again.
  assert.match(next.text, /ok: Updated team instructions/)
  assert.equal(adapter.contextOf('s1').used, 15050)
})

test('an ACP agent that lists no compact command condenses only on its own', async (t) => {
  const adapter = makeAdapter({ args: ['--no-compact'] })
  t.after(() => adapter.dispose())
  await turn(adapter, 's1', [user('m1', 'hello')])
  assert.equal(await adapter.compact('s1', AbortSignal.timeout(10_000)), 'unsupported')
  assert.equal(adapter.contextOf('s1').compactions, 0)
})

test('the handoff note is one more prompt in the CLI session; the next turn sends only what is new', async (t) => {
  const usage = []
  const adapter = makeAdapter({ usage })
  t.after(() => adapter.dispose())
  const history = [user('m1', 'hello')]
  await turn(adapter, 's1', history)
  const note = await adapter.note('s1', 'write the note', AbortSignal.timeout(10_000))
  assert.equal(note, 'ok: write the note')
  // What it spent counts for the Session it served.
  assert.deepEqual(usage.map(entry => [entry.sessionId, entry.kind, entry.provider]), [['s1', 'compaction', 'local-acp-fake']])
  const next = await turn(adapter, 's1', [...history, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('m2', 'go on')])
  assert.equal(next.text, 'ok: go on')
})

test('a one-off request runs in a session of its own and closes it', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await turn(adapter, 's1', [user('m1', 'hello')])
  const answer = await adapter.ask('s1', { system: 'You decide.', prompt: 'count-sessions', signal: AbortSignal.timeout(10_000) })
  // The Bot's session and this one were open while it answered.
  assert.equal(answer, 'sessions: 2')
  assert.equal(adapter.live.size, 1)
  assert.equal((await turn(adapter, 's1', [user('m1', 'hello'), user('m2', 'count-sessions')])).text, 'sessions: 1')
})

test('a one-off request the CLI refuses ends at once', async () => {
  const queue = { waiters: [], next: () => new Promise(resolve => queue.waiters.push(resolve)) }
  const engine = {
    open: async () => queue,
    prompt: async () => { throw new Error('turn/start refused') },
    forget: () => {},
  }
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} }, customAgents: () => [], findExecutable: () => undefined, spawnEngine: () => engine,
    record: () => ({ route: 'local-codex-cli', model: 'default' }), saveRecord: () => {}, presetFor: () => 'read-only',
    cwdFor: async () => tmpdir(), probeCwd: () => tmpdir(), toolsFor: () => [],
  })
  const started = Date.now()
  await assert.rejects(adapter.ask('s1', { system: 'decide', prompt: 'now', signal: AbortSignal.timeout(5_000) }), /refused/)
  assert.ok(Date.now() - started < 1_000)
})

test('Codex condenses in a turn of its own and reports what is left', async (t) => {
  const adapter = makeAdapter({ kind: 'codex' })
  t.after(() => adapter.dispose())
  await turn(adapter, 's1', [user('m1', 'hello grow:300000')], 'local-codex-cli')
  assert.equal(adapter.contextOf('s1').used, 325800)
  assert.equal(adapter.contextOf('s1').size, 475000)
  assert.equal(await adapter.compact('s1', AbortSignal.timeout(10_000)), 'done')
  assert.deepEqual(adapter.contextOf('s1'), { used: 29000, size: 475000, compactions: 1 })
})

test('a CLI that says its context is past its window fails the turn as an overflow', async () => {
  const adapter = makeAdapter()
  const live = { spec: { kind: 'acp' }, state: 'running', pending: new Map() }
  const queue = [{ type: 'error', error: new Error('Prompt is too long') }]
  await assert.rejects(adapter.collect(live, () => ({ event: Promise.resolve(queue.shift()), drop: () => {} })), error => error.code === 'CONTEXT_WINDOW_EXCEEDED')
})

// ---------------------------------------------------------------------------
// The parts module with a part on a local agent CLI.

const NOTE_SECTIONS = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
const goodNote = marker => NOTE_SECTIONS.map(name => `## ${name}\n- ${marker}`).join('\n\n')
const MESSAGES = [
  { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Port the parser' }], source: { kind: 'user' } },
  { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'The parser is ported and the tests pass.' }] },
]

function localPart({ context, team, decision = 'switch', note = goodNote('from-the-cli'), compact = 'done', after } = {}) {
  const calls = { steward: [], asks: [], notes: [], compacts: [], maintenance: 0, compactsHeld: 0 }
  let held = false
  const warnings = []
  const followed = []
  let current = { ...context }
  const ctx = fakeContext()
  ctx.logger = { warn: (...args) => warnings.push(format(...args)), info: () => {} }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm = {
    resolveModelInfo: async () => ({}),
    stream: (options) => {
      calls.steward.push(`${options.provider}/${options.model}`)
      const text = JSON.stringify({ action: decision, reason: 'test' })
      return (function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'local-devin-cli/default', segments: [] }
  const header = { config: { provider: 'local-devin-cli', model: 'default' }, tools: [] }
  const session = { id: 's1', header: { cwd: '/tmp/team' }, seq: 1, eventAt: () => undefined, requestHeader: () => header, deriveMessages: () => MESSAGES, toolHistory: () => [] }
  const maintain = async (job) => {
    calls.maintenance += 1
    held = true
    try { return await job(AbortSignal.timeout(10_000)) } finally { held = false }
  }
  const agent = { id: 's1', session, status: 'idle', whenIdle: async () => {}, runMaintenance: maintain, inbox: { nextStep: [], nextTurn: [] }, followup: message => followed.push(message), send: async () => {} }
  const fresh = { id: 's2', session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] }, status: 'idle', whenIdle: async () => {}, runMaintenance: async job => job(AbortSignal.timeout(10_000)), inbox: { nextStep: [], nextTurn: [] }, followup: message => followed.push(message), send: async () => {} }
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: team === undefined ? {} : { defaultBotModel: team }, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: (...args) => warnings.push(format(...args)),
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    chatOf: () => bot.sessionId,
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-'),
    isLocalAgentRoute: route => route.startsWith('local-'),
    engineOf: ref => (ref?.startsWith('local-') ? ref.split('/')[0] : 'model'),
    engineOfBot: subject => rt.engineOf(subject?.model),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: new Map(),
    liveOf: () => ({}),
    groupSessionsOf: () => [],
    partsOf: () => [],
    partLines: async function* () {
      yield { who: 'you', text: 'You: The parser is ported and the tests pass.', seq: 2, time: 1 }
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
    tagUsage: messages => messages,
    defaultModel: async () => undefined,
    localAgentContext: () => (current.used === undefined && current.size === undefined && !current.compactions ? undefined : current),
    localAgentAsk: async (id, request) => { calls.asks.push(request.prompt); return JSON.stringify({ action: decision, reason: 'cli' }) },
    localAgentNote: async (id, prompt) => {
      calls.notes.push(prompt)
      if (note instanceof Error) throw note
      return note
    },
    localAgentCompact: async () => {
      calls.compacts.push(true)
      if (held) calls.compactsHeld += 1
      if (compact === 'done') current = { ...current, ...after, compactions: (current.compactions ?? 0) + 1 }
      return compact
    },
  }
  partsInstall(rt)
  const idle = () => ctx.listeners.get('agent/status').forEach(listener => listener({ agent, status: 'idle' }))
  const settle = async () => {
    for (let at = 0; at < 100 && bot.sessionId !== 's2'; at += 1) await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { rt, bot, calls, warnings, followed, idle, settle, setContext: (next) => { current = { ...current, ...next } } }
}

const packageOf = run => run.followed.map(message => message?.content?.map?.(block => block.text).join('') ?? '').join('\n')

test('past the check line, the steward on the CLI says switch: the CLI writes the note and the part moves on', async () => {
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, team: 'deepseek/v4' })
  run.idle()
  await run.settle()
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  // What the conversation runs on answers, not the team's default model.
  assert.deepEqual(run.calls.steward, [])
  assert.equal(run.calls.asks.length, 1)
  assert.equal(run.calls.notes.length, 1)
  assert.match(run.calls.notes[0], /handoff note to yourself/)
  assert.match(packageOf(run), /from-the-cli/)
})

test('work still under way: the CLI condenses and the part stays', async () => {
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, team: 'deepseek/v4', decision: 'compact', after: { used: 30_000 } })
  run.idle()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(run.calls.compacts.length, 1)
  // Under the agent's maintenance: no turn can start on the CLI session meanwhile.
  assert.equal(run.calls.compactsHeld, 1)
  assert.equal(run.bot.sessionId, 's1')
})

test('a CLI that condensed without saying how full it is now: still past the line at the next turn, the part moves on', async () => {
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, team: 'deepseek/v4', decision: 'compact', after: { used: undefined } })
  run.idle()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(run.bot.sessionId, 's1')
  run.setContext({ used: 215_000 })
  run.idle()
  await run.settle()
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  assert.equal(run.calls.asks.length, 1)
})

test('below the check line, a compaction the CLI ran on its own still gets the steward', async () => {
  const run = localPart({ context: { used: 40_000, size: 262_000, compactions: 0 }, team: 'deepseek/v4' })
  run.idle()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(run.calls.asks.length, 0)
  run.setContext({ used: 45_000, compactions: 1 })
  run.idle()
  await run.settle()
  assert.equal(run.calls.asks.length, 1)
  assert.equal(run.bot.sessionId, 's2')
})

test('a CLI that reports nothing about its context is not checked', async () => {
  const run = localPart({ context: {}, team: 'deepseek/v4' })
  run.idle()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(run.calls.asks.length, 0)
  assert.equal(run.bot.sessionId, 's1')
})

test('a note the CLI could not write: the part still moves on, with the package', async () => {
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, team: 'deepseek/v4', note: new Error('the agent failed') })
  run.idle()
  await run.settle()
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  assert.match(packageOf(run), /did not write a usable note/)
})
