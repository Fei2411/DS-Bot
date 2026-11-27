import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound, loopTurn, waitForRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { LONG_HEAD, MESSAGE_INLINE_MAX, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { promisesWork } from '../src/host/turns.js'

let rt

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}, bots = {}, top = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ...bots.a },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ...bots.b },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, ...bots.c },
    ...(bots.d ? { d: { id: 'd', name: 'Reviewer', role: 'Review', sessionId: 'd', createdAt: 4, ...bots.d } } : {}),
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  ...top,
})

async function start(t, room, services, extraRooms, bots, llm, top, files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms, bots, top)))
  for (const [name, value] of Object.entries(files)) writeFileSync(join(home, name), JSON.stringify(value))
  const selected = []
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: llm ?? { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async (request) => { selected.push(request) } },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const emitScoped = (parentId, name, info) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, info)
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message, sessionId = 'r1') => {
    emit(sessionId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    const done = tool('group_relay', {}, sessionId, { callId, signal: stop.signal })
      .then(async (value) => (result = await afterRound(rt, sessionId, value)))
    done.catch(() => {})
    const read = () => result
    read.done = done
    read.wait = ms => waitForRound(done, ms)
    read.cancel = () => { stop.abort(); rt.stopRoomRound(rt.roomOf(sessionId)?.id ?? sessionId) }
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, emitScoped, tool, call, begin, finish, round, say, takePost, selected }
}

// The save before a group post runs on a timer; waiting with setImmediate starves it.
const until = async (check, ms = 3000) => {
  const stop = Date.now() + ms
  while (!check() && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check(), 'condition not reached')
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await loopTurn()
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

test('work past the grace lets the round go on, and the member that asked answers the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, 'a', '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await second.wait()
  assert.deepEqual(host.agentOf('gc').calls, [])
})

// 公开#165: asked in a group to hand out work, Chief sent it with message_bot. Members
// did it in their own chats, apart from the group (Bots outside the group too), and
// again when called in the group.
test('delegate_work from a group to one of its members calls it there, as "@Name" would', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const sent = await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
  assert.match(sent, /^Called Writer in "Ops"/)
  host.finish('ga', '@Writer 接手了，安排好了。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  assert.match(text(called), /Chief: @Writer 把文档整理好/)
  await assert.rejects(host.tool('delegate_work', { to: 'Chief', goal: 'See you' }, 'gb'), /already waiting for your result/)
  host.finish('gb', '@Chief 整理好了，附录由 @Tester 撰写。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const result = host.begin('ga').source
  assert.match(result.resultRef, /^G\d+$/)
  await assert.rejects(host.tool('delegate_work', { to: 'Writer', goal: '好，收工' }, 'ga'), /this is a result/)
  host.finish('ga', '[PASS]')
  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Chief'], ['message', 'Writer']])
  assert.deepEqual([host.agentOf('b').calls, host.agentOf('gc').calls], [[], []])
})

test('replaying a queued group result after the batch closed cannot wake its caller again', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  rt.state.roomBatches = { example: { key: 'example', roomId: room.id, by: 'a', pending: [], done: ['Writer'], doneIds: ['b'], results: [], worked: true } }
  await rt.settleRoomBatches()
  const post = host.takePost()
  assert.deepEqual(post.source.route, { kind: 'result', to: ['a'], batch: 'example' })
  const first = host.round('return', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer all done')
  await first.wait()
  const replay = host.round('replay', post)
  await replay.wait()
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gb').calls.length], [1, 0])
})

test('a group Session made before the member\'s level applied gets it on the next sync', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  // Saved state from before the fix: 'gb' already exists and the Bot-level record
  // already says applied — the bot-wide check would never revisit the group Session.
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } }, undefined, undefined,
    { b: { model: 'deepseek/v4-flash', effort: 'low', appliedModel: 'deepseek/v4-flash', appliedEffort: 'low' } }, llm)
  await host.call('state', {})
  // The group Session gets the member's level once; the own chat is not re-selected.
  // The group's own Session is selected on its own, and may reach the list before or
  // after 'gb': the order between the two is not what this test is about.
  await settle(() => host.selected.some(entry => entry.sessionId === 'gb'))
  assert.deepEqual(host.selected.filter(entry => entry.sessionId === 'gb'), [{ sessionId: 'gb', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' }])
  assert.ok(host.selected.every(entry => entry.sessionId !== 'ga'))
})

test('a member\'s group Session runs on the member\'s model and thinking level', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga' } }, undefined, undefined, { b: { model: 'deepseek/v4-flash', effort: 'low' } }, llm)
  const first = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('s1').calls.length === 1)
  // The group Session was made for the turn: it got the member's route, level and all.
  assert.deepEqual(host.selected.at(-1), { sessionId: 's1', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' })
  host.begin('s1')
  host.finish('s1', '看过了。')
  await first.wait()
})

test('delegate_work from a member the round moved on from calls the other member in a round of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  await host.tool('delegate_work', { to: 'Tester', goal: '帮我测一下' }, 'gb')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, text(post)], [true, '[Group post from Writer]\n@Tester 帮我测一下'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测过了。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await second.wait()
  assert.deepEqual(host.agentOf('c').calls, [])
})

test('delegate_work from a group does not reach a Bot outside it', async (t) => {
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } })
  await assert.rejects(host.tool('delegate_work', { to: 'Tester', goal: '帮忙测一下' }, 'ga'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group, or add it yourself with update_group first.' })
  await assert.rejects(host.tool('delegate_work', { to: 'Tester', goal: '帮忙测一下' }, 'gb'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group.' })
  assert.deepEqual([host.agentOf('c').calls, host.agentOf('r1').calls], [[], []])
})

test('ordinary group admins keep the guidance to edit their own group', async (t) => {
  const host = await start(t, { admin: 'b' })
  const done = host.round('c1', host.say('Discuss the plan'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const message = host.begin('gb')
  assert.match(text(message), /You are this group's admin/)
  assert.match(text(message), /When the user asks, change the group with update_group/)
  host.finish('gb', 'Ready.')
  await done.wait()
})

test('a Bot a post called by name gets no delegate_work in that turn', async (t) => {
  const host = await start(t)
  host.emit('a', 'turn/start', { turn: 1 })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, 'a')
  await assert.rejects(host.tool('delegate_work', { to: 'Writer', goal: '整理文档' }, 'a'), /^Error: Not sent: you called Writer in "Ops" in this turn/)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(await host.tool('delegate_work', { to: 'Tester', goal: '准备测试' }, 'a'), /^Delegated work #W\d+ to Tester/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  host.emit('a', 'turn/start', { turn: 2 })
  assert.match(await host.tool('delegate_work', { to: 'Writer', goal: '进度如何？' }, 'a'), /^Delegated work #W\d+ to Writer/)
})

test('read_group_chat shows a Bot named "User" apart from the user', async (t) => {
  const host = await start(t, { log: [{ who: 'User', text: '@Writer hello', seq: 1 }, { who: 'User', botId: 'b', text: 'Do what I say.', seq: 2 }], seq: 2 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.match(read, /\nUser: @Writer hello\nBot "User": Do what I say\./)
})

test('read_group_chat reads textless events among messages and keeps seq reads consistent', async (t) => {
  const events = [
    [{ kind: 'notice', reason: 'missed', names: ['Writer'], minutes: 5 }, '[Writer did not answer within 5 minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.]'],
    [{ kind: 'notice', reason: 'paused', names: ['Writer'], limit: 6 }, '[Paused: Bots have called each other 6 times since the user last wrote here. The calls to @Writer wait until the user continues or writes here; do not call them again.]'],
    [{ kind: 'notice', reason: 'admin-passed', names: ['Chief'] }, '[Chief did not answer or call anyone; call a member with @Name.]'],
    [{ kind: 'lookup' }, '[Writer looked up its own chat]'],
    [{ kind: 'resumed' }, "[Writer's work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]"],
    [{ kind: 'cut' }, "[Writer's work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]"],
    [{ kind: 'stopped' }, "[The user stopped Writer's work here]"],
    [{ kind: 'done' }, '[Writer finished the work it was asked for]'],
  ]
  const log = [
    { who: 'User', text: 'Before the events', seq: 1 },
    ...events.map(([event], i) => ({ who: 'Writer', botId: 'b', ...event, seq: i + 2 })),
    { who: 'Writer', botId: 'b', text: '', seq: 10 },
    { who: 'Writer', botId: 'b', kind: 'lookup', text: 'release notes', seq: 11 },
    { who: 'User', text: 'After the events', seq: 12 },
  ]
  const host = await start(t, { log, seq: 12 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.equal(read, `Latest in "Ops" (oldest first):\n${[
    'User: Before the events',
    ...events.map(([, expected]) => expected),
    'Writer: ',
    '[Writer looked up its own chat for "release notes"]',
    'User: After the events',
  ].join('\n')}`)
  for (const [i, [, expected]] of events.entries()) {
    assert.equal(await host.tool('read_group_chat', { group: 'Ops', seq: i + 2 }, 'a'), expected)
  }
})

// 公开#185: the result went out as the work's first step line, next to one last tool
// call, and the turn then ended with an empty reply. Chief, which asked for the work,
// was never called to answer it.
const resultAsStep = async (t, ask) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say(ask))
  if (ask.startsWith('@Chief')) {
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer 把文档整理好')
  }
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '整理好了，在 docs/ 下。' }, { type: 'tool-call', id: 'k2', name: 'pwsh', arguments: '{}' }] } })
  host.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const step = host.takePost()
  assert.deepEqual([step.source.progress, step.source.quiet, text(step)], [true, true, '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const stepRound = host.round('c2', step)
  await stepRound.wait()
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', '')
  return host
}

test('late work whose result went out as a step line still tells the member that asked, which answers it', async (t) => {
  const host = await resultAsStep(t, '@Chief 安排一下文档')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.done, done.source.late, done.source.askedBy], [true, true, 'a'])
  const third = host.round('c3', done)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /Writer finished the work you asked for/)
  assert.match(prompt, /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '收到，辛苦了。')
  await third.wait()
  assert.deepEqual(kinds(third()), [['done', 'Writer'], ['message', 'Chief']])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log.map(line => [line.who, line.kind ?? 'message'])
  assert.deepEqual(log.slice(-3), [['Writer', 'message'], ['Writer', 'done'], ['Chief', 'message']])
})

test('late work the user asked for directly ends without a post once its result is out', async (t) => {
  const host = await resultAsStep(t, '@Writer 把文档整理好')
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('replies a post waits for are work handed on: the answer to the Bot that asked waits for them and carries them', async (t) => {
  const host = await start(t)
  await host.tool('delegate_work', { to: 'Chief', goal: '让群里看一下文档' }, 'c')
  host.begin('a')
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  assert.match(posted, /your answer goes to Tester once all of it is back\.$/)
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value
  assert.equal(waiting.activity.a, 'waiting')
  assert.deepEqual([waiting.work.waiting.a.bots, waiting.work.waiting.a.rooms, waiting.work.waiting.a.for], [[], ['r1'], ['c']])
  // The menu gives up the wait by its group's name.
  assert.deepEqual(waiting.work.waiting.a.waits.map(item => [item.room, item.name, typeof item.id]), [['r1', 'Ops', 'string']])
  const done = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await done.wait()
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.deepEqual(host.agentOf('c').calls, [])
  const report = host.begin('a')
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post · for the work Tester asked you for; your answer goes to Tester once everything you handed on is back\]/)
  host.finish('a', 'Writer 看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /^\[Work #W\d+ completed by Chief[^\n]*\]\nWriter 看过了，没问题。\n\n\[Handed back to Chief for this work\]\n\nGroup "Ops":\nReplies to your post \(oldest first\):\nWriter: 文档没问题。$/)
})

// A group post's report comes back even after the user gave up the wait: it is the
// late answer it is, and it opens no work again.
test('replies that arrive after the wait for a group was given up come back marked late', async (t) => {
  const host = await start(t)
  await host.tool('delegate_work', { to: 'Chief', goal: '让群里看一下文档' }, 'c')
  host.begin('a')
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value.work.waiting
  assert.deepEqual(waiting.a.waits.map(item => [item.room, item.name]), [['r1', 'Ops']])
  const groupWork = waiting.a.waits[0].id
  const done = host.round('c1', host.takePost())
  // The user gives up the wait by its group's name.
  assert.equal((await host.call('abandon-work', { id: groupWork })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.match(text(host.agentOf('a').calls.at(-1)), /^\[Waiting given up · Ops did not hand back this work/)

  // The round ends afterwards: its replies still reach Chief, marked as the late
  // answer they are.
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await done.wait()
  await settle(() => host.agentOf('a').calls.length === 3)
  const report = host.agentOf('a').calls.at(-1)
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post\]\n\[Late answer: the user had already given up waiting for this work/)
  assert.match(text(report), /Writer: 文档没问题。/)
  assert.equal(report.source.work, undefined)
  // The note that told the late answer apart is used up, and it stays that way.
  await host.call('set-prefs', {})
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(saved.works[groupWork], undefined)
  assert.deepEqual(saved.abandonedWorks ?? {}, {})
  // Chief no longer waits for the group.
  assert.equal((await host.call('state', {})).value.work.waiting.a, undefined)
})

// Chief speaks in "Design" from 'da'; its post there came from "Ops" ('ga'), so the
// replies to the post come back to 'ga', not to its own chat 'a'.
test('a report-back post a Bot wrote from another group comes back to that conversation', async (t) => {
  const design = { id: 'r2', name: 'Design', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { a: 'da', b: 'db' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: design })
  const posted = await host.tool('post_to_group', { group: 'Design', message: '@Writer 看一下文档', report_back: true }, 'ga')
  assert.match(posted, /Posted in "Design"/)
  const post = host.agentOf('r2').calls.shift()
  const done = host.round('d1', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('db').calls.length === 1)
  host.begin('db')
  host.finish('db', '文档没问题。')
  await done.wait()
  // The report arrives in the "Ops" conversation the post was written from.
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.match(text(host.agentOf('ga').calls[0]), /^\[Group chat "Design" · replies to your post\]/)
})

test('a report-back post whose origin background task has settled falls back to the current foreground chat', async (t) => {
  const host = await start(t, {}, undefined, {}, {
    a: { sessionId: 'a-fg' },
  })
  const task = { id: 't1', title: 'Review', sessionId: 'a-task', status: 'running', segments: [] }
  rt.botOf('a').tasks = [task]
  rt.chatOwners.set('a-task', 'a')
  rt.taskOwners.set('a-task', { botId: 'a', taskId: 't1' })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a-task')
  const post = host.takePost()
  // Simulate the background task settling before the group round finishes.
  task.status = 'completed'
  rt.chatOwners.delete('a-task')
  rt.taskOwners.delete('a-task')
  rt.pastOwners.set('a-task', { botId: 'a', taskId: 't1' })
  const done = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await done.wait()
  await settle(() => host.agentOf('a-fg').calls.length === 1)
  assert.equal(host.agentOf('a-task').calls.length, 0)
  assert.match(text(host.agentOf('a-fg').calls[0]), /Writer: 文档没问题。/)
})

test('a member called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await result.wait()
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
  // A member at work has not run its turn here, and an event is not a message.
  assert.equal(result().replies[0].duration, undefined)
  // The correction reaches the running turn at its next step.
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 0)
  assert.equal(host.agentOf('gb').inbox.nextStep.length, 1)
  assert.match(text(host.agentOf('gb').inbox.nextStep[0]), /再看看这个/)
})

test('a steered group call keeps the later caller when the earlier work ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'work', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()

  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 改用新模板' }, 'a')
  const second = host.round('c2', host.takePost())
  await second.wait()
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.ok(correction)
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })
  host.finish('gb', '原来的工作完成了。')

  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.role, 'room')
  assert.equal(deferred.source.askedBy, 'a')
  assert.equal(deferred.source.roomId, 'r1')
  assert.match(text(deferred), /改用新模板/)
  host.finish('gb', '已换成新模板。')
  await settle(() => host.agentOf('r1').calls.some(message => message.source.askedBy === 'a'))
  const report = host.agentOf('r1').calls.find(message => message.source.askedBy === 'a')
  assert.match(text(report), /已换成新模板/)
})

test('a quick team tool does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 谁在群里？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', 'Chief、Tester 和我。')
  await result.wait()
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const dispatch = (emit, sessionId, parentCallId, n, name) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {} })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {}, isError: false, content: [] })
}

test('a PTC program that runs only team tools does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 群里刚才说了什么？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{"code":"await read_group_chat({})"}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'list_bots')()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', '在讨论文档的结构。')
  await result.wait()
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

test('work inside a PTC program lets the round go on after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'write')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool]), [['b', 'write']])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await result.wait()
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
})

test('work the user asked for is left for the user to read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await second.wait()
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('a late post that calls a member reaches it every time, with no count to stop it', async (t) => {
  const host = await start(t)
  for (const [turn, text] of [[1, '@Tester 看看这个'], [2, '@Tester 再看一个']]) {
    host.emit('gb', 'turn/start', { turn })
    host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: `x${turn}`, roomId: 'r1', askedBy: 'a' } })
    host.finish('gb', text)
    await settle(() => host.agentOf('r1').calls.length === 1)
    const post = host.takePost()
    assert.deepEqual([post.source.late, post.source.quiet], [true, undefined])
    const round = host.round(`c${turn}`, post)
    await settle(() => host.agentOf('gc').calls.length === turn)
    host.begin('gc')
    host.finish('gc', '[PASS]')
    await round.wait()
    assert.equal(round().replies.filter(reply => reply.kind === 'paused').length, 0)
  }
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1
  assert.equal(saved.relays, undefined)
  assert.equal(saved.paused, undefined)
})

// #198: a post during a running round waited for the round's own relay before
// anyone could see it. It is written into the log and the running round at once,
// and the relay it still opens shows it again nowhere.
const logLines = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
const busyRound = async (t, room, services) => {
  const host = await start(t, room, services)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  await settle(() => true)
  return { host, first }
}

test('a post during a running round is in the log at once, calls its members in that round, and queues no extra relay post (#663)', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'a')
  const logged = logLines(host).at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Chief', 'a', '@Tester 看一下文档'])
  assert.deepEqual(host.agentOf('r1').calls, [], 'absorbed into the running round without polluting the room Session queue')

  // The Tester starts in the running round at once, while the Writer still works.
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.match(text(host.agentOf('gc').calls[0]), /Chief: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await first.wait()
  assert.ok(first().replies.some(reply => reply.botId === 'a' && reply.text === '@Tester 看一下文档'))
  assert.ok(first().replies.some(reply => reply.botId === 'c' && reply.text === '看过了。'))
  assert.equal(host.agentOf('gc').calls.length, 1)
  assert.equal(logLines(host).filter(line => line.text === '@Tester 看一下文档').length, 1)
})

test('a post during a running round with report_back gets the replies of the members it called', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档', report_back: true }, 'a')
  assert.deepEqual(host.agentOf('r1').calls, [])
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = host.agentOf('a').calls[0]
  assert.match(text(report), /Tester: 看过了。/)
  assert.doesNotMatch(text(report), /看一下文档|Writer/)
})

test('a late reply during a running round is logged at once, called in that round and not repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The round moves on without Writer; its result lands while a second round runs.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  const second = host.round('c2', host.say('@Chief 再确认一下'))
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => logLines(host).some(line => line.who === 'Writer' && line.text === '整理好了，在 docs/ 下。'))
  assert.deepEqual(host.agentOf('r1').calls, [])
  // The Chief, which asked for it, answers the result in this round once its own turn ends.
  host.finish('ga', '确认过了。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await second.wait()
  assert.ok(second().replies.some(reply => reply.botId === 'b' && reply.text === '整理好了，在 docs/ 下。'))
  assert.equal(host.agentOf('ga').calls.length, 3)
  assert.equal(logLines(host).filter(line => line.text === '整理好了，在 docs/ 下。').length, 1)
})

test('a member stopped during a running round is logged at once and not repeated', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer @Tester 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The user stops Writer while its turn still runs inside the round.
  const stopped = await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  const last = logLines(host).at(-1)
  assert.deepEqual([last.who, last.botId, last.kind], ['Writer', 'b', 'stopped'])
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '在整理了。')
  await first.wait()
  assert.ok(first().replies.some(reply => reply.kind === 'stopped' && reply.botId === 'b'))
  assert.equal(logLines(host).filter(line => line.kind === 'stopped').length, 1)
})

