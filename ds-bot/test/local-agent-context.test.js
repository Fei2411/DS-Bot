// A local agent Bot's context, the way every other Bot's is handled: DS Bot reads how
// full the CLI session is from what the CLI reports, the steward decides past the
// check line or after the CLI condensed on its own, the CLI condenses on request and
// writes the handoff note, and the part moves on.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { LocalAgentAdapter, mergeUsage } from '../src/host/local-agents/adapter.js'
import { AcpEngine, modelsFromProbe, usageOf } from '../src/host/local-agents/acp.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { ENGINES } from '../src/host/local-agents/engines.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { install as partsInstall } from '../src/host/parts.js'
import { runStatsOf } from '../src/client/text.js'
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

function makeAdapter({ kind = 'acp', args = [], records = {}, usage = [], engines = [], windows = {}, windowSaves = [] } = {}) {
  const file = FIXTURE(kind === 'acp' ? 'fake-acp.mjs' : 'fake-codex.mjs')
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (engineKind, route, spec) => {
      const engine = engineKind === 'acp'
        ? new AcpEngine(route, { ...spec, command: process.execPath, args: [file, ...args] }, { findExecutable: path => path })
        : new CodexEngine(route, { ...spec, command: process.execPath, args: [file, ...args] }, { findExecutable: path => path })
      engines.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    savedWindow: (route, model) => windows[`${route}/${model}`],
    saveWindow: (route, model, size) => {
      windows[`${route}/${model}`] = size
      windowSaves.push([route, model, size])
    },
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

test('cancelling an ACP compaction after its prompt ended still cancels the native work', async t => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await turn(adapter, 's1', [user('m1', 'hello')])
  const live = adapter.live.get('s1')
  const controller = new AbortController()
  const completed = Promise.withResolvers()
  const notice = live.engine.onNotice.bind(live.engine)
  const cancel = live.engine.cancel.bind(live.engine)
  let cancellations = 0
  live.engine.onNotice = (method, params) => {
    notice(method, params)
    if (method !== '_cognition.ai/compaction') return
    if (params.status === 'started') controller.abort(new Error('stopped during compaction'))
    if (params.status === 'completed') completed.resolve()
  }
  live.engine.cancel = session => { cancellations += 1; return cancel(session) }
  await assert.rejects(adapter.compact('s1', controller.signal), /stopped during compaction/)
  assert.equal(cancellations, 1)
  assert.equal(live.state, 'idle')
  assert.equal(live.waiters.length, 0)
  await completed.promise
})

test('Codex compaction cancellation uses the compaction item turn, including cancellation before it starts', async () => {
  const message = recorded('codex-app-server-0.166.json').find(message => message.method === 'item/started' && message.params.item.type === 'contextCompaction')
  for (const beforeStart of [false, true]) {
    const engine = new CodexEngine('local-codex-cli', { name: 'Codex' }, { findExecutable: () => undefined })
    const thread = engine.threadFor('s1')
    thread.threadId = message.params.threadId
    thread.turnId = 'previous-turn'
    const calls = []
    engine.peer = { request: async (method, params) => { calls.push({ method, params }); return {} } }
    engine.compact(thread)
    const cancelled = beforeStart ? engine.cancel(thread) : undefined
    engine.onNotice(message.method, message.params)
    await (beforeStart ? cancelled : engine.cancel(thread))
    assert.deepEqual(calls.filter(call => call.method === 'turn/interrupt'), [{
      method: 'turn/interrupt',
      params: { threadId: thread.threadId, turnId: message.params.turnId },
    }])
  }
})

test('a refused Codex compaction releases a cancellation waiting for its turn id', async () => {
  const engine = new CodexEngine('local-codex-cli', { name: 'Codex' }, { findExecutable: () => undefined })
  const thread = engine.threadFor('s1')
  thread.threadId = 'thread'
  const rejected = Promise.withResolvers()
  engine.peer = { request: () => rejected.promise }
  engine.compact(thread)
  const cancelled = engine.cancel(thread)
  rejected.reject(new Error('compaction refused'))
  await cancelled
  assert.equal((await thread.next()).type, 'error')
  assert.equal(thread.turnId, undefined)
})

for (const terminal of ['exit', 'close', 'forget']) {
  test(`an accepted Codex compaction releases pending cancellation on ${terminal}`, async t => {
    const adapter = makeAdapter({ kind: 'codex', args: ['--hold-compact'] })
    let exited
    t.after(async () => { await adapter.dispose(); await exited })
    await turn(adapter, 's1', [user('m1', 'hello')], 'local-codex-cli')
    const live = adapter.live.get('s1')
    const engine = live.engine
    const thread = live.engineSession
    const child = engine.child
    exited = new Promise(resolve => child.once('close', resolve))
    const accepted = Promise.withResolvers()
    const waiting = Promise.withResolvers()
    const request = engine.peer.request.bind(engine.peer)
    engine.peer.request = (method, params, options) => {
      const result = request(method, params, options)
      if (method === 'thread/compact/start') result.then(accepted.resolve, accepted.reject)
      return result
    }
    const cancel = engine.cancel.bind(engine)
    engine.cancel = session => {
      const result = cancel(session)
      waiting.resolve()
      return result
    }
    const controller = new AbortController()
    let settled = false
    const failed = assert.rejects(adapter.compact('s1', controller.signal), /stopped/).then(() => { settled = true })
    await accepted.promise
    controller.abort(new Error('stopped before the turn id'))
    await waiting.promise
    assert.ok(thread.compactionCancel)
    if (terminal === 'exit') {
      child.kill('SIGTERM')
      await exited
    } else if (terminal === 'close') await engine.close()
    else engine.forget('s1')
    await new Promise(setImmediate)
    assert.equal(settled, true)
    await failed
    assert.equal(thread.pendingCompaction, false)
    assert.equal(thread.compactionCancel, undefined)
    assert.equal(live.waiters.length, 0)
  })
}

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

test('Codex one-off requests exit their own processes while the conversation keeps its process', async t => {
  const engines = []
  const closed = []
  const adapter = makeAdapter({ kind: 'codex', engines })
  t.after(() => adapter.dispose())
  const spawn = adapter.deps.spawnEngine
  adapter.deps.spawnEngine = (...args) => {
    const engine = spawn(...args)
    const close = engine.close.bind(engine)
    engine.close = async () => {
      const child = engine.child
      await close()
      if (child !== undefined) closed.push(child)
    }
    return engine
  }
  const history = [user('m1', 'hello')]
  await turn(adapter, 's1', history, 'local-codex-cli')
  const main = engines[0].child
  for (let at = 0; at < 3; at += 1) {
    assert.match(await adapter.ask('s1', { system: 'Decide.', prompt: 'answer', signal: AbortSignal.timeout(30_000) }), /ok: answer/)
  }
  assert.equal(engines.length, 4)
  assert.equal(closed.length, 3)
  assert.ok(closed.every(child => child.exitCode !== null || child.signalCode !== null))
  assert.equal(main.exitCode, null)
  assert.equal(main.signalCode, null)
  assert.match((await turn(adapter, 's1', [...history, user('m2', 'next')], 'local-codex-cli')).text, /ok: next/)
})

test('disposing the adapter cancels an in-flight Codex one-off and waits for its process to exit', async t => {
  const engines = []
  const adapter = makeAdapter({ kind: 'codex', records: { s1: { route: 'local-codex-cli', model: 'default' } }, engines })
  t.after(() => adapter.dispose())
  const started = Promise.withResolvers()
  const spawn = adapter.deps.spawnEngine
  adapter.deps.spawnEngine = (...args) => {
    const engine = spawn(...args)
    const prompt = engine.prompt.bind(engine)
    engine.prompt = async (...args) => {
      const turnId = await prompt(...args)
      started.resolve(engine.child)
      return turnId
    }
    return engine
  }
  const rejected = assert.rejects(adapter.ask('s1', { system: 'Decide.', prompt: 'hold' }), /disposed/)
  const child = await started.promise
  await adapter.dispose()
  await rejected
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(adapter.sideRequests.size, 0)
  await assert.rejects(adapter.ask('s1', { system: 'Decide.', prompt: 'next' }), /disposed/)
  assert.equal(engines.length, 1)
})

test('a one-off session that opens after disposal is closed without starting its prompt', async t => {
  const adapter = makeAdapter({ kind: 'codex', records: { s1: { route: 'local-codex-cli', model: 'default' } } })
  t.after(() => adapter.dispose())
  const opening = Promise.withResolvers()
  const opened = Promise.withResolvers()
  let prompts = 0
  let closes = 0
  const engine = {
    open: () => { opening.resolve(); return opened.promise },
    prompt: () => { prompts += 1 },
    close: async () => { closes += 1; opened.resolve({}) },
  }
  adapter.deps.spawnEngine = () => engine
  const rejected = assert.rejects(adapter.ask('s1', { system: 'Decide.', prompt: 'next' }), /disposed/)
  await opening.promise
  await adapter.dispose()
  await rejected
  assert.equal(prompts, 0)
  assert.equal(closes, 2)
  assert.equal(adapter.sideRequests.size, 0)
})

test('overlapping ACP one-off requests retain their shared process until both finish', async t => {
  const adapter = makeAdapter({ records: { s1: { route: 'local-acp-fake', model: 'default' } } })
  t.after(() => adapter.dispose())
  const engine = adapter.engine('local-acp-fake')
  const started = Promise.withResolvers()
  const prompt = engine.prompt.bind(engine)
  engine.prompt = (session, blocks, options) => {
    const result = prompt(session, blocks, options)
    if (blocks.some(block => block.text?.endsWith('hang'))) started.resolve()
    return result
  }
  const controller = new AbortController()
  const rejected = assert.rejects(adapter.ask('s1', { system: 'Decide.', prompt: 'hang', signal: controller.signal }), /stopped/)
  await started.promise
  const child = engine.child
  const exited = new Promise(resolve => child.once('close', resolve))
  t.after(async () => { controller.abort(new Error('stopped')); await adapter.dispose(); await exited })
  assert.match(await adapter.ask('s1', { system: 'Decide.', prompt: 'answer' }), /ok:/)
  assert.equal(adapter.sideRequests.size, 1)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  controller.abort(new Error('stopped'))
  await rejected
  await exited
  assert.equal(adapter.sideRequests.size, 0)
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

test('a busy DSH maintenance owner defers local compaction without scheduling a switch', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await import('@deepseek-ai/dsh-agent-loop-testkit')
  const ctx = new Context()
  const held = Promise.withResolvers()
  let work
  t.after(async () => { held.resolve(); await work; await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const actual = await ctx.agentLoop.create(SessionId('busy-maintenance'), { provider: 'test', model: 'test' })
  work = actual.runMaintenance(() => held.promise)
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, decision: 'compact', after: { used: 30_000 } })
  const agent = await run.rt.resolveAgent('s1')
  const admission = Promise.withResolvers()
  agent.runMaintenance = job => {
    admission.resolve()
    return actual.runMaintenance(job)
  }
  run.idle()
  await admission.promise
  await new Promise(setImmediate)
  assert.equal(run.rt.state.switching.s1, undefined)
  assert.deepEqual(run.warnings, [])
  held.resolve()
  await work
  run.idle()
  await new Promise(setImmediate)
  assert.equal(run.calls.compacts.length, 1)
  assert.equal(run.bot.sessionId, 's1')
})

test('cancelling local compaction does not trigger a background switch', async () => {
  const run = localPart({ context: { used: 220_000, size: 262_000, compactions: 0 }, decision: 'compact' })
  const agent = await run.rt.resolveAgent('s1')
  const controller = new AbortController()
  const compacting = Promise.withResolvers()
  agent.runMaintenance = job => job(controller.signal)
  run.rt.localAgentCompact = async (id, signal) => {
    compacting.resolve()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  run.idle()
  await compacting.promise
  controller.abort(new Error('user stopped'))
  await new Promise(setImmediate)
  assert.equal(run.rt.state.switching.s1, undefined)
  assert.deepEqual(run.warnings, [])
})

test('Antigravity 1.5.9, as recorded: models with per-model thinking levels, context window, commands, permissions, and separate cached usage', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE('recorded/antigravity-acp-1.5.9.json'), 'utf8'))
  const engine = new AcpEngine('local-antigravity', ENGINES['local-antigravity'], { findExecutable: () => undefined })
  const session = engine.sessionFor('s1')
  const id = fixture.sessionNew.sessionId
  session.acpSessionId = id
  const { queue } = drained(session)

  for (const message of fixture.messages) engine.onNotice(message.method, message.params)
  assert.ok(engine.commands.get(id).includes('compact'))
  assert.deepEqual(queue.filter(event => event.type === 'context'), [
    { type: 'context', used: 0, size: 1048576 },
    { type: 'context', used: 12701, size: 1048576 },
    { type: 'context', used: 12984, size: 1048576 },
  ])

  const mcpOutcome = await engine.onRequest('session/request_permission', fixture.requests[0].params)
  assert.deepEqual(mcpOutcome, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.equal(queue.filter(event => event.type === 'permission').length, 0)

  const cmdPending = engine.onRequest('session/request_permission', fixture.requests[1].params)
  const perm = queue.find(event => event.type === 'permission')
  assert.equal(perm.action, 'Run `pwd`')
  assert.equal(perm.changes, true)
  perm.reply(null)
  assert.deepEqual(await cmdPending, { outcome: { outcome: 'cancelled' } })

  const models = modelsFromProbe(fixture.sessionNew)
  assert.equal(models.length, 9)
  const byId = Object.fromEntries(models.map(entry => [entry.id, entry]))
  assert.deepEqual(byId['gemini-4-carbon'].reasoning.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['gemini-4-hydrogen'].reasoning.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(byId['gemini-4-hydrogen'].reasoning.defaultEffort, undefined)
  assert.equal(byId['gemini-pro-orchestrator'].reasoning, undefined)
  assert.equal(byId['gemini-pro-orchestrator-argon'].reasoning, undefined)
  assert.equal(byId['gpt-oss-120b-medium'].reasoning, undefined)

  assert.deepEqual(usageOf(fixture.promptResult.usage), {
    inputTokens: 17436,
    outputTokens: 137,
    cacheReadTokens: 8112,
  })
})

function makeScriptAdapter(script, { records = {}, engines = [] } = {}) {
  const usage = []
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = new AcpEngine(route, { ...spec, command: process.execPath, args: ['-e', script] }, { findExecutable: path => path })
      engines.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    patchRecord: (sessionId, patch) => { if (records[sessionId]) Object.assign(records[sessionId], patch) },
    recordUsage: entry => usage.push(entry),
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    probeCwd: () => tmpdir(),
    toolsFor: () => [],
  })
}

