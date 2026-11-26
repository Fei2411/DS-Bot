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
import { REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'

const clock = ts => `T${ts}`

function makeMockCtx() {
  const emitter = new EventEmitter()
  const services = new Map()
  const disposers = []
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, fn) { emitter.on(event, fn); return () => emitter.off(event, fn) },
    emit(event, ...args) { emitter.emit(event, ...args) },
    effect(fn) {
      const stop = fn?.()
      if (typeof stop === 'function') disposers.push(stop)
    },
    async dispose() {
      for (const stop of disposers.splice(0).reverse()) await stop()
    },
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
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { source: { kind: 'ds-bot-own-memory' }, content: [{ type: 'text', text: '## Your memory (MEMORY.md)\nNOISE_MEM' }] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>NOISE_AGENTS_MD</system-reminder>' }] } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
      { seq: 4, type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'kickoff' }, content: [{ type: 'text', text: '[Bot team setup] NOISE_KICKOFF' }] } },
      { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build feature X' }] } },
      { seq: 6, type: 'user/message', data: { source: { kind: REPLY_KIND, callId: 'ask-1', outcome: 'answered' }, content: [{ type: 'text', text: 'Picked option Alpha' }] } },
      { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on X now.' }] } } },
      { seq: 8, type: 'turn/end', data: { turn: 1 } },
      { seq: 9, type: 'turn/start', data: { turn: 2 } },
      { seq: 10, type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'request' }, content: [{ type: 'text', text: 'SECRET_PEER_DELEGATION' }] } },
      { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'SECRET_PEER_REPLY' }] } } },
      { seq: 12, type: 'turn/end', data: { turn: 2 } },
    ],
    label: 'your own chat',
    sourceKind: SOURCE_KIND,
    excludeTurns: new Set([2]),
  })
  assert.match(fallback, /\[Recent context from your own chat\]/)
  assert.match(fallback, /User: Build feature X/)
  assert.match(fallback, /User: Picked option Alpha/, 'user-question-reply card answers must survive in fallback context')
  assert.match(fallback, /Assistant: Working on X now\./)
  assert.doesNotMatch(fallback, /NOISE_MEM|NOISE_AGENTS_MD|Time sampled|NOISE_KICKOFF/, 'must filter out DSH/plugin context injections and kickoff boilerplate')
  assert.doesNotMatch(fallback, /SECRET_PEER/, 'excludeTurns must strip hidden peer-Bot turns completely')

  // A second consecutive non-forked bot-handoff or fg-handoff preserves prior carriedContext
  // (stripping any stale [Background task notice] prefix) and clips plain lines recency-first.
  const fgNoticeWithContext = `[Background task notice] Your earlier turn ("Build X", t1) moved to the background.${fallback}`
  const secondFallback = buildFallbackContext({
    events: [
      { seq: 0, type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'task-handoff', carriedContext: true }, content: [{ type: 'text', text: fgNoticeWithContext }] } },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Second user follow-up' }] } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Second reply.' }] } } },
      { seq: 4, type: 'turn/end', data: { turn: 1 } },
    ],
    label: 'your own chat',
    sourceKind: SOURCE_KIND,
  })
  assert.match(secondFallback, /Build feature X/, 'second non-forked handoff must retain carriedContext from first handoff')
  assert.doesNotMatch(secondFallback, /\[Background task notice\]/, 'must strip stale background notice wrapper when carrying forward context')
  assert.match(secondFallback, /Second user follow-up/)

  const clippedRecent = buildFallbackContext({
    events: [
      {
        seq: 0,
        type: 'user/message',
        data: {
          source: { kind: SOURCE_KIND, role: 'task-handoff', carriedContext: true },
          content: [{ type: 'text', text: '[Recent context from your own chat]\nUser: OLDEST_LINE_SHOULD_DROP\nUser: MIDDLE_LINE\nUser: NEWEST_LINE_MUST_STAY' }],
        },
      },
    ],
    label: 'your own chat',
    sourceKind: SOURCE_KIND,
    maxChars: 45,
    noteMinChars: 45,
  })
  assert.match(clippedRecent, /NEWEST_LINE_MUST_STAY/, 'plain carriedContext must clip recency-first (keep tail)')
  assert.doesNotMatch(clippedRecent, /OLDEST_LINE_SHOULD_DROP/)

  assert.match(formatOwnChatBrief(['[#1 · T1] User: Hi']), /User: Hi/)
  assert.match(formatOwnChatBrief([]), /Nothing yet\./)
})

