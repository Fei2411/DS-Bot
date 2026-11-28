import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installRequests } from '../src/host/requests.js'

let rt

test('old identities survive age and receipt volume without permitting another delivery', async () => {
  const rt = { state: {}, own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined, readOnly: () => undefined, save: async () => {}, warn() {} }
  installRequests(rt)
  const original = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'original', payload: { message: 'do it' } })
  await rt.admitRequest(original, async () => 'first receipt')
  rt.state.requests[original.key].at = 0
  for (let i = 0; i < 2001; i += 1) rt.state.requests[`other-${i}`] = { at: i, outcome: 'delivered', fingerprint: 'x', receipt: 'kept' }
  const fresh = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'fresh', payload: { message: 'next' } })
  await rt.admitRequest(fresh, async () => 'next receipt')
  const result = await rt.admitRequest(original, async () => { throw new Error('duplicate delivery') })
  assert.deepEqual(result, { status: 'replay', receipt: 'first receipt' })
})

// A two-Bot team, optionally with b in a group Session 'gb' of room 'Ops'.
function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// The plugin in a home of its own, with a stand-in DSH around it. The seed is written the
// first time; a later boot keeps the state the first run saved.
async function boot(home, seed) {
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
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
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose() }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, rt, agents, agentOf, emit, tool, stop }
}

// After a restart, a message its recipient never read is sent again on purpose (resume.js);
// what a repeated request adds is everything else.
const freshSends = agent => agent.calls.filter(([, message]) => !message?.content?.[0]?.text?.includes('restarted before it could reach you'))
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-request-'))
const cleanup = home => rmSync(home, { recursive: true, force: true, maxRetries: 5 })

test('a request with an id is delivered once, and a repeat gives the first receipt back', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(first, /^Delegated work #W\d+ to Writer\./)
  assert.equal(agents.get('b').calls.length, 1)

  const again = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('the same request id with other content is refused, and nothing goes out', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: 'do another thing', request_id: 'r-1' }, 'a'), /request_id "r-1" was already used for a different request/)
  assert.equal(agents.get('b').calls.length, 1)
  // Another target under the same name is another request, and is refused as well.
  await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-2' }, 'c')
  await assert.rejects(tool('delegate_work', { to: 'Chief', goal: 'do the thing', request_id: 'r-2' }, 'c'), /request_id "r-2" was already used for a different request/)
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
})

test('two callers with the same request id do not collide', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { rt, agents, emit, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  const fromChief = await tool('delegate_work', { to: 'Writer', goal: 'from Chief', request_id: 'r-1' }, 'a')
  const fromTester = await tool('delegate_work', { to: 'Writer', goal: 'from Tester', request_id: 'r-1' }, 'c')
  assert.match(fromChief, /^Delegated work #W1 to Writer/)
  assert.match(fromTester, /^Delegated work #W2 to Writer/)
  // Work #1 holds the 1:1 session claim on 'b'; work #2 waits in SQLite `ready`.
  assert.equal(agents.get('b').calls.length, 1)
  assert.equal(rt.coordDb.peekReady({ botId: 'b' }).length, 1)

  const firstMsg = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: firstMsg.content, source: firstMsg.source })
  emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'done 1' }] } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)
  assert.equal(agents.get('b').calls.length, 2)
})

test('two calls at once with the same request id admit it once', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const [first, second] = await Promise.all([
    tool('delegate_work', { to: 'Writer', goal: 'same request', request_id: 'r-1' }, 'a'),
    tool('delegate_work', { to: 'Writer', goal: 'same request', request_id: 'r-1' }, 'a'),
  ])
  assert.equal(first, second)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a repeat after a restart gives the receipt back and sends nothing', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  const out = await again.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(out, receipt)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a repeat after the recipient read the message does not send it again', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  const delivered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: delivered.content, source: delivered.source })
  const again = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose delivery failed is not sent again', async (t) => {
  const home = tempHome()
  const { agentOf, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  const { followup, steer } = writer
  writer.followup = () => { throw new Error('dsh is down') }
  writer.steer = () => { throw new Error('dsh is down') }
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a'), /dsh is down/)
  writer.followup = followup
  writer.steer = steer
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(writer.calls.length, 0)
})