test('dispose() unblocks when a non-isolated ACP ask() is stuck waiting in engine.open()', async (t) => {
  const hangOpenScript = `
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\\n')
        }
      }
    })
  `
  const engines = []
  const adapter = makeScriptAdapter(hangOpenScript, {
    records: { s1: { route: 'local-acp-fake', model: 'default' } },
    engines,
  })
  t.after(async () => { for (const engine of engines) await engine.close().catch(() => {}) })

  const asked = adapter.ask('s1', { system: 'sys', prompt: 'hello' })
  asked.catch(() => {})
  while ((engines[0]?.peer?.nextId ?? 0) < 2 || (engines[0]?.peer?.pending?.size ?? 0) < 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const outcome = await Promise.race([
    adapter.dispose().then(() => 'disposed'),
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 2_000)),
  ])
  assert.equal(outcome, 'disposed')
  await assert.rejects(asked)
})

test('ask() finishing on a shared ACP engine does not close it underneath an in-flight probeModels()', async (t) => {
  const concurrentProbeScript = `
    let buf = '', next = 0, heldProbe = null, heldPrompt = null
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
          if (next === 0) {
            send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-' + (++next), configOptions: [] } })
          } else {
            // Second session/new is the concurrent probeModels() reusing this live peer.
            heldProbe = id
            if (heldPrompt !== null) {
              const p = heldPrompt; heldPrompt = null
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
              send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'end_turn' } })
            }
          }
        } else if (method === 'session/prompt') {
          if (heldProbe !== null) {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
          } else {
            heldPrompt = { id, sessionId: params.sessionId }
          }
        } else if (method === 'session/close') {
          send({ jsonrpc: '2.0', id, result: {} })
          if (params.sessionId === 'acp-1' && heldProbe !== null) {
            const probeId = heldProbe; heldProbe = null
            setTimeout(() => {
              send({ jsonrpc: '2.0', id: probeId, result: { sessionId: 'acp-probe', configOptions: [{ id: 'model', category: 'model', name: 'Model', options: [{ id: 'm-fast', name: 'Fast' }] }] } })
            }, 30)
          }
        } else if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        }
      }
    })
  `
  const engines = []
  const adapter = makeScriptAdapter(concurrentProbeScript, {
    records: { s1: { route: 'local-acp-fake', model: 'default' } },
    engines,
  })
  t.after(() => adapter.dispose())

  // Start ask() first so the shared live peer exists, then launch probeModels()
  // which reuses that live peer while ask() is still in flight.
  const asking = adapter.ask('s1', { system: 'sys', prompt: 'hi' })
  while (engines[0]?.peer === undefined || (engines[0]?.peer?.nextId ?? 0) < 3) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const probing = adapter.probeModels('local-acp-fake')

  const text = await asking
  assert.equal(text, 'ok')
  const models = await probing
  assert.deepEqual(models.map(model => model.id), ['default', 'm-fast'])
  assert.equal(engines[0].child, undefined)
})