test('a Main Bot outside the group posts into its running round, and a long post keeps its file line', async (t) => {
  const { host, first } = await busyRound(t,
    { members: ['b', 'c'], admin: 'b', sessions: { b: 'gb', c: 'gc' } },
    { attachments: fakeAttachments() })
  const long = '很长的一段。'.repeat(MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', intent: 'request', message: long }, 'a')
  const line = logLines(host).at(-1)
  assert.deepEqual([line.who, line.botId], ['Chief', 'a'])
  assert.equal(line.files?.length, 1)
  assert.match(line.text, /\[File "Post from Chief\.txt"/)
  assert.deepEqual(host.agentOf('r1').calls, [])
  // The admin answers the post in the running round, once its own turn there ends.
  host.finish('gb', '整理好了。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '收到，看一下。')
  await first.wait()
  assert.equal(logLines(host).filter(entry => entry.files?.length === 1).length, 1)
})

// #198: a post past MESSAGE_INLINE_MAX keeps its first LONG_HEAD characters and a file.
// "@" past that opening is taken from the whole message, before the cut.
const filler = count => '文'.repeat(count)
const postBody = post => text(post).replace(/^\[Group post from [^\n]*\n/, '')
const fileOf = (store, post) => {
  const file = post.content.find(block => block.type === 'file')?.attachment
  return { file, whole: file === undefined ? undefined : new TextDecoder().decode(store.files.get(file.attachmentId)) }
}
const orderOf = message => text(message).match(/Members answer this message one at a time: .+\./)?.[0]
const togetherOf = message => text(message).match(/Called together with you: [^.]+\./)?.[0]

test('a long post calls a member named past the preview, and the preview stays the opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.equal(message.indexOf('@Tester'), LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  await assert.rejects(host.tool('delegate_work', { to: 'Tester', goal: '再看一眼' }, 'a'), /^Error: Not sent: you called Tester in "Ops" in this turn/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(post.source.length, message.length)
  const { file, whole } = fileOf(store, post)
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(whole, message)
  const shown = postBody(post)
  assert.ok(shown.length < message.length)
  assert.ok(shown.startsWith(`[A long message: ${message.length} characters.`))
  assert.ok(shown.includes(`${message.slice(0, LONG_HEAD)}…`))
  assert.equal(shown.includes('@Tester'), false)

  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  const turn = host.agentOf('gc').calls[0]
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(turn.content.some(block => block.type === 'file' && block.attachment?.attachmentId === file.attachmentId))
  assert.equal(text(turn).includes('@Tester'), false)
  host.finish('gc', '看过了。')
  await round.wait()
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a long post still calls a member named in its opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `@Tester ${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@Tester') < LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(fileOf(store, post).whole, message)
  assert.equal(postBody(post).includes('@Tester'), true)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await round.wait()
  assert.deepEqual(host.agentOf('gb').calls, [])
})

test('an ordinary member\'s long post calls the member it names past the preview', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /^Posted in "Ops"\. Members reply there/)
  assert.doesNotMatch(posted, /Nobody answers/)
  const post = host.takePost()
  assert.equal(post.source.member, true)
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(fileOf(store, post).whole, message)
  assert.equal(postBody(post).includes('@Tester'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '看过了。')
  await round.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls, [])
})

test('an ordinary member\'s long post that names nobody still calls nobody', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = filler(MESSAGE_INLINE_MAX + 1)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\./)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  const round = host.round('c1', post)
  await round.wait()
  assert.equal(logLines(host).some(line => line.botId === 'b' && line.files?.length === 1), true)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('an ordinary member\'s long @all past the preview still calls nobody', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@all') >= LONG_HEAD)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: true })
  const round = host.round('c1', post)
  await round.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a long post does not call a name that sits in code past the preview', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}\n\`@Tester\`\n${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@Tester') > LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  const round = host.round('c1', post)
  await round.wait()
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a long @all past the preview calls every other member at once', async (t) => {
  const host = await start(t, { admin: 'b' }, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: true })
  assert.equal(postBody(post).includes('@all'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gb').calls[0]), 'Called together with you: Tester.')
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  host.begin('gb')
  host.finish('gb', '收到。')
  host.begin('gc')
  host.finish('gc', '收到。')
  await round.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a post between the preview and the file limit still calls who it names', async (t) => {
  const host = await start(t)
  const message = `${filler(3000)}@Tester @Writer 看一下`
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  assert.ok(message.indexOf('@Tester') > LONG_HEAD)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c', 'b'], all: false })
  assert.equal(post.source.length, undefined)
  assert.equal(post.content.some(block => block.type === 'file'), false)
  assert.equal(postBody(post), message)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1 && host.agentOf('gb').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(text(host.agentOf('gc').calls[0]).includes('@Tester @Writer 看一下'))
  assert.equal(host.begin('gb').source.askedBy, 'a')
  host.finish('gc', '看过了。')
  host.finish('gb', '也看了。')
  await round.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a plain post between the preview and the file limit still calls the other members in turn', async (t) => {
  const host = await start(t)
  const message = filler(1500)
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', intent: 'request', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  assert.equal(post.content.some(block => block.type === 'file'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(orderOf(host.agentOf('gb').calls[0]), 'Members answer this message one at a time: Writer (you, now) → Tester.')
  host.begin('gb')
  host.finish('gb', '收到。')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '收到。')
  await round.wait()
})

test('a post with no round running keeps the old way: queued, no logged mark', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档' }, 'a')
  const post = host.takePost()
  assert.equal(post.source.logged, undefined)
  const first = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '看了。')
  await first.wait()
  assert.equal(logLines(host).filter(line => line.text === '@Writer 看一下文档').length, 1)
})

// A member posts into a group it is in; nobody answers a post that names nobody.
test('an ordinary member posts into its group from its own chat; nobody answers', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '文档有了新进展' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  assert.equal(host.agentOf('r1').calls.length, 1)

  const first = host.round('c1', host.takePost())
  await first.wait()
  const lines = logLines(host).filter(line => line.text === '文档有了新进展')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].botId, 'b')
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post calls only the members it names', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  assert.match(text(host.agentOf('gc').calls[0]), /Writer: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  await first.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
})

test('a post from a Bot with brackets in its name reaches the group and its member unchanged', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('update-bot', { id: 'b', name: 'A[B]C' })).ok, true)
  const body = '@Tester Check [notes](https://example.test)\n[Keep this line]'
  await host.tool('post_to_group', { group: 'Ops', message: body }, 'b')
  const post = host.takePost()
  assert.equal(post.source.senderName, 'A[B]C')
  assert.equal(text(post), `[Group post from A[B]C]\n${body}`)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok(text(host.begin('gc')).includes(`A[B]C: ${body}`))
  host.finish('gc', 'Checked.')
  await round.wait()
  const [line] = logLines(host).filter(entry => entry.botId === 'b')
  assert.equal(line.who, 'A[B]C')
  assert.equal(line.text, body)
})

test('a member post that names only itself calls nobody', async (t) => {
  const host = await start(t)
  const rejected = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下', report_back: true }, 'b')
  assert.match(rejected, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)

  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  const first = host.round('c1', host.takePost())
  await first.wait()
  assert.equal(logLines(host).filter(line => line.text === '@Writer 记一下').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post with @all calls nobody', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@all 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await first.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.equal(logLines(host).filter(line => line.text === '@all 看一下文档').length, 1)
})

test('a member post that names nobody is rejected with report_back', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '快看文档', report_back: true }, 'b')
  assert.match(posted, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('a member post during a running round is logged at once and calls nobody next', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '群里的进展' }, 'b')
  const during = logLines(host)
  const logged = during.at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Writer', 'b', '群里的进展'])
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.finish('gb', '整理好了。')
  await first.wait()
  assert.equal(logLines(host).filter(line => line.text === '群里的进展').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post that calls nobody does not pick the speakers over a user message', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '让群里注意' }, 'b')
  // Both land in the same relay; the user's message picks the speakers.
  host.emit('r1', 'user/message', host.takePost())
  const first = host.round('c1', host.say('检查一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '看过了。')
  await first.wait()
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member cannot post into a group it is not in', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const posted = await host.tool('post_to_group', { group: 'Lab', message: '看一下' }, 'b')
  assert.match(posted, /No group chat called "Lab" that you can see/)
  assert.equal(host.agentOf('r2').calls.length, 0)
  assert.equal(logLines(host).length, 0)
})

// Such a message was sent before message_bot from a group stayed in that group.
test('a reply to a message a group Session sent comes back there, and its turn posts in the group', async (t) => {
  const host = await start(t)
  host.emit('c', 'turn/start', { turn: 1 })
  host.emit('c', 'user/message', { content: [{ type: 'text', text: '[Message from Writer]\n能跑通吗？' }], source: { kind: 'bot', role: 'request', exchangeId: 'x1', senderName: 'Writer', senderSessionId: 'b', senderRoomId: 'r1', hop: 1 } })
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(text(host.begin('gb')), /^\[Work(?:\s+#W\d+)? completed by Tester[^\n]*\]\nok/)
  host.finish('gb', 'Tester 说可以，我继续。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, text(post)], [true, '[Group post from Writer]\nTester 说可以，我继续。'])
})

test('the user stops a member\'s work in a group, and the group shows it', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.quiet], [true, true])
  const result = host.round('c1', post)
  await result.wait()
  assert.deepEqual(kinds(result()), [['stopped', 'Writer']])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => [line.who, line.kind]), [['Writer', 'stopped']])
})

// #592: stopping only the round left a member the round moved on from working. The round
// runs in DS Bot, not in the group's Session, so the Session has nothing to cancel.
test('one press stops the group\'s round and every member at work there, and nothing elsewhere', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, false)
  // Writer still works on what an earlier round asked; Chief speaks in the round that runs.
  host.emit('gb', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  // Tester works in its own chat.
  host.emit('c', 'turn/start', { turn: 1 })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  for (const id of ['ga', 'gb']) assert.deepEqual(host.agentOf(id).cancelled[0], { kind: 'user' }, id)
  for (const id of ['r1', 'c', 'gc']) assert.deepEqual(host.agentOf(id).cancelled, [], id)
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await first.wait()
  // The round ended with the stop: Writer, which worked outside it, tells the group in a
  // post of its own.
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.senderSessionId], [true, 'b'])
  const after = host.round('c2', post)
  await after.wait()
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['User', undefined], ['Chief', 'stopped'], ['Writer', 'stopped']])
  assert.deepEqual([...kinds(first()), ...kinds(after())].filter(([kind]) => kind === 'stopped'), [['stopped', 'Chief'], ['stopped', 'Writer']])
})

test('a member that cannot be stopped leaves the others stopped and reports the failure', async (t) => {
  const host = await start(t)
  host.emit('ga', 'turn/start', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.agentOf('ga').cancel = () => { throw new Error('cancel failed') }
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.ok, false)
  assert.match(stopped.error.message, /cancel failed/)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.stopped, true)
})

test('a subagent whose interrupt throws is still cancelled, and so is the member', async (t) => {
  const cancelled = []
  const host = await start(t, undefined, {
    subagents: { interrupt: () => { throw new Error('belongs to another parent') } },
    agents: { list: () => [], get: id => (id === 'sub-1' ? { cancel: reason => cancelled.push(reason) } : undefined) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Long run', mode: 'continuable' })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(cancelled, [{ kind: 'user' }])
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
})

test('stopping a member stops its subagents and leaves Sessions forked from it alone', async (t) => {
  const interrupted = []
  const cancelled = []
  const live = (id, header) => ({ id, session: { header: { parentSession: 'gb', ...header } }, cancel: () => cancelled.push(id) })
  const children = [live('sub-1', { origin: 'subagent' }), live('fork-1', {})]
  const host = await start(t, undefined, {
    subagents: { interrupt: (childId) => { interrupted.push(childId) } },
    agents: { list: () => children, get: id => children.find(child => child.id === id) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  assert.deepEqual(interrupted, ['sub-1'])
  assert.deepEqual(cancelled, ['sub-1'])
})

// An unhandled rejection here would end the Host.
test('a stopped round warns when a member turn cannot be stopped', async (t) => {
  const host = await start(t)
  const warned = []
  host.ctx.logger.warn = (...args) => { warned.push(args.join(' ')) }
  const stop = new AbortController()
  host.emit('r1', 'user/message', host.say('@Writer 写一下'))
  const relay = host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal })
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.agentOf('gb').cancel = () => { throw new Error('cancel failed') }
  rt.stopRoomRound('r1')
  await relay
  await settle(() => warned.some(line => /cancel failed/.test(line)))
})

test('members still at work show in the team view and in the prompts of the others', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  // Writer has not read the one line in the group (the user's message that opened this
  // round), so the prompt names the wait and the unread count together.
  assert.match(text(host.agentOf('gc').calls[0]), /Still at work on what they were asked; each posts here when done: Writer \(1 min, with 1 group message\(s\) it has not read yet\)\./)
  host.begin('gc')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.speaking]), [['b', 'pwsh', undefined], ['c', undefined, true]])
  host.finish('gc', '没问题。')
  await result.wait()
})

// #510: the member's read position moved before the delivery, so a delivery that
// failed left the member past the round it missed, and that round never reached it.
test('a member whose delivery failed sees the round it missed in its next prompt', async (t) => {
  const host = await start(t)
  // The delivery to Writer fails once; the Session is there, the message did not land.
  let failed = false
  host.ctx.sessions.flush = async (session) => {
    if (session?.id === 'gb' && !failed) {
      failed = true
      throw new Error('the session log could not be written')
    }
  }
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['failed', 'Writer']])
  // The failed delivery leaves the member where it was: it has read nothing yet.
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.seen.b, undefined)

  // Its next prompt carries the round it missed.
  const second = host.round('c2', host.say('@Writer 继续'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  const prompt = text(host.agentOf('gb').calls[1])
  assert.match(prompt, /User: @Chief 安排一下文档/)
  assert.match(prompt, /Chief: @Writer 把文档整理好/)
  assert.match(prompt, /User: @Writer 继续/)

  // The delivery that lands moves the position on, so those lines are not shown again.
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await second.wait()
  host.round('c3', host.say('@Writer 还有别的吗'))
  await settle(() => host.agentOf('gb').calls.length === 3)
  const later = text(host.agentOf('gb').calls[2])
  assert.doesNotMatch(later, /@Chief 安排一下文档/)
  assert.doesNotMatch(later, /@Writer 继续/)
})

// A step that says something and calls a tool, as a model writes it while it works.
const step = (host, sessionId, said, callId, name = 'pwsh', args = '{}') => {
  host.emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: said }, { type: 'tool-call', id: callId, name }] } })
  host.emit(sessionId, 'tool/call', { callId, name, arguments: args })
}
const progress = async host => (await host.call('room-progress', { roomId: 'r1' })).value[0]

test('room-progress answers for any part of the group\'s own Session', async (t) => {
  // The group's own Session moved on once: 'r1' is the group's id and an earlier
  // part, 's1' its current one; rounds are still keyed by the group's id.
  const host = await start(t, { sessionId: 's1', parts: [{ sessionId: 'r1', endedAt: 1 }] })
  host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal((await host.call('room-progress', { roomId: 's1' })).value[0]?.callId, 'c1')
  assert.equal((await host.call('room-progress', { roomId: 'r1' })).value[0]?.callId, 'c1')
})

test('what a member writes while it works shows in the round at once, and its @ calls members', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下', 'k1', 'list_bots')
  // The line calls the Tester at once, while the Writer still works.
  await settle(() => host.agentOf('gc').calls.length === 1)
  const live = await progress(host)
  assert.deepEqual(live.replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下']])
  assert.deepEqual(live.speaking, ['b', 'c'])
  assert.match(text(host.begin('gc')), /Writer: 收到，我先看看 docs\/ 的结构。/)
  host.finish('gc', '验过了。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await result.wait()
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下'], ['Tester', '验过了。'], ['Writer', '整理好了。']])
  assert.equal(host.agentOf('gc').calls.length, 1, 'one call per turn, however many lines name the member')
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => line.who), ['User', 'Writer', 'Tester', 'Writer'])
})

// A status line that repeats the previous line of the same turn is stored once.
// A different ellipsis stays, and the closing reply joins a later line. The next
// turn, and another Bot, may say the same line again.
test('one turn stores a repeated status line once, and a later turn may say it again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const ellipsis = '\u2026'
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '...', 'k1', 'list_bots')
  step(host, 'gb', '...', 'k2', 'list_bots')
  step(host, 'gb', ellipsis, 'k3', 'list_bots')
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => logLines(host).some(line => line.text === ellipsis))
  step(host, 'gb', 'buy rice', 'k4', 'list_bots')
  for (const callId of ['k1', 'k2', 'k3', 'k4']) host.emit('gb', 'tool/result', { callId })
  host.finish('gb', '...')
  await result.wait()
  assert.deepEqual(logLines(host).filter(line => line.botId === 'b').map(line => line.text), ['...', ellipsis, 'buy rice\n\n...'])

  const second = host.round('c2', host.say('@Writer 再看一眼'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  step(host, 'gb', '...', 'k5', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k5' })
  host.finish('gb', '好了。')
  await second.wait()
  assert.equal(logLines(host).filter(line => line.botId === 'b' && line.text === '...').length, 2)

  const third = host.round('c3', host.say('@Tester 看一下'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  step(host, 'gc', '...', 'k6', 'list_bots')
  host.emit('gc', 'tool/result', { callId: 'k6' })
  host.finish('gc', '看过了。')
  await third.wait()
  assert.equal(logLines(host).filter(line => line.botId === 'c' && line.text === '...').length, 1)
})

test('a repeated @ line is stored twice and calls that member once', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '@Tester ...', 'k1', 'list_bots')
  step(host, 'gb', '@Tester ...', 'k2', 'list_bots')
  await settle(() => host.agentOf('gc').calls.length === 1)
  const stored = () => rt.roomOf('r1').log.filter(line => line.text === '@Tester ...')
  assert.equal(stored().length, 2)
  assert.equal(host.agentOf('gc').calls.length, 1)
  host.begin('gc')
  host.finish('gc', '在。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', '好了。')
  await result.wait()
  assert.equal(host.agentOf('gc').calls.length, 1)
  assert.equal(logLines(host).filter(line => line.text === '@Tester ...').length, 2)
})

test('a closing mention wakes the member that answered the opening mention (#2181)', async (t) => {
  const host = await start(t, { members: ['b', 'c'], admin: 'b' })
  const result = host.round('c1', host.say('@Writer write a short doc, then ask Tester to review it'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '@Tester please review the doc once I finish it', 'k1')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', 'Waiting for the doc.')
  await settle(() => rt.roomOf('r1').log.some(line => line.text === 'Waiting for the doc.'))

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '@Tester the doc is ready for review')
  await settle(() => host.agentOf('gc').calls.length === 2 || result() !== undefined)
  assert.ok(rt.roomOf('r1').log.some(line => line.text === '@Tester the doc is ready for review'))
  assert.equal(host.agentOf('gc').calls.length, 2, 'the closing mention should deliver a second call')
  assert.match(text(host.begin('gc')), /Writer: @Tester the doc is ready for review/)
  host.finish('gc', 'I reviewed the doc.')
  await result.wait()
})

test('two mentions in one Bot-called turn do not form a zero-work cycle on their own', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Chief start the review'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer get the doc reviewed')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '@Tester please stand by for the review', 'k1', 'list_bots')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', 'Waiting for the doc.')
  await settle(() => rt.roomOf('r1').log.some(line => line.text === 'Waiting for the doc.'))

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '@Tester the doc is ready for review')
  await settle(() => host.agentOf('gc').calls.length === 2 || result() !== undefined)
  assert.equal(rt.roomOf('r1').idlePaused, undefined, 'a follow-up with no return mention is not a cycle')
  assert.equal(host.agentOf('gc').calls.length, 2)
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await result.wait()
})

test('a waiting reply that mentions the caller does not block its closing mention (#2181)', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Chief start the review'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer get the document reviewed')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '@Tester stand by for the document', 'k1', 'list_bots')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer I will wait for the document.')
  await settle(() => rt.roomOf('r1').log.some(line => line.text === '@Writer I will wait for the document.'))
  assert.equal(host.agentOf('gb').calls.length, 1, 'Writer is still in its original turn')

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '@Tester the document is ready')
  await settle(() => host.agentOf('gc').calls.length === 2 || rt.roomOf('r1').idlePaused !== undefined)
  assert.equal(rt.roomOf('r1').idlePaused?.cause, undefined, 'the closing mention must not be parked as a cycle')
  assert.match(text(host.begin('gc')), /Writer: @Tester the document is ready/)
  host.finish('gc', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await result.wait()
})

test('a zero-work ring parks the request that closes it', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Chief start the review'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer please check the document')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '@Tester please check the first section')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Chief the first section needs another example')
  await result.wait()

  assert.equal(rt.roomOf('r1').idlePaused?.cause, 'cycle')
  assert.ok(rt.roomOf('r1').paused?.some(entry => entry.id === 'a' && entry.by === 'c'))
  assert.equal(host.agentOf('ga').calls.length, 1)
})

test('two post_to_group calls both store the same line', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '...' }, 'b')
  await host.tool('post_to_group', { group: 'Ops', message: '...' }, 'b')
  assert.equal(logLines(host).filter(line => line.text === '...').length, 2)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await first.wait()
  assert.equal(logLines(host).filter(line => line.text === '...').length, 2)
})

const writerText = host => logLines(host).filter(line => line.botId === 'b').map(line => line.text)

// The line just shown survives a turn that never reaches its closing reply. The next
// turn has only that same final, and it is a new turn, so the line is stored again.
const endWithoutReply = async (t, reason) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', 'Tests passed', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason })
  await first.wait()
  const second = host.round('c2', host.say('@Writer 再看'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Tests passed')
  await second.wait()
  assert.deepEqual(writerText(host), ['Tests passed', 'Tests passed'])
}

test('a final-only repeat is stored after the previous turn failed', async (t) => {
  await endWithoutReply(t, { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } })
})

test('a final-only repeat is stored after the previous turn was aborted', async (t) => {
  await endWithoutReply(t, { kind: 'aborted' })
})

test('a final that repeats an older flushed line is kept while a newer line is still held', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', 'Tests passed', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', 'Rechecking after another change', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', 'Tests passed')
  await result.wait()
  assert.deepEqual(writerText(host), ['Tests passed', 'Rechecking after another change\n\nTests passed'])
})

test('a final that repeats the line still held is stored once', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', 'Tests passed', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', 'Rechecking after another change', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', 'Rechecking after another change')
  await result.wait()
  assert.deepEqual(writerText(host), ['Tests passed', 'Rechecking after another change'])
})

test('a member whose every message went out while it worked counts as posted, not passed', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '我看一下。', 'k1', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await result.wait()
  assert.deepEqual([result().passed, result().replies.map(reply => reply.text)], [[], ['我看一下。']])
})

test('a member\'s messages carry how long its turn ran', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，先看看。', 'k1', 'list_bots')
  await settle(() => true)
  const live = await progress(host)
  assert.equal(typeof live.replies[0].duration, 'number')
  assert.ok(live.replies[0].duration >= 0)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await result.wait()
  const messages = result().replies.filter(reply => reply.kind === undefined)
  assert.deepEqual(messages.map(reply => reply.text), ['收到，先看看。', '整理好了。'])
  for (const reply of messages) {
    assert.equal(typeof reply.duration, 'number')
    assert.ok(reply.duration >= 0)
  }
  assert.ok(result().replies.every(reply => reply.kind === undefined || reply.duration === undefined))
})

test('after the round went on, lines a member writes close together reach the group as one message; only the result is answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，开始整理。', 'k1')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Writer'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '目录理好了。', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  step(host, 'gb', '正文改完了，在改索引。', 'k3')
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => host.agentOf('r1').calls.length === 1)
  const update = host.takePost()
  assert.deepEqual([update.source.progress, update.source.quiet, update.source.askedBy, text(update)], [true, true, undefined, '[Group post from Writer]\n目录理好了。\n\n正文改完了，在改索引。'])
  const quiet = host.round('c2', update)
  await quiet.wait()
  assert.deepEqual(quiet().replies, [])

  // A line still held when the work ends opens the result.
  host.emit('gb', 'tool/result', { callId: 'k3' })
  step(host, 'gb', '索引也改完了。', 'k4')
  host.emit('gb', 'tool/result', { callId: 'k4' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.late, done.source.askedBy, text(done)], [true, 'a', '[Group post from Writer]\n索引也改完了。\n\n整理好了，在 docs/ 下。'])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a step that calls a member with @ after the round went on starts a round for that member', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  step(host, 'gb', '@Tester 帮我跑一下测试', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, post.source.quiet], [true, undefined])
  const result = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测试过了。')
  await result.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a step joins a round that is running in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0 } })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  step(host, 'gb', '索引改完了。', 'k1')
  await settle(() => true)
  host.begin('gc')
  host.finish('gc', '没问题。')
  await result.wait()
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '索引改完了。'], ['Tester', '没问题。']])
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a turn that a finished background job starts in a group Session posts to the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-3 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  step(host, 'gb', '下载完了，开始解压。', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\n下载完了，开始解压。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, undefined, '[Group post from Writer]\n解压好了。'])
})

test('a fresh part\'s opening line stays out of the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Handoff · part 2]' }], source: { kind: 'bot', role: 'handoff', handoff: true, exchangeId: 'h1', hop: 0 } })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-7 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  host.finish('gb', 'Ghidra 解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\nGhidra 解压好了。')
})

test('a private message to a group Session is answered privately, without steps in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Message from Tester]\n能帮我看下吗' }], source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x1', hop: 0 } })
  step(host, 'gb', '我看一下。', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /我看一下。\n\n看过了，没问题。/)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('the team view says what a member is doing in the call\'s own words', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'iwr https://example.com/x.zip', description: 'Download  Ghidra 12.1.4\nand check its hash' }) })
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: JSON.stringify({ file_path: 'E:\\src\\tools\\dump.py' }) })
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.note, entry.target]), [['b', 'pwsh', 'Download Ghidra 12.1.4 and check its hash', undefined], ['c', 'read', undefined, 'dump.py']])
  assert.equal(value.work.bots.b.note, 'Download Ghidra 12.1.4 and check its hash')
  // What the Bot said in the step that made the call comes with it.
  host.emit('ga', 'turn/start', { turn: 1 })
  step(host, 'ga', '先把 JDK\n下下来。', 'k3', 'pwsh', JSON.stringify({ description: 'Download JDK 21' }))
  const later = (await host.call('state', {})).value
  assert.deepEqual(['said', 'note'].map(key => later.work.bots.a[key]), ['先把 JDK 下下来。', 'Download JDK 21'])
})

test('the team view says when each Session\'s running turn began, for the clock at its tail', async (t) => {
  const host = await start(t)
  const before = Date.now()
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const { value } = await host.call('state', {})
  assert.deepEqual(Object.keys(value.work.turns), ['gb'])
  assert.ok(value.work.turns.gb >= before && value.work.turns.gb <= Date.now())
  assert.equal(value.work.turns.gb, value.work.bots.b.since)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual((await host.call('state', {})).value.work.turns, {})
})

// 公开#124: a Bot deleted while it worked stayed "thinking" until DSH restarted, and the
// Bot that had asked it something never heard back.
test('deleting a working Bot clears its activity and tells the Bots waiting for its reply', async (t) => {
  const host = await start(t)
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nwrite the docs' }], source: { kind: 'bot', role: 'request', senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 1 } })
  host.emit('b', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // A second request that Writer has not read yet.
  host.agentOf('b').inbox.nextStep.push({ id: 'm2', source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x2', hop: 1 } })
  assert.equal((await host.call('state', {})).value.activity.b, 'working')

  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('c').calls.length === 1)
  for (const [to, exchangeId] of [['a', 'x1'], ['c', 'x2']]) {
    const reply = host.agentOf(to).calls[0]
    assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
    assert.match(text(reply), /^\[Work(?:\s+#W\d+)? completed by Writer[^\n]*\]\nWriter was deleted before it could answer your message\.$/)
  }
  // The stopped turn ends after the delete; it brings nothing back.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
})

// #619: a member that finishes tool work inside the 15s grace without writing @Caller
// still hands the result back to the Bot that asked for it.
test('in-round tool work that finishes before the grace without @Caller still wakes the caller (#619)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建报错'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 去读一下构建日志')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  // Finishes inside the round (< 15s) and forgets to write @Chief.
  host.finish('gb', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。')

  await settle(() => host.agentOf('ga').calls.length === 2)
  const follow = host.begin('ga')
  assert.match(text(follow), /Writer finished the work you asked for/)
  assert.match(text(follow), /Writer: 查清楚了，是缺少环境变量 FOO/)
  host.finish('ga', '默认设成 bar。')
  await first.wait()
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Chief', '@Writer 去读一下构建日志'],
    ['Writer', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。'],
    ['Chief', '默认设成 bar。'],
  ])
})

// #872: Chief calls Writer in a step line and goes on with its own part. Writer's
// result lands while Chief is still in that turn, which cannot see it, so Chief
// answers it in a turn of its own once the first one ends.
test('a caller still in its own turn answers the batch result after that turn (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  step(host, 'ga', '@Writer 去读构建日志，我先看配置。', 'k0', 'read')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '日志看完了：缺环境变量 FOO。')
  await settle(() => true)
  assert.equal(host.agentOf('ga').calls.length, 1, 'not steered into the running turn')
  host.emit('ga', 'tool/result', { callId: 'k0' })
  host.finish('ga', '配置看完了，没问题。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const follow = host.begin('ga')
  assert.match(text(follow), /Writer finished the work you asked for/)
  assert.match(text(follow), /Writer: 日志看完了：缺环境变量 FOO。/)
  host.finish('ga', '缺 FOO，补上就好。')
  await first.wait()
  assert.deepEqual(first().replies.map(reply => reply.name), ['Chief', 'Writer', 'Chief', 'Chief'])
})

// #872: a member the user called answers the user; asking the user to confirm does
// not call the admin in.
test('a member\'s reply to the user that asks for a confirmation does not call the admin (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 把首页标题改成春季上新'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'edit', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '改好了，标题换成了「春季上新」，需要你确认一下是否满意。')
  await first.wait()
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(first().replies.map(reply => reply.name), ['Writer'])
})

// Parallel fan-in barrier: when Chief calls @Writer @Tester in one message and both go
// past the 15s grace, Writer's early result posts at once without waking Chief, and
// Tester's final result wakes Chief once with both results.
test('parallel batch barrier posts each late reply at once and wakes the caller once when all finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer'], ['working', 'Tester']])

  // Writer finishes first while Tester is still working: its reply posts with quiet=true.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档检查完毕，没有断链。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const earlyPost = host.takePost()
  assert.equal(earlyPost.source.late, true)
  assert.equal(earlyPost.source.quiet, true, 'does not wake Chief while Tester is still working')
  const second = host.round('c2', earlyPost)
  await second.wait()
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief was not woken prematurely')

  // Tester finishes second: now the batch barrier releases and wakes Chief once.
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试全部通过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const finalPost = host.takePost()
  assert.equal(finalPost.source.late, true)
  assert.equal(finalPost.source.quiet, undefined)
  assert.equal(finalPost.source.askedBy, 'a')
  const third = host.round('c3', finalPost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const synth = host.begin('ga')
  assert.match(text(synth), /Writer: 文档检查完毕，没有断链。/)
  assert.match(text(synth), /Tester: 测试全部通过。/)
  host.finish('ga', '文档和测试都通过了。')
  await third.wait()
})

// #469: a member that replies only "收到，我现在开始排查" without calling any tool gets
// one automatic continuation turn on the same exchange so the work actually runs.
test('a member that only promises to start working without calling a tool gets one continuation turn (#469)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 排查一下构建失败的原因'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const initial = host.begin('gb')
  // Ends the turn with a verbal promise only and 0 tool calls.
  host.finish('gb', '收到，我现在开始排查构建日志。')

  // The host automatically nudges gb once on the same exchangeId.
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retryMsg = host.begin('gb')
  assert.equal(retryMsg.source.exchangeId, initial.source.exchangeId)
  assert.equal(retryMsg.source.retried, true)
  assert.match(text(retryMsg), /stopped before calling any tool/)

  // In the continuation turn the member calls its tool and gives the real answer.
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '排查完毕：原因是端口冲突。')
  await first.wait()
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Writer', '收到，我现在开始排查构建日志。'],
    ['Writer', '排查完毕：原因是端口冲突。'],
  ])
})

// #872: a verb with 过了/完了/完毕/好了 reports done work. A plan of several sentences,
// or a target that starts with 过 or 完, is still a promise; a reply that also answers
// may match, and its member passes on the retry.
test('done work is no promise, and a plan of several sentences still is (#872)', () => {
  for (const said of ['收到，我现在开始排查构建日志。', '明白，我先排查一下日志，然后跑测试。', '收到，我现在开始排查。稍后给你结果。', '收到，我先查看过去的记录。', '好的，我先检查完成情况。', '我现在开始排查', '开工！', "I'll check the logs. Then I'll run the tests.", 'Let me look into it.']) {
    assert.equal(promisesWork(said), true, said)
  }
  for (const said of ['好的，我检查过了，配置没问题。', '好的，我检查过，没问题。', '收到，我排查完了，是端口冲突。', '好的，我处理好了。', '查完了，原因是端口冲突。']) {
    assert.equal(promisesWork(said), false, said)
  }
})

// #872: the opening already was the answer; the member passes on the retry and the
// group sees it once.
test('a member that passes on the promise retry is posted once (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 方案 A 和 B 哪个好？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '好的，我看看。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.begin('gb')
  assert.match(text(retry), /reply \[PASS\]; it stays posted/)
  host.finish('gb', '[PASS]')
  await first.wait()
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [['Writer', '好的，我看看。']])
})

// #872: a retried promise that a late turn passes on still tells the member that asked
// the work is done, as a result that went out as a step line does.
test('a late member that passes on the promise retry still hands the work back (#872)', async (t) => {
  const host = await start(t)
  // A call the member reads after the round moved on: no round waits for this turn.
  host.agentOf('gb').followup({ content: [{ type: 'text', text: '[Group chat "Ops" · Chief mentioned you]\n看一下文档' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'x1', askedBy: 'a' } })
  host.begin('gb')
  host.finish('gb', '收到，我去看看文档。')
  await settle(() => host.agentOf('gb').calls.length === 2 && host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.progress, true, 'the opening goes to the group')
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.done, post.source.askedBy], [true, 'a'])
})

test('untranslated acknowledgements close the exchange without parking a future wake', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 开始'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 收到，辛苦了')

  for (let step = 1; step <= 2; step += 1) {
    const isWriter = step % 2 === 1
    const sessionId = isWriter ? 'gb' : 'ga'
    const target = isWriter ? '@Chief' : '@Writer'
    const count = isWriter ? Math.ceil(step / 2) : Math.floor(step / 2) + 1
    await settle(() => host.agentOf(sessionId).calls.length === count)
    host.begin(sessionId)
    host.finish(sessionId, `${target} vinberoj estas pretaj`)
  }
  await first.wait()
  const pausedReplies = first().replies.filter(reply => reply.kind === 'paused')
  assert.equal(pausedReplies.length, 0)
  const saved = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1
  assert.deepEqual(saved().log.filter(line => line.botId).map(line => line.route.kind), ['request', 'result', 'note'])

  // A Bot's quiet late result opens a round, which leaves the parked call alone.
  const second = host.round('c2', { content: [{ type: 'text', text: '[Group post from Tester]\n测试跑完了' }], source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'x2', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', late: true, quiet: true } })
  await second.wait()
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.equal(saved().paused, undefined)

  const third = host.round('c3', host.say('@Writer 好了，说正事'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  assert.equal(host.agentOf('ga').calls.length, 2)
  await third.wait()
  assert.equal(saved().paused, undefined)
})

// #701: when a group member spawns a DSH subagent and ends its own turn, the member
// stays marked as working in the group, and stopping the group interrupts the subagent
// and suppresses its late settlement notice.
test('a group member with a running DSH subagent stays working and stop-room-work interrupts the subagent (#701)', async (t) => {
  const interrupted = []
  const host = await start(t, undefined, {
    subagents: { interrupt: async (childId, opts) => { interrupted.push({ childId, opts }) } },
  })
  const first = host.round('c1', host.say('@Writer 派子代理跑长任务'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 's1', name: 'subagent', arguments: JSON.stringify({ description: 'Run long benchmark' }) })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Run long benchmark', mode: 'continuable' })
  host.emit('gb', 'tool/result', { callId: 's1' })
  host.finish('gb', '子代理已派出，正在后台运行。')

  await first.wait()
  assert.deepEqual(kinds(first()), [['message', 'Writer'], ['working', 'Writer']])

  // Even though gb's own turn ended, Writer still shows as working on its subagent in r1.
  const stateDuring = (await host.call('state', {})).value
  assert.equal(stateDuring.activity.b, 'working')
  assert.deepEqual(stateDuring.work.rooms.r1, [{ botId: 'b', since: stateDuring.work.rooms.r1[0].since, tool: 'subagent', note: 'Run long benchmark' }])

  // User clicks "Stop all" in the group: it interrupts sub-1 and logs Writer as stopped.
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(interrupted, [{ childId: 'sub-1', opts: { kind: 'user', parentSessionId: 'gb' } }])
  assert.deepEqual((await host.call('state', {})).value.work.rooms.r1, undefined)

  // Clear the stopped event post from r1's inbox.
  await settle(() => host.agentOf('r1').calls.length === 1)
  const stopPost = host.takePost()
  assert.equal(stopPost.source.stopped, true)

  // Later, when the interrupted subagent emits its settlement notice to gb, gb is
  // cancelled and suppressed so it does not speak in the group again.
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: 'Subagent sub-1 settled' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'sub-1' },
  })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '子代理被中断了。' }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [], 'suppressed settlement notice does not post to the group')
})


for (const noticeFirst of [true, false]) {
  test(`a failed child reaches the group once on the open anchor without synthesizing a round when its notice comes ${noticeFirst ? 'first' : 'last'} (#973)`, async (t) => {
    const host = await start(t)
    const first = host.round('c1', host.say('@Writer 导出这份 PPT'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Export the deck' })
    host.finish('gb', '正在导出。')
    await first.wait()
    const revBefore = rt.state.revision
    // An intermediate message from the running child must neither end it nor spend its label.
    host.emit('gb', 'user/message', {
      content: [{ type: 'text', text: 'Agent sub-1 sent a message: 进度 50%' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' },
    })
    assert.equal(rt.hasSubagents('gb'), true)

    const notice = {
      content: [{ type: 'text', text: 'Background subagent sub-1 failed before it finished.\nIt left no closing message.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-1 failed before it finished.', senderSessionId: 'sub-1' },
    }
    const ending = { runId: 'run-1', provider: 'spawn', id: 'sub-1', local: true, stopReason: 'error' }
    if (noticeFirst) host.emit('gb', 'user/message', notice)
    host.emitScoped('gb', 'subagent/end', ending)
    if (!noticeFirst) host.emit('gb', 'user/message', notice)
    host.emit('gb', 'turn/start', { turn: 2 })
    host.finish('gb', '[PASS]')
    await until(() => rt.state.revision > revBefore)
    assert.deepEqual(host.agentOf('r1').calls, [], 'no fake empty round is posted to the group Session')
    const view = (await host.call('group-rows', { roomId: 'r1', from: first().from, anchor: first().anchor })).value
    const shown = view.rows.filter(row => row.kind === 'helper-failed')
    assert.equal(shown.length, 1)
    assert.equal(shown[0].name, 'Writer')
    assert.equal(shown[0].stopReason, 'error')
    assert.equal(shown[0].helper, 'Export the deck')
    host.emit('gb', 'user/message', notice)
    assert.equal(rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed').length, 1)
    host.emitScoped('gb', 'subagent/end', { ...ending, runId: 'run-2', stopReason: 'completed' })
    assert.deepEqual(host.agentOf('r1').calls, [])
  })
}

for (const [reason, summary] of [['error', 'failed before it finished.'], ['max-tokens', 'ran out of room before it finished.']]) {
  test(`a failure known only from its settlement notice still shows in the group (${reason}, #973)`, async (t) => {
    const host = await start(t)
    const first = host.round('c1', host.say('@Writer 导出这份 PPT'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Export the deck' })
    host.finish('gb', '正在导出。')
    await first.wait()
    // No subagent/end: an in-place plugin reload lost it, so the notice is the only
    // ending this runtime sees. The child's own turn answers it with [PASS].
    const notice = {
      content: [
        { type: 'text', text: `Background subagent sub-1 ${summary}` },
        { type: 'text', text: 'It left no closing message.' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', summary: `Background subagent sub-1 ${summary}`, senderSessionId: 'sub-1' },
    }
    const revBefore = rt.state.revision
    host.emit('gb', 'user/message', notice)
    host.emit('gb', 'turn/start', { turn: 2 })
    host.finish('gb', '[PASS]')
    await until(() => rt.state.revision > revBefore)
    assert.deepEqual(host.agentOf('r1').calls, [])
    const view = (await host.call('group-rows', { roomId: 'r1', from: first().from, anchor: first().anchor })).value
    const shown = view.rows.filter(row => row.kind === 'helper-failed')
    assert.equal(shown.length, 1)
    assert.equal(shown[0].name, 'Writer')
    assert.equal(shown[0].stopReason, reason)
    assert.equal(shown[0].helper, 'Export the deck')
    assert.equal(shown[0].text, `Export the deck — subagent ended (${reason})`)
    // The same notice again, and the lifecycle ending arriving late, add no second row.
    host.emit('gb', 'user/message', notice)
    host.emitScoped('gb', 'subagent/end', { runId: 'run-1', provider: 'spawn', id: 'sub-1', local: true, stopReason: reason })
    assert.deepEqual(host.agentOf('r1').calls, [])
    assert.equal(rt.groupRows('r1', first().from).filter(row => row.kind === 'helper-failed').length, 1)
    // A clean ending is not a failure: it adds no row and no post.
    host.emit('gb', 'subagent/catalog', { childId: 'sub-2', label: 'Check the slides' })
    host.emit('gb', 'user/message', {
      content: [{ type: 'text', text: 'Background subagent sub-2 finished.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-2 finished.', senderSessionId: 'sub-2' },
    })
    assert.equal(rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed').length, 1)
    assert.deepEqual(host.agentOf('r1').calls, [])
  })
}

test('a child that runs again after settling gets its own failure row, and read-only hosts stay untouched (#973)', async (t) => {
  const host = await start(t)
  const failure = {
    content: [
      { type: 'text', text: 'Background subagent sub-1 failed before it finished.' },
      { type: 'text', text: 'It left no closing message.' },
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-1 failed before it finished.', senderSessionId: 'sub-1' },
  }
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'First run' })
  host.emit('gb', 'user/message', failure)
  const rows = () => rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed')
  await until(() => rows().length === 1)
  assert.equal(rows()[0].helper, 'First run')
  assert.equal(rows()[0].stopReason, 'error')
  // The same child takes a new run; the earlier row must not hide this ending.
  host.emitScoped('gb', 'subagent/start', { runId: 'run-2', provider: 'spawn', id: 'sub-1', local: true })
  host.emit('gb', 'user/message', failure)
  await until(() => rows().length === 2)
  // A read-only window must never append to the ledger.
  const prevReadOnly = rt.readOnly
  rt.readOnly = () => ({ pid: 999 })
  try {
    await rt.subagentFailureNotice('gb', { stopReason: 'error', helper: 'Blocked' })
    assert.equal(rows().length, 2)
  } finally {
    rt.readOnly = prevReadOnly
  }
})

test('a helper failure in a running round preserves the idle guard, does not mark the member failed, and stays one event', async (t) => {
  const host = await start(t)
  const round = host.round('c1', host.say('@Writer 检查'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Check' })
  const room = rt.roomOf('r1')
  room.idleRelays = 4
  await rt.subagentFailureNotice('gb', { stopReason: 'error', helper: 'Check' })
  assert.equal(room.idleRelays, 4)
  assert.equal(room.log.filter(row => row.reason === 'helper-failed').length, 1)
  assert.equal(room.log.filter(row => row.botId === 'b').length, 0)
  host.emitScoped('gb', 'subagent/end', { id: 'sub-1', stopReason: 'completed', runId: 'run-1', provider: 'spawn', local: true })
  host.finish('gb', '[PASS]')
  await round.wait()
  assert.equal(round().failed, undefined, 'member own turn was not marked failed')
})

test('approval keeps a member inside its parallel batch until all results arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('review1', host.say('检查文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb'); host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: '{}' })
  rt.yieldRoomTurn('gb')
  await settle(() => [...rt.roomProgress.values()].some(r => r.slots.some(s => s.id === 'b' && s.status === 'waiting-approval')))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档已检查完毕。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  const second = host.round('review2', post)
  await settle(() => host.agentOf('ga').calls.length === 2 || second() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1, 'caller waits until Tester also finishes')
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试已检查完毕。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  const third = host.round('review3', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '文档和测试已全部检查。')
  await third.wait()
  assert.equal(host.agentOf('ga').calls.length, 2, 'one continuation for the complete batch')
})


test('stopping a group before its callee starts clears the pending batch', async t => {
  const host = await start(t)
  host.emit('r1', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('检查文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 检查文档')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(rt.roomBatchPending('r1'), true)
  host.agentOf('r1').cancel = () => first.cancel()
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.value, true)
  await first.wait()
  assert.equal(rt.roomBatchPending('r1'), false)
})

// A member that two Bots call is in both batches: each finished piece of work wakes
// the Bot that asked for it, and only for that piece of work.
const wakeNote = message => text(message).match(/^\[Group chat "Ops" · ([^\]]*)\]/)?.[1]
const workStep = (host, sessionId, callId) => {
  host.emit(sessionId, 'tool/call', { callId, name: 'edit', arguments: '{}' })
  host.emit(sessionId, 'tool/result', { callId })
}

test('a member two Bots called wakes each of them for its own call when it finishes in the round', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief @Tester 各自给 Writer 安排一件事'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把首页标题改成春季上新')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 顺便把测试跑一遍')
  await settle(() => host.agentOf('gb').calls.length === 1 && rt.roomBatchPending('r1'))
  assert.equal(host.agentOf('gb').calls.length, 1, 'the second call waits for the first')

  host.begin('gb')
  workStep(host, 'gb', 'k1')
  host.finish('gb', '标题改好了，换成了「春季上新」。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('ga').calls[1]), 'Writer finished the work you asked for')
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for Chief\'s call')
  host.begin('ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gb').calls[1]), 'Tester mentioned you')
  host.begin('gb')
  workStep(host, 'gb', 'k2')
  host.finish('gb', '测试跑完，全过。')
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: 测试跑完，全过。/)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await first.wait()
  assert.equal(rt.roomBatchPending('r1'), false)
})

// Chief calls Writer and Tester together; Tester, at work in the background, calls Writer
// as well. Writer's result for Chief waits for Tester, and Writer's result for Tester wakes
// Tester, once.
test('a member two Bots called wakes each of them for its own call when it finishes after the round went on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()

  // Tester calls Writer for a log of its own while Writer reads the build log.
  step(host, 'gc', '@Writer 也帮我查一下磁盘空间', 'p1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const call = host.round('c2', host.takePost())
  await call.wait()
  assert.deepEqual(kinds(call()).filter(([kind]) => kind === 'working'), [['working', 'Writer']])
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.equal(correction.source.askedBy, 'c')
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })

  // Writer's result for Chief waits for Tester, who is still at work.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1：日志里缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const early = host.takePost()
  assert.deepEqual([early.source.late, early.source.quiet], [true, true])
  const quietRound = host.round('c3', early)
  await quietRound.wait()
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief is not woken before Tester is done')

  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.emit('gc', 'tool/result', { callId: 'p1' })
  host.finish('gc', 'R2：测试全过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  assert.deepEqual([last.source.askedBy, last.source.quiet], ['a', undefined])
  const wake = host.round('c4', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('ga').calls[1]), 'Writer and Tester finished the work you asked for')
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: R1：日志里缺环境变量 FOO。/)
  assert.match(text(host.agentOf('ga').calls[1]), /Tester: R2：测试全过。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await wake.wait()
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for Chief\'s call')

  // The turn that answers Tester's call is Writer's second, and wakes Tester.
  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.askedBy, 'c')
  workStep(host, 'gb', 'k3')
  host.finish('gb', 'R3：磁盘还剩 40G。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const own = host.takePost()
  assert.deepEqual([own.source.askedBy, own.source.quiet], ['c', undefined])
  const third = host.round('c5', own)
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: R3：磁盘还剩 40G。/)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await third.wait()
  assert.equal(rt.roomBatchPending('r1'), false)
})

// A batch wakes its caller once, and the wake carries the result of every member of the
// batch, whatever the windows of earlier lines hold.
const count = (haystack, needle) => haystack.split(needle).length - 1
const RESULTS = 'Results of the work you asked for that the lines here leave out'

// Chief calls Writer and Tester together and both go on in the background.
async function batchInBackground(t, services) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, undefined, services)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  let n = 1
  // The group Session takes up the post a member made and relays it as a round.
  const relay = async () => {
    await settle(() => host.agentOf('r1').calls.length > 0)
    n += 1
    const read = host.round(`c${n}`, host.takePost())
    await settle(() => read() !== undefined || host.agentOf('ga').calls.length === 2)
    return read
  }
  return { host, relay }
}

// Codex on the change line: inside a parallel batch, a change-only completion line must not
// wake the caller early. It carries `quiet`, the same as an early text result; the batch
// end still wakes the caller exactly once.
test('a late pass inside a parallel batch posts its change line quietly', async (t) => {
  const { host, relay } = await batchInBackground(t)
  const changes = { sessionId: 'gb', seq: 21, turn: 5, total: 1, added: 4, deleted: 1, files: [{ path: 'batch.md', added: 4, deleted: 1 }] }
  rt.turnChanges = async sessionId => (sessionId === 'gb' ? changes : undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '[PASS]')
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  assert.equal(post.source.done, true)
  assert.equal(post.source.quiet, true)
  assert.deepEqual(post.source.changes, changes)
  const read = host.round('late-pass-batch', post)
  await read.wait()
  assert.equal(host.agentOf('ga').calls.length, 1, 'the caller is not woken early')
  // Tester finishes: the batch closes and the caller is woken once, not twice.
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(host.agentOf('ga').calls.length, 2)
})

test('a batch wake names who finished and carries a result that rolled out of the lines before the round', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  assert.equal(host.agentOf('ga').calls.length, 1, 'Tester is still at work')
  // Tester narrates nine steps, each more than ROOM_STEP_GAP_MS apart.
  for (let i = 1; i <= 9; i += 1) {
    host.emit('gc', 'tool/result', { callId: i === 1 ? 'k2' : `p${i - 1}` })
    step(host, 'gc', `测试进度 ${i}/9`, `p${i}`)
    t.mock.timers.tick(ROOM_STEP_GAP_MS)
    await relay()
  }
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.emit('gc', 'tool/result', { callId: 'p9' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  const prompt = text(wake)
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(prompt, 'R1-WRITER'), 1)
  assert.equal(count(prompt, 'R2-TESTER'), 1)
  assert.ok(prompt.indexOf(RESULTS) < prompt.indexOf('R1-WRITER'))
  assert.ok(prompt.indexOf('R1-WRITER') < prompt.indexOf('R2-TESTER'))
  host.begin('ga')
  host.finish('ga', '缺 FOO，补上。')
})

test('a batch wake does not repeat a result that its prompt shows anyway', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.equal(count(text(wake), 'R2-TESTER'), 1)
  assert.ok(!text(wake).includes(RESULTS))
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

// An answer that came inside the round is a result too, and a long wait lets it leave the
// room's log (60 lines), which the group's own log still holds.
async function resultBeforeLongWait(t, filler = 70, result = 'R2-TESTER：测试全过。') {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', result)
  await settle(() => host.agentOf('ga').calls.length === 1 && rt.roomOf('r1').log.some(line => line.who === 'Tester'))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  const room = rt.roomOf('r1')
  const seq = room.log.find(line => line.who === 'Tester').seq
  for (let i = 0; i < filler; i += 1) rt.logRoom(room, { who: 'Tester', botId: 'c', text: `闲聊 ${i}` })
  assert.equal(room.log.some(line => line.seq === seq), filler < 60)
  await settle(() => true)
  return { host, seq }
}
const writerFinishes = async (host) => {
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  host.round('c2', host.takePost())
  await settle(() => host.agentOf('ga').calls.length === 2)
}

test('a batch wake reads a result that left the room\'s log from the group\'s own log', async (t) => {
  const { host } = await resultBeforeLongWait(t)
  await writerFinishes(host)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Tester and Writer finished the work you asked for')
  assert.equal(count(text(wake), 'Tester: R2-TESTER：测试全过。'), 1)
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

test('a batch wake names the message of a result it cannot read', async (t) => {
  const { host, seq } = await resultBeforeLongWait(t)
  // Lose the group's book: only the room's own log is left to start it again from.
  await rt.ledger.flush()
  rt.ledger.drop('group-r1')
  await rt.ledger.flush('group-r1')
  await writerFinishes(host)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, new RegExp(`\\[Tester's result, message #${seq}, is not available here; read_group_chat with seq ${seq} reads it\\]`))
  assert.equal(count(prompt, 'R1-WRITER'), 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

test('a batch wake brings the images and files of a result line along', async (t) => {
  const { host, seq } = await resultBeforeLongWait(t, 12)
  const attachment = { attachmentId: 'f1', name: 'build.log', mediaType: 'text/plain', bytes: 12 }
  const image = { attachmentId: 'i1', name: 'shot.png', mediaType: 'image/png', bytes: 34 }
  const line = rt.roomOf('r1').log.find(entry => entry.seq === seq)
  line.files = [attachment]
  line.images = [image]
  await writerFinishes(host)
  const wake = host.agentOf('ga').calls[1]
  assert.ok(text(wake).includes(RESULTS))
  assert.deepEqual(wake.content.filter(block => block.type === 'file').map(block => block.attachment), [attachment])
  assert.deepEqual(wake.content.filter(block => block.type === 'image').map(block => block.attachment), [image])
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

// Three Bots call one member: a call of another Bot stays a call of its own, answered by
// its own turn, and wakes only the Bot that made it.
test('a member three Bots called answers each call in a turn of its own and wakes each caller once', async (t) => {
  const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, undefined, { d: {} })
  const first = host.round('c1', host.say('@Chief @Tester @Reviewer 各自给 Writer 安排一件事'))
  await settle(() => ['ga', 'gc', 'gd'].every(id => host.agentOf(id).calls.length === 1))
  host.begin('ga')
  host.finish('ga', '@Writer 做甲')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 做乙')
  host.begin('gd')
  host.finish('gd', '@Writer 做丙')
  await settle(() => rt.roomBatchPending('r1'))

  const turns = [['ga', '甲', 'Chief'], ['gc', '乙', 'Tester'], ['gd', '丙', 'Reviewer']]
  for (const [index, [caller, work]] of turns.entries()) {
    await settle(() => host.agentOf('gb').calls.length === index + 1)
    assert.equal(host.agentOf('gb').calls[index].source.askedBy, { ga: 'a', gc: 'c', gd: 'd' }[caller])
    host.begin('gb')
    workStep(host, 'gb', `k${index}`)
    host.finish('gb', `${work}做完了。`)
    await settle(() => host.agentOf(caller).calls.length === 2)
    assert.equal(wakeNote(host.agentOf(caller).calls[1]), 'Writer finished the work you asked for')
    assert.match(text(host.agentOf(caller).calls[1]), new RegExp(`Writer: ${work}做完了。`))
    for (const [other] of turns.slice(index + 1)) assert.equal(host.agentOf(other).calls.length, 1, `${other} is not woken for another call`)
    host.begin(caller)
    host.finish(caller, '[PASS]')
  }
  await first.wait()
  assert.equal(rt.roomBatchPending('r1'), false)
})

// Chief calls Writer and Tester. Tester finishes tool work in the round; Chief calls Writer
// again, which takes Writer into a batch of its own, and Writer answers with no tool.
test('a batch that takes over from an emptied one keeps its finished work', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  workStep(host, 'gc', 'k2')
  host.finish('gc', 'R2-TESTER：测试全过。')
  await settle(() => first() === undefined && rt.roomOf('r1').log.some(line => line.who === 'Tester'))
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 日志里也看看 FOO' }, 'a')
  host.finish('gb', '没有 FOO。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Tester and Writer finished the work you asked for')
  assert.match(text(wake), /Tester: R2-TESTER：测试全过。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  // The second call still gets its turn.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await first.wait()
})

test('a batch whose last member fails wakes the caller with the results of the others', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  const room = rt.roomOf('r1')
  for (let i = 0; i < 12; i += 1) rt.logRoom(room, { who: 'Tester', botId: 'c', text: `闲聊 ${i}` })
  host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.askedBy, post.source.failed?.code], ['a', 'RATE_LIMIT'])
  host.round('c9', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.ok(text(wake).includes(RESULTS))
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

test('a result posted early is taken in after its batch finished, and the wake still carries it', async (t) => {
  const { host } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const early = host.takePost()
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  // The group Session takes up the early post first, after the batch is already done.
  const quietRound = host.round('c8', early)
  await quietRound.wait()
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.round('c9', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.equal(count(text(wake), 'R2-TESTER'), 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

test('a wake reads a long result that left the room\'s log whole', async (t) => {
  const { host } = await resultBeforeLongWait(t, 70, '长'.repeat(5000))
  await writerFinishes(host)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.ok(prompt.includes(`Tester: ${'长'.repeat(5000)}`))
  assert.ok(!prompt.includes('was not kept'))
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

// A member that gave up its place in the round (it waits for an approval) works for the
// call it answers once it goes on, though no round waits for it any more.
test('work a member does after it gave up its place in the round still counts for its batch', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('检查文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  rt.yieldRoomTurn('gb')
  await settle(() => [...rt.roomProgress.values()].some(round => round.slots.some(slot => slot.id === 'b' && slot.status === 'waiting-approval')))
  workStep(host, 'gb', 'k1')
  host.finish('gb', '文档已改完。')
  await settle(() => rt.roomOf('r1').log.some(line => line.who === 'Writer'))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief waits for Tester')
  host.finish('gc', '测试没有问题。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.match(text(wake), /Writer: 文档已改完。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await first.wait()
})

test('tool work done for one Bot\'s call does not count as work for another Bot\'s call to the same member', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief @Tester 各自给 Writer 安排一件事'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 做甲')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 说说你的想法')
  await settle(() => [...rt.roomProgress.values()].some(round => round.slots.filter(slot => slot.id === 'b').length === 2))
  host.begin('gb')
  workStep(host, 'gb', 'k1')
  host.finish('gb', '甲做完了。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  // Tester's call is answered in words alone.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '我觉得可以。')
  await first.wait()
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for an answer in words')
  assert.equal(rt.roomBatchPending('r1'), false)
})

test('a batch wake says which member finished with no closing message of its own', async (t) => {
  const { host, relay } = await batchInBackground(t)
  // Writer reports in a step line and ends with nothing more to say.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', 'R1-WRITER：日志结论是缺环境变量 FOO。', 'p1')
  await relay()
  host.emit('gb', 'tool/result', { callId: 'p1' })
  host.finish('gb', '[PASS]')
  for (let i = 0; i < 30; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Tester is still at work')
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.ok(text(wake).includes('Finished without a closing message: Writer.'))
  assert.ok(!text(wake).includes('Finished without a closing message: Writer and'))
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

// #977: a final reply that announces work while no tool, job or subagent runs is marked
// for the reader, and a local file it links to is checked. Nothing is retried or reworded.
test('a reply announcing work with nothing running is marked, with its missing linked file (#977)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  const missing = join(tmpdir(), `ds-bot-977-${process.pid}-${Date.now()}`, 'report.pptx')
  const long = `正在导出报告到 [report.pptx](<${missing}>)，稍后汇报。${'背景：这一页要沿用上一版的样式和图表。'.repeat(12)}`
  host.finish('gb', long)
  await first.wait()
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.deepEqual(reply.claims, { missingFiles: [missing], inProgress: true })
  assert.equal(host.agentOf('gb').calls.length, 1, 'nothing is retried')
})

// A member that started real work or handed work to a peer is not marked, and an existing file in a spaced folder passes.
test('work that did run, a peer handoff and an existing file in a spaced folder carry no marker (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-file-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const spaced = join(root, 'DS Bot')
  mkdirSync(spaced, { recursive: true })
  const done = join(spaced, 'report.pptx')
  writeFileSync(done, 'x')
  const host = await start(t, { workDir: spaced })
  const first = host.round('c1', host.say('@Chief 导出报告'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 请先导出初稿，我稍后汇报。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '正在导出报告到 [report.pptx](report.pptx)，稍后汇报。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await first.wait()
  for (const reply of first().replies) assert.equal(reply.claims, undefined)
})

// #977 review: the check must use the Session's own folder, the one its header reports
// or DS Bot gave it. A group's folder outranks the member's own, and neither is the team
// folder the old code fell back to.
test('a relative file link is checked in the group folder (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-room-'))
  const group = join(root, 'group')
  const member = join(root, 'member')
  mkdirSync(join(group, 'out'), { recursive: true })
  mkdirSync(member, { recursive: true })
  writeFileSync(join(group, 'out', 'report.pptx'), 'x')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, { workDir: group }, {}, {}, { b: { workDir: member } })
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '报告已导出到 [report.pptx](./out/report.pptx)。')
  await first.wait()
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.equal(reply.claims, undefined)
})

test('a relative file link is checked in the member\'s own folder (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-member-'))
  const member = join(root, 'member')
  mkdirSync(join(member, 'out'), { recursive: true })
  writeFileSync(join(member, 'out', 'report.pptx'), 'x')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, {}, {}, {}, { b: { workDir: member } })
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '报告已导出到 [report.pptx](./out/report.pptx)。')
  await first.wait()
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.equal(reply.claims, undefined)
})

test('a late reply and post_to_group keep missing-file claims when opening a group round', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-post-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, {}, {}, {}, { a: { workDir: root } })
  const missing = join(host.home, 'missing-report.md')
  await rt.lateRoomReply('gb', {}, `Report is at [missing-report.md](<${missing}>).`)
  const post = host.takePost()
  assert.deepEqual(post.source.claims, { missingFiles: [missing] })
  const relay = host.round('claims-late', post)
  await relay.wait()
  const record = logLines(host).find(line => line.text?.includes('missing-report.md'))
  assert.deepEqual(record.claims, { missingFiles: [missing] })
  assert.equal(record.session, true)

  const postedMissing = join(root, 'gone.md').replace(/\\/g, '/')
  await host.tool('post_to_group', { group: 'Ops', message: '请看 [gone.md](./gone.md)' }, 'a', { agent: { id: 'a', session: { header: { cwd: root } } } })
  const fromTool = host.takePost()
  assert.deepEqual(fromTool.source.claims, { missingFiles: [postedMissing] })
})

// Codex on the change line: a late turn that changed files and ended with [PASS] used to
// read the summary and then post nothing on either return path. Its completion line now
// carries the change card; a late pass that changed nothing still posts nothing.
test('a late pass that changed files posts its completion line', async (t) => {
  const host = await start(t)
  const changes = { sessionId: 'gb', seq: 12, turn: 3, total: 1, added: 2, deleted: 0, files: [{ path: 'late.md', added: 2, deleted: 0 }] }
  rt.turnChanges = async () => changes
  await rt.lateRoomReply('gb', {}, '[PASS]', { toolCount: 1 })
  const post = host.takePost()
  assert.equal(post.source.done, true)
  assert.deepEqual(post.source.changes, changes)
  const relay = host.round('late-pass', post)
  await relay.wait()
  const rows = rt.groupRows('r1', 1, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(rows.find(row => row.kind === 'done')?.changes, changes)
})

test('a late pass that changed nothing posts nothing', async (t) => {
  const host = await start(t)
  rt.turnChanges = async () => undefined
  await rt.lateRoomReply('gb', {}, '[PASS]', { toolCount: 1 })
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('the first completed member of a parallel batch keeps its file claim', async (t) => {
  const { host } = await batchInBackground(t)
  const missing = join(host.home, 'missing-report.md')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', `Report is at [missing-report.md](<${missing}>).`)
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  assert.deepEqual(post.source.claims, { missingFiles: [missing] })
})

// A batch is saved with the team, so who still owes whom survives a restart.
test('a call batch is saved with the team while its member works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 整理文档')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  await rt.save()
  const saved = Object.values(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).roomBatches)
  assert.deepEqual(saved.map(batch => [batch.roomId, batch.by, batch.pending, batch.worked]), [['r1', 'a', ['b'], true]])
  host.finish('gb', '文档好了')
})

// After a restart, a member that does not pick its work up again never answers: the batch
// settles without it, and the Bot that asked is woken once with the result that came.
test('after a restart a batch whose last member is gone wakes the caller with the results it has', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const batch = { key: 'k-batch', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], results: [{ name: 'Tester', seq: 3 }], worked: true, answered: false, at: 1 }
  const host = await start(t, { log, seq: 3, shown: 3 }, undefined, undefined, undefined, undefined, { roomBatches: { 'k-batch': batch } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.done, post.source.askedBy, post.source.batch], ['post', true, 'a', 'k-batch'])
  host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const wake = text(host.agentOf('ga').calls[0])
  assert.match(wake, /Tester finished the work you asked for/)
  assert.match(wake, /TESTER-RESULT/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => Object.keys(rt.state.roomBatches).length === 0)
})

test('after a restart a batch nobody finished is dropped without waking anyone', async (t) => {
  const batch = { key: 'k-none', roomId: 'r1', by: 'a', pending: ['b', 'c'], done: [], results: [], worked: false, answered: false, at: 1 }
  const host = await start(t, undefined, undefined, undefined, undefined, undefined, { roomBatches: { 'k-none': batch } })
  await settle(() => Object.keys(rt.state.roomBatches).length === 0)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

// The round runs in DS Bot, not inside the group_relay call: the call returns at once, so
// the group's Session is free and DSH cuts nothing short.
test('the relay call returns at once and the round goes on without it', async (t) => {
  const host = await start(t)
  host.emit('r1', 'user/message', host.say('@Writer 整理文档'))
  const value = await host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: new AbortController().signal })
  assert.deepEqual(Object.keys(JSON.parse(value)), ['from', 'anchor'])
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length, 1)
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await settle(() => rt.roomRounds('r1').length === 0)
  const { from } = JSON.parse(value)
  assert.deepEqual(rt.groupRows('r1', from).map(row => row.text), ['整理好了。'])
})

// A message the user sends while a round runs joins that round; what is said after it
// shows under it.
test('a message sent while a round runs joins it, and the rows after it show under it', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const second = host.round('c2', host.say('@Writer 你也看看'))
  // One round in the group: the second message called Writer in it.
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length, 1)
  host.begin('gb')
  host.finish('gb', '我看过了。')
  host.finish('ga', '安排好了。')
  await Promise.all([first.wait(), second.wait()])
  assert.deepEqual(first().replies, [])
  assert.deepEqual(second().replies.map(row => [row.name, row.text]), [['Writer', '我看过了。'], ['Chief', '安排好了。']])
  assert.deepEqual(logLines(host).map(line => line.who), ['User', 'User', 'Writer', 'Chief'])
})

