// Real-runtime contract tests for memory scope isolation, durability & restore,
// causal delta watermarks, group review coordination, topic/entry invariants,
// learning durability, and operational hygiene.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { PENDING_FILE, record as pendingRecord } from '../src/host/memory-pending.js'
import { cleanEntry, isEmptyTopic, matchEntries, newEntryId, parseMemory } from '../src/host/memory-entries.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coder', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '',
      sessions: { b2: 'g2', b3: 'g3' },
      seq: 3,
      log: [
        { who: 'User', text: 'Ship Launch v2 on Friday', seq: 1 },
        { who: 'Writer', botId: 'b2', text: 'Noted.', seq: 2 },
        { who: 'Coder', botId: 'b3', text: 'Will prepare the build.', seq: 3 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const defaultChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember my deployment preference' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved.' }] } } } },
]

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-dur-')), replies = [], history = {}, config = {}, team = TEAM } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 128_000 }, defaultMaxTokens: 4_000 }),
      async* stream(request) {
        requests.push(request)
        const next = typeof replies === 'function' ? await replies(request) : await replies.shift()
        if (next instanceof Error) throw next
        const out = typeof next === 'object' && next !== null ? next : { text: next ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async (sessionId) => {
        const records = history[sessionId] ?? defaultChat
        const seq = (records.at(-1)?.event?.seq ?? 0) + 1
        return { agent: { id: sessionId, session: { id: sessionId, seq } } }
      },
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? defaultChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, memoryReview: true, memoryReviewDelayMs: 0, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const read = (...path) => readFileSync(join(home, 'memory', ...path), 'utf8')
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, rt, call, tool, section, read, requests, warnings, stop }
}

const textOf = message => (message?.content ?? []).map(block => block.text).join('')
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function reviewed(call) {
  for (let tries = 0; tries < 200; tries += 1) {
    await settle(15)
    if ((await call('state', {})).value.memoryReviews === 0) return
  }
  throw new Error('memory review did not settle')
}

async function runPreStep(ctx, sessionId, { messages = [], history = [] } = {}) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => history } }
  return step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages }))
}

// ---------------------------------------------------------------------------
// P0-3: Memory scope isolation & review routing invariants.