// The model card's share is what the Session used over the window resolveModel reports:
// the loop stamps that figure into request/context and the contextPressure view hands it
// to `text.js`'s runStatsOf. Every local route answered DEFAULT_CONTEXT_WINDOW there, so a
// CLI that reports 1M -- antigravity-acp-1.5.9.json has 1048576 in every usage_update --
// read "Context 100%" from 200K up, with 200.0K on hover (#1823).
test('the window a CLI reports is the one its model card shows', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  // Before the CLI says anything, the fallback stands.
  assert.equal((await adapter.resolveModel('local-acp-fake', 'default')).context.contextWindow, 200_000)
  await turn(adapter, 's1', [user('m1', 'hello grow:100000')])
  assert.equal(adapter.contextOf('s1').size, 262_000)
  assert.equal((await adapter.resolveModel('local-acp-fake', 'default')).context.contextWindow, 262_000)
  // A route serves more than one model and the window is the model's: one the CLI has
  // not reported for keeps the fallback instead of inheriting its neighbour's size.
  adapter.live.get('s1').model = 'another-model'
  assert.equal((await adapter.resolveModel('local-acp-fake', 'another-model')).context.contextWindow, 200_000)
})

// A Session that was reopened on another model still carries the size it saved (the
// Session's own figure, which the parts module reads), but that figure must not become
// the new model's window. Usage-only reports are real -- claude.js sends the size
// optionally, and a turn that only spends tokens reports `used` alone -- so the old
// size used to be published under the new model's key: 262,000 for a model whose
// ceiling nobody had reported.
test('a usage-only report does not hand the previous model\'s window to the new one', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await turn(adapter, 's1', [user('m1', 'hello grow:100000')])
  assert.equal(adapter.contextOf('s1').size, 262_000)
  const live = adapter.live.get('s1')
  live.model = 'another-model'
  adapter.observe(live, { type: 'context', used: 5_000 })
  // The Session keeps the size it saved, so its own percentage still reads it.
  assert.deepEqual(adapter.contextOf('s1'), { used: 5_000, size: 262_000, compactions: 0 })
  // The model card still shows the fallback: nothing reported a window for it.
  assert.equal((await adapter.resolveModel('local-acp-fake', 'another-model')).context.contextWindow, 200_000)
  // A report that does carry a size is still the model's window.
  adapter.observe(live, { type: 'context', used: 5_100, size: 475_000 })
  assert.equal((await adapter.resolveModel('local-acp-fake', 'another-model')).context.contextWindow, 475_000)
})