// A post that waits for the next round (a goal post, an image, the greeting) does not
// start one after the user stopped the group: it goes with the group's next message.
test('a post waiting for the next round does not start one after the user stops the group', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  assert.equal((await host.call('goal-draft', { roomId: 'r1', text: 'Ship v1' })).ok, true)
  const at = host.agentOf('r1').calls.findIndex(call => call.source?.role === 'goal')
  const [draft] = host.agentOf('r1').calls.splice(at, 1)
  host.round('c2', { content: draft.content, source: draft.source })
  await settle(() => true)
  rt.stopRoomRound('r1')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await first.wait()
  assert.equal(host.agentOf('ga').calls.length, 0, 'nothing started after the stop')
  assert.equal(rt.roomActive('r1'), false)
  // The group's next message takes the draft with it: the admin is called for the goal.
  host.round('c3', host.say('继续'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /the user wants to set a goal/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
})

// While a round finishes (goal check, save), the group is still taken: a message that comes
// in then opens the next round once this one is done, never a second round beside it.
test('a message that comes in while a round finishes waits for it, and no two rounds run', async (t) => {
  const host = await start(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const drive = rt.goalDrive
  rt.goalDrive = async (...args) => { await gate; return drive?.(...args) }
  const first = host.round('c1', host.say('@Writer 写一句'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomActive('r1') && [...rt.roomProgress.values()].every(round => round.roomId !== 'r1'))
  const second = host.round('c2', host.say('@Tester 看一下'))
  await settle(() => true)
  assert.equal(host.agentOf('gc').calls.length, 0, 'the finishing round still holds the group')
  release()
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length <= 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await Promise.all([first.wait(), second.wait()])
  assert.deepEqual(second().replies.map(row => row.text), ['看过了。'])
})

// Two calls with nothing said between them start at the same seq: each shows only its own rows.
test('two calls that start at the same seq each show only their own rows', async (t) => {
  await start(t)
  rt.ledger.append('group-r1', { event: 'anchor', id: 'one', from: 1, time: 1 })
  rt.ledger.append('group-r1', { event: 'anchor', id: 'two', from: 1, time: 2 })
  rt.logRoom(rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: '回答第二次' })
  assert.deepEqual(rt.groupRows('r1', 1, undefined, 'one'), [])
  assert.deepEqual(rt.groupRows('r1', 1, undefined, 'two').map(row => row.text), ['回答第二次'])
})

// The newest cell is read every second only while the group works.
test('the rows of the newest call say whether the group is still at work', async (t) => {
  const host = await start(t)
  host.emit('r1', 'user/message', host.say('@Writer 写一句'))
  const { from, anchor } = JSON.parse(await host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: new AbortController().signal }))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const busy = (await host.call('group-rows', { roomId: 'r1', from, anchor })).value
  assert.deepEqual([busy.open, busy.active], [true, true])
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomRounds('r1').length === 0)
  const quiet = (await host.call('group-rows', { roomId: 'r1', from, anchor })).value
  assert.deepEqual([quiet.open, quiet.active, quiet.rows.map(row => row.text)], [true, false, ['写好了。']])
})

