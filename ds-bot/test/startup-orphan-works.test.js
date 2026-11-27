// Startup orphan & interrupted-work reconciliation (DS Bot v2 SQLite + DSH D2):
// interrupted or orphaned leaf works are recovered from D2 session logs when
// already completed, settled visibly back to their caller/parent when the target
// session or Bot is gone, and pruned of unreferenced result files — while paused,
// needs_verification, need_input, non-leaf, group room_work, live running,
// inbox-queued, question, approval, and secret-waiting works stay untouched.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import { after, test } from 'node:test'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { openCoordinationDb } from '../src/host/coordination-db.js'
import { fakeContext } from './fake-ctx.js'

const tempHomes = []
after(() => {
  for (const dir of tempHomes) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {}
  }
})
const tempHome = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempHomes.push(dir)
  return dir
}

const textOf = content => (Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : String(content ?? ''))

const settle = async (check, ms = 3000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), label)
}

const seedTeam = (over = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
    c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    d: { id: 'd', name: 'Helper', role: 'Ops', sessionId: 'dm-d', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  views: {},
  prefs: {},
  revision: 0,
  ...over,
})

function startHost(t, { home: existingHome, team, inflight, agentSetup, logs = new Map() } = {}) {
  const ownsHome = existingHome === undefined
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-orphan-works-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  if (inflight !== undefined) writeFileSync(join(home, 'inflight.json'), JSON.stringify(inflight))

  const ctx = fakeContext()
  const agents = new Map()
  const makeAgent = (id) => {
    const calls = []
    const inbox = {
      nextStep: [],
      nextTurn: [],
      prepend(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg) },
      append(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg) },
      remove(msgId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) return list.splice(at, 1).length === 1
        }
        return false
      },
    }
    const agent = {
      id,
      session: {
        id,
        requestHeader: () => undefined,
        snapshotEvents: () => (logs.get(id) ?? []).map((event, idx) => ({ seq: idx + 1, ...event })),
      },
      calls,
      status: 'idle',
      inbox,
      followup(message) { calls.push(['followup', message]); inbox.nextTurn.push(message) },
      steer(message) { calls.push(['steer', message]); inbox.nextStep.push(message) },
      inject(message) { calls.push(['inject', message]); inbox.nextStep.push(message) },
      cancel(cause) { calls.push(['cancel', cause]) },
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    }
    agentSetup?.(id, agent)
    return agent
  }
  const agentOf = (id) => {
    if (!agents.has(id)) agents.set(id, makeAgent(id))
    return agents.get(id)
  }

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's-new' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async ({ address }) => {
        const sid = address?.sessionId ?? address?.childSessionId
        const records = (logs.get(sid) ?? []).map((event, idx) => ({ event: { seq: idx + 1, ...event } }))
        return { records, hasMore: false }
      },
      projections: async ({ sessionId }) => ({ asOfSeq: (logs.get(sessionId) ?? []).length }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  ctx.get = key => (key === 'agents' ? agents : origGet(key))

  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  t.after(async () => {
    await ctx.dispose()
    if (ownsHome) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { home, ctx, rt, agents, agentOf, emit }
}

function seedCoord(home, fn) {
  const db = openCoordinationDb({ path: join(home, 'coordination.sqlite') })
  try {
    fn(db)
  } finally {
    db.close()
  }
}

test('empty inflight: orphan leaf work settles visibly, wakes parent without killing parent, frees result files and upstreamOf', async (t) => {
  const home = tempHome('ds-bot-orphan-leaf-')
  const resultsDir = join(home, 'handoff-results')
  mkdirSync(resultsDir, { recursive: true })
  const pinnedFile = join(resultsDir, 'w-sub-old.txt')
  writeFileSync(pinnedFile, 'x'.repeat(2500))

  // Seed a parent work (`w-parent`, a -> b) waiting on an interrupted leaf work (`w-leaf`, b -> c)
  // whose target session is gone (`sessionId: null`, no active session).
  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'dm-b' })
    db.createWork({
      workId: 'w-parent', workRef: 'W1', botId: 'b', kind: 'task',
      logicalAddress: 'task:w-parent', status: 'waiting', parentWorkId: 'fg:a', sessionId: 'dm-b',
    })
    db.createCall({
      callId: 'c_w-parent', parentWorkId: 'fg:a', childWorkId: 'w-parent',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
    })
    db.createWork({
      workId: 'w-leaf', workRef: 'W42', botId: 'c', kind: 'task',
      logicalAddress: 'task:w-leaf', status: 'idle', parentWorkId: 'w-parent',
    })
    db.createCall({
      callId: 'c_w-leaf', parentWorkId: 'w-parent', childWorkId: 'w-leaf',
      callerBotId: 'b', calleeBotId: 'c', returnAddress: 'task:w-parent',
      initialMessage: { dedupKey: 'req-w-leaf', bodyPreview: 'Review PR', payload: { text: 'Review PR', role: 'request' } },
    })
    const claim = db.claimReady({ workId: 'w-leaf' })
    db.beginDeliveryAttempt({ workId: 'w-leaf', claimToken: claim.claimToken, throughSeq: claim.claimedInboxSeq, idempotencyKey: 'dk-w-leaf' })
  })

  const host = startHost(t, { home, team: seedTeam() })
  await host.rt.adoptLiveWork()

  const leaf = host.rt.coordDb.getWork('w-leaf')
  const parent = host.rt.coordDb.getWork('w-parent')
  assert.equal(leaf.status, 'failed', 'orphan leaf work with missing session settles as failed')
  assert.equal(leaf.error?.code, 'coordination/session_missing')
  assert.ok(parent !== undefined && !['done', 'failed', 'stopped'].includes(parent.status), 'woken parent work must NOT be killed')
  assert.equal(host.rt.waitsWork('w-parent'), false, 'parent wait list cleared')

  const calls = host.rt.coordDb.listCalls({ parentWorkId: 'w-parent' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].status, 'failed')

  await settle(() => host.agentOf('dm-b').calls.some(([kind]) => kind === 'followup'), 2000, 'parent owner receives visible wakeup')
  const deliveries = host.agentOf('dm-b').calls.filter(([kind]) => kind === 'followup')
  assert.equal(deliveries.length, 1, 'parent owner receives visible wakeup once')
  const msg = deliveries[0][1]
  assert.equal(msg.source.coordWorkId, 'w-parent')

  // Cycle-detection upstream graph is unblocked once orphan leaf settles.
  assert.equal(host.rt.upstreamOf(['w-leaf']).size, 0, 'upstreamOf unblocked for w-leaf')

  // Startup orphan handoff-results sweep prunes unreferenced result files.
  await settle(() => !existsSync(pinnedFile), 2000, 'unreferenced handoff-results file is pruned')
})