function makeScriptEngineAdapter(kind, script, { records = {}, engines = [] } = {}) {
  const Ctor = kind === 'claude' ? ClaudeEngine : kind === 'codex' ? CodexEngine : AcpEngine
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, r, spec) => {
      const args = kind === 'claude' ? ['-e', script, '--'] : ['-e', script]
      const engine = new Ctor(r, { ...spec, command: process.execPath, args }, { findExecutable: path => path })
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
    toolsFor: () => [],
  })
}

test('Claude Code multi-step turn: preserves full cumulative billed tokens + num_turns calls while keeping single-step context', async (t) => {
  const claudeScript = `
    let buf = '', turn = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.type !== 'user') continue
        turn += 1
        if (turn === 1) {
          send({ type: 'system', subtype: 'init', session_id: 'cl-1', model: 'claude-sonnet-4-6' })
          // Two blocks sharing msg_1 (must count once), plus msg_2, msg_3, and a subagent message (ignored).
          send({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'plan' }], usage: { input_tokens: 2000, cache_read_input_tokens: 7500, output_tokens: 500 } } })
          send({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }], usage: { input_tokens: 2000, cache_read_input_tokens: 7500, output_tokens: 500 } } })
          send({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { id: 'msg_sub', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'sub.js' } }], usage: { input_tokens: 90000, output_tokens: 1000 } } })
          send({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'b.js' } }], usage: { input_tokens: 3000, cache_read_input_tokens: 18000, output_tokens: 1000 } } })
          send({ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 4000, cache_read_input_tokens: 30000, output_tokens: 1000 } } })
          send({
            type: 'result', subtype: 'success', is_error: false, num_turns: 12,
            usage: { input_tokens: 120000, cache_read_input_tokens: 5800000, cache_creation_input_tokens: 80000, output_tokens: 15000 },
            modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
          })
        } else {
          // Turn 2 omits num_turns: falls back to distinct main-session message.ids (2, ignoring subagent).
          send({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'thinking', thinking: 'hmm' }], usage: { input_tokens: 1000, cache_read_input_tokens: 34000, output_tokens: 200 } } })
          send({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'c.js' } }], usage: { input_tokens: 1000, cache_read_input_tokens: 34000, output_tokens: 200 } } })
          send({ type: 'assistant', parent_tool_use_id: 'toolu_sub2', message: { id: 'msg_sub2', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'sub2.js' } }], usage: { input_tokens: 50000, output_tokens: 500 } } })
          send({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'ok2' }], usage: { input_tokens: 1500, cache_read_input_tokens: 36000, output_tokens: 500 } } })
          send({
            type: 'result', subtype: 'success', is_error: false,
            usage: { input_tokens: 2500, cache_read_input_tokens: 70000, output_tokens: 700 },
            modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
          })
        }
      }
    })
  `
  const adapter = makeScriptEngineAdapter('claude', claudeScript)
  t.after(() => adapter.dispose())

  const first = await turn(adapter, 's1', [user('m1', 'do big work')], 'local-claude-code')
  assert.equal(first.text, 'done')
  assert.deepEqual(first.usage, {
    inputTokens: 120_000,
    outputTokens: 15_000,
    cacheReadTokens: 5_800_000,
    cacheWriteTokens: 80_000,
    calls: 12,
  })
  // Single-step context is the last main assistant message (4000 + 30000 + 1000 = 35000),
  // never the 6M cumulative multi-step sum or the 91K subagent step.
  assert.deepEqual(adapter.contextOf('s1'), { used: 35_000, size: 200_000, compactions: 0 })

  const second = await turn(adapter, 's1', [user('m1', 'do big work'), { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'done' }] }, user('m2', 'next')], 'local-claude-code')
  assert.equal(second.text, 'ok2')
  assert.deepEqual(second.usage, {
    inputTokens: 2_500,
    outputTokens: 700,
    cacheReadTokens: 70_000,
    calls: 2,
  })
  assert.deepEqual(adapter.contextOf('s1'), { used: 38_000, size: 200_000, compactions: 0 })
})

