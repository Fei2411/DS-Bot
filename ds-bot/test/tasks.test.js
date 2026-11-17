import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install } from '../src/host/tasks.js'
import { fakeContext } from './fake-ctx.js'

// The task board is room data: these tests start with the queue every new room has,
// and the last one drives the panel's two endpoints through a whole runtime.

function fakeHost(given) {
  const state = given ?? {
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', sessions: { a: 'ga', b: 'gb' }, tasks: {} } },
    prefs: {},
  }
  const members = { a: 'a', b: 'b', ga: 'a', gb: 'b' }
  const calls = { save: 0 }
  const rt = {
    state,
    teamTools: [],
    async load() {},
    async save() { calls.save += 1 },
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => members[id],
    isMain: id => id === 'a',
    isAdminOf: (room, id) => room.admin === id,
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
  }
  install(rt)
  const tool = (args, sessionId = 'gb') => rt.teamTools.find(entry => entry.name === 'group_task').execute(args, { agent: { id: sessionId } })
  const tasks = () => Object.values(state.rooms.r1.tasks ?? {})
  return { state, rt, tool, calls, tasks }
}

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const prompts = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, cancel() {}, followup() {}, steer() {} } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const tool = (args, sessionId) => rt.teamTools.find(entry => entry.name === 'group_task').execute(args, { agent: { id: sessionId } })
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  return { home, ctx, rt, call, tool, prompts, saved, emit }
}

test('group_task opens a task and moves it through active, review, blocked and done', async () => {
  const host = fakeHost()
  assert.match(await host.tool({ action: 'open', goal: '  Write   the draft ' }), /^Opened t_[0-9a-f]{8}: Write the draft\n\nTasks in "Ops":/)
  const [task] = host.tasks()
  assert.deepEqual([task.botId, task.status, task.goal, task.progress], ['b', 'active', 'Write the draft', ''])
  assert.equal(host.calls.save, 1)

  assert.match(await host.tool({ action: 'update', status: 'review', progress: 'Draft is ready  for review' }), /^Updated t_/)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].progress], ['review', 'Draft is ready for review'])
  assert.match(await host.tool({ action: 'update', status: 'blocked', progress: 'Waiting for the outline' }), /\(blocked\)/)
  assert.match(await host.tool({ action: 'update', status: 'active' }), /\(active\)/)

  assert.equal(await host.tool({ action: 'complete' }), 'A finished task needs a result summary.')
  assert.match(await host.tool({ action: 'complete', result: 'Draft delivered' }), /Finished: "Draft delivered"/)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].result], ['done', 'Draft delivered'])
  assert.match(await host.tool({ action: 'show' }), /1 finished or cancelled in the history/)
})

test('a task belongs to the Bot that opened it; only the admin or a Main Bot may cancel another one', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const [task] = host.tasks()
  // The admin may not move another member's task through update; it may cancel it.
  assert.equal(await host.tool({ action: 'update', status: 'review', id: task.id }, 'ga'), `Task ${task.id} belongs to another member.`)
  assert.equal(await host.tool({ action: 'complete', id: task.id, result: 'x' }, 'ga'), `Task ${task.id} belongs to another member.`)
  assert.match(await host.tool({ action: 'cancel', id: task.id, reason: 'scope cut' }, 'ga'), /^Updated t_.* Cancelled\./)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].reason], ['cancelled', 'scope cut'])

  // A member who is neither the owner nor the admin is refused.
  await host.tool({ action: 'open', goal: 'Check the draft' }, 'ga')
  const second = host.tasks().find(entry => entry.status === 'active')
  assert.equal(await host.tool({ action: 'cancel', id: second.id }, 'gb'), `Task ${second.id} belongs to another member; only its owner, the admin or a Main Bot cancels it.`)
  assert.equal(host.tasks().find(entry => entry.id === second.id).status, 'active')
})

test('update and complete pick the caller\'s own newest open task when no id is given', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'First' }, 'gb')
  await host.tool({ action: 'open', goal: 'Second' }, 'gb')
  await host.tool({ action: 'open', goal: 'Other' }, 'ga')
  await host.tool({ action: 'update', progress: 'on Second' }, 'gb')
  const mine = host.tasks().filter(task => task.botId === 'b')
  assert.deepEqual(mine.map(task => [task.goal, task.progress]), [['First', ''], ['Second', 'on Second']])
  await host.tool({ action: 'complete', result: 'done' }, 'gb')
  assert.deepEqual(host.tasks().filter(task => task.botId === 'b').map(task => task.status), ['active', 'done'])
})

