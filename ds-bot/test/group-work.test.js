import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
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
    void tool('group_relay', {}, sessionId, { callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, sessionId, value) })
    const read = () => result
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
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])
const isReportWork = work => work?.meta?.kind === 'room_report'
  || work?.meta?.migratedFrom === 'state.roomReports'
  || (typeof work?.workId === 'string' && work.workId.startsWith('room-report:'))
const isChainWork = work => work?.meta?.kind === 'room_chain'
const activeRoomWorks = roomId => (rt.coordDb?.listWorks({ kind: 'room_work', ...(roomId ? { roomId } : {}), activeOnly: true, limit: 200 }) ?? [])
  .filter(w => !isReportWork(w) && !isChainWork(w))
const activeCallWorks = roomId => activeRoomWorks(roomId).filter(w => w.meta?.kind === 'room_call')
const activeRoomReports = roomId => (rt.coordDb?.listWorks({ kind: 'room_work', ...(roomId ? { roomId } : {}), activeOnly: true, limit: 200 }) ?? [])
  .filter(isReportWork)
const reportWork = (id) => {
  const work = rt.coordDb?.getWork(`room-report:${id}`)
  return work && !['done', 'failed', 'stopped'].includes(work.status) ? work : undefined
}

test('work past the grace lets the round go on, and the member that asked answers the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.done, post.source.askedBy], [true, true, 'a'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Chief'], ['message', 'Writer']])
  assert.deepEqual([host.agentOf('b').calls, host.agentOf('gc').calls], [[], []])
})

test('replaying a queued group result after the batch closed cannot wake its caller again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const open = host.round('c0', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '整理文档' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => open() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.route?.kind, 'result')
  assert.deepEqual(post.source.route?.to, ['a'])
  const first = host.round('return', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '@Writer all done')
  await settle(() => first() !== undefined)
  const replay = host.round('replay', post)
  await settle(() => replay() !== undefined)
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gb').calls.length], [2, 1])
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
  await settle(() => first() !== undefined)
})

test('delegate_work from a member the round moved on from calls the other member in a round of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
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
  await settle(() => second() !== undefined)
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
  await settle(() => done() !== undefined)
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
    [{ kind: 'notice', reason: 'paused', names: ['Writer'], limit: 6 }, '[Paused: Bots waited on the same unresolved step without measurable progress. Waiting for the user to continue or stop.]'],
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
    await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
    host.finish('ga', '[PASS]')
  }
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '整理好了，在 docs/ 下。' }, { type: 'tool-call', id: 'k2', name: 'pwsh', arguments: '{}' }] } })
  host.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  // With an open anchor, visible step lines write straight to the ledger without waking the room Session.
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === '整理好了，在 docs/ 下。'))
  assert.deepEqual(host.agentOf('r1').calls, [])
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
  await settle(() => third() !== undefined)
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
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.deepEqual(host.agentOf('c').calls, [])
  const report = host.begin('a')
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post\]/)
  assert.match(text(report), /Writer: 文档没问题。/)
  host.finish('a', 'Writer 看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /^\[Work #W\d+ completed by Chief[^\n]*\]\nWriter 看过了，没问题。$/)
})

// Giving up a wait for a group report settles the wait immediately in SQLite so the caller
// wakes without waiting further, and late replies from the group do not resurrect the wait.
test('giving up a wait for a group settles the wait immediately and late replies do not resurrect it', async (t) => {
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
  assert.match(text(host.agentOf('a').calls.at(-1)), /No reply came back from the group chat "Ops", and the user gave up waiting for work/)

  // The round ends afterwards: the abandoned wait stays closed and does not wake Chief again.
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await settle(() => done() !== undefined)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 2)
  assert.deepEqual(activeRoomReports('r1'), [])
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
  await settle(() => done() !== undefined)
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
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a-fg').calls.length === 1)
  assert.equal(host.agentOf('a-task').calls.length, 0)
  assert.match(text(host.agentOf('a-fg').calls[0]), /Writer: 文档没问题。/)
})

test('a member called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await settle(() => result() !== undefined)
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
  await settle(() => first() !== undefined)

  await host.tool('delegate_work', { to: 'Writer', goal: '改用新模板' }, 'ga')
  const second = host.round('c2', host.takePost())
  await settle(() => second() !== undefined)
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
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('已换成新模板')))
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => first() !== undefined)
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('a late post body @Name wakes nobody (zero-echo), while explicit delegate_work reaches the member every time', async (t) => {
  const host = await start(t)
  // 1) Plain body @Tester in a late reply is strictly visible (0 wakes).
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x0', roomId: 'r1' } })
  host.finish('gb', '@Tester 看看这个')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const visiblePost = host.takePost()
  assert.equal(visiblePost.source.route?.kind, 'visible')
  const zeroEcho = host.round('c0', visiblePost)
  await settle(() => zeroEcho() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 0)

  // 2) Explicit delegate_work reaches Tester every time with no fixed round count cap.
  for (const [turn, goal] of [[1, '看看这个'], [2, '再看一个']]) {
    await host.tool('delegate_work', { to: 'Tester', goal }, 'gb')
    await settle(() => host.agentOf('r1').calls.length === 1)
    const post = host.takePost()
    assert.deepEqual([post.source.progress, post.source.quiet], [true, undefined])
    const round = host.round(`c${turn}`, post)
    await settle(() => host.agentOf('gc').calls.length === turn)
    host.begin('gc')
    host.finish('gc', '[PASS]')
    await settle(() => round() !== undefined)
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
  assert.equal(host.begin('gc').source.askedBy, undefined)
  assert.match(text(host.agentOf('gc').calls[0]), /Chief: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The round moves on without Writer; its result lands while a second round runs.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
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
  await settle(() => second() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  assert.equal(host.begin('gc').source.askedBy, undefined)
  assert.ok(turn.content.some(block => block.type === 'file' && block.attachment?.attachmentId === file.attachmentId))
  assert.equal(text(turn).includes('@Tester'), false)
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  assert.equal(host.begin('gc').source.askedBy, undefined)
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  assert.equal(host.begin('gc').source.askedBy, undefined)
  assert.ok(text(host.agentOf('gc').calls[0]).includes('@Tester @Writer 看一下'))
  assert.equal(host.begin('gb').source.askedBy, undefined)
  host.finish('gc', '看过了。')
  host.finish('gb', '也看了。')
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 看一下文档').length, 1)
})

// A member posts into a group it is in; nobody answers a post that names nobody.
test('an ordinary member posts into its group from its own chat; nobody answers', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '文档有了新进展' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  assert.equal(host.agentOf('r1').calls.length, 1)

  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
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
  assert.equal(host.begin('gc').source.askedBy, undefined)
  assert.match(text(host.agentOf('gc').calls[0]), /Writer: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  await settle(() => first() !== undefined)
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
  await settle(() => round() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 记一下').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post with @all calls nobody', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@all 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  assert.deepEqual(host.agentOf('r1').calls, [])
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
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['User', undefined], ['Chief', 'stopped'], ['Writer', 'stopped']])
  assert.deepEqual(kinds(first()).filter(([kind]) => kind === 'stopped'), [['stopped', 'Chief'], ['stopped', 'Writer']])
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
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['Writer', 'stopped']])
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
  await settle(() => result() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
  host.finish('ga', '已交 Writer 处理。')
  await settle(() => first() !== undefined)
  assert.ok(kinds(first()).some(([kind, name]) => kind === 'message' && name === 'Chief'))
  assert.ok(kinds(first()).some(([kind, name]) => kind === 'failed' && name === 'Writer'))
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
  await settle(() => second() !== undefined)
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

test('what a member writes while it works shows in the round at once; body @Name never wakes, only delegate_work does', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下', 'k1', 'list_bots')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('docs/')))
  // Strict 3-way zero-echo: body @Tester in a step line never wakes Tester.
  assert.equal(host.agentOf('gc').calls.length, 0)
  // Explicit delegate_work calls Tester at once, while Writer still works.
  await host.tool('delegate_work', { to: 'Tester', goal: '你等下帮我验一下' }, 'gb')
  await settle(() => host.agentOf('gc').calls.length === 1)
  const live = await progress(host)
  assert.deepEqual(live.replies.map(reply => [reply.name, reply.text]), [
    ['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下'],
    ['Writer', '@Tester 你等下帮我验一下'],
  ])
  assert.deepEqual(live.speaking, ['b', 'c'])
  assert.match(text(host.begin('gc')), /Writer: 收到，我先看看 docs\/ 的结构。/)
  host.finish('gc', '验过了。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [
    ['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下'],
    ['Writer', '@Tester 你等下帮我验一下'],
    ['Tester', '验过了。'],
    ['Writer', '整理好了。'],
  ])
  assert.equal(host.agentOf('gc').calls.length, 1)
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => line.who), ['User', 'Writer', 'Writer', 'Tester', 'Writer'])
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
  await settle(() => result() !== undefined)
  assert.deepEqual(logLines(host).filter(line => line.botId === 'b').map(line => line.text), ['...', ellipsis, 'buy rice\n\n...'])

  const second = host.round('c2', host.say('@Writer 再看一眼'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  step(host, 'gb', '...', 'k5', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k5' })
  host.finish('gb', '好了。')
  await settle(() => second() !== undefined)
  assert.equal(logLines(host).filter(line => line.botId === 'b' && line.text === '...').length, 2)

  const third = host.round('c3', host.say('@Tester 看一下'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  step(host, 'gc', '...', 'k6', 'list_bots')
  host.emit('gc', 'tool/result', { callId: 'k6' })
  host.finish('gc', '看过了。')
  await settle(() => third() !== undefined)
  assert.equal(logLines(host).filter(line => line.botId === 'c' && line.text === '...').length, 1)
})

test('a repeated @ line in step text is deduplicated and wakes nobody (zero-echo)', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '@Tester ...', 'k1', 'list_bots')
  step(host, 'gb', '@Tester ...', 'k2', 'list_bots')
  await settle(() => rt.roomOf('r1').log.some(line => line.text === '@Tester ...'))
  const stored = () => rt.roomOf('r1').log.filter(line => line.text === '@Tester ...')
  assert.equal(stored().length, 1)
  assert.equal(host.agentOf('gc').calls.length, 0)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', '好了。')
  await settle(() => result() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 0)
  assert.equal(logLines(host).filter(line => line.text === '@Tester ...').length, 1)
})

test('a follow_up_to delegate_work wakes the member again after its earlier result returned', async (t) => {
  const host = await start(t, { members: ['b', 'c'], admin: 'b' })
  const result = host.round('c1', host.say('@Writer write a short doc, then ask Tester to review it'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'prepare for the doc review' }, 'gb')
  host.finish('gb', '[PASS]')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', 'Ready to review.')
  await settle(() => host.agentOf('gb').calls.length === 2)
  const wake = host.begin('gb')
  assert.ok(wake.source.resultRef)
  await host.tool('delegate_work', { to: 'Tester', goal: 'the doc is ready for review', follow_up_to: wake.source.resultRef }, 'gb')
  host.finish('gb', '[PASS]')
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.match(text(host.begin('gc')), /Writer: @Tester the doc is ready for review/)
  host.finish('gc', 'I reviewed the doc.')
  await settle(() => host.agentOf('gb').calls.length === 3)
  host.begin('gb')
  host.finish('gb', 'All reviewed.')
  await settle(() => result() !== undefined)
})

test('a directed wait-cycle ring rejects the delegate_work call that closes it', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Chief start the review'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'please check the document' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('delegate_work', { to: 'Tester', goal: 'please check the first section' }, 'gb')
  host.finish('gb', '[PASS]')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  await assert.rejects(
    host.tool('delegate_work', { to: 'Chief', goal: 'the first section needs another example' }, 'gc'),
    /already waiting for your result/,
  )
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.finish('gc', 'Section 1 needs another example.')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Updated section 1.')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => result() !== undefined)
})

test('two post_to_group calls both store the same line', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '...' }, 'b')
  await host.tool('post_to_group', { group: 'Ops', message: '...' }, 'b')
  assert.equal(logLines(host).filter(line => line.text === '...').length, 2)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
  const second = host.round('c2', host.say('@Writer 再看'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Tests passed')
  await settle(() => second() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '把文档整理好' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，开始整理。', 'k1')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Writer'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '目录理好了。', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  step(host, 'gb', '正文改完了，在改索引。', 'k3')
  await settle(() => true)
  assert.equal(logLines(host).some(line => line.text.includes('目录理好了。')), false)
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === '目录理好了。\n\n正文改完了，在改索引。'))
  assert.deepEqual(host.agentOf('r1').calls, [], 'visible step update writes directly to ledger with 0 room wakes')

  // A line still held when the work ends opens the result, and only the final result wakes Chief.
  host.emit('gb', 'tool/result', { callId: 'k3' })
  step(host, 'gb', '索引也改完了。', 'k4')
  host.emit('gb', 'tool/result', { callId: 'k4' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.late, done.source.done, done.source.askedBy], [true, true, 'a'])
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === '索引也改完了。\n\n整理好了，在 docs/ 下。'))
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a step with body @Name after the round went on is visible and wakes nobody (zero-echo)', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  step(host, 'gb', '@Tester 帮我跑一下测试', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, post.source.quiet, post.source.route?.kind], [true, true, 'visible'])
  const result = host.round('c1', post)
  await settle(() => result() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
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
  await settle(() => result() !== undefined)
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
  // A second delegated work tracked in SQLite that Writer has not finished yet.
  await host.tool('delegate_work', { to: 'Writer', goal: 'run the checks' }, 'c')
  assert.equal((await host.call('state', {})).value.activity.b, 'working')

  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('c').calls.length === 1)
  const replyA = host.agentOf('a').calls[0]
  assert.deepEqual([replyA.source.role, replyA.source.replyTo], ['reply', 'x1'])
  assert.match(text(replyA), /^\[Work(?:\s+#W\d+)? completed by Writer[^\n]*\]\nWriter was deleted before it could answer your message\.$/)
  const replyC = host.agentOf('c').calls[0]
  assert.match(text(replyC), /Writer was deleted/)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '去读一下构建日志' }, 'ga')
  host.finish('ga', '[PASS]')

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
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Chief', '@Writer 去读一下构建日志'],
    ['Writer', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。'],
    ['Chief', '默认设成 bar。'],
  ])
})

