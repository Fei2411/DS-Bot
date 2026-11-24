// Startup orphan leaf-work reconciliation: genuinely abandoned open leaf works
// left behind with empty or stale inflight.json are recovered from the pair
// ledger when already answered, otherwise settled visibly back to their caller/
// parent — while paused, need_input, non-leaf, child/room, active-task, live,
// switching, card-waiting, and queued works remain untouched.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { HEADER } from '../src/client/text.js'
import { fakeContext } from './fake-ctx.js'

const textOf = content => (Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : String(content ?? ''))

const flushMicrotasks = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
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
      session: { id, requestHeader: () => undefined },
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

  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  t.after(async () => {
    t.mock.timers.reset()
    await ctx.dispose()
    if (ownsHome) rmSync(home, { recursive: true, force: true })
  })
  return { home, ctx, rt, agents, agentOf, emit }
}

test('empty inflight: orphan leaf work settles visibly, wakes parent without killing parent, frees result files and upstreamOf', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-orphan-leaf-'))
  const resultsDir = join(home, 'handoff-results')
  mkdirSync(resultsDir, { recursive: true })
  const pinnedFile = join(resultsDir, 'w-sub-old.txt')
  writeFileSync(pinnedFile, 'x'.repeat(2500))

  const team = seedTeam({
    works: {
      'w-parent': {
        from: 'a', to: 'b', name: 'Writer', ref: 'W1', state: 'open',
        open: ['w-leaf'],
        results: [],
        at: 1000,
      },
      'w-leaf': {
        from: 'b', to: 'c', name: 'Reviewer', ref: 'W42', parent: 'w-parent', state: 'open',
        open: [],
        results: [{ id: 'w-sub-old', name: 'Helper', text: 'summary', file: 'w-sub-old.txt', at: 1001 }],
        at: 1002,
      },
    },
  })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = startHost(t, { home, team })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await host.rt.load()

  // Before RESUME_DELAY_MS, orphan reconciliation has not fired yet.
  t.mock.timers.tick(0)
  await flushMicrotasks()
  assert.ok(host.rt.state.works['w-leaf'] !== undefined, 'leaf work stays open before startup grace period')
  assert.deepEqual([...host.rt.upstreamOf(['w-leaf'])], ['b', 'a'], 'upstreamOf walks open work chain')

  // After RESUME_DELAY_MS, reconcileOrphanWorks settles the leaf and wakes the parent.
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host.rt.state.works['w-leaf'] === undefined && host.agentOf('dm-b').calls.length > 0) break
  }

  assert.equal(host.rt.state.works['w-leaf'], undefined, 'orphan leaf work is closed')
  assert.ok(host.rt.state.works['w-parent'] !== undefined, 'woken parent work must NOT be killed')
  assert.deepEqual(host.rt.state.works['w-parent'].open, [], 'parent wait list cleared')
  assert.equal(host.rt.state.works['w-parent'].results.length, 1)
  assert.equal(host.rt.state.works['w-parent'].results[0].abandoned, true)
  assert.equal(host.rt.state.works['w-parent'].results[0].abandonedReason, 'restart')
  assert.match(host.rt.state.works['w-parent'].results[0].text, /#W42.*restarted/)

  const deliveries = host.agentOf('dm-b').calls.filter(([kind]) => kind === 'followup')
  assert.equal(deliveries.length, 1, 'parent owner receives visible wakeup')
  const msg = deliveries[0][1]
  const body = textOf(msg.content)
  const firstLine = body.split('\n')[0]
  assert.ok(HEADER.test(firstLine), `restart delivery header must match client HEADER regex: ${firstLine}`)
  assert.match(firstLine, /^\[Work #W42 · Reviewer did not complete before restart · for the work Chief asked you for/)
  assert.match(body, /#W42.*restarted/)
  assert.equal(msg.source.work, 'w-parent')
  assert.equal(msg.source.replyTo, 'w-leaf')

  // Cycle-detection upstream graph is unblocked once orphan leaf closes.
  assert.equal(host.rt.upstreamOf(['w-leaf']).size, 0, 'upstreamOf unblocked for w-leaf')

  // Wait for async save to finish pruning the result file pinned by w-leaf.
  t.mock.timers.reset()
  await host.rt.save()
  await realDelay(30)
  assert.equal(existsSync(pinnedFile), false, 'handoff-results file pinned by orphan leaf work is pruned')
})

test('empty inflight: orphan leaf work with existing pair-ledger reply recovers cleanly instead of abandoning', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-orphan-ledger-'))

  // Host 1: write real pair-ledger delivered replies for both a nested and a top-level work.
  {
    const host1 = startHost(t, { home, team: seedTeam() })
    await host1.rt.load()
    await host1.rt.deliver({
      fromId: 'c', toId: 'b', role: 'reply', replyTo: 'w-nested',
      text: 'Verified audit report from Reviewer.',
    })
    await host1.rt.deliver({
      fromId: 'b', toId: 'a', role: 'reply', replyTo: 'w-top-answered',
      text: 'Already delivered top-level answer.',
    })
    await host1.rt.save()
    await host1.ctx.dispose()
  }

  // Simulate crash where state.json still holds both leaf works open and inflight.json is empty.
  const staleTeam = seedTeam({
    works: {
      'w-parent': { from: 'a', to: 'b', name: 'Writer', ref: 'W1', state: 'open', open: ['w-nested'], results: [], at: 1000 },
      'w-nested': { from: 'b', to: 'c', name: 'Reviewer', ref: 'W7', parent: 'w-parent', state: 'open', open: [], results: [], at: 1001 },
      'w-top-answered': { from: 'a', to: 'b', name: 'Writer', ref: 'W8', state: 'open', open: [], results: [], at: 1002 },
    },
  })
  rmSync(join(home, 'inflight.json'), { force: true })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host2 = startHost(t, { home, team: staleTeam })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await host2.rt.load()
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host2.rt.state.works['w-nested'] === undefined
      && host2.rt.state.works['w-top-answered'] === undefined
      && host2.agentOf('dm-b').calls.length > 0) break
  }

  assert.equal(host2.rt.state.works['w-nested'], undefined, 'nested leaf closed via ledger recovery')
  assert.equal(host2.rt.state.works['w-top-answered'], undefined, 'top-level answered leaf closed via ledger recovery')
  assert.equal(host2.rt.state.abandonedWorks?.['w-nested'], undefined, 'recovered work is NOT recorded as abandoned')
  assert.equal(host2.rt.state.abandonedWorks?.['w-top-answered'], undefined, 'recovered top-level work is NOT recorded as abandoned')

  // Parent work stays open and receives the genuine recovered reply text.
  assert.ok(host2.rt.state.works['w-parent'] !== undefined)
  assert.equal(host2.rt.state.works['w-parent'].results[0].text, 'Verified audit report from Reviewer.')
  assert.equal(host2.rt.state.works['w-parent'].results[0].abandoned, undefined)

  const bDeliveries = host2.agentOf('dm-b').calls.filter(([kind]) => kind === 'followup')
  assert.equal(bDeliveries.length, 1, 'parent owner woken with recovered reply')
  assert.match(textOf(bDeliveries[0][1].content), /Verified audit report from Reviewer\./)
  assert.equal(bDeliveries[0][1].source.work, 'w-parent')
  assert.equal(bDeliveries[0][1].source.replyTo, 'w-nested')

  // Top-level already-answered work does NOT emit a duplicate abandonment notice to Chief.
  assert.equal(host2.agentOf('dm-a').calls.length, 0)
  t.mock.timers.reset()
  await host2.rt.save()
})

