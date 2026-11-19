import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installRequests } from '../src/host/requests.js'
import { BOT_ROUTING_KEEP, compactRouting } from '../src/host/bot-response-policy.js'

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
  const tool = (name, args, sessionId, callId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, callId })
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

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(first, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.equal(agents.get('b').calls.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('the same request id with other content is refused, and nothing goes out', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do another thing', request_id: 'r-1' }, 'a'), /request_id "r-1" was already used for a different request/)
  assert.equal(agents.get('b').calls.length, 1)
  // Another target under the same name is another request, and is refused as well.
  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-2' }, 'c')
  await assert.rejects(tool('message_bot', { to: 'Chief', message: 'do the thing', request_id: 'r-2' }, 'c'), /request_id "r-2" was already used for a different request/)
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
})

test('two callers with the same request id do not collide', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'from Chief', request_id: 'r-1' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'from Tester', request_id: 'r-1' }, 'c')
  assert.equal(agents.get('b').calls.length, 2)
})

test('two calls at once with the same request id admit it once', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const [first, second] = await Promise.all([
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
  ])
  assert.equal(first, second)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a repeat after a restart gives the receipt back and sends nothing', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  const out = await again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(out, receipt)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a task to a preset Bot without a category is refused with the categories it accepts', async (t) => {
  const seed = team()
  seed.bots.b.responsibility = { preset: 'reviewer', categories: ['review'] }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  assert.match(await tool('list_bots', { bot: 'Writer' }, 'a'), /Writer \(Write, accepts review\)/)
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'look at this' }, 'a'), /task-category-required.*Writer accepts: review/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)
  await tool('message_bot', { to: 'Writer', message: 'review this', task_category: 'review' }, 'a')
  assert.equal(agents.get('b').calls.length, 1)
})

test('a named request stays a replay after its routing event is compacted away', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const receipt = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const key = Object.keys(rt.state.botRouting.events)[0]
  // The turn ran: its routing record is terminal and therefore eligible for eviction.
  rt.state.botRouting.events[key] = 'taken'
  for (let i = 0; i < BOT_ROUTING_KEEP.events + 1; i += 1) rt.state.botRouting.events[`later-${i}`] = 'taken'
  assert.ok(compactRouting(rt.state) > 0)
  assert.equal(rt.state.botRouting.events[key], undefined, 'the admission record is gone')

  // The receipt is kept by the request table, not by the bounded routing table.
  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, receipt)
  assert.equal(agents.get('b').calls.length, 1, 'nothing was delivered again')
})

test('a repeat after the recipient read the message does not send it again', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const delivered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: delivered.content, source: delivered.source })
  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose delivery failed is not sent again', async (t) => {
  const home = tempHome()
  const { agentOf, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  const steer = writer.steer
  writer.steer = () => { throw new Error('dsh is down') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /dsh is down/)
  writer.steer = steer
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(writer.calls.length, 0)
})

test('a request with an id takes in the message before it, and a repeat merges nothing', async (t) => {
  const home = tempHome()
  const { agentOf, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  const first = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  const second = await tool('message_bot', { to: 'Writer', message: 'task 2', request_id: 'r-2' }, 'a')
  assert.match(second, /had not read your earlier message yet/)
  assert.equal(writer.inbox.nextStep.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(writer.inbox.nextStep.length, 1)
  assert.equal(writer.inbox.nextStep[0].source.exchangeId, writer.calls[0][1].source.exchangeId)
})

test('a request with an id that queues, or that answers the user, goes out once', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  // Writer is working, so a request that waits for its current work is queued.
  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a')
  assert.match(queued, /^Queued for Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a'), queued)

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a')
  assert.match(toUser, /It will answer the user in its own chat/)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a'), toUser)
  assert.equal(agents.get('b').calls.length, 2)
})

test('a request with an id in a group calls the member once', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const home = tempHome()
  const { rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  let posts = 0
  rt.callRoomBot = async () => { posts += 1 }
  const first = await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga')
  assert.match(first, /^Request for Writer recorded in "Ops"/)
  assert.equal(posts, 1)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga'), first)
  assert.equal(posts, 1)
})

test('a request that was in the air when DS Bot stopped is not sent again', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  // The delivery hangs, as it would when DS Bot stops in the middle of it.
  first.ctx.sessions.flush = async () => new Promise(() => {})
  const inFlight = first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  inFlight.catch(() => {})
  for (let count = 0; count < 200 && Object.keys(first.rt.state.requests).length === 0; count += 1) await delay(10)
  assert.equal(Object.keys(first.rt.state.requests).length, 1)
  assert.equal(Object.values(first.rt.state.requests)[0].outcome, 'pending')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a name whose receipt is no longer kept is not used again', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  // The receipt falls out of what is kept; the name itself stays taken.
  for (const record of Object.values(rt.state.requests)) record.receipt = undefined
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /Nothing was sent again: request_id "r-1" was admitted before/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose receipt cannot be saved is not sent', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const save = rt.save
  rt.save = async () => { throw new Error('the disk is full') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /the disk is full/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)
  // Nothing went out, so the name is free again.
  rt.save = save
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /^Delivered to Writer/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('calls without a request id are sent as they were', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'one' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'two' }, 'a')
  assert.equal(agents.get('b').calls.length, 2)
})