// #872: Chief calls Writer while continuing with its own part. Writer's
// result lands while Chief is still in that turn, which cannot see it, so Chief
// answers it in a turn of its own once the first one ends.
test('a caller still in its own turn answers the batch result after that turn (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '去读构建日志' }, 'ga')
  step(host, 'ga', '我先看配置。', 'k0', 'read')
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
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => reply.name), ['Chief', 'Chief', 'Writer', 'Chief', 'Chief'])
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
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(first().replies.map(reply => reply.name), ['Writer'])
})

// Parallel fan-in barrier: when Chief delegates to Writer and Tester in one turn and both go
// past the 15s grace, Writer's early result logs at once without waking Chief, and
// Tester's final result wakes Chief once with both results.
test('parallel batch barrier posts each late reply at once and wakes the caller once when all finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '检查文档' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '检查测试' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Chief'], ['working', 'Writer'], ['working', 'Tester']])

  // Writer finishes first while Tester is still working: its reply logs straight to room.log without waking Chief.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档检查完毕，没有断链。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === '文档检查完毕，没有断链。'))
  assert.deepEqual(host.agentOf('r1').calls, [], 'does not wake room or Chief while Tester is still working')
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
  await settle(() => third() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [['Writer', '好的，我看看。']])
})

// #872: a retried promise that a late turn passes on still tells the member that asked
// the work is done, as a result that went out as a step line does.
test('a late member that passes on the promise retry still hands the work back (#872)', async (t) => {
  const host = await start(t)
  // A SQLite room_call the member reads after the round moved on: no round waits for this turn.
  const opened = rt.openRoomCall(rt.roomOf('r1'), 'a', [rt.botOf('b')])
  const workId = opened.children[0].work.workId
  host.agentOf('gb').followup({ content: [{ type: 'text', text: '[Group chat "Ops" · Chief delegated a task to you]\n看一下文档' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'x1', askedBy: 'a', work: workId, batchKey: workId } })
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
  await host.tool('delegate_work', { to: 'Writer', goal: '收到，辛苦了' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '@Chief vinberoj estas pretaj')

  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '@Writer vinberoj estas pretaj')

  await settle(() => first() !== undefined)
  const pausedReplies = first().replies.filter(reply => reply.kind === 'paused')
  assert.equal(pausedReplies.length, 0)
  const saved = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1
  assert.deepEqual(saved().log.filter(line => line.botId).map(line => line.route.kind), ['request', 'result', 'visible'])
  assert.equal(host.agentOf('gb').calls.length, 1, 'closing ack with body @Writer never re-wakes Writer')

  // A Bot's quiet late result opens a round, which leaves nothing parked.
  const second = host.round('c2', { content: [{ type: 'text', text: '[Group post from Tester]\n测试跑完了' }], source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'x2', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', late: true, quiet: true } })
  await settle(() => second() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.equal(saved().paused, undefined)

  const third = host.round('c3', host.say('@Writer 好了，说正事'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  assert.equal(host.agentOf('ga').calls.length, 2)
  await settle(() => third() !== undefined)
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

  await settle(() => first() !== undefined)
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

  // stop-room-work logs Writer as stopped directly into room.log without queueing a relay post.
  assert.ok(logLines(host).some(line => line.botId === 'b' && line.kind === 'stopped'))
  assert.deepEqual(host.agentOf('r1').calls, [])

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
    await settle(() => first() !== undefined)
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
    await settle(() => first() !== undefined)
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
  await settle(() => round() !== undefined)
  assert.equal(round().failed, undefined, 'member own turn was not marked failed')
})

test('approval keeps a member inside its parallel batch until all results arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('review1', host.say('检查文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '检查文档' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '检查测试' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb'); host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: '{}' })
  rt.yieldRoomTurn('gb')
  await settle(() => [...rt.roomProgress.values()].some(r => r.slots.some(s => s.id === 'b' && s.status === 'waiting-approval')))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档已检查完毕。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === '文档已检查完毕。'))
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(host.agentOf('ga').calls.length, 1, 'caller waits until Tester also finishes')
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试已检查完毕。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  const third = host.round('review3', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '文档和测试已全部检查。')
  await settle(() => third() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 2, 'one continuation for the complete batch')
})


test('stopping a group before its callee starts clears the pending batch', async t => {
  const host = await start(t)
  host.emit('r1', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('检查文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '检查文档' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(rt.roomBatchPending('r1'), true)
  host.agentOf('r1').cancel = () => first.cancel()
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.value, true)
  await settle(() => first() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '把首页标题改成春季上新' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  await host.tool('delegate_work', { to: 'Writer', goal: '顺便把测试跑一遍' }, 'gc')
  host.finish('gc', '[PASS]')
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
  assert.equal(wakeNote(host.agentOf('gb').calls[1]), 'Tester delegated a task to you')
  host.begin('gb')
  workStep(host, 'gb', 'k2')
  host.finish('gb', '测试跑完，全过。')
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: 测试跑完，全过。/)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await settle(() => first() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '读构建日志' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '跑全量测试' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)

  // Tester calls Writer for a log of its own while Writer reads the build log.
  await host.tool('delegate_work', { to: 'Writer', goal: '也帮我查一下磁盘空间' }, 'gc')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const call = host.round('c2', host.takePost())
  await settle(() => call() !== undefined)
  assert.deepEqual(kinds(call()).filter(([kind]) => kind === 'working'), [['working', 'Writer']])
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.equal(correction.source.askedBy, 'c')
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })

  // Writer's result for Chief waits for Tester, who is still at work.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1：日志里缺环境变量 FOO。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === 'R1：日志里缺环境变量 FOO。'))
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief is not woken before Tester is done')

  // The turn that answers Tester's call is Writer's second; Tester is still running Chief's call,
  // so Writer's nested result queues in Tester's inbox until Tester finishes its current turn.
  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.askedBy, 'c')
  workStep(host, 'gb', 'k3')
  host.finish('gb', 'R3：磁盘还剩 40G。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text === 'R3：磁盘还剩 40G。'))

  // Tester finishes its running turn -> resumes first with Writer's nested R3, then returns its combined
  // answer to Chief, waking Chief once with Writer's R1 + Tester's combined answer.
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2：测试全过，等待磁盘结论。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const testerWake = host.takePost()
  assert.equal(testerWake.source.askedBy, 'c')
  const roundTester = host.round('c4', testerWake)
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: R3：磁盘还剩 40G。/)
  host.begin('gc')
  host.finish('gc', 'R2：测试全过且磁盘还剩 40G。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('ga').calls[1]), 'Writer and Tester finished the work you asked for')
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: R1：日志里缺环境变量 FOO。/)
  assert.match(text(host.agentOf('ga').calls[1]), /Tester: R2：测试全过且磁盘还剩 40G。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => roundTester() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 2)
  assert.equal(host.agentOf('gc').calls.length, 2)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '读构建日志' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '跑全量测试' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
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
// wake the caller early. It writes directly to the ledger; the batch end still wakes the
// caller exactly once.
test('a late pass inside a parallel batch posts its change line quietly', async (t) => {
  const { host, relay } = await batchInBackground(t)
  const changes = { sessionId: 'gb', seq: 21, turn: 5, total: 1, added: 4, deleted: 1, files: [{ path: 'batch.md', added: 4, deleted: 1 }] }
  rt.turnChanges = async sessionId => (sessionId === 'gb' ? changes : undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '[PASS]')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.kind === 'done'))
  assert.deepEqual(logLines(host).find(line => line.botId === 'b' && line.kind === 'done')?.changes, changes)
  assert.deepEqual(host.agentOf('r1').calls, [])
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
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('R1-WRITER')))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Tester is still at work')
  // Tester narrates nine steps, each more than ROOM_STEP_GAP_MS apart.
  for (let i = 1; i <= 9; i += 1) {
    host.emit('gc', 'tool/result', { callId: i === 1 ? 'k2' : `p${i - 1}` })
    step(host, 'gc', `测试进度 ${i}/9`, `p${i}`)
    t.mock.timers.tick(ROOM_STEP_GAP_MS)
    await settle(() => logLines(host).some(line => line.botId === 'c' && line.text.includes(`测试进度 ${i}/9`)))
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
  assert.ok(prompt.includes('R2-TESTER'))
  host.begin('ga')
  host.finish('ga', '缺 FOO，补上。')
})

test('a batch wake does not repeat a result that its prompt shows anyway', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('R1-WRITER')))
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
  await host.tool('delegate_work', { to: 'Writer', goal: '读构建日志' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '跑全量测试' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', result)
  await settle(() => host.agentOf('ga').calls.length === 1 && rt.roomOf('r1').log.some(line => line.who === 'Tester'))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '做甲' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  await host.tool('delegate_work', { to: 'Writer', goal: '做乙' }, 'gc')
  host.finish('gc', '[PASS]')
  host.begin('gd')
  await host.tool('delegate_work', { to: 'Writer', goal: '做丙' }, 'gd')
  host.finish('gd', '[PASS]')
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
  await settle(() => first() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

// Chief calls Writer and Tester. Tester finishes tool work in the round; Chief follows up
// with a post to Writer, and Writer answers. Chief wakes once with both results.
test('a batch that takes over from an emptied one keeps its finished work', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '读构建日志' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '跑全量测试' }, 'ga')
  host.finish('ga', '[PASS]')
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
  await settle(() => first() !== undefined)
})