test('P0-3: group background task reviews into group memory (never Bot private memory) and own task uses task anchor', async (t) => {
  const replies = [
    JSON.stringify({ changes: [{ op: 'add', text: 'Group launch deadline is Friday' }] }),
    JSON.stringify({ changes: [{ op: 'add', text: 'Own task preference saved' }] }),
  ]
  const history = {
    'task-own-1': [
      { event: { seq: 40, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember this own-task rule' }] } } },
      { event: { seq: 41, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done.' }] } } } },
    ],
  }
  const { ctx, home, rt, call, tool, read, stop } = start({ replies, history })
  t.after(() => stop())
  await call('state', {})
  // Real store.js indexing via rt.save() puts active tasks into BOTH chatOwners and taskOwners.
  rt.botOf('b2').tasks = [
    { id: 'tg1', sessionId: 'task-group-1', roomId: 'r1', status: 'running', title: 'Group task' },
    { id: 'to1', sessionId: 'task-own-1', status: 'running', title: 'Own task' },
  ]
  await rt.save()
  assert.equal(rt.chatOwners.get('task-group-1'), 'b2')
  assert.equal(rt.taskOwners.get('task-group-1')?.roomId, 'r1')

  // Group background task must review into group:r1, NEVER into Bot's own memory.
  ctx.emit('agent/status', { agent: { id: 'task-group-1' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /Group launch deadline is Friday/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false, 'group task must NEVER write into Bot own memory')

  // Own-chat background task: simulate real host settleTask order where status='completed' +
  // rt.save() moves the session to pastOwners BEFORE agent/status: idle fires.
  ctx.emit('agent/status', { agent: { id: 'task-own-1' }, status: 'running' })
  rt.botOf('b2').tasks[1].status = 'completed'
  await rt.save()
  assert.equal(rt.taskOwners.get('task-own-1'), undefined, 'settled task moved out of taskOwners')
  assert.equal(rt.pastOwners.get('task-own-1')?.botId, 'b2', 'settled task indexed in pastOwners')
  ctx.emit('agent/status', { agent: { id: 'task-own-1' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Own task preference saved \[id: [0-9a-f]{4}; source: task to1 #40;/)

  // Explicit bot_remember from a settled/past task session also resolves the task anchor.
  await tool('bot_remember', { text: 'Explicit own-task note' }, 'task-own-1')
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Explicit own-task note \[id: [0-9a-f]{4}; source: task to1 #40;/)
})

test('P0-3: team empty-topic bypass blocked, change.group restricted to admin/Main Bot, conflicts & private-Bot writes refused', async (t) => {
  const team = structuredClone(TEAM)
  team.bots.b2.private = true
  team.rooms.r2 = { id: 'r2', name: 'Ops', named: true, members: ['b2', 'b3', 'm1'], admin: 'm1', mode: 'everyone', notice: '', sessions: { b3: 'g3b' }, seq: 0, log: [] }
  team.rooms.r3 = { id: 'r3', name: 'DupName', named: true, members: ['m1', 'b3'], admin: 'm1', mode: 'everyone', notice: '', sessions: {}, seq: 0, log: [] }
  team.rooms.r4 = { id: 'r4', name: 'DupName', named: true, members: ['m1', 'b3'], admin: 'm1', mode: 'everyone', notice: '', sessions: {}, seq: 0, log: [] }

  const replies = [
    // Main Bot review: empty/whitespace topic on team normalizes to shared.md; conflicting targets and duplicate group names refused.
    JSON.stringify({
      changes: [
        { op: 'add', text: 'Shared release rule empty topic', team: true, topic: '' },
        { op: 'add', text: 'Shared release rule blank topic', team: true, topic: '   ' },
        { op: 'add', text: 'Conflicting team and for', team: true, for: 'Coder' },
        { op: 'add', text: 'Conflicting team and group', team: true, group: 'Ops' },
        { op: 'add', text: 'Ambiguous group write', group: 'DupName' },
        { op: 'add', text: 'Allowed Main Bot group write', group: 'Ops' },
      ],
    }),
    // Coder is admin of Launch (r1) so writesTeam(b3) is true, but NOT admin of Ops (r2) -> group: 'Ops' must be refused!
    JSON.stringify({
      changes: [
        { op: 'add', text: 'Unauthorized non-admin group write', group: 'Ops' },
        { op: 'add', text: 'Authorized admin group write', group: 'Launch' },
      ],
    }),
  ]
  const { ctx, home, tool, call, read, warnings, stop } = start({ replies, team })
  t.after(() => stop())
  await call('state', {})

  ctx.emit('agent/status', { agent: { id: 'm1' }, status: 'idle' })
  await reviewed(call)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Shared release rule/, 'auto-review must NEVER write into resident team/MEMORY.md')
  assert.match(read('team', 'shared.md'), /Shared release rule empty topic/)
  assert.match(read('team', 'shared.md'), /Shared release rule blank topic/)
  assert.match(read('groups', 'r2', 'MEMORY.md'), /Allowed Main Bot group write/)
  assert.equal(existsSync(join(home, 'memory', 'groups', 'r3', 'MEMORY.md')), false)
  assert.equal(existsSync(join(home, 'memory', 'groups', 'r4', 'MEMORY.md')), false)
  assert.ok(warnings.some(line => line.includes('more than one destination')))
  assert.ok(warnings.some(line => line.includes('more than one group is named "DupName"')))

  ctx.emit('agent/status', { agent: { id: 'b3' }, status: 'idle' })
  await reviewed(call)
  assert.doesNotMatch(read('groups', 'r2', 'MEMORY.md'), /Unauthorized non-admin group write/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /Authorized admin group write/)
  assert.ok(warnings.some(line => line.includes('cannot route notes to a group named "Ops"')))

  // Defense-in-depth: writeDenied blocks Main Bot writing directly to private Bot b2 even outside privacy.js hook.
  await assert.rejects(
    tool('bot_remember', { text: 'Should be blocked by writeDenied', scope: 'Writer' }, 'm1'),
    /That Bot is private/,
  )
})

// ---------------------------------------------------------------------------
// P0-4 + G-10: memoryRestore fixes, causal delta watermark, read-only promotion,
// pending guard on groupSnapshot, and G-10 groupSnapshot/memoryUpdate dedup.

test('P0-4: memoryRestore into empty MEMORY.md uses # Memory (not # undefined) and into earlier.md survives overflow', async (t) => {
  const { home, tool, call, read, stop } = start({ config: { memoryReview: false } })
  t.after(() => stop())

  // 1. Add and remove an entry, then wipe MEMORY.md to empty and restore -> must write `# Memory`, never `# undefined`.
  await tool('bot_remember', { text: 'Restore into empty main test' }, 'b2')
  await tool('bot_forget', { entry: 'Restore into empty main test' }, 'b2')
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), '')
  const hist1 = (await call('memory-history', { botId: 'b2' })).value.rows
  const removeRow1 = hist1.find(row => row.op === 'remove' && row.text === 'Restore into empty main test')
  assert.ok(removeRow1)
  const res1 = await call('memory-restore', { botId: 'b2', id: removeRow1.id })
  assert.equal(res1.ok, true, JSON.stringify(res1))
  const restoredMain = read('bots', 'b2', 'MEMORY.md')
  assert.match(restoredMain, /^# Memory\n/)
  assert.doesNotMatch(restoredMain, /# undefined/)
  assert.match(restoredMain, /Restore into empty main test/)

  // 2. Restore a removed `earlier.md` entry while MEMORY.md is at its limit so makeRoom also overflows into `earlier.md`.
  await call('set-prefs', { memoryLimits: { bot: 2_000 } })
  const dirB3 = join(home, 'memory', 'bots', 'b3')
  mkdirSync(dirB3, { recursive: true })
  const residentLines = Array.from({ length: 10 }, (_, i) => `- Resident entry ${i + 1} ${'z'.repeat(175)} [id: c${String(i).padStart(3, '0')}; added: 2026-01-${String(i + 1).padStart(2, '0')}]`)
  writeFileSync(join(dirB3, 'MEMORY.md'), `# Memory\n\n${residentLines.join('\n')}\n\n## Index\n- [[earlier]]\n`)
  writeFileSync(join(dirB3, 'earlier.md'), '# earlier\n\n- Archived alpha fact to restore [id: e001; added: 2025-12-01]\n')
  // Remove alpha from earlier.md (which deletes earlier.md + [[earlier]] link).
  await tool('bot_forget', { entry: 'Archived alpha fact to restore', topic: 'earlier' }, 'b3')
  assert.equal(existsSync(join(dirB3, 'earlier.md')), false)
  // Fill MEMORY.md past 2,000 chars (via direct edit + add) so restoring earlier.md triggers adding [[earlier]] link AND makeRoom overflowing into earlier.md!
  const beforeRestore = read('bots', 'b3', 'MEMORY.md')
  assert.doesNotMatch(beforeRestore, /\[\[earlier\]\]/)
  await tool('bot_remember', { text: `Pushing to exact limit ${'q'.repeat(70)}` }, 'b3')
  // Now MEMORY.md is right near 2,000 chars; lower limit or ensure adding [[earlier]] triggers overflow into earlier.md.
  const hist2 = (await call('memory-history', { botId: 'b3' })).value.rows
  const removeRow2 = hist2.find(row => row.op === 'remove' && row.text.includes('Archived alpha fact to restore'))
  assert.ok(removeRow2)
  // Pre-seed MEMORY.md slightly below limit with a link-add growth that pushes bodySize past limit if needed;
  // here we also add an entry directly via file slightly below 2,000 then test restore into earlier.md!
  const b3Cur = read('bots', 'b3', 'MEMORY.md')
  const padEntry = `- Extra resident line ${'p'.repeat(240)} [id: f111; added: 2026-02-01]`
  writeFileSync(join(dirB3, 'MEMORY.md'), b3Cur.replace('\n\n## Index', `\n${padEntry}\n\n## Index`))
  const res2 = await call('memory-restore', { botId: 'b3', id: removeRow2.id })
  assert.equal(res2.ok, true, JSON.stringify(res2))
  assert.match(read('bots', 'b3', 'earlier.md'), /Archived alpha fact to restore/, 'restored entry in earlier.md must survive makeRoom')

  // 3. Restoring a removed resident MEMORY.md entry while MEMORY.md is full triggers real makeRoom
  //    overflow into earlier.md while keeping both the restored entry and the overflowed older entry.
  const removedMain = await tool('bot_forget', { entry: 'Extra resident line' }, 'b3')
  assert.match(removedMain, /Removed/)
  await tool('bot_remember', { text: `Refill resident cap ${'r'.repeat(240)}` }, 'b3')
  const hist3 = (await call('memory-history', { botId: 'b3' })).value.rows
  const removeRow3 = hist3.find(row => row.op === 'remove' && row.text.includes('Extra resident line'))
  assert.ok(removeRow3)
  const res3 = await call('memory-restore', { botId: 'b3', id: removeRow3.id })
  assert.equal(res3.ok, true, JSON.stringify(res3))
  assert.match(read('bots', 'b3', 'MEMORY.md'), /Extra resident line/, 'restored resident entry lands in MEMORY.md')
  assert.match(read('bots', 'b3', 'earlier.md'), /Resident entry 1/, 'oldest resident entry overflows cleanly into earlier.md')
  assert.match(read('bots', 'b3', 'earlier.md'), /Archived alpha fact to restore/, 'prior earlier.md entry remains intact')
})

test('P0-4 + G-10: causal memoryUpdate delivers same-ms & externally appended rows, guards pending groupSnapshot, and deduplicates compacted group refresh', async (t) => {
  const { ctx, home, tool, read, stop } = start({ config: { memoryReview: false } })
  let stoppedFirst = false
  t.after(() => (stoppedFirst ? undefined : stop()))

  // Prime b2 part-opening snapshot and verify two externally appended rows with the EXACT SAME millisecond timestamp both deliver.
  const seedStep = await runPreStep(ctx, 'b2')
  const ownSnap = seedStep.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  assert.ok(ownSnap, 'part-opening own memory snapshot must be emitted')
  const seenIso = read('snapshots', 'b2.seen').trim()
  assert.ok(Number.isFinite(Date.parse(seenIso)), '.seen must stay a parseable ISO timestamp')
  const sameMs = new Date(Date.parse(seenIso) + 50).toISOString()
  const journalPath = join(home, 'memory', 'journal.jsonl')
  writeFileSync(journalPath, `${[
    JSON.stringify({ id: 'same-ms-1', time: sameMs, scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- First same-ms team fact' }),
  ].join('\n')}\n`)
  const firstStep = await runPreStep(ctx, 'b2', { history: [ownSnap] })
  const upd1 = firstStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(upd1), /First same-ms team fact/)

  // Append a second row with the IDENTICAL timestamp to journal.jsonl (simulating external writer or sub-ms burst).
  writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${JSON.stringify({ id: 'same-ms-2', time: sameMs, scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Second same-ms team fact' })}\n`)
  const secondStep = await runPreStep(ctx, 'b2', { history: [ownSnap, upd1] })
  const upd2 = secondStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(upd2), /Second same-ms team fact/, 'same-millisecond row appended after previous update must still deliver')

  // G-10: groupSnapshot guards pending.json AND suppresses duplicate group: update on fresh compacted snapshot while keeping team: update!
  await tool('bot_remember', { text: 'Group rule alpha', scope: 'group' }, 'g2')
  await tool('bot_remember', { text: 'Team rule beta', scope: 'team', always: true }, 'm1')
  const g3Seed = await runPreStep(ctx, 'g3')
  const g3Own = g3Seed.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  assert.ok(g3Own)
  // Create a pending.json record -> groupSnapshot must return undefined while pending exists.
  writeFileSync(join(home, 'memory', PENDING_FILE), JSON.stringify(pendingRecord({
    id: 'pending-group-test',
    time: new Date().toISOString(),
    op: 'add',
    scope: 'group:r1',
    steps: [{ action: 'write', path: 'groups/r1/MEMORY.md', text: '# Memory\n\n- Group rule alpha\n\n## Index\n' }],
    row: { id: 'pending-group-row', time: new Date().toISOString(), op: 'add', scope: 'group:r1', file: 'MEMORY.md', actor: 'b2', actorName: 'Writer', after: '- Group rule alpha' },
  })))
  const duringPending = await runPreStep(ctx, 'g3', { history: [g3Own] })
  assert.equal(duringPending.messages.find(m => m.source?.kind === 'ds-bot-group-memory'), undefined, 'groupSnapshot must not freeze while pending.json exists')
  rmSync(join(home, 'memory', PENDING_FILE), { force: true })

  // Now simulate post-compaction step (ownSnap kept, groupSnap compacted away -> groupSnapshot injects fresh group memory):
  // group: update for "Group rule alpha" MUST be suppressed, while unseen team: update MUST still appear!
  await tool('bot_remember', { text: 'Fresh team rule gamma', scope: 'team', always: true }, 'm1')
  await tool('bot_remember', { text: 'Fresh group rule delta', scope: 'group' }, 'g2')
  const postCompact = await runPreStep(ctx, 'g3', { history: [g3Own] })
  const groupSnap = postCompact.messages.find(m => m.source?.kind === 'ds-bot-group-memory')
  const postUpd = postCompact.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.ok(groupSnap, 'fresh groupSnapshot must be injected after compaction')
  assert.match(textOf(groupSnap), /Fresh group rule delta/)
  assert.ok(postUpd, 'unseen team update must still be delivered alongside fresh groupSnapshot')
  assert.match(textOf(postUpd), /Fresh team rule gamma/)
  assert.doesNotMatch(textOf(postUpd), /Fresh group rule delta/, 'group change already inside fresh groupSnapshot must NOT duplicate in memoryUpdate')

  // Subsequent group change AFTER the fresh groupSnapshot IS delivered cleanly.
  await tool('bot_remember', { text: 'Later group rule epsilon', scope: 'group' }, 'g2')
  const nextStep = await runPreStep(ctx, 'g3', { history: [g3Own, groupSnap] })
  const nextUpd = nextStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(nextUpd), /Later group rule epsilon/)
  assert.ok(nextUpd.source?.groupWatermark?.time, 'group update carries persisted groupWatermark')

  // Across a host restart (cold in-memory groupSeen), epsilon must NOT be re-delivered.
  stoppedFirst = true
  await stop({ keep: true })
  const restarted = start({ home, config: { memoryReview: false } })
  t.after(() => restarted.stop())
  await restarted.call('state', {})
  const afterRestart = await runPreStep(restarted.ctx, 'g3', { history: [g3Own, groupSnap, nextUpd] })
  assert.equal(afterRestart.messages.find(m => m.source?.kind === 'ds-bot-memory-update'), undefined, 'already-delivered group update must not replay after restart')
})

test('P0-4: read-only host promotion observes external journal writes and survives RECENT_ROWS_MAX eviction', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-dur-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const { ctx, rt, call, stop } = start({ home, config: { memoryReview: false } })
  t.after(() => stop())
  await call('state', {})
  assert.notEqual(rt.readOnly(), undefined)

  // Initial step while read-only reads the empty journal tail.
  const journalPath = join(home, 'memory', 'journal.jsonl')
  mkdirSync(join(home, 'memory'), { recursive: true })
  const t0 = new Date(Date.now() - 10_000).toISOString()
  writeFileSync(journalPath, `${JSON.stringify({ id: 'seed-0', time: t0, scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Initial team note' })}\n`)
  const roStep = await runPreStep(ctx, 'b2')
  const roOwn = roStep.messages.find(m => m.source?.kind === 'ds-bot-own-memory')

  // Simulate another host writing an important team update PLUS 2,050 unrelated rows (> RECENT_ROWS_MAX = 2000).
  const baseMs = Date.now()
  const external = [
    JSON.stringify({ id: 'important-1', time: new Date(baseMs + 10).toISOString(), scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- External host critical team rule' }),
    ...Array.from({ length: 2_050 }, (_, i) => JSON.stringify({
      id: `noise-${i}`,
      time: new Date(baseMs + 100 + i).toISOString(),
      scope: 'bot:b3',
      op: 'add',
      file: 'MEMORY.md',
      actor: 'b3',
      actorName: 'Coder',
      after: `- Noise row ${i}`,
    })),
  ]
  writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${external.join('\n')}\n`)

  // Other host closes and this host promotes to writer via rt.refresh().
  rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)

  // memoryUpdate must detect the changed journal stat AND fall back to disk scan past RECENT_ROWS_MAX eviction!
  const step = await runPreStep(ctx, 'b2', { history: [roOwn] })
  const upd = step.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(upd), /External host critical team rule/)
})

test('P0-4: readTail recovers >512KB (<2000 rows) truncation, split partial appends, and atomic inode replacement', async (t) => {
  // 1. >512 KB journal with ONLY 700 rows (< RECENT_ROWS_MAX = 2,000): unseen row before 512 KB tail must still deliver.
  const bigHome = mkdtempSync(join(tmpdir(), 'ds-bot-mem-big-'))
  writeFileSync(join(bigHome, 'state.json'), JSON.stringify(TEAM))
  const rBig = start({ home: bigHome, config: { memoryReview: false } })
  let stoppedBig = false
  t.after(() => (stoppedBig ? undefined : rBig.stop()))
  await rBig.call('state', {})
  const bigSeed = await runPreStep(rBig.ctx, 'b2')
  const bigOwn = bigSeed.messages.find(m => m.source?.kind === 'ds-bot-own-memory')
  const bigJournal = join(bigHome, 'memory', 'journal.jsonl')
  mkdirSync(join(bigHome, 'memory'), { recursive: true })
  const tBase = Date.now() + 1_000
  const bigRows = [
    JSON.stringify({ id: 'big-target', time: new Date(tBase).toISOString(), scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Crucial pre-tail team fact' }),
    ...Array.from({ length: 700 }, (_, i) => JSON.stringify({
      id: `big-pad-${i}`,
      time: new Date(tBase + 10 + i).toISOString(),
      scope: 'bot:b3',
      op: 'add',
      file: 'MEMORY.md',
      actor: 'b3',
      actorName: 'Coder',
      after: `- Large payload ${i} ${'x'.repeat(780)}`,
    })),
  ]
  writeFileSync(bigJournal, `${bigRows.join('\n')}\n`)
  // Restart so readTail starts cold on the >512 KB (<2,000 rows) journal.
  stoppedBig = true
  await rBig.stop({ keep: true })
  const rBig2 = start({ home: bigHome, config: { memoryReview: false } })
  t.after(() => rBig2.stop())
  await rBig2.call('state', {})
  const bigStep = await runPreStep(rBig2.ctx, 'b2', { history: [bigOwn] })
  const bigUpd = bigStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(bigUpd), /Crucial pre-tail team fact/, 'unseen row before 512 KB tail must trigger full scan even with <2000 rows')

  // 2. Split / half-written append: reading mid-line must NOT advance offset past the partial line.
  const splitLine = `${JSON.stringify({ id: 'split-1', time: new Date(tBase + 5_000).toISOString(), scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Split append completed rule' })}\n`
  const cut = Math.floor(splitLine.length / 2)
  appendFileSync(bigJournal, splitLine.slice(0, cut))
  const midStep = await runPreStep(rBig2.ctx, 'b2', { history: [bigOwn] })
  assert.equal(midStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update'), undefined, 'partial append must not emit broken update')
  appendFileSync(bigJournal, splitLine.slice(cut))
  const doneStep = await runPreStep(rBig2.ctx, 'b2', { history: [bigOwn] })
  const doneUpd = doneStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(doneUpd), /Split append completed rule/, 'completed split line must deliver on the very next step')

  // 3. Atomic file replacement (new inode) resets offset and delivers new rows cleanly.
  const replacedTmp = `${bigJournal}.swap`
  const swapRow = JSON.stringify({ id: 'swap-1', time: new Date(tBase + 10_000).toISOString(), scope: 'team', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Atomic inode swap rule' })
  writeFileSync(replacedTmp, `${readFileSync(bigJournal, 'utf8')}${swapRow}\n`)
  renameSync(replacedTmp, bigJournal)
  const swapStep = await runPreStep(rBig2.ctx, 'b2', { history: [bigOwn] })
  const swapUpd = swapStep.messages.find(m => m.source?.kind === 'ds-bot-memory-update')
  assert.match(textOf(swapUpd), /Atomic inode swap rule/, 'atomic journal replacement must be observed via inode check')
})

// ---------------------------------------------------------------------------
// P1-4: Zombie topics, replaceEntry duplicates & until preservation,
// cleanEntry bracket preservation, matchEntries disambiguation, newEntryId, memoryMove.

test('P1-4: isEmptyTopic cleans zombie > about topics; replaceEntry rejects duplicates and preserves until; cleanEntry/matchEntries/newEntryId/memoryMove invariants hold', async (t) => {
  // Unit invariants on memory-entries.js.
  assert.equal(cleanEntry('  - * Likes short replies [source: forged; id: a1b2] '), 'Likes short replies')
  assert.equal(cleanEntry('Redis cluster config [timeout: 30]'), 'Redis cluster config [timeout: 30]')
  assert.equal(cleanEntry('Logger format [level: INFO]'), 'Logger format [level: INFO]')
  assert.equal(isEmptyTopic(['# travel', '> Notes about trips', '']), true)
  assert.equal(isEmptyTopic(['# travel', '> Notes about trips', '- Flies ANA']), false)

  // matchEntries: exact text before bare 4-hex ID, whole-word ID conflict disambiguation, and collision list.
  const sample = [
    { text: 'Unrelated fact one', meta: { id: 'cafe' } },
    { text: 'Likes the local cafe', meta: { id: '1234' } },
    { text: 'Legacy note number 307', meta: {} },
    { text: 'Legacy note number 432', meta: {} },
    { text: 'Added feedback on Friday', meta: { id: 'b001' } },
    { text: 'Exact id without word conflict', meta: { id: 'adde' } },
  ]
  assert.equal(matchEntries(sample, 'cafe').length, 2, 'bare 4-hex English word colliding with text must return both for disambiguation')
  assert.equal(matchEntries([...sample, { text: 'cafe', meta: { id: '9999' } }], 'cafe').length, 1, 'exact text match must beat bare 4-hex id')
  assert.equal(matchEntries(sample, '1528').length, 2, 'duplicate derived 4-hex IDs must return all collisions')
  assert.deepEqual(matchEntries(sample, 'adde').map(e => e.text), ['Exact id without word conflict'], 'substring inside "added" must not falsely conflict with id "adde"')

  // newEntryId falls back to 6 hex chars when 4-hex space reaches saturation threshold.
  const saturated = Array.from({ length: 32_768 }, (_, i) => ({ text: `e${i}`, meta: { id: i.toString(16).padStart(4, '0') } }))
  assert.match(newEntryId(saturated), /^[0-9a-f]{6}$/)

  // End-to-end runtime invariants.
  const { home, tool, call, read, stop } = start({ config: { memoryReview: false } })
  t.after(() => stop())

  // Zombie topic with `> about` note is deleted completely when last entry is removed.
  await tool('bot_remember', { text: 'Kyoto trip in May', topic: 'travel' }, 'b2')
  const travelPath = join(home, 'memory', 'bots', 'b2', 'travel.md')
  writeFileSync(travelPath, `# travel\n> Flights and hotel notes\n\n${read('bots', 'b2', 'travel.md').split('\n').find(l => l.includes('Kyoto'))}\n`)
  await tool('bot_forget', { entry: 'Kyoto trip in May', topic: 'travel' }, 'b2')
  assert.equal(existsSync(travelPath), false, 'topic holding only heading + > about must be removed')
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /\[\[travel\]\]/)

  // replaceEntry preserves `until`, allows overriding/clearing `until`, and rejects duplicates.
  await tool('bot_remember', { text: 'Temporary promo code', until: '2099-05-01' }, 'b2')
  await tool('bot_remember', { text: 'Permanent billing rule' }, 'b2')
  await tool('bot_remember', { text: 'Temporary promo code updated', replace: 'Temporary promo code' }, 'b2')
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Temporary promo code updated \[[^\]]*until: 2099-05-01/)
  await tool('bot_remember', { text: 'Permanent promo rule now', replace: 'Temporary promo code updated', until: '' }, 'b2')
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /until: 2099-05-01/)
  await assert.rejects(
    tool('bot_remember', { text: 'Permanent billing rule', replace: 'Permanent promo rule now' }, 'b2'),
    error => error.code === 'memory/refused' && /Already in/.test(error.message),
  )

  // memoryMove normalizes empty topic `""` and mints a fresh ID on 4-hex collision at destination.
  mkdirSync(join(home, 'memory', 'bots', 'b3'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b3', 'MEMORY.md'), '# Memory\n\n- Existing Coder entry [id: abcd; added: 2026-10-01]\n\n## Index\n')
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), '# Memory\n\n- Moving Writer entry [id: abcd; added: 2026-10-01]\n\n## Index\n')
  const moved = await call('memory-move', { botId: 'b2', scope: 'own', topic: '', text: 'Moving Writer entry', to: 'bot:b3' })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  const b3Main = parseMemory(read('bots', 'b3', 'MEMORY.md')).entries
  assert.equal(b3Main.length, 2)
  assert.notEqual(b3Main[0].meta.id, b3Main[1].meta.id, 'destination ID collision must mint a fresh ID instead of failing move')
})

// ---------------------------------------------------------------------------
// P1-5 + G-10: fail-closed groupLinesAfter, malformed-JSON retry without losing
// cursor, multi-member group review coordination, entryId targeting, overflowed
// exact pass bound, and startup catch-up.

test('P1-5 + G-10: group review fails closed on ledger errors, retries malformed JSON with bounded backoff, waits for all active group members, and targets by entryId', async (t) => {
  // 1. Fail-closed groupLinesAfter: throwing must leave reviewed.json untouched.
  const rLedger = start({ replies: [JSON.stringify({ changes: [] })] })
  t.after(() => rLedger.stop())
  await rLedger.call('state', {})
  rLedger.rt.groupLinesAfter = async () => { throw new Error('disk ledger read failed') }
  rLedger.ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(rLedger.call)
  assert.equal(existsSync(join(rLedger.home, 'memory', 'reviewed.json')), false, 'ledger read error must NOT advance reviewed.json')

  // 2. Malformed JSON reply keeps cursor and recovers on backoff retry, while persistently broken output caps at retryMax!
  const rMalformed = start({
    replies: [
      'Not valid JSON at all',
      JSON.stringify({ changes: [{ op: 'add', text: 'Recovered after malformed JSON retry' }] }),
    ],
    config: { memoryReviewRetryMs: 25, memoryReviewRetryMax: 3 },
  })
  t.after(() => rMalformed.stop())
  await rMalformed.call('state', {})
  rMalformed.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(rMalformed.call)
  assert.equal(rMalformed.requests.length, 1)
  assert.deepEqual(JSON.parse(rMalformed.read('reviewed.json')), { 'chat:b2': 9 })
  // Wait for automatic retry timer (25ms) to fire and succeed.
  for (let i = 0; i < 60 && rMalformed.requests.length < 2; i += 1) await settle(15)
  await reviewed(rMalformed.call)
  assert.equal(rMalformed.requests.length, 2)
  assert.match(rMalformed.read('bots', 'b2', 'MEMORY.md'), /Recovered after malformed JSON retry/)
  assert.deepEqual(JSON.parse(rMalformed.read('reviewed.json')), { 'chat:b2': 11 })

  // Persistently malformed replies stop retrying at memoryReviewRetryMax (no infinite spin).
  const rBroken = start({
    replies: () => 'still not json',
    config: { memoryReviewRetryMs: 10, memoryReviewRetryMax: 2 },
  })
  t.after(() => rBroken.stop())
  await rBroken.call('state', {})
  rBroken.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await settle(120)
  await reviewed(rBroken.call)
  assert.equal(rBroken.requests.length, 2, 'malformed retries must stop at memoryReviewRetryMax')

  // 3. G-10: Multi-member group review waits until ALL active group members are idle before running ONCE.
  const rGroup = start({
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'Whole-round group fact' }] })],
    config: { memoryReviewDelayMs: 20 },
  })
  t.after(() => rGroup.stop())
  await rGroup.call('state', {})
  rGroup.ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'running' })
  rGroup.ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'running' })
  // Faster member g2 finishes while g3 is still running -> review must NOT run yet.
  rGroup.ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await settle(60)
  assert.equal(rGroup.requests.length, 0, 'group review must wait while slower member g3 is still active')
  // Slower member g3 finishes -> single group review runs cleanly.
  rGroup.ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(rGroup.call)
  assert.equal(rGroup.requests.length, 1)
  assert.match(rGroup.read('groups', 'r1', 'MEMORY.md'), /Whole-round group fact/)

  // 4. Group debounce waits past GROUP_WAIT_MAX while rt.roomActive(roomId) stays true (never drops the review).
  let activeRound = true
  let activeChecks = 0
  const rLongRound = start({
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'Long finalizing round fact' }] })],
    config: { memoryReviewDelayMs: 5, memoryReviewGroupWaitMs: 10 },
  })
  t.after(() => rLongRound.stop())
  await rLongRound.call('state', {})
  rLongRound.rt.roomActive = (roomId) => {
    if (roomId !== 'r1') return false
    activeChecks += 1
    if (activeChecks > 24) activeRound = false
    return activeRound
  }
  rLongRound.ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'running' })
  rLongRound.ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await reviewed(rLongRound.call)
  assert.ok(activeChecks > 24, `expected polling past GROUP_WAIT_MAX (>20), saw ${activeChecks}`)
  assert.equal(rLongRound.requests.length, 1, 'group review must still run once after roomActive clears past GROUP_WAIT_MAX')
  assert.match(rLongRound.read('groups', 'r1', 'MEMORY.md'), /Long finalizing round fact/)

  // 5. applyReview uses exact-identity matching so exact-text-equals-ID (`cafe`) never deletes the
  //    wrong entry and whole-word ID collisions (`2026`) never silently drop edits/removals.
  const rExact = start({
    replies: [JSON.stringify({
      changes: [
        { op: 'remove', entry: 1 },
        { op: 'edit', entry: 3, text: 'Ship daily summaries' },
      ],
    })],
  })
  t.after(() => rExact.stop())
  mkdirSync(join(rExact.home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(rExact.home, 'memory', 'bots', 'b2', 'MEMORY.md'), [
    '# Memory',
    '',
    '- User prefers dark mode [id: cafe; added: 2026-01-01]',
    '- cafe [id: 9999; added: 2026-01-02]',
    '- Ship weekly summaries [id: 2026; added: 2026-01-03]',
    '- Launch target is 2026 [id: 8888; added: 2026-01-04]',
    '',
    '## Index',
    '',
  ].join('\n'))
  await rExact.call('state', {})
  rExact.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(rExact.call)
  const afterExact = parseMemory(rExact.read('bots', 'b2', 'MEMORY.md')).entries.map(e => e.text)
  assert.deepEqual(afterExact, ['cafe', 'Ship daily summaries', 'Launch target is 2026'], 'exact-identity targetMatch must delete entry 1 (not literal "cafe") and edit id:2026 cleanly')

  // 6. applyReview targets entries with bracket suffixes via exact identity and overflowed caps at exactly 4 passes.
  let pass = 0
  const rPasses = start({
    replies: () => {
      pass += 1
      if (pass === 1) {
        return JSON.stringify({
          changes: [
            { op: 'edit', entry: 1, text: 'Redis pool [timeout: 60]' },
            ...Array.from({ length: 7 }, (_, i) => ({ op: 'add', text: `Overflow pass ${pass} item ${i}` })),
          ],
        })
      }
      return JSON.stringify({
        changes: Array.from({ length: 8 }, (_, i) => ({ op: 'add', text: `Overflow pass ${pass} item ${i}` })),
      })
    },
  })
  t.after(() => rPasses.stop())
  await rPasses.tool('bot_remember', { text: 'Redis pool [timeout: 30]' }, 'b2')
  await rPasses.call('state', {})
  rPasses.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(rPasses.call)
  assert.match(rPasses.read('bots', 'b2', 'MEMORY.md'), /Redis pool \[timeout: 60\]/)
  assert.equal(rPasses.requests.length, 4, 'overflowed passes must stop at REVIEW_PASSES_MAX = 4, not 5')

  // 7. Startup catch-up reviews unreviewed lines after restart, AND skips already-reviewed Bots
  //    with 0 page() calls (respecting DSH session.seq === lastSeq + 1).
  const rCatchup = start({
    replies: () => JSON.stringify({ changes: [{ op: 'add', text: 'Caught up on startup' }] }),
    config: { memoryReviewCatchupDelayMs: 20 },
  })
  let stoppedCatchup = false
  t.after(() => (stoppedCatchup ? undefined : rCatchup.stop()))
  // Wait for group:r1 + all 3 Bots (m1, b2, b3) to complete startup catch-up.
  for (let i = 0; i < 100 && rCatchup.requests.length < 4; i += 1) await settle(20)
  await reviewed(rCatchup.call)
  assert.equal(rCatchup.requests.length, 4, 'startup catch-up must review the group and all 3 unreviewed Bots')
  assert.match(rCatchup.read('groups', 'r1', 'MEMORY.md'), /Caught up on startup/)

  // Restart on the same up-to-date home: catchUp must skip all reviewed Bots with 0 page() calls.
  stoppedCatchup = true
  await rCatchup.stop({ keep: true })
  let pageCalls = 0
  const rCaughtUp = start({
    home: rCatchup.home,
    replies: () => JSON.stringify({ changes: [] }),
    config: { memoryReviewCatchupDelayMs: 20 },
  })
  t.after(() => rCaughtUp.stop())
  const origPage = rCaughtUp.ctx.sessionController.page
  rCaughtUp.ctx.sessionController.page = async (args) => {
    pageCalls += 1
    return origPage(args)
  }
  await settle(80)
  assert.equal(rCaughtUp.rt.memoryReviews(), 0, 'no review should be queued when all Bots are up-to-date')
  assert.equal(pageCalls, 0, 'up-to-date Bots (session.seq - 1 <= cursor) must trigger 0 page() calls on startup catch-up')
  assert.equal(rCaughtUp.requests.length, 0)
})