test('Codex multi-step turn deduplicates repeated totals, preserves coalesced deltas and cacheWrite, and skips thread/resume catch-up', async (t) => {
  const codexScript = `
    let buf = '', turnNo = 0, resumed = false
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
          send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'thread/start') {
          send({ jsonrpc: '2.0', id, result: { thread: { id: 'th-1' } } })
        } else if (method === 'thread/resume') {
          resumed = true
          // Catch-up tokenUsage emitted during thread/resume before any new turn starts:
          // must update context and baseline total without emitting billed usage.
          send({
            jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
            params: {
              threadId: params.threadId,
              tokenUsage: {
                total: { totalTokens: 60600, inputTokens: 60000, cachedInputTokens: 30000, cacheWriteInputTokens: 500, outputTokens: 600, reasoningOutputTokens: 100 },
                last: { totalTokens: 22000, inputTokens: 21800, cachedInputTokens: 12000, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                modelContextWindow: 475000,
              },
            },
          })
          send({ jsonrpc: '2.0', id, result: { thread: { id: params.threadId } } })
        } else if (method === 'turn/start') {
          turnNo += 1
          const turnId = (resumed ? 'tr-' : 't-') + turnNo
          send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
          send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
          if (!resumed) {
            // Step 1 (with cacheWriteInputTokens)
            send({
              jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId, turnId,
                tokenUsage: {
                  total: { totalTokens: 10100, inputTokens: 10000, cachedInputTokens: 4000, cacheWriteInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 },
                  last: { totalTokens: 10100, inputTokens: 10000, cachedInputTokens: 4000, cacheWriteInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 },
                  modelContextWindow: 475000,
                },
              },
            })
            // Step 2
            send({
              jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId, turnId,
                tokenUsage: {
                  total: { totalTokens: 25300, inputTokens: 25000, cachedInputTokens: 12000, cacheWriteInputTokens: 500, outputTokens: 300, reasoningOutputTokens: 50 },
                  last: { totalTokens: 15200, inputTokens: 15000, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 30 },
                  modelContextWindow: 475000,
                },
              },
            })
            // Duplicate unchanged total (must NOT double-count tokens or increment calls)
            send({
              jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId, turnId,
                tokenUsage: {
                  total: { totalTokens: 25300, inputTokens: 25000, cachedInputTokens: 12000, cacheWriteInputTokens: 500, outputTokens: 300, reasoningOutputTokens: 50 },
                  last: { totalTokens: 15200, inputTokens: 15000, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 30 },
                  modelContextWindow: 475000,
                },
              },
            })
            // Step 3 (coalesced delta: total jumped by 35000 input / 300 output while last is 21800 / 200)
            send({
              jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId, turnId,
                tokenUsage: {
                  total: { totalTokens: 60600, inputTokens: 60000, cachedInputTokens: 30000, cacheWriteInputTokens: 500, outputTokens: 600, reasoningOutputTokens: 100 },
                  last: { totalTokens: 22000, inputTokens: 21800, cachedInputTokens: 12000, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 },
                  modelContextWindow: 475000,
                },
              },
            })
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', text: 'step3-done' } } })
            send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } })
          } else {
            // Post-resume Turn 2: total advances by 24000 input (15000 cached), 250 output.
            send({
              jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId, turnId,
                tokenUsage: {
                  total: { totalTokens: 84850, inputTokens: 84000, cachedInputTokens: 45000, cacheWriteInputTokens: 500, outputTokens: 850, reasoningOutputTokens: 100 },
                  last: { totalTokens: 24250, inputTokens: 24000, cachedInputTokens: 15000, cacheWriteInputTokens: 0, outputTokens: 250, reasoningOutputTokens: 0 },
                  modelContextWindow: 475000,
                },
              },
            })
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', text: 'resumed-ok' } } })
            send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } })
          }
        }
      }
    })
  `
  const records = {}
  const adapter = makeScriptEngineAdapter('codex', codexScript, { records })
  t.after(() => adapter.dispose())

  const first = await turn(adapter, 's1', [user('m1', 'run tools')], 'local-codex-cli')
  assert.equal(first.text, 'step3-done')
  // Exact total spend: input (uncached) = 60000 - 30000 - 500 = 29500, cacheRead = 30000, cacheWrite = 500, output = 600, reasoning = 100, calls = 3.
  assert.deepEqual(first.usage, {
    inputTokens: 29_500,
    outputTokens: 600,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 500,
    reasoningTokens: 100,
    calls: 3,
  })
  // Single-step context stays at last.totalTokens (22000), not cumulative 60600.
  assert.deepEqual(adapter.contextOf('s1'), { used: 22_000, size: 475_000, compactions: 0 })

  // Close live session to force thread/resume on Turn 2.
  await adapter.closeSession('s1')
  const second = await turn(adapter, 's1', [
    user('m1', 'run tools'),
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'step3-done' }] },
    user('m2', 'follow up'),
  ], 'local-codex-cli')
  assert.equal(second.text, 'resumed-ok')
  // Only Turn 2's delta is billed (24000 - 15000 = 9000 uncached, 15000 cached, 250 output); single call omits `calls`.
  assert.deepEqual(second.usage, {
    inputTokens: 9_000,
    outputTokens: 250,
    cacheReadTokens: 15_000,
  })
  assert.deepEqual(adapter.contextOf('s1'), { used: 24_250, size: 475_000, compactions: 0 })
})