test('a batch whose last member fails wakes the caller with the results of the others', async (t) => {
  const { host } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('R1-WRITER')))
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

test('an early member result in a parallel batch is logged directly and carried in the single final wake', async (t) => {
  const { host } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('R1-WRITER')))
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
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
  await host.tool('delegate_work', { to: 'Writer', goal: '检查文档' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '检查测试' }, 'ga')
  host.finish('ga', '[PASS]')
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
  await settle(() => first() !== undefined)
})

test('explicit calls from two Bots to the same member each settle independently for their own caller', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief @Tester 各自给 Writer 安排一件事'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '做甲' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  await host.tool('delegate_work', { to: 'Writer', goal: '说说你的想法' }, 'gc')
  host.finish('gc', '[PASS]')
  await settle(() => [...rt.roomProgress.values()].some(round => round.slots.filter(slot => slot.id === 'b').length === 2))
  host.begin('gb')
  workStep(host, 'gb', 'k1')
  host.finish('gb', '甲做完了。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for Chief\'s call')
  host.begin('ga')
  host.finish('ga', '[PASS]')
  // Tester's explicit delegate_work call also returns its answer to Tester.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '我觉得可以。')
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await settle(() => first() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

test('a batch wake says which member finished with no closing message of its own', async (t) => {
  const { host, relay } = await batchInBackground(t)
  // Writer reports in a step line and ends with nothing more to say.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', 'R1-WRITER：日志结论是缺环境变量 FOO。', 'p1')
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('R1-WRITER')))
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
  await settle(() => first() !== undefined)
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
  await host.tool('delegate_work', { to: 'Writer', goal: '请先导出初稿' }, 'ga')
  host.finish('ga', '已交给 Writer，我稍后汇报。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '正在导出报告到 [report.pptx](report.pptx)，稍后汇报。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  await settle(() => relay() !== undefined)
  const record = logLines(host).find(line => line.text?.includes('missing-report.md'))
  assert.deepEqual(record.claims, { missingFiles: [missing] })
  assert.equal(record.session, true)

  const postedMissing = join(root, 'gone.md').replace(/\\/g, '/')
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 请看 [gone.md](./gone.md)' }, 'a', { agent: { id: 'a', session: { header: { cwd: root } } } })
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
  await settle(() => relay() !== undefined)
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
  await settle(() => logLines(host).some(line => line.botId === 'b' && line.text.includes('missing-report.md')))
  const line = logLines(host).find(entry => entry.botId === 'b' && entry.text.includes('missing-report.md'))
  assert.deepEqual(line.claims, { missingFiles: [missing] })
  assert.deepEqual(host.agentOf('r1').calls, [], 'does not wake caller before sibling finishes')
})

// A room call is persisted in SQLite (`coordDb`), so who still owes whom survives a restart.
test('a call batch is saved with the team while its member works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '整理文档' }, 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  const saved = activeCallWorks('r1')
  assert.deepEqual(saved.map(w => [w.roomId, w.meta?.callerBotId, w.botId, w.status]), [['r1', 'a', 'b', 'running']])
  host.finish('gb', '文档好了')
})

// After a restart, a member that does not pick its work up again never answers: the call
// settles without it, and the Bot that asked is woken once with the result that came.
test('after a restart a batch whose last member is gone wakes the caller with the results it has', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const host = await start(t, { log, seq: 3, shown: 3 })
  const room = rt.roomOf('r1')
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  const testerChild = opened.children.find(ch => ch.peer.id === 'c')
  rt.coordDb.updateApiMeta(opened.parentWork.workId, () => ({ done: ['Tester'], doneIds: ['c'], results: [{ name: 'Tester', botId: 'c', seq: 3 }], worked: true }))
  rt.coordDb.settleWork({ workId: testerChild.work.workId, outcome: 'done', force: true, summary: 'TESTER-RESULT：测试全过。', resultRef: 'G3' })
  await rt.settleRoomBatches()
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.done, post.source.askedBy, post.source.batch], ['post', true, 'a', opened.parentWork.workId])
  host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const wake = text(host.agentOf('ga').calls[0])
  assert.match(wake, /Tester finished the work you asked for/)
  assert.match(wake, /TESTER-RESULT/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => activeRoomWorks('r1').length === 0)
})

test('after a restart a batch nobody finished is dropped without waking anyone', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  await rt.settleRoomBatches()
  await settle(() => activeRoomWorks('r1').length === 0)
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
  await settle(() => first() !== undefined && second() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 0, 'nothing started after the stop')
  assert.equal(rt.roomActive('r1'), false)
  // The group's next message takes the draft with it: the admin is called for the goal.
  host.round('c3', host.say('继续'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /The user wants this group to reach a goal: Ship v1/)
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
  await settle(() => first() !== undefined && second() !== undefined)
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
// Bot that asked when the missing sibling exits at startup.
test('after a restart a batch whose finished member was renamed still wakes the caller', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const host = await start(t, { log, seq: 3 })
  const room = rt.roomOf('r1')
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  const childC = opened.children.find(child => child.peer.id === 'c')
  rt.coordDb.updateApiMeta(opened.parentWork.workId, () => ({
    done: ['Tester'],
    doneIds: ['c'],
    results: [{ name: 'Tester', botId: 'c', seq: 3 }],
    worked: true,
  }))
  rt.coordDb.settleWork({ workId: childC.work.workId, outcome: 'done', force: true, summary: 'TESTER-RESULT：测试全过。', resultRef: 'G3' })
  rt.botOf('c').name = 'QA'
  await rt.settleRoomBatches()
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.done, post.source.askedBy], [true, 'a'])
  const done = host.round('c-renamed', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /TESTER-RESULT/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => done() !== undefined)
  assert.deepEqual(activeRoomWorks('r1'), [])
})

// A member whose work a restart left queued in DSH inbox is adopted rather than dropped,
// so the call work keeps waiting for it without waking the caller early.
test('after a restart a member whose pick-up is still queued keeps its batch waiting', async (t) => {
  let host
  host = await start(t, {}, { agents: { get: id => host?.agentOf(id) } })
  const room = rt.roomOf('r1')
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b')])
  const childB = opened.children[0].work
  const deliveryKey = 'dk-queued-b'
  rt.coordDb.recordDirectDeliveryAttempt({
    workId: childB.workId,
    idempotencyKey: deliveryKey,
    sessionId: 'gb',
  })
  const gbAgent = host.agentOf('gb')
  gbAgent.session.snapshotEvents = () => []
  gbAgent.inbox.nextTurn.push({
    id: 'parked-gb-1',
    content: [{ type: 'text', text: '整理文档' }],
    source: {
      kind: 'ds-bot',
      role: 'room',
      roomId: 'r1',
      askedBy: 'a',
      workId: childB.workId,
      exchangeId: 'x-queued',
      idempotencyKey: deliveryKey,
    },
  })
  await rt.settleRoomBatches()
  await settle(() => gbAgent.calls.length === 1)
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(activeCallWorks('r1').map(w => w.botId), ['b'])
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
  await settle(() => first() !== undefined && !rt.roomActive('r1'))
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
  await settle(() => first() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Writer: 核对完毕，一切正常。/)

  const postedQuiet = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 仅通知', report_back: false }, 'a')
  assert.match(postedQuiet, /nothing comes back to you/)
  const second = host.round('c2', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '收到通知。')
  await settle(() => second() !== undefined)
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
  await host.tool('delegate_work', { to: 'Tester', goal: '跑测试' }, 'lb')
  await host.tool('delegate_work', { to: 'Reviewer', goal: '做代码审查' }, 'lb')
  host.finish('lb', '[PASS]')
  await settle(() => host.agentOf('lc').calls.length === 1 && host.agentOf('ld').calls.length === 1)
  host.begin('lc')
  host.begin('ld')
  host.emit('lc', 'tool/call', { callId: 'tc1', name: 'pwsh', arguments: '{}' })
  host.emit('ld', 'tool/call', { callId: 'td1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => round1() !== undefined)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'must not cut off Chief while members are still working past 15s')

  // Tester finishes first (logged directly to r2 while Reviewer still works, no r2 wake relay yet).
  host.emit('lc', 'tool/result', { callId: 'tc1' })
  host.finish('lc', '测试全绿（128/128）。')
  await settle(() => rt.roomOf('r2').log.some(line => line.text.includes('测试全绿')))
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('r2').calls.length, 0, 'early sibling must not post a wake relay while Reviewer is still pending')
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
  await settle(() => round3() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /\[Group chat "Lab" · replies to your post\]/)
  assert.match(report, /Tester: 测试全绿（128\/128）。/)
  assert.match(report, /Reviewer: 审查通过，无阻断问题。/)
  assert.match(report, /Writer: 全部验收通过：测试 128\/128 且代码审查无阻断问题，可以交付。/)
  assert.deepEqual(activeRoomReports('r2'), [])
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
  await settle(() => round1() !== undefined)
  assert.equal(host.agentOf('a').calls.length, 0)

  host.emit('lc', 'tool/result', { callId: 'tc1' })
  host.finish('lc', '日志定位完成：缺少 API_URL 环境变量。')
  await settle(() => host.agentOf('r2').calls.length === 1)
  const post2 = host.agentOf('r2').calls.shift()
  const round2 = host.round('l2', { content: post2.content, source: post2.source }, 'r2')
  await settle(() => round2() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Tester: 日志定位完成：缺少 API_URL 环境变量。/)
  assert.deepEqual(activeRoomReports('r2'), [])
})

test('stopping or restarting a group settles pending roomReports instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 1) Stop settles pending report with stopped note.
  const host1 = await start(t)
  await host1.tool('post_to_group', { group: 'Ops', message: '@Writer 跑长任务' }, 'a')
  const r1 = host1.round('c1', host1.takePost())
  await settle(() => host1.agentOf('gb').calls.length === 1)
  host1.begin('gb')
  host1.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => r1() !== undefined)
  assert.equal(host1.agentOf('a').calls.length, 0)
  await host1.call('stop-room-work', { roomId: 'r1' })
  host1.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host1.agentOf('a').calls.length === 1)
  assert.match(text(host1.agentOf('a').calls[0]), /stopped before finishing/)

  // 2) Restart reconciliation settles persisted tracking report with logged replies.
  const log = [{ seq: 1, who: 'Chief', botId: 'a', text: '@Writer 查一下', session: true }, { seq: 2, who: 'Writer', botId: 'b', text: '重启前已写好的结论。' }]
  const host3 = await start(t, { log, seq: 2 })
  rt.openRoomReportCall(rt.roomOf('r1'), { id: 'rep1', botId: 'a', name: 'Chief', status: 'tracking', fromSeq: 2 })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host3.agentOf('a').calls.length === 1)
  assert.match(text(host3.agentOf('a').calls[0]), /Writer: 重启前已写好的结论。/)
  assert.deepEqual(activeRoomReports('r1'), [])

  // 3) Restart reconciliation of a persisted queued report reports never-started and never dumps seq 1..N history.
  const oldLog = [
    { seq: 1, who: 'User', text: '旧问题' },
    { seq: 2, who: 'Writer', botId: 'b', text: '不该泄露的旧历史回答。' },
  ]
  const host4 = await start(t, { log: oldLog, seq: 2 })
  rt.openRoomReportCall(rt.roomOf('r1'), { id: 'repQ', botId: 'a', name: 'Chief', status: 'queued' })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host4.agentOf('a').calls.length === 1)
  const queuedMsg = text(host4.agentOf('a').calls[0])
  assert.match(queuedMsg, /did not start before DS Bot restarted/)
  assert.doesNotMatch(queuedMsg, /不该泄露的旧历史回答/)
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('deleting a group settles pending roomReports with deleted notice instead of empty result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host2 = await start(t)
  await host2.tool('post_to_group', { group: 'Ops', message: '@Writer 跑另一个长任务' }, 'a')
  const r2 = host2.round('c1', host2.takePost())
  await settle(() => host2.agentOf('gb').calls.length === 1)
  host2.begin('gb')
  host2.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => r2() !== undefined)
  assert.equal(host2.agentOf('a').calls.length, 0)
  assert.equal((await host2.call('delete-room', { id: 'r1' })).ok, true)
  await settle(() => host2.agentOf('a').calls.length === 1)
  assert.match(text(host2.agentOf('a').calls[0]), /was deleted before it finished/)
})