// ---------------------------------------------------------------------------
// P2-1: learning.js durability, double-approve lock, backoff on all-failed runs,
// group-task filtering, delete-bot cleanup, and settled proposal trimming.

test('P2-1: learning fails closed on corrupt state.json, guards double-approve, backs off on all-failed runs, skips group tasks, cleans deleted bots, and trims settled content', async (t) => {
  // 1. Corrupt learning/state.json -> backup created, stuck guard refuses overwrite and learning-answer.
  const corruptHome = mkdtempSync(join(tmpdir(), 'ds-bot-mem-dur-'))
  mkdirSync(join(corruptHome, 'learning'), { recursive: true })
  writeFileSync(join(corruptHome, 'learning', 'state.json'), '{broken json!!!')
  const rCorrupt = start({ home: corruptHome, config: { memoryReview: false, learningTimes: { minTurnMs: 0, idleMs: 0 } } })
  t.after(() => rCorrupt.stop())
  await rCorrupt.call('state', {})
  assert.deepEqual(rCorrupt.rt.learningView(), {})
  const files = readdirSync(join(corruptHome, 'learning'))
  assert.ok(files.some(name => name.startsWith('state.json.broken-')), 'corrupt state.json must be backed up')
  assert.equal(await rCorrupt.rt.learningRun(), 0)
  assert.equal(readFileSync(join(corruptHome, 'learning', 'state.json'), 'utf8'), '{broken json!!!', 'corrupt state.json must NOT be overwritten')
  const badAns = await rCorrupt.call('learning-answer', { id: 'any', approve: true })
  assert.equal(badAns.ok, false)

  // 2. Group background task ignored; all-failed run uses short backoff instead of 12h lockout;
  // double-approve race serialized; settled trimming; delete-bot cleanup!
  let failFirst = true
  const replies = () => {
    if (failFirst) {
      failFirst = false
      return new Error('transient LLM outage')
    }
    return JSON.stringify({
      action: 'create',
      name: 'deploy-checks',
      description: 'Run release checks before publishing',
      content: `# Deploy checks\n\n${'Run checks thoroughly. '.repeat(80)}`,
      why: 'User corrected release workflow',
    })
  }
  const rLearn = start({
    replies,
    config: {
      memoryReview: false,
      agentsMd: false,
      learningTimes: { minTurnMs: 0, idleMs: 0, intervalMs: 12 * 60 * 60_000, retryMs: 200 },
    },
  })
  t.after(() => rLearn.stop())
  await rLearn.call('state', {})

  // Group background task long turn must NOT mark b2 pending for own-chat learning.
  rLearn.rt.chatOwners.set('task-g-learn', 'b2')
  rLearn.rt.taskOwners.set('task-g-learn', { botId: 'b2', taskId: 'tgl', roomId: 'r1' })
  rLearn.ctx.emit('agent/status', { agent: { id: 'task-g-learn' }, status: 'running' })
  rLearn.ctx.emit('agent/status', { agent: { id: 'task-g-learn' }, status: 'idle' })
  assert.equal(rLearn.rt.learningDue(), false, 'group background task must not queue own-chat learning')

  // Real own-chat turn queues b2.
  rLearn.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'running' })
  rLearn.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  assert.equal(rLearn.rt.learningDue(), true)

  // First pass fails completely -> must NOT set 12h lastRun lockout; due() recovers after retryMs (200ms).
  await rLearn.rt.learningRun()
  assert.equal(rLearn.rt.learningDue(), false, 'failed run must enter short backoff')
  for (let i = 0; i < 40 && !rLearn.rt.learningDue(); i += 1) await settle(25)
  assert.equal(rLearn.rt.learningDue(), true, 'all-failed learning run must retry after short retryMs, not wait 12h')

  // Second pass succeeds and creates proposal.
  await rLearn.rt.learningRun()
  const [proposal] = rLearn.rt.learningView().b2 ?? []
  assert.ok(proposal)

  // Double-approve race: wrap capabilitySave with a delay so two concurrent approves overlap.
  let saves = 0
  const realSave = rLearn.rt.capabilitySave
  rLearn.rt.capabilitySave = async (...args) => {
    saves += 1
    await settle(40)
    return realSave(...args)
  }
  const [a1, a2] = await Promise.all([
    rLearn.call('learning-answer', { id: proposal.id, approve: true }),
    rLearn.call('learning-answer', { id: proposal.id, approve: true }),
  ])
  assert.equal(saves, 1, 'concurrent approve must execute capabilitySave only once')
  assert.equal([a1.ok, a2.ok].filter(Boolean).length, 1)
  assert.equal([a1, a2].find(r => !r.ok).error.code, 'bot/busy')

  // Settled skill keeps content in current chat part, and trims content once Bot moves to a new chat part.
  const stateBeforeSwitch = JSON.parse(readFileSync(join(rLearn.home, 'learning', 'state.json'), 'utf8'))
  assert.ok(stateBeforeSwitch.settled[proposal.id].content.length > 500)
  rLearn.rt.botOf('b2').sessionId = 'b2-part-2'
  await rLearn.rt.learningRun()
  const stateAfterSwitch = JSON.parse(readFileSync(join(rLearn.home, 'learning', 'state.json'), 'utf8'))
  assert.equal(stateAfterSwitch.settled[proposal.id].content, undefined, 'settled proposal from past chat part must trim bulky content')
  assert.equal(stateAfterSwitch.settled[proposal.id].name, 'deploy-checks')

  // Deleting Bot b2 cleans its proposals, settled, pending, and learned via onBotDelete.
  const del = await rLearn.call('delete-bot', { id: 'b2' })
  assert.equal(del.ok, true, JSON.stringify(del))
  const stateAfterDelete = JSON.parse(readFileSync(join(rLearn.home, 'learning', 'state.json'), 'utf8'))
  assert.equal(stateAfterDelete.settled[proposal.id], undefined)
  assert.equal(stateAfterDelete.learned.b2, undefined)
  assert.equal(stateAfterDelete.pending.b2, undefined)
})

