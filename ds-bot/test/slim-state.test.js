import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { install as installLedger, bookFile, parseBook } from '../src/host/ledger.js'
import { segmentNoteFile } from '../src/host/store.js'
import { fakeContext } from './fake-ctx.js'

function patchFsp(method, replace) {
  const original = fsp[method]
  fsp[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fsp[method] = original
    syncBuiltinESMExports()
  }
}

const NOTE_SECTIONS = [
  'Goals', 'Constraints and preferences', 'Progress', 'Decisions',
  'Facts to keep', 'Open threads', 'Next step', 'Where to look',
]
const fullNote = (marker, repeat = 120) => NOTE_SECTIONS
  .map(name => `## ${name}\n- ${marker} ${name.toLowerCase()} ${'detail '.repeat(repeat).trim()}`)
  .join('\n\n')

async function settle(check, timeout = 3000, label = 'condition') {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  assert.ok(check(), `timed out waiting for ${label}`)
}

function makeAgent(id, { events = [], cwd = '/tmp/team', tokens = 1_000 } = {}) {
  const calls = []
  const inbox = { nextStep: [], nextTurn: [], remove: () => {}, prepend: () => {} }
  const session = {
    id,
    seq: events.length + 1,
    header: { cwd },
    eventAt: () => undefined,
    snapshotEvents: () => events.slice(),
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' }, tools: [] }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'Work item in progress' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Completed the work item.' }] },
    ],
    toolHistory: () => [],
  }
  return {
    id,
    status: 'idle',
    session,
    inbox,
    calls,
    tokens,
    whenIdle: async () => {},
    runMaintenance: async fn => fn(new AbortController().signal),
    steer: message => calls.push(['steer', message]),
    followup: message => calls.push(['followup', message]),
    inject: message => calls.push(['inject', message]),
    send: (message, target) => calls.push([target, message]),
    cancel: () => {},
  }
}

async function bootHost(t, { home, seed, llmStream, measureTokens, pageEvents = {}, runningSessions = [] } = {}) {
  const ownHome = home === undefined
  const dir = home ?? mkdtempSync(join(tmpdir(), 'ds-bot-slim-state-'))
  if (ownHome) t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  if (seed !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(seed))

  const runningSet = new Set(runningSessions)
  const agents = new Map()
  const archived = []
  let createdSeq = 0
  let routeHandler
  const getAgent = (id) => {
    let agent = agents.get(id)
    if (agent === undefined) {
      agent = makeAgent(id, { events: pageEvents[id] ?? [] })
      if (runningSet.has(id)) agent.status = 'running'
      agents.set(id, agent)
    }
    return agent
  }

  const ctx = fakeContext({
    services: {
      tokenMeter: {
        measure: session => ({ totalTokens: measureTokens?.(session.id) ?? getAgent(session.id).tokens }),
        estimateMessage: () => 200,
      },
    },
  })
  const warnings = []
  ctx.logger = { warn: (...args) => warnings.push(args), info() {} }
  ctx.connection.fetch.register = (route) => {
    if (route.path === '/api/bot') routeHandler = route.fetch
    return () => {}
  }
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.workspaceRegistry = {
    archivedSessionIds: [],
    get: id => ({ id, path: join(dir, 'workspace') }),
    resolveByPath: async () => ({ id: 'ws-1', path: join(dir, 'workspace') }),
    create: async path => ({ id: 'ws-1', path }),
    archiveSession: async (id, opts) => { archived.push({ id, opts }) },
    unarchiveSession: async () => {},
  }
  ctx.sessionController = {
    create: async () => {
      const sessionId = `fresh-${++createdSeq}`
      getAgent(sessionId)
      return { sessionId }
    },
    resolveAgent: async id => ({ agent: getAgent(id) }),
    selectModel: async () => {},
    page: async ({ address, beforeSeq, maxMessages = 60 }) => {
      const list = pageEvents[address.sessionId] ?? []
      const end = beforeSeq === undefined ? list.length : list.findIndex(ev => ev.seq >= beforeSeq)
      const upto = end === -1 ? list.length : end
      const start = Math.max(0, upto - maxMessages)
      return { records: list.slice(start, upto).map(event => ({ event })), hasMore: start > 0 }
    },
  }
  ctx.llm = {
    ...ctx.llm,
    listProviders: () => [{ id: 'deepseek', models: [{ id: 'v4' }] }],
    resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8_000 }),
    stream: options => llmStream(options),
  }

  const rt = createRuntime(ctx, { home: dir })
  await rt.load()

  const call = async (endpoint, payload = {}) => {
    const req = new Request('http://localhost/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    const res = await routeHandler(req)
    return res.json()
  }
  const tool = (name, args, sessionId) => {
    const def = rt.teamTools.find(item => item.name === name)
    assert.ok(def, `missing tool ${name}`)
    return def.execute(args, { agent: getAgent(sessionId) })
  }
  const stop = async () => {
    await rt.ledger.flush()
    await ctx.dispose()
  }
  t.after(stop)
  return { rt, ctx, home: dir, agents, getAgent, archived, warnings, call, tool, stop }
}