test('ordinary member post_to_group without @mention stays quiet and rejects report_back: true (#1894)', async (t) => {
  const host = await start(t)
  const quiet = await host.tool('post_to_group', { group: 'Ops', message: '同步一下进展，无需回复' }, 'b')
  assert.match(quiet, /Nobody answers it/)
  assert.deepEqual(activeRoomReports('r1'), [])
  host.agentOf('r1').calls.length = 0
  const refused = await host.tool('post_to_group', { group: 'Ops', message: '同步一下进展', report_back: true }, 'b')
  assert.match(refused, /Nobody would answer/)
  assert.equal(host.agentOf('r1').calls.length, 0, 'refused report_back: true post must not be posted')
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('stop-room-work with active group_goal and queued report settles cleanly without hanging (#1894)', async (t) => {
  const host = await start(t)
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Writer', task: 'build' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Ship v3', objective: 'Deliver', acceptance: 'green', stages: oneStage }, 'ga'), /Started\./)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 帮我跑一下' }, 'a')
  const queuedReports = activeRoomReports('r1')
  assert.equal(queuedReports.length, 1)
  assert.equal(queuedReports[0].apiMeta?.status ?? queuedReports[0].meta?.status, 'queued')

  // Stopping the group via channel endpoint sets goal.idle and settles even queued reports.
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.equal(rt.roomOf('r1').goal.idle, true)
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('post_to_group when room has paused no-progress work reports paused instead of saying nobody replied (#1894)', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b')])
  rt.coordDb.pauseWork(opened.children[0].work.workId, { reason: 'no_progress', pauseChain: true })
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 收到，待命' }, 'a')
  const round = host.round('c-paused-report', host.takePost())
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await settle(() => round() !== undefined)
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
  await settle(() => round() !== undefined)
  assert.equal(host.agentOf('a').calls.length, 0)

  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('scoped mid-round post_to_group expands report.ids when called member starts a new round via delegate_work (#1894)', async (t) => {
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
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('a').calls.length, 0, 'scoped report must wait for Tester')

  // While no round is running, Tester delegates to Writer ('b') -> runRoundFrom expands report.ids!
  await host.tool('delegate_work', { to: 'Writer', goal: '帮我复核一下结果' }, 'gc')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const delegatePost = host.takePost()
  const round2 = host.round('c2', delegatePost)
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k-b2', name: 'pwsh', arguments: '{}' })
  // Round 2 moves on past Writer (>15s); Tester finishes while Writer is still working on the expanded call.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => round2() !== undefined)
  host.emit('gc', 'tool/result', { callId: 'k-c' })
  host.finish('gc', '已交 Writer 复核。')
  await settle(() => rt.roomOf('r1').log.some(line => line.botId === 'c' && line.text.includes('已交 Writer 复核。')))
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
  await settle(() => round3() !== undefined)
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
  await settle(() => round() !== undefined)
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
  const savedOrigin = { connId: 'c1', chatKey: 'dm-u1', senderId: 'u1', binding: 'bot:a' }
  rt.coordDb.updateApiMeta(`room-report:${reportId}`, prev => ({ ...prev, imOrigin: savedOrigin }))

  // 1) Room moved to a new part 'r1-p2'; old part 'r1' removing the forwarded inbox message must NOT settle or drop imOrigin.
  room.sessionId = 'r1-p2'
  fireDiscarded('r1', post)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'earlier-part inbox removal must not settle queued report')
  const r1Work = reportWork(reportId)
  assert.equal(r1Work?.apiMeta?.status ?? r1Work?.meta?.status, 'queued')
  assert.deepEqual(rt.roomReportImOrigin('r1'), savedOrigin)

  // 2) While room's own Session is marked switching, inbox discard must NOT settle either.
  rt.state.switching['r1-p2'] = { roomId: 'r1' }
  fireDiscarded('r1-p2', post)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'discard while room Session switches must not settle queued report')
  const r2Work = reportWork(reportId)
  assert.equal(r2Work?.apiMeta?.status ?? r2Work?.meta?.status, 'queued')
  delete rt.state.switching['r1-p2']

  // 3) Genuine discard on the current non-switching room Session settles the queued report cleanly.
  fireDiscarded('r1-p2', post)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.deepEqual(activeRoomReports('r1'), [])
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
  await settle(() => round() !== undefined)
  // Drain the goal-check nudge queued by goalDrive so only the active goal holds the tracking report open.
  const nudge = host.agentOf('r2').calls.shift()
  if (nudge?.source?.exchangeId) rt.roomRelayTaken('r2', nudge.source.exchangeId)
  assert.equal(host.agentOf('a').calls.length, 0, 'active goal holds tracking report open')

  // Stopping the group marks report.stopped BEFORE goalUserStopped triggers settleRoomReports.
  assert.equal((await host.call('stop-room-work', { roomId: 'r2' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before finishing/)
  assert.deepEqual(activeRoomReports('r2'), [])
})

test('stop-room-work withdraws queued post_to_group relays while preserving deferred user images (#1894)', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
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
  rt.openRoomReportCall(room, { id: 'rep-stop-1', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 2 })
  rt.noteRoomRelayQueued('r1', 'ex-stop-1')
  roomAgent.followup(queuedPost)
  // Also seed an open room call work and queue a terminal wake relay that Stop All must clear.
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b')])
  roomAgent.followup({
    content: [{ type: 'text', text: '[Group post from Writer]\n迟到答复' }],
    source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-batch-end', late: true, batch: opened.parentWork.workId, parentWorkId: opened.parentWork.workId, senderName: 'Writer', senderSessionId: 'b', roomId: 'r1' },
  })
  assert.equal(roomAgent.inbox.nextTurn.length, 2)

  // Stop All withdraws the queued Bot post and settles its report once, without dropping the user's screenshot.
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => first() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /stopped before your post started/)
  assert.equal(roomAgent.inbox.nextTurn.some(item => item.source?.exchangeId === 'ex-stop-1'), false, 'queued Bot relay must be withdrawn from room inbox')
  assert.deepEqual(activeRoomWorks('r1'), [], 'stop-room-work must close active call works')
  assert.deepEqual(activeRoomReports('r1'), [])

  // Even if the stopped relay was already claimed before removal, replaying it skips the stopped
  // Bot post while bringing back ONLY the preserved user screenshot from laterPosts!
  const replay = host.round('c-replay', queuedPost)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.agentOf('gc').calls[0]), /看这张截图/)
  assert.doesNotMatch(text(host.agentOf('gc').calls[0]), /不要再跑的任务/)
  host.begin('gc')
  host.finish('gc', '看到截图了。')
  await settle(() => replay() !== undefined)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 1, 'cancelled Bot relay must not send a second report')
})

