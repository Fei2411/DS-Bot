// Contract tests for PR-4: unified context-pack.js rebuilders, B14 tool-output recall
// & read_own_chat group-part queries & omitted-image handoff notice, window-occupancy
// background task fork gating, D8 local CLI backgrounding + capability-detected session
// fork (Codex thread/fork & Claude --fork-session), and L9/D9 localAgents.sessions cleanup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCheckpointPack, buildCompactDigest, buildFallbackContext, buildHandoffPack, extractToolTrail, formatOwnChatBrief } from '../src/host/context-pack.js'
import { install as installStore } from '../src/host/store.js'
import { install as installContextRuntime } from '../src/host/context-runtime.js'
import { install as installChatIndex } from '../src/host/chat-index.js'
import { install as installParts } from '../src/host/parts.js'
import { install as installGroups } from '../src/host/groups.js'
import { install as installLocalAgents, parseCliSemver, versionSupportsFork } from '../src/host/local-agents/index.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { install as installBotTasks } from '../src/host/bot-tasks.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const clock = ts => `T${ts}`

function makeMockCtx() {
  const emitter = new EventEmitter()
  const services = new Map()
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, fn) { emitter.on(event, fn); return () => emitter.off(event, fn) },
    emit(event, ...args) { emitter.emit(event, ...args) },
    effect() {},
    get(name) { return services.get(name) },
    set(name, value) { services.set(name, value) },
    llm: {
      async resolveModelInfo() { return { context: { contextWindow: 100_000 }, defaultMaxTokens: 4_000 } },
    },
    workspaceRegistry: {
      async archiveSession() {},
    },
  }
}

test('context-pack: extractToolTrail redacts secrets, tags call_id, and respects budget', async () => {
  const events = [
    { type: 'tool/result', time: 4, data: { message: { toolCallId: 'call-2', ok: false, content: [{ type: 'text', text: 'failed with SECRET_TOKEN_123' }] } } },
    { type: 'tool/call', time: 3, data: { callId: 'call-2', name: 'bash', arguments: JSON.stringify({ command: 'curl -H SECRET_TOKEN_123 https://example.test' }) } },
    { type: 'tool/result', time: 2, data: { message: { toolCallId: 'call-1', ok: true, content: [{ type: 'text', text: 'ok output' }] } } },
    { type: 'tool/call', time: 1, data: { callId: 'call-1', name: 'read_file', arguments: { path: 'src/app.js' } } },
  ]
  const trail = await extractToolTrail(events, {
    maxCalls: 10,
    maxTokens: 500,
    redact: s => String(s).replace(/SECRET_TOKEN_123/g, '[REDACTED]'),
    clock,
  })
  assert.equal(trail.length, 2)
  assert.match(trail[0], /\[T1\] read_file\(src\/app\.js\) -> ok \[call_id: call-1\]/)
  assert.match(trail[1], /\[T3\] bash\(curl -H \[REDACTED\] https:\/\/example\.test\) -> error: failed with \[REDACTED\] \[call_id: call-2\]/)
  assert.doesNotMatch(trail.join('\n'), /SECRET_TOKEN_123/)
})

