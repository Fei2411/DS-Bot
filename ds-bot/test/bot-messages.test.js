import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installParts } from '../src/host/parts.js'
import { MAX_HOPS, MAX_UNATTENDED_MESSAGES, REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'

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
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): resolveAgent returns a per-Session agent that
// records followup/steer/inject/cancel calls.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-messages-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
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
        inbox: { nextStep: [], nextTurn: [], remove() {} },
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  // Runs every registered waterfall listener; `next` settles the chain.
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, fire, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

test('message_bot steers by default; on an idle Bot it opens the next turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  // Idle: the message goes to the Bot's own chat and starts its next turn.
  const idle = await tool('message_bot', { to: 'Writer', message: 'how are you' }, 'a')
  assert.equal(idle, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /^\[Message from Chief\]/)
  assert.equal(agents.get('b').calls[0][1].source.role, 'request')

  // Running: the message cuts into that turn instead of queuing.
  emit('b', 'turn/start', { turn: 1 })
  const busy = await tool('message_bot', { to: 'Writer', message: 'watch out' }, 'a')
  assert.equal(busy, 'Delivered to Writer while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'steer'])
})

test('message_bot when "queue" waits for the current work, and reply_to "user" always queues', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue' }, 'a')
  assert.equal(queued, 'Queued for Writer: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', when: 'now' }, 'a')
  assert.equal(toUser, 'Delivered to Writer. It will answer the user in its own chat; nothing comes back to you, so point the user to Writer\'s chat instead of relaying.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.equal(agents.get('b').calls[1][1].source.audience, 'user')
})

test('a Bot busy in a group gets the message in its own chat, and the sender is told', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const { agents, emit, tool, stop } = await start(seed)
  t.after(stop)

  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('message_bot', { to: 'Writer', message: 'status?' }, 'a')
  assert.equal(out, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it. Writer is also working in group "Ops"; your message does not reach that work. If it must not go on there, use stop_bot.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.equal(agents.get('gb'), undefined)

  // A non-Main sender gets no stop_bot hint.
  emit('ga', 'turn/start', { turn: 1 })
  const back = await tool('message_bot', { to: 'Chief', message: 'done' }, 'b')
  assert.equal(back, 'Delivered to Chief. Its reply will arrive later as a new message; do not wait for it. Chief is also working in group "Ops"; your message does not reach that work.')
})

test('a request steered into a running turn is recorded once and answered in a turn of its own', async (t) => {
  const { agents, emit, tool, exchanges, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await tool('message_bot', { to: 'Writer', message: 'which year is the data?' }, 'a')
  const steered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter, for the user'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)

  // Nothing from the user's turn goes to Chief; the request comes back to Writer.
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
  const [kind, again] = agents.get('b').calls[1]
  assert.equal(kind, 'followup')
  assert.equal(textOf(again.content), '[Message from Chief · you read it during your last task; answer it now]\nwhich year is the data?')
  assert.equal(again.source.deferred, true)
  assert.equal(again.source.exchangeId, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request'])

  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: again.content, source: again.source })
  emit('b', 'assistant/message', assistantText('2025'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && (agents.get('a')?.calls ?? []).length < 1; count += 1) await delay(5)
  const reply = agents.get('a').calls[0][1]
  assert.equal(textOf(reply.content), '[Reply from Writer]\n2025')
  assert.equal(reply.source.replyTo, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request', 'reply'])
})

test('message_bot names the messages a Bot has not read yet, and stops sending to a stuck Bot', async (t) => {
  const { ctx, agentOf, emit, tool, exchanges, stop } = await start(team())
  t.after(stop)
  // Writer's turn waits on something and never reaches its next step.
  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  const first = await tool('message_bot', { to: 'Writer', message: 'task 1' }, 'a')
  assert.equal(first, 'Delivered to Writer while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.')
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 2' }, 'a'), /Writer has not read an earlier message from Bots yet\.$/)
  for (let index = 3; index <= 10; index += 1) await tool('message_bot', { to: 'Writer', message: `task ${index}` }, 'a')
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 10b' }, 'a').catch(error => error.message), /^Not sent: Writer has not read the last 10 messages from Bots yet/)
  assert.equal(writer.calls.length, 10)
  assert.equal((await exchanges()).length, 10)

  // Once a step takes them up, messages go through again.
  writer.inbox.nextStep.length = 0
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 11' }, 'a'), /^Delivered to Writer while it is working/)

  // An approval the Bot waits for holds its messages too.
  writer.inbox.nextStep.length = 0
  for (const listener of ctx.listeners.get('approval/request')) void listener({ agent: { session: { id: 'b' } }, toolName: 'bash', reason: 'rm' }, () => new Promise(() => {}))
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 12' }, 'a'), /Writer is waiting for the user's approval, so it reads your message only after the user answers\.$/)
})

test('a non-Main Bot can steer a message to a Main Bot', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)

  const out = await tool('message_bot', { to: 'Chief', message: 'heads up' }, 'b')
  assert.equal(out, 'Delivered to Chief. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('a').calls.map(([kind]) => kind), ['steer'])
  assert.equal(agents.get('a').calls[0][1].source.senderSessionId, 'b')
})