test('segmentNoteFile produces Windows/macOS/Linux-safe collision-free filenames', () => {
  // Plain lowercase ASCII stays readable.
  assert.equal(segmentNoteFile('dm-a-p1'), 'dm-a-p1.md')
  assert.equal(segmentNoteFile('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000.md')
  assert.equal(segmentNoteFile('seg_123'), 'seg_123.md')

  // Windows reserved device names (case-insensitive) must be hashed.
  for (const reserved of ['CON', 'con', 'PRN', 'aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9']) {
    const out = segmentNoteFile(reserved)
    assert.match(out, /^h\.[0-9a-f]{32}\.md$/, `reserved ${reserved} must be hashed`)
  }

  // Unsafe characters, traversal, trailing dots, spaces, and overly long ids are hashed.
  for (const unsafe of ['../escape', 'a/b', 'a\\b', 'a:b', 'a*b?', 'name.', 'has space', 'x'.repeat(200)]) {
    const out = segmentNoteFile(unsafe)
    assert.match(out, /^h\.[0-9a-f]{32}\.md$/, `unsafe ${unsafe} must be hashed`)
    assert.equal(/[\\/:*?"<>|\s]/.test(out), false)
  }

  // Case-insensitive filesystem collision freedom (e.g. macOS APFS / Windows NTFS).
  assert.notEqual(segmentNoteFile('SessA').toLowerCase(), segmentNoteFile('sessa').toLowerCase())
  assert.notEqual(segmentNoteFile('CON').toLowerCase(), segmentNoteFile('con').toLowerCase())

  // A sessionId shaped like the hash prefix itself cannot collide with hashed outputs.
  const fakeHashId = `h.${'a'.repeat(32)}`
  assert.match(segmentNoteFile(fakeHashId), /^h\.[0-9a-f]{32}\.md$/)
  assert.notEqual(segmentNoteFile(fakeHashId), `${fakeHashId}.md`)
})

test('legacy state.exchanges migrates transparently into pair ledgers without losing existing books, and new deliveries never grow state.json', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-exchanges-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  // Pre-seed pair-a-c.jsonl with a newer message AND an already-imported legacy id.
  mkdirSync(join(home, 'ledger'), { recursive: true })
  const pairACPath = join(home, 'ledger', bookFile('pair-a-c'))
  writeFileSync(pairACPath, [
    JSON.stringify({ id: 'ac-dup', from: 'a', to: 'c', role: 'request', text: 'already in book', time: 20, delivered: true }),
    JSON.stringify({ id: 'ac-new', from: 'c', to: 'a', role: 'reply', replyTo: 'ac-dup', text: 'newer ledger reply', time: 30 }),
    JSON.stringify({ event: 'delivered', id: 'ac-new', sessionId: 'a', time: 31 }),
  ].join('\n') + '\n')

  const longLegacy = `LEGACY_FULL_TEXT_${'Z'.repeat(3_500)}_TAIL`
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', sessionId: 'a', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
      b: { id: 'b', sessionId: 'b', name: 'Writer', role: 'Dev', instructions: '', createdAt: 2 },
      c: { id: 'c', sessionId: 'c', name: 'Reviewer', role: 'QA', instructions: '', createdAt: 3 },
    },
    rooms: {},
    exchanges: [
      { id: 'ab-req-1', from: 'a', to: 'b', role: 'request', text: longLegacy, time: 10 },
      { id: 'ab-rep-1', from: 'b', to: 'a', role: 'reply', replyTo: 'ab-req-1', text: 'legacy reply text', time: 11 },
      // Missing older entry for pair-a-c (book already exists on disk) + duplicate entry already in book.
      { id: 'ac-old', from: 'a', to: 'c', role: 'request', text: 'older missing from pair-a-c', time: 5 },
      { id: 'ac-dup', from: 'a', to: 'c', role: 'request', text: 'already in book', time: 20 },
      // Obsolete entry referencing a deleted Bot.
      { id: 'dead-1', from: 'deleted-bot', to: 'a', role: 'request', text: 'stale deleted bot msg', time: 2 },
    ],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(seed))

  const host = await bootHost(t, { home, seed })

  // 1) state.json on disk is slimmed: exchanges is empty and carries no message bodies.
  const savedRaw = readFileSync(join(home, 'state.json'), 'utf8')
  const saved = JSON.parse(savedRaw)
  assert.deepEqual(saved.exchanges, [])
  assert.equal(savedRaw.includes('LEGACY_FULL_TEXT_'), false)
  assert.ok(Buffer.byteLength(savedRaw) < beforeBytes * 0.5, 'migrated state.json must drop legacy exchanges bloat')

  // 2) pair-a-b.jsonl persisted full text cleanly.
  const abRecords = parseBook(readFileSync(join(home, 'ledger', bookFile('pair-a-b')), 'utf8'))
  assert.deepEqual(abRecords.map(r => r.id), ['ab-req-1', 'ab-rep-1'])
  assert.equal(abRecords[0].text, longLegacy)

  // 3) pair-a-c.jsonl prepended missing older entry without duplicating ac-dup or losing ac-new!
  const acRecords = parseBook(readFileSync(pairACPath, 'utf8'))
  assert.deepEqual(acRecords.filter(r => r.event === undefined).map(r => r.id), ['ac-old', 'ac-dup', 'ac-new'])

  // 4) channel('exchange'), channel('exchange-text') with and without a/b, and deliveredReplyOf all work!
  const listed = (await host.call('exchange', { a: 'a', b: 'b' })).value
  assert.deepEqual(listed.map(e => e.id), ['ab-req-1', 'ab-rep-1'])
  assert.equal(listed[0].length, longLegacy.length)
  assert.deepEqual((await host.call('exchange-text', { id: 'ab-req-1', a: 'a', b: 'b' })).value, { text: longLegacy, whole: true })
  assert.deepEqual((await host.call('exchange-text', { id: 'ab-req-1' })).value, { text: longLegacy, whole: true })
  assert.equal(host.rt.deliveredReplyOf('b', 'a', 'ab-req-1')?.id, 'ab-rep-1')
  assert.equal(host.rt.deliveredReplyOf('b', undefined, 'ab-req-1')?.id, 'ab-rep-1')
  assert.equal(host.rt.deliveredReplyOf('c', 'a', 'ac-dup')?.id, 'ac-new')

  // 5) New deliveries (both bot-to-bot AND non-bot cancelled notice) NEVER grow state.exchanges!
  const liveBody = `LIVE_LEDGER_BODY_${'L'.repeat(2_600)}_END`
  await host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: liveBody, exchangeId: 'ab-req-2' })
  await host.rt.deliver({ fromId: 'b', toId: 'a', role: 'reply', replyTo: 'ab-req-2', text: 'live reply 2', exchangeId: 'ab-rep-2' })
  await host.rt.deliver({ fromId: undefined, fromName: 'The user', toId: 'b', role: 'cancelled', text: 'user cancelled', wake: false })
  await host.rt.save()

  const afterSave = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(afterSave.exchanges, [], 'new deliveries must not append to state.exchanges')
  assert.deepEqual((await host.call('exchange-text', { id: 'ab-req-2' })).value, { text: liveBody, whole: true })
  assert.equal(host.rt.deliveredReplyOf('b', 'a', 'ab-req-2')?.id, 'ab-rep-2')
  await host.stop()

  // 6) Restart with cold caches: everything still resolves from pair ledgers!
  const restarted = await bootHost(t, { home })
  assert.deepEqual((await restarted.call('exchange-text', { id: 'ab-req-1' })).value, { text: longLegacy, whole: true })
  assert.deepEqual((await restarted.call('exchange-text', { id: 'ab-req-2' })).value, { text: liveBody, whole: true })
  assert.equal(restarted.rt.deliveredReplyOf('b', 'a', 'ab-rep-1'), undefined)
  assert.equal(restarted.rt.deliveredReplyOf('b', 'a', 'ab-req-2')?.id, 'ab-rep-2')
  assert.deepEqual((await restarted.call('exchange', { a: 'a', b: 'c' })).value.map(e => e.id), ['ac-old', 'ac-dup', 'ac-new'])
})

