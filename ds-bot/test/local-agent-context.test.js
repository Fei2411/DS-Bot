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
import { AcpEngine, modelsFromProbe, usageOf } from '../src/host/local-agents/acp.js'
import { ENGINES } from '../src/host/local-agents/engines.js'
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

function makeAdapter({ kind = 'acp', args = [], records = {}, usage = [], engines = [] } = {}) {
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