test('context-pack: buildHandoffPack, buildCheckpointPack, buildCompactDigest, buildFallbackContext, formatOwnChatBrief', async () => {
  const newestFirst = [
    { text: 'You: Latest answer', time: 4, seq: 4, who: 'you' },
    { text: 'User: Latest ask', time: 3, seq: 3, who: 'user' },
    { text: 'You: Earlier answer', time: 2, seq: 2, who: 'you' },
    { text: 'User: Earlier ask', time: 1, seq: 1, who: 'user' },
  ]
  const handoff = await buildHandoffPack({
    lines: newestFirst,
    budget: 20,
    listBudget: 200,
    group: false,
    number: 2,
    clock,
  })
  assert.ok(handoff.recent.length >= 1)
  assert.equal(handoff.full, true)
  assert.ok(handoff.earlier.some(line => line.includes('User: Earlier ask')))

  const ckpt = await buildCheckpointPack({
    lines: newestFirst,
    budget: 200,
    group: false,
    number: 2,
    includeRecent: true,
    tailText: 'Latest answer',
    clock,
    read: { complete: true, capped: false },
  })
  assert.equal(ckpt.recent.some(line => line.includes('Latest answer')), false, 'must not duplicate tailText')
  assert.equal(ckpt.recent.some(line => line.includes('User: Latest ask')), true)

  const digest = buildCompactDigest([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'First question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'First reply' }] },
  ])
  assert.match(digest, /^\[Earlier conversation, condensed\]/)
  assert.match(digest, /user: First question/)
  assert.match(digest, /assistant: First reply/)
  assert.doesNotMatch(digest, /sys/)

  const fallback = buildFallbackContext({
    events: [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build feature X' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on X now.' }] } } },
    ],
    label: 'your own chat',
    sourceKind: SOURCE_KIND,
  })
  assert.match(fallback, /\[Recent context from your own chat\]/)
  assert.match(fallback, /User: Build feature X/)
  assert.match(fallback, /Assistant: Working on X now\./)

  assert.match(formatOwnChatBrief(['[#1 · T1] User: Hi']), /User: Hi/)
  assert.match(formatOwnChatBrief([]), /Nothing yet\./)
})