test('stop_bot cancels the running turns and tells the Bot why in a new turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), /not running/)
  assert.deepEqual(agents.get('b')?.calls ?? [], [])

  emit('b', 'turn/start', { turn: 1 })
  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('stop_bot', { bot: 'Writer', reason: 'that command deletes data' }, 'a')
  assert.match(out, /Stopped Writer in its own chat and group "Ops"/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['cancel', 'followup'])
  assert.deepEqual(agents.get('b').calls[0][1], { kind: 'hook', reason: 'ds-bot/stopped' })
  assert.deepEqual(agents.get('gb').calls.map(([kind]) => kind), ['cancel'])
  const notice = agents.get('b').calls[1][1]
  assert.match(textOf(notice.content), /^\[Stopped by Chief\]\nthat command deletes data$/)
  assert.equal(notice.source.role, 'stopped')
})

test('stop_bot belongs to a Main Bot', async (t) => {
  const { tool, stop } = await start(team())
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'b'), { message: 'Only a Main Bot can stop other Bots.' })
  await assert.rejects(tool('stop_bot', { bot: 'Chief' }, 'a'), { message: 'You cannot stop yourself.' })
  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), { message: 'Writer is not running right now, so there is nothing to stop. Use message_bot to reach it.' })
})

function turnsHost() {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    dropKickoff() {},
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered }
}

const replySource = (role, extra = {}) => ({ kind: SOURCE_KIND, role, senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 0, ...extra })
const textBlock = (content) => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })

test('a stopped notice routes the acknowledgement back like a request', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Stopped by Chief]\nwhy'), source: replySource('stopped', { exchangeId: 's1' }) })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  emit('b', 'assistant/message', assistantText('understood'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 's1')
  assert.equal(delivered[0].text, 'understood')
})

// What the turn hands back for a joined request: the request itself, to answer next.
const deferredOf = job => [job.fromId, job.toId, job.sessionId, job.role, job.exchangeId, job.hop, job.deferred, job.text]

test('a request that joins a user-started turn is handed back, not answered with the turn\'s text', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1', hop: 2 }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(deferredOf), [['a', 'b', 'b', 'request', 'e1', 2, true, 'make it shorter']])
  assert.deepEqual(rt.state.exchangeTurns, {})

  // The handed-back request opens a hidden turn whose text is the reply.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief · you read it during your last task; answer it now]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1', hop: 2, deferred: true }) })
  emit('b', 'assistant/message', assistantText('done, it is shorter'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.slice(1).map(job => [job.toId, job.role, job.replyTo, job.hop, job.text]), [['a', 'reply', 'e1', 2, 'done, it is shorter']])
  assert.deepEqual(rt.state.exchangeTurns, { b: [2] })
})

test('a request that joins a Bot-triggered turn is handed back; the trigger gets the whole turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  assert.deepEqual(delivered.map(job => [job.role, job.replyTo ?? job.exchangeId, job.text]), [['reply', 'e0', 'first half\n\nsecond half'], ['request', 'e1', 'more']])
})

test('a joined request in a stopped turn tells its sender, and is not handed back', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /was stopped before it could answer/)
})

test('a joined request gets the failure notice when the model call fails', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
})

test('a joined request never claims the next turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('next task'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('for the user'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.deferred]), [['request', 'e1', true]])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a schedule-started turn stays visible when a request joins', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('routine'), source: { kind: 'schedule' } })
  emit('b', 'assistant/message', assistantText('before'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('after'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.text]), [['request', 'e1', 'more']])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a duplicate exchangeId joins no second reply', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e0')
})