test('the receipt of a request is kept in the team file', async (t) => {
  const home = tempHome()
  const { tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const receipts = Object.values(saved.requests)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].outcome, 'delivered')
  assert.match(receipts[0].receipt, /^Delivered to Writer/)
})

for (const reason of ['stopped', 'lock lost']) {
  test(`a named request is not delivered when its state save is skipped: ${reason}`, async (t) => {
    const home = tempHome()
    const host = await boot(home, team())
    t.after(async () => { await host.stop(); cleanup(home) })
    const args = { to: 'Writer', message: 'do the thing', request_id: 'r-1' }
    let attempt
    let closing
    if (reason === 'stopped') {
      attempt = host.tool('message_bot', args, 'a')
      // The call has started but has not reached admission when its host closes.
      closing = host.stop()
    } else {
      writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: `${hostname()}-other`, token: 'other-writer', since: Date.now() }))
      attempt = host.tool('message_bot', args, 'a')
    }
    await assert.rejects(attempt, /cannot save|cannot be saved/i)
    await closing
    assert.equal(host.agentOf('b').calls.length, 0)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).requests ?? {}).length, 0)
  })
}

// Responding to Bots: a blocked message is not admitted, so its request_id stays free.
test('a blocked request starts nothing and leaves its request id free for after the policy changes', async (t) => {
  const seed = team()
  seed.bots.b.botResponse = { mode: 'selected', allow: [] }
  const home = tempHome()
  const { agents, rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /recipient-not-selected/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)

  // The user picks Chief; the same request now goes out, once, however often it repeats.
  await rt.updateBot('b', { botResponse: { mode: 'selected', allow: ['a'] } })
  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(first, /^Delivered to Writer/)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('under a chosen policy a repeated request still runs once, and a finding gets two attempts at most', async (t) => {
  const seed = team()
  seed.bots.b.botResponse = { mode: 'all' }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })
  const finding = { finding_pr: '12', finding_commit: 'abc1234', finding_id: 'F-1' }

  await tool('message_bot', { to: 'Writer', message: 'fix F-1', request_id: 'fix-1', ...finding }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'fix F-1', request_id: 'fix-1', ...finding }, 'a')
  assert.equal(agents.get('b').calls.length, 1, 'the duplicate event runs once')

  // The same finding with the same words is unchanged, not a new attempt.
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'fix F-1', request_id: 'fix-2', ...finding }, 'a'), /unchanged-finding/)
  await tool('message_bot', { to: 'Writer', message: 'fix F-1, the null check is still missing', request_id: 'fix-3', ...finding }, 'a')
  assert.equal(agents.get('b').calls.length, 2)
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'fix F-1 once more, differently', request_id: 'fix-4', ...finding }, 'a'), /finding-attempt-limit/)
  assert.equal(agents.get('b').calls.length, 2, 'a third attempt starts nothing')

  // Another finding, or the same one on a new commit, has attempts of its own.
  await tool('message_bot', { to: 'Writer', message: 'fix F-2', request_id: 'fix-5', ...finding, finding_id: 'F-2' }, 'a')
  assert.equal(agents.get('b').calls.length, 3)
})

test('two Bots that keep sending a finding back and forth stop after two attempts', async (t) => {
  const seed = team()
  seed.bots.a.botResponse = { mode: 'all' }
  seed.bots.b.botResponse = { mode: 'all' }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })
  const finding = { finding_pr: '7', finding_commit: 'deadbee', finding_id: 'R-9' }

  await tool('message_bot', { to: 'Writer', message: 'please fix R-9', ...finding }, 'a')
  await tool('message_bot', { to: 'Chief', message: 'fixed R-9, review again', ...finding }, 'b')
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'R-9 still fails, again', ...finding }, 'a'), /finding-attempt-limit/)
  assert.equal(agents.get('b').calls.length, 1)
  assert.equal(agents.get('a').calls.length, 1)
})