test('empty inflight: orphan leaf work with existing D2 completed log recovers cleanly instead of abandoning', async (t) => {
  const home = tempHome('ds-bot-orphan-ledger-')

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'dm-b' })
    db.createWork({
      workId: 'w-parent', workRef: 'W1', botId: 'b', kind: 'task',
      logicalAddress: 'task:w-parent', status: 'waiting', parentWorkId: 'fg:a', sessionId: 'dm-b',
    })
    db.createCall({
      callId: 'c_w-parent', parentWorkId: 'fg:a', childWorkId: 'w-parent',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
    })
    db.createWork({
      workId: 'w-nested', workRef: 'W7', botId: 'c', kind: 'task',
      logicalAddress: 'task:w-nested', status: 'idle', parentWorkId: 'w-parent', sessionId: 'dm-c',
    })
    db.createCall({
      callId: 'c_w-nested', parentWorkId: 'w-parent', childWorkId: 'w-nested',
      callerBotId: 'b', calleeBotId: 'c', returnAddress: 'task:w-parent',
      initialMessage: { dedupKey: 'req-w-nested', bodyPreview: 'Audit', payload: { text: 'Audit', role: 'request' } },
    })
    const cNested = db.claimReady({ workId: 'w-nested' })
    db.beginDeliveryAttempt({ workId: 'w-nested', claimToken: cNested.claimToken, throughSeq: cNested.claimedInboxSeq, idempotencyKey: 'dk-nested', sessionId: 'dm-c' })

    db.ensureForegroundWork({ botId: 'c', workId: 'fg:c', logicalAddress: 'foreground:c', sessionId: 'dm-c' })
    db.createWork({
      workId: 'w-top-answered', workRef: 'W8', botId: 'd', kind: 'task',
      logicalAddress: 'task:w-top-answered', status: 'idle', parentWorkId: 'fg:c', sessionId: 'dm-d',
    })
    db.createCall({
      callId: 'c_w-top-answered', parentWorkId: 'fg:c', childWorkId: 'w-top-answered',
      callerBotId: 'c', calleeBotId: 'd', returnAddress: 'foreground:c',
      initialMessage: { dedupKey: 'req-w-top', bodyPreview: 'Top check', payload: { text: 'Top check', role: 'request' } },
    })
    const cTop = db.claimReady({ workId: 'w-top-answered' })
    db.beginDeliveryAttempt({ workId: 'w-top-answered', claimToken: cTop.claimToken, throughSeq: cTop.claimedInboxSeq, idempotencyKey: 'dk-top', sessionId: 'dm-d' })
  })

  const logs = new Map([
    ['dm-c', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-nested', role: 'request' }, content: [{ type: 'text', text: 'Audit' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Verified audit report from Reviewer.' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['dm-d', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-top', role: 'request' }, content: [{ type: 'text', text: 'Top check' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Already completed top-level answer.' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host2 = startHost(t, { home, team: seedTeam(), logs })
  await host2.rt.adoptLiveWork()

  assert.equal(host2.rt.coordDb.getWork('w-nested').status, 'done', 'nested leaf closed via D2 log recovery')
  assert.equal(host2.rt.coordDb.getWork('w-top-answered').status, 'done', 'top-level answered leaf closed via D2 log recovery')
  assert.equal(host2.agentOf('dm-d').calls.length, 0, 'completed worker dm-d must not be re-run')

  // Parent work stays open and receives the genuine recovered reply text.
  const parent = host2.rt.coordDb.getWork('w-parent')
  assert.ok(parent !== undefined && !['done', 'failed', 'stopped'].includes(parent.status))
  assert.equal(host2.rt.coordDb.listCalls({ parentWorkId: 'w-parent' })[0].resultSummary, 'Verified audit report from Reviewer.')

  await settle(() => host2.agentOf('dm-b').calls.length === 1 && host2.agentOf('dm-c').calls.length === 1)
  const bMsg = host2.agentOf('dm-b').calls[0][1]
  const cMsg = host2.agentOf('dm-c').calls[0][1]
  assert.match(textOf(bMsg.content), /Verified audit report from Reviewer\./)
  assert.match(textOf(cMsg.content), /Already completed top-level answer\./)
  // Mark both delivered replies consumed so a subsequent restart has nothing left to deliver.
  host2.emit('dm-b', 'turn/start', { turn: 2 })
  host2.emit('dm-b', 'user/message', { content: bMsg.content, source: bMsg.source })
  host2.emit('dm-b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  host2.emit('dm-c', 'turn/start', { turn: 2 })
  host2.emit('dm-c', 'user/message', { content: cMsg.content, source: cMsg.source })
  host2.emit('dm-c', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await host2.ctx.dispose()

  // Subsequent restart must not duplicate already-settled works.
  const host3 = startHost(t, { home, team: seedTeam(), logs })
  await host3.rt.adoptLiveWork()
  assert.equal(host3.agentOf('dm-c').calls.length, 0)
  assert.equal(host3.agentOf('dm-d').calls.length, 0)
})

test('empty inflight: top-level orphan leaf and waiting_work background task handoff notify their callers visibly', async (t) => {
  const home = tempHome('ds-bot-orphan-bg-')
  const team = seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 'task-1', title: 'Audit', sessionId: 'a-task-1', status: 'waiting_work', createdAt: 100, updatedAt: 100 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
  })

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.createWork({
      workId: 'task:task-1', botId: 'a', kind: 'task', logicalAddress: 'task:task-1',
      status: 'waiting', parentWorkId: 'fg:a', sessionId: 'a-task-1',
    })
    // Top-level orphan work owned by b with missing session.
    db.createWork({
      workId: 'w-top', workRef: 'W9', botId: 'b', kind: 'task', logicalAddress: 'task:w-top',
      status: 'idle', parentWorkId: 'fg:a',
    })
    db.createCall({
      callId: 'c_w-top', parentWorkId: 'fg:a', childWorkId: 'w-top',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'req-w-top', bodyPreview: 'Top work', payload: { text: 'Top work', role: 'request' } },
    })
    const c1 = db.claimReady({ workId: 'w-top' })
    db.beginDeliveryAttempt({ workId: 'w-top', claimToken: c1.claimToken, throughSeq: c1.claimedInboxSeq, idempotencyKey: 'dk-w-top' })

    // Child orphan work owned by c whose parent is background task `task:task-1`.
    db.createWork({
      workId: 'w-bg', workRef: 'W15', botId: 'c', kind: 'task', logicalAddress: 'task:w-bg',
      status: 'idle', parentWorkId: 'task:task-1',
    })
    db.createCall({
      callId: 'c_w-bg', parentWorkId: 'task:task-1', childWorkId: 'w-bg',
      callerBotId: 'a', calleeBotId: 'c', returnAddress: 'task:task-1',
      initialMessage: { dedupKey: 'req-w-bg', bodyPreview: 'BG work', payload: { text: 'BG work', role: 'request' } },
    })
    const c2 = db.claimReady({ workId: 'w-bg' })
    db.beginDeliveryAttempt({ workId: 'w-bg', claimToken: c2.claimToken, throughSeq: c2.claimedInboxSeq, idempotencyKey: 'dk-w-bg' })
  })

  const host = startHost(t, { home, team })
  await host.rt.adoptLiveWork()
  await settle(() => host.agentOf('dm-a').calls.length > 0 && host.agentOf('a-task-1').calls.length > 0)

  assert.equal(host.rt.coordDb.getWork('w-top').status, 'failed')
  assert.equal(host.rt.coordDb.getWork('w-bg').status, 'failed')

  const fgMsg = host.agentOf('dm-a').calls.find(([kind]) => kind === 'followup')?.[1]
  assert.ok(fgMsg, 'foreground caller notified of orphaned top-level work')
  assert.equal(fgMsg.source.coordWorkId, 'fg:a')

  const taskMsg = host.agentOf('a-task-1').calls.find(([kind]) => kind === 'followup')?.[1]
  assert.ok(taskMsg, 'waiting background task session woken with failure notice')
  assert.equal(taskMsg.source.coordWorkId, 'task:task-1')
})