test('failed pair ledger write keeps legacy state.exchanges intact (fail-closed) and retries on next load', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-exchanges-fail-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  // Block `<home>/ledger` directory creation cross-platform by placing a regular file there.
  writeFileSync(join(home, 'ledger'), 'not a directory')

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', sessionId: 'a', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
      b: { id: 'b', sessionId: 'b', name: 'Writer', role: 'Dev', instructions: '', createdAt: 2 },
    },
    rooms: {},
    exchanges: [
      { id: 'x-keep', from: 'a', to: 'b', role: 'request', text: 'MUST_NOT_BE_DROPPED', time: 1 },
      { id: 'x-reply', from: 'b', to: 'a', role: 'reply', replyTo: 'x-keep', text: 'kept reply', time: 2 },
    ],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }

  const first = await bootHost(t, { home, seed, runningSessions: ['a-task-cur'] })
  await first.rt.save()

  const persistedWhileBlocked = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(persistedWhileBlocked.exchanges.map(e => e.id), ['x-keep', 'x-reply'], 'entries must stay in state.json when ledger write fails')
  assert.equal(first.rt.deliveredReplyOf('b', 'a', 'x-keep')?.id, 'x-reply')
  assert.deepEqual((await first.call('exchange-text', { id: 'x-keep' })).value, { text: 'MUST_NOT_BE_DROPPED', whole: true })
  await first.stop()

  // Remove the blocker file: next boot migrates cleanly and empties state.exchanges.
  rmSync(join(home, 'ledger'))
  const second = await bootHost(t, { home })
  const migrated = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(migrated.exchanges, [])
  assert.equal(existsSync(join(home, 'ledger', bookFile('pair-a-b'))), true)
  assert.equal(second.rt.deliveredReplyOf('b', 'a', 'x-keep')?.id, 'x-reply')
  assert.deepEqual((await second.call('exchange-text', { id: 'x-keep' })).value, { text: 'MUST_NOT_BE_DROPPED', whole: true })
})

test('legacy inline segment notes migrate to segment-notes/*.md across bot, task, and room segments, shrinking state.json by >90%', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-notes-migrate-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const botNote1 = fullNote('BOT_SEG_1', 200)
  const botNoteUnsafe = fullNote('WIN_RESERVED_CON', 150)
  const taskNote = fullNote('TASK_SEG_1', 150)
  const roomNote = fullNote('ROOM_SEG_1', 150)

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [
          { sessionId: 'a-seg-1', endedAt: 100, tokens: 50_000, note: botNote1 },
          { sessionId: 'CON', endedAt: 200, tokens: 60_000, note: botNoteUnsafe },
        ],
        tasks: [
          {
            id: 'k_1',
            title: 'Audit',
            brief: 'Run audit',
            from: 'a-cur',
            sessionId: 'a-task-cur',
            status: 'running',
            startedAt: 250,
            updatedAt: 250,
            inheritedSegments: [
              { sessionId: 'a-seg-1', endedAt: 100 },
              { sessionId: 'CON', endedAt: 200 },
            ],
            segments: [
              { sessionId: 'a-task-seg-1', endedAt: 260, note: taskNote },
            ],
          },
        ],
      },
      b: { id: 'b', sessionId: 'b', name: 'Writer', role: 'Dev', instructions: '', createdAt: 2 },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'Team',
        members: ['a', 'b'],
        admin: 'a',
        mode: 'admin',
        notice: '',
        createdAt: 3,
        sessions: { a: 'r1-a-cur', b: 'r1-b-cur' },
        segments: {
          a: [{ sessionId: 'r1-a-seg-1', endedAt: 300, note: roomNote }],
        },
      },
    },
    exchanges: Array.from({ length: 40 }, (_, i) => ({
      id: `legacy-ex-${i}`,
      from: i % 2 === 0 ? 'a' : 'b',
      to: i % 2 === 0 ? 'b' : 'a',
      role: i % 2 === 0 ? 'request' : 'reply',
      ...(i % 2 === 1 ? { replyTo: `legacy-ex-${i - 1}` } : {}),
      text: `Legacy exchange body ${i} ${'payload '.repeat(120)}`,
      time: 1000 + i,
    })),
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(seed))

  const first = await bootHost(t, { home, seed, runningSessions: ['a-task-cur'] })
  const savedRaw = readFileSync(join(home, 'state.json'), 'utf8')
  const afterBytes = Buffer.byteLength(savedRaw)
  const saved = JSON.parse(savedRaw)

  // Verify >90% shrink of state.json and zero inline notes left.
  assert.ok(afterBytes < beforeBytes * 0.1, `expected >90% shrink, got ${beforeBytes} -> ${afterBytes}`)
  assert.deepEqual(saved.exchanges, [])
  assert.equal('note' in saved.bots.a.segments[0], false)
  assert.equal(saved.bots.a.segments[0].hasNote, true)
  assert.equal('note' in saved.bots.a.segments[1], false)
  assert.equal(saved.bots.a.segments[1].hasNote, true)
  assert.equal('note' in saved.bots.a.tasks[0].segments[0], false)
  assert.equal(saved.bots.a.tasks[0].segments[0].hasNote, true)
  assert.equal('note' in saved.rooms.r1.segments.a[0], false)
  assert.equal(saved.rooms.r1.segments.a[0].hasNote, true)

  // Verify files on disk (including Windows-safe hashed filename for 'CON').
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-seg-1')), 'utf8'), botNote1)
  assert.match(segmentNoteFile('CON'), /^h\.[0-9a-f]{32}\.md$/)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('CON')), 'utf8'), botNoteUnsafe)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-task-seg-1')), 'utf8'), taskNote)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('r1-a-seg-1')), 'utf8'), roomNote)

  // Verify read_own_chat({ part: N }) works from foreground AND from background task (hydrated inheritedSegments).
  const fgPart1 = await first.tool('read_own_chat', { part: 1 }, 'a-cur')
  assert.match(fgPart1, /BOT_SEG_1/)
  const fgPart2 = await first.tool('read_own_chat', { part: 2 }, 'a-cur')
  assert.match(fgPart2, /WIN_RESERVED_CON/)
  const taskPart1 = await first.tool('read_own_chat', { part: 1 }, 'a-task-cur')
  assert.match(taskPart1, /BOT_SEG_1/)
  const taskPart3 = await first.tool('read_own_chat', { part: 3 }, 'a-task-cur')
  assert.match(taskPart3, /TASK_SEG_1/)

  // Inline fixture compatibility: segment with inline .note still works without disk file.
  assert.equal(first.rt.readSegmentNote({ sessionId: 'inline-only', note: 'Direct inline fixture' }), 'Direct inline fixture')
  assert.equal(first.rt.noteText({ sessionId: 'inline-only', note: 'Direct inline fixture' }), 'Direct inline fixture')
  await first.stop()

  // Restart with cold cache and verify round-trip reads from disk.
  const second = await bootHost(t, { home })
  assert.equal(second.rt.readSegmentNote(second.rt.botOf('a').segments[0]), botNote1)
  assert.equal(second.rt.readSegmentNote(second.rt.botOf('a').segments[1]), botNoteUnsafe)
  assert.equal(second.rt.readSegmentNote(second.rt.botOf('a').tasks[0].segments[0]), taskNote)
  assert.equal(second.rt.readSegmentNote(second.rt.roomOf('r1').segments.a[0]), roomNote)
  const coldPart1 = await second.tool('read_own_chat', { part: 1 }, 'a-cur')
  assert.match(coldPart1, /BOT_SEG_1/)
})