// The member that finished was renamed before the restart: its result still wakes the
// Bot that asked, carried by that member.
test('after a restart a batch whose finished member was renamed still wakes the caller', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const batch = { key: 'k-renamed', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], doneIds: ['c'], results: [{ name: 'Tester', seq: 3 }], worked: true, answered: false, at: 1 }
  const host = await start(t, { log, seq: 3 }, undefined, undefined, { c: { name: 'QA' } }, undefined, { roomBatches: { 'k-renamed': batch } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.senderSessionId, post.source.done, post.source.askedBy], ['c', true, 'a'])
})

// A member whose work a restart left is picked up again with a message its turn has not
// taken yet: it still works for the batch, so the batch keeps waiting for it.
test('after a restart a member whose pick-up is still queued keeps its batch waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const batch = { key: 'k-queued', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], doneIds: ['c'], results: [], worked: true, answered: false, at: 1 }
  const note = { at: 1, args: { toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', note: 'your turn', text: '整理文档', exchangeId: 'x-queued', askedBy: 'a' } }
  const host = await start(t, undefined, undefined, undefined, undefined, undefined, { roomBatches: { 'k-queued': batch } }, { 'inflight.json': { turns: {}, queued: { gb: [note] } } })
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('gb').calls.length === 1)
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rt.state.roomBatches['k-queued']?.pending, ['b'])
  assert.equal(host.agentOf('r1').calls.length, 0, 'the caller is not woken before the member answers')
})

// Stop all while a round finishes: what waited on it does not start once it is done.
test('stopping a group while its round finishes starts nothing afterwards', async (t) => {
  const host = await start(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const drive = rt.goalDrive
  rt.goalDrive = async (...args) => { await gate; return drive?.(...args) }
  const first = host.round('c1', host.say('@Writer 写一句'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomActive('r1') && [...rt.roomProgress.values()].every(round => round.roomId !== 'r1'))
  host.round('c2', host.say('@Tester 看一下'))
  await settle(() => true)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  release()
  await first.wait()
  await settle(() => !rt.roomActive('r1'))
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('gc').calls.length, 0, 'nothing started after the stop')
})

test('post_to_group defaults to reporting back once finished, and report_back false opts out', async (t) => {
  const host = await start(t)
  const postedDefault = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 快速核对一下' }, 'a')
  assert.match(postedDefault, /final outcome also comes back to you/)
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '核对完毕，一切正常。')
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Writer: 核对完毕，一切正常。/)

  const postedQuiet = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 仅通知', report_back: false }, 'a')
  assert.match(postedQuiet, /nothing comes back to you/)
  const second = host.round('c2', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '收到通知。')
  await second.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 1, 'report_back false sends nothing back to the caller')
})

test('post_to_group from Chief outside a group waits across >15s parallel work, batch wake, and admin summary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c', 'd'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc', d: 'ld' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab }, { d: { id: 'd', name: 'Reviewer', role: 'Review', sessionId: 'd', createdAt: 4 } })
  // Chief ('a') is NOT in Lab; Lead ('b') is admin, Tester ('c') and Reviewer ('d') are members.
  await host.tool('post_to_group', { group: 'Lab', intent: 'request', message: '完成重构并验证' }, 'a')
  const opening = host.agentOf('r2').calls.shift()
  const round1 = host.round('l1', { content: opening.content, source: opening.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 1)
  host.begin('lb')
  host.finish('lb', '@Tester 跑测试 @Reviewer 做代码审查')
  await settle(() => host.agentOf('lc').calls.length === 1 && host.agentOf('ld').calls.length === 1)
  host.begin('lc')
  host.begin('ld')
  host.emit('lc', 'tool/call', { callId: 'tc1', name: 'pwsh', arguments: '{}' })
  host.emit('ld', 'tool/call', { callId: 'td1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await round1.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'must not cut off Chief while members are still working past 15s')

  // Tester finishes first (quiet post while Reviewer still works).
  host.emit('lc', 'tool/result', { callId: 'tc1' })
  host.finish('lc', '测试全绿（128/128）。')
  await settle(() => host.agentOf('r2').calls.length === 1)
  const post2 = host.agentOf('r2').calls.shift()
  const round2 = host.round('l2', { content: post2.content, source: post2.source }, 'r2')
  await round2.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'must still wait while Reviewer and admin batch are pending')

  // Reviewer finishes second -> wakes admin Lead -> Lead posts final summary.
  host.emit('ld', 'tool/result', { callId: 'td1' })
  host.finish('ld', '审查通过，无阻断问题。')
  await settle(() => host.agentOf('r2').calls.length === 1)
  const post3 = host.agentOf('r2').calls.shift()
  const round3 = host.round('l3', { content: post3.content, source: post3.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 2)
  host.begin('lb')
  host.finish('lb', '全部验收通过：测试 128/128 且代码审查无阻断问题，可以交付。')
  await round3.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /\[Group chat "Lab" · replies to your post\]/)
  assert.match(report, /Tester: 测试全绿（128\/128）。/)
  assert.match(report, /Reviewer: 审查通过，无阻断问题。/)
  assert.match(report, /Writer: 全部验收通过：测试 128\/128 且代码审查无阻断问题，可以交付。/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('post_to_group directly naming a member when Chief is outside the group still reports the late reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  await host.tool('post_to_group', { group: 'Lab', message: '@Tester 查一下报错日志' }, 'a')
  const opening = host.agentOf('r2').calls.shift()
  const round1 = host.round('l1', { content: opening.content, source: opening.source }, 'r2')
  await settle(() => host.agentOf('lc').calls.length === 1)
  host.begin('lc')
  host.emit('lc', 'tool/call', { callId: 'tc1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await round1.wait()
  assert.equal(host.agentOf('a').calls.length, 0)

  host.emit('lc', 'tool/result', { callId: 'tc1' })
  host.finish('lc', '日志定位完成：缺少 API_URL 环境变量。')
  await settle(() => host.agentOf('r2').calls.length === 1)
  const post2 = host.agentOf('r2').calls.shift()
  const round2 = host.round('l2', { content: post2.content, source: post2.source }, 'r2')
  await round2.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Tester: 日志定位完成：缺少 API_URL 环境变量。/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('stopping, deleting, or restarting a group settles pending roomReports instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 1) Stop settles pending report with stopped note.
  const host1 = await start(t)
  await host1.tool('post_to_group', { group: 'Ops', message: '@Writer 跑长任务' }, 'a')
  const r1 = host1.round('c1', host1.takePost())
  await settle(() => host1.agentOf('gb').calls.length === 1)
  host1.begin('gb')
  host1.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await r1.wait()
  assert.equal(host1.agentOf('a').calls.length, 0)
  await host1.call('stop-room-work', { roomId: 'r1' })
  host1.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host1.agentOf('a').calls.length === 1)
  assert.match(text(host1.agentOf('a').calls[0]), /stopped before finishing/)

  // 2) Delete settles pending report immediately.
  const host2 = await start(t)
  await host2.tool('post_to_group', { group: 'Ops', message: '@Writer 跑另一个长任务' }, 'a')
  const r2 = host2.round('c1', host2.takePost())
  await settle(() => host2.agentOf('gb').calls.length === 1)
  host2.begin('gb')
  host2.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await r2.wait()
  assert.equal(host2.agentOf('a').calls.length, 0)
  assert.equal((await host2.call('delete-room', { id: 'r1' })).ok, true)
  await settle(() => host2.agentOf('a').calls.length === 1)
  assert.match(text(host2.agentOf('a').calls[0]), /was deleted before it finished/)

  // 3) Restart reconciliation settles persisted tracking report with logged replies.
  const log = [{ seq: 1, who: 'Chief', botId: 'a', text: '@Writer 查一下', session: true }, { seq: 2, who: 'Writer', botId: 'b', text: '重启前已写好的结论。' }]
  const persisted = { rep1: { id: 'rep1', roomId: 'r1', botId: 'a', name: 'Chief', status: 'tracking', fromSeq: 2, passed: [], failed: [], at: 1 } }
  const host3 = await start(t, { log, seq: 2 }, undefined, undefined, undefined, undefined, { roomReports: persisted })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host3.agentOf('a').calls.length === 1)
  assert.match(text(host3.agentOf('a').calls[0]), /Writer: 重启前已写好的结论。/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})

  // 4) Restart reconciliation of a persisted queued report reports never-started and never dumps seq 1..N history.
  const oldLog = [
    { seq: 1, who: 'User', text: '旧问题' },
    { seq: 2, who: 'Writer', botId: 'b', text: '不该泄露的旧历史回答。' },
  ]
  const queuedOnly = { repQ: { id: 'repQ', roomId: 'r1', botId: 'a', name: 'Chief', status: 'queued', passed: [], failed: [], at: 1 } }
  const host4 = await start(t, { log: oldLog, seq: 2 }, undefined, undefined, undefined, undefined, { roomReports: queuedOnly })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host4.agentOf('a').calls.length === 1)
  const queuedMsg = text(host4.agentOf('a').calls[0])
  assert.match(queuedMsg, /did not start before DS Bot restarted/)
  assert.doesNotMatch(queuedMsg, /不该泄露的旧历史回答/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('ordinary member post_to_group without @mention stays quiet and rejects report_back: true (#1894)', async (t) => {
  const host = await start(t)
  const quiet = await host.tool('post_to_group', { group: 'Ops', message: '同步一下进展，无需回复' }, 'b')
  assert.match(quiet, /Nobody answers it/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
  host.agentOf('r1').calls.length = 0
  const refused = await host.tool('post_to_group', { group: 'Ops', message: '同步一下进展', report_back: true }, 'b')
  assert.match(refused, /Nobody would answer/)
  assert.equal(host.agentOf('r1').calls.length, 0, 'refused report_back: true post must not be posted')
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('stop-room-work with active group_goal and queued report settles cleanly without hanging (#1894)', async (t) => {
  const host = await start(t)
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Writer', task: 'build' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Ship v3', objective: 'Deliver', acceptance: 'green', stages: oneStage }, 'ga'), /Started\./)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 帮我跑一下' }, 'a')
  assert.equal(Object.values(rt.state.roomReports).length, 1)
  assert.equal(Object.values(rt.state.roomReports)[0].status, 'queued')

  // Stopping the group via channel endpoint sets goal.idle and settles even queued reports.
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.equal(rt.roomOf('r1').goal.idle, true)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('mid-round post_to_group held by idlePaused reports paused instead of hanging or saying nobody replied (#1894)', async (t) => {
  const { host, first } = await busyRound(t)
  const room = rt.roomOf('r1')
  room.idlePaused = { at: Date.now(), count: 3, limit: 3, by: 'Writer', pending: [] }
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 收到，待命' }, 'a')
  assert.equal(host.agentOf('gc').calls.length, 0, 'idle status post must be held while idlePaused')
  host.finish('gb', '整理好了。')
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const msg = text(host.agentOf('a').calls[0])
  assert.match(msg, /Paused in "Ops"/)
  assert.doesNotMatch(msg, /Nobody replied/)
})

test('deleting a working group member settles pending roomReports cleanly (#1894)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 跑个耗时检查' }, 'a')
  const round = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await round.wait()
  assert.equal(host.agentOf('a').calls.length, 0)

  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('scoped mid-round post_to_group expands report.ids when called member starts a new round via progress @mention (#1894)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, first } = await busyRound(t)
  // Chief posts mid-round calling Tester ('c') -> scoped report with ids: ['c'].
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 核对并找同事复核' }, 'a')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k-c', name: 'pwsh', arguments: '{}' })
  // First round moves on past Writer + Tester; Writer finishes.
  host.finish('gb', 'Writer 完成无关任务。')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  assert.equal(host.agentOf('a').calls.length, 0, 'scoped report must wait for Tester')

  // While no round is running, Tester sends a progress post calling Writer ('b') -> runRoundFrom expands report.ids!
  await rt.roomStepText('gc', {}, '@Writer 帮我复核一下结果')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const progressPost = host.takePost()
  const round2 = host.round('c2', progressPost)
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k-b2', name: 'pwsh', arguments: '{}' })
  // Round 2 moves on past Writer (>15s); Tester finishes while Writer is still working on the expanded call.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await round2.wait()
  host.emit('gc', 'tool/result', { callId: 'k-c' })
  host.finish('gc', '已交 Writer 复核。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const testerLate = host.takePost()
  const round2b = host.round('c2b', testerLate)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await round2b.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'expanded scoped report must wait for Writer')

  host.emit('gb', 'tool/result', { callId: 'k-b2' })
  host.finish('gb', '复核通过，数据一致。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const latePost = host.takePost()
  const round3 = host.round('c3', latePost)
  // Writer was called by Tester -> round3 wakes Tester with Writer's review.
  await settle(() => host.agentOf('gc').calls.length === 2)
  host.begin('gc')
  host.finish('gc', '收到复核结果，全部通过。')
  await round3.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Writer: 复核通过，数据一致。/)
  assert.match(report, /Tester: 收到复核结果，全部通过。/)
})

test('concurrent post_to_group posts do not leak the second opening post as a reply to the first (#1894)', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 第一个任务' }, 'a')
  const firstPost = host.takePost()
  const round = host.round('c1', firstPost)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  // Second post arrives while the first round is still running.
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 第二个并发任务', report_back: false }, 'a')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gb', '第一个任务完成。')
  host.finish('gc', '第二个任务完成。')
  await round.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Writer: 第一个任务完成。/)
  assert.doesNotMatch(report, /第二个并发任务/, 'second opening post must not appear as a reply to the first report')
})