test('empty inflight: top-level orphan leaf and waiting_work background task handoff notify their callers visibly', async (t) => {
  const team = seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 'task-1', title: 'Audit', sessionId: 'a-task-1', status: 'waiting_work', createdAt: 100, updatedAt: 100 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
    works: {
      'w-top': { from: 'a', to: 'b', name: 'Writer', ref: 'W9', state: 'open', open: [], results: [], at: 1000 },
      'w-bg': { from: 'a', fromPart: 'a-task-1', to: 'c', name: 'Reviewer', ref: 'W15', state: 'open', open: [], results: [], at: 1001 },
    },
  })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = startHost(t, { team })
  await host.rt.load()
  t.mock.timers.tick(0)
  await flushMicrotasks()
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host.rt.state.works['w-top'] === undefined
      && host.rt.state.works['w-bg'] === undefined
      && host.agentOf('dm-a').calls.length > 0
      && host.agentOf('a-task-1').calls.length > 0) break
  }

  assert.equal(host.rt.state.works['w-top'], undefined)
  assert.equal(host.rt.state.works['w-bg'], undefined)

  const fgMsg = host.agentOf('dm-a').calls.find(([kind]) => kind === 'followup')?.[1]
  assert.ok(fgMsg, 'foreground caller notified of orphaned top-level work')
  assert.match(textOf(fgMsg.content), /#W9.*restarted/)

  const taskMsg = host.agentOf('a-task-1').calls.find(([kind]) => kind === 'followup')?.[1]
  assert.ok(taskMsg, 'waiting background task session woken with restart notice')
  assert.match(textOf(taskMsg.content), /#W15.*restarted/)
})

