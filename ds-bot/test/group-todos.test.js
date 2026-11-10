import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The team of test/sections.test.js: three Bots and one existing group, so the to-do
// list has to work on a room that was saved before it existed.
const baseTeam = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Copy', instructions: '', createdAt: 2 },
    editor: { id: 'editor', sessionId: 'editor', name: 'Editor', role: 'Video', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', sessionId: 'r1', name: 'Video Room', named: true, members: ['chief', 'writer', 'editor'], admin: 'chief', mode: 'admin', notice: '', createdAt: 4 },
    r2: { id: 'r2', sessionId: 'r2', name: 'Other Room', named: true, members: ['chief', 'writer'], admin: 'chief', mode: 'admin', notice: '', createdAt: 5 },
  },
})

function start(saved, existingHome) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-todos-'))
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
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
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = name => rt.teamTools.find(entry => entry.name === name)
  const exec = id => ({ agent: { id, session: { id } } })
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, exec, stop, home, rt }
}

const todosOf = async (call, id = 'r1') => (await call('state', {})).value.rooms.find(room => room.id === id)?.todos

test('add, list and check share one list between the members', async (t) => {
  const { call, tool, exec, stop } = start(baseTeam())
  t.after(stop)
  // The room comes from a state.json written before to-do lists existed.
  assert.equal(await todosOf(call), undefined)

  const added = await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: '  Buy   props ' }, exec('chief'))
  assert.match(added, /^Added "Buy props" to the shared to-do list of "Video Room" \(1 open, todo [0-9a-f]{8}\)\.$/)
  let todos = await todosOf(call)
  assert.equal(todos.length, 1)
  assert.equal(todos[0].text, 'Buy props')
  assert.equal(todos[0].done, false)
  assert.equal(todos[0].createdBy, 'chief')
  const id = todos[0].id

  // Another member reads the same list, and a member ticks it by the short id.
  const listed = await tool('group_todo').execute({ group: 'Video Room', action: 'list' }, exec('writer'))
  assert.match(listed, /^Shared to-do list of "Video Room" \(1 open, 0 done\):$/m)
  assert.match(listed, new RegExp(`^- \\[ \\] Buy props \\(todo ${id.slice(0, 8)}\\)$`, 'm'))
  const ticked = await tool('group_todo').execute({ group: 'Video Room', action: 'check', id: id.slice(0, 8) }, exec('writer'))
  assert.match(ticked, /^Ticked "Buy props" \(0 open\)\.$/)
  todos = await todosOf(call)
  assert.equal(todos[0].done, true)
  assert.equal(todos[0].doneBy, 'writer')
  assert.equal(typeof todos[0].doneAt, 'number')

  // Ticking twice is not an error, so two members can act on the same row.
  assert.match(await tool('group_todo').execute({ group: 'Video Room', action: 'check', id }, exec('editor')), /^Ticked /)
  const unticked = await tool('group_todo').execute({ group: 'Video Room', action: 'check', id, done: false }, exec('editor'))
  assert.match(unticked, /^Unticked "Buy props" \(1 open\)\.$/)
  todos = await todosOf(call)
  assert.equal(todos[0].done, false)
  assert.equal(todos[0].doneAt, undefined)
  assert.equal(todos[0].doneBy, undefined)
})

test('a member of another group cannot read or change this list, but a Main Bot can', async (t) => {
  const { call, tool, exec, stop } = start(baseTeam())
  t.after(stop)
  // Editor is in Video Room but not in Other Room, and is not a Main Bot.
  const refused = await tool('group_todo').execute({ group: 'Other Room', action: 'add', text: 'Nope' }, exec('editor'))
  assert.match(refused, /^No group chat called "Other Room" that you can see\. Groups: "Video Room"\.$/)

  assert.equal((await call('set-main', { id: 'editor', main: true })).ok, true)
  const added = await tool('group_todo').execute({ group: 'Other Room', action: 'add', text: 'Main Bot item' }, exec('editor'))
  assert.match(added, /^Added "Main Bot item"/)
  assert.equal((await todosOf(call, 'r2')).length, 1)
  assert.equal((await todosOf(call, 'r1')), undefined)
})