test('a joined request crosses a part switch and is handed back in the new part', async (t) => {
  const { agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  // The model call hits the window: the turn stops and the part moves on.
  await fire('agent/request-error', { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000), agent: agentOf('b') })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
  // Neither the trigger nor the joined request answers from the old part.
  for (let count = 0; count < 200 && agents.get('s1')?.calls.find(([, message]) => message.source?.handoff === true) === undefined; count += 1) await delay(5)
  const handoff = agents.get('s1').calls.find(([, message]) => message.source?.handoff === true)[1]
  assert.equal((agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply').length, 0)
  assert.equal(handoff.source.exchangeId, 'e0')
  assert.deepEqual(handoff.source.joined.map(item => [item.info.exchangeId, item.text]), [['e1', 'more']])

  // The resumed turn answers its trigger and hands the joined request back there.
  emit('s1', 'turn/start', { turn: 1 })
  emit('s1', 'user/message', { content: textBlock('[Handoff]\npackage'), source: handoff.source })
  emit('s1', 'assistant/message', assistantText('done'))
  emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const handedBack = () => agents.get('s1').calls.find(([, message]) => message.source?.deferred === true)
  for (let count = 0; count < 200 && ((agents.get('a')?.calls ?? []).length < 1 || handedBack() === undefined); count += 1) await delay(5)
  const replies = (agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply')
  assert.deepEqual(replies.map(([, message]) => message.source.replyTo), ['e0'])
  assert.equal(textOf(replies[0][1].content), '[Reply from Writer]\ndone')
  assert.equal(handedBack()[0], 'followup')
  assert.equal(handedBack()[1].source.exchangeId, 'e1')
  assert.equal(textOf(handedBack()[1].content), '[Message from Chief · you read it during your last task; answer it now]\nmore')
})

test('a message goes one hop past the highest of the turn\'s trigger and joined requests', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0', hop: 1 }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1', hop: 4 }) })
  await tool('message_bot', { to: 'Chief', message: 'onward' }, 'b')
  assert.equal(agents.get('a').calls[0][1].source.hop, 5)
})

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const take = (id) => {
    const [, message] = agents.get(id).calls.at(-1)
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, end, userTurn }
}
const allCalls = agents => [...agents.values()].reduce((sum, agent) => sum + agent.calls.length, 0)

test('every forwarded message counts a hop, and the one past MAX_HOPS is not sent', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const { agents, emit, tool, stop } = await start(seed)
  t.after(stop)
  const { take, end, userTurn } = turnTaker(agents, emit)
  const ring = [['a', 'Writer', 'b'], ['b', 'Tester', 'c'], ['c', 'Chief', 'a']]

  userTurn('a', 'ask Writer to pass it on')
  const hops = []
  let refused
  for (let step = 0; step < MAX_HOPS + 3 && refused === undefined; step += 1) {
    const [from, to, toId] = ring[step % ring.length]
    if (step > 0) take(from)
    const before = allCalls(agents)
    const out = await tool('message_bot', { to, message: 'pass it on' }, from)
    end(from)
    if (out.startsWith('Delivered')) hops.push(agents.get(toId).calls.at(-1)[1].source.hop)
    else {
      refused = out
      assert.equal(allCalls(agents), before)
    }
  }
  assert.deepEqual(hops, Array.from({ length: MAX_HOPS }, (_, index) => index + 1))
  assert.equal(refused, 'This chain of Bot messages is already long. Stop here and report to the user instead.')
})

test('a back-and-forth between two Bots ends at MAX_HOPS', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)
  const { take, end, userTurn } = turnTaker(agents, emit)
  const replies = () => (agents.get('a')?.calls ?? []).length

  userTurn('a', 'work it out with Writer')
  const asked = []
  for (let round = 0; round < MAX_HOPS + 3; round += 1) {
    const out = await tool('message_bot', { to: 'Writer', message: 'and now?' }, 'a')
    end('a')
    if (!out.startsWith('Delivered')) break
    asked.push(take('b').source.hop)
    const before = replies()
    end('b', 'here is my part')
    for (let count = 0; count < 200 && replies() === before; count += 1) await delay(5)
    const reply = take('a')
    assert.equal(reply.source.role, 'reply')
  }
  assert.deepEqual(asked, Array.from({ length: MAX_HOPS }, (_, index) => index + 1))
})

const spentBudget = { message: new RegExp(`^Not sent: the team has sent ${MAX_UNATTENDED_MESSAGES} Bot messages since the user last wrote`) }

test('the team sends no more Bot messages past the unattended limit, counting group posts', async (t) => {
  const { agents, tool, stop } = await start(team({ group: true }))
  t.after(stop)
  const send = () => tool('message_bot', { to: 'Writer', message: 'ping' }, 'a')

  for (let count = 1; count < MAX_UNATTENDED_MESSAGES; count += 1) await send()
  assert.match(await tool('post_to_group', { group: 'Ops', message: 'note' }, 'a'), /^Posted in "Ops"/)
  await assert.rejects(send(), spentBudget)
  await assert.rejects(tool('post_to_group', { group: 'Ops', message: 'again' }, 'a'), spentBudget)
  assert.equal(agents.get('b').calls.length, MAX_UNATTENDED_MESSAGES - 1)
  assert.equal(agents.get('r1').calls.length, 1)
})