test('group background task delegating to its own group via post_to_group settles without self-deadlock (#1894)', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
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
  rt.coordDb.createWork({
    workId: 'task:task-self-1',
    botId: 'b',
    kind: 'task',
    logicalAddress: 'task:task-self-1',
    status: 'waiting',
    roomId: 'r1',
    sessionId: 'bt-self-1',
  })
  // Also simulate the realistic parent room call held open while Writer's background task runs.
  rt.openRoomCall(room, 'a', [rt.botOf('b')])

  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 帮我复核一下' }, 'bt-self-1')
  const post = host.takePost()
  assert.equal(reportWork(post.source.reportId)?.meta?.fromTaskId, 'task-self-1')
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '复核通过。')
  await settle(() => round() !== undefined)
  await settle(() => host.agentOf('bt-self-1').calls.length === 1)
  assert.match(text(host.agentOf('bt-self-1').calls[0]), /Tester: 复核通过。/)
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('post_to_group reports waiting-for-user-answer when a named member opens ask_user (#1894)', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 帮我确认发布版本' }, 'a')
  const post = host.takePost()
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  // Writer opens a question card (waiting for user answer) and ends its turn.
  rt.state.questions.gb = { id: 'q-rel', prompt: '选择发布版本', options: ['v1', 'v2'], at: Date.now() }
  host.finish('gb', '请先选择发布版本。')
  await settle(() => round() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Waiting for the user's answer in "Ops": Writer\./)
  assert.doesNotMatch(report, /Nobody replied/)
  assert.ok(rt.state.questions.gb !== undefined, 'question card remains open for user answer')
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('scoped mid-round post_to_group expands report.ids when called member delegates in the same round (#1894)', async (t) => {
  const { host, first } = await busyRound(t)
  // Chief posts mid-round calling Tester ('c') -> scoped report with ids: ['c'].
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 跑完测试并让 Chief 群内汇总' }, 'a')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k-test', name: 'pwsh', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k-test' })
  // Tester delegates to Chief ('ga') inside the same round -> expandScopedReports adds 'a' to report.ids!
  await host.tool('delegate_work', { to: 'Chief', goal: '请基于测试结果做群内汇总' }, 'gc')
  host.finish('gc', '测试全部通过。')
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '群内总结：测试通过，可以合入。')
  await settle(() => host.agentOf('gc').calls.length === 2)
  host.begin('gc')
  host.finish('gc', '[PASS]')
  host.finish('gb', 'Writer 完成无关文档。')
  await settle(() => first() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Tester: 测试全部通过。/)
  assert.match(report, /Chief: 群内总结：测试通过，可以合入。/)
  assert.doesNotMatch(report, /Writer 完成无关文档/)
})

test('startup settleRoomReports keeps queued reports still present in roomAgent.inbox and settles once after the round runs (#1894)', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
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
  rt.openRoomReportCall(room, { id: 'rep-vanished', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 2 })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /did not start before DS Bot restarted/, 'vanished sibling report must settle even while another relay survives in inbox')
  assert.equal(reportWork('rep-vanished'), undefined)
  const surviving = reportWork(reportId)
  assert.equal(surviving?.apiMeta?.status ?? surviving?.meta?.status, 'queued', 'surviving relay must stay queued')
  // Chief processes report 1 so its foreground claim releases before report 2 arrives.
  host.begin('a', host.agentOf('a').calls[0][1])
  host.finish('a', '[PASS]')

  // 2) Now DSH drains the inbox and runs the real round -> Chief receives the real reply for A once.
  roomAgent.inbox.nextTurn.length = 0
  const round = host.round('c-reload', queuedPost)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '重载后正常完成。')
  await settle(() => round() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.match(text(host.agentOf('a').calls[1]), /Writer: 重载后正常完成。/)
  assert.doesNotMatch(text(host.agentOf('a').calls[1]), /did not start before DS Bot restarted/)
  host.begin('a', host.agentOf('a').calls[1][1])
  host.finish('a', '[PASS]')

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
  rt.openRoomReportCall(room, { id: 'rep-after-um', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 3 })
  await rt.settleRoomReports(undefined, { startup: true })
  await settle(() => host.agentOf('a').calls.length === 3)
  assert.match(text(host.agentOf('a').calls[2]), /did not start before DS Bot restarted/)
  assert.equal(reportWork('rep-after-um'), undefined)
  host.begin('a', host.agentOf('a').calls[2][1])
  host.finish('a', '[PASS]')

  // 4) Plugin reload DURING DSH preStep window (status: 'running', turn/start emitted, NO user/message yet):
  //    startup holds the report until the turn settles, then automatically re-checks via whenIdle().
  let releasePreStep
  roomAgent.status = 'running'
  roomAgent.session = {
    id: 'r1',
    snapshotEvents: () => [{ type: 'turn/start', data: { turn: 6 } }],
  }
  roomAgent.whenIdle = () => new Promise((resolve) => { releasePreStep = resolve })
  rt.openRoomReportCall(room, { id: 'rep-prestep', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 3 })
  await rt.settleRoomReports(undefined, { startup: true })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 3, 'preStep window must hold queued report until turn finishes')
  const preStepWork = reportWork('rep-prestep')
  assert.equal(preStepWork?.apiMeta?.status ?? preStepWork?.meta?.status, 'queued')

  // If the preStep turn belonged to something else and ends without claiming rep-prestep, whenIdle recheck settles it!
  roomAgent.status = 'idle'
  releasePreStep()
  await settle(() => host.agentOf('a').calls.length === 4)
  assert.match(text(host.agentOf('a').calls[3]), /did not start before DS Bot restarted/)
  assert.equal(reportWork('rep-prestep'), undefined)
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
  await settle(() => round() !== undefined)
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
  rt.openRoomReportCall(rt.roomOf('r2'), { id: 'rep-lab-missing', botId: 'a', name: 'Chief', status: 'queued', fromSeq: 1 })
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
  await settle(() => opsRound() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  host.begin('a', host.agentOf('a').calls[0][1])
  host.finish('a', '[PASS]')

  // Now release Lab's resolveAgent and finish startup. Ops's report must NOT be blocked by a stale re-inserted relay!
  rt.resolveAgent = origResolve
  releaseLabResolve()
  await startupPromise
  await settle(() => host.agentOf('a').calls.length === 2)
  const texts = host.agentOf('a').calls.map(text)
  assert.ok(texts.some(msg => msg.includes('Writer: 并发恢复后正常完成。')), 'Ops report must settle cleanly instead of hanging on a stale re-inserted relay')
  assert.ok(texts.some(msg => msg.includes('did not start before DS Bot restarted')), 'Lab vanished report must still settle')
  assert.deepEqual(activeRoomReports(), [])
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
  rt.coordDb.updateApiMeta(`room-report:${reportId}`, prev => ({ ...prev, imOrigin: savedOrigin }))
  host.emit('r1', 'user/message', deferredPost)
  await host.tool('group_relay', {}, 'r1', { callId: 'c-fin-2', signal: new AbortController().signal })
  const deferredBefore = reportWork(reportId)
  assert.equal(deferredBefore?.apiMeta?.status ?? deferredBefore?.meta?.status, 'queued')

  // Startup reconciliation runs while the post sits in laterPosts -> must preserve report & imOrigin!
  await rt.settleRoomReports(undefined, { startup: true })
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'deferred post in laterPosts must not falsely fail as never-started')
  const deferredAfter = reportWork(reportId)
  assert.equal(deferredAfter?.apiMeta?.status ?? deferredAfter?.meta?.status, 'queued')
  assert.deepEqual(rt.roomReportImOrigin('r1'), savedOrigin)

  // Release finalizing -> Round 2 starts from laterPosts -> Tester answers -> Chief gets the real report!
  releaseFinalizing()
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '延迟任务已完成。')
  await settle(() => first() !== undefined && host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /Tester: 延迟任务已完成。/)
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('instant work tools record worked without 15s grace yield, while read_document yields past grace and bgRunning yields working', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 1) group_todo (instant work tool): does NOT arm grace timer, DOES set worked, and wakes caller.
  {
    const host = await start(t)
    const first = host.round('c-inst', host.say('@Chief assign Writer'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'add the todo item' }, 'ga')
    host.finish('ga', '[PASS]')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'tc-todo', name: 'group_todo', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'tc-todo', name: 'group_todo', isError: false, content: [] })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(first(), undefined, 'instant work tool must not arm the 15s grace timer')
    // Writer replies without naming @Chief -> Chief is woken in the same round!
    host.finish('gb', 'Added the todo item.')
    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Got it, thanks.')
    await settle(() => first() !== undefined)
  }

  // 2) read_document (substantive non-instant work tool): DOES arm 15s grace timer and yields with working row.
  {
    const host = await start(t)
    const first = host.round('c-doc', host.say('@Writer read the spec'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'tc-doc', name: 'read_document', arguments: '{}' })
    t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
    await settle(() => first() !== undefined)
    assert.ok(kinds(first()).some(([kind, who]) => kind === 'working' && who === 'Writer'), 'read_document must yield after grace')
  }

  // 3) bgRunning branch: member finishes with active group background task and 0 direct tool events -> yields working.
  {
    const host = await start(t)
    rt.botOf('b').tasks = [{
      id: 'bt-bg-1', title: 'Index docs', sessionId: 'bt-bg-sess', status: 'running',
      roomId: 'r1', fromPart: 'gb', startedAt: Date.now(), updatedAt: Date.now(),
    }]
    rt.taskOwners.set('bt-bg-sess', { botId: 'b', taskId: 'bt-bg-1', roomId: 'r1' })
    const first = host.round('c-bg', host.say('@Writer start background job'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Background job is running.')
    await settle(() => first() !== undefined)
    assert.ok(kinds(first()).some(([kind, who]) => kind === 'working' && who === 'Writer'))
  }
})

test('hard-signal stagnation pauses and resumes cleanly, stopRoomWork clears paused calls, and acyclic 6-member chains have no hop cap', async (t) => {
  // 1) Hard-signal stagnation pauses after 3 identical zero-change checks, logs no_progress notice, and stopRoomWork clears paused works.
  {
    const host = await start(t)
    const r1 = rt.roomOf('r1')
    const opened = rt.openRoomCall(r1, 'a', [rt.botOf('b')])
    const childWork = opened.children[0].work
    for (let i = 0; i < 3; i += 1) {
      rt.checkRoomProgressStagnation(r1, childWork.workId, {
        callerId: 'a',
        calleeId: 'b',
        text: 'Still unchanged.',
      })
    }
    const pausedWork = rt.coordDb.getWork(childWork.workId)
    assert.equal(pausedWork?.status, 'paused')
    const notices = r1.log.filter(line => line.kind === 'notice' && line.reason === 'paused')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].cause, 'no_progress')
    assert.match(await host.tool('read_group_chat', { group: 'Ops' }, 'a'), /no measurable progress/)

    // stop-room-work stops paused works so they never resurrect.
    assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).ok, true)
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 2) All six members of an acyclic delegate_work chain get their own turn without a fixed hop cap.
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
    await host.tool('delegate_work', { to: 'Writer', goal: 'handoff step one' }, 'ga')
    host.finish('ga', '[PASS]')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    await host.tool('delegate_work', { to: 'Tester', goal: 'handoff step two' }, 'gb')
    host.finish('gb', '[PASS]')
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    await host.tool('delegate_work', { to: 'Reviewer', goal: 'handoff step three' }, 'gc')
    host.finish('gc', '[PASS]')
    await settle(() => host.agentOf('gd').calls.length === 1)
    host.begin('gd')
    await host.tool('delegate_work', { to: 'Editor', goal: 'handoff step four' }, 'gd')
    host.finish('gd', '[PASS]')
    await settle(() => host.agentOf('ge').calls.length === 1)
    host.begin('ge')
    await host.tool('delegate_work', { to: 'QA', goal: 'please inspect the output' }, 'ge')
    host.finish('ge', '[PASS]')
    await settle(() => host.agentOf('gf').calls.length === 1)
    host.begin('gf')
    host.finish('gf', 'QA verified the output.')
    for (const sid of ['ge', 'gd', 'gc', 'gb', 'ga']) {
      await settle(() => host.agentOf(sid).calls.length === 2)
      host.begin(sid)
      host.finish(sid, `Summary from ${sid}.`)
    }
    await settle(() => first() !== undefined)
    assert.equal(host.agentOf('gf').calls.length, 1, 'acyclic chain must reach QA without fixed hop cap')
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 3) User message resumes paused SQLite calls from the same parent and wakes caller once after both finish.
  {
    const host = await start(t)
    const r1 = rt.roomOf('r1')
    const opened = rt.openRoomCall(r1, 'a', [rt.botOf('b'), rt.botOf('c')])
    for (const child of opened.children) {
      rt.coordDb.pauseWork(child.work.workId, { reason: 'no_progress' })
    }
    const resumed = host.round('c-rel', host.say('continue'))
    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
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
    // Chief is woken ONCE after both Writer and Tester finish the shared parent work.
    await settle(() => host.agentOf('ga').calls.length === 2)
    host.begin('ga')
    host.finish('ga', 'Both received.')
    await settle(() => resumed() !== undefined)
    assert.deepEqual(activeRoomWorks('r1'), [])
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

  await settle(() => first() !== undefined)
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
  await settle(() => first() !== undefined)
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
  const room = rt.roomOf('r1')
  // Seed a parallel call where Writer and Tester finish late -> produces a real roomResult wake relay for Chief.
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  const [childB, childC] = opened.children
  await rt.lateRoomReply('gb', { roomId: 'r1', workId: childB.work.workId, exchangeId: 'ex-fold-b' }, 'WRITER-DONE：文档已整理。', { toolCount: 1 })
  await rt.lateRoomReply('gc', { roomId: 'r1', workId: childC.work.workId, exchangeId: 'ex-fold-c' }, 'TESTER-DONE：测试全过。', { toolCount: 1 })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const wakePost = host.takePost()

  // Fold BOTH the roomResult wake post for Chief AND a user @Writer message AND a quiet resumed post into one round.
  host.emit('r1', 'user/message', wakePost)
  host.emit('r1', 'user/message', host.say('@Writer 顺便看一下部署清单'))
  const done = host.round('c-fold-1', { content: [{ type: 'text', text: '' }], source: { kind: 'bot', form: 'relay', role: 'post', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', quiet: true, resumed: true } })

  // Both Chief (result wake with Writer + Tester results) and Writer (user @mention) must be called in the same round!
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gb').calls.length === 1)
  const chiefPrompt = text(host.agentOf('ga').calls[0])
  assert.match(chiefPrompt, /Writer and Tester finished the work you asked for/)
  assert.match(chiefPrompt, /TESTER-DONE/)
  assert.match(text(host.agentOf('gb').calls[0]), /顺便看一下部署清单/)
  assert.deepEqual(activeRoomWorks('r1'), [], 'parent work must close after settling its wake')

  host.begin('ga')
  host.finish('ga', '汇总收到。')
  host.begin('gb')
  host.finish('gb', '清单正常。')
  await settle(() => done() !== undefined)
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

  await settle(() => done() !== undefined && host.agentOf('a').calls.length === 1 && host.agentOf('d').calls.length === 1)
  const reportToChief = text(host.agentOf('a').calls[0])
  const reportToReviewer = text(host.agentOf('d').calls[0])
  assert.match(reportToChief, /WRITER-ONLY-RESULT/)
  assert.doesNotMatch(reportToChief, /TESTER-ONLY-RESULT/, 'Chief report must stay scoped to Writer and never cross-contaminate with Tester')
  assert.match(reportToReviewer, /TESTER-ONLY-RESULT/)
  assert.doesNotMatch(reportToReviewer, /WRITER-ONLY-RESULT/, 'Reviewer report must stay scoped to Tester and never cross-contaminate with Writer')
  assert.deepEqual(activeRoomReports('r1'), [])
})

test('stopping one member in a parallel batch via stopMemberWork wakes the caller with completed sibling results', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  const opened = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  const [childB, childC] = opened.children
  await rt.lateRoomReply('gb', { roomId: 'r1', workId: childB.work.workId, exchangeId: 'ex-stop-b' }, 'WRITER-PART：已完成前半段。', { toolCount: 1 })
  // Tester ('gc') is currently running a turn.
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'user/message', { content: [{ type: 'text', text: 'working' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-stop-c', askedBy: 'a', workId: childC.work.workId } })

  assert.equal(await rt.stopMemberWork('r1', 'c'), true)
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.stopped, true)
  assert.equal(post.source.askedBy, 'a', 'stopMemberWork must wake Chief instead of silently dropping Writer results')
  assert.equal(post.source.parentWorkId, opened.parentWork.workId)

  const done = host.round('c-stop-wake', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const wakePrompt = text(host.agentOf('ga').calls[0])
  assert.match(wakePrompt, /Writer finished the work you asked for/)
  assert.match(wakePrompt, /WRITER-PART/)
  host.begin('ga')
  host.finish('ga', '收到 Writer 的成果。')
  await settle(() => done() !== undefined)
  assert.deepEqual(activeRoomWorks('r1'), [])
})

test('lateRoomFailure wakes its caller with completed sibling results and reconcileStoppedRoomTask wakes every completed caller', async (t) => {
  const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, undefined, { d: { name: 'Reviewer', role: 'Lead' } })
  const room = rt.roomOf('r1')

  // 1) lateRoomFailure on Tester's call work wakes Chief with Writer's completed sibling result.
  const open1 = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  await rt.lateRoomReply('gb', { roomId: 'r1', workId: open1.children[0].work.workId, exchangeId: 'ex-lr-b1' }, 'WRITER-SHARED：结果已出。', { toolCount: 1 })
  await rt.lateRoomFailure('gc', { roomId: 'r1', workId: open1.children[1].work.workId }, { code: 'API_ERROR', message: 'upstream failed' })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const failPost = host.takePost()
  assert.equal(failPost.source.askedBy, 'a')
  const round1 = host.round('c-fail-wake', failPost)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /WRITER-SHARED/)
  host.begin('ga')
  host.finish('ga', 'Chief 收到。')
  await settle(() => round1() !== undefined)
  assert.deepEqual(activeRoomWorks('r1'), [])

  // 2) reconcileStoppedRoomTask with two callers (Chief 'a' and Reviewer 'd') both waiting on Tester ('c').
  const openChief = rt.openRoomCall(room, 'a', [rt.botOf('b'), rt.botOf('c')])
  const openRev = rt.openRoomCall(room, 'd', [rt.botOf('b'), rt.botOf('c')])
  await rt.lateRoomReply('gb', { roomId: 'r1', workId: openChief.children[0].work.workId, exchangeId: 'ex-rec-b1' }, 'WRITER-FOR-CHIEF', { toolCount: 1 })
  await rt.lateRoomReply('gb', { roomId: 'r1', workId: openRev.children[0].work.workId, exchangeId: 'ex-rec-b2' }, 'WRITER-FOR-REV', { toolCount: 1 })
  await rt.reconcileStoppedRoomTask('r1', 'c')
  const stopPosts = host.agentOf('r1').calls.splice(0)
  assert.equal(stopPosts.length, 2, 'reconcileStoppedRoomTask must wake every completed caller')
  assert.deepEqual(stopPosts.map(m => m.source.askedBy).sort(), ['a', 'd'])
  assert.deepEqual(activeRoomWorks('r1'), [])
})

test('missed inactive member exits its batch and removed non-member does not deadlock roomReports', async (t) => {
  const host = await start(t, undefined, undefined, undefined, { d: { name: 'Reviewer', role: 'Lead' } }, undefined, { mainBotIds: ['a', 'd'] })
  await host.tool('post_to_group', { group: 'Ops', message: '@Chief 安排一下', report_back: true }, 'd')
  const post = host.takePost()
  const done = host.round('c-missed-exit', post)

  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: '同时查一下 A' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: '同时查一下 B' }, 'ga')
  host.finish('ga', '[PASS]')

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

  // Chief must wake with Writer's completed result, call works must clear, and Reviewer's report_back must settle!
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer finished the work you asked for/)
  host.begin('ga')
  host.finish('ga', '已收到 Writer 的结果，Tester 超时我先收口。')
  await settle(() => done() !== undefined && host.agentOf('d').calls.length === 1)
  assert.match(text(host.agentOf('d').calls[0]), /WRITER-OK/)
  assert.deepEqual(activeRoomWorks('r1'), [])
  assert.deepEqual(activeRoomReports('r1'), [])

  // Also verify startup reconciliation drops a removed non-member's call work so roomReports never deadlock.
  const room = rt.roomOf('r1')
  rt.openRoomCall(room, 'a', [rt.botOf('b')])
  room.members = room.members.filter(id => id !== 'b')
  rt.openRoomReportCall(room, { id: 'rep-ghost', botId: 'd', name: 'Reviewer', status: 'tracking', fromSeq: 1 })
  await rt.settleRoomBatches()
  await rt.settleRoomReports('r1')
  assert.equal(reportWork('rep-ghost'), undefined, 'removed non-member call must clear so roomReports never deadlock')
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
    await host.tool('delegate_work', { to: 'Writer', goal: 'run writer check' }, 'ga')
    await host.tool('delegate_work', { to: 'Tester', goal: 'run tester check' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'call-w', name: 'pwsh', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'call-w', name: 'pwsh', isError: false, content: [] })
    host.finish('gb', 'Writer finished the build')

    host.begin('gc')
    await settle(() => {
      const calls = activeCallWorks('r1')
      return calls.length === 1 && calls[0].botId === 'c'
    })

    const stopped = await host.call('stop-room-work', { roomId: 'r1' })
    assert.equal(stopped.ok, true)
    host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await settle(() => first() !== undefined)
    await new Promise(resolve => setTimeout(resolve, 40))

    const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.askedBy !== undefined)
    assert.deepEqual(wakePosts, [], 'stopRoomWork mid-batch must never post a wake relay that resurrects stopped group work')
    assert.deepEqual(activeRoomWorks('r1'), [], 'aborted call works must be cleanly closed')
  }

  // 2) direct stopRoomRound mid-batch (without stopMemberWork)
  {
    const host = await start(t)
    const first = host.round('c1', host.say('@Chief dispatch both'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    await host.tool('delegate_work', { to: 'Writer', goal: 'run writer check' }, 'ga')
    await host.tool('delegate_work', { to: 'Tester', goal: 'run tester check' }, 'ga')
    host.finish('ga', '[PASS]')

    await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'tool/call', { callId: 'call-w-direct', name: 'pwsh', arguments: '{}' })
    host.emit('gb', 'tool/result', { callId: 'call-w-direct', name: 'pwsh', isError: false, content: [] })
    host.finish('gb', 'Writer finished the build')

    host.begin('gc')
    await settle(() => {
      const calls = activeCallWorks('r1')
      return calls.length === 1 && calls[0].botId === 'c'
    })

    assert.equal(rt.stopRoomRound('r1'), true)
    host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await settle(() => first() !== undefined)
    await new Promise(resolve => setTimeout(resolve, 40))

    const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.askedBy !== undefined)
    assert.deepEqual(wakePosts, [], 'stopRoomRound mid-batch must never post a wake relay')
    assert.deepEqual(activeRoomWorks('r1'), [], 'aborted call works must be cleanly closed')
  }
})

