import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCoordinationDb } from '../src/host/coordination-db.js'
import { install as installGroups } from '../src/host/groups.js'
import {
  ROOM_MESSAGE_KINDS,
  addressedMembers,
  classifyBotGroupSpeech,
  explicitCallees,
  isCallRoute,
  isInviteRoute,
  isResultRoute,
  isVisibleRoute,
  newCallees,
  resolveUserInvite,
  roomCall,
  roomInvite,
  roomNote,
  roomRequest,
  roomResult,
  roomVisible,
  waitsOnMember,
} from '../src/host/room-message.js'
import { createRoomReports } from '../src/host/room-reports.js'

const members = [
  { id: 'bot-a', name: 'Alice' },
  { id: 'bot-b', name: 'Bob' },
  { id: 'bot-c', name: 'Carol' },
]

test('room-message 3-way routes preserve zero-wake visible and strict zero-echo semantics', () => {
  assert.deepEqual(ROOM_MESSAGE_KINDS, ['visible', 'invite', 'call'])

  assert.equal(isVisibleRoute(undefined), true)
  assert.equal(isVisibleRoute(roomVisible()), true)
  assert.equal(isVisibleRoute(roomNote()), true)
  assert.equal(isCallRoute(roomCall(['bot-b'])), true)
  assert.equal(isCallRoute(roomRequest(['bot-b'])), true)
  assert.equal(isInviteRoute(roomInvite(['bot-a'])), true)
  assert.equal(isResultRoute(roomResult('bot-a', 'rw-1')), true)

  // Visible / note messages address nobody (0 wakes).
  assert.deepEqual(addressedMembers(roomVisible(), members, 'bot-a'), [])
  assert.deepEqual(addressedMembers(roomNote(), members, 'bot-a'), [])

  // Explicit `call` excludes sender and unknown ids.
  assert.deepEqual(
    explicitCallees(roomCall(['bot-a', 'bot-b', 'unknown', 'bot-b']), members, 'bot-a').map(m => m.id),
    ['bot-b'],
  )
  // Invites and results never count as explicit `call` edges.
  assert.deepEqual(explicitCallees(roomInvite(['bot-b']), members, 'bot-a'), [])
  assert.deepEqual(explicitCallees(roomResult('bot-a', 'rw-1'), members, 'bot-b'), [])

  // Strict zero-echo: `newCallees` never turns body `@Name` speakers into calls without a `call` route.
  assert.deepEqual(newCallees(roomVisible(), members), [])
  assert.deepEqual(newCallees(roomResult('bot-a', 'rw-1'), members), [])
  assert.deepEqual(newCallees(roomInvite(['bot-b']), members), [])
  assert.deepEqual(newCallees(roomCall(['bot-c']), members).map(m => m.id), ['bot-c'])

  // `classifyBotGroupSpeech`: answering a result -> `visible`; answering a call -> `result`; plain -> `visible`.
  assert.deepEqual(classifyBotGroupSpeech({ resultRef: 'G42', activeCallId: 'rw-1', askedBy: 'bot-a' }), { kind: 'visible' })
  assert.deepEqual(classifyBotGroupSpeech({ activeCallId: 'rw-1', askedBy: 'bot-a' }), { kind: 'result', to: ['bot-a'], callId: 'rw-1', batch: 'rw-1' })
  assert.deepEqual(classifyBotGroupSpeech({}), { kind: 'visible' })
})

test('resolveUserInvite honors @mention, admin mode, everyone ordered mode, and @all', () => {
  const byMention = resolveUserInvite({ members, adminId: 'bot-a', mode: 'admin', mentions: { all: false, found: [members[2]] } })
  assert.deepEqual(byMention, { kind: 'invite', to: ['bot-c'], reason: 'user_mention' })

  const byAdmin = resolveUserInvite({ members, adminId: 'bot-a', mode: 'admin', mentions: { all: false, found: [] } })
  assert.deepEqual(byAdmin, { kind: 'invite', to: ['bot-a'], reason: 'user_admin' })

  const byEveryone = resolveUserInvite({ members, adminId: 'bot-b', mode: 'everyone', mentions: { all: false, found: [] } })
  assert.deepEqual(byEveryone, { kind: 'invite', to: ['bot-b', 'bot-a', 'bot-c'], ordered: true, reason: 'user_everyone' })

  const byAll = resolveUserInvite({ members, adminId: 'bot-b', mode: 'admin', mentions: { all: true, found: [] } })
  assert.deepEqual(byAll, { kind: 'invite', to: ['bot-b', 'bot-a', 'bot-c'], reason: 'user_all' })
})