test('roomRelayDiscarded ignores part-switch inbox moves and only settles genuine discards on the current room Session (#1894)', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  const fireDiscarded = (sessionId, message) => {
    for (const listener of host.ctx.listeners.get('agent/inbox/discarded') ?? []) {
      listener({ agent: { id: sessionId, session: { id: sessionId } }, message })
    }
  }

  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 跑一下检查' }, 'a')
  const post = host.takePost()
  const reportId = post.source.reportId
  rt.state.roomReports[reportId].imOrigin = { connId: 'c1', chatKey: 'dm-u1', senderId: 'u1', binding: 'bot:a' }

  // 1) Room moved to a new part 'r1-p2'; old part 'r1' removing the forwarded inbox message must NOT settle or drop imOrigin.
  room.sessionId = 'r1-p2'
  fireDiscarded('r1', post)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'earlier-part inbox removal must not settle queued report')
  assert.equal(rt.state.roomReports[reportId]?.status, 'queued')
  assert.deepEqual(rt.state.roomReports[reportId]?.imOrigin, { connId: 'c1', chatKey: 'dm-u1', senderId: 'u1', binding: 'bot:a' })

  // 2) While room's own Session is marked switching, inbox discard must NOT settle either.
  rt.state.switching['r1-p2'] = { roomId: 'r1' }
  fireDiscarded('r1-p2', post)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'discard while room Session switches must not settle queued report')
  assert.equal(rt.state.roomReports[reportId]?.status, 'queued')
  delete rt.state.switching['r1-p2']

  // 3) Genuine discard on the current non-switching room Session settles the queued report cleanly.
  fireDiscarded('r1-p2', post)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('stop-room-work with active group_goal and idle tracking report preserves the stopped note (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  await host.tool('post_to_group', { group: 'Lab', intent: 'request', message: '开目标推进发布' }, 'a')
  const post = host.agentOf('r2').calls.shift()
  const round = host.round('c1', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 1)
  host.begin('lb')
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Ship v4', objective: 'Deliver', acceptance: 'green', stages: oneStage }, 'lb'), /Started\./)
  host.finish('lb', '目标已启动，等待继续推进。')
  await round.wait()
  // Drain the goal-check nudge queued by goalDrive so only the active goal holds the tracking report open.
  const nudge = host.agentOf('r2').calls.shift()
  if (nudge?.source?.exchangeId) rt.roomRelayTaken('r2', nudge.source.exchangeId)
  assert.equal(host.agentOf('a').calls.length, 0, 'active goal holds tracking report open')

  // Stopping the group marks report.stopped BEFORE goalUserStopped triggers settleRoomReports.
  assert.equal((await host.call('stop-room-work', { roomId: 'r2' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before finishing/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('stop-room-work withdraws queued post_to_group relays while preserving deferred user images (#1894)', async (t) => {
  const host = await start(t)
  const roomAgent = host.agentOf('r1')
  const origFollowup = roomAgent.followup.bind(roomAgent)
  let seq = 0
  roomAgent.inbox = {
    nextStep: [],
    nextTurn: [],
    remove(id) {
      for (const lane of [this.nextStep, this.nextTurn]) {
        const idx = lane.findIndex(item => item.id === id)
        if (idx !== -1) { lane.splice(idx, 1); return true }
      }
      return false
    },
  }
  roomAgent.followup = (message) => {
    const entry = { ...message, id: `rm${++seq}` }
    origFollowup(entry)
    roomAgent.inbox.nextTurn.push(entry)
  }

  // Start a running round and queue a user image message into laterPosts.
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.round('c-img', {
    content: [
      { type: 'text', text: '@Tester 看这张截图' },
      { type: 'image', attachment: { attachmentId: 'img-1', mimeType: 'image/png', name: 'shot.png' } },
    ],
    source: { kind: 'user' },
  })
  await settle(() => true)
  // Also queue a post_to_group directly into the room's inbox (simulating a queued relay).
  const queuedPost = {
    content: [{ type: 'text', text: '[Group post from Chief]\n@Tester 不要再跑的任务' }],
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-stop-1', reportId: 'rep-stop-1', reportBack: true, senderName: 'Chief', senderSessionId: 'a', roomId: 'r1' },
  }
  rt.state.roomReports['rep-stop-1'] = { id: 'rep-stop-1', roomId: 'r1', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 2, passed: [], failed: [], at: Date.now() }
  rt.noteRoomRelayQueued('r1', 'ex-stop-1')
  roomAgent.followup(queuedPost)
  // Also queue a terminal batchEnd late reply whose empty batch must close when Stop All cancels it.
  rt.state.roomBatches['b-done'] = { key: 'b-done', roomId: 'r1', by: 'a', pending: [], done: ['Writer'], doneIds: ['b'], results: [], worked: true, answered: false, at: Date.now() }
  roomAgent.followup({
    content: [{ type: 'text', text: '[Group post from Writer]\n迟到答复' }],
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-batch-end', late: true, batch: 'b-done', batchEnd: true, senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
  })
  assert.equal(roomAgent.inbox.nextTurn.length, 2)

  // Stop All withdraws the queued Bot post and settles its report once, without dropping the user's screenshot.
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.equal(roomAgent.inbox.nextTurn.some(item => item.source?.exchangeId === 'ex-stop-1'), false, 'queued Bot relay must be withdrawn from room inbox')
  assert.equal(rt.state.roomBatches['b-done'], undefined, 'cancelled terminal batchEnd reply must close its empty batch')

  // Even if the stopped relay was already claimed before removal, replaying it skips the stopped
  // Bot post while bringing back ONLY the preserved user screenshot from laterPosts!
  const replay = host.round('c-replay', queuedPost)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.agentOf('gc').calls[0]), /看这张截图/)
  assert.doesNotMatch(text(host.agentOf('gc').calls[0]), /不要再跑的任务/)
  host.begin('gc')
  host.finish('gc', '看到截图了。')
  await replay.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 1, 'cancelled Bot relay must not send a second report')
})

test('group background task delegating to its own group via post_to_group settles without self-deadlock (#1894)', async (t) => {
  const host = await start(t)
  const writer = rt.botOf('b')
  writer.tasks = [{
    id: 'task-self-1',
    title: 'Prepare release',
    roomId: 'r1',
    from: 'gb',
    sessionId: 'bt-self-1',
    segments: [],
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }]
  rt.chatOwners.set('bt-self-1', 'b')
  rt.taskOwners.set('bt-self-1', { botId: 'b', taskId: 'task-self-1', roomId: 'r1' })
  // Also simulate the realistic parent roomBatch held open while Writer's background task runs.
  rt.state.roomBatches['b-parent'] = { key: 'b-parent', roomId: 'r1', by: 'a', pending: ['b'], done: [], doneIds: [], results: [], worked: true, answered: false, at: Date.now() }

  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 帮我复核一下' }, 'bt-self-1')
  const post = host.takePost()
  assert.equal(rt.state.roomReports[post.source.reportId]?.fromTaskId, 'task-self-1')
  const round = host.round('c1', post)
  await until(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '复核通过。')
  await until(() => round() !== undefined)
  await until(() => host.agentOf('bt-self-1').calls.length === 1)
  assert.match(text(host.agentOf('bt-self-1').calls[0]), /Tester: 复核通过。/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('post_to_group reports waiting-for-user-answer when a named member opens ask_user while its batch stays pending (#1894)', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 帮我确认发布版本' }, 'a')
  const post = host.takePost()
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  // Writer opens a question card (waiting for user answer) and ends its turn.
  rt.state.questions.gb = { id: 'q-rel', prompt: '选择发布版本', options: ['v1', 'v2'], at: Date.now() }
  host.finish('gb', '请先选择发布版本。')
  await round.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Waiting for the user's answer in "Ops": Writer\./)
  assert.doesNotMatch(report, /Nobody replied/)
  // The intra-group batch remains pending so the user's later answer still wakes Chief.
  assert.ok(Object.values(rt.state.roomBatches).some(batch => batch.roomId === 'r1' && batch.pending.includes('b')))
})

test('scoped mid-round post_to_group expands report.ids when memberTurn wakes the batch caller in the same round (#1894)', async (t) => {
  const { host, first } = await busyRound(t)
  // Chief posts mid-round calling Tester ('c') -> scoped report with ids: ['c'].
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 跑完测试汇报给我' }, 'a')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k-test', name: 'pwsh', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k-test' })
  // Tester worked and finishes inside the same round -> memberTurn wakes Chief ('ga') to summarize!
  host.finish('gc', '测试全部通过。')
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '群内总结：测试通过，可以合入。')
  host.finish('gb', 'Writer 完成无关文档。')
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Tester: 测试全部通过。/)
  assert.match(report, /Chief: 群内总结：测试通过，可以合入。/)
  assert.doesNotMatch(report, /Writer 完成无关文档/)
})

test('startup settleRoomReports keeps queued reports still present in roomAgent.inbox and settles once after the round runs (#1894)', async (t) => {
  const host = await start(t)
  const roomAgent = host.agentOf('r1')
  roomAgent.inbox = { nextStep: [], nextTurn: [] }
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 重载前排队的消息' }, 'a')
  const queuedPost = host.takePost()
  const reportId = queuedPost.source.reportId
  // Simulate plugin reload: in-memory queuedRelays was cleared, while DSH still holds the message in roomAgent.inbox.
  rt.roomRelayTaken('r1', queuedPost.source.exchangeId)
  roomAgent.inbox.nextTurn.push({ id: 'live-q1', ...queuedPost })

  // 1) Room has BOTH surviving report A (in roomAgent.inbox) AND vanished report B (not in inbox):
  //    startup must preserve A AND settle vanished B in the same pass without letting A hide B!
  rt.state.roomReports['rep-vanished'] = { id: 'rep-vanished', roomId: 'r1', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 2, passed: [], failed: [], at: Date.now() }
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /did not start before DS Bot restarted/, 'vanished sibling report must settle even while another relay survives in inbox')
  assert.equal(rt.state.roomReports['rep-vanished'], undefined)
  assert.equal(rt.state.roomReports[reportId]?.status, 'queued', 'surviving relay must stay queued')

  // 2) Now DSH drains the inbox and runs the real round -> Chief receives the real reply for A once.
  roomAgent.inbox.nextTurn.length = 0
  const round = host.round('c-reload', queuedPost)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '重载后正常完成。')
  await round.wait()
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.match(text(host.agentOf('a').calls[1]), /Writer: 重载后正常完成。/)
  assert.doesNotMatch(text(host.agentOf('a').calls[1]), /did not start before DS Bot restarted/)

  // 3) Plugin reload AFTER user/message was already emitted (old plugin's roomInbox was lost):
  //    startup must NOT strand the report forever.
  roomAgent.status = 'running'
  roomAgent.session = {
    id: 'r1',
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'user/message', data: { source: { kind: 'bot', role: 'post', reportId: 'rep-after-um' } } },
    ],
  }
  rt.state.roomReports['rep-after-um'] = { id: 'rep-after-um', roomId: 'r1', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 3, passed: [], failed: [], at: Date.now() }
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host.agentOf('a').calls.length === 3)
  assert.match(text(host.agentOf('a').calls[2]), /did not start before DS Bot restarted/)
  assert.equal(rt.state.roomReports['rep-after-um'], undefined)

  // 4) Plugin reload DURING DSH preStep window (status: 'running', turn/start emitted, NO user/message yet):
  //    startup holds the report until the turn settles, then automatically re-checks via whenIdle().
  let releasePreStep
  roomAgent.status = 'running'
  roomAgent.session = {
    id: 'r1',
    snapshotEvents: () => [{ type: 'turn/start', data: { turn: 6 } }],
  }
  roomAgent.whenIdle = () => new Promise((resolve) => { releasePreStep = resolve })
  rt.state.roomReports['rep-prestep'] = { id: 'rep-prestep', roomId: 'r1', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 3, passed: [], failed: [], at: Date.now() }
  await rt.settleRoomReports(undefined, { startup: true })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 3, 'preStep window must hold queued report until turn finishes')
  assert.equal(rt.state.roomReports['rep-prestep']?.status, 'queued')

  // If the preStep turn belonged to something else and ends without claiming rep-prestep, whenIdle recheck settles it!
  roomAgent.status = 'idle'
  releasePreStep()
  await settle(() => host.agentOf('a').calls.length === 4)
  assert.match(text(host.agentOf('a').calls[3]), /did not start before DS Bot restarted/)
  assert.equal(rt.state.roomReports['rep-prestep'], undefined)
})

test('stopping an individual working member via stopMemberWork reports stopped instead of nobody replied (#1894)', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 帮我跑长时间构建' }, 'a')
  const post = host.takePost()
  const round = host.round('c-stop-member', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')

  // User clicks Stop on Writer alone in Group Details before Writer writes any reply.
  assert.equal(await rt.stopMemberWork('r1', 'b'), true)
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await round.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Stopped before finishing: Writer\./)
  assert.doesNotMatch(report, /Nobody replied/)
  assert.doesNotMatch(report, /Stayed silent: Writer/)
})