test('deleting a room mid-round with a partially-completed parallel batch closes cleanly without waking callers', async (t) => {
  const host = await start(t)

  const first = host.round('c1', host.say('@Chief dispatch both'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'run writer check' }, 'ga')
  await host.tool('delegate_work', { to: 'Tester', goal: 'run tester check' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'call-w2', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'call-w2', name: 'pwsh', isError: false, content: [] })
  host.finish('gb', 'Writer finished before deletion')
  host.begin('gc')
  await settle(() => {
    const calls = activeCallWorks('r1')
    return calls.length === 1 && calls[0].botId === 'c'
  })

  await rt.deleteRoom('r1')
  await settle(() => first() !== undefined)
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(rt.roomOf('r1'), undefined)
  assert.deepEqual(activeRoomWorks('r1'), [], 'deleted room must leave zero lingering call works')
  const wakePosts = host.agentOf('r1').calls.filter(msg => msg.source?.askedBy !== undefined)
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

  // Chief MUST receive Writer's completed review as a result wake, not lose it to visible.
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '@Writer 收到，谢谢！')
  await settle(() => first() !== undefined)

  // Chief's closing acknowledgement must be visible and must not wake Writer again.
  assert.equal(host.agentOf('gb').calls.length, 2, 'Chief ack after final result must not re-wake Writer')
  const writerReview = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Full review complete'))
  const chiefAck = rt.roomOf('r1').log.find(line => line.botId === 'a' && line.text.includes('收到'))
  assert.equal(writerReview?.route?.kind, 'result')
  assert.deepEqual(writerReview?.route?.to, ['a'])
  assert.equal(chiefAck?.route?.kind, 'visible')
})

test('repeated zero-change group delegate_work cycles trip hard-signal stagnation pause', async (t) => {
  const host = await start(t)
  const room = rt.roomOf('r1')
  const first = host.round('c1', host.say('@Chief ask Writer a quick check'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const firstReceipt = await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 1 from context' }, 'ga')
  assert.match(firstReceipt, /Called Writer/)
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'Detail 1 looks okay from memory.')

  // Chief wakes on Writer's result with resultRef and runs follow_up_to cycles with identical output & no file changes.
  await settle(() => host.agentOf('ga').calls.length === 2)
  const chiefSecond = host.begin('ga')
  const resultRef = chiefSecond.source.resultRef
  assert.ok(resultRef, 'Chief result wake must include resultRef')
  const secondReceipt = await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 2', follow_up_to: resultRef }, 'ga')
  assert.match(secondReceipt, /Called Writer/)
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 2)
  const childWork = activeCallWorks('r1').find(w => w.botId === 'b')
  assert.ok(childWork !== undefined)
  let check
  for (let i = 0; i < 3 && !check?.paused; i += 1) {
    check = rt.checkRoomProgressStagnation(room, childWork.workId, {
      callerId: 'a',
      calleeId: 'b',
      text: 'Detail 1 looks okay from memory.',
    })
  }
  assert.equal(check?.paused, true)
  assert.equal(rt.coordDb.getWork(childWork.workId)?.status, 'paused')
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => first() !== undefined)

  const pausedNotices = room.log.filter(line => line.kind === 'notice' && line.reason === 'paused')
  assert.equal(pausedNotices.length, 1)
  assert.equal(pausedNotices[0].cause, 'no_progress')
})

test('slow group turn past 15s grace preserves zero-echo so closing @Name in lateRoomReply does not double-wake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer please run build and delegate verification'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k-slow', name: 'pwsh', arguments: '{}' })
  // Outlive the 15s grace timer so roomTurn removes the roomWaiter.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
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
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => round2() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 1)

  // Writer closes its original long turn mentioning @Tester in status text -> must NOT wake Tester again!
  host.emit('gb', 'tool/result', { callId: 'k-slow' })
  host.finish('gb', '@Tester is handling verification; build finished.')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const lateClose = host.takePost()
  assert.equal(lateClose.source.route?.kind, 'visible', 'closing body @Name must route as visible under zero-echo')
  const round3 = host.round('c3', lateClose)
  await settle(() => round3() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester must NOT receive a second wake from lateRoomReply')
})

test('delegated member starting an active group background task downgrades its interim reply to visible without waking caller early', async (t) => {
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
  await settle(() => first() !== undefined)

  // Interim reply while bgRunning must be downgraded to visible, and Chief must not be woken yet.
  const interimLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Started background migration'))
  assert.equal(interimLine?.route?.kind, 'visible', 'interim reply while group background task runs must be visible, not result')
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief must not be woken early while Writer background task runs')
  assert.ok(activeCallWorks('r1').some(work => work.meta?.callerBotId === 'a' && work.botId === 'b'), 'upstream call work must remain open')
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
  await settle(() => first() !== undefined)

  assert.deepEqual(activeRoomWorks('r1'), [], 'upstream call work must unwind instead of lingering when child passes')
})