test('group_task refuses a chat that is not a group chat and a session that is not a Bot', async () => {
  const host = fakeHost()
  assert.equal(await host.tool({ action: 'open', goal: 'x' }, 'a'), 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.')
  assert.equal(await host.tool({ action: 'open', goal: 'x' }, 'nobody'), 'Only Bots on the team can use group_task.')
  assert.equal(await host.tool({ action: 'open', goal: ' ' }), 'A task needs a one-line goal.')
})

test('the panel adds a note and cancels through the same task, refusing a finished one', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const [task] = host.tasks()
  const noted = host.rt.taskNote('r1', task.id, '  also add   tests ')
  assert.deepEqual(noted.task.notes.map(note => [note.by, note.text]), [['user', 'also add tests']])
  assert.equal(host.rt.taskNote('r1', task.id, '  ').error, 'Write a note first.')
  assert.equal(host.rt.taskNote('r1', 'nope', 'x').error, 'No such task.')

  assert.equal(host.rt.taskCancel('r1', task.id).task.status, 'cancelled')
  assert.equal(host.rt.taskNote('r1', task.id, 'late').error, 'That task is already finished.')
  assert.equal(host.rt.taskCancel('r1', task.id).error, 'That task is already finished.')
})

test('tasks live on the room: a reload keeps them, and deleting the group drops them', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const id = host.tasks()[0].id
  // What a restart reads back is the room itself, tasks included.
  const reloaded = fakeHost(JSON.parse(JSON.stringify(host.state)))
  assert.match(await reloaded.tool({ action: 'show' }, 'gb'), new RegExp(`- ${id} · Writer · active · Write the draft`))
  assert.equal(reloaded.rt.taskNote('r1', id, 'note').task.notes.length, 1)

  delete reloaded.state.rooms.r1
  assert.equal(await reloaded.tool({ action: 'show' }, 'gb'), 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.')
})