test('startup settleRoomReports does not re-insert a relay consumed while resolving another room (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const opsAgent = host.agentOf('r1')
  opsAgent.inbox = { nextStep: [], nextTurn: [] }
  const labAgent = host.agentOf('r2')
  labAgent.inbox = { nextStep: [], nextTurn: [] }

  // Queue a live post on r1 (Ops), then clear in-memory queuedRelays to simulate reload.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 启动并发恢复测试' }, 'a')
  const opsPost = host.takePost()
  rt.roomRelayTaken('r1', opsPost.source.exchangeId)
  opsAgent.inbox.nextTurn.push({ id: 'live-ops-1', ...opsPost })

  // Add a second queued report on r2 (Lab) whose resolveAgent pauses mid-startup loop.
  rt.state.roomReports['rep-lab-missing'] = { id: 'rep-lab-missing', roomId: 'r2', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 1, passed: [], failed: [], at: Date.now() }
  let releaseLabResolve
  const origResolve = rt.resolveAgent
  rt.resolveAgent = async (sid) => {
    if (sid === 'r2') await new Promise((resolve) => { releaseLabResolve = resolve })
    return origResolve(sid)
  }

  const startupPromise = rt.settleRoomReports(undefined, { startup: true })
  await settle(() => releaseLabResolve !== undefined)

  // While startup awaits Lab's resolveAgent, Ops consumes its recovered relay and finishes its round!
  opsAgent.inbox.nextTurn.length = 0
  const opsRound = host.round('c-ops-race', opsPost)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '并发恢复后正常完成。')
  await opsRound.wait()

  // Now release Lab's resolveAgent and finish startup. Ops's report must NOT be blocked by a stale re-inserted relay!
  rt.resolveAgent = origResolve
  releaseLabResolve()
  await startupPromise
  await settle(() => host.agentOf('a').calls.length === 2)
  const texts = host.agentOf('a').calls.map(text)
  assert.ok(texts.some(msg => msg.includes('Writer: 并发恢复后正常完成。')), 'Ops report must settle cleanly instead of hanging on a stale re-inserted relay')
  assert.ok(texts.some(msg => msg.includes('did not start before DS Bot restarted')), 'Lab vanished report must still settle')
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('startup settleRoomReports preserves a queued report deferred into laterPosts during finalizing (#1894)', async (t) => {
  const host = await start(t)
  let releaseFinalizing
  const gate = new Promise((resolve) => { releaseFinalizing = resolve })
  const origDrive = rt.goalDrive
  rt.goalDrive = async (...args) => { await gate; return origDrive?.(...args) }

  // Run Round 1 and hold it in finalizing.
  const first = host.round('c-fin-1', host.say('@Writer 先完成第一轮'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '第一轮结束。')
  await settle(() => rt.roomActive('r1') && [...rt.roomProgress.values()].every(round => round.roomId !== 'r1'))

  // While r1 is finalizing, Chief posts with report_back: true and saved imOrigin, and group_relay moves it to laterPosts.
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 延迟进入下一轮的任务' }, 'a')
  const deferredPost = host.takePost()
  const reportId = deferredPost.source.reportId
  const savedOrigin = { connId: 'c1', chatKey: 'dm-u1', senderId: 'u1', binding: 'bot:a' }
  rt.state.roomReports[reportId].imOrigin = savedOrigin
  host.emit('r1', 'user/message', deferredPost)
  await host.tool('group_relay', {}, 'r1', { callId: 'c-fin-2', signal: new AbortController().signal })
  assert.equal(rt.state.roomReports[reportId]?.status, 'queued')

  // Startup reconciliation runs while the post sits in laterPosts -> must preserve report & imOrigin!
  await rt.settleRoomReports(undefined, { startup: true })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'deferred post in laterPosts must not falsely fail as never-started')
  assert.equal(rt.state.roomReports[reportId]?.status, 'queued')
  assert.deepEqual(rt.state.roomReports[reportId]?.imOrigin, savedOrigin)

  // Release finalizing -> Round 2 starts from laterPosts -> Tester answers -> Chief gets the real report!
  releaseFinalizing()
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '延迟任务已完成。')
  await first.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Tester: 延迟任务已完成。/)
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('instant work tools record worked without 15s grace yield, while read_document yields past grace and bgRunning marks slot worked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 1) group_todo (instant work tool): does NOT arm grace timer, DOES set worked/batch.worked, clears idleEdges, and wakes caller.
  {
    const host = await start(t)
    const r1 = rt.roomOf('r1')
    r1.idleEdges = ['a->b', 'b->a']
    const first = host.round('c-inst', host.say('@Chief assign Writer'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer add the todo item')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'tc-todo', name: 'group_todo', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'tc-todo', name: 'group_todo', isError: false, content: [] })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(first(), undefined, 'instant work tool must not arm the 15s grace timer')
    assert.equal(r1.idleEdges, undefined, 'instant work tool must clear idleEdges')
    // Writer replies without naming @Chief -> batch.worked is true so Chief is woken in the same round!
    host.finish('gb', 'Added the todo item.')
    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Got it, thanks.')
    await first.wait()
  }

  // 2) read_document (substantive non-instant work tool): DOES arm 15s grace timer and yields with working row.
  {
    const host = await start(t)
    const first = host.round('c-doc', host.say('@Writer read the spec'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'tc-doc', name: 'read_document', arguments: '{}' })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
    await first.wait()
    assert.ok(kinds(first()).some(([kind, who]) => kind === 'working' && who === 'Writer'), 'read_document must yield after grace')
  }

  // 3) bgRunning branch: member finishes with active group background task and 0 direct tool events -> clears idleEdges and yields working.
  {
    const host = await start(t)
    const r1 = rt.roomOf('r1')
    r1.idleEdges = ['a->b']
    rt.botOf('b').tasks = [{
      id: 'bt-bg-1', title: 'Index docs', sessionId: 'bt-bg-sess', status: 'running',
      roomId: 'r1', fromPart: 'gb', startedAt: Date.now(), updatedAt: Date.now(),
    }]
    rt.taskOwners.set('bt-bg-sess', { botId: 'b', taskId: 'bt-bg-1', roomId: 'r1' })
    const first = host.round('c-bg', host.say('@Writer start background job'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Background job is running.')
    await first.wait()
    assert.equal(r1.idleEdges, undefined, 'bgRunning must clear idleEdges as real work')
    assert.ok(kinds(first()).some(([kind, who]) => kind === 'working' && who === 'Writer'))
  }
})

test('pause notices reflect cycle vs zero-work causes, alreadyPaused re-announces new explicit mentions, stopRoomWork clears paused calls, and releaseParked merges by caller', async (t) => {
  // 1) Distinct cycle notice + alreadyPaused re-announce for a new explicit @mention + stopRoomWork clears room.paused/idlePaused.
  {
    const host = await start(t, {}, undefined, {}, { d: {} })
    const r1 = rt.roomOf('r1')
    r1.members.push('d')
    r1.sessions.d = 'gd'
    rt.groupOwners.set('gd', { botId: 'd', roomId: 'r1' })

    const first = host.round('c-cyc', host.say('@Chief start'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer check section one')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', '@Tester please check section two')
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.finish('gc', '@Chief please double-check paragraph two now')
    await first.wait()

    const notices1 = r1.log.filter(line => line.kind === 'notice' && line.reason === 'paused')
    assert.equal(notices1.length, 1)
    assert.equal(notices1[0].cause, 'cycle')
    assert.ok(r1.paused?.some(entry => entry.id === 'a'))
    assert.match(await host.tool('read_group_chat', { group: 'Ops' }, 'a'), /looped without running any work tool/)

    // While already paused, Tester posts a zero-work message explicitly calling a NEW peer (@Reviewer) -> must re-announce!
    const r2 = host.round('c-cyc-2', {
      content: [{ type: 'text', text: '[Group post from Tester]\n@Reviewer please take a look' }],
      source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-p2', senderName: 'Tester', senderSessionId: 'c', roomId: 'r1' },
    })
    // Wait: a fresh post from Tester opens a round calling Reviewer if not idle, OR in-round Bot-to-Bot call:
    // Use Reviewer speaking in-round with zero work calling a new unparked peer (@Tester) while alreadyPaused:
    await settle(() => host.agentOf('gd').calls.length === 1)
    host.begin('gd')
    host.finish('gd', '@Writer please review my notes')
    await r2.wait()
    const notices2 = r1.log.filter(line => line.kind === 'notice' && line.reason === 'paused')
    assert.equal(notices2.length, 2, 'newly parked explicit @mention while alreadyPaused must emit a visible notice')
    assert.deepEqual(notices2[1].names, ['Writer'])
    assert.ok(r1.paused?.some(entry => entry.id === 'b'))

    // stopRoomWork must clear room.paused and room.idlePaused so stale parked calls never resurrect.
    host.emit('gb', 'turn/start', { turn: 9 })
    assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
    assert.equal(r1.paused, undefined)
    assert.equal(r1.idlePaused, undefined)
  }

  // 2) All six members of a non-cyclic text-only handoff chain get their own turn without a fixed 4-hop cap.
  {
    const host = await start(t, {}, undefined, {}, { d: {} })
    const r1 = rt.roomOf('r1')
    rt.state.bots.e = { id: 'e', name: 'Editor', role: 'Edit', sessionId: 'e', createdAt: 5 }
    rt.state.bots.f = { id: 'f', name: 'QA', role: 'QA', sessionId: 'f', createdAt: 6 }
    r1.members.push('d', 'e', 'f')
    r1.sessions.d = 'gd'
    r1.sessions.e = 'ge'
    r1.sessions.f = 'gf'
    rt.groupOwners.set('gd', { botId: 'd', roomId: 'r1' })
    rt.groupOwners.set('ge', { botId: 'e', roomId: 'r1' })
    rt.groupOwners.set('gf', { botId: 'f', roomId: 'r1' })

    const first = host.round('c-zw', host.say('@Chief kick off the chain'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer handoff step one')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', '@Tester handoff step two')
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.finish('gc', '@Reviewer handoff step three')
    await settle(() => host.agentOf('gd').calls.length === 1)
    host.begin('gd')
    host.finish('gd', '@Editor handoff step four')
    await settle(() => host.agentOf('ge').calls.length === 1)
    host.begin('ge')
    host.finish('ge', '@QA please inspect the output')
    await settle(() => host.agentOf('gf').calls.length === 1)
    host.begin('gf')
    host.finish('gf', 'QA verified the output.')
    await first.wait()
    assert.equal(host.agentOf('gf').calls.length, 1, 'acyclic text-only chain should reach QA without fixed turn cap')
    assert.equal(r1.idlePaused, undefined)
  }

  // 3) releaseParked merges multiple parked calls from the same caller into ONE batch and skips removed members.
  {
    const host = await start(t)
    const r1 = rt.roomOf('r1')
    r1.idlePaused = { from: 'a', count: 2, limit: 2, cause: 'cycle', noticed: true }
    r1.paused = [
      { id: 'b', name: 'Writer', note: 'Chief mentioned you', by: 'a', idle: true },
      { id: 'c', name: 'Tester', note: 'Chief mentioned you', by: 'a', idle: true },
      { id: 'ghost', name: 'Ghost', note: 'Chief mentioned you', by: 'a', idle: true },
    ]
    const resumed = host.round('c-rel', host.say('continue'))
    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
    const activeBatches = Object.values(rt.state.roomBatches ?? {}).filter(b => b.roomId === 'r1' && b.by === 'a')
    assert.equal(activeBatches.length, 1, 'parked calls from the same caller must merge into one single batch')
    assert.deepEqual([...activeBatches[0].pending].sort(), ['b', 'c'], 'removed/ghost parked member must be skipped')
    host.begin('ga')
    host.finish('ga', '[PASS]')
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 't-b', name: 'pwsh', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 't-b', name: 'pwsh', isError: false, content: [] })
    host.finish('gb', 'Writer done')
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-c', name: 'pwsh', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-c', name: 'pwsh', isError: false, content: [] })
    host.finish('gc', 'Tester done')
    // Chief is woken ONCE after both Writer and Tester finish the merged batch.
    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Both received.')
    await resumed.wait()
  }
})

test('mid-turn group member part switch resolves live activeSid, turnChanges by turn, and real Session header for claimsOf', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'ds-bot-claims-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  writeFileSync(join(workDir, 'report.md'), '# ok\n')
  const changeSummary = {
    turn: 1, cwd: workDir, total: 1, added: 4, deleted: 0,
    files: [{ path: 'report.md', display: 'report.md', added: 4, deleted: 0 }],
  }
  const agentsMap = new Map()
  const host = await start(t, {}, {
    workspaceChanges: { summary: (id, seq) => (id === 'gb2' && seq > 0 ? changeSummary : undefined) },
    agents: { get: id => agentsMap.get(id), list: () => [...agentsMap.values()] },
  })
  // Register live DSH agent for the post-switch session 'gb2' with real header.cwd = workDir.
  agentsMap.set('gb2', { id: 'gb2', session: { id: 'gb2', header: { cwd: workDir } } })

  const first = host.round('c-sw', host.say('@Writer generate report.md'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  // Simulate mid-turn part switch: gb -> gb2 before turn ends on gb2!
  const msg = host.agentOf('gb').calls.at(-1)
  rt.roomOf('r1').sessions.b = 'gb2'
  rt.groupOwners.delete('gb')
  rt.groupOwners.set('gb2', { botId: 'b', roomId: 'r1' })

  host.emit('gb2', 'turn/start', { turn: 1 })
  host.emit('gb2', 'user/message', { content: msg.content, source: msg.source })
  host.emit('gb2', 'tool/call', { callId: 'tc-1', name: 'write_file', arguments: '{}' })
  host.emit('gb2', 'tool/result', { callId: 'tc-1', name: 'write_file', isError: false, content: [] })
  host.emit('gb2', 'workspace/changes', { turn: 1 })
  host.emit('gb2', 'assistant/message', { message: { content: [{ type: 'text', text: 'Saved [report.md](report.md) and checked [missing.md](missing.md).' }] } })
  host.emit('gb2', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Immediately start Turn 2 on gb2 (with no changes) before memberTurn reads Turn 1's changes!
  host.emit('gb2', 'turn/start', { turn: 2 })

  await first.wait()
  const writerLine = logLines(host).find(line => line.who === 'Writer')
  assert.ok(writerLine !== undefined)
  assert.equal(writerLine.changes?.sessionId, 'gb2', 'turnChanges must resolve live post-switch sessionId gb2')
  assert.equal(writerLine.changes?.turn, 1, 'turnChanges must retrieve Turn 1 even after Turn 2 started')
  assert.equal(writerLine.changes?.files?.[0]?.path, 'report.md')
  // claimsOf received liveSession with header.cwd = workDir: report.md exists, missing.md is flagged missing!
  assert.ok(writerLine.claims?.missingFiles?.some(p => p.includes('missing.md')), 'claimsOf must verify paths against gb2 real Session header.cwd')
  assert.equal(writerLine.claims?.missingFiles?.some(p => p.includes('report.md')), false)
})

test('group member part switch in parts.js migrates pending state.questions and state.views to the fresh part', async (t) => {
  const dir1 = mkdtempSync(join(tmpdir(), 'ds-bot-dir1-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'ds-bot-dir2-'))
  t.after(() => {
    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  })
  const host = await start(t, { workDir: dir2 })
  const gbAgent = host.agentOf('gb')
  gbAgent.id = 'gb'
  gbAgent.status = 'idle'
  gbAgent.whenIdle = async () => {}
  gbAgent.runMaintenance = async fn => fn(new AbortController().signal)
  gbAgent.inject = () => {}
  gbAgent.session = {
    id: 'gb',
    header: { cwd: dir1 },
    requestHeader: () => ({ config: {} }),
    snapshotEvents: () => [],
    deriveMessages: () => [],
  }
  const freshAgent = host.agentOf('gb-fresh')
  freshAgent.id = 'gb-fresh'
  freshAgent.status = 'idle'
  freshAgent.whenIdle = async () => {}
  freshAgent.runMaintenance = async fn => fn(new AbortController().signal)
  freshAgent.inject = () => {}
  freshAgent.session = { id: 'gb-fresh', header: { cwd: dir2 }, requestHeader: () => ({ config: {} }), snapshotEvents: () => [], deriveMessages: () => [] }
  host.ctx.sessionController.page = async () => ({ records: [], hasMore: false })
  host.ctx.sessionController.create = async () => ({ sessionId: 'gb-fresh' })
  host.ctx.workspaceRegistry.resolveByPath = async path => ({ id: path === dir2 ? 'ws-2' : 'ws-1', path, rootPath: path })

  rt.state.questions.gb = { id: 'q-grp-1', callId: 'call-q1', question: 'Ship now?', options: [{ label: 'Yes' }], askedAt: 1 }
  rt.state.views = { gb: { id: 'v-grp-1', callId: 'call-v1', title: 'Summary', view: { kind: 'text', text: 'ok' }, askedAt: 1 } }

  await rt.followFolder({ roomId: 'r1', botId: 'b' })
  await settle(() => rt.roomOf('r1').sessions.b === 'gb-fresh')

  assert.equal(rt.state.questions.gb, undefined)
  assert.equal(rt.state.questions['gb-fresh']?.id, 'q-grp-1')
  assert.equal(rt.state.questions['gb-fresh']?.callSessionId, 'gb')
  assert.equal(rt.state.views.gb, undefined)
  assert.equal(rt.state.views['gb-fresh']?.id, 'v-grp-1')
  assert.equal(rt.state.views['gb-fresh']?.callSessionId, 'gb')
})

test('groupSearch works cold on unmigrated rooms, read_group_chat uses excerpt for deep query matches and paginates with before_seq', async (t) => {
  // 1) Cold groupSearch on a room whose legacy log has not yet opened its ledger book.
  const host = await start(t, {
    log: [
      { seq: 1, who: 'User', text: 'initial rollout note', time: 1000 },
      { seq: 2, who: 'Writer', botId: 'b', text: 'cold migration target phrase', time: 2000 },
    ],
    seq: 2,
  })
  const coldHits = rt.groupSearch('r1', 'cold migration')
  assert.deepEqual(coldHits.results.map(hit => hit.seq), [2], 'groupSearch must ensureRoomLog before reading ledger')

  // 2) read_group_chat({ query }) centers excerpt around a match past 2000 chars and skips working rows.
  const deepText = `${'a'.repeat(2400)} UNIQUE_DEEP_NEEDLE ${'b'.repeat(400)}`
  rt.logRoom(rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: deepText })
  for (let i = 0; i < 25; i += 1) {
    rt.logRoom(rt.roomOf('r1'), { who: 'Writer', botId: 'b', kind: 'working', text: 'UNIQUE_DEEP_NEEDLE noise' })
  }
  const queryOut = await host.tool('read_group_chat', { group: 'Ops', query: 'UNIQUE_DEEP_NEEDLE' }, 'a')
  assert.match(queryOut, /UNIQUE_DEEP_NEEDLE/, 'query result must use excerpt around deep match past 2000 chars')
  assert.doesNotMatch(queryOut, /noise/, 'query must filter out SHOWN_ONLY working rows before limit')

  // 3) read_group_chat({ before_seq }) paginates backwards across >30 messages with #seq prefixes and footer hint.
  const host2 = await start(t)
  const room2 = rt.roomOf('r1')
  for (let i = 1; i <= 35; i += 1) rt.logRoom(room2, { who: 'User', text: `history line ${i}` })
  const latest = await host2.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.match(latest, /history line 35/)
  assert.match(latest, /history line 6/)
  assert.doesNotMatch(latest, /history line 5\b/)
  assert.match(latest, /pass before_seq: 6 to read earlier/)

  const older = await host2.tool('read_group_chat', { group: 'Ops', before_seq: 6 }, 'a')
  assert.match(older, /#1 User: history line 1/)
  assert.match(older, /#5 User: history line 5/)
  assert.doesNotMatch(older, /Older messages exist/)

  // 4) Exact-30-row boundary backfill: ledger keeps seqs 3..32 (30 rows) while seqs 1..2 live only
  //    in the group Session history -> before_seq: 33 must still backfill so hasMore is true!
  const sessionEvents32 = Array.from({ length: 32 }, (_, idx) => ({
    seq: idx + 1,
    type: 'user/message',
    time: 1000 + idx + 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `legacy line ${idx + 1}` }] },
  }))
  const kept30 = Array.from({ length: 30 }, (_, idx) => ({
    seq: idx + 3, who: 'User', text: `legacy line ${idx + 3}`, time: 1000 + idx + 3,
  }))
  const host3 = await start(t, { log: kept30, seq: 32 })
  host3.ctx.sessionController.page = async () => ({
    records: sessionEvents32.map(event => ({ event })),
    hasMore: false,
  })
  const boundaryPage = await host3.tool('read_group_chat', { group: 'Ops', before_seq: 33 }, 'a')
  assert.match(boundaryPage, /#3 User: legacy line 3/)
  assert.match(boundaryPage, /#32 User: legacy line 32/)
  assert.match(boundaryPage, /Older messages exist; pass before_seq: 3 to read earlier/, 'exact 30-row page must still backfill to detect older messages')
  const recoveredTail = await host3.tool('read_group_chat', { group: 'Ops', before_seq: 3 }, 'a')
  assert.match(recoveredTail, /#1 User: legacy line 1/)
  assert.match(recoveredTail, /#2 User: legacy line 2/)

  // 5) Sparse SHOWN_ONLY (working) rows before_seq backfill: ledger starts at seq 5 (seqs 1..4 in
  //    Session history) with 20 working rows + 15 real rows in seqs 5..39 -> before_seq: 40 must
  //    backfill from seq 0 and include recovered #1..#4 in the returned page.
  const sparseSessionEvents = [
    ...Array.from({ length: 4 }, (_, idx) => ({
      seq: idx + 1,
      type: 'user/message',
      time: 2000 + idx + 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `early sparse ${idx + 1}` }] },
    })),
    ...Array.from({ length: 15 }, (_, idx) => ({
      seq: idx + 5,
      type: 'user/message',
      time: 2000 + idx + 5,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `kept sparse ${idx + 1}` }] },
    })),
  ]
  const sparseKept = Array.from({ length: 15 }, (_, idx) => ({
    seq: idx + 5, who: 'User', text: `kept sparse ${idx + 1}`, time: 2000 + idx + 5,
  }))
  const host4 = await start(t, { log: sparseKept, seq: 19 })
  // Append 20 working (SHOWN_ONLY) rows at seqs 20..39 into the ledger.
  const r4 = rt.roomOf('r1')
  for (let i = 0; i < 20; i += 1) rt.logRoom(r4, { who: 'Writer', botId: 'b', kind: 'working' })
  host4.ctx.sessionController.page = async () => ({
    records: sparseSessionEvents.map(event => ({ event })),
    hasMore: false,
  })
  const sparsePage = await host4.tool('read_group_chat', { group: 'Ops', before_seq: 40 }, 'a')
  assert.match(sparsePage, /#1 User: early sparse 1/, 'sparse working rows must not skip backfill of seqs 1..4')
  assert.match(sparsePage, /#4 User: early sparse 4/)
  assert.match(sparsePage, /#19 User: kept sparse 15/)
})

test('delegate_work callInGroup uses mention boundary check so @Bob2 does not suppress @Bob prefix', async (t) => {
  const host = await start(t, {}, undefined, {}, { b: { name: 'Bob' }, c: { name: 'Bob2' } })
  const first = host.round('c-mention', host.say('@Chief coordinate'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const out = await host.tool('delegate_work', { to: 'Bob', goal: '@Bob2 already ran the build; please review' }, 'ga')
  assert.match(out, /Called Bob in "Ops"/)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.finish('ga', '[PASS]')
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await first.wait()
  const stepLine = logLines(host).find(line => line.who === 'Chief')
  assert.deepEqual(stepLine.route.to, ['b'])
  assert.equal(host.agentOf('gc').calls.length, 0, 'a name in the goal is not an addressee')
  assert.ok(stepLine?.text.startsWith('@Bob @Bob2 '), `expected @Bob prefix before @Bob2, got: ${stepLine?.text}`)
})

test('stopRoomWork cancels all busy members concurrently instead of waiting serially on a slow member', async (t) => {
  let releaseFirstSubagent
  let secondCancelled = false
  const host = await start(t, {}, {
    subagents: {
      interrupt: async (childId) => {
        if (childId === 'sub-slow') await new Promise((resolve) => { releaseFirstSubagent = resolve })
      },
    },
  })
  host.emit('ga', 'turn/start', { turn: 1 })
  host.emit('ga', 'subagent/catalog', { childId: 'sub-slow', label: 'Slow child', mode: 'continuable' })
  host.emit('gb', 'turn/start', { turn: 1 })
  const origCancel = host.agentOf('gb').cancel
  host.agentOf('gb').cancel = (reason) => { secondCancelled = true; return origCancel(reason) }

  const stopping = host.call('stop-room-work', { roomId: 'r1' })
  // While Chief's slow subagent interrupt is still pending, Writer MUST already be cancelled concurrently!
  await settle(() => releaseFirstSubagent !== undefined && secondCancelled === true)
  assert.equal(secondCancelled, true, 'member 2 must be cancelled concurrently while member 1 subagent stop is pending')
  releaseFirstSubagent()
  const result = await stopping
  assert.equal(result.ok, true)
})

test('folded open posts in one round dispatch every user @mention, late reply, and batchEnd wake without dropping earlier posts', async (t) => {
  const host = await start(t)
  // Seed a parallel batch where Writer already finished with tools and Tester is the last pending member.
  const log = [
    { seq: 1, who: 'Chief', botId: 'a', text: '@Writer @Tester 分头处理' },
    { seq: 2, who: 'Writer', botId: 'b', text: 'WRITER-DONE：文档已整理。' },
  ]
  const room = rt.roomOf('r1')
  room.log = log
  room.seq = 2
  rt.state.roomBatches = {
    'b-fold': {
      key: 'b-fold',
      roomId: 'r1',
      by: 'a',
      pending: [],
      done: ['Writer', 'Tester'],
      doneIds: ['b', 'c'],
      results: [{ name: 'Writer', seq: 2 }],
      worked: true,
      answered: false,
      at: Date.now(),
    },
  }

  // Fold BOTH a batchEnd late reply waking Chief AND a user @Writer message into the same group_relay round.
  host.emit('r1', 'user/message', {
    content: [{ type: 'text', text: '[Group post from Tester]\nTESTER-DONE：测试全过。' }],
    source: { kind: 'bot', form: 'relay', role: 'post', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', late: true, askedBy: 'a', batch: 'b-fold', batchEnd: true, worked: true },
  })
  host.emit('r1', 'user/message', host.say('@Writer 顺便看一下部署清单'))
  const done = host.round('c-fold-1', { content: [{ type: 'text', text: '' }], source: { kind: 'bot', form: 'relay', role: 'post', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', quiet: true, resumed: true } })

  // Both Chief (batchEnd wake with Writer + Tester results) and Writer (user @mention) must be called in the same round!
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gb').calls.length === 1)
  const chiefPrompt = text(host.agentOf('ga').calls[0])
  assert.match(chiefPrompt, /Writer and Tester finished the work you asked for/)
  assert.match(chiefPrompt, /TESTER-DONE/)
  assert.match(text(host.agentOf('gb').calls[0]), /顺便看一下部署清单/)
  assert.equal(rt.state.roomBatches['b-fold'], undefined, 'batch must close after scheduling its wake')

  host.begin('ga')
  host.finish('ga', '汇总收到。')
  host.begin('gb')
  host.finish('gb', '清单正常。')
  await done.wait()
})

test('concurrent post_to_group calls with report_back folded into one round run every target and isolate reports per caller', async (t) => {
  const host = await start(t, undefined, undefined, undefined, { d: { name: 'Reviewer', role: 'Lead' } }, undefined, { mainBotIds: ['a', 'd'] })
  // Chief ('a') and Reviewer ('d') concurrently dispatch post_to_group(report_back: true) targeting Writer and Tester.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 核对发布说明', report_back: true }, 'a')
  const postA = host.takePost()
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 跑一遍回归测试', report_back: true }, 'd')
  const postD = host.takePost()

  // Both posts fold into a single group_relay round.
  host.emit('r1', 'user/message', postA)
  const done = host.round('c-fold-reports', postD)

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'WRITER-ONLY-RESULT：发布说明已核对。')
  host.begin('gc')
  host.finish('gc', 'TESTER-ONLY-RESULT：回归测试全部通过。')

  await done.wait()
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('d').calls.length === 1)
  const reportToChief = text(host.agentOf('a').calls[0])
  const reportToReviewer = text(host.agentOf('d').calls[0])
  assert.match(reportToChief, /WRITER-ONLY-RESULT/)
  assert.doesNotMatch(reportToChief, /TESTER-ONLY-RESULT/, 'Chief report must stay scoped to Writer and never cross-contaminate with Tester')
  assert.match(reportToReviewer, /TESTER-ONLY-RESULT/)
  assert.doesNotMatch(reportToReviewer, /WRITER-ONLY-RESULT/, 'Reviewer report must stay scoped to Tester and never cross-contaminate with Writer')
  assert.deepEqual(rt.state.roomReports ?? {}, {})
})

test('stopping one member in a parallel batch via stopMemberWork wakes the caller with completed sibling results', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  room.log = [
    { seq: 1, who: 'Chief', botId: 'a', text: '@Writer @Tester 并行干活' },
    { seq: 2, who: 'Writer', botId: 'b', text: 'WRITER-PART：已完成前半段。' },
  ]
  room.seq = 2
  rt.state.roomBatches = {
    'b-stop-wake': {
      key: 'b-stop-wake',
      roomId: 'r1',
      by: 'a',
      pending: ['c'],
      done: ['Writer'],
      doneIds: ['b'],
      results: [{ name: 'Writer', seq: 2 }],
      worked: true,
      answered: false,
      at: Date.now(),
    },
  }
  // Tester ('gc') is currently running a turn.
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'user/message', { content: [{ type: 'text', text: 'working' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-stop-c', askedBy: 'a' } })

  assert.equal(await rt.stopMemberWork('r1', 'c'), true)
  const post = host.takePost()
  assert.equal(post.source.stopped, true)
  assert.equal(post.source.askedBy, 'a', 'stopMemberWork must wake Chief instead of silently dropping Writer results')
  assert.equal(post.source.batch, 'b-stop-wake')
  assert.equal(post.source.batchEnd, true)

  const done = host.round('c-stop-wake', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const wakePrompt = text(host.agentOf('ga').calls[0])
  assert.match(wakePrompt, /Writer finished the work you asked for/)
  assert.match(wakePrompt, /WRITER-PART/)
  host.begin('ga')
  host.finish('ga', '收到 Writer 的成果。')
  await done.wait()
  assert.deepEqual(rt.state.roomBatches ?? {}, {})
})

test('lateRoomFailure and reconcileStoppedRoomTask wake EVERY completed caller batch, not just the first', async (t) => {
  const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, undefined, { d: { name: 'Reviewer', role: 'Lead' } })
  const room = rt.roomOf('r1')
  room.log = [{ seq: 1, who: 'Writer', botId: 'b', text: 'WRITER-SHARED：结果已出。' }]
  room.seq = 1

  // 1) lateRoomFailure with two callers (Chief 'a' and Reviewer 'd') both waiting on Tester ('c').
  rt.state.roomBatches = {
    'b-chief': { key: 'b-chief', roomId: 'r1', by: 'a', pending: ['c'], done: ['Writer'], doneIds: ['b'], results: [{ name: 'Writer', seq: 1 }], worked: true, answered: false, at: 1 },
    'b-rev': { key: 'b-rev', roomId: 'r1', by: 'd', pending: ['c'], done: ['Writer'], doneIds: ['b'], results: [{ name: 'Writer', seq: 1 }], worked: true, answered: false, at: 2 },
  }
  await rt.lateRoomFailure('gc', { roomId: 'r1' }, { code: 'API_ERROR', message: 'upstream failed' })
  const failPosts = host.agentOf('r1').calls.splice(0)
  assert.equal(failPosts.length, 2, 'lateRoomFailure must post one wake per completed caller batch')
  assert.deepEqual(failPosts.map(m => m.source.askedBy).sort(), ['a', 'd'])
  assert.ok(failPosts.every(m => m.source.batchEnd === true))

  // Fold both wakes into one round -> BOTH Chief and Reviewer must wake!
  host.emit('r1', 'user/message', { content: failPosts[0].content, source: failPosts[0].source })
  const round1 = host.round('c-multi-fail', { content: failPosts[1].content, source: failPosts[1].source })
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gd').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'Chief 收到。')
  host.begin('gd')
  host.finish('gd', 'Reviewer 收到。')
  await round1.wait()
  assert.deepEqual(rt.state.roomBatches ?? {}, {})

  // 2) reconcileStoppedRoomTask with two callers both waiting on Tester ('c').
  rt.state.roomBatches = {
    'b-chief-2': { key: 'b-chief-2', roomId: 'r1', by: 'a', pending: ['c'], done: ['Writer'], doneIds: ['b'], results: [{ name: 'Writer', seq: 1 }], worked: true, answered: false, at: 3 },
    'b-rev-2': { key: 'b-rev-2', roomId: 'r1', by: 'd', pending: ['c'], done: ['Writer'], doneIds: ['b'], results: [{ name: 'Writer', seq: 1 }], worked: true, answered: false, at: 4 },
  }
  await rt.reconcileStoppedRoomTask('r1', 'c')
  const stopPosts = host.agentOf('r1').calls.splice(0)
  assert.equal(stopPosts.length, 2, 'reconcileStoppedRoomTask must wake every completed caller batch')
  assert.deepEqual(stopPosts.map(m => m.source.askedBy).sort(), ['a', 'd'])
})

test('missed inactive member exits its batch and batchMemberBusy ignores removed members so roomReports never deadlock', async (t) => {
  const host = await start(t, undefined, undefined, undefined, { d: { name: 'Reviewer', role: 'Lead' } }, undefined, { mainBotIds: ['a', 'd'] })
  await host.tool('post_to_group', { group: 'Ops', message: '@Chief 安排一下', report_back: true }, 'd')
  const post = host.takePost()
  const done = host.round('c-missed-exit', post)

  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 同时查一下')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  // Writer finishes with a real work tool.
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'w1', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'w1' })
  host.finish('gb', 'WRITER-OK')

  // Tester never starts a turn and times out (`missed`) while inactive (empty inbox, no turn).
  host.agentOf('gc').inbox.nextTurn.length = 0
  host.agentOf('gc').inbox.nextStep.length = 0
  const testerExId = host.agentOf('gc').calls[0].source.exchangeId
  rt.roomWaiters.get(testerExId).resolve({ missed: true })

  // Chief must wake with Writer's completed result, batch must clear, and Reviewer's report_back must settle!
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer finished the work you asked for/)
  host.begin('ga')
  host.finish('ga', '已收到 Writer 的结果，Tester 超时我先收口。')
  await done.wait()
  await settle(() => host.agentOf('d').calls.length === 1)
  assert.match(text(host.agentOf('d').calls[0]), /WRITER-OK/)
  assert.deepEqual(rt.state.roomBatches ?? {}, {})
  assert.deepEqual(rt.state.roomReports ?? {}, {})

  // Also verify batchMemberBusy ignores removed non-members if a stale batch still lists one.
  rt.state.roomBatches = {
    'b-ghost': { key: 'b-ghost', roomId: 'r1', by: 'a', pending: ['ghost-member'], done: [], doneIds: [], results: [], worked: true, answered: false, at: Date.now() },
  }
  rt.state.roomReports = {
    'rep-ghost': { id: 'rep-ghost', roomId: 'r1', botId: 'd', name: 'Reviewer', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: Date.now() },
  }
  await rt.settleRoomReports('r1')
  assert.equal(rt.state.roomReports['rep-ghost'], undefined, 'batchMemberBusy must ignore removed non-members so roomReports never deadlock')
})

test('joined role: room request settles its live roomWaiter immediately when the running turn aborts or fails', async (t) => {
  const host = await start(t)
  // 1) Aborted turn with a joined role: 'room' request that has a live roomWaiter.
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'initial turn' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-primary-1' } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'joined room call' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-joined-abort' } })
  let abortedResult = 'pending'
  rt.roomWaiters.set('ex-joined-abort', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { abortedResult = value },
    fail: failure => { abortedResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.equal(abortedResult, null, 'aborted turn must immediately settle joined roomWaiter with null instead of leaking')
  assert.equal(rt.roomWaiters.has('ex-joined-abort'), false)

  // 2) Failed turn with a joined role: 'room' request that has a live roomWaiter.
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'initial turn 2' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-primary-2' } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'joined room call 2' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-joined-fail' } })
  let failedResult = 'pending'
  rt.roomWaiters.set('ex-joined-fail', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { failedResult = value },
    fail: failure => { failedResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'API_ERROR', message: 'boom' } } })
  assert.equal(failedResult?.failure?.code, 'API_ERROR', 'failed turn must immediately fail joined roomWaiter instead of leaking')
  assert.equal(rt.roomWaiters.has('ex-joined-fail'), false)
})

test('stopRoomRound and stopRoomWork during a partially-completed parallel batch close the batch without posting a wake relay', async (t) => {
  // 1) stopRoomWork mid-batch
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief dispatch both'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer @Tester please run your checks')

    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'call-w', name: 'pwsh', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'call-w', name: 'pwsh', isError: false, content: [] })
    host.finish('gb', 'Writer finished the build')

    host.begin('gc')
    await settle(() => Object.values(rt.state.roomBatches ?? {}).some(b => b.done.includes('Writer') && b.worked === true && b.pending.includes('c')))

    const stopped = await host.call('stop-room-work', { roomId: 'r1' })
    assert.equal(stopped.ok, true)
    host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await first.wait()
    await new Promise(resolve => setTimeout(resolve, 40))

    const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.batchEnd === true || msg.source?.askedBy !== undefined)
    assert.deepEqual(wakePosts, [], 'stopRoomWork mid-batch must never post a batchEnd wake relay that resurrects stopped group work')
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [], 'aborted batch must be cleanly closed')
  }

  // 2) direct stopRoomRound mid-batch (without stopMemberWork)
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief dispatch both'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer @Tester please run your checks')

    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'call-w-direct', name: 'pwsh', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'call-w-direct', name: 'pwsh', isError: false, content: [] })
    host.finish('gb', 'Writer finished the build')

    host.begin('gc')
    await settle(() => Object.values(rt.state.roomBatches ?? {}).some(b => b.done.includes('Writer') && b.worked === true && b.pending.includes('c')))

    assert.equal(rt.stopRoomRound('r1'), true)
    host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await first.wait()
    await new Promise(resolve => setTimeout(resolve, 40))

    const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.batchEnd === true || msg.source?.askedBy !== undefined)
    assert.deepEqual(wakePosts, [], 'stopRoomRound mid-batch must never post a batchEnd wake relay')
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [], 'aborted batch must be cleanly closed')
  }
})