test('strict conservatism: never aborts paused, need_input, non-leaf, child/room, active-task, live, switching, card-waiting, or queued works', async (t) => {
  const team = seedTeam({
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      b: {
        id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2,
        tasks: [
          { id: 'bt-handoff', title: 'Handoff', sessionId: 'b-t1', status: 'running', origin: 'bot-handoff', exchangeId: 'w-task-ex', createdAt: 10, updatedAt: 10 },
          { id: 'bt-work', title: 'SubWork', sessionId: 'b-t2', status: 'running', workId: 'w-task-wid', createdAt: 11, updatedAt: 11 },
        ],
      },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
      d: { id: 'd', name: 'Helper', role: 'Ops', sessionId: 'dm-d', createdAt: 4 },
      e: { id: 'e', name: 'RunningBot', role: 'Run', sessionId: 'dm-e', createdAt: 5 },
      f: { id: 'f', name: 'InboxBot', role: 'Inbox', sessionId: 'dm-f', createdAt: 6 },
      g: { id: 'g', name: 'QuestionBot', role: 'Ask', sessionId: 'dm-g', createdAt: 7 },
      h: { id: 'h', name: 'ViewBot', role: 'View', sessionId: 'dm-h', createdAt: 8 },
      i: { id: 'i', name: 'SwitchBot', role: 'Switch', sessionId: 'dm-i', createdAt: 9 },
    },
    rooms: { r1: { id: 'r1', name: 'DevRoom', members: ['a', 'b'], sessions: { a: 'r1-a', b: 'r1-b' }, createdAt: 1 } },
    roomReports: { rr1: { id: 'rr1', botId: 'a', roomId: 'r1', sub: 'w-room-report', parentWork: 'w-non-leaf', status: 'tracking' } },
    questions: { 'dm-g': { id: 'q1', prompt: 'Pick one' } },
    views: { 'dm-h': { id: 'v1', title: 'Form' } },
    switching: { 'dm-i': { at: 100 } },
    works: {
      'w-paused': { from: 'a', to: 'c', name: 'Reviewer', state: 'paused', open: [], results: [], at: 1 },
      'w-need-input': { from: 'a', to: 'c', name: 'Reviewer', state: 'need_input', open: [], results: [], at: 2 },
      'w-non-leaf': { from: 'a', to: 'c', name: 'Reviewer', state: 'open', open: ['w-paused'], results: [], at: 3 },
      'w-child': { from: 'a', to: 'c', child: 'sub-1', name: 'subagent', state: 'open', open: [], results: [], at: 4 },
      'w-room': { from: 'a', room: 'r1', name: 'DevRoom', state: 'open', open: [], results: [], at: 5 },
      'w-task-ex': { from: 'a', to: 'b', toTaskId: 'bt-handoff', name: 'Writer', state: 'open', open: [], results: [], at: 6 },
      'w-task-wid': { from: 'a', to: 'b', name: 'Writer', state: 'open', open: [], results: [], at: 7 },
      'w-room-report': { from: 'a', to: 'c', name: 'Reviewer', state: 'open', open: [], results: [], at: 8 },
      'w-live-agent': { from: 'a', to: 'e', name: 'RunningBot', state: 'open', open: [], results: [], at: 9 },
      'w-inbox': { from: 'a', to: 'f', name: 'InboxBot', state: 'open', open: [], results: [], at: 10 },
      'w-question': { from: 'a', to: 'g', name: 'QuestionBot', state: 'open', open: [], results: [], at: 11 },
      'w-view': { from: 'a', to: 'h', name: 'ViewBot', state: 'open', open: [], results: [], at: 12 },
      'w-switching': { from: 'a', to: 'i', name: 'SwitchBot', state: 'open', open: [], results: [], at: 13 },
      'w-true-orphan': { from: 'a', to: 'd', name: 'Helper', ref: 'W99', state: 'open', open: [], results: [], at: 14 },
    },
  })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = startHost(t, {
    team,
    agentSetup(id, agent) {
      if (id === 'dm-e' || id === 'b-t1' || id === 'b-t2') agent.status = 'running'
      if (id === 'dm-f') {
        agent.inbox.nextTurn.push({
          id: 'msg-inbox-1',
          source: { kind: SOURCE_KIND, exchangeId: 'w-inbox', role: 'request' },
          content: [{ type: 'text', text: 'pending' }],
        })
      }
    },
  })
  await host.rt.load()
  // Mark r1 as actively speaking so startup settleRoomReports keeps rr1 alive,
  // and simulate an active in-progress part switch on dm-i.
  host.rt.roomProgress.set('call-r1', { roomId: 'r1', from: 0, slots: [{ id: 'b', status: 'speaking' }] })
  const origIsSwitching = host.rt.isSwitchingPart
  host.rt.isSwitchingPart = sid => sid === 'dm-i' || origIsSwitching(sid)
  t.mock.timers.tick(0)
  await flushMicrotasks()
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host.rt.state.works['w-true-orphan'] === undefined) break
  }

  assert.equal(host.rt.state.works['w-true-orphan'], undefined, 'genuinely orphaned leaf work is settled')
  for (const protectedId of [
    'w-paused', 'w-need-input', 'w-non-leaf', 'w-child', 'w-room',
    'w-task-ex', 'w-task-wid', 'w-room-report', 'w-live-agent',
    'w-inbox', 'w-question', 'w-view', 'w-switching',
  ]) {
    assert.ok(host.rt.state.works[protectedId] !== undefined, `protected work ${protectedId} must remain untouched`)
  }
})