test('live part switch writes externalized segment-notes/*.md and carries earlierNote across overflow without bloating state.json', async (t) => {
  const writtenNote = fullNote('LIVE_SWITCH_PART_1', 60)
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', sessionId: 'a', name: 'Chief', role: 'Lead', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }

  let tokens = 90_000
  const host = await bootHost(t, {
    seed,
    measureTokens: () => tokens,
    llmStream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: writtenNote }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: writtenNote } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // 1) Trigger Part 1 -> Part 2 switch via idle context check past hard line.
  host.ctx.emit('agent/status', { agent: host.getAgent('a'), status: 'idle' })
  await settle(() => host.rt.chatOf('a') === 'fresh-1' && host.getAgent('fresh-1').calls.some(([, msg]) => msg.source?.handoff), 3000, 'part 1 -> part 2 switch')
  await host.rt.save()

  const savedAfter1 = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(savedAfter1.bots.a.segments.length, 1)
  assert.equal(savedAfter1.bots.a.segments[0].sessionId, 'a')
  assert.equal(savedAfter1.bots.a.segments[0].hasNote, true)
  assert.equal('note' in savedAfter1.bots.a.segments[0], false, 'state.json must not inline new handover note')
  assert.equal(readFileSync(join(host.home, 'segment-notes', segmentNoteFile('a')), 'utf8'), writtenNote)

  const part2Handoff = host.getAgent('fresh-1').calls.find(([, msg]) => msg.source?.handoff)?.[1]?.content?.[0]?.text ?? ''
  assert.match(part2Handoff, /LIVE_SWITCH_PART_1/)

  const part1Read = await host.tool('read_own_chat', { part: 1 }, 'fresh-1')
  assert.match(part1Read, /LIVE_SWITCH_PART_1/)

  // 2) Now trigger a real `agent/request-error` overflow on Part 2 (`fresh-1` -> `fresh-2`):
  //    exercises BOTH `canMakeRoom` AND `moveOn` carrying Part 1's externalized note!
  const fresh1 = host.getAgent('fresh-1')
  fresh1.session.deriveMessages = () => [
    { role: 'user', source: { kind: 'bot', handoff: true }, content: [{ type: 'text', text: part2Handoff }] },
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] },
  ]
  const reqErrListeners = host.ctx.listeners.get('agent/request-error') ?? []
  const runMiddleware = async (index = 0) => {
    const fn = reqErrListeners[index]
    if (fn === undefined) return undefined
    return fn({ agent: fresh1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' } }, () => runMiddleware(index + 1))
  }
  await runMiddleware()
  await settle(() => host.rt.chatOf('a') === 'fresh-2' && host.getAgent('fresh-2').calls.some(([, msg]) => msg.source?.handoff), 3000, 'part 2 -> part 3 overflow switch')
  await host.rt.save()

  const savedAfter2 = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(savedAfter2.bots.a.segments.length, 2)
  const seg2 = savedAfter2.bots.a.segments[1]
  assert.equal(seg2.sessionId, 'fresh-1')
  assert.equal(seg2.fallback, 'overflow')
  assert.equal(seg2.noteFrom, 1)
  assert.equal(seg2.hasNote, true)
  assert.equal('note' in seg2, false, 'carried-over overflow note must also be externalized')
  assert.equal(readFileSync(join(host.home, 'segment-notes', segmentNoteFile('fresh-1')), 'utf8'), writtenNote)

  const part3Handoff = host.getAgent('fresh-2').calls.find(([, msg]) => msg.source?.handoff)?.[1]?.content?.[0]?.text ?? ''
  assert.match(part3Handoff, /carried over unchanged/)
  assert.match(part3Handoff, /LIVE_SWITCH_PART_1/)

  const part2Read = await host.tool('read_own_chat', { part: 2 }, 'fresh-2')
  assert.match(part2Read, /written at the end of part 1/)
  assert.match(part2Read, /LIVE_SWITCH_PART_1/)
  tokens = 1_000
})