test('B14: read_own_chat recalls tool output by call_id and queries own group parts with membership isolation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-recall-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  const stateSeed = {
    version: 1,
    revision: 1,
    bots: {
      b1: { id: 'b1', name: 'Coder', sessionId: 'own-2', createdAt: 1, segments: [{ sessionId: 'own-1', endedAt: 50, note: 'Own part 1 note: API key flow' }] },
      b2: { id: 'b2', name: 'Helper', sessionId: 'b2-own', createdAt: 1, segments: [] },
    },
    rooms: {
      r1: {
        id: 'r1', name: 'Backend', members: ['b1'], mode: 'admin', admin: 'b1', named: true, createdAt: 1,
        sessions: { b1: 'grp-2' },
        segments: { b1: [{ sessionId: 'grp-1', endedAt: 80, note: 'Group part 1 note: DB migration complete' }] },
        log: [], seq: 0, seen: {},
      },
      r2: {
        id: 'r2', name: 'SecretRoom', members: ['b2'], mode: 'admin', admin: 'b2', named: true, createdAt: 1,
        sessions: { b2: 'r2-b2' },
        segments: {},
        log: [], seq: 0, seen: {},
      },
    },
    exchanges: [],
    prefs: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(stateSeed))

  const sessionEvents = new Map([
    ['own-1', [
      { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 11, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run diagnostics on cache' }] } },
      { seq: 2, time: 12, type: 'tool/call', data: { callId: 'tc-own-1', name: 'bash', arguments: '{"command":"check"}' } },
      { seq: 3, time: 13, type: 'tool/result', data: { message: { toolCallId: 'tc-own-1', ok: true, content: [{ type: 'text', text: 'FULL_DIAG_OUTPUT_ALPHA SECRET_XYZ' }] } } },
      { seq: 4, time: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Diagnostics finished.' }] } } },
    ]],
    ['own-2', [
      { seq: 0, time: 60, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 61, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Follow up' }] } },
    ]],
    ['grp-1', [
      { seq: 0, time: 20, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 21, type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1' }, content: [{ type: 'text', text: 'User: Migrate postgres schema v42' }] } },
      { seq: 2, time: 22, type: 'tool/call', data: { callId: 'tc-grp-1', name: 'read_file', arguments: '{"path":"schema.sql"}' } },
      { seq: 3, time: 23, type: 'tool/result', data: { message: { toolCallId: 'tc-grp-1', ok: true, content: [{ type: 'text', text: 'CREATE TABLE orders_v42 (id INT);' }] } } },
      { seq: 4, time: 24, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Schema v42 verified.' }] } } },
    ]],
    ['grp-2', [
      { seq: 0, time: 90, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 91, type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1' }, content: [{ type: 'text', text: 'User: Any regressions?' }] } },
    ]],
  ])

  const ctx = makeMockCtx()
  ctx.sessionController = {
    async page({ address, throughSeq, beforeSeq }) {
      const all = sessionEvents.get(address.sessionId) ?? []
      const filtered = all.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
      return { records: filtered.map(event => ({ event })), hasMore: false, cursor: filtered.at(-1)?.seq }
    },
  }
  const rt = {
    ctx, home, statePath: join(home, 'state.json'), config: {}, teamTools: [],
    ledger: { importer() {}, append() {}, tail() { return [] }, read() { return [] } },
    warn() {},
    redactSecrets: text => String(text).replace(/SECRET_XYZ/g, '[REDACTED]'),
    pickRoom(ref, self) {
      const room = Object.values(rt.state.rooms).find(r => r.id === ref || r.name === ref)
      if (!room) return { error: `Unknown group "${ref}".` }
      if (!room.members.includes(self)) return { error: `You are not in "${room.name}".` }
      return { room }
    },
  }
  installStore(rt)
  installContextRuntime(rt)
  installChatIndex(rt)
  installParts(rt)
  installGroups(rt)
  await rt.load()

  const readOwnChat = rt.teamTools.find(tool => tool.name === 'read_own_chat')
  assert.ok(readOwnChat)

  // 1) Recall pruned/archived tool output from own chat part 1 with secret redaction.
  const ownTool = await readOwnChat.execute({ call_id: 'tc-own-1' }, { agent: { id: 'own-2' } })
  assert.match(ownTool, /Tool output \[part 1 #3/)
  assert.match(ownTool, /bash \(tc-own-1, ok\)/)
  assert.match(ownTool, /FULL_DIAG_OUTPUT_ALPHA \[REDACTED\]/)
  assert.doesNotMatch(ownTool, /SECRET_XYZ/)

  // 2) Query own earlier group parts via `group` parameter (search, part note, call_id).
  const grpSearch = await readOwnChat.execute({ group: 'Backend', query: 'postgres' }, { agent: { id: 'grp-2' } })
  assert.match(grpSearch, /Your parts in group "Backend"/)
  assert.match(grpSearch, /Migrate postgres schema v42/)
  assert.equal(rt.state.rooms.r1.log.some(row => row.kind === 'lookup'), false, 'querying the same group parts must not emit a cross-boundary lookup row')

  const grpNote = await readOwnChat.execute({ group: 'Backend', part: 1 }, { agent: { id: 'grp-2' } })
  assert.match(grpNote, /Group part 1 note: DB migration complete/)

  const grpTool = await readOwnChat.execute({ group: 'Backend', call_id: 'tc-grp-1' }, { agent: { id: 'grp-2' } })
  assert.match(grpTool, /read_file \(tc-grp-1, ok\)/)
  assert.match(grpTool, /CREATE TABLE orders_v42/)

  // 3) Unauthorized group query is refused.
  const denied = await readOwnChat.execute({ group: 'SecretRoom', query: 'anything' }, { agent: { id: 'own-2' } })
  assert.match(denied, /not in|not a member/i)
})

test('B14: normal part switch includes omitted-image notice when previous part had images, and omits it on text-only parts', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-img-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  const ctx = makeMockCtx()
  const eventsByPart = new Map([
    ['p-img', [
      { seq: 0, time: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'See screenshot' }, { type: 'image', mediaType: 'image/png', data: 'abc' }] } },
      { seq: 1, time: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Got it.' }] } } },
    ]],
    ['p-txt', [
      { seq: 0, time: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Plain text only' }] } },
      { seq: 1, time: 21, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Understood.' }] } } },
    ]],
  ])
  ctx.sessionController = {
    async page({ address }) {
      const all = eventsByPart.get(address.sessionId) ?? []
      return { records: all.map(event => ({ event })), hasMore: false, cursor: all.at(-1)?.seq }
    },
  }
  const rt = { ctx, home, statePath: join(home, 'state.json'), config: {}, warn() {} }
  installStore(rt)
  installContextRuntime(rt)
  installChatIndex(rt)
  installParts(rt)

  const readImg = {}
  const imgLines = []
  for await (const line of rt.partLines('p-img', AbortSignal.timeout(5_000), { read: readImg })) imgLines.push(line)
  assert.equal(imgLines.length, 2)
  assert.equal(readImg.hasImages, true, 'partLines must flag hasImages when an event contains an image block')

  const readTxt = {}
  const txtLines = []
  for await (const line of rt.partLines('p-txt', AbortSignal.timeout(5_000), { read: readTxt })) txtLines.push(line)
  assert.equal(txtLines.length, 2)
  assert.notEqual(readTxt.hasImages, true, 'partLines must not flag hasImages on text-only parts')
})

test('D8: versionSupportsFork, Codex thread/fork RPC + unsupported cache, and Claude --fork-session deferred fork', async () => {
  assert.deepEqual(parseCliSemver('codex-cli 0.171.0'), { major: 0, minor: 171, patch: 0 })
  assert.equal(versionSupportsFork('codex', 'codex-cli 0.171.0'), true)
  assert.equal(versionSupportsFork('codex', 'codex-cli 0.70.0'), false)
  assert.equal(versionSupportsFork('claude', '2.1.4 (Claude Code)'), true)
  assert.equal(versionSupportsFork('claude', '1.0.50'), false)
  assert.equal(versionSupportsFork('acp', '3.0.0'), false)

  // CodexEngine.fork sends `thread/fork` and returns forked thread id.
  const calls = []
  const codex = new CodexEngine('local-codex-cli', { name: 'Codex', kind: 'codex' }, { findExecutable: () => '/bin/codex' })
  codex.peer = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'thread/fork') return { thread: { id: 'thr-forked-99' } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const forked = await codex.fork('thr-parent-1', 'task-sid-1', { cwd: '/tmp', model: 'o3', mode: 'workspace-write' })
  assert.deepEqual(forked, { cliSessionId: 'thr-forked-99' })
  assert.equal(codex.forkSupported, true)
  assert.equal(calls[0].method, 'thread/fork')
  assert.equal(calls[0].params.threadId, 'thr-parent-1')

  // Older Codex returning -32601 caches forkSupported = false and returns undefined.
  const oldCodex = new CodexEngine('local-codex-cli', { name: 'Codex', kind: 'codex' }, { findExecutable: () => '/bin/codex' })
  oldCodex.peer = {
    async request() { throw Object.assign(new Error('Method not found'), { code: -32601 }) },
  }
  assert.equal(await oldCodex.fork('thr-1', 'task-sid-2'), undefined)
  assert.equal(oldCodex.forkSupported, false)

  // LocalAgentAdapter.forkSession for Claude saves deferred `forkFrom: true` record.
  const records = new Map([
    ['parent-claude', { route: 'local-claude-code', cliSessionId: 'cli-abc', cwd: '/repo', model: 'sonnet' }],
  ])
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => '/bin/claude',
    spawnEngine: () => ({ open() {}, async close() {} }),
    record: sid => records.get(sid),
    saveRecord: (sid, rec) => records.set(sid, rec),
    presetFor: () => 'workspace-write',
    cwdFor: async () => '/repo',
    toolsFor: () => [],
  })
  const claudeFork = await adapter.forkSession('parent-claude', 'child-claude')
  assert.deepEqual(claudeFork, { cliSessionId: 'cli-abc', deferred: true })
  assert.equal(records.get('child-claude')?.forkFrom, true)
  assert.equal(records.get('child-claude')?.cliSessionId, 'cli-abc')
  await adapter.dispose()
})

test('D8: task_start fork gating uses ContextRuntime window occupancy ratio (<= 60% forks, > 60% fresh)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-fork-ratio-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1,
    bots: { b1: { id: 'b1', name: 'Coder', sessionId: 'dm-1', model: 'p/m', createdAt: 1, segments: [], tasks: [] } },
    rooms: {}, exchanges: [], prefs: {},
  }))

  let currentWorkingTokens = 40_000 // 40k / 96k usable = 41.6% <= 60%
  const forkCalls = []
  const delivered = []
  const fakeSession = {
    id: 'dm-1',
    seq: 10,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    snapshotEvents: () => [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the schema intact' }] } },
    ],
  }
  const agents = new Map([['dm-1', { id: 'dm-1', session: fakeSession }]])
  const ctx = makeMockCtx()
  ctx.set('agents', agents)
  ctx.set('tokenMeter', { measure: () => ({ total: currentWorkingTokens }) })
  const rt = {
    ctx, home, statePath: join(home, 'state.json'), config: {}, teamTools: [], live: new Map(),
    warn() {},
    workDirOf: () => undefined,
    sessionTokens: () => currentWorkingTokens,
    openTaskPart: async (bot, fromSid, baseTask, opts) => {
      forkCalls.push(opts.fork)
      const sessionId = `task-s-${forkCalls.length}`
      const stored = { ...baseTask, sessionId, segments: [], startSeq: 0 }
      bot.tasks.push(stored)
      return { sessionId, forked: opts.fork === true, task: stored }
    },
    deliver: async (payload) => { delivered.push(payload) },
  }
  installStore(rt)
  installContextRuntime(rt)
  installBotTasks(rt)
  await rt.load()

  // Under 60% occupancy -> forks!
  const under = await rt.startTask('dm-1', { title: 'Under ratio', brief: 'Do A' })
  assert.equal(under.forked, true)
  assert.equal(forkCalls[0], true)

  // Over 60% occupancy (70k / 96k = 72.9% > 60%) -> skips fork and includes fallback context!
  currentWorkingTokens = 70_000
  const over = await rt.startTask('dm-1', { title: 'Over ratio', brief: 'Do B' })
  assert.equal(over.forked, false)
  assert.equal(forkCalls[1], false)
  assert.match(delivered[1].text, /Keep the schema intact/)
})