test('separate request IDs get separate assignments; retrying one does not enqueue it again', async (t) => {
  const home = tempHome()
  const { rt, agentOf, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  writer.followup = (message) => { writer.calls.push(['followup', message]); writer.inbox.nextTurn.push(message) }

  const first = await tool('delegate_work', { to: 'Writer', goal: 'task 1', request_id: 'r-1', when: 'queue' }, 'a')
  const second = await tool('delegate_work', { to: 'Writer', goal: 'task 2', request_id: 'r-2', when: 'queue' }, 'a')
  assert.match(first, /#W1/)
  assert.match(second, /#W2/)
  assert.equal(writer.inbox.nextTurn.length, 1)
  assert.equal(rt.coordDb.peekReady({ botId: 'b' }).length, 1)

  const again = await tool('delegate_work', { to: 'Writer', goal: 'task 1', request_id: 'r-1', when: 'queue' }, 'a')
  assert.equal(again, first)
  assert.equal(writer.inbox.nextTurn.length, 1)
  assert.equal(rt.coordDb.peekReady({ botId: 'b' }).length, 1)
  assert.equal(writer.inbox.nextTurn[0].source.exchangeId, writer.calls[0][1].source.exchangeId)

  // Finishing task 1 drains task 2 from SQLite ready into nextTurn.
  const firstMsg = writer.inbox.nextTurn[0]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: firstMsg.content, source: firstMsg.source })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && writer.inbox.nextTurn.length < 2; count += 1) await delay(5)
  assert.equal(writer.inbox.nextTurn.length, 2)
  assert.equal(writer.inbox.nextTurn[0].source.exchangeId, writer.calls[0][1].source.exchangeId)
})

test('a request with an id that queues, or that answers the user, goes out once', async (t) => {
  const home = tempHome()
  const { rt, agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  // Writer runs queued work #W1 first; a second deliver_to 'user' request queues in SQLite `fg:b` until #W1 settles.
  const queued = await tool('delegate_work', { to: 'Writer', goal: 'later', when: 'queue', request_id: 'r-1' }, 'a')
  assert.match(queued, /^Queued work #W\d+ for Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.equal(await tool('delegate_work', { to: 'Writer', goal: 'later', when: 'queue', request_id: 'r-1' }, 'a'), queued)

  const toUser = await tool('delegate_work', { to: 'Writer', goal: 'tell them', deliver_to: 'user', request_id: 'r-2' }, 'a')
  assert.match(toUser, /It will answer the user in its own chat/)
  assert.equal(await tool('delegate_work', { to: 'Writer', goal: 'tell them', deliver_to: 'user', request_id: 'r-2' }, 'a'), toUser)
  assert.equal(rt.coordDb.listInbox('fg:b', { unreadOnly: true, includeNotes: false }).length, 1)

  const firstMsg = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: firstMsg.content, source: firstMsg.source })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)
  assert.equal(agents.get('b').calls.length, 2)
})

test('a request with an id in a group calls the member once', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const home = tempHome()
  const { rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  let posts = 0
  rt.postToRoom = async (_room, _sender, _body, post) => { assert.deepEqual(post.route.to, ['b']); posts += 1 }
  const first = await tool('delegate_work', { to: 'Writer', goal: 'do it', request_id: 'r-1' }, 'ga')
  assert.match(first, /^Called Writer in "Ops"/)
  assert.equal(posts, 1)
  assert.equal(await tool('delegate_work', { to: 'Writer', goal: 'do it', request_id: 'r-1' }, 'ga'), first)
  assert.equal(posts, 1)
})

test('a request that was in the air when DS Bot stopped is not sent again', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  // The delivery hangs, as it would when DS Bot stops in the middle of it.
  first.ctx.sessions.flush = async () => new Promise(() => {})
  const inFlight = first.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  inFlight.catch(() => {})
  const reqRows = () => (first.rt.coordDb.getWork('reqlog:a') ? first.rt.coordDb.listInbox('reqlog:a') : [])
  for (let count = 0; count < 200 && reqRows().length === 0; count += 1) await delay(10)
  assert.equal(reqRows().length, 1)
  assert.equal(reqRows()[0].payload.op, 'admit')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  // Wait for any startup adoption of the original in-flight SQLite work to settle, then verify the repeat sends nothing new.
  await delay(50)
  const beforeRepeat = freshSends(again.agentOf('b')).length
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(again.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(freshSends(again.agentOf('b')).length, beforeRepeat)
})

test('a name whose receipt is no longer kept is not used again', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  // The receipt falls out of what is kept; the name itself stays taken in reqlog:a.
  const rows = rt.coordDb.listInbox('reqlog:a')
  const settled = rows.find(row => row.payload?.op === 'settle')
  assert.ok(settled, 'delivered settle record exists in reqlog:a')
  rt.coordDb.receiveMessage({
    workId: 'reqlog:a',
    kind: 'note',
    dedupKey: `test-expire:${settled.payload.key}`,
    senderAddress: 'foreground:a',
    senderBotId: 'a',
    payload: {
      op: 'settle',
      key: settled.payload.key,
      fingerprint: settled.payload.fingerprint,
      outcome: 'delivered',
      at: Date.now(),
      epoch: (settled.payload.epoch ?? 1) + 1,
    },
    wake: false,
  })
  const out = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /Nothing was sent again: request_id "r-1" was admitted before/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose receipt cannot be saved is not sent', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const save = rt.save
  rt.save = async () => { throw new Error('the disk is full') }
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a'), /the disk is full/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)
  // Nothing went out, so the name is free again.
  rt.save = save
  const out = await tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /^Delegated work #W\d+ to Writer/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('calls without a request id are sent as they were', async (t) => {
  const home = tempHome()
  const { rt, agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('delegate_work', { to: 'Writer', goal: 'one' }, 'a')
  await tool('delegate_work', { to: 'Writer', goal: 'two' }, 'a')
  assert.equal(agents.get('b').calls.length, 1)
  assert.equal(rt.coordDb.peekReady({ botId: 'b' }).length, 1)
  const firstMsg = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: firstMsg.content, source: firstMsg.source })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)
  assert.equal(agents.get('b').calls.length, 2)
})