test('ACP multi-step prompt (Antigravity 1.5.9 recorded trace): counts internal steps, deduplicates identical usage_update, ignores session/load replay', async (t) => {
  const fixturePath = FIXTURE('recorded/antigravity-acp-1.5.9.json')
  const acpReplayScript = `
    const { readFileSync } = require('node:fs')
    const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'))
    const sid = fixture.sessionNew.sessionId
    let buf = ''
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
          send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
        } else if (method === 'session/new') {
          send({ jsonrpc: '2.0', id, result: { sessionId: sid, configOptions: [] } })
          // Historical replay notice outside any active prompt: updates context, must NOT inflate next turn's calls.
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 9000, size: 1048576 } } })
        } else if (method === 'session/prompt') {
          for (const m of fixture.messages) {
            if (m.method === 'session/update') send({ jsonrpc: '2.0', method: m.method, params: m.params })
          }
          // Duplicate back-to-back usage_update with identical used and no work between (must be deduped).
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 12984, size: 1048576 } } })
          send({ jsonrpc: '2.0', id, result: fixture.promptResult })
        } else if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        }
      }
    })
  `
  const adapter = makeScriptEngineAdapter('acp', acpReplayScript)
  t.after(() => adapter.dispose())

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const out = await turn(adapter, 's1', [user('m1', 'run recorded trace')])
  assert.deepEqual(out.usage, { ...usageOf(fixture.promptResult.usage), calls: 2 })
  // Single-step context is 12984, NOT the cumulative 25685 sum across both steps.
  assert.deepEqual(adapter.contextOf('s1'), { used: 12_984, size: 1_048_576, compactions: 0 })
})

test('mergeUsage accumulates additive tokens and call counts without emitting calls=1 for single-step turns', () => {
  const single = mergeUsage(undefined, { inputTokens: 100, outputTokens: 20, calls: 1 })
  assert.deepEqual(single, { inputTokens: 100, outputTokens: 20 })
  const two = mergeUsage(single, { inputTokens: 200, outputTokens: 30, cacheReadTokens: 500 })
  assert.deepEqual(two, { inputTokens: 300, outputTokens: 50, cacheReadTokens: 500, calls: 2 })
  const multi = mergeUsage(two, { inputTokens: 400, outputTokens: 40, cacheWriteTokens: 100, calls: 3 })
  assert.deepEqual(multi, { inputTokens: 700, outputTokens: 90, cacheReadTokens: 500, cacheWriteTokens: 100, calls: 5 })
})

test('channel run-stats replaces distorted cumulative DSH contextPressure with CLI per-step context occupancy', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-run-stats-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Coder', role: 'Dev', sessionId: 'dm-b1', model: 'local-claude-code/sonnet', createdAt: 1 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    localAgents: {
      custom: [],
      sessions: {
        'dm-b1': { route: 'local-claude-code', model: 'sonnet', context: { used: 42_000, size: 200_000 }, compactions: 0 },
      },
    },
    revision: 0,
  }))

  const dshSnapshot = {
    values: {
      sessionStats: { turns: 1, decodeMs: 5000, decodeTokens: 500 },
      tokenUsage: { uncachedInputTokens: 120_000, cacheReadTokens: 5_800_000, cacheWriteTokens: 80_000, outputTokens: 15_000 },
      // Cumulative 6M tokens from DSH's usage-projection on a 200K window:
      contextPressure: { pressureTokens: 6_000_000, projectedTokens: 6_000_000, contextWindow: 200_000 },
    },
  }
  const ctx = fakeContext({ services: { sessionProjections: { snapshot: () => dshSnapshot } } })
  const session = {
    id: 'dm-b1',
    requestHeader: () => ({ config: { provider: 'local-claude-code', model: 'sonnet' } }),
  }
  const agent = {
    id: 'dm-b1',
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [], remove: () => false },
    async whenIdle() {},
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    sessionController: { resolveAgent: async () => ({ agent }) },
  })
  let route
  const origReg = ctx.connection.fetch.register
  ctx.connection.fetch.register = (opts) => { route = opts; return origReg(opts) }

  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()

  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const res = await call('run-stats', { botId: 'b1' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.contextPressure, {
    pressureTokens: 42_000,
    projectedTokens: 42_000,
    contextWindow: 200_000,
  })
  const rendered = runStatsOf(res.value)
  const ctxItem = rendered.find(item => item.key === 'context')
  assert.equal(ctxItem?.text, 'Context 21%')
  assert.equal(ctxItem?.title, '42.0K of 200.0K tokens of context in use')

  // When CLI context is stale after compaction (used === undefined), omit contextPressure
  // instead of falling back to DSH's cumulative 6M figure.
  rt.state.localAgents.sessions['dm-b1'].context = { used: 42_000, size: 200_000, stale: true }
  rt.state.localAgents.sessions['dm-b1'].compactions = 1
  const staleRes = await call('run-stats', { botId: 'b1' })
  assert.equal(staleRes.ok, true)
  assert.equal(staleRes.value.contextPressure, undefined)
  assert.equal(runStatsOf(staleRes.value).find(item => item.key === 'context'), undefined)
})