test('the details endpoint ticks one item and refuses unknown rooms and ids', async (t) => {
  const { call, tool, exec, stop } = start(baseTeam())
  t.after(stop)
  await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'Ship the cut' }, exec('chief'))
  const id = (await todosOf(call))[0].id

  const ticked = await call('room-todo', { roomId: 'r1', id, done: true })
  assert.equal(ticked.ok, true)
  assert.equal(ticked.value.item.done, true)
  assert.equal(ticked.value.todos[0].done, true)

  const unknownRoom = await call('room-todo', { roomId: 'nope', id, done: true })
  assert.equal(unknownRoom.ok, false)
  assert.equal(unknownRoom.error.message, 'Unknown group chat')

  const unknownItem = await call('room-todo', { roomId: 'r1', id: 'deadbeef', done: true })
  assert.equal(unknownItem.ok, false)
  assert.equal(unknownItem.error.message, 'That to-do is no longer on the list.')

  const unticked = await call('room-todo', { roomId: 'r1', id, done: false })
  assert.equal(unticked.ok, true)
  assert.equal(unticked.value.item.done, false)
})

test('concurrent adds keep every item', async (t) => {
  const { call, tool, exec, stop } = start(baseTeam())
  t.after(stop)
  const texts = Array.from({ length: 8 }, (_, index) => `Item ${index}`)
  const outputs = await Promise.all(texts.map((text, index) => tool('group_todo').execute({ group: 'Video Room', action: 'add', text }, exec(index % 2 === 0 ? 'chief' : 'writer'))))
  for (const output of outputs) assert.match(output, /^Added /)
  const todos = await todosOf(call)
  assert.equal(todos.length, texts.length)
  assert.deepEqual(todos.map(item => item.text).sort(), texts.sort())
})

test('the list shows open items first and done ones last', async (t) => {
  const { tool, exec, stop } = start({
    ...baseTeam(),
    rooms: {
      r1: {
        ...baseTeam().rooms.r1,
        todos: [
          { id: 'aaaaaaaa-1', text: 'Done first', done: true, createdAt: 1 },
          { id: 'bbbbbbbb-2', text: 'Open second', done: false, createdAt: 2 },
          { id: 'cccccccc-3', text: 'Open third', done: false, createdAt: 3 },
        ],
      },
    },
  })
  t.after(stop)
  const listed = await tool('group_todo').execute({ group: 'Video Room', action: 'list' }, exec('chief'))
  assert.equal(listed, [
    'Shared to-do list of "Video Room" (2 open, 1 done):',
    '- [ ] Open second (todo bbbbbbbb)',
    '- [ ] Open third (todo cccccccc)',
    '- [x] Done first (todo aaaaaaaa)',
  ].join('\n'))
})

test('the list stops at 100 items, and each item stays one short line', async (t) => {
  const seeded = baseTeam()
  seeded.rooms.r1.todos = Array.from({ length: 99 }, (_, index) => ({ id: `t${index}`, text: `Item ${index}`, done: false, createdAt: index }))
  const { call, tool, exec, stop } = start(seeded)
  t.after(stop)

  assert.match(await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'Last one' }, exec('chief')), /^Added "Last one"/)
  const full = await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'One too many' }, exec('chief'))
  assert.equal(full, 'Could not change the to-do list of "Video Room": The shared to-do list is full (100).')
  assert.equal((await todosOf(call)).length, 100)

  const long = await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'x'.repeat(201) }, exec('chief'))
  assert.equal(long, 'Could not change the to-do list of "Video Room": Keep a to-do under 200 characters.')
  const empty = await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: '   ' }, exec('chief'))
  assert.equal(empty, 'Could not change the to-do list of "Video Room": Write the to-do first.')
})

test('deleting the group deletes its list with the rest of the room', async (t) => {
  const { call, tool, exec, stop, home } = start(baseTeam())
  t.after(stop)
  await tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'Only in this room' }, exec('chief'))
  const deleted = await tool('delete_group').execute({ group: 'Video Room' }, exec('chief'))
  assert.match(deleted, /^Deleted "Video Room"\./)

  const state = (await call('state', {})).value
  assert.equal(state.rooms.some(room => room.id === 'r1'), false)
  assert.equal(JSON.stringify(state).includes('Only in this room'), false)
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  assert.equal(saved.includes('Only in this room'), false)
})

test('the list survives a reload of the same state.json', async (t) => {
  const first = start(baseTeam())
  await first.tool('group_todo').execute({ group: 'Video Room', action: 'add', text: 'Keep me' }, first.exec('chief'))
  await first.stop({ keep: true })
  const second = start(undefined, first.home)
  t.after(() => second.stop())
  const todos = await todosOf(second.call)
  assert.equal(todos.length, 1)
  assert.equal(todos[0].text, 'Keep me')
})