test('a panel note reaches the task owner as a user message, and both panel actions save the board', async (t) => {
  const host = await start(t)
  assert.match(await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb'), /^Opened t_/)
  const id = Object.keys(host.saved().rooms.r1.tasks)[0]

  const noted = await host.call('task-note', { roomId: 'r1', id, text: 'Also add tests' })
  assert.equal(noted.ok, true)
  assert.equal(host.prompts.length, 1)
  assert.equal(host.prompts[0].sessionId, 'r1')
  assert.equal(host.prompts[0].mode, 'queue')
  assert.equal(host.prompts[0].content[0].text, '@Writer Also add tests')
  const after = id => host.saved().rooms.r1.tasks[id]
  assert.equal(after(id).notes.at(-1).text, 'Also add tests')
  assert.ok(noted.value.rooms.find(room => room.id === 'r1').tasks[id].notes.length === 1)

  // A finished task takes no new note and the message is not posted.
  await host.tool({ action: 'complete', id, result: 'Draft delivered' }, 'gb')
  const refused = await host.call('task-note', { roomId: 'r1', id, text: 'Too late' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.message, 'That task is already finished.')
  assert.equal(host.prompts.length, 1)

  const cancelled = await host.call('task-cancel', { roomId: 'r1', id })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.message, 'That task is already finished.')

  // A second open task cancels from the panel without the group.
  await host.tool({ action: 'open', goal: 'Check the draft' }, 'ga')
  const second = Object.values(host.saved().rooms.r1.tasks).find(task => task.status === 'active')
  const done = await host.call('task-cancel', { roomId: 'r1', id: second.id })
  assert.equal(done.ok, true)
  assert.equal(after(second.id).status, 'cancelled')
  assert.equal(host.prompts.length, 1)
})


test('a finished task is immutable through every Bot action', async () => {
  for (const terminal of ['complete', 'cancel']) {
    const host = fakeHost()
    await host.tool({ action: 'open', goal: 'Deliver' }, 'gb')
    const id = host.tasks()[0].id
    await host.tool({ action: terminal, id, result: 'delivered', reason: 'stopped' }, 'gb')
    const saved = JSON.stringify(host.tasks())
    for (const action of ['update', 'complete', 'cancel']) {
      assert.equal(await host.tool({ action, id, status: 'active', progress: 'late', result: 'changed' }, 'gb'), 'That task is already finished.')
      assert.equal(JSON.stringify(host.tasks()), saved)
    }
  }
})

test('finished tasks stay in the board history beyond two hundred deliveries', async () => {
  const host = fakeHost()
  for (let i = 0; i < 205; i++) {
    await host.tool({ action: 'open', goal: `Deliver ${i}` }, 'gb')
    await host.tool({ action: 'complete', result: `Result ${i}` }, 'gb')
  }
  assert.equal(host.tasks().length, 205)
  assert.ok(host.tasks().some(task => task.goal === 'Deliver 0'))
})

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

test('a member\'s failed turn blocks its open tasks in the group with the reason; a completed turn lifts it', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Review the plan' }, 'ga')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)

  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', status: 402, message: 'Insufficient balance' } } })
  await settle(() => task('Write the draft').status === 'blocked')
  const { at, ...blocked } = task('Write the draft').blocked
  assert.ok(at > 0)
  assert.deepEqual(blocked, { by: 'system', cause: 'failed', code: 'QUOTA', status: 402, from: 'active' })
  assert.equal(task('Review the plan').status, 'active')

  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'socket hang up' } } })
  await settle(() => task('Write the draft').blocked.code === 'TRANSPORT')
  assert.equal(task('Write the draft').blocked.status, undefined)
  assert.equal(task('Write the draft').blocked.from, 'active')
  host.emit('gb', 'turn/start', { turn: 3 })
  host.emit('gb', 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'QUOTA', status: 402, message: 'Insufficient balance' } } })
  await settle(() => task('Write the draft').blocked.code === 'QUOTA')
  assert.match(await host.tool({ action: 'show' }, 'ga'), /· Writer · blocked · Write the draft\n {2}blocked by DS Bot: its model call failed \(QUOTA 402\)/)

  host.emit('gb', 'turn/start', { turn: 4 })
  host.emit('gb', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  await settle(() => task('Write the draft').status === 'active')
  assert.equal(task('Write the draft').blocked, undefined)
})

test('the user stopping a member blocks its open tasks; a block the Bot set itself stays', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Wait for the data' }, 'gb')
  await host.tool({ action: 'update', status: 'blocked', progress: 'No data yet' }, 'gb')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)

  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  await settle(() => task('Write the draft').status === 'blocked')
  assert.equal(task('Write the draft').blocked.cause, 'stopped')
  assert.equal(task('Wait for the data').blocked, undefined)

  // The Bot picks the work up again itself.
  await host.tool({ action: 'update', id: task('Write the draft').id, status: 'active' }, 'gb')
  assert.equal(task('Write the draft').status, 'active')
  assert.equal(task('Write the draft').blocked, undefined)

  // A completed turn lifts only what DS Bot blocked.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(task('Wait for the data').status, 'blocked')
})

test('a turn picked up after a restart that leaves a task untouched blocks it; one that updates it keeps it running', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Check the facts' }, 'gb')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)
  await new Promise(resolve => setTimeout(resolve, 5))

  host.emit('gb', 'user/message', { source: { kind: 'bot', role: 'resume', resumed: true }, content: [{ type: 'text', text: '[DeepSeek Harness restarted while you were working]\nGo on.' }] })
  host.emit('gb', 'turn/start', { turn: 1 })
  await host.tool({ action: 'update', id: task('Check the facts').id, progress: 'Two sources left' }, 'gb')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task('Write the draft').status === 'blocked')
  const { at, ...blocked } = task('Write the draft').blocked
  assert.deepEqual(blocked, { by: 'system', cause: 'restarted', from: 'active' })
  assert.equal(task('Check the facts').status, 'active')
  assert.match(await host.tool({ action: 'show' }, 'ga'), /blocked by DS Bot: not updated after DeepSeek Harness restarted/)

  // Finishing a task DS Bot blocked leaves no block behind.
  await host.tool({ action: 'complete', id: task('Write the draft').id, result: 'Draft delivered' }, 'gb')
  assert.equal(task('Write the draft').status, 'done')
  assert.equal(task('Write the draft').blocked, undefined)
})