test('queued new-round delegate_work(follow_up_to) preserves explicitDelegate and follows through turns.js', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  // Round 1: Chief delegates to Writer -> returns result to Chief with resultRef.
  const first = host.round('c1', host.say('@Chief ask Writer to check detail 1'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 1' }, 'ga')
  host.finish('ga', '[PASS]')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'Detail 1 checked from context.')

  // Chief wakes on Writer's result, yields past grace so no round is running when Chief calls follow_up_to.
  await settle(() => host.agentOf('ga').calls.length === 2)
  const chiefSecond = host.begin('ga')
  const resultRef = chiefSecond.source.resultRef
  assert.ok(resultRef)
  rt.roomWaiters.get(chiefSecond.source.exchangeId)?.resolve({ working: true })
  await settle(() => first() !== undefined)
  assert.equal(rt.roomActive('r1'), false, 'no round may be running when Chief calls delegate_work')

  await host.tool('delegate_work', { to: 'Writer', goal: 'Check detail 2 via queued relay', follow_up_to: resultRef }, 'ga')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const queuedPost = host.takePost()
  assert.equal(queuedPost.source.explicitDelegate, true, 'queued relay source must carry explicitDelegate')
  assert.equal(queuedPost.source.callerExchangeId, chiefSecond.source.exchangeId)
  assert.equal(queuedPost.source.route?.follows, resultRef)

  // Replay through turns.js -> group_relay -> runRoundFrom: Writer runs and returns result to Chief.
  host.finish('ga', '[PASS]')
  const round2 = host.round('c2', queuedPost)
  await settle(() => host.agentOf('gb').calls.length === 2)
  assert.equal(activeCallWorks('r1')[0]?.meta?.follows, resultRef)
  host.begin('gb')
  host.finish('gb', 'Detail 2 verified.')
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'Both details confirmed.')
  await settle(() => round2() !== undefined)
  assert.deepEqual(activeRoomWorks('r1'), [])
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
  // to verify settleRoomCallWork still attaches resumedUpstream instead of skipping callIn.
  const activeRound = [...rt.roomProgress.values()].find(r => r.roomId === 'r1')
  activeRound.slots.push({ id: 'b', name: 'Writer', status: 'waiting', note: 'user ping' })

  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 't-fast', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 't-fast' })
  host.finish('gc', 'Fast check passed.')

  // Now Writer closes Turn 1 with [PASS] AFTER Tester already completed and queued Writer's resumed slot.
  await settle(() => activeRound.slots.some(s => s.id === 'b' && s.status === 'waiting' && s.resumedUpstream === true))
  host.finish('gb', '[PASS]')

  // Writer's resumed Turn 2 must still carry Chief's upstream call and return the final summary to Chief!
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'Combined summary after fast Tester check.')

  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'Got it, thanks!')
  await settle(() => first() !== undefined)

  const summaryLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Combined summary'))
  assert.equal(summaryLine?.route?.kind, 'result', 'Writer resumed summary must route to Chief as result')
  assert.deepEqual(summaryLine?.route?.to, ['a'])
  assert.deepEqual(activeRoomWorks('r1'), [])
})

test('slow (>15s grace) nested delegation keeps upstream batch open across queued child relay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
  await settle(() => first() !== undefined)

  // No round is running now: Writer delegates to Tester (queued to group Session) and closes Turn 1 immediately.
  await host.tool('delegate_work', { to: 'Tester', goal: 'Verify slow build' }, 'gb')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const childRelay = host.takePost()
  host.emit('gb', 'tool/result', { callId: 'w-slow' })
  host.finish('gb', '[PASS]')
  await new Promise(resolve => setImmediate(resolve))

  // Upstream Chief -> Writer call work MUST still be open while childRelay awaits its round!
  assert.ok(activeCallWorks('r1').some(work => work.meta?.callerBotId === 'a' && work.botId === 'b'), 'upstream call work must survive queued child relay')

  // Now Tester's round runs and finishes -> wakes Writer with Chief's upstream call intact -> wakes Chief!
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
  await settle(() => round2() !== undefined)

  const reportLine = rt.roomOf('r1').log.find(line => line.botId === 'b' && line.text.includes('Final report for Chief'))
  assert.equal(reportLine?.route?.kind, 'result')
  assert.deepEqual(reportLine?.route?.to, ['a'])
  assert.deepEqual(activeRoomWorks('r1'), [])
})

test('slow (>15s grace) nested delegation unwinds orphaned upstream call on late child [PASS]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
  await settle(() => first() !== undefined)

  // Both Chief->Writer and Writer->Tester call works are open while Tester runs late.
  assert.equal(activeCallWorks('r1').length, 2)

  // Tester finishes late with [PASS] -> both child work AND orphaned parent work must unwind!
  host.emit('gc', 'tool/result', { callId: 't-slow-pass' })
  host.finish('gc', '[PASS]')
  await settle(() => activeRoomWorks('r1').length === 0, 2000, 'late child [PASS] must unwind orphaned parent work')
})

test('nested delegation parentWorkId scopes child holding and wakes so unrelated callers receive immediate results', async (t) => {
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

  // Tester is now actively working on Chief's child work.
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

  // Reviewer MUST get Writer's result wake immediately — NOT blocked or downgraded by Chief's child call!
  await settle(() => host.agentOf('gd').calls.length === 2)
  host.begin('gd')
  host.finish('gd', 'Thanks!')
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief must still be waiting on Tester')
  const relLine = room.log.find(line => line.botId === 'b' && line.text.includes('Release date is Friday'))
  assert.equal(relLine?.route?.kind, 'result')
  assert.deepEqual(relLine?.route?.to, ['d'])

  // Now Tester finishes -> resumes Writer specifically for Chief's work -> Chief gets final result!
  host.emit('gc', 'tool/call', { callId: 't-num', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 't-num' })
  host.finish('gc', 'Numbers verified.')

  await settle(() => host.agentOf('gb').calls.length === 3)
  host.begin('gb')
  host.finish('gb', 'Draft fact-check complete for Chief.')

  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'Approved.')
  await settle(() => first() !== undefined)

  const chiefLine = room.log.find(line => line.botId === 'b' && line.text.includes('Draft fact-check complete for Chief'))
  assert.equal(chiefLine?.route?.kind, 'result')
  assert.deepEqual(chiefLine?.route?.to, ['a'])
  assert.deepEqual(activeRoomWorks('r1'), [])
})

test('paused nested delegation preserves parent across Continue and user message, handles removed member, and clears on stopRoomWork', async (t) => {
  // 1) Paused nested SQLite delegation keeps parent open while parked and resumes parent after Continue.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const pOpen = rt.openRoomCall(room, 'a', [rt.botOf('b')])
    const parentWork = pOpen.children[0].work
    rt.coordDb.parkWaiting(parentWork.workId)
    const cOpen = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: parentWork.workId })
    const childWork = cOpen.children[0].work
    rt.coordDb.pauseWork(childWork.workId, { reason: 'no_progress' })
    assert.equal(rt.coordDb.getWork(childWork.workId)?.status, 'paused')
    assert.equal(rt.coordDb.getWork(parentWork.workId)?.status, 'waiting')

    // User clicks Continue -> resumeRoomPause wakes Tester with parentWork intact -> resumes Writer -> wakes Chief!
    assert.equal(await rt.resumeRoomPause('r1'), true)
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const round3 = host.round('c3', continuePost)
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-cont', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-cont' })
    host.finish('gc', 'Fact verified after Continue.')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Final answer for Chief after Continue.')

    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Great, done!')
    await settle(() => round3() !== undefined)
    const finalLine = room.log.find(line => line.botId === 'b' && line.text.includes('Final answer for Chief after Continue'))
    assert.equal(finalLine?.route?.kind, 'result')
    assert.deepEqual(finalLine?.route?.to, ['a'])
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 2) stopRoomWork clears paused nested call works and releases their waiting parent cleanly.
  {
    await start(t)
    const room = rt.roomOf('r1')
    const pOpen = rt.openRoomCall(room, 'a', [rt.botOf('b')])
    const parentWork = pOpen.children[0].work
    rt.coordDb.parkWaiting(parentWork.workId)
    const cOpen = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: parentWork.workId })
    rt.coordDb.pauseWork(cOpen.children[0].work.workId, { reason: 'no_progress' })

    await rt.stopRoomWork('r1')
    assert.deepEqual(activeRoomWorks('r1'), [], 'stopRoomWork must stop paused nested calls and waiting parent')
  }

  // 3) Lifting a nested pause by user `@Tester` message resumes Tester with parent intact so Writer & Chief resume.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const pOpen = rt.openRoomCall(room, 'a', [rt.botOf('b')])
    const parentWork = pOpen.children[0].work
    rt.coordDb.parkWaiting(parentWork.workId)
    const cOpen = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: parentWork.workId })
    rt.coordDb.pauseWork(cOpen.children[0].work.workId, { reason: 'no_progress' })

    // User lifts pause by directly mentioning `@Tester` -> resumePausedRoomWorks attaches Tester's work!
    const round3 = host.round('c3', host.say('@Tester please go ahead'))
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-mention', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-mention' })
    host.finish('gc', 'Fact verified on user mention.')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief after user mention.')

    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Thanks!')
    await settle(() => round3() !== undefined)
    const finalLine = room.log.find(line => line.botId === 'b' && line.text.includes('Summary for Chief after user mention'))
    assert.equal(finalLine?.route?.kind, 'result')
    assert.deepEqual(finalLine?.route?.to, ['a'])
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 4) Removing one of two paused callees before Continue keeps parent open for the surviving callee.
  {
    const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, {}, { d: {} })
    const room = rt.roomOf('r1')
    const pOpen = rt.openRoomCall(room, 'a', [rt.botOf('b')])
    const parentWork = pOpen.children[0].work
    rt.coordDb.parkWaiting(parentWork.workId)
    const cOpen = rt.openRoomCall(room, 'b', [rt.botOf('c'), rt.botOf('d')], { parentWorkId: parentWork.workId })
    for (const child of cOpen.children) rt.coordDb.pauseWork(child.work.workId, { reason: 'no_progress' })
    // Remove Tester ('c') via leave-room / settle its work while Reviewer ('d') survives.
    const removedChild = cOpen.children.find(child => child.peer.id === 'c')
    room.members = room.members.filter(id => id !== 'c')
    rt.coordDb.settleWork({ workId: removedChild.work.workId, outcome: 'stopped', force: true })

    assert.equal(await rt.resumeRoomPause('r1'), true)
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const round2 = host.round('c2', continuePost)
    await settle(() => host.agentOf('gd').calls.length === 1)
    assert.equal(rt.coordDb.getWork(parentWork.workId)?.status, 'waiting', 'parent work must stay open while surviving Reviewer runs')

    host.begin('gd')
    host.emit('gd', 'tool/call', { callId: 'r-surv', name: 'read', arguments: '{}' })
    host.emit('gd', 'tool/result', { callId: 'r-surv' })
    host.finish('gd', 'Reviewer check done.')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief from surviving Reviewer.')

    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Received.')
    await settle(() => round2() !== undefined)
    const line = room.log.find(entry => entry.botId === 'b' && entry.text.includes('Summary for Chief from surviving Reviewer'))
    assert.equal(line?.route?.kind, 'result')
    assert.deepEqual(line?.route?.to, ['a'])
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 5) Two distinct callers with paused calls to the same target both resume on Continue and wake both callers.
  {
    const host = await start(t)
    const room = rt.roomOf('r1')
    const chiefOpen = rt.openRoomCall(room, 'a', [rt.botOf('c')])
    const writerOpen = rt.openRoomCall(room, 'b', [rt.botOf('c')])
    rt.coordDb.pauseWork(chiefOpen.children[0].work.workId, { reason: 'no_progress' })
    rt.coordDb.pauseWork(writerOpen.children[0].work.workId, { reason: 'no_progress' })

    assert.equal(await rt.resumeRoomPause('r1'), true)
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
    await settle(() => r3() !== undefined)
    assert.deepEqual(activeRoomWorks('r1'), [])
  }
})