test('the receipt of a request is kept durably in coordination.sqlite', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a')
  const rows = first.rt.coordDb.listInbox('reqlog:a')
  const settled = rows.filter(row => row.payload?.op === 'settle')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].payload.outcome, 'delivered')
  assert.match(settled[0].payload.receipt, /^Delegated work #W\d+ to Writer/)
  await first.stop()

  const second = await boot(home)
  t.after(async () => { await second.stop(); cleanup(home) })
  assert.equal(await second.tool('delegate_work', { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }, 'a'), receipt)
})

for (const reason of ['stopped', 'lock lost']) {
  test(`a named request is not delivered when its state save is skipped: ${reason}`, async (t) => {
    const home = tempHome()
    const host = await boot(home, team())
    t.after(async () => { await host.stop(); cleanup(home) })
    const args = { to: 'Writer', goal: 'do the thing', request_id: 'r-1' }
    let attempt
    let closing
    if (reason === 'stopped') {
      attempt = host.tool('delegate_work', args, 'a')
      // The call has started but has not reached admission when its host closes.
      closing = host.stop()
    } else {
      writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: `${hostname()}-other`, token: 'other-writer', since: Date.now() }))
      attempt = host.tool('delegate_work', args, 'a')
    }
    await assert.rejects(attempt, /cannot save|cannot be saved/i)
    await closing
    assert.equal(host.agentOf('b').calls.length, 0)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).requests ?? {}).length, 0)
  })
}

test('a group waitsOnMember refusal does not poison request_id as uncertain', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  seed.rooms.r1.sessions.b = 'gb'
  const home = tempHome()
  const { rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })
  await rt.load()

  // Seed an open group call in SQLite `coordDb`: Chief ('a') is waiting on Writer ('b') in room 'r1'.
  rt.coordDb.createWork({
    workId: 'rw_caller_a',
    botId: 'a',
    kind: 'room_work',
    logicalAddress: 'room:r1:a',
    status: 'waiting',
    priority: 'interactive',
    roomId: 'r1',
    originKind: 'group',
  })
  rt.coordDb.createWork({
    workId: 'rw_callee_b',
    botId: 'b',
    kind: 'room_work',
    logicalAddress: 'room:r1:b',
    status: 'running',
    priority: 'interactive',
    parentWorkId: 'rw_caller_a',
    roomId: 'r1',
    originKind: 'group',
  })
  rt.coordDb.createCall({
    callId: 'c_group_1',
    parentWorkId: 'rw_caller_a',
    childWorkId: 'rw_callee_b',
    callerBotId: 'a',
    calleeBotId: 'b',
    returnAddress: 'room:r1:a',
    visibleScope: 'room',
    roomId: 'r1',
  })

  let posts = 0
  rt.postToRoom = async (_room, _sender, _body, post) => { assert.deepEqual(post.route.to, ['a']); posts += 1 }

  // While Chief ('a') is waiting on Writer ('b'), delegating back to Chief is refused BEFORE admitting request_id.
  await assert.rejects(
    tool('delegate_work', { to: 'Chief', goal: 'verify backup', request_id: 'verify-backup' }, 'gb'),
    /already waiting for your result/,
  )
  assert.equal(posts, 0)
  assert.equal(rt.coordDb.getWork('reqlog:b'), undefined, 'refused upstream wait must not persist an uncertain request_id')

  // Once the upstream wait ends, reusing the exact same request_id succeeds cleanly.
  rt.coordDb.settleWork({ workId: 'rw_callee_b', outcome: 'done', force: true, summary: 'done' })
  rt.coordDb.settleWork({ workId: 'rw_caller_a', outcome: 'done', force: true, summary: 'done' })
  const out = await tool('delegate_work', { to: 'Chief', goal: 'verify backup', request_id: 'verify-backup' }, 'gb')
  assert.match(out, /Called Chief in "Ops"/)
  assert.equal(posts, 1)
})