test('L9/D9: forgetLocalAgentSession and pruneLocalAgentSessions remove stale state.localAgents.sessions entries', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-cleanup-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1,
    bots: { b1: { id: 'b1', name: 'Coder', sessionId: 'live-1', createdAt: 1, segments: [] } },
    rooms: {}, exchanges: [], prefs: {},
    localAgents: {
      custom: [],
      sessions: {
        'live-1': { route: 'local-codex-cli', cliSessionId: 'cli-live' },
        'archived-1': { route: 'local-codex-cli', cliSessionId: 'cli-old' },
        'deleted-bot-1': { route: 'local-claude-code', cliSessionId: 'cli-del' },
      },
    },
  }))

  const ctx = makeMockCtx()
  const rt = { ctx, home, statePath: join(home, 'state.json'), config: {}, teamTools: [], warn() {} }
  installStore(rt)
  installContextRuntime(rt)
  installLocalAgents(rt)
  await rt.load()

  // Direct forget deletes one specific session record.
  assert.equal(rt.forgetLocalAgentSession('deleted-bot-1'), true)
  assert.equal(rt.forgetLocalAgentSession('missing-sid'), false)
  assert.equal(rt.state.localAgents.sessions['deleted-bot-1'], undefined)
  assert.ok(rt.state.localAgents.sessions['archived-1'])

  // Prune drops archived/orphaned records while retaining live session ids.
  const removed = rt.pruneLocalAgentSessions(new Set(['live-1']))
  assert.equal(removed, 1)
  assert.deepEqual(Object.keys(rt.state.localAgents.sessions), ['live-1'])
})