test('a Bot tool event with no request_id is deduplicated across a host restart', async (t) => {
  const home = tempHome()
  let host = await boot(home, team())
  t.after(async () => { await host.stop(); cleanup(home) })
  const ask = { to: 'Writer', message: 'Draft the missing section' }
  await host.tool('message_bot', ask, 'a', 'same-tool-call')
  const msg = host.agents.get('b').calls[0][1]
  host.emit('b', 'user/message', { source: msg.source, content: msg.content })
  await host.stop()

  host = await boot(home)
  await assert.rejects(host.tool('message_bot', ask, 'a', 'same-tool-call'), /Not sent:.*duplicate-event/)
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('the reviewer and coder review-fix loop stops across a restart and requires structured identity', async (t) => {
  const home = tempHome()
  const seed = team()
  Object.assign(seed.bots.a, { name: 'Reviewer', role: 'Code Reviewer' })
  Object.assign(seed.bots.b, { name: 'Coder', role: 'Coding Agent', botResponse: { mode: 'all' } })
  let host = await boot(home, seed)
  t.after(async () => { await host.stop(); cleanup(home) })
  const finding = { finding_pr: 'team/project#7', finding_commit: 'deadbee', finding_id: 'R-9' }
  const ask = { to: 'Coder', reply_to: 'user', action: 'review_fix' }
  await assert.rejects(host.tool('message_bot', { ...ask, message: 'Please apply the change' }, 'a'), /finding-identity-required/)
  await assert.rejects(host.tool('message_bot', { ...ask, action: 'task', message: 'Do what we discussed' }, 'a'), /finding-identity-required/)
  await host.tool('message_bot', { ...ask, ...finding, message: 'Please fix R-9' }, 'a')
  const msg = host.agentOf('b').calls[0][1]
  host.emit('b', 'user/message', { source: msg.source, content: msg.content })
  await host.stop()

  host = await boot(home)
  await assert.rejects(host.tool('message_bot', { ...ask, ...finding, message: 'Please fix R-9' }, 'a'), /unchanged-finding/)
  await host.tool('message_bot', { to: 'Reviewer', reply_to: 'user', ...finding, message: 'R-9 needs the null guard reviewed again' }, 'b')
  await assert.rejects(host.tool('message_bot', { ...ask, ...finding, message: 'R-9 needs another change' }, 'a'), /finding-attempt-limit/)
  assert.equal(host.agentOf('a').calls.length, 1)
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('a refused group message never returns a call receipt or queues the group relay', async (t) => {
  const home = tempHome()
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  seed.rooms.r1.botResponse = { mode: 'off' }
  const host = await boot(home, seed)
  t.after(async () => { await host.stop(); cleanup(home) })
  const ask = { to: 'Writer', message: '@Writer try a different approach', request_id: 'refused' }
  for (let i = 0; i < 2; i += 1) await assert.rejects(host.tool('message_bot', ask, 'ga'), /Not sent:.*group-off.*No turn was started/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('a reply at the hop limit is kept in the exchange without waking the asker', async (t) => {
  const home = tempHome()
  const { rt, agentOf, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })
  const parent = { task: 'draft', hops: 6 }
  await rt.deliver({ fromId: 'b', toId: 'a', role: 'reply', parent, exchangeId: 'reply:draft', text: 'Draft done' })
  assert.equal(agentOf('a').calls.length, 0)
  assert.equal(rt.exchangesOf('a', 'b').find(item => item.id === 'reply:draft')?.text, 'Draft done')
})

test('a result that asks for a review fix stays passive without a finding identity', async (t) => {
  const home = tempHome()
  const { rt, agentOf, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })
  const text = 'Please fix the review findings.'
  await rt.deliver({ fromId: 'b', toId: 'a', role: 'reply', exchangeId: 'review', text })
  assert.equal(agentOf('a').calls.length, 0)
  assert.equal(rt.exchangesOf('a', 'b').find(item => item.id === 'review')?.text, text)
})

test('restart recovery drops a queued request when the recipient policy changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = tempHome()
  let host = await boot(home, team())
  t.after(async () => { await host.stop(); cleanup(home) })
  await host.tool('message_bot', { to: 'Writer', message: 'Start the draft' }, 'a')
  await host.stop()
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  state.bots.b.botResponse = { mode: 'off' }
  host = await boot(home, state)
  t.mock.timers.tick(3000)
  for (let i = 0; i < 50 && host.rt.unreadOf('b').length !== 0; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.rt.unreadOf('b').length, 0)
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('responsibility settings preserve instructions until applied and restore custom values after reloading', async (t) => {
  const home = tempHome()
  const seed = team()
  seed.bots.b.instructions = 'Use the local review checklist.'
  let host = await boot(home, seed)
  t.after(async () => { await host.stop(); cleanup(home) })
  assert.equal(host.rt.botOf('b').instructions, seed.bots.b.instructions)
  assert.equal(host.rt.botOf('b').responsibility, undefined)
  const custom = { instructions: seed.bots.b.instructions, categories: ['review'] }
  await assert.rejects(host.rt.updateBot('b', { responsibility: { preset: 'coding', categories: ['coding'] } }, 'a'), /Only the user/)
  await host.rt.updateBot('b', { instructions: 'Make a small, tested change.', responsibility: { preset: 'coding', categories: ['coding'], custom } })
  assert.equal(host.rt.isMain('b'), false)
  assert.equal(host.rt.botOf('b').permission, undefined)
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'Read these papers', task_category: 'research' }, 'a'), /task-category-not-permitted/)
  await host.stop()

  host = await boot(home)
  assert.equal(host.rt.botOf('b').instructions, 'Make a small, tested change.')
  assert.deepEqual(host.rt.botOf('b').responsibility, { preset: 'coding', categories: ['coding'], custom })
  await host.rt.updateBot('b', { instructions: custom.instructions, responsibility: { preset: 'custom', categories: custom.categories, custom } })
  assert.equal(host.rt.botOf('b').instructions, seed.bots.b.instructions)
})

test('a pending inbox message cannot wake a Bot after its policy turns off', async (t) => {
  const home = tempHome()
  const { ctx, rt, tool, agentOf, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })
  await tool('message_bot', { to: 'Writer', message: 'Write the draft' }, 'a')
  const agent = agentOf('b')
  const message = agent.calls[0][1]
  await rt.updateBot('b', { botResponse: { mode: 'off' } })
  const listeners = ctx.listeners.get('agent/pre-step')
  const guard = listeners.find(listener => listener.toString().includes('automaticSource'))
  const enter = async () => ({ kind: 'enter', messages: [message] })
  assert.deepEqual(await guard({ agent, step: 1, messages: [message] }, enter), { kind: 'enter', messages: [] })
  const { routing, ...source } = message.source
  assert.ok(routing)
  assert.deepEqual(await guard({ agent, step: 1, messages: [{ ...message, source }] }, enter), { kind: 'enter', messages: [] })
  assert.equal(rt.unreadOf('b').length, 0)
})

test('a routing event already taken stays consumed after restart even without the session log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = tempHome()
  let host = await boot(home, team())
  t.after(async () => { await host.stop(); cleanup(home) })
  await host.tool('message_bot', { to: 'Writer', message: 'Finish the draft' }, 'a')
  const message = host.agentOf('b').calls[0][1]
  const step = () => host.ctx.listeners.get('agent/pre-step').find(listener => listener.toString().includes('automaticSource'))
  const enter = async () => ({ kind: 'enter', messages: [message] })
  assert.deepEqual(await step()({ agent: host.agentOf('b'), step: 1, messages: [message] }, enter), await enter())
  await host.stop()

  host = await boot(home)
  assert.deepEqual(await step()({ agent: host.agentOf('b'), step: 1, messages: [message] }, enter), { kind: 'enter', messages: [] })
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('b').calls.length, 0)
  assert.ok(host.rt.state.works[message.source.exchangeId])
})