test('segment-notes write failure falls back fail-closed to inline segment.note during both migration and live part switch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-notes-fail-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  // Block `<home>/segment-notes` directory creation cross-platform by placing a regular file there.
  writeFileSync(join(home, 'segment-notes'), 'not a directory')

  const legacyNote = fullNote('LEGACY_FAIL_CLOSED', 20)
  const liveNote = fullNote('LIVE_FAIL_CLOSED', 20)
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        model: 'deepseek/v4',
        instructions: '',
        createdAt: 1,
        segments: [{ sessionId: 'a-old', endedAt: 100, note: legacyNote }],
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }

  const first = await bootHost(t, {
    home,
    seed,
    measureTokens: () => 90_000,
    llmStream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: liveNote }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: liveNote } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // 1) Migration failed closed: legacy inline note preserved on segment and still readable.
  assert.equal(first.rt.botOf('a').segments[0].note, legacyNote)
  assert.equal(first.rt.botOf('a').segments[0].hasNote, undefined)
  assert.match(await first.tool('read_own_chat', { part: 1 }, 'a-cur'), /LEGACY_FAIL_CLOSED/)

  // 2) Live moveOn also fails closed to inline segment.note rather than losing the handover note!
  first.ctx.emit('agent/status', { agent: first.getAgent('a-cur'), status: 'idle' })
  await settle(() => first.rt.chatOf('a') === 'fresh-1' && first.getAgent('fresh-1').calls.some(([, msg]) => msg.source?.handoff), 3000, 'fail-closed live part switch')
  await first.rt.save()

  const savedBlocked = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(savedBlocked.bots.a.segments[0].note, legacyNote)
  assert.equal(savedBlocked.bots.a.segments[1].note, liveNote)
  assert.equal(savedBlocked.bots.a.segments[1].hasNote, undefined)
  assert.match(await first.tool('read_own_chat', { part: 2 }, 'fresh-1'), /LIVE_FAIL_CLOSED/)
  await first.stop()

  // 3) Remove the blocker file: next boot migrates both inline notes cleanly to disk!
  rmSync(join(home, 'segment-notes'))
  const second = await bootHost(t, { home })
  const savedFixed = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal('note' in savedFixed.bots.a.segments[0], false)
  assert.equal(savedFixed.bots.a.segments[0].hasNote, true)
  assert.equal('note' in savedFixed.bots.a.segments[1], false)
  assert.equal(savedFixed.bots.a.segments[1].hasNote, true)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-old')), 'utf8'), legacyNote)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-cur')), 'utf8'), liveNote)
  assert.equal(second.rt.readSegmentNote(second.rt.botOf('a').segments[0]), legacyNote)
  assert.equal(second.rt.readSegmentNote(second.rt.botOf('a').segments[1]), liveNote)
})

test('deleteBot, deleteRoom, and member removal clean up all segment-notes/*.md files without leaking orphans', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-cleanup-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [{ sessionId: 'a-seg-keep', endedAt: 10, note: 'keep-a' }],
      },
      b: {
        id: 'b',
        sessionId: 'b-cur',
        name: 'Writer',
        role: 'Dev',
        instructions: '',
        createdAt: 2,
        segments: [{ sessionId: 'b-seg-1', endedAt: 20, note: 'drop-b-own' }],
        tasks: [{
          id: 'k_b1',
          title: 'Task',
          brief: 'Work',
          from: 'b-cur',
          sessionId: 'b-task-cur',
          status: 'completed',
          startedAt: 25,
          updatedAt: 26,
          endedAt: 26,
          segments: [{ sessionId: 'b-task-seg-1', endedAt: 25, note: 'drop-b-task' }],
        }],
      },
      c: {
        id: 'c',
        sessionId: 'c-cur',
        name: 'Reviewer',
        role: 'QA',
        instructions: '',
        createdAt: 3,
      },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'Alpha',
        named: true,
        members: ['a', 'b', 'c'],
        admin: 'a',
        mode: 'admin',
        notice: '',
        createdAt: 10,
        // Notice `c` has a retired group session (absent from sessions, still has segments).
        sessions: { a: 'r1-a-cur', b: 'r1-b-cur' },
        segments: {
          b: [{ sessionId: 'r1-b-seg-1', endedAt: 30, note: 'drop-r1-b' }],
          c: [{ sessionId: 'r1-c-seg-retired', endedAt: 31, note: 'drop-r1-c-retired' }],
        },
      },
      r2: {
        id: 'r2',
        name: 'Beta',
        named: true,
        members: ['a', 'c'],
        admin: 'a',
        mode: 'admin',
        notice: '',
        createdAt: 11,
        sessions: { a: 'r2-a-cur', c: 'r2-c-cur' },
        segments: {
          c: [{ sessionId: 'r2-c-seg-1', endedAt: 40, note: 'drop-r2-c' }],
        },
        parts: [{ sessionId: 'r2-part-1', endedAt: 41, note: 'drop-r2-part' }],
      },
    },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }

  const host = await bootHost(t, { home, seed })
  const notePath = sid => join(home, 'segment-notes', segmentNoteFile(sid))

  // All 6 migrated note files exist initially.
  for (const sid of ['a-seg-keep', 'b-seg-1', 'b-task-seg-1', 'r1-b-seg-1', 'r1-c-seg-retired', 'r2-c-seg-1', 'r2-part-1']) {
    assert.equal(existsSync(notePath(sid)), true, `expected ${sid} note file to exist after migration`)
  }

  // 1) Removing `c` from `r1` deletes its retired segment note even without an active room.sessions.c entry!
  await host.rt.updateRoom('r1', { remove: ['c'] })
  assert.equal(existsSync(notePath('r1-c-seg-retired')), false, 'removed member retired group segment note must be deleted')
  assert.equal(existsSync(notePath('r2-c-seg-1')), true, 'unrelated room note must remain')

  // 2) Deleting Bot `b` deletes its own-chat, task, and group segment notes!
  await host.rt.deleteBot('b')
  assert.equal(existsSync(notePath('b-seg-1')), false, 'deleted Bot own segment note must be deleted')
  assert.equal(existsSync(notePath('b-task-seg-1')), false, 'deleted Bot task segment note must be deleted')
  assert.equal(existsSync(notePath('r1-b-seg-1')), false, 'deleted Bot group segment note must be deleted')
  assert.equal(existsSync(notePath('a-seg-keep')), true, 'surviving Bot note must remain')

  // 3) Deleting Room `r2` deletes member group segment notes and room.parts notes!
  await host.rt.deleteRoom('r2')
  assert.equal(existsSync(notePath('r2-c-seg-1')), false, 'deleted room member segment note must be deleted')
  assert.equal(existsSync(notePath('r2-part-1')), false, 'deleted room part note must be deleted')
  assert.equal(existsSync(notePath('a-seg-keep')), true, 'surviving Bot note must still remain')
})