test('waitsOnMember detects direct and transitive cycles in SQLite room_work graph', () => {
  const db = openCoordinationDb({ path: ':memory:' })
  try {
    // A -> B -> C in room-1.
    const wA = db.createWork({ workId: 'rw-a', botId: 'bot-a', kind: 'room_work', roomId: 'room-1', status: 'waiting' }).work
    const wB = db.createWork({ workId: 'rw-b', botId: 'bot-b', kind: 'room_work', roomId: 'room-1', status: 'waiting', parentWorkId: wA.workId }).work
    const wC = db.createWork({ workId: 'rw-c', botId: 'bot-c', kind: 'room_work', roomId: 'room-1', status: 'running', parentWorkId: wB.workId }).work
    db.createCall({ callId: 'c-ab', parentWorkId: wA.workId, childWorkId: wB.workId, callerBotId: 'bot-a', calleeBotId: 'bot-b', visibleScope: 'room', roomId: 'room-1' })
    db.createCall({ callId: 'c-bc', parentWorkId: wB.workId, childWorkId: wC.workId, callerBotId: 'bot-b', calleeBotId: 'bot-c', visibleScope: 'room', roomId: 'room-1' })

    // Self-call, direct cycle (B -> A), and transitive cycle (C -> A) all blocked.
    assert.equal(waitsOnMember(db, 'room-1', 'bot-a', 'bot-a'), true)
    assert.equal(waitsOnMember(db, 'room-1', 'bot-b', 'bot-a'), true)
    assert.equal(waitsOnMember(db, 'room-1', 'bot-c', 'bot-a'), true)
    assert.equal(waitsOnMember(db, 'room-1', 'bot-c', 'bot-b'), true)
    // Forward / unrelated room edges are not cycles.
    assert.equal(waitsOnMember(db, 'room-1', 'bot-a', 'bot-c'), false)
    assert.equal(waitsOnMember(db, 'room-2', 'bot-c', 'bot-a'), false)
  } finally {
    db.close()
  }
})

function makeReportHarness(db) {
  const room = { id: 'room-1', name: 'Design', members: ['bot-a', 'bot-b'], seq: 2, sessions: { 'bot-a': 's-a', 'bot-b': 's-b' }, log: [] }
  const bots = new Map([
    ['bot-a', { id: 'bot-a', name: 'Alice', color: '#111' }],
    ['bot-b', { id: 'bot-b', name: 'Bob', color: '#222' }],
  ])
  const records = [
    { seq: 1, who: 'Alice', botId: 'bot-a', text: 'Please check the spec', openingPost: true, time: 100 },
    { seq: 2, who: 'Bob', botId: 'bot-b', text: 'Spec looks good!', time: 200 },
  ]
  const kicked = []
  const delivered = []
  const imOrigins = new Map()
  let busy = false

  const rt = {
    coordDb: db,
    state: { questions: {}, views: {}, switching: {} },
    live: new Map(),
    roomInbox: new Map(),
    readOnly: () => undefined,
    botOf: id => bots.get(id),
    roomOf: id => (id === room.id ? room : undefined),
    chatOf: id => `chat-${id}`,
    sessionOfRoom: r => `sess-${r.id}`,
    warn: () => {},
    ledger: {
      range: (_book, from, to) => records.filter(r => r.seq >= from && r.seq <= to),
    },
    kickScheduler: async (opts) => { kicked.push(opts) },
    deliver: async (args) => { delivered.push(args) },
    rememberImReplyOrigin: (key, origin) => { imOrigins.set(key, origin) },
  }

  const reports = createRoomReports(rt, {
    hasActiveRoomCalls: () => busy,
    exitMemberRoomCalls: async () => {},
    activeInRoom: () => busy,
    runningRound: () => (busy ? { roomId: room.id } : undefined),
    isFinalizing: () => false,
    laterPostsOf: () => [],
    bookOf: id => `group-${id}`,
    ensureRoomLog: () => {},
    rowOf: rec => ({ botId: rec.botId, name: rec.who, text: rec.text, kind: rec.kind }),
    saveSoon: () => {},
    nextRoomSeq: r => r.seq + 1,
  })

  return { rt, room, reports, kicked, delivered, imOrigins, setBusy: (v) => { busy = v } }
}