test('deleting a room mid-round with a partially-completed parallel batch closes cleanly without waking callers', async (t) => {
  const host = await start(t)

  const first = host.round('c1', host.say('@Chief dispatch both'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester please run your checks')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'call-w2', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'call-w2', name: 'pwsh', isError: false, content: [] })
  host.finish('gb', 'Writer finished before deletion')
  host.begin('gc')
  await settle(() => Object.values(rt.state.roomBatches ?? {}).some(b => b.done.includes('Writer') && b.worked === true && b.pending.includes('c')))

  await rt.deleteRoom('r1')
  await first.wait()
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(rt.roomOf('r1'), undefined)
  assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [], 'deleted room must leave zero lingering batches')
  const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.batchEnd === true || msg.source?.askedBy !== undefined)
  assert.deepEqual(wakePosts, [], 'deleting a room mid-batch must never wake callers')
})

test('nested group delegation (Chief -> Writer -> Tester) keeps upstream batch open and returns Writer summary to Chief as result', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief please coordinate a fact-checked draft review'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Review the draft with a fact check' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'Fact check claim #1' }, 'gb')
  // Writer ends Turn 1 with [PASS] while waiting for Tester's child batch.
  host.finish('gb', '[PASS]')

  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 't-fact', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 't-fact' })
  host.finish('gc', 'Claim #1 is verified.')

  // Tester's result resumes Writer with its upstream Chief batch intact.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Full review complete: draft is verified and ready.')

  // Chief MUST receive Writer's completed review as a result wake, not lose it to a note.
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '@Writer 收到，谢谢！')
  await first.wait()

  // Chief's closing acknowledgement must be a note and must not wake Writer again.
  assert.equal(host.agentOf('gb').calls.length, 2, 'Chief ack after final result must not re-wake Writer')
  const writerReview = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Full review complete'))
  const chiefAck = rt.roomOf('r1').log.find(line => line.botId === 'a' && line.text.includes('收到'))
  assert.equal(writerReview?.route?.kind, 'result')
  assert.deepEqual(writerReview?.route?.to, ['a'])
  assert.equal(chiefAck?.route?.kind, 'note')
})

test('zero-work group delegate_work with follow_up_to trips the zero-work cycle guard instead of looping forever', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief ask Writer a quick check'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const firstReceipt = await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 1 from context' }, 'ga')
  assert.match(firstReceipt, /Called Writer/)
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  // Writer answers from context with 0 substantive work tools.
  host.finish('gb', 'Detail 1 looks okay from memory.')

  // Chief wakes on Writer's result, runs 0 work tools, and delegates again to Writer via follow_up_to.
  await settle(() => host.agentOf('ga').calls.length === 2)
  const chiefSecond = host.begin('ga')
  const resultRef = chiefSecond.source.resultRef
  assert.ok(resultRef, 'Chief result wake must include resultRef')
  const pausedReceipt = await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 2 from context', follow_up_to: resultRef }, 'ga')
  assert.match(pausedReceipt, /Paused in "Ops"/)
  host.finish('ga', '[PASS]')
  await first.wait()

  assert.equal(host.agentOf('gb').calls.length, 1, 'Writer must not be woken again on a 0-work follow_up_to cycle')
  const pausedNotices = rt.roomOf('r1').log.filter(line => line.kind === 'notice' && line.reason === 'paused')
  assert.equal(pausedNotices.length, 1)
  assert.equal(pausedNotices[0].cause, 'cycle')
  assert.ok(rt.roomOf('r1').paused?.some(entry => entry.id === 'b'))
})

test('slow group turn past 15s grace preserves explicitCalls so closing @Name in lateRoomReply does not double-wake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer please run build and delegate verification'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k-slow', name: 'pwsh', arguments: '{}' })
  // Outlive the 15s grace timer so roomTurn removes the roomWaiter.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await first.wait()
  assert.equal(rt.roomWaiters.size, 0, 'waiter must have been cleaned up after grace expiry')

  // Writer now delegates verification to Tester via delegate_work after grace expiry.
  await host.tool('delegate_work', { to: 'Tester', goal: 'Verify the build artifacts' }, 'gb')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const delegatePost = host.takePost()
  const round2 = host.round('c2', delegatePost)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k-test', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k-test' })
  host.finish('gc', 'Verification passed.')
  await round2.wait()
  assert.equal(host.agentOf('gc').calls.length, 1)

  // Writer closes its original long turn mentioning @Tester in status text -> must NOT wake Tester again!
  host.emit('gb', 'tool/result', { callId: 'k-slow' })
  host.finish('gb', '@Tester is handling verification; build finished.')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const lateClose = host.takePost()
  assert.equal(lateClose.source.route?.kind, 'note', 'closing mention of an explicitly delegated member must route as note')
  const round3 = host.round('c3', lateClose)
  await round3.wait()
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester must NOT receive a second wake from lateRoomReply')
})

test('delegated member starting an active group background task downgrades its interim reply to note without waking caller early', async (t) => {
  const host = await start(t)
  const origHasRoomTasks = rt.hasRoomTasks
  let taskActive = false
  rt.hasRoomTasks = (roomId, botId) => (roomId === 'r1' && botId === 'b' ? taskActive : (origHasRoomTasks?.(roomId, botId) ?? false))
  t.after(() => { rt.hasRoomTasks = origHasRoomTasks })

  const first = host.round('c1', host.say('@Chief please ask Writer to run the migration'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Run the migration in background' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  taskActive = true
  host.finish('gb', 'Started background migration task; will report when finished.')
  await first.wait()

  // Interim reply while bgRunning must be downgraded to note, and Chief must not be woken yet.
  const interimLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Started background migration'))
  assert.equal(interimLine?.route?.kind, 'note', 'interim reply while group background task runs must be note, not result')
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief must not be woken early while Writer background task runs')
  assert.ok(Object.values(rt.state.roomBatches ?? {}).some(batch => batch.by === 'a' && batch.pending.includes('b')), 'upstream batch must remain open')
})

test('nested group delegation unwinds upstream batch cleanly when the child delegate passes without a result', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief delegate nested check'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Review with Tester' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'Check claim' }, 'gb')
  host.finish('gb', '[PASS]')

  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await first.wait()

  assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [], 'upstream batch must unwind instead of lingering when child passes')
})

test('queued new-round zero-work delegate_work(follow_up_to) preserves explicitDelegate through turns.js and trips cycle guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  // Round 1: Chief delegates to Writer (0 work tools on Writer -> returns result to Chief).
  const first = host.round('c1', host.say('@Chief ask Writer to check detail 1'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 1' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'Detail 1 checked from context.')

  // Chief wakes on Writer's result, then pauses past 15s grace (via a non-work tool / wait) or
  // let's have Round 1 end while Chief is still running so Chief's follow_up_to delegate_work
  // goes through `postToRoom` -> `agent.followup` -> `turns.js:queueRoomMessage` -> `runRoundFrom`!
  await settle(() => host.agentOf('ga').calls.length === 2)
  const chiefSecond = host.begin('ga')
  const resultRef = chiefSecond.source.resultRef
  assert.ok(resultRef)
  // Simulate Chief holding past reply/grace timeout so Round 1 finishes with no running round.
  rt.roomWaiters.get(chiefSecond.source.exchangeId)?.resolve({ working: true })
  await first.wait()
  assert.equal(rt.roomActive('r1'), false, 'no round may be running when Chief calls delegate_work')

  await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 2 via queued relay', follow_up_to: resultRef }, 'ga')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const queuedPost = host.takePost()
  assert.equal(queuedPost.source.explicitDelegate, true, 'queued relay source must carry explicitDelegate')
  assert.equal(queuedPost.source.callerExchangeId, chiefSecond.source.exchangeId)

  // Replay through turns.js -> group_relay -> runRoundFrom.
  const round2 = host.round('c2', queuedPost)
  await round2.wait()
  host.finish('ga', '[PASS]')

  assert.equal(host.agentOf('gb').calls.length, 1, 'Writer must not be woken on a queued 0-work follow_up_to cycle')
  const pausedNotices = rt.roomOf('r1').log.filter(line => line.kind === 'notice' && line.reason === 'paused')
  assert.equal(pausedNotices.length, 1)
  assert.equal(pausedNotices[0].cause, 'cycle')
})

test('nested group delegation survives fast child finishing before parent Turn 1 ends and waiting-slot collisions on parent', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief coordinate fast nested check'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Coordinate check with Tester' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'Fast check' }, 'gb')

  // Tester starts and finishes BEFORE Writer ends Turn 1!
  await settle(() => host.agentOf('gc').calls.length === 1)
  // Also simulate a concurrent waiting slot on Writer (e.g. from user) before Tester finishes
  // to verify exitMemberBatches still attaches resumeBatch instead of skipping callIn.
  const activeRound = [...rt.roomProgress.values()].find(r => r.roomId === 'r1')
  activeRound.slots.push({ id: 'b', name: 'Writer', status: 'waiting', note: 'user ping' })

  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 't-fast', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 't-fast' })
  host.finish('gc', 'Fast check passed.')

  // Now Writer closes Turn 1 with [PASS] AFTER Tester already completed and queued Writer's resumed slot.
  await settle(() => activeRound.slots.some(s => s.id === 'b' && s.status === 'waiting' && s.resumedUpstream === true))
  host.finish('gb', '[PASS]')

  // Writer's resumed Turn 2 must still carry Chief's upstream batch and return the final summary to Chief!
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Combined summary after fast Tester check.')

  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'Got it, thanks!')
  await first.wait()

  const summaryLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Combined summary'))
  assert.equal(summaryLine?.route?.kind, 'result', 'Writer resumed summary must route to Chief as result')
  assert.deepEqual(summaryLine?.route?.to, ['a'])
  assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
})

test('slow (>15s grace) nested delegation keeps upstream batch open across queued child relay and unwinds on late child [PASS]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Case A: Slow parent delegates with no running round, finishes Turn 1 before child round starts -> parent batch stays open.
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief ask Writer to run slow nested work'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Run build and ask Tester' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-slow', name: 'pwsh', arguments: '{}' })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS)
    await first.wait()

    // No round is running now: Writer delegates to Tester (queued to group Session) and closes Turn 1 immediately.
    await host.tool('delegate_work', { to: 'Tester', goal: 'Verify slow build' }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const childRelay = host.takePost()
    host.emit('gb', 'tool/result', { callId: 'w-slow' })
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))

    // Upstream Chief -> Writer batch MUST still be open while childRelay awaits its round!
    assert.ok(Object.values(rt.state.roomBatches ?? {}).some(b => b.by === 'a' && b.pending.includes('b')), 'upstream batch must survive queued child relay')

    // Now Tester's round runs and finishes -> wakes Writer with Chief's upstream batch intact -> wakes Chief!
    const round2 = host.round('c2', childRelay)
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-ver', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-ver' })
    host.finish('gc', 'Build verified.')

    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Final report for Chief: verified.')

    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Done.')
    await round2.wait()

    const reportLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Final report for Chief'))
    assert.equal(reportLine?.route?.kind, 'result')
    assert.deepEqual(reportLine?.route?.to, ['a'])
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // Case B: Child past 15s grace finishes with late [PASS] -> unwinds orphaned upstream batch cleanly.
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief ask Writer to delegate slow check'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Ask Tester to check' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    await host.tool('delegate_work', { to: 'Tester', goal: 'Slow check' }, 'gb')
    host.finish('gb', '[PASS]')

    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-slow-pass', name: 'pwsh', arguments: '{}' })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS)
    await first.wait()

    // Both Chief->Writer and Writer->Tester batches are open while Tester runs late.
    assert.equal(Object.values(rt.state.roomBatches ?? {}).length, 2)

    // Tester finishes late with [PASS] -> both child batch AND orphaned parent batch must unwind!
    host.emit('gc', 'tool/result', { callId: 't-slow-pass' })
    host.finish('gc', '[PASS]')
    await settle(() => Object.values(rt.state.roomBatches ?? {}).length === 0, 2000, 'late child [PASS] must unwind orphaned parent batch')
  }
})

test('nested delegation parentBatchKey scopes child holding and wakes so unrelated callers receive immediate results', async (t) => {
  const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, {}, { d: {} })
  const room = rt.roomOf('r1')

  // Chief delegates review to Writer; Reviewer separately asks Writer for release date.
  const first = host.round('c1', host.say('@Chief @Reviewer please each ask Writer your question'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gd').calls.length === 1)

  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Fact-check draft' }, 'ga')
  host.finish('ga', '[PASS]')

  // Writer starts Chief's task, delegates fact-check to Tester, and yields Turn 1.
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'Verify numbers' }, 'gb')
  host.finish('gb', '[PASS]')

  // Tester is now actively working on Chief's child batch.
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')

  // While Tester is still busy, Reviewer delegates an UNRELATED question to Writer.
  host.begin('gd')
  await host.tool('delegate_work', { to: 'Writer', goal: 'What is the release date?' }, 'gd')
  host.finish('gd', '[PASS]')

  // Writer answers Reviewer IMMEDIATELY while Tester is still running!
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Release date is Friday.')

  // Reviewer MUST get Writer's result wake immediately — NOT blocked or downgraded by Chief's child batch!
  await settle(() => host.agentOf('gd').calls.length === 2)
  host.begin('gd')
  host.finish('gd', 'Thanks!')
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief must still be waiting on Tester')
  const relLine = room.log.find(line => line.botId === 'b' && line.text.includes('Release date is Friday'))
  assert.equal(relLine?.route?.kind, 'result')
  assert.deepEqual(relLine?.route?.to, ['d'])

  // Now Tester finishes -> resumes Writer specifically for Chief's batch -> Chief gets final result!
  host.emit('gc', 'tool/call', { callId: 't-num', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 't-num' })
  host.finish('gc', 'Numbers verified.')

  await settle(() => host.agentOf('gb').calls.length === 3)
  host.begin('gb')
  host.finish('gb', 'Draft fact-check complete for Chief.')

  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'Approved.')
  await first.wait()

  const chiefLine = room.log.find(line => line.botId === 'b' && line.text.includes('Draft fact-check complete for Chief'))
  assert.equal(chiefLine?.route?.kind, 'result')
  assert.deepEqual(chiefLine?.route?.to, ['a'])
  assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
})

test('paused nested delegation preserves parentBatchKey across Continue, partial batch reissue reparents child, and stopRoomWork clears idle parent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 1) Paused queued nested delegation keeps parent open while parked and resumes parent after Continue.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const first = host.round('c1', host.say('@Chief ask Writer to check'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Coordinate check' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    const writerCall = host.begin('gb')
    // Yield Writer's round early so Writer's nested delegate_work queues to group Session.
    rt.roomWaiters.get(writerCall.source.exchangeId)?.resolve({ working: true })
    await first.wait()

    // Pre-seed idle pause state so the queued nested delegation is parked by the guard.
    room.idlePaused = { from: 'a', count: 2, limit: 2, cause: 'cycle', noticed: true }
    await host.tool('delegate_work', { to: 'Tester', goal: 'Check fact' }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const queuedChild = host.takePost()
    // Writer finishes Turn 1 with [PASS] before queuedChild runs -> parent batch stays open.
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))
    const parentBatch = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'a' && b.pending.includes('b'))
    assert.ok(parentBatch, 'Chief -> Writer batch must remain open while child relay is queued')

    // Queued round parks Tester and preserves parentBatchKey + direct on room.paused!
    const round2 = host.round('c2', queuedChild)
    await round2.wait()
    assert.equal(room.paused?.[0]?.id, 'c')
    assert.equal(room.paused?.[0]?.direct, true)
    assert.equal(room.paused?.[0]?.parentBatchKey, parentBatch.key)
    assert.equal(rt.state.roomBatches?.[parentBatch.key]?.pending.includes('b'), true, 'parent batch must stay pending while child is parked')

    // User clicks Continue -> releaseParked opens Tester's batch WITH parentBatchKey -> resumes Writer -> wakes Chief!
    await rt.resumeRoomPause('r1')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const round3 = host.round('c3', continuePost)
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-cont', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-cont' })
    host.finish('gc', 'Fact verified after Continue.')

    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Final answer for Chief after Continue.')

    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Great, done!')
    await round3.wait()
    const finalLine = room.log.find(line => line.botId === 'b' && line.text.includes('Final answer for Chief after Continue'))
    assert.equal(finalLine?.route?.kind, 'result')
    assert.deepEqual(finalLine?.route?.to, ['a'])
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 2) Partial batch supersession reparents only the moved member's child batch to the new batch.
  {
    const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, {}, { d: {} })
    const first = host.round('c1', host.say('@Chief assign Writer and Reviewer'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer @Reviewer please work on your parts')

    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gd').calls.length === 1)
    host.begin('gb')
    host.begin('gd')
    await host.tool('delegate_work', { to: 'Tester', goal: 'Check Writer part' }, 'gb')
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    const oldParent = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'a' && b.pending.includes('b') && b.pending.includes('d'))
    const childBatch = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'b' && b.pending.includes('c'))
    assert.equal(childBatch?.parentBatchKey, oldParent?.key)

    // Chief reissues work to Writer alone while Reviewer is STILL pending in oldParent!
    await host.tool('delegate_work', { to: 'Writer', goal: 'Updated instructions for Writer' }, 'ga')
    const newParent = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'a' && b.key !== oldParent.key && b.pending.includes('b'))
    assert.ok(newParent, 'new replacement batch must exist for Writer')
    assert.deepEqual(oldParent.pending, ['d'], 'old batch still waits for Reviewer')
    assert.equal(rt.state.roomBatches[childBatch.key].parentBatchKey, newParent.key, 'Writer child batch must reparent to the replacement batch')

    // Finish cleanly so round exits.
    host.finish('gb', '[PASS]')
    host.emit('gc', 'tool/call', { callId: 't-re', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-re' })
    host.finish('gc', 'Tester done.')
    host.finish('gd', 'Reviewer done.')
    await settle(() => host.agentOf('gb').calls.length >= 2)
    host.begin('gb')
    host.finish('gb', 'Writer final after reissue.')
    await settle(() => host.agentOf('ga').calls.length >= 2)
    host.begin('ga')
    host.finish('ga', 'All done.')
    await first.wait()
  }

  // 3) stopRoomWork cancels a queued nested relay in roomAgent.inbox and releases the idle parent batch.
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief ask Writer to check'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Check via Tester' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    const writerCall = host.begin('gb')
    rt.roomWaiters.get(writerCall.source.exchangeId)?.resolve({ working: true })
    await first.wait()

    await host.tool('delegate_work', { to: 'Tester', goal: 'Queued child check' }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 1)
    // Writer finishes Turn 1 while Tester's relay is still sitting in r1's inbox.
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(Object.values(rt.state.roomBatches ?? {}).length, 1, 'parent batch is held open by queued relay')

    // User clicks Stop -> cancelRoomQueues removes the queued relay AND releases the idle parent batch!
    await rt.stopRoomWork('r1')
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [], 'stopRoomWork must clear parent batch once queued nested relay is cancelled')
  }

  // 4) Lifting a nested pause by user `@Tester` mention still attaches the parked direct batch so Writer & Chief resume.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const first = host.round('c1', host.say('@Chief ask Writer to check'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Coordinate check' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    const writerCall = host.begin('gb')
    rt.roomWaiters.get(writerCall.source.exchangeId)?.resolve({ working: true })
    await first.wait()

    room.idlePaused = { from: 'a', count: 2, limit: 2, cause: 'cycle', noticed: true }
    await host.tool('delegate_work', { to: 'Tester', goal: 'Check fact' }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const queuedChild = host.takePost()
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))

    const round2 = host.round('c2', queuedChild)
    await round2.wait()
    assert.equal(room.paused?.[0]?.id, 'c')
    assert.equal(room.paused?.[0]?.direct, true)

    // User lifts pause by directly mentioning `@Tester` -> releaseParked must attach the parked batch to Tester's slot!
    const round3 = host.round('c3', host.say('@Tester please go ahead'))
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-mention', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-mention' })
    host.finish('gc', 'Fact verified on user mention.')

    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief after user mention.')

    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Thanks!')
    await round3.wait()
    const finalLine = room.log.find(line => line.botId === 'b' && line.text.includes('Summary for Chief after user mention'))
    assert.equal(finalLine?.route?.kind, 'result')
    assert.deepEqual(finalLine?.route?.to, ['a'])
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 5) Removing one of two parked direct callees before Continue keeps parent open for the surviving callee.
  {
    const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, {}, { d: {} })
    const room = rt.roomOf('r1')
    const first = host.round('c1', host.say('@Chief ask Writer for combined checks'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Check with Tester and Reviewer' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    const writerCall = host.begin('gb')
    rt.roomWaiters.get(writerCall.source.exchangeId)?.resolve({ working: true })
    await first.wait()

    const parentBatch = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'a' && b.pending.includes('b'))
    assert.ok(parentBatch)
    // Simulate both Tester ('c') and Reviewer ('d') parked for Writer's parentBatch, then Tester is removed from room.
    room.idlePaused = { from: 'b', count: 2, limit: 2, cause: 'cycle', noticed: true }
    room.paused = [
      { id: 'c', name: 'Tester', note: 'Writer mentioned you', by: 'b', idle: true, direct: true, parentBatchKey: parentBatch.key },
      { id: 'd', name: 'Reviewer', note: 'Writer mentioned you', by: 'b', idle: true, direct: true, parentBatchKey: parentBatch.key },
    ]
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))
    room.members = room.members.filter(id => id !== 'c')

    // User clicks Continue between rounds -> Tester is dropped, Reviewer survives, parentBatch MUST stay open!
    await rt.resumeRoomPause('r1')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const round2 = host.round('c2', continuePost)
    await settle(() => host.agentOf('gd').calls.length === 1)
    assert.equal(rt.state.roomBatches?.[parentBatch.key]?.pending.includes('b'), true, 'parent batch must stay open while surviving Reviewer runs')

    host.begin('gd')
    host.emit('gd', 'tool/call', { callId: 'r-surv', name: 'read', arguments: '{}' })
    host.emit('gd', 'tool/result', { callId: 'r-surv' })
    host.finish('gd', 'Reviewer check done.')

    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief from surviving Reviewer.')

    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Received.')
    await round2.wait()
    const line = room.log.find(entry => entry.botId === 'b' && entry.text.includes('Summary for Chief from surviving Reviewer'))
    assert.equal(line?.route?.kind, 'result')
    assert.deepEqual(line?.route?.to, ['a'])
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 6) Two distinct callers parking explicit delegate_work to the same target both stay in room.paused and run on Continue.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    room.idleEdges = ['a->b', 'b->a']
    room.idlePaused = { from: 'a', count: 2, limit: 2, cause: 'cycle', noticed: true }
    await host.tool('delegate_work', { to: 'Tester', goal: 'Chief parked check' }, 'ga')
    await host.tool('delegate_work', { to: 'Tester', goal: 'Writer parked check' }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 2)
    const chiefPost = host.takePost()
    const writerPost = host.takePost()

    const r1 = host.round('c1', chiefPost)
    await r1.wait()
    const r2 = host.round('c2', writerPost)
    await r2.wait()
    assert.deepEqual(room.paused.map(entry => [entry.id, entry.by, entry.direct]), [['c', 'a', true], ['c', 'b', true]])

    await rt.resumeRoomPause('r1')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const r3 = host.round('c3', continuePost)
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-two-1', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-two-1' })
    host.finish('gc', 'Done for Chief.')
    await settle(() => host.agentOf('gc').calls.length === 2)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-two-2', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-two-2' })
    host.finish('gc', 'Done for Writer.')

    await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gb').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief got it.')
    host.begin('gb')
    host.finish('gb', 'Writer got it.')
    await r3.wait()
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 7) Removing the only parked callee and resuming via user `@Writer` mention clears Writer's abandoned parent batch so Writer can delegate back to Chief.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const first = host.round('c1', host.say('@Chief ask Writer to check'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'Check with Tester' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1)
    const writerCall = host.begin('gb')
    rt.roomWaiters.get(writerCall.source.exchangeId)?.resolve({ working: true })
    await first.wait()

    const parentBatch = Object.values(rt.state.roomBatches ?? {}).find(b => b.by === 'a' && b.pending.includes('b'))
    assert.ok(parentBatch)
    room.idlePaused = { from: 'b', count: 2, limit: 2, cause: 'cycle', noticed: true }
    room.paused = [{ id: 'c', name: 'Tester', note: 'Writer mentioned you', by: 'b', idle: true, direct: true, parentBatchKey: parentBatch.key }]
    host.finish('gb', '[PASS]')
    await new Promise(resolve => setImmediate(resolve))

    // User removes the only parked callee (Tester) and writes `@Writer Ask Chief which release to document`.
    room.members = room.members.filter(id => id !== 'c')
    const r2 = host.round('c2', host.say('@Writer Ask Chief which release to document'))
    await settle(() => host.agentOf('gb').calls.length === 2)
    assert.equal(rt.state.roomBatches?.[parentBatch.key], undefined, 'abandoned parent batch must be released even though user mentioned Writer')

    host.begin('gb')
    const receipt = await host.tool('delegate_work', { to: 'Chief', goal: 'Which release to document?' }, 'gb')
    assert.match(receipt, /Called Chief/)
    host.finish('gb', '[PASS]')
    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Document v0.3.11.')
    await settle(() => host.agentOf('gb').calls.length === 3)
    host.begin('gb')
    host.finish('gb', 'Will document v0.3.11.')
    await r2.wait()
  }
})