test('legacy Bot profile updates cannot resume with the sender removed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = tempHome()
  const seed = team()
  seed.bots.b.botResponse = { mode: 'off' }
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: { b: {
    botId: 'b', trigger: { role: 'update', senderSessionId: 'a', exchangeId: 'profile-update' },
  } } }))
  const host = await boot(home, seed)
  t.after(async () => { await host.stop(); cleanup(home) })
  let attempted = false
  const deliver = host.rt.deliver
  host.rt.deliver = async (args) => { attempted = true; return deliver(args) }
  t.mock.timers.tick(3000)
  for (let i = 0; i < 50 && !attempted; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.ok(attempted)
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('restart checks the delivery identity without dropping a deferred continuation of the same exchange', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = tempHome()
  let host = await boot(home, team())
  t.after(async () => { await host.stop(); cleanup(home) })
  await host.tool('message_bot', { to: 'Writer', message: 'Finish the draft' }, 'a')
  const original = host.agentOf('b').calls[0][1]
  host.emit('b', 'user/message', { source: original.source, content: original.content })
  await host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Finish the draft',
    exchangeId: original.source.exchangeId, routing: original.source.routing, deferred: true })
  await host.stop()

  host = await boot(home)
  host.ctx.sessionController.inspect = async () => ({ events: [{ type: 'user/message', data: { source: original.source } }] })
  t.mock.timers.tick(3000)
  for (let i = 0; i < 100 && host.agentOf('b').calls.length === 0; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('b').calls.length, 1)
  const resumed = host.agentOf('b').calls[0][1]
  assert.equal(resumed.source.exchangeId, original.source.exchangeId)
  assert.equal(resumed.source.deferred, true)
  assert.notEqual(resumed.source.routing.key, original.source.routing.key)
})