test('room-reports opens SQLite call+wait and settles atomically via kickScheduler without double rt.deliver', async () => {
  const db = openCoordinationDb({ path: ':memory:' })
  try {
    const { room, reports, kicked, delivered, imOrigins, setBusy } = makeReportHarness(db)
    const fg = db.ensureForegroundWork({ botId: 'bot-a', sessionId: 'chat-bot-a' }).work

    setBusy(true)
    const imOrigin = { connId: 'feishu-1', chatKey: 'oc_1', senderId: 'ou_1' }
    const opened = reports.openRoomReportCall(room, {
      id: 'rep-1',
      botId: 'bot-a',
      name: 'Alice',
      status: 'tracking',
      fromSeq: 1,
      parentWorkId: fg.workId,
      imOrigin,
    })
    assert.equal(opened.id, 'rep-1')
    assert.equal(db.listWaits({ workId: fg.workId, kind: 'call', status: 'open' }).length, 1)

    // While busy, settleRoomReports must wait.
    await reports.settleRoomReports(room.id)
    assert.equal(kicked.length, 0)
    assert.equal(delivered.length, 0)

    // Once group work finishes, settle atomically -> inbox(kind='result') + kickScheduler ONCE, 0 rt.deliver.
    setBusy(false)
    await reports.settleRoomReports(room.id)
    assert.deepEqual(kicked, [{ workId: fg.workId }])
    assert.equal(delivered.length, 0)
    assert.deepEqual(imOrigins.get('rep-1'), imOrigin)

    const inbox = db.listInbox(fg.workId, { unreadOnly: true })
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'result')
    assert.equal(inbox[0].payload.role, 'report')
    assert.equal(inbox[0].payload.source.replyTo, 'rep-1')
    assert.deepEqual(inbox[0].payload.imOrigin, imOrigin)
    assert.ok(inbox[0].payload.renderedText.startsWith('[Group chat "Design" · replies to your post]\n'))
    assert.match(inbox[0].payload.renderedText, /Bob: Spec looks good!/)
    assert.equal(db.listWaits({ workId: fg.workId, kind: 'call', status: 'open' }).length, 0)

    // Second settleRoomReports is a no-op (single-settlement guarantee).
    await reports.settleRoomReports(room.id)
    assert.equal(kicked.length, 1)
  } finally {
    db.close()
  }
})

test('room-reports taints IM origin on conflicting post and delivers migrated legacy roomReports on startup', async () => {
  const db = openCoordinationDb({ path: ':memory:' })
  try {
    const { room, reports, kicked, imOrigins, setBusy } = makeReportHarness(db)

    // 1. IM origin taint isolation.
    setBusy(true)
    reports.openRoomReportCall(room, {
      id: 'rep-im',
      botId: 'bot-a',
      name: 'Alice',
      status: 'tracking',
      fromSeq: 1,
      imOrigin: { connId: 'feishu-1', chatKey: 'oc_1', senderId: 'ou_1' },
    })
    reports.taintRoomReportOrigins(room.id, undefined)
    setBusy(false)
    await reports.settleRoomReports(room.id)
    assert.deepEqual(imOrigins.get('rep-im'), { mixed: true })

    // 2. Migrated legacy `state.roomReports` row (no `calls` row from `importLegacyState`).
    db.importLegacyState({
      state: {
        bots: { 'bot-a': { id: 'bot-a', name: 'Alice', sessionId: 'chat-bot-a' } },
        roomReports: {
          'legacy-1': { id: 'legacy-1', botId: 'bot-a', roomId: 'room-1', fromSeq: 1 },
        },
      },
    })
    await reports.settleRoomReports(room.id, { startup: true })
    assert.equal(kicked.filter(k => k.workId === 'fg:bot-a').length, 2)
    const inbox = db.listInbox('fg:bot-a', { unreadOnly: true })
    assert.ok(inbox.some(m => m.kind === 'result' && m.payload?.replyTo === 'legacy-1'))
  } finally {
    db.close()
  }
})