test('strict conservatism: never aborts paused, needs_verification, need_input, non-leaf, group room_work, live running, queued inbox, question, approval, or secret works', async (t) => {
  const home = tempHome('ds-bot-orphan-strict-')
  const team = seedTeam({
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
      d: { id: 'd', name: 'Helper', role: 'Ops', sessionId: 'dm-d', createdAt: 4 },
      e: { id: 'e', name: 'RunningBot', role: 'Run', sessionId: 'dm-e', createdAt: 5 },
      f: { id: 'f', name: 'InboxBot', role: 'Inbox', sessionId: 'dm-f', createdAt: 6 },
      g: { id: 'g', name: 'QuestionBot', role: 'Ask', sessionId: 'dm-g', createdAt: 7 },
      h: { id: 'h', name: 'ApprovalBot', role: 'Appr', sessionId: 'dm-h', createdAt: 8 },
      i: { id: 'i', name: 'SecretBot', role: 'Sec', sessionId: 'dm-i', createdAt: 9 },
    },
    rooms: { r1: { id: 'r1', name: 'DevRoom', members: ['a', 'b'], sessions: { a: 'r1-a', b: 'r1-b' }, createdAt: 1 } },
  })

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    // 1) paused
    db.createWork({ workId: 'w-paused', botId: 'c', kind: 'task', logicalAddress: 'task:w-paused', status: 'paused', sessionId: 'dm-c' })
    // 2) needs_verification
    db.createWork({ workId: 'w-verify', botId: 'c', kind: 'task', logicalAddress: 'task:w-verify', status: 'needs_verification', sessionId: 'dm-c' })
    // 3) need_input (open ask wait)
    db.createWork({ workId: 'w-need-input', botId: 'c', kind: 'task', logicalAddress: 'task:w-need-input', status: 'waiting', parentWorkId: 'fg:a', sessionId: 'dm-c' })
    db.addWait({ waitId: 'wt-ask-1', workId: 'w-need-input', kind: 'ask', targetId: 'ask:1', targetWorkId: 'fg:a' })
    // 4) non-leaf (waiting on open child call)
    db.createWork({ workId: 'w-non-leaf', botId: 'c', kind: 'task', logicalAddress: 'task:w-non-leaf', status: 'waiting', sessionId: 'dm-c' })
    db.createCall({ callId: 'c-non-leaf', parentWorkId: 'w-non-leaf', childWorkId: 'w-paused', callerBotId: 'c', calleeBotId: 'c', returnAddress: 'task:w-non-leaf' })
    // 5) group room_work with open child wait
    db.createWork({ workId: 'w-room', botId: 'b', kind: 'room_work', originKind: 'group', roomId: 'r1', logicalAddress: 'room:r1:b', status: 'waiting', sessionId: 'r1-b', meta: { kind: 'room_call' } })
    db.addWait({ waitId: 'wt-room-1', workId: 'w-room', kind: 'call', targetId: 'sub-room-call', targetWorkId: 'w-paused' })
    // 6) live running agent (D2 status: 'running')
    db.createWork({ workId: 'w-live-agent', botId: 'e', kind: 'task', logicalAddress: 'task:w-live-agent', status: 'idle', sessionId: 'dm-e' })
    db.receiveMessage({ workId: 'w-live-agent', kind: 'request', dedupKey: 'k-live', bodyPreview: 'run', payload: { text: 'run' } })
    const cLive = db.claimReady({ workId: 'w-live-agent' })
    db.beginDeliveryAttempt({ workId: 'w-live-agent', claimToken: cLive.claimToken, throughSeq: cLive.claimedInboxSeq, idempotencyKey: 'dk-live', sessionId: 'dm-e' })
    // 7) queued in DSH inbox (D2 status: 'queued')
    db.createWork({ workId: 'w-inbox', botId: 'f', kind: 'task', logicalAddress: 'task:w-inbox', status: 'idle', sessionId: 'dm-f' })
    db.receiveMessage({ workId: 'w-inbox', kind: 'request', dedupKey: 'k-inbox', bodyPreview: 'pending', payload: { text: 'pending' } })
    const cInbox = db.claimReady({ workId: 'w-inbox' })
    db.beginDeliveryAttempt({ workId: 'w-inbox', claimToken: cInbox.claimToken, throughSeq: cInbox.claimedInboxSeq, idempotencyKey: 'dk-inbox', sessionId: 'dm-f' })
    // 8) user_question wait
    db.createWork({ workId: 'w-question', botId: 'g', kind: 'task', logicalAddress: 'task:w-question', status: 'waiting', sessionId: 'dm-g' })
    db.addWait({ waitId: 'wt-q-1', workId: 'w-question', kind: 'user_question', targetId: 'question:dm-g' })
    // 9) approval wait
    db.createWork({ workId: 'w-approval', botId: 'h', kind: 'task', logicalAddress: 'task:w-approval', status: 'waiting', sessionId: 'dm-h' })
    db.addWait({ waitId: 'wt-a-1', workId: 'w-approval', kind: 'approval', targetId: 'approval:dm-h' })
    // 10) secret wait
    db.createWork({ workId: 'w-secret', botId: 'i', kind: 'task', logicalAddress: 'task:w-secret', status: 'waiting', sessionId: 'dm-i' })
    db.addWait({ waitId: 'wt-s-1', workId: 'w-secret', kind: 'secret', targetId: 'secret:s1' })
    // 11) genuinely orphaned interrupted work (missing session)
    db.createWork({ workId: 'w-true-orphan', workRef: 'W99', botId: 'd', kind: 'task', logicalAddress: 'task:w-true-orphan', status: 'idle', parentWorkId: 'fg:a' })
    db.createCall({
      callId: 'c-orphan', parentWorkId: 'fg:a', childWorkId: 'w-true-orphan',
      callerBotId: 'a', calleeBotId: 'd', returnAddress: 'foreground:a',
      initialMessage: { dedupKey: 'k-orphan', bodyPreview: 'orphan', payload: { text: 'orphan' } },
    })
    const cOrph = db.claimReady({ workId: 'w-true-orphan' })
    db.beginDeliveryAttempt({ workId: 'w-true-orphan', claimToken: cOrph.claimToken, throughSeq: cOrph.claimedInboxSeq, idempotencyKey: 'dk-orphan' })
  })

  const logs = new Map([
    ['dm-e', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-live', role: 'request' }, content: [{ type: 'text', text: 'run' }] } },
    ]],
  ])

  const host = startHost(t, {
    home,
    team,
    logs,
    agentSetup(id, agent) {
      if (id === 'dm-e') agent.status = 'running'
      if (id === 'dm-f') {
        agent.inbox.nextTurn.push({
          id: 'msg-inbox-1',
          source: { kind: SOURCE_KIND, idempotencyKey: 'dk-inbox', exchangeId: 'w-inbox', role: 'request' },
          content: [{ type: 'text', text: 'pending' }],
        })
      }
    },
  })
  // Pre-register live agents so D2 observes dm-e as running and dm-f as queued in inbox.
  host.agentOf('dm-e')
  host.agentOf('dm-f')

  await host.rt.adoptLiveWork()

  assert.equal(host.rt.coordDb.getWork('w-true-orphan').status, 'failed', 'genuinely orphaned leaf work is settled')
  for (const protectedId of [
    'w-paused', 'w-verify', 'w-need-input', 'w-non-leaf', 'w-room',
    'w-live-agent', 'w-inbox', 'w-question', 'w-approval', 'w-secret',
  ]) {
    const w = host.rt.coordDb.getWork(protectedId)
    assert.ok(w !== undefined && !['done', 'failed', 'stopped'].includes(w.status), `protected work ${protectedId} must remain non-terminal (got ${w?.status})`)
  }
})