test('pruning old settled tasks deletes pruned task segment notes while preserving foreground bot segment notes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-prune-tasks-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const settledTasks = Array.from({ length: 50 }, (_, idx) => ({
    id: `k_old_${idx}`,
    title: `Old task ${idx}`,
    brief: 'Done',
    from: 'a-cur',
    sessionId: `a-old-task-${idx}`,
    status: 'completed',
    startedAt: 10 + idx,
    updatedAt: 20 + idx,
    endedAt: 20 + idx,
    inheritedSegments: [{ sessionId: 'a-fg-seg', endedAt: 5 }],
    segments: idx === 0 ? [{ sessionId: 'pruned-task-seg-0', endedAt: 15, note: 'PRUNED_TASK_NOTE' }] : [],
  }))
  settledTasks.push({
    id: 'k_active',
    title: 'Active task',
    brief: 'Running',
    from: 'a-cur',
    sessionId: 'a-active-task',
    status: 'running',
    startedAt: 500,
    updatedAt: 500,
    segments: [{ sessionId: 'kept-task-seg', endedAt: 505, note: 'KEPT_TASK_NOTE' }],
  })

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [{ sessionId: 'a-fg-seg', endedAt: 5, note: 'FG_SURVIVES' }],
        tasks: settledTasks,
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }

  const host = await bootHost(t, { home, seed, runningSessions: ['a-active-task'] })
  const notePath = sid => join(home, 'segment-notes', segmentNoteFile(sid))
  assert.equal(existsSync(notePath('pruned-task-seg-0')), true)
  assert.equal(existsSync(notePath('kept-task-seg')), true)
  assert.equal(existsSync(notePath('a-fg-seg')), true)

  // Stopping the 51st task triggers pruneSettledTasks, dropping `k_old_0` and its segment note.
  await host.rt.stopTask('a', 'k_active', 'done')
  await settle(() => !existsSync(notePath('pruned-task-seg-0')), 2000, 'pruned task segment note deletion')
  assert.equal(existsSync(notePath('pruned-task-seg-0')), false, 'pruned task segment note must be deleted')
  assert.equal(existsSync(notePath('kept-task-seg')), true, 'non-pruned task segment note must remain')
  assert.equal(existsSync(notePath('a-fg-seg')), true, 'foreground inherited segment note must remain')
})

test('read-only host reads unmigrated legacy state without writing, then migrates cleanly upon lock takeover', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-readonly-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [{ sessionId: 'a-seg-ro', endedAt: 10, note: 'RO_INLINE_NOTE' }],
      },
      b: { id: 'b', sessionId: 'b', name: 'Writer', role: 'Dev', instructions: '', createdAt: 2 },
    },
    rooms: {},
    exchanges: [
      { id: 'ro-1', from: 'a', to: 'b', role: 'request', text: 'RO_EXCHANGE_TEXT', time: 1 },
      { id: 'ro-2', from: 'b', to: 'a', role: 'reply', replyTo: 'ro-1', text: 'RO_REPLY_TEXT', time: 2 },
    ],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  const initialRaw = JSON.stringify(seed)
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-dsh', since: Date.now() }))

  const host = await bootHost(t, { home, seed })
  assert.match(host.rt.readOnly(), /another dsh/)
  // Read-only host must NOT mutate disk files.
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), initialRaw)
  assert.equal(existsSync(join(home, 'ledger', bookFile('pair-a-b'))), false)
  assert.equal(existsSync(join(home, 'segment-notes', segmentNoteFile('a-seg-ro'))), false)
  // Yet all reads still work seamlessly!
  assert.equal(host.rt.noteText(host.rt.botOf('a').segments[0]), 'RO_INLINE_NOTE')
  assert.equal(host.rt.deliveredReplyOf('b', 'a', 'ro-1')?.id, 'ro-2')
  assert.deepEqual((await host.call('exchange-text', { id: 'ro-1' })).value, { text: 'RO_EXCHANGE_TEXT', whole: true })

  // Other host closes and releases lock -> refresh() takes over and migrates!
  rmSync(join(home, 'state.lock'))
  await host.rt.refresh()
  assert.equal(host.rt.readOnly(), undefined)
  await settle(() => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).exchanges.length === 0, 2000, 'takeover migration save')

  const migrated = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(migrated.exchanges, [])
  assert.equal(migrated.bots.a.segments[0].hasNote, true)
  assert.equal('note' in migrated.bots.a.segments[0], false)
  assert.equal(existsSync(join(home, 'ledger', bookFile('pair-a-b'))), true)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-seg-ro')), 'utf8'), 'RO_INLINE_NOTE')
})