test('non-empty inflight: resumeAll protects resumed work while reconciling unrelated orphan leaf works', async (t) => {
  const team = seedTeam({
    works: {
      'w-resumed': { from: 'a', to: 'b', name: 'Writer', ref: 'W10', state: 'open', open: [], results: [], at: 1000 },
      'w-orphan': { from: 'a', to: 'c', name: 'Reviewer', ref: 'W11', state: 'open', open: [], results: [], at: 1001 },
    },
  })
  const inflight = {
    turns: {
      'dm-b': {
        botId: 'b',
        turnId: 'turn-1',
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

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = startHost(t, { team, inflight, logs })
  await host.rt.load()
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host.rt.state.works['w-orphan'] === undefined && host.agentOf('dm-b').calls.length > 0) break
  }

  assert.ok(host.rt.state.works['w-resumed'] !== undefined, 'resumed in-flight work stays open')
  assert.equal(host.rt.state.works['w-orphan'], undefined, 'unrelated orphan leaf work reconciled at end of resumeAll')
  const aCalls = host.agentOf('dm-a').calls.filter(([kind]) => kind === 'followup')
  assert.equal(aCalls.length, 1)
  assert.match(textOf(aCalls[0][1].content), /#W11.*restarted/)
})

test('post-pushThreadPart switching guard protects works when state.switching or switchJobs is keyed by earlier segment', async (t) => {
  const team = seedTeam({
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      d: { id: 'd', name: 'Helper', role: 'Ops', sessionId: 'dm-d', createdAt: 2 },
      i: {
        id: 'i', name: 'SwitchBot', role: 'Switch', sessionId: 'dm-i-2',
        segments: [{ sessionId: 'dm-i-1', endedAt: 100 }],
        createdAt: 3,
      },
      j: {
        id: 'j', name: 'JobSwitchBot', role: 'Switch', sessionId: 'dm-j-2',
        segments: [{ sessionId: 'dm-j-1', endedAt: 100 }],
        createdAt: 4,
      },
    },
    switching: {
      'dm-i-1': { botId: 'i' },
    },
    works: {
      'w-sw-state': { from: 'a', to: 'i', name: 'SwitchBot', ref: 'W30', state: 'open', open: [], results: [], at: 1000 },
      'w-sw-job': { from: 'a', to: 'j', name: 'JobSwitchBot', ref: 'W31', state: 'open', open: [], results: [], at: 1001 },
      'w-orphan-ctrl': { from: 'a', to: 'd', name: 'Helper', ref: 'W32', state: 'open', open: [], results: [], at: 1002 },
    },
  })

  const host = startHost(t, { team })
  await host.rt.load()
  const origSwitchJobs = host.rt.switchJobs
  host.rt.switchJobs = () => [...(origSwitchJobs?.() ?? []), { botId: 'j' }]

  const settled = await host.rt.reconcileOrphanWorks()
  assert.equal(settled, 1)
  assert.equal(host.rt.state.works['w-orphan-ctrl'], undefined, 'control orphan settles')
  assert.ok(host.rt.state.works['w-sw-state'] !== undefined, 'work protected by post-pushThreadPart state.switching[oldSid] = { botId }')
  assert.ok(host.rt.state.works['w-sw-job'] !== undefined, 'work protected by live switchJobs() { botId }')
})

test('multi-child ledger recovery delivers EVERY child reply for the same parent, skips live-turn duplicates, and clears parent.open', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-orphan-multi-child-'))

  // Host 1 records genuine pair-ledger replies for 3 sibling children of the same parent.
  {
    const host1 = startHost(t, { home, team: seedTeam() })
    await host1.rt.load()
    await host1.rt.deliver({ fromId: 'c', toId: 'b', role: 'reply', replyTo: 'w-1', text: 'First sibling answer.' })
    await host1.rt.deliver({ fromId: 'd', toId: 'b', role: 'reply', replyTo: 'w-2', text: 'Second sibling answer.' })
    await host1.rt.deliver({ fromId: 'c', toId: 'b', role: 'reply', replyTo: 'w-3-live', text: 'Already running live reply.' })
    await host1.rt.save()
    await host1.ctx.dispose()
  }

  const staleTeam = seedTeam({
    works: {
      'w-parent': { from: 'a', to: 'b', name: 'Writer', ref: 'W1', state: 'open', open: ['w-1', 'w-2', 'w-3-live'], results: [], at: 1000 },
      'w-1': { from: 'b', to: 'c', name: 'Reviewer', ref: 'W2', parent: 'w-parent', state: 'open', open: [], results: [], at: 1001 },
      'w-2': { from: 'b', to: 'd', name: 'Helper', ref: 'W3', parent: 'w-parent', state: 'open', open: [], results: [], at: 1002 },
      'w-3-live': { from: 'b', to: 'c', name: 'Reviewer', ref: 'W4', parent: 'w-parent', state: 'open', open: [], results: [], at: 1003 },
    },
  })
  rmSync(join(home, 'inflight.json'), { force: true })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host2 = startHost(t, { home, team: staleTeam })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await host2.rt.load()
  // Simulate dm-b currently running a turn that already holds w-3-live's reply.
  host2.rt.live.set('dm-b', {
    turn: 9,
    info: { kind: SOURCE_KIND, role: 'reply', replyTo: 'w-3-live', work: 'w-parent' },
  })

  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host2.rt.state.works['w-1'] === undefined
      && host2.rt.state.works['w-2'] === undefined
      && host2.rt.state.works['w-3-live'] === undefined
      && host2.agentOf('dm-b').calls.length >= 2) break
  }

  assert.equal(host2.rt.state.works['w-1'], undefined)
  assert.equal(host2.rt.state.works['w-2'], undefined)
  assert.equal(host2.rt.state.works['w-3-live'], undefined)
  assert.equal(host2.rt.state.abandonedWorks?.['w-1'], undefined)
  assert.equal(host2.rt.state.abandonedWorks?.['w-2'], undefined)

  // Both w-1 and w-2 MUST be delivered to dm-b (not skipped after w-1 queued for w-parent!),
  // while w-3-live MUST NOT be duplicated because dm-b's live turn already holds it.
  const bDeliveries = host2.agentOf('dm-b').calls.filter(([kind]) => kind === 'followup').map(([, msg]) => msg)
  const replyTos = bDeliveries.map(msg => msg.source?.replyTo).sort()
  assert.deepEqual(replyTos, ['w-1', 'w-2'])
  assert.ok(bDeliveries.every(msg => msg.source?.work === 'w-parent'))
  assert.ok(bDeliveries.some(msg => textOf(msg.content).includes('First sibling answer.')))
  assert.ok(bDeliveries.some(msg => textOf(msg.content).includes('Second sibling answer.')))

  // When dm-b's turn consumes the delivered replies (and the live w-3-live reply), parent.open clears cleanly.
  host2.emit('dm-b', 'turn/start', { turn: 10 })
  for (const msg of bDeliveries) host2.emit('dm-b', 'user/message', msg)
  host2.rt.takenWork('w-parent', 'w-3-live')
  assert.deepEqual(host2.rt.state.works['w-parent'].open, [], 'parent.open clears cleanly once sibling replies are consumed')

  t.mock.timers.reset()
  await host2.rt.save()
})