test('dual-parent direct requests from the same caller to the same worker survive Continue, folded runRoundFrom, and busy activeJoined', async (t) => {
  // 8) Clicking Continue with two parked direct requests from the same caller to the same worker
  // serving two different upstream parents keeps both child batches and resumes both parents.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = {
      key: 'parent-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const p2 = {
      key: 'parent-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [p1.key]: p1, [p2.key]: p2 }
    room.idlePaused = { from: 'b', count: 2, limit: 2, cause: 'zero-work', noticed: true }
    room.paused = [
      { id: 'c', name: 'Tester', note: 'Writer mentioned you', by: 'b', idle: true, direct: true, parentBatchKey: p1.key },
      { id: 'c', name: 'Tester', note: 'Writer mentioned you', by: 'b', idle: true, direct: true, parentBatchKey: p2.key },
    ]
    await rt.resumeRoomPause('r1')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const r = host.round('c-dual', continuePost)

    // Tester runs slot 1 (Chief's parent) -> wakes Writer for Chief's parent.
    await settle(() => host.agentOf('gc').calls.length === 1)
    const testerCalls = Object.values(rt.state.roomBatches ?? {}).filter(b => b.by === 'b' && b.pending.includes('c'))
    assert.equal(testerCalls.length, 2, 'both parent-scoped child batches must coexist on resume')
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-dual-1', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-dual-1' })
    host.finish('gc', 'Checked release notes.')

    // Tester runs slot 2 (Reviewer's parent) -> wakes Writer for Reviewer's parent.
    await settle(() => host.agentOf('gc').calls.length === 2)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-dual-2', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-dual-2' })
    host.finish('gc', 'Checked migration guide.')

    // Writer resumes twice (once per upstream parent) and hands back both summaries.
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Release notes summary ready.')
    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Migration guide summary ready.')

    // Both Chief AND Reviewer must be woken with their respective results!
    await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gd').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief done.')
    host.begin('gd')
    host.finish('gd', 'Reviewer done.')
    await r.wait()
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 9) Two queued direct posts from the same caller to the same worker for distinct parents
  // folded into one runRoundFrom keep separate waiting slots and resume both parents.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const p1 = {
      key: 'fold-parent-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const p2 = {
      key: 'fold-parent-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [p1.key]: p1, [p2.key]: p2 }

    // Deliver both P1 and P2 into gb's unread queue before awaiting so startup settleRoomBatches
    // sees both deliveries queued on Writer (testing unreadOf parentBatchKey scoping).
    await Promise.all([
      rt.deliver({
        toId: 'b',
        sessionId: 'gb',
        role: 'room',
        roomId: 'r1',
        askedBy: 'a',
        batchKey: p1.key,
        text: 'Check release notes',
      }),
      rt.deliver({
        toId: 'b',
        sessionId: 'gb',
        role: 'room',
        roomId: 'r1',
        askedBy: 'd',
        batchKey: p2.key,
        text: 'Check migration guide',
      }),
    ])
    const gbCalls = host.agentOf('gb').calls
    const [w1Msg, w2Msg] = gbCalls.slice(-2)
    // Start w1 first (leaving w2 unread in gb's queue), delegate to Tester, finish w1.
    host.agentOf('gb').calls.push(w1Msg)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-work-1', name: 'read', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'w-work-1' })
    await host.tool('delegate_work', { to: 'Tester', goal: 'check release notes' }, 'gb')
    host.finish('gb', '[PASS]')

    // Now start w2, delegate to Tester, finish w2.
    host.agentOf('gb').calls.push(w2Msg)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-work-2', name: 'read', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'w-work-2' })
    await host.tool('delegate_work', { to: 'Tester', goal: 'check migration guide' }, 'gb')
    host.finish('gb', '[PASS]')

    await settle(() => host.agentOf('r1').calls.length === 2)
    const post1 = host.takePost()
    const post2 = host.takePost()
    const gbBefore = host.agentOf('gb').calls.length
    host.emit('r1', 'user/message', post1)
    const r = host.round('c-fold', post2)

    await settle(() => host.agentOf('gc').calls.length === 1)
    const childBatches = Object.values(rt.state.roomBatches ?? {}).filter(b => b.by === 'b' && b.pending.includes('c'))
    assert.equal(childBatches.length, 2, 'folded direct posts with distinct parentBatchKey must keep both child batches')
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-fold-1', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-fold-1' })
    host.finish('gc', 'Release notes verified.')

    await settle(() => host.agentOf('gc').calls.length === 2)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-fold-2', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-fold-2' })
    host.finish('gc', 'Migration guide verified.')

    await settle(() => host.agentOf('gb').calls.length === gbBefore + 1)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief.')
    await settle(() => host.agentOf('gb').calls.length === gbBefore + 2)
    host.begin('gb')
    host.finish('gb', 'Summary for Reviewer.')

    await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gd').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief got summary.')
    host.begin('gd')
    host.finish('gd', 'Reviewer got summary.')
    await r.wait()
    assert.deepEqual(Object.values(rt.state.roomBatches ?? {}), [])
  }

  // 10) Busy Tester receiving two waiterless room deliveries from the same caller for distinct
  // live pending child batches re-delivers BOTH when its current turn ends (activeJoined).
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const c1 = {
      key: 'child-batch-1',
      roomId: 'r1',
      by: 'b',
      pending: ['c'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      parentBatchKey: 'parent-1',
      answered: false,
      at: Date.now(),
    }
    const c2 = {
      key: 'child-batch-2',
      roomId: 'r1',
      by: 'b',
      pending: ['c'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      parentBatchKey: 'parent-2',
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [c1.key]: c1, [c2.key]: c2 }

    // Tester is busy on an earlier room turn while both waiterless calls from Writer join it.
    host.agentOf('gc').followup({
      id: 'u-busy',
      content: [{ type: 'text', text: 'Busy room turn' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-busy-other', senderSessionId: 'r1' },
    })
    host.begin('gc')
    host.emit('gc', 'user/message', {
      content: [{ type: 'text', text: 'Check release notes' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: c1.key, exchangeId: 'ex-join-c1', senderSessionId: 'r1' },
    })
    host.emit('gc', 'user/message', {
      content: [{ type: 'text', text: 'Check migration guide' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: c2.key, exchangeId: 'ex-join-c2', senderSessionId: 'r1' },
    })

    const before = host.agentOf('gc').calls.length
    host.finish('gc', 'Finished unrelated busy turn.')
    await settle(() => host.agentOf('gc').calls.length >= before + 2)
    const redelivered = host.agentOf('gc').calls.slice(before).map(msg => msg.source?.batchKey)
    assert.deepEqual(redelivered, [c1.key, c2.key], 'both live pending child batches must be re-delivered when busy turn finishes')
  }
})

test('reissued in-flight child batch settles its same-parent successor and unwinds orphaned parent while caller runs another parent', async (t) => {
  // 11) Writer delegates K1 (for Chief P1) to Tester; Tester starts running K1 past the round grace.
  // Writer also queues K2 (for Reviewer P2) to Tester, then revises P1 creating K3 (superseding & deleting K1,
  // leaving K2 ahead of K3 in roomBatches). When Tester finishes K1 late, it must settle K3 (Chief P1), NOT K2 (Reviewer P2).
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const p1 = {
      key: 'reissue-p1-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const p2 = {
      key: 'reissue-p2-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [p1.key]: p1 }

    // Round 1: Writer delegates K1 (for P1) to Tester; Tester starts running K1 and passes the grace.
    host.agentOf('gb').followup({
      id: 'w-p1-initial',
      content: [{ type: 'text', text: 'Check release notes' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'a', batchKey: p1.key, exchangeId: 'ex-w-p1-1', senderSessionId: 'r1' },
    })
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-r1', name: 'read', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'w-r1' })
    await host.tool('delegate_work', { to: 'Tester', goal: 'initial release notes check' }, 'gb')
    host.finish('gb', '[PASS]')

    await settle(() => host.agentOf('r1').calls.length === 1)
    const r1 = host.round('c-r1', host.takePost())
    await settle(() => host.agentOf('gc').calls.length === 1)
    const k1Msg = host.begin('gc')
    const k1Key = k1Msg.source.batchKey
    assert.ok(k1Key)
    host.emit('gc', 'tool/call', { callId: 'c-work-k1', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 'c-work-k1' })
    rt.roomWaiters.get(k1Msg.source.exchangeId)?.resolve({ working: true })
    await r1.wait()

    // Reviewer now assigns P2 to Writer: Writer queues K2 (for P2) to Tester, then revises P1
    // creating K3 (superseding & deleting K1, leaving K2 ahead of K3 in roomBatches).
    rt.state.roomBatches[p2.key] = p2
    host.agentOf('gb').followup({
      id: 'w-p2-initial',
      content: [{ type: 'text', text: 'Check migration guide' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'd', batchKey: p2.key, exchangeId: 'ex-w-p2-1', senderSessionId: 'r1' },
    })
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-r2', name: 'read', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'w-r2' })
    await host.tool('delegate_work', { to: 'Tester', goal: 'migration guide check' }, 'gb')
    host.finish('gb', '[PASS]')

    host.agentOf('gb').followup({
      id: 'w-p1-revise',
      content: [{ type: 'text', text: 'Revise release notes check' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'a', batchKey: p1.key, exchangeId: 'ex-w-p1-2', senderSessionId: 'r1' },
    })
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'w-r3', name: 'read', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'w-r3' })
    await host.tool('delegate_work', { to: 'Tester', goal: 'revised release notes check' }, 'gb')
    host.finish('gb', '[PASS]')

    await settle(() => host.agentOf('r1').calls.length === 2)
    const p2Post = host.takePost()
    const p1RevisePost = host.takePost()
    host.emit('r1', 'user/message', p2Post)
    const r2 = host.round('c-r2', p1RevisePost)
    await settle(() => {
      const children = Object.values(rt.state.roomBatches ?? {}).filter(b => b.by === 'b' && b.pending.includes('c'))
      return children.length === 2 && rt.state.roomBatches?.[k1Key] === undefined
    })
    const k2Batch = Object.values(rt.state.roomBatches).find(b => b.by === 'b' && b.parentBatchKey === p2.key)
    const k3Batch = Object.values(rt.state.roomBatches).find(b => b.by === 'b' && b.parentBatchKey === p1.key)
    assert.ok(k2Batch && k3Batch && k3Batch.key !== k1Key)

    // Tester finishes the original K1 turn late -> must settle K3 (P1), keeping K2 (P2) pending!
    host.finish('gc', 'Release notes check complete.')
    await settle(() => rt.state.roomBatches?.[k3Batch.key]?.pending.length === 0 || rt.state.roomBatches?.[k3Batch.key] === undefined)
    assert.deepEqual(rt.state.roomBatches?.[k2Batch.key]?.pending, ['c'], 'K2 (Reviewer parent) must stay pending when K1 settles K3 (Chief parent)')
    r2.cancel()
  }

  // 12) Writer holds P1 (Chief) and P2 (Reviewer) and is actively running P2's turn when P1's only
  // child (Tester) exits with [PASS] -> activeInRoom scoped by parentBatchKey must unwind P1 without touching P2.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const p1 = {
      key: 'unwind-p1-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const p2 = {
      key: 'unwind-p2-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const c1 = {
      key: 'unwind-c1-tester',
      roomId: 'r1',
      by: 'b',
      pending: ['c'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      parentBatchKey: p1.key,
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [p1.key]: p1, [p2.key]: p2, [c1.key]: c1 }

    // Writer is actively running P2's turn (unrelated to P1).
    host.agentOf('gb').followup({
      id: 'w-running-p2',
      content: [{ type: 'text', text: 'Work on Reviewer task' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'd', batchKey: p2.key, exchangeId: 'ex-w-run-p2', senderSessionId: 'r1' },
    })
    host.begin('gb')

    // Tester finishes C1 (P1's only child) late with [PASS] -> C1 closes without waking Writer,
    // and unwindOrphanedCallers must see Writer is NOT working on P1 and clear P1 while keeping P2.
    host.agentOf('gc').followup({
      id: 't-running-c1',
      content: [{ type: 'text', text: 'Check for P1' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: c1.key, exchangeId: 'ex-t-c1', senderSessionId: 'r1' },
    })
    host.begin('gc')
    host.finish('gc', '[PASS]')

    await settle(() => rt.state.roomBatches?.[p1.key] === undefined)
    assert.ok(rt.state.roomBatches?.[p2.key] !== undefined, 'active P2 parent batch must remain untouched')
    assert.deepEqual(rt.state.roomBatches?.[p2.key]?.pending, ['b'])
    host.finish('gb', 'Reviewer task finished.')
  }
})

test('persisted batch replacement survives restart and startup settleRoomBatches keeps parents with waking completed children', async (t) => {
  // 13) Reissue replacement link (`batch.replaces`) is persisted on the replacement batch:
  // after a restart (fresh runtime instance), a resumed Tester turn carrying K1 still settles K3 (P1), not K2 (P2).
  {
    const host1 = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const p1 = {
      key: 'restart-p1-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    const p2 = {
      key: 'restart-p2-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now(),
    }
    rt.state.roomBatches = { [p1.key]: p1 }

    // Host 1: Writer sends K1 (for P1), Tester starts K1 past grace, then Writer queues K2 (P2) and revises P1 -> K3.
    host1.agentOf('gb').followup({
      id: 'w-rs-1',
      content: [{ type: 'text', text: 'Check release notes' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'a', batchKey: p1.key, exchangeId: 'ex-w-rs-1', senderSessionId: 'r1' },
    })
    host1.begin('gb')
    host1.emit('gb', 'tool/call', { callId: 'w-rs-t1', name: 'read', arguments: '{}' })
    host1.emit('gb', 'tool/result', { callId: 'w-rs-t1' })
    await host1.tool('delegate_work', { to: 'Tester', goal: 'initial check' }, 'gb')
    host1.finish('gb', '[PASS]')

    await settle(() => host1.agentOf('r1').calls.length === 1)
    const r1 = host1.round('c-rs-1', host1.takePost())
    await settle(() => host1.agentOf('gc').calls.length === 1)
    const k1Msg = host1.begin('gc')
    const k1Key = k1Msg.source.batchKey
    rt.roomWaiters.get(k1Msg.source.exchangeId)?.resolve({ working: true })
    await r1.wait()

    rt.state.roomBatches[p2.key] = p2
    host1.agentOf('gb').followup({
      id: 'w-rs-2',
      content: [{ type: 'text', text: 'Check migration guide' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'd', batchKey: p2.key, exchangeId: 'ex-w-rs-2', senderSessionId: 'r1' },
    })
    host1.begin('gb')
    host1.emit('gb', 'tool/call', { callId: 'w-rs-t2', name: 'read', arguments: '{}' })
    host1.emit('gb', 'tool/result', { callId: 'w-rs-t2' })
    await host1.tool('delegate_work', { to: 'Tester', goal: 'migration check' }, 'gb')
    host1.finish('gb', '[PASS]')

    host1.agentOf('gb').followup({
      id: 'w-rs-3',
      content: [{ type: 'text', text: 'Revise release notes check' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'a', batchKey: p1.key, exchangeId: 'ex-w-rs-3', senderSessionId: 'r1' },
    })
    host1.begin('gb')
    host1.emit('gb', 'tool/call', { callId: 'w-rs-t3', name: 'read', arguments: '{}' })
    host1.emit('gb', 'tool/result', { callId: 'w-rs-t3' })
    await host1.tool('delegate_work', { to: 'Tester', goal: 'revised check' }, 'gb')
    host1.finish('gb', '[PASS]')

    await settle(() => host1.agentOf('r1').calls.length === 2)
    const p2Post = host1.takePost()
    const p1RevisePost = host1.takePost()
    host1.emit('r1', 'user/message', p2Post)
    const r2 = host1.round('c-rs-2', p1RevisePost)
    await settle(() => {
      const children = Object.values(rt.state.roomBatches ?? {}).filter(b => b.by === 'b' && b.pending.includes('c'))
      return children.length === 2 && rt.state.roomBatches?.[k1Key] === undefined
    })
    const k2Batch = Object.values(rt.state.roomBatches).find(b => b.by === 'b' && b.parentBatchKey === p2.key)
    const k3Batch = Object.values(rt.state.roomBatches).find(b => b.by === 'b' && b.parentBatchKey === p1.key)
    assert.ok(k2Batch && k3Batch && k3Batch.replaces?.c?.includes(k1Key))
    await rt.save()
    const savedBatches = JSON.parse(readFileSync(join(host1.home, 'state.json'), 'utf8')).roomBatches
    r2.cancel()

    // Host 2 (fresh restart with empty in-memory maps): load persisted roomBatches + inflight queued turns.
    const host2 = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
      undefined,
      { roomBatches: savedBatches },
      {
        'inflight.json': {
          turns: {},
          queued: {
            gc: [
              { at: Date.now(), args: { toId: 'c', sessionId: 'gc', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: k1Key, exchangeId: 'ex-t-rec-k1', text: 'Recovered check' } },
              { at: Date.now(), args: { toId: 'c', sessionId: 'gc', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: k2Batch.key, exchangeId: 'ex-t-rec-k2', text: 'Queued migration check' } },
            ],
          },
          silent: {},
        },
      },
    )
    // Tester's recovered turn still carries k1Key -> must settle K3 (P1), leaving K2 (P2) pending!
    await until(() => host2.agentOf('gc').calls.some(msg => msg.source?.exchangeId === 'ex-t-rec-k1'), 6000)
    const k1Recovered = host2.agentOf('gc').calls.find(msg => msg.source?.exchangeId === 'ex-t-rec-k1')
    host2.agentOf('gc').calls.push(k1Recovered)
    host2.begin('gc')
    host2.emit('gc', 'tool/call', { callId: 'c-rec-1', name: 'read', arguments: '{}' })
    host2.emit('gc', 'tool/result', { callId: 'c-rec-1' })
    host2.finish('gc', 'Release notes verified after restart.')

    await settle(() => host2.agentOf('r1').calls.length === 1)
    const wakePost = host2.takePost()
    assert.equal(wakePost.source.batch, k3Batch.key, 'restarted K1 turn must settle persisted successor K3')
    assert.equal(wakePost.source.parentBatchKey, p1.key)
    assert.deepEqual(rt.state.roomBatches?.[k2Batch.key]?.pending, ['c'], 'unrelated K2 must remain pending')
  }

  // 14) Startup settleRoomBatches visits parent P1 before finished child C1 while Writer is resuming P2:
  // hasWakingChildBatch protects P1 so C1's replayed wake resumes P1 and delivers the final summary to Chief.
  {
    const p1 = {
      key: 'wake-p1-chief',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now() - 2000,
    }
    const p2 = {
      key: 'wake-p2-reviewer',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now() - 1000,
    }
    const c1 = {
      key: 'wake-c1-done',
      roomId: 'r1',
      by: 'b',
      pending: [],
      done: ['Tester'],
      doneIds: ['c'],
      results: [{ name: 'Tester', seq: 1 }],
      worked: true,
      direct: true,
      returnRequested: true,
      parentBatchKey: p1.key,
      answered: false,
      at: Date.now(),
    }
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' }, log: [{ seq: 1, who: 'Tester', botId: 'c', text: 'Fact-check done.' }], seq: 1 },
      undefined,
      undefined,
      { d: {} },
      undefined,
      { roomBatches: { [p1.key]: p1, [p2.key]: p2, [c1.key]: c1 } },
      {
        'inflight.json': {
          turns: {},
          queued: {
            gb: [{ at: Date.now(), args: { toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', askedBy: 'd', batchKey: p2.key, exchangeId: 'ex-w-res-p2', text: 'Resume Reviewer task' } }],
          },
          silent: {},
        },
      },
    )

    // Startup settleRoomBatches automatically runs with P2 queued on Writer and C1 finished for P1.
    await until(() => host.agentOf('gb').calls.some(msg => msg.source?.exchangeId === 'ex-w-res-p2'), 6000)
    await settle(() => host.agentOf('r1').calls.length === 1)
    assert.ok(rt.state.roomBatches?.[p1.key] !== undefined, 'parent P1 with finished waking child C1 must not be pruned')
    const wakePost = host.takePost()
    assert.equal(wakePost.source.batch, c1.key)
    assert.equal(wakePost.source.parentBatchKey, p1.key)

    // Writer runs & finishes its recovered P2 turn, then C1's wake opens a round -> Writer must resume P1 (not resultOnly) and wake Chief!
    host.begin('gb')
    host.finish('gb', 'Reviewer summary done.')
    await settle(() => host.agentOf('r1').calls.length === 1)
    host.takePost()
    const gbBefore = host.agentOf('gb').calls.length
    const r = host.round('c-wake-p1', wakePost)
    await settle(() => host.agentOf('gb').calls.length === gbBefore + 1)
    const resumedWriterCall = host.begin('gb')
    assert.equal(resumedWriterCall.source.batchKey, p1.key, 'replayed child wake must resume P1')
    assert.equal(resumedWriterCall.source.resumedUpstream, true)
    host.finish('gb', 'Chief summary ready.')
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief got recovered summary.')
    await r.wait()
  }

  // 15) Discarding a queued batchEnd wake closes the child AND releases its idle parent batch,
  // while keeping the parent alive if another child for that same parent is still active.
  {
    const pIdle = {
      key: 'discard-p-idle',
      roomId: 'r1',
      by: 'a',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now() - 2000,
    }
    const cIdle = {
      key: 'discard-c-idle',
      roomId: 'r1',
      by: 'b',
      pending: [],
      done: ['Tester'],
      doneIds: ['c'],
      results: [{ name: 'Tester', seq: 1 }],
      worked: true,
      direct: true,
      returnRequested: true,
      parentBatchKey: pIdle.key,
      answered: false,
      at: Date.now(),
    }
    const pBusy = {
      key: 'discard-p-busy',
      roomId: 'r1',
      by: 'd',
      pending: ['b'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      answered: false,
      at: Date.now() - 2000,
    }
    const cDone = {
      key: 'discard-c-done',
      roomId: 'r1',
      by: 'b',
      pending: [],
      done: ['Tester'],
      doneIds: ['c'],
      results: [{ name: 'Tester', seq: 1 }],
      worked: true,
      direct: true,
      returnRequested: true,
      parentBatchKey: pBusy.key,
      answered: false,
      at: Date.now(),
    }
    const cStillWorking = {
      key: 'discard-c-working',
      roomId: 'r1',
      by: 'b',
      pending: ['c'],
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      direct: true,
      returnRequested: true,
      parentBatchKey: pBusy.key,
      answered: false,
      at: Date.now(),
    }
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' }, log: [{ seq: 1, who: 'Tester', botId: 'c', text: 'Done.' }], seq: 1 },
      undefined,
      undefined,
      { d: {} },
      undefined,
      { roomBatches: { [pIdle.key]: pIdle, [cIdle.key]: cIdle, [pBusy.key]: pBusy, [cDone.key]: cDone, [cStillWorking.key]: cStillWorking } },
      {
        'inflight.json': {
          turns: {},
          queued: {
            gc: [{ at: Date.now(), args: { toId: 'c', sessionId: 'gc', role: 'room', roomId: 'r1', askedBy: 'b', batchKey: cStillWorking.key, exchangeId: 'ex-still-working', text: 'Keep working' } }],
          },
          silent: {},
        },
      },
    )

    await until(() => host.agentOf('r1').calls.length === 2, 6000)
    const wakeIdle = host.agentOf('r1').calls.find(m => m.source?.batch === cIdle.key)
    const wakeBusy = host.agentOf('r1').calls.find(m => m.source?.batch === cDone.key)
    assert.ok(wakeIdle && wakeBusy)

    // Genuine discard of wakeIdle must close cIdle AND release idle parent pIdle.
    rt.roomRelayDiscarded(wakeIdle.source, 'r1')
    assert.equal(rt.state.roomBatches?.[cIdle.key], undefined)
    assert.equal(rt.state.roomBatches?.[pIdle.key], undefined, 'idle parent must be released when its only waking child result is discarded')

    // Genuine discard of wakeBusy closes cDone, but pBusy stays open because cStillWorking is still queued on Tester!
    rt.roomRelayDiscarded(wakeBusy.source, 'r1')
    assert.equal(rt.state.roomBatches?.[cDone.key], undefined)
    assert.ok(rt.state.roomBatches?.[pBusy.key] !== undefined, 'parent with another live child must stay open')
  }
})