test('groups multi-round stagnation pauses on 3rd identical no-file-changes round and resets cleanly on resume', async () => {
  const db = openCoordinationDb({ path: ':memory:' })
  try {
    const room = { id: 'room-s', name: 'Ops', admin: 'bot-a', members: ['bot-a', 'bot-b'], seq: 0, log: [], seen: {}, sessions: { 'bot-a': 's-a', 'bot-b': 's-b' } }
    const bots = new Map([
      ['bot-a', { id: 'bot-a', name: 'Alice', color: '#111' }],
      ['bot-b', { id: 'bot-b', name: 'Bob', color: '#222' }],
    ])
    const records = []
    const rt = {
      home: '/tmp/dsb-room-protocol-test',
      coordDb: db,
      state: { questions: {}, views: {}, switching: {} },
      ctx: { on: () => {}, effect: () => {} },
      teamTools: [],
      live: new Map(),
      roomInbox: new Map(),
      roomProgress: new Map(),
      roomWaiters: new Map(),
      groupOwners: new Map(),
      pastOwners: new Map(),
      chatOwners: new Map(),
      readOnly: () => undefined,
      load: async () => {},
      save: async () => {},
      warn: () => {},
      botOf: id => bots.get(id),
      roomOf: id => (id === room.id ? room : undefined),
      sessionOfRoom: r => `sess-${r.id}`,
      isAdminOf: (r, id) => r.admin === id,
      resolveAgent: async () => ({ followup: () => {}, session: {} }),
      ledger: {
        importer: () => {},
        open: () => ({ bySeq: new Map() }),
        after: () => [],
        append: (_book, rec) => { records.push(rec) },
        records: () => records,
        range: () => [],
      },
    }
    installGroups(rt)

    // Round 1: Alice -> Bob, Bob replies with identical text and no file changes -> count 1.
    const r1 = rt.openRoomCall(room, 'bot-a', [bots.get('bot-b')])
    const c1 = rt.checkRoomProgressStagnation(room, r1.children[0].work.workId, {
      callerId: 'bot-a', calleeId: 'bot-b', text: 'still checking logs',
    })
    assert.equal(c1.count, 1)
    assert.equal(c1.paused, false)
    db.settleWork({ workId: r1.children[0].work.workId, outcome: 'done', force: true })
    db.settleWork({ workId: r1.parentWork.workId, outcome: 'done', force: true })

    // Round 2: new caller/call pair in same room shares `rw_chain:room-s` -> count 2.
    const r2 = rt.openRoomCall(room, 'bot-a', [bots.get('bot-b')])
    assert.equal(r2.parentWork.rootWorkId, 'rw_chain:room-s')
    const c2 = rt.checkRoomProgressStagnation(room, r2.children[0].work.workId, {
      callerId: 'bot-a', calleeId: 'bot-b', text: 'still checking logs',
    })
    assert.equal(c2.count, 2)
    assert.equal(c2.paused, false)
    db.settleWork({ workId: r2.children[0].work.workId, outcome: 'done', force: true })
    db.settleWork({ workId: r2.parentWork.workId, outcome: 'done', force: true })

    // Round 3: 3rd identical no-file-changes round -> pauses entire chain + emits visible pause notice.
    const r3 = rt.openRoomCall(room, 'bot-a', [bots.get('bot-b')])
    const c3 = rt.checkRoomProgressStagnation(room, r3.children[0].work.workId, {
      callerId: 'bot-a', calleeId: 'bot-b', text: 'still checking logs',
    })
    assert.equal(c3.count, 3)
    assert.equal(c3.paused, true)
    assert.equal(db.getWork('rw_chain:room-s').status, 'paused')
    assert.equal(db.getWork(r3.children[0].work.workId).status, 'paused')
    assert.ok(records.some(r => r.kind === 'notice' && r.reason === 'paused' && r.cause === 'no_progress'))

    // User clicks Continue: resumes paused works, parks `rw_chain` back to `idle`, leaves 0 rows in `ready`.
    rt.ctx.sessions = { flush: async () => {} }
    const resumed = await rt.resumeRoomPause(room.id)
    assert.equal(resumed, true)
    assert.equal(db.getWork('rw_chain:room-s').status, 'idle')
    assert.equal(db.getWork('rw_chain:room-s').stagnationCount, 0)
    assert.equal(db.peekReady().length, 0)
  } finally {
    db.close()
  }
})