test('dual-parent direct requests from the same caller to the same worker survive Continue and folded runRoundFrom', async (t) => {
  // 1) Clicking Continue with two paused nested child calls from Writer to Tester serving
  // two different upstream parents (Chief P1 and Reviewer P2) keeps both and resumes both parents.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    rt.coordDb.parkWaiting(p2.workId)
    const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work
    const c2 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p2.workId }).children[0].work
    rt.coordDb.pauseWork(c1.workId, { reason: 'no_progress' })
    rt.coordDb.pauseWork(c2.workId, { reason: 'no_progress' })

    assert.equal(await rt.resumeRoomPause('r1'), true)
    await settle(() => host.agentOf('r1').calls.length === 1)
    const continuePost = host.takePost()
    const r = host.round('c-dual', continuePost)

    // Tester runs slot 1 (Chief's parent) -> wakes Writer for Chief's parent.
    await settle(() => host.agentOf('gc').calls.length === 1)
    assert.equal(activeCallWorks('r1').filter(w => w.botId === 'c').length, 2, 'both parent-scoped child works must coexist on resume')
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
    await settle(() => r() !== undefined)
    assert.deepEqual(activeRoomWorks('r1'), [])
  }

  // 2) Two queued direct posts from Writer to Tester for distinct parents folded into one
  // runRoundFrom keep separate waiting slots and resume both parents.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    rt.coordDb.parkWaiting(p2.workId)

    // Two queued delegate_work posts from Writer for P1 and P2 folded into one round.
    await rt.postToRoom(room, rt.botOf('b'), '@Tester check release notes', {
      mentions: true,
      explicitDelegate: true,
      parentWorkId: p1.workId,
      route: { kind: 'call', to: ['c'] },
    })
    await rt.postToRoom(room, rt.botOf('b'), '@Tester check migration guide', {
      mentions: true,
      explicitDelegate: true,
      parentWorkId: p2.workId,
      route: { kind: 'call', to: ['c'] },
    })
    await settle(() => host.agentOf('r1').calls.length === 2)
    const post1 = host.takePost()
    const post2 = host.takePost()
    host.emit('r1', 'user/message', post1)
    const r = host.round('c-fold', post2)

    await settle(() => host.agentOf('gc').calls.length === 1)
    assert.equal(activeCallWorks('r1').filter(w => w.botId === 'c').length, 2, 'folded direct posts with distinct parentWorkId must keep both child works')
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-fold-1', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-fold-1' })
    host.finish('gc', 'Release notes verified.')

    await settle(() => host.agentOf('gc').calls.length === 2)
    host.begin('gc')
    host.emit('gc', 'tool/call', { callId: 't-fold-2', name: 'read', arguments: '{}' })
    host.emit('gc', 'tool/result', { callId: 't-fold-2' })
    host.finish('gc', 'Migration guide verified.')

    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.finish('gb', 'Summary for Chief.')
    await settle(() => host.agentOf('gb').calls.length === 2)
    host.begin('gb')
    host.finish('gb', 'Summary for Reviewer.')

    await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gd').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief got summary.')
    host.begin('gd')
    host.finish('gd', 'Reviewer got summary.')
    await settle(() => r() !== undefined)
    assert.deepEqual(activeRoomWorks('r1'), [])
  }
})

test('busy worker receiving two waiterless room deliveries from the same caller for distinct live child works re-delivers both', async (t) => {
  const host = await start(
    t,
    { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
    undefined,
    undefined,
    { d: {} },
  )
  const room = rt.roomOf('r1')
  const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
  const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
  const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work
  const c2 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p2.workId }).children[0].work

  // Tester is busy on an earlier room turn while both waiterless calls from Writer join it.
  host.agentOf('gc').followup({
    id: 'u-busy',
    content: [{ type: 'text', text: 'Busy room turn' }],
    source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'ex-busy-other', senderSessionId: 'r1' },
  })
  host.begin('gc')
  host.emit('gc', 'user/message', {
    content: [{ type: 'text', text: 'Check release notes' }],
    source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', workId: c1.workId, batchKey: c1.workId, exchangeId: 'ex-join-c1', senderSessionId: 'r1' },
  })
  host.emit('gc', 'user/message', {
    content: [{ type: 'text', text: 'Check migration guide' }],
    source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', workId: c2.workId, batchKey: c2.workId, exchangeId: 'ex-join-c2', senderSessionId: 'r1' },
  })

  const before = host.agentOf('gc').calls.length
  host.finish('gc', 'Finished unrelated busy turn.')
  await settle(() => host.agentOf('gc').calls.length >= before + 2)
  const redelivered = host.agentOf('gc').calls.slice(before).map(msg => msg.source?.workId ?? msg.source?.batchKey)
  assert.deepEqual(redelivered, [c1.workId, c2.workId], 'both live pending child works must be re-delivered when busy turn finishes')
})

test('concurrent nested calls settle strictly by workId and unwind orphaned parent while caller runs another parent', async (t) => {
  // 1) Writer holds P1 (Chief) and P2 (Reviewer) and has child calls C1 (for P1) and C2 (for P2) on Tester.
  // When Tester finishes C1 late, only P1 wakes; C2 (Reviewer P2) stays pending untouched.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    rt.coordDb.parkWaiting(p2.workId)
    const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work
    const c2 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p2.workId }).children[0].work

    await rt.lateRoomReply('gc', { roomId: 'r1', workId: c1.workId, exchangeId: 'ex-c1-late' }, 'Release notes check complete.', { toolCount: 1 })
    await settle(() => host.agentOf('r1').calls.length === 1)
    const wake = host.takePost()
    assert.equal(wake.source.parentWorkId, p1.workId)
    assert.equal(rt.coordDb.getWork(c2.workId)?.status, 'running', 'C2 (Reviewer parent) must remain untouched when C1 settles P1')
    assert.equal(rt.coordDb.getWork(p2.workId)?.status, 'waiting', 'P2 (Reviewer parent) must remain waiting')
  }

  // 2) Writer holds P1 (Chief) and P2 (Reviewer) and is actively running P2's turn when P1's only
  // child (Tester) exits with [PASS] -> P1 unwinds cleanly without touching P2.
  {
    const host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      undefined,
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work

    // Writer is actively running P2's turn (unrelated to P1).
    host.agentOf('gb').followup({
      id: 'w-running-p2',
      content: [{ type: 'text', text: 'Work on Reviewer task' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'd', workId: p2.workId, exchangeId: 'ex-w-run-p2', senderSessionId: 'r1' },
    })
    host.begin('gb')

    // Tester finishes C1 (P1's only child) late with [PASS] -> C1 closes and unwinds P1 while P2 stays running.
    host.agentOf('gc').followup({
      id: 't-running-c1',
      content: [{ type: 'text', text: 'Check for P1' }],
      source: { kind: 'bot', role: 'room', roomId: 'r1', askedBy: 'b', workId: c1.workId, exchangeId: 'ex-t-c1', senderSessionId: 'r1' },
    })
    host.begin('gc')
    host.finish('gc', '[PASS]')

    await settle(() => rt.coordDb.getWork(p1.workId)?.status === 'stopped')
    assert.equal(rt.coordDb.getWork(p2.workId)?.status, 'running', 'active P2 parent work must remain untouched')
    host.finish('gb', 'Reviewer task finished.')
  }
})

test('startup settleRoomBatches recovers completed cold delivery and keeps parents with unread child results', async (t) => {
  // 1) Startup settleRoomBatches queries cold DSH delivery status for a persisted child call work
  // that already completed before restart, settles it, and wakes its waiting parent cleanly.
  {
    let host
    host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } },
      { agents: { get: id => host?.agentOf(id) } },
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    rt.coordDb.parkWaiting(p2.workId)
    const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work
    const c2 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p2.workId }).children[0].work
    rt.coordDb.recordDirectDeliveryAttempt({ workId: c1.workId, idempotencyKey: 'dk-c1-done', sessionId: 'gc' })
    rt.coordDb.recordDirectDeliveryAttempt({ workId: c2.workId, idempotencyKey: 'dk-c2-queued', sessionId: 'gc' })
    host.agentOf('gc').session.snapshotEvents = () => []
    host.agentOf('gc').inbox.nextTurn.push({
      id: 'parked-c2',
      content: [{ type: 'text', text: 'Migration check' }],
      source: { kind: 'ds-bot', role: 'room', roomId: 'r1', askedBy: 'b', workId: c2.workId, idempotencyKey: 'dk-c2-queued' },
    })
    const origQuery = rt.queryDeliveryStatus
    rt.queryDeliveryStatus = async (sid, query, opts) => {
      if (sid === 'gc' && query?.idempotencyKey === 'dk-c1-done') {
        return { status: 'completed', turn: 1, assistantText: 'Release notes verified before restart.', toolCalls: 1 }
      }
      return origQuery(sid, query, opts)
    }
    t.after(() => { rt.queryDeliveryStatus = origQuery })

    await rt.settleRoomBatches()
    await settle(() => host.agentOf('r1').calls.length === 1)
    const wakePost = host.takePost()
    assert.equal(wakePost.source.parentWorkId, p1.workId, 'recovered completed C1 must wake P1')
    assert.equal(rt.coordDb.getWork(c2.workId)?.status, 'running', 'queued C2 (P2) must stay active')
  }

  // 2) Startup settleRoomBatches visits parent P1 with an unread completed child result while Writer
  // has P2 queued: P1 is resumed (not dropped) and delivers the final summary to Chief.
  {
    let host
    host = await start(
      t,
      { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' }, log: [{ seq: 1, who: 'Tester', botId: 'c', text: 'Fact-check done.' }], seq: 1 },
      { agents: { get: id => host?.agentOf(id) } },
      undefined,
      { d: {} },
    )
    const room = rt.roomOf('r1')
    const p1 = rt.openRoomCall(room, 'a', [rt.botOf('b')]).children[0].work
    const p2 = rt.openRoomCall(room, 'd', [rt.botOf('b')]).children[0].work
    rt.coordDb.parkWaiting(p1.workId)
    const c1 = rt.openRoomCall(room, 'b', [rt.botOf('c')], { parentWorkId: p1.workId }).children[0].work
    rt.coordDb.updateApiMeta(p1.workId, () => ({
      done: ['Tester'],
      doneIds: ['c'],
      results: [{ name: 'Tester', botId: 'c', seq: 1 }],
      worked: true,
    }))
    rt.coordDb.settleWork({ workId: c1.workId, outcome: 'done', force: true, summary: 'Fact-check done.', resultRef: 'G1' })
    rt.coordDb.recordDirectDeliveryAttempt({ workId: p2.workId, idempotencyKey: 'dk-p2-gb', sessionId: 'gb' })
    host.agentOf('gb').session.snapshotEvents = () => []
    host.agentOf('gb').inbox.nextTurn.push({
      id: 'parked-p2',
      content: [{ type: 'text', text: 'Resume Reviewer task' }],
      source: { kind: 'ds-bot', role: 'room', roomId: 'r1', askedBy: 'd', workId: p2.workId, exchangeId: 'ex-w-res-p2', idempotencyKey: 'dk-p2-gb' },
    })

    await rt.settleRoomBatches()
    await settle(() => host.agentOf('r1').calls.length === 1)
    assert.ok(rt.coordDb.getWork(p1.workId)?.status !== 'stopped', 'parent P1 with unread finished child result must not be pruned')
    const wakePost = host.takePost()
    assert.equal(wakePost.source.parentWorkId, p1.workId)

    // Replay C1's wake into a round -> Writer resumes P1 and delivers summary to Chief!
    const gbBefore = host.agentOf('gb').calls.length
    const r = host.round('c-wake-p1', wakePost)
    await settle(() => host.agentOf('gb').calls.length === gbBefore + 1)
    const resumedWriterCall = host.begin('gb')
    assert.equal(resumedWriterCall.source.resumedUpstream, true)
    host.finish('gb', 'Chief summary ready.')
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', 'Chief got recovered summary.')
    await settle(() => r() !== undefined)
  }
})