test('non-empty inflight: legacy inflight.json migration protects live running work via D2 while settling lost orphan work', async (t) => {
  const home = tempHome('ds-bot-orphan-inflight-')
  const team = seedTeam({
    works: {
      'w-resumed': { from: 'a', to: 'b', toSession: 'dm-b', name: 'Writer', ref: 'W10', state: 'open', open: [], results: [], at: 1000 },
      'w-orphan': { from: 'd', to: 'c', name: 'Reviewer', ref: 'W11', state: 'open', open: [], results: [], at: 1001 },
    },
  })
  const inflight = {
    turns: {
      'dm-b': {
        botId: 'b',
        turn: 1,
        startedAt: 1000,
        trigger: { kind: SOURCE_KIND, exchangeId: 'w-resumed', from: 'a', role: 'request', workRef: 'W10' },
      },
    },
    queued: {},
    silent: {},
  }
  const logs = new Map([
    ['dm-b', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: '[Work #W10 from Chief]\nDo task' }], source: { kind: SOURCE_KIND, exchangeId: 'w-resumed', from: 'a', role: 'request', workRef: 'W10' } } },
    ]],
  ])

  const host = startHost(t, {
    home,
    team,
    inflight,
    logs,
    agentSetup(id, agent) {
      if (id === 'dm-b') agent.status = 'running'
    },
  })
  host.agentOf('dm-b')
  await host.rt.adoptLiveWork()

  // Legacy inflight.json migrated once and renamed to inflight.json.migrated.
  assert.equal(existsSync(join(home, 'inflight.json')), false, 'legacy inflight.json must be renamed after migration')
  assert.equal(existsSync(join(home, 'inflight.json.migrated')), true, 'backup inflight.json.migrated created')

  // Live running work on dm-b stays active (adopted, never aborted or re-dispatched).
  const resumed = host.rt.coordDb.getWork('fg:b')
  assert.equal(resumed.status, 'running', 'live running work stays adopted')
  assert.equal(host.agentOf('dm-b').calls.length, 0, 'live running turn must not be duplicated')

  // Unrelated unresolvable legacy work `w-orphan` (missing sessionId) settles as failed and wakes its caller (Helper).
  await settle(() => host.rt.coordDb.getWork('handoff:w-orphan')?.status === 'failed' && host.agentOf('dm-d').calls.length >= 1)
  const dCalls = host.agentOf('dm-d').calls.filter(([kind]) => kind === 'followup')
  assert.equal(dCalls.length, 1)
})