test('a CLI-reported context window persists across restarts without redundant saves (#1896)', async (t) => {
  const records = {}
  const windows = {}
  const windowSaves = []
  const first = makeAdapter({ records, windows, windowSaves })
  t.after(() => first.dispose())

  await turn(first, 's1', [system('sys', 'rules'), user('m1', 'hello')])
  assert.deepEqual(windowSaves, [['local-acp-fake', 'default', 262_000]])

  // A second turn with the same window must not trigger redundant saves.
  await turn(first, 's1', [system('sys', 'rules'), user('m1', 'hello'), { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('m2', 'again')])
  assert.equal(windowSaves.length, 1)

  // A fresh adapter (simulated host restart) hydrates the persisted window before any turn runs.
  const restarted = makeAdapter({ records, windows, windowSaves })
  t.after(() => restarted.dispose())
  assert.equal((await restarted.resolveModel('local-acp-fake', 'default')).context.contextWindow, 262_000)
  // Another model on the same route must not inherit the first model's window.
  assert.equal((await restarted.resolveModel('local-acp-fake', 'other-model')).context.contextWindow, 200_000)
  // dropWindows clears in-memory cache by route or globally.
  delete windows['local-acp-fake/default']
  restarted.dropWindows('local-acp-fake')
  assert.equal((await restarted.resolveModel('local-acp-fake', 'default')).context.contextWindow, 200_000)
})

test('settling, suspending on call/permission, or collecting flushes CLI context occupancy to disk (#1896)', async (t) => {
  const saved = {}
  const liveRecords = {}
  const saveCounts = { s1: 0 }
  const file = FIXTURE('fake-acp.mjs')
  const make = () => new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new AcpEngine(route, { ...spec, command: process.execPath, args: [file] }, { findExecutable: path => path }),
    record: sessionId => liveRecords[sessionId],
    saveRecord: (sessionId, record) => {
      saveCounts[sessionId] = (saveCounts[sessionId] ?? 0) + 1
      liveRecords[sessionId] = record
      saved[sessionId] = structuredClone(record)
    },
    patchRecord: (sessionId, patch) => {
      if (liveRecords[sessionId]) Object.assign(liveRecords[sessionId], patch)
    },
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [],
  })

  const first = make()
  t.after(() => first.dispose())
  const history = [system('sys', 'rules'), user('m1', 'hello grow:10000')]
  const firstOut = await turn(first, 's1', history)
  const usedAfterFirst = first.contextOf('s1').used
  assert.equal(saved.s1.context.used, usedAfterFirst)

  // Turn 2 with unchanged window still flushes updated occupancy on settle.
  await turn(first, 's1', [...history, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: firstOut.text }] }, user('m2', 'more grow:20000')])
  const usedAfterSecond = first.contextOf('s1').used
  assert.ok(usedAfterSecond > usedAfterFirst)
  assert.equal(saved.s1.context.used, usedAfterSecond)

  // Suspending on a bridged call or permission flushes dirty context before returning.
  const live = first.live.get('s1')
  const beforeSuspendSaves = saveCounts.s1
  first.observe(live, { type: 'context', used: usedAfterSecond + 1234, size: 262_000 })
  assert.equal(live.contextDirty, true)
  live.push({ type: 'call', name: 'list_bots', args: {}, dshCallId: 'dsbot-1' })
  const chunks = []
  for await (const chunk of first.drain(live, { signal: AbortSignal.timeout(5_000) })) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.reason?.kind, 'tool-calls')
  assert.equal(saveCounts.s1, beforeSuspendSaves + 1)
  assert.equal(saved.s1.context.used, usedAfterSecond + 1234)
  assert.equal(live.contextDirty, false)

  // Invalid negative or non-integer context figures are ignored.
  first.observe(live, { type: 'context', used: -5, size: 1.5 })
  assert.equal(live.context.used, usedAfterSecond + 1234)
  assert.equal(live.context.size, 262_000)

  // collect() flushes dirty context on settle as well.
  const beforeCollectSaves = saveCounts.s1
  first.observe(live, { type: 'context', used: usedAfterSecond + 2000, size: 262_000 })
  live.events.length = 0
  live.events.push({ type: 'text', text: 'note body' }, { type: 'done', reason: 'end_turn' })
  const collected = await first.collect(live, () => first.take(live), AbortSignal.timeout(5_000))
  assert.equal(collected.text, 'note body')
  assert.equal(saveCounts.s1, beforeCollectSaves + 1)
  assert.equal(saved.s1.context.used, usedAfterSecond + 2000)
})