test('B14: read_own_chat recalls tool output by call_id and queries own group parts with membership isolation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-recall-'))
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

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

  ctx.sessionController = {
    async page({ address, throughSeq, beforeSeq }) {
      const all = sessionEvents.get(address.sessionId) ?? []
      const filtered = all.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
      return { records: filtered.map(event => ({ event })), hasMore: false, cursor: filtered.at(-1)?.seq }
    },
  }
  const rt = {
    ctx, home, statePath: join(home, 'state.json'), config: {}, teamTools: [], roomProgress: new Map(),
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

  // 4) Querying a group from private chat does NOT hide the target group's latest finished turn.
  const crossRoomLatest = await readOwnChat.execute({ group: 'Backend', query: 'regressions' }, { agent: { id: 'own-2' } })
  assert.match(crossRoomLatest, /Any regressions\?/, 'group lookup from private chat must not hide the group current session latest turn')
})

test('B14 regressions: pruned replacement never overwrites original tool output, and upgraded v5 sealed parts backfill tool_outputs', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-prune-recall-'))
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1,
    bots: {
      b1: { id: 'b1', name: 'Coder', sessionId: 'p2', createdAt: 1, segments: [{ sessionId: 'p1', endedAt: 100 }] },
    },
    rooms: {}, exchanges: [], prefs: {},
  }))

  // p1 contains an original tool/result at seq 2 (with real DSH `sourceEventSeqs: [1]` linking its tool/call)
  // AND a pruned surfaceOp replace at seq 5 with the same callId.
  const sessionEvents = new Map([
    ['p1', [
      { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 11, type: 'tool/call', data: { callId: 'tc-big', name: 'read_file', arguments: '{"path":"big.log"}' } },
      { seq: 2, time: 12, type: 'tool/result', sourceEventSeqs: [1], data: { message: { toolCallId: 'tc-big', ok: true, content: [{ type: 'text', text: 'ORIGINAL_FULL_DIAGNOSTIC_PAYLOAD_9999' }] } } },
      { seq: 3, time: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reviewed.' }] } } },
      { seq: 4, time: 14, type: 'compaction/prune', data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2] } },
      { seq: 5, time: 15, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2], data: { message: { toolCallId: 'tc-big', ok: true, content: [{ type: 'text', text: '[pruned output]' }] } } },
    ]],
    ['p2', [
      { seq: 0, time: 200, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 201, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check big.log again' }] } },
    ]],
  ])

  ctx.sessionController = {
    async page({ address, throughSeq, beforeSeq }) {
      const all = sessionEvents.get(address.sessionId) ?? []
      const filtered = all.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
      return { records: filtered.map(event => ({ event })), hasMore: false, cursor: filtered.at(-1)?.seq }
    },
  }
  const rt = { ctx, home, statePath: join(home, 'state.json'), config: {}, warn() {} }
  installStore(rt)
  installContextRuntime(rt)
  installChatIndex(rt)
  installParts(rt)
  await rt.load()

  // Seed a pre-upgrade v5 database where p1 is already marked sealed in `marks`, with empty `tool_outputs`/`tool_marks`.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'chat-index.sqlite'))
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, text, session, seq, time, who);
    CREATE INDEX messages_session_seq ON messages (session, seq);
    CREATE INDEX messages_session_time ON messages (session, time DESC);
    CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
    CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
    INSERT INTO marks (session, through, keep, sealed, turn) VALUES ('p1', 5, 1, 1, 0);
    PRAGMA user_version = 5;
  `)
  db.close()

  // Recalling tc-big must backfill from p1 despite sealed text mark AND return the ORIGINAL unpruned payload!
  const recalled = await rt.recallToolOutput('b1', 'tc-big', { askingId: 'p2' })
  assert.equal(recalled.found, true)
  assert.equal(recalled.seq, 2)
  assert.equal(recalled.text, 'ORIGINAL_FULL_DIAGNOSTIC_PAYLOAD_9999')
  assert.doesNotMatch(recalled.text, /\[pruned output\]/)

  // extractToolTrail also skips replacement events and keeps the original outcome.
  const trail = await extractToolTrail([...sessionEvents.get('p1')].reverse(), { clock })
  assert.equal(trail.length, 1)
  assert.match(trail[0], /read_file\(big\.log\) -> ok \[call_id: tc-big\]/)
})

test('D8 regressions: Claude rejected --fork-session retries once on fresh session with fallbackContext (never resuming parent); openTaskPart probes fork on demand and preserves parent inheritedSegments', async (t) => {
  // 1) Claude deferred fork rejected before init retries cleanly on a fresh session without resumeId and delivers fallbackContext.
  const records = new Map([
    ['parent-c', { route: 'local-claude-code', cliSessionId: 'cli-parent-1', cwd: '/repo', model: 'sonnet' }],
  ])
  const openCalls = []
  const promptCalls = []
  const fakeEngine = {
    forkSupported: undefined,
    open(sid, args) {
      openCalls.push({ sid, resumeId: args.resumeId, forkSession: args.forkSession })
      if (args.forkSession === true) {
        this.forkSupported = false
        let emitted = false
        return Promise.resolve({
          dead: true,
          cliSessionId: undefined,
          forkUnsupported: true,
          next() {
            if (!emitted) {
              emitted = true
              return Promise.resolve({ type: 'error', error: new Error('unknown option: --fork-session') })
            }
            return new Promise(() => {})
          },
          whenSessionId() { return Promise.resolve(undefined) },
        })
      }
      let step = 0
      return Promise.resolve({
        dead: false,
        cliSessionId: 'cli-fresh-child-2',
        next() {
          step += 1
          if (step === 1) return Promise.resolve({ type: 'text', text: 'Child succeeded on fresh session.' })
          if (step === 2) return Promise.resolve({ type: 'done', reason: 'stop' })
          return new Promise(() => {})
        },
        whenSessionId() { return Promise.resolve('cli-fresh-child-2') },
      })
    },
    prompt(_session, blocks) { promptCalls.push(blocks) },
    forget() {},
    async close() {},
  }
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => '/bin/claude',
    spawnEngine: () => fakeEngine,
    record: sid => records.get(sid),
    saveRecord: (sid, rec) => records.set(sid, rec),
    presetFor: () => 'workspace-write',
    cwdFor: async () => '/repo',
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  const forked = await adapter.forkSession('parent-c', 'child-c', { fallbackContext: '[Recent context from your own chat]\nUser: Keep port 8080' })
  assert.equal(forked.deferred, true)
  // Stage a second deferred fork BEFORE the first discovers --fork-session is unsupported.
  const forked2 = await adapter.forkSession('parent-c', 'child-c-2', { fallbackContext: '[Recent context from your own chat]\nUser: Keep port 9090' })
  assert.equal(forked2.deferred, true)

  const chunks = []
  for await (const chunk of adapter.stream({
    sessionId: 'child-c',
    provider: 'local-claude-code',
    model: 'sonnet',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'Run task' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(openCalls.length, 2, 'must retry once after --fork-session rejection')
  assert.deepEqual(openCalls[0], { sid: 'child-c', resumeId: 'cli-parent-1', forkSession: true })
  assert.deepEqual(openCalls[1], { sid: 'child-c', resumeId: undefined, forkSession: false }, 'retry must open fresh session and NEVER resume parent without --fork-session')
  const promptText = promptCalls.flat().map(b => b.text ?? '').join('\n')
  assert.match(promptText, /Keep port 8080/, 'fresh retry must deliver retained fallbackContext')
  assert.equal(records.get('child-c')?.cliSessionId, 'cli-fresh-child-2')
  assert.equal(records.get('child-c')?.forkFrom, undefined)
  assert.equal(records.get('child-c')?.forkFallbackContext, undefined)

  // Second already-staged deferred fork opens directly on a fresh session with its fallbackContext.
  promptCalls.length = 0
  for await (const _chunk of adapter.stream({
    sessionId: 'child-c-2',
    provider: 'local-claude-code',
    model: 'sonnet',
    messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: 'Run second task' }] }],
  })) {
    chunks.push(_chunk)
  }
  assert.deepEqual(openCalls[2], { sid: 'child-c-2', resumeId: undefined, forkSession: false }, 'already-staged second fork must convert directly to fresh session')
  const promptText2 = promptCalls.flat().map(b => b.text ?? '').join('\n')
  assert.match(promptText2, /Keep port 9090/, 'already-staged second fork must deliver its retained fallbackContext')

  // 2) openTaskPart probes fork on demand and preserves bounded parent ref in inheritedSegments for native CLI forks.
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-clifork-'))
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1,
    bots: { b1: { id: 'b1', name: 'CodexBot', sessionId: 'dm-codex', model: 'local-codex-cli/o3', createdAt: 1, segments: [], tasks: [] } },
    rooms: {}, exchanges: [], prefs: {},
  }))
  const parentSession = { id: 'dm-codex', seq: 15, requestHeader: () => ({ config: { provider: 'local-codex-cli', model: 'o3' } }) }
  ctx.set('agents', new Map([['dm-codex', { id: 'dm-codex', session: parentSession }]]))
  let probedRoute
  let forkedCliCalled = false
  const rt = {
    ctx, home, statePath: join(home, 'state.json'), config: {}, warn() {},
    workDirOf: () => undefined,
    desiredModel: async () => 'local-codex-cli/o3',
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyPermission: async () => {},
    createSession: async () => 'task-codex-1',
    isLocalAgentRoute: p => p === 'local-codex-cli',
    localAgentSupportsFork: () => false, // not yet probed at startup!
    ensureLocalAgentForkCapability: async (route) => { probedRoute = route; return true },
    forkLocalAgentSession: async () => { forkedCliCalled = true; return { cliSessionId: 'thr-fork-1' } },
  }
  installStore(rt)
  installContextRuntime(rt)
  installParts(rt)
  await rt.load()

  const opened = await rt.openTaskPart(rt.botOf('b1'), 'dm-codex', { id: 't1', title: 'Job', brief: 'Work', from: 'dm-codex', status: 'running', startedAt: 1, updatedAt: 1 }, { fork: true })
  assert.equal(probedRoute, 'local-codex-cli', 'must probe fork capability on demand when not yet cached')
  assert.equal(forkedCliCalled, true)
  assert.equal(opened.forked, true)
  assert.deepEqual(opened.task.inheritedSegments, [{ sessionId: 'dm-codex', throughSeq: 14 }], 'native CLI fork must preserve bounded parent DSH ref for read_own_chat recall')
})

test('B14: normal part switch includes omitted-image notice when previous part had images, and omits it on text-only parts', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-img-'))
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const eventsByPart = new Map([
    ['p-img', [
      { seq: 0, time: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'See screenshot' }, { type: 'image', mediaType: 'image/png', data: 'abc' }] } },
      { seq: 1, time: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Got it.' }] } } },
    ]],
    ['p-txt', [
      { seq: 0, time: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Plain text only' }] } },
      { seq: 1, time: 21, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Understood.' }] } } },
    ]],
    ['p-tool-img', [
      { seq: 0, time: 30, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Capture page' }] } },
      { seq: 1, time: 31, type: 'tool/result', data: { message: { toolCallId: 'tc-shot', ok: true, content: [{ type: 'image', mediaType: 'image/png', data: 'png' }] } } },
      { seq: 2, time: 32, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Captured.' }] } } },
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

  const readToolImg = {}
  const toolImgLines = []
  for await (const line of rt.partLines('p-tool-img', AbortSignal.timeout(5_000), { read: readToolImg })) toolImgLines.push(line)
  assert.equal(toolImgLines.length, 2)
  assert.equal(readToolImg.hasImages, true, 'partLines must flag hasImages when a tool/result contains an image block')

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
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

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
  ctx.set('agents', agents)
  ctx.set('tokenMeter', { measure: () => ({ total: currentWorkingTokens }) })
  const rt = {
    ctx, home, statePath: join(home, 'state.json'), config: {}, teamTools: [], roomProgress: new Map(), live: new Map(),
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
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

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

test('B14/D8 review regressions: reused call_id + SQL throughSeq + offset pagination, and Codex forkSession reuses live parent engine', async (t) => {
  // 1) Reused short call_id (`call_0`), SQL throughSeq pushdown, and offset pagination.
  const home = mkdtempSync(join(tmpdir(), 'dsb-pr4-offset-'))
  const ctx = makeMockCtx()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const longPayload = `HEAD_MARKER_${'A'.repeat(40)}_MIDDLE_MARKER_${'B'.repeat(40)}_TAIL_MARKER`
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1,
    bots: {
      b1: {
        id: 'b1', name: 'Coder', sessionId: 'p-live', createdAt: 1,
        segments: [{ sessionId: 'p-old', endedAt: 100 }],
        tasks: [{ id: 't1', sessionId: 't-fork', inheritedSegments: [{ sessionId: 'p-old', throughSeq: 3 }] }],
      },
    },
    rooms: {}, exchanges: [], prefs: {},
  }))
  const sessionEvents = new Map([
    ['p-old', [
      { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 11, type: 'tool/call', data: { callId: 'call_0', name: 'bash', arguments: '{}' } },
      { seq: 2, time: 12, type: 'tool/result', data: { message: { toolCallId: 'call_0', ok: true, content: [{ type: 'text', text: longPayload }] } } },
      { seq: 3, time: 13, type: 'turn/end', data: { turn: 1 } },
      { seq: 4, time: 20, type: 'turn/start', data: { turn: 2 } },
      { seq: 5, time: 21, type: 'tool/call', data: { callId: 'call_0', name: 'bash', arguments: '{}' } },
      { seq: 6, time: 22, type: 'tool/result', data: { message: { toolCallId: 'call_0', ok: true, content: [{ type: 'text', text: 'TURN_2_REUSED_CALL_0_OUTPUT' }] } } },
      { seq: 7, time: 23, type: 'turn/end', data: { turn: 2 } },
    ]],
    ['p-live', []],
    ['t-fork', []],
  ])
  ctx.sessionController = {
    async page({ address, throughSeq, beforeSeq }) {
      const all = sessionEvents.get(address.sessionId) ?? []
      const filtered = all.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
      return { records: filtered.map(event => ({ event })), hasMore: false, cursor: filtered.at(-1)?.seq }
    },
  }
  const rt = { ctx, home, statePath: join(home, 'state.json'), config: {}, warn() {} }
  installStore(rt)
  installContextRuntime(rt)
  installChatIndex(rt)
  installParts(rt)
  await rt.load()

  // Unbounded p-live sees the newer reused `call_0` at seq 6.
  const latestReuse = await rt.recallToolOutput('b1', 'call_0', { askingId: 'p-live' })
  assert.equal(latestReuse.found, true)
  assert.equal(latestReuse.seq, 6)
  assert.equal(latestReuse.text, 'TURN_2_REUSED_CALL_0_OUTPUT')

  // Forked task with throughSeq=3 sees seq 2 directly via SQL pushdown and can paginate with offset!
  const page1 = await rt.recallToolOutput('b1', 'call_0', { askingId: 't-fork', maxChars: 50, offset: 0 })
  assert.equal(page1.found, true)
  assert.equal(page1.seq, 2)
  assert.equal(page1.truncated, true)
  assert.match(page1.text, /HEAD_MARKER/)
  assert.match(page1.text, /around: "part 1 #2", offset: 50/)

  const page2 = await rt.recallToolOutput('b1', 'call_0', { askingId: 't-fork', around: 'part 1 #2', maxChars: 50, offset: 50 })
  assert.equal(page2.found, true)
  assert.match(page2.text, /MIDDLE_MARKER/)

  // Even on unbounded p-live where a newer `call_0` exists at seq 6 (or was just appended),
  // passing `around: "part 1 #2"` pins pagination to seq 2 and never jumps to seq 6!
  const pinnedOnLive = await rt.recallToolOutput('b1', 'call_0', { askingId: 'p-live', around: 'part 1 #2', maxChars: 50, offset: 50 })
  assert.equal(pinnedOnLive.found, true)
  assert.equal(pinnedOnLive.seq, 2)
  assert.match(pinnedOnLive.text, /MIDDLE_MARKER/)

  // Attempting to pin past a forked task's throughSeq is refused.
  const deniedPastBound = await rt.recallToolOutput('b1', 'call_0', { askingId: 't-fork', around: 'part 1 #6', maxChars: 50, offset: 0 })
  assert.equal(deniedPastBound.found, false)

  const page3 = await rt.recallToolOutput('b1', 'call_0', { askingId: 't-fork', around: 'part 1 #2', maxChars: 50, offset: 100 })
  assert.equal(page3.found, true)
  assert.equal(page3.truncated, false)
  assert.match(page3.text, /TAIL_MARKER/)

  // Group recall continuation hint includes both explicit `part N #seq` and `group`.
  rt.state.rooms.r1 = { id: 'r1', name: 'Backend', members: ['b1'], sessions: { b1: 'g-live' }, segments: {}, log: [], seq: 0, seen: {} }
  sessionEvents.set('g-live', [
    { seq: 0, time: 30, type: 'tool/call', data: { callId: 'g-call', name: 'bash', arguments: '{}' } },
    { seq: 1, time: 31, type: 'tool/result', data: { message: { toolCallId: 'g-call', ok: true, content: [{ type: 'text', text: longPayload }] } } },
  ])
  const grpPage1 = await rt.recallToolOutput('b1', 'g-call', { askingId: 'g-live', roomId: 'r1', maxChars: 50, offset: 0 })
  assert.equal(grpPage1.found, true)
  assert.match(grpPage1.text, /around: "part 1 #1", offset: 50, group: "r1"/)

  // 2) Codex forkSession reuses live parent engine instead of spawning a second shared engine.
  let spawnCount = 0
  let parentForkCalls = 0
  const parentEngine = {
    forkSupported: undefined,
    async fork(threadId) {
      parentForkCalls += 1
      return { cliSessionId: `forked-from-${threadId}` }
    },
    async close() {},
  }
  const records = new Map([
    ['parent-codex', { route: 'local-codex-cli', cliSessionId: 'thr-live-1', cwd: '/repo', model: 'o3' }],
  ])
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    findExecutable: () => '/bin/codex',
    spawnEngine: () => { spawnCount += 1; return { async fork() { return { cliSessionId: 'wrong-shared' } }, async close() {} } },
    record: sid => records.get(sid),
    saveRecord: (sid, rec) => records.set(sid, rec),
    presetFor: () => 'workspace-write',
    cwdFor: async () => '/repo',
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())
  adapter.live.set('parent-codex', {
    sessionId: 'parent-codex',
    route: 'local-codex-cli',
    cliSessionId: 'thr-live-1',
    cwd: '/repo',
    model: 'o3',
    engine: parentEngine,
    queue: [],
    pending: new Map(),
    waiters: [],
    events: [],
    pendingContext: [],
  })
  const forked = await adapter.forkSession('parent-codex', 'child-codex')
  assert.deepEqual(forked, { cliSessionId: 'forked-from-thr-live-1' })
  assert.equal(parentForkCalls, 1)
  assert.equal(spawnCount, 0, 'forkSession must reuse live parent CodexEngine without spawning an extra shared engine')
})