test('reconcileLostWorks protects living Bots across part switches while abandoning works whose target Bot or group was deleted', async (t) => {
  const home = tempHome('ds-bot-orphan-lost-')
  const team = seedTeam({
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      i: {
        id: 'i', name: 'SwitchBot', role: 'Switch', sessionId: 'dm-i-2',
        segments: [{ sessionId: 'dm-i-1', endedAt: 100 }],
        createdAt: 3,
      },
    },
  })

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.createWork({ workId: 'w-sw-state', workRef: 'W30', botId: 'i', kind: 'task', logicalAddress: 'task:w-sw-state', status: 'waiting', parentWorkId: 'fg:a', sessionId: 'dm-i-2' })
    db.createWork({ workId: 'w-gone-bot', workRef: 'W32', botId: 'deleted-helper', kind: 'task', logicalAddress: 'task:w-gone-bot', status: 'waiting', parentWorkId: 'fg:a' })
    db.createCall({ callId: 'c-gone-bot', parentWorkId: 'fg:a', childWorkId: 'w-gone-bot', callerBotId: 'a', calleeBotId: 'deleted-helper', returnAddress: 'foreground:a' })
    db.createWork({ workId: 'w-gone-room', workRef: 'W33', botId: 'a', kind: 'room_work', roomId: 'r-deleted', logicalAddress: 'room:r-deleted:a', status: 'waiting', parentWorkId: 'fg:a' })
  })

  const host = startHost(t, { home, team })
  await host.rt.adoptLiveWork()

  await settle(() => host.rt.coordDb.getWork('w-gone-bot')?.status === 'stopped'
    && host.rt.coordDb.getWork('w-gone-room')?.status === 'stopped')

  assert.equal(host.rt.coordDb.getWork('w-sw-state')?.status, 'waiting', 'living Bot work across part switch stays untouched')
  assert.equal(host.rt.coordDb.getWork('w-gone-bot')?.status, 'stopped', 'work targeting deleted Bot settles as stopped')
  assert.equal(host.rt.coordDb.getWork('w-gone-room')?.status, 'stopped', 'work targeting deleted group settles as stopped')
})