test('the user, a question card\'s answer and a scheduled task each reset the unattended count; a goal does not', async (t) => {
  const { emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)
  const send = () => tool('message_bot', { to: 'Writer', message: 'ping' }, 'a')
  const spend = async (count) => {
    for (let sent = 0; sent < count; sent += 1) await send()
    await assert.rejects(send(), spentBudget)
  }
  const arrive = (id, source) => emit(id, 'user/message', { content: textBlock('next'), source })

  await spend(MAX_UNATTENDED_MESSAGES)
  arrive('b', { kind: 'goal' })
  await assert.rejects(send(), spentBudget)

  arrive('r1', { kind: 'user' })
  await spend(MAX_UNATTENDED_MESSAGES)
  arrive('a', { kind: REPLY_KIND })
  await spend(MAX_UNATTENDED_MESSAGES)
  arrive('b', { kind: 'schedule' })
  await spend(MAX_UNATTENDED_MESSAGES)
  arrive('a', { kind: 'user' })
  assert.match(await send(), /^Delivered to Writer/)
})

test('an earlier part keeps the request its Bot answered', async () => {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2', segments: [{ sessionId: 'b1', endedAt: 2 }] }
  const events = [
    { type: 'user/message', seq: 1, time: 10, data: { turn: 1, content: [{ type: 'text', text: '[Message from Chief]\nDo not delete that' }], source: replySource('request') } },
    { type: 'assistant/message', seq: 2, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'Understood, I stopped.' }] } } },
  ]
  const rt = {
    ctx: { on() {}, effect() {}, get() {}, sessionController: { page: async () => ({ records: events.map(event => ({ event })), hasMore: false }) } },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map([['b1', { botId: 'b' }]]),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
    resolveAgent: async id => ({ session: { id, seq: 3 } }),
  }
  installParts(rt)
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.role ?? item.text]), [['event', 'request'], ['bot', 'Understood, I stopped.']])
  assert.equal(items[0].botId, 'a')
})

test('a request the model keeps turning down moves the Bot on, without its latest messages the second time; a connection failure does not', async (t) => {
  const { ctx, agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)
  let made = 0
  ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
  // Per Session, the events DS Bot reads back; only the previous turn's end matters.
  const ends = new Map()
  const endedWith = (id, code) => ends.set(id, { 9: { type: 'turn/end', data: { reason: { kind: 'error', error: { code } } } } })
  const failTurn = async (id, code) => {
    const agent = agentOf(id)
    agent.session.seq = 10
    agent.session.eventAt = seq => ends.get(id)?.[seq]
    emit(id, 'turn/start', { turn: 1 })
    emit(id, 'user/message', { content: textBlock('look at this'), source: { kind: 'user' } })
    await fire('agent/request-error', { failure: { code }, signal: AbortSignal.timeout(60_000), agent })
    emit(id, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code } } })
  }
  const handoffIn = id => agents.get(id)?.calls.find(([, message]) => message.source?.handoff === true)?.[1]
  const waitFor = async (check) => {
    for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
    assert.ok(check())
  }

  await failTurn('b', 'TRANSPORT')
  // One turned-down request may be the provider's own hiccup.
  await failTurn('b', 'INVALID_REQUEST')
  await delay(30)
  assert.equal(made, 0)

  endedWith('b', 'INVALID_REQUEST')
  await failTurn('b', 'INVALID_REQUEST')
  await waitFor(() => handoffIn('s1') !== undefined)
  const first = textOf(handoffIn('s1').content)
  assert.match(first, /because a request in the previous part kept failing \(INVALID_REQUEST\)/)
  assert.match(first, /first tell the user in one short sentence that the last message could not be sent as it was/)

  endedWith('s1', 'INVALID_REQUEST')
  await failTurn('s1', 'INVALID_REQUEST')
  await waitFor(() => handoffIn('s2') !== undefined)
  const second = textOf(handoffIn('s2').content)
  assert.match(second, /so they are left out this time\. First tell the user/)
  assert.match(second, /## Latest messages[^#]*\(none\)/)

  // A part that already left the messages out stays where it is.
  endedWith('s2', 'INVALID_REQUEST')
  await failTurn('s2', 'INVALID_REQUEST')
  await delay(30)
  assert.equal(made, 2)
})