test('legacy duplicated bot.tasks[*].inheritedSegments[*].note entries migrate out of state.json without risking foreground notes on prune', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-inherited-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const fgNote = fullNote('SHARED_FG_NOTE', 120)
  const orphanInheritedNote = fullNote('ORPHAN_INHERITED_NOTE', 80)

  // Simulate a pre-slimSegments team where 20 settled tasks each cloned multi-KB inheritedSegments[*].note.
  const tasks = Array.from({ length: 20 }, (_, idx) => ({
    id: `k_leg_${idx}`,
    title: `Legacy task ${idx}`,
    brief: 'Done',
    from: 'a-cur',
    sessionId: `a-task-${idx}`,
    status: 'completed',
    startedAt: 100 + idx,
    updatedAt: 110 + idx,
    endedAt: 110 + idx,
    inheritedSegments: [
      { sessionId: 'a-fg-1', endedAt: 50, note: fgNote },
      ...(idx === 0 ? [{ sessionId: 'a-fg-cleared', endedAt: 40, note: orphanInheritedNote }] : []),
    ],
    segments: [],
  }))
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [{ sessionId: 'a-fg-1', endedAt: 50, note: fgNote }],
        tasks,
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(seed))

  const host = await bootHost(t, { home, seed })
  const savedRaw = readFileSync(join(home, 'state.json'), 'utf8')
  const saved = JSON.parse(savedRaw)

  assert.ok(Buffer.byteLength(savedRaw) < beforeBytes * 0.1, `expected >90% shrink, got ${beforeBytes} -> ${Buffer.byteLength(savedRaw)}`)
  assert.equal('note' in saved.bots.a.segments[0], false)
  assert.equal(saved.bots.a.segments[0].hasNote, true)
  for (const task of saved.bots.a.tasks) {
    for (const seg of task.inheritedSegments) {
      assert.equal('note' in seg, false, `task ${task.id} inheritedSegment ${seg.sessionId} must strip inline note`)
      assert.equal(seg.hasNote, true)
    }
  }
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-fg-1')), 'utf8'), fgNote)
  assert.equal(readFileSync(join(home, 'segment-notes', segmentNoteFile('a-fg-cleared')), 'utf8'), orphanInheritedNote)
  assert.equal(host.rt.readSegmentNote(host.rt.botOf('a').tasks[0].inheritedSegments[1]), orphanInheritedNote)
})