test('multi-child D2 recovery delivers EVERY child reply for the same parent, skips already-settled duplicates, and clears parent waits', async (t) => {
  const home = tempHome('ds-bot-orphan-multi-child-')

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.ensureForegroundWork({ botId: 'b', workId: 'fg:b', logicalAddress: 'foreground:b', sessionId: 'dm-b' })
    db.createWork({
      workId: 'w-parent', workRef: 'W1', botId: 'b', kind: 'task',
      logicalAddress: 'task:w-parent', status: 'waiting', parentWorkId: 'fg:a', sessionId: 'dm-b',
    })
    db.createCall({
      callId: 'c_w-parent', parentWorkId: 'fg:a', childWorkId: 'w-parent',
      callerBotId: 'a', calleeBotId: 'b', returnAddress: 'foreground:a',
    })

    for (const [id, ref, botId, sid, key] of [
      ['w-1', 'W2', 'c', 'dm-c', 'dk-w1'],
      ['w-2', 'W3', 'd', 'dm-d', 'dk-w2'],
      ['w-3-done', 'W4', 'c', 'dm-c-old', 'dk-w3'],
    ]) {
      db.createWork({ workId: id, workRef: ref, botId, kind: 'task', logicalAddress: `task:${id}`, status: 'idle', parentWorkId: 'w-parent', sessionId: sid })
      db.createCall({
        callId: `c_${id}`, parentWorkId: 'w-parent', childWorkId: id,
        callerBotId: 'b', calleeBotId: botId, returnAddress: 'task:w-parent',
        initialMessage: { dedupKey: `req-${id}`, bodyPreview: id, payload: { text: id, role: 'request' } },
      })
      const clm = db.claimReady({ workId: id })
      db.beginDeliveryAttempt({ workId: id, claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: key, sessionId: sid })
    }
    // w-3-done already settled and its inbox message was already read before crash!
    db.settleWork({ workId: 'w-3-done', outcome: 'done', force: true, summary: 'Already handled earlier.' })
    const parentInbox = db.listInbox('w-parent', { unreadOnly: true })
    if (parentInbox.length > 0) db.ackInbox('w-parent', parentInbox.at(-1).seq)
  })

  const logs = new Map([
    ['dm-c', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-w1', role: 'request' }, content: [{ type: 'text', text: 'w-1' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'First sibling answer.' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['dm-d', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-w2', role: 'request' }, content: [{ type: 'text', text: 'w-2' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Second sibling answer.' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host2 = startHost(t, { home, team: seedTeam(), logs })
  await host2.rt.adoptLiveWork()

  assert.equal(host2.rt.coordDb.getWork('w-1').status, 'done')
  assert.equal(host2.rt.coordDb.getWork('w-2').status, 'done')
  assert.equal(host2.rt.coordDb.getWork('w-3-done').status, 'done')
  assert.equal(host2.rt.waitsWork('w-parent'), false, 'parent waits clear cleanly once all sibling children settle')

  await settle(() => host2.agentOf('dm-b').calls.length >= 1)
  const bBody = host2.agentOf('dm-b').calls.map(([, msg]) => textOf(msg.content)).join('\n')
  assert.match(bBody, /First sibling answer\./, 'w-1 reply must be delivered')
  assert.match(bBody, /Second sibling answer\./, 'w-2 reply must be delivered')
  assert.doesNotMatch(bBody, /Already handled earlier\./, 'already-acknowledged w-3-done must not be duplicated')
})

test('top-level child work with D2 completed log wakes waiting_work background task session without spamming foreground', async (t) => {
  const home = tempHome('ds-bot-orphan-bg-ledger-')

  const team = seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 'task-1', title: 'Audit', sessionId: 'a-task-1', status: 'waiting_work', createdAt: 100, updatedAt: 100 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
  })

  seedCoord(home, (db) => {
    db.ensureForegroundWork({ botId: 'a', workId: 'fg:a', logicalAddress: 'foreground:a', sessionId: 'dm-a' })
    db.createWork({
      workId: 'task:task-1', botId: 'a', kind: 'task', logicalAddress: 'task:task-1',
      status: 'waiting', parentWorkId: 'fg:a', sessionId: 'a-task-1',
    })
    db.createWork({
      workId: 'w-bg-answered', workRef: 'W22', botId: 'c', kind: 'task', logicalAddress: 'task:w-bg-answered',
      status: 'idle', parentWorkId: 'task:task-1', sessionId: 'dm-c',
    })
    db.createCall({
      callId: 'c_w-bg-answered', parentWorkId: 'task:task-1', childWorkId: 'w-bg-answered',
      callerBotId: 'a', calleeBotId: 'c', returnAddress: 'task:task-1',
      initialMessage: { dedupKey: 'req-bg-ans', bodyPreview: 'Audit bg', payload: { text: 'Audit bg', role: 'request' } },
    })
    const clm = db.claimReady({ workId: 'w-bg-answered' })
    db.beginDeliveryAttempt({ workId: 'w-bg-answered', claimToken: clm.claimToken, throughSeq: clm.claimedInboxSeq, idempotencyKey: 'dk-bg-ans', sessionId: 'dm-c' })
  })

  const logs = new Map([
    ['dm-c', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: SOURCE_KIND, idempotencyKey: 'dk-bg-ans', role: 'request' }, content: [{ type: 'text', text: 'Audit bg' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Recovered background audit answer.' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])

  const host2 = startHost(t, { home, team, logs })
  await host2.rt.adoptLiveWork()

  assert.equal(host2.rt.coordDb.getWork('w-bg-answered').status, 'done', 'child work settled via D2 log recovery')
  await settle(() => host2.agentOf('a-task-1').calls.length === 1)
  const taskDeliveries = host2.agentOf('a-task-1').calls.filter(([kind]) => kind === 'followup')
  assert.equal(taskDeliveries.length, 1, 'waiting_work background task woken with recovered reply')
  assert.match(textOf(taskDeliveries[0][1].content), /Recovered background audit answer\./)
  assert.equal(host2.agentOf('dm-a').calls.length, 0, 'foreground chat is not spammed')
})