// ---------------------------------------------------------------------------
// P2-2: memory-history read-only access, orphan snapshot cleanup, and
// Private -> Public journal continuity.

test('P2-2: memory-history works read-only, orphan snapshots are pruned, and Private->Public keeps legacy journal continuity', async (t) => {
  // 1. Private -> Public toggle keeps legacy per-Bot journal visible in memory-history while new writes go to shared journal.
  const team = structuredClone(TEAM)
  team.bots.b2.private = true
  const rPriv = start({ team, config: { memoryReview: false } })
  t.after(() => rPriv.stop())
  await rPriv.tool('bot_remember', { text: 'Private era secret-free fact' }, 'b2')
  assert.match(rPriv.read('bots', 'b2', 'journal.jsonl'), /Private era secret-free fact/)

  // Toggle Private -> Public.
  const pub = await rPriv.call('update-bot', { id: 'b2', private: false })
  assert.equal(pub.ok, true, JSON.stringify(pub))
  await rPriv.tool('bot_remember', { text: 'Public era new fact' }, 'b2')
  assert.match(rPriv.read('journal.jsonl'), /Public era new fact/)
  assert.doesNotMatch(rPriv.read('bots', 'b2', 'journal.jsonl'), /Public era new fact/, 'new public writes must go to shared journal')

  const hist = (await rPriv.call('memory-history', { botId: 'b2' })).value.rows
  assert.ok(hist.some(row => row.text === 'Private era secret-free fact'), 'legacy private journal must remain readable after toggling to public')
  assert.ok(hist.some(row => row.text === 'Public era new fact'))

  // 2. Orphaned snapshots (settled task / archived segment / deleted session) are pruned while live sessions stay.
  await runPreStep(rPriv.ctx, 'b2')
  const snapDir = join(rPriv.home, 'memory', 'snapshots')
  mkdirSync(snapDir, { recursive: true })
  writeFileSync(join(snapDir, 'settled-task-99.md'), '# stale')
  writeFileSync(join(snapDir, 'settled-task-99.seen'), new Date().toISOString())
  const pruned = rPriv.rt.pruneMemorySnapshots()
  assert.equal(pruned, 2)
  assert.equal(existsSync(join(snapDir, 'settled-task-99.md')), false)
  assert.equal(existsSync(join(snapDir, 'settled-task-99.seen')), false)
  assert.equal(existsSync(join(snapDir, 'b2.seen')), true, 'live session seen watermark must stay')

  // 3. memory-history succeeds in a read-only window (channel.js READS).
  const roHome = mkdtempSync(join(tmpdir(), 'ds-bot-mem-dur-'))
  writeFileSync(join(roHome, 'state.json'), JSON.stringify(TEAM))
  mkdirSync(join(roHome, 'memory'), { recursive: true })
  writeFileSync(join(roHome, 'memory', 'journal.jsonl'), `${JSON.stringify({ id: 'ro-1', time: new Date().toISOString(), scope: 'bot:b2', op: 'add', file: 'MEMORY.md', actor: 'user', after: '- Read-only visible entry' })}\n`)
  writeFileSync(join(roHome, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const rRo = start({ home: roHome, config: { memoryReview: false } })
  t.after(() => rRo.stop())
  await rRo.call('state', {})
  assert.notEqual(rRo.rt.readOnly(), undefined)
  const roHist = await rRo.call('memory-history', { botId: 'b2' })
  assert.equal(roHist.ok, true, JSON.stringify(roHist))
  assert.equal(roHist.value.rows[0].text, 'Read-only visible entry')
})