test('savedWindow/saveWindow guard prototype keys and custom agent update/remove/adopt clear windows (#1896)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-win-guard-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: [],
    bots: {},
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    localAgents: {
      custom: [{ id: 'mycli', name: 'My CLI', command: process.execPath, args: ['-v'] }],
      sessions: {},
      // Deliberately corrupted windows value (array) to verify store() sanitizes it.
      windows: ['bad'],
    },
    revision: 0,
  }))
  const adapters = new Map()
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [...adapters.keys()].map(id => ({ id })),
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      registerAdapter: (routes, adapter) => {
        for (const r of routes) adapters.set(r, adapter)
        return Object.assign(() => { for (const r of routes) adapters.delete(r) }, {
          replace(next) {
            adapters.clear()
            for (const r of next) adapters.set(r, adapter)
          },
        })
      },
    },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  const route = 'local-acp-mycli'
  const adapter = adapters.get(route)
  assert.ok(adapter, 'custom agent route should be registered')

  // Prototype pollution attempts must be ignored without touching Object or Object.prototype.
  adapter.deps.saveWindow('constructor', 'pollutedTestProp', 999_999)
  adapter.deps.saveWindow('__proto__', 'pollutedProtoProp', 999_999)
  adapter.deps.saveWindow(route, '__proto__', 999_999)
  assert.equal(Object.pollutedTestProp, undefined)
  assert.equal(({}).pollutedProtoProp, undefined)
  assert.equal(adapter.deps.savedWindow('constructor', 'toString'), undefined)
  assert.equal(adapter.deps.savedWindow(route, 'toString'), undefined)

  // Persisted window hydrates via resolveModel and clears when command/args change.
  adapter.deps.saveWindow(route, 'default', 512_000)
  assert.equal((await adapter.resolveModel(route, 'default')).context.contextWindow, 512_000)

  // Renaming only keeps the cached window.
  await rt.localAgentsEndpoint('local-agent-update', { id: 'mycli', name: 'Renamed CLI' })
  assert.equal(rt.state.localAgents.windows[route]?.default, 512_000)

  // Changing command/args drops both persisted and in-memory windows.
  await rt.localAgentsEndpoint('local-agent-update', { id: 'mycli', args: ['--version'] })
  assert.equal(rt.state.localAgents.windows[route], undefined)
  assert.equal((await adapter.resolveModel(route, 'default')).context.contextWindow, 200_000)

  // Removing the custom agent also drops persisted and in-memory windows.
  adapter.deps.saveWindow(route, 'default', 768_000)
  assert.equal((await adapter.resolveModel(route, 'default')).context.contextWindow, 768_000)
  await rt.localAgentsEndpoint('local-agent-remove', { id: 'mycli' })
  assert.equal(rt.state.localAgents.windows[route], undefined)
  assert.equal(adapter.windows.size, 0)
})

test('CLI profile config update and removal drop persisted and in-memory windows (#1896)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-prof-win-'))
  const profileDir = join(home, 'profiles', 'codex-work')
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: [],
    bots: {
      b1: { id: 'b1', name: 'Work Codex', role: 'Dev', sessionId: 'dm-b1', model: 'local-codex-cli@work/gpt-5.4', createdAt: 1 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    localAgents: {
      custom: [],
      profiles: [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: profileDir }],
      retiredProfiles: [],
      sessions: {},
      windows: {},
    },
    revision: 0,
  }))
  const adapters = new Map()
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [...adapters.keys()].map(id => ({ id })),
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      registerAdapter: (routes, adapter) => {
        for (const r of routes) adapters.set(r, adapter)
        return Object.assign(() => { for (const r of routes) adapters.delete(r) }, {
          replace(next) {
            adapters.clear()
            for (const r of next) adapters.set(r, adapter)
          },
        })
      },
    },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  const route = 'local-codex-cli@work'
  const adapter = adapters.get(route)
  assert.ok(adapter, 'profile route should be registered via Bot ref')

  adapter.deps.saveWindow(route, 'gpt-5.4', 1_048_576)
  assert.equal((await adapter.resolveModel(route, 'gpt-5.4')).context.contextWindow, 1_048_576)

  // Renaming a profile keeps its learned window.
  await rt.localAgentsEndpoint('local-agent-profile-update', { baseRoute: 'local-codex-cli', id: 'work', name: 'Work Renamed' })
  assert.equal(rt.state.localAgents.windows[route]?.['gpt-5.4'], 1_048_576)

  // Changing profile env clears persisted and in-memory windows for that profile route.
  await rt.localAgentsEndpoint('local-agent-profile-update', { baseRoute: 'local-codex-cli', id: 'work', env: { OPENAI_BASE_URL: 'https://example.invalid/v1' } })
  assert.equal(rt.state.localAgents.windows[route], undefined)
  assert.equal((await adapter.resolveModel(route, 'gpt-5.4')).context.contextWindow, 200_000)

  // Removing a profile clears persisted and in-memory windows as well.
  adapter.deps.saveWindow(route, 'gpt-5.4', 512_000)
  assert.equal((await adapter.resolveModel(route, 'gpt-5.4')).context.contextWindow, 512_000)
  await rt.localAgentsEndpoint('local-agent-profile-remove', { baseRoute: 'local-codex-cli', id: 'work' })
  assert.equal(rt.state.localAgents.windows[route], undefined)
  assert.equal(adapter.windows.size, 0)
})