test('concurrent writeSegmentNote + deleteSegmentNotes cannot resurrect deleted note in cache or on disk', async (t) => {
  const host = await bootHost(t, {
    seed: {
      version: 1,
      mainBotIds: ['a'],
      bots: { a: { id: 'a', sessionId: 'a', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
      rooms: {},
      exchanges: [],
      exchangeTurns: {},
      questions: {},
      prefs: {},
      revision: 1,
    },
  })

  const notePath = join(host.home, 'segment-notes', segmentNoteFile('race-sid'))
  let entered
  let unblock
  const atWrite = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patchFsp('writeFile', original => async (path, ...args) => {
    if (String(path).startsWith(`${notePath}.`)) {
      entered()
      await gate
    }
    return original(path, ...args)
  })
  try {
    const writing = host.rt.writeSegmentNote('race-sid', 'STALE_WRITTEN_NOTE')
    await atWrite
    // Delete is invoked while writeSegmentNote is mid-flight.
    const deleting = host.rt.deleteSegmentNotes(['race-sid'])
    unblock()
    await Promise.all([writing, deleting])
  } finally {
    unblock()
    restore()
  }

  assert.equal(existsSync(notePath), false, 'deleted segment note file must not exist on disk')
  assert.equal(host.rt.readSegmentNote({ sessionId: 'race-sid', hasNote: true }), undefined, 'deleted segment note must not be resurrected in noteCache')
  assert.equal(host.rt.readSegmentNote('race-sid'), undefined)
})

test('dispose during migrateSegmentNotes stops remaining segment note writes before lock release', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-slim-dispose-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        name: 'Chief',
        role: 'Lead',
        instructions: '',
        createdAt: 1,
        segments: [
          { sessionId: 'seg-1', endedAt: 10, note: 'NOTE_ONE' },
          { sessionId: 'seg-2', endedAt: 20, note: 'NOTE_TWO' },
        ],
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  const seg1Path = join(home, 'segment-notes', segmentNoteFile('seg-1'))
  const seg2Path = join(home, 'segment-notes', segmentNoteFile('seg-2'))
  let entered
  let unblock
  const atSeg1 = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patchFsp('writeFile', original => async (path, ...args) => {
    if (String(path).startsWith(`${seg1Path}.`)) {
      entered()
      await gate
    }
    return original(path, ...args)
  })
  const ctx = fakeContext()
  ctx.logger = { warn() {}, info() {} }
  const rt = createRuntime(ctx, { home })
  try {
    const loading = rt.load()
    await atSeg1
    const disposing = ctx.dispose()
    unblock()
    await Promise.all([loading, disposing])
  } finally {
    unblock()
    restore()
  }

  assert.equal(existsSync(join(home, 'state.lock')), false, 'lock must be released after dispose')
  assert.equal(existsSync(seg2Path), false, 'seg-2 must not be written after dispose stopped migration')
})

test('ledger.mergeRecords prevents duplicate disk writes, duplicate delivered events on cold open, and book resurrection after drop', async (t) => {
  const makeLedger = (label) => {
    const home = mkdtempSync(join(tmpdir(), `ds-bot-merge-race-${label}-`))
    t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
    let readOnly
    const rt = { home, readOnly: () => readOnly, warn: () => {} }
    installLedger(rt)
    return { rt, home, file: book => join(home, 'ledger', bookFile(book)), setReadOnly: v => { readOnly = v } }
  }

  // 1) Queued append behind in-flight W0 + mergeRecords (W1) must NOT write R_new twice to disk.
  {
    const { rt, file } = makeLedger('dup-append')
    let entered
    let unblock
    const atAppend = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { unblock = resolve })
    let paused = false
    const restore = patchFsp('appendFile', original => async (path, ...args) => {
      if (path === file('pair-a-b') && !paused) {
        paused = true
        entered()
        await gate
      }
      return original(path, ...args)
    })
    try {
      rt.ledger.append('pair-a-b', { id: 'm0', text: 'first' })
      await atAppend
      const merging = rt.ledger.mergeRecords('pair-a-b', [{ id: 'legacy-0', text: 'older', delivered: true }])
      // Synchronously append while W0 is still blocked and W1 (mergeRecords) is queued behind W0.
      rt.ledger.append('pair-a-b', { id: 'm1', text: 'after-merge' })
      unblock()
      assert.equal(await merging, true)
      await rt.ledger.flush('pair-a-b')
    } finally {
      unblock()
      restore()
    }
    const diskIds = parseBook(readFileSync(file('pair-a-b'), 'utf8')).map(r => r.id)
    const memIds = rt.ledger.records('pair-a-b').map(r => r.id)
    assert.deepEqual(diskIds, ['legacy-0', 'm0', 'm1'], 'disk must contain each record exactly once in order')
    assert.deepEqual(memIds, ['legacy-0', 'm0', 'm1'], 'memory must match disk with zero duplicates')
  }

  // 2) Cold book mergeRecords + concurrent open()/append() must NOT duplicate existing `{ event: 'delivered' }` records.
  {
    const { rt, home, file } = makeLedger('cold-delivered')
    mkdirSync(join(home, 'ledger'), { recursive: true })
    writeFileSync(file('pair-a-b'), [
      JSON.stringify({ id: 'm1', from: 'a', to: 'b', role: 'reply', text: 'existing' }),
      JSON.stringify({ event: 'delivered', id: 'm1', sessionId: 'b', failureRequestId: 'fail-req-1', time: 10 }),
    ].join('\n') + '\n')

    let entered
    let unblock
    const atWrite = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { unblock = resolve })
    const restore = patchFsp('writeFile', original => async (path, ...args) => {
      if (String(path).startsWith(`${file('pair-a-b')}.`)) {
        entered()
        await gate
      }
      return original(path, ...args)
    })
    try {
      const merging = rt.ledger.mergeRecords('pair-a-b', [{ id: 'legacy-1', from: 'a', to: 'b', role: 'request', text: 'old', delivered: true }])
      await atWrite
      // Cold open + append while mergeRecords is writing temp file.
      rt.ledger.open('pair-a-b')
      rt.ledger.append('pair-a-b', { id: 'm2', from: 'b', to: 'a', role: 'request', text: 'concurrent' })
      unblock()
      assert.equal(await merging, true)
      await rt.ledger.flush('pair-a-b')
    } finally {
      unblock()
      restore()
    }
    const memRecords = rt.ledger.records('pair-a-b')
    const diskRecords = parseBook(readFileSync(file('pair-a-b'), 'utf8'))
    assert.equal(memRecords.filter(r => r.event === 'delivered' && r.failureRequestId === 'fail-req-1').length, 1, 'delivered event must not be duplicated in memory')
    assert.equal(diskRecords.filter(r => r.event === 'delivered' && r.failureRequestId === 'fail-req-1').length, 1, 'delivered event must not be duplicated on disk')
    assert.deepEqual(memRecords.filter(r => r.event === undefined).map(r => r.id), ['legacy-1', 'm1', 'm2'])
    assert.deepEqual(diskRecords.filter(r => r.event === undefined).map(r => r.id), ['legacy-1', 'm1', 'm2'])
  }

  // 3) Concurrent drop(book) during in-flight mergeRecords must abort without resurrecting the book.
  {
    const { rt, file } = makeLedger('drop-race')
    let entered
    let unblock
    const atWrite = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { unblock = resolve })
    const restore = patchFsp('writeFile', original => async (path, ...args) => {
      if (String(path).startsWith(`${file('pair-a-b')}.`)) {
        entered()
        await gate
      }
      return original(path, ...args)
    })
    try {
      const merging = rt.ledger.mergeRecords('pair-a-b', [{ id: 'x-drop', text: 'should drop', delivered: true }])
      await atWrite
      rt.ledger.drop('pair-a-b')
      unblock()
      assert.equal(await merging, false, 'mergeRecords must abort when book is dropped mid-flight')
      await rt.ledger.flush('pair-a-b')
    } finally {
      unblock()
      restore()
    }
    assert.equal(existsSync(file('pair-a-b')), false, 'dropped book file must not exist on disk')
    assert.equal(rt.ledger.hasBook('pair-a-b'), false, 'dropped book must not be resurrected in memory')
    assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  }
})

test('stale exchange-text probes do not scan or pin empty books for unused Bot pairs', async (t) => {
  const host = await bootHost(t, {
    seed: {
      version: 1,
      mainBotIds: ['a'],
      bots: {
        a: { id: 'a', sessionId: 'a', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
        b: { id: 'b', sessionId: 'b', name: 'Writer', role: 'Dev', instructions: '', createdAt: 2 },
        c: { id: 'c', sessionId: 'c', name: 'Reviewer', role: 'QA', instructions: '', createdAt: 3 },
        d: { id: 'd', sessionId: 'd', name: 'Ops', role: 'Ops', instructions: '', createdAt: 4 },
      },
      rooms: {},
      exchanges: [],
      exchangeTurns: {},
      questions: {},
      prefs: {},
      revision: 1,
    },
  })

  await host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'only pair a-b', exchangeId: 'ex-ab' })
  assert.equal(host.rt.ledger.hasBook('pair-a-b'), true)
  assert.equal(host.rt.ledger.hasBook('pair-c-d'), false)

  // Stale ID with explicit pair (a, b) must not open unused pairs.
  const missWithPair = await host.call('exchange-text', { id: 'missing-id', a: 'a', b: 'b' })
  assert.equal(missWithPair.ok, false)
  assert.equal(missWithPair.error.code, 'bot/stale')

  // Stale ID without pair must also skip pairs with no file on disk.
  const missNoPair = await host.call('exchange-text', { id: 'missing-id' })
  assert.equal(missNoPair.ok, false)
  assert.equal(missNoPair.error.code, 'bot/stale')

  for (const unused of ['pair-a-c', 'pair-a-d', 'pair-b-c', 'pair-b-d', 'pair-c-d']) {
    assert.equal(host.rt.ledger.hasBook(unused), false, `stale lookup must not open/pin unused ${unused}`)
  }
})