test('top-level orphan work with pair-ledger reply wakes waiting_work background task session', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-orphan-bg-ledger-'))

  // Host 1 records a real pair-ledger reply from Reviewer to Chief for w-bg-answered.
  {
    const host1 = startHost(t, { home, team: seedTeam() })
    await host1.rt.load()
    await host1.rt.deliver({
      fromId: 'c', toId: 'a', role: 'reply', replyTo: 'w-bg-answered',
      text: 'Recovered background audit answer.',
    })
    await host1.rt.save()
    await host1.ctx.dispose()
  }

  const staleTeam = seedTeam({
    bots: {
      a: {
        id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1,
        tasks: [{ id: 'task-1', title: 'Audit', sessionId: 'a-task-1', status: 'waiting_work', createdAt: 100, updatedAt: 100 }],
      },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
    works: {
      'w-bg-answered': { from: 'a', fromPart: 'a-task-1', to: 'c', name: 'Reviewer', ref: 'W22', state: 'open', open: [], results: [], at: 1000 },
    },
  })
  rmSync(join(home, 'inflight.json'), { force: true })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host2 = startHost(t, { home, team: staleTeam })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await host2.rt.load()
  t.mock.timers.tick(0)
  await flushMicrotasks()
  t.mock.timers.tick(3000)
  for (let i = 0; i < 40; i += 1) {
    await flushMicrotasks()
    if (host2.rt.state.works['w-bg-answered'] === undefined && host2.agentOf('a-task-1').calls.length > 0) break
  }

  assert.equal(host2.rt.state.works['w-bg-answered'], undefined, 'top-level task work closed via ledger recovery')
  assert.equal(host2.rt.state.abandonedWorks?.['w-bg-answered'], undefined, 'recovered task work is NOT marked abandoned')
  const taskDeliveries = host2.agentOf('a-task-1').calls.filter(([kind]) => kind === 'followup')
  assert.equal(taskDeliveries.length, 1, 'waiting_work background task woken with recovered reply')
  assert.equal(taskDeliveries[0][1].source?.replyTo, 'w-bg-answered')
  assert.match(textOf(taskDeliveries[0][1].content), /Recovered background audit answer\./)
  assert.equal(host2.agentOf('dm-a').calls.length, 0, 'foreground chat is not spammed')

  t.mock.timers.reset()
  await host2.rt.save()
})
