import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { reminderText } from '../src/host/schedules.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// An in-memory stand-in for DSH's schedule service.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    tasks,
    async create(sessionId, request) {
      const id = `schedule-${next++}`
      const kind = { every_seconds: 'every' }[Object.keys(request).find(key => !['title', 'prompt'].includes(key))]
        ?? Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = {
        id, kind, title: request.title, prompt: request.prompt,
        timing: request[Object.keys(request).find(key => !['title', 'prompt'].includes(key))],
        scheduledAt: request.at ?? '2030-01-01T01:00:00.000Z',
        everySeconds: request.every_seconds,
        time: request.daily?.time ?? request.weekly?.time,
        timeZone: request.daily?.time_zone ?? request.weekly?.time_zone ?? request.cron?.time_zone,
        weekdays: request.weekly?.weekdays,
        expression: request.cron?.expression,
      }
      tasks.set(id, { sessionId, record })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId).map(task => task.record) },
    async catalog() {
      return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status ?? 'active' }))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
    },
    async delete({ sessionId, id }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
  }
}

// The Host-wide service of DSH 0.2.2: each task has a delivery target and changes through edit().
function hostSchedule() {
  const tasks = new Map()
  let next = 1
  const edits = []
  return {
    tasks,
    edits,
    async create({ title, prompt, timing, target }) {
      const id = `schedule-${next++}`
      const [selector] = Object.keys(timing).filter(key => key !== 'kind')
      tasks.set(id, { record: { id, kind: timing.kind, title, prompt, scheduledAt: timing.at ?? '2030-01-01T01:00:00.000Z' }, timing: timing[selector], target, status: 'active' })
      return { id }
    },
    async catalog() {
      return [...tasks.values()].map(task => ({ ...task.record, target: task.target, status: task.status }))
    },
    async edit(request) {
      edits.push(request)
      if (request.action === 'delete') tasks.delete(request.id)
      else Object.assign(tasks.get(request.id), request.patch)
      return { id: request.id }
    },
  }
}

function setup(services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call, rt }
}

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [] })
  const refused = await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Automation tasks are off/)
})

test('a time with seconds, as a browser\'s time picker can report it, is accepted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  for (const [when, timing] of [
    [{ kind: 'weekly', time: '18:25:00', timeZone: 'UTC', weekdays: [1] }, { time: '18:25:00', time_zone: 'UTC', weekdays: [1] }],
    [{ kind: 'daily', time: '07:05:30', timeZone: 'UTC' }, { time: '07:05:30', time_zone: 'UTC' }],
  ]) {
    const created = await call('schedule-create', { target: 'm1', title: 'Seconds', prompt: 'Plan', when })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.deepEqual([...schedule.tasks.values()].at(-1).record.timing, timing)
  }
})

test('tasks are created on the Bot’s current part, listed by Bot, and deleted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const daily = await call('schedule-create', { target: 'w1', title: ' Briefing ', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(daily.ok, true, JSON.stringify(daily))
  const [created] = [...schedule.tasks.values()]
  assert.equal(created.sessionId, 'w2')
  assert.deepEqual(created.record.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  assert.equal(created.record.title, 'Briefing')

  await schedule.create('w1', { title: 'Old part', prompt: 'x', every_seconds: 3600 })
  await schedule.create('outside', { title: 'Not ours', prompt: 'x', every_seconds: 3600 })
  // A task past its firing reads overdue; an inactive one is finished.
  schedule.tasks.set('schedule-late', { sessionId: 'w2', record: { id: 'schedule-late', kind: 'at', title: 'Late', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z' } })
  schedule.tasks.set('schedule-done', { sessionId: 'w2', record: { id: 'schedule-done', kind: 'at', title: 'Done', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z' }, status: 'inactive' })
  const listed = (await call('schedules', {})).value
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId]), [['Done', 'w1'], ['Late', 'w1'], ['Briefing', 'w1'], ['Old part', 'w1']])
  assert.deepEqual(listed.tasks.map(task => task.state), ['finished', 'overdue', 'scheduled', 'scheduled'])

  const weekly = await call('schedule-create', { target: 'm1', title: 'Week', prompt: 'Plan', when: { kind: 'weekly', time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 1, 9] } })
  assert.equal(weekly.ok, true)
  assert.deepEqual([...schedule.tasks.values()].at(-1).record.timing, { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] })
  const every = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.equal([...schedule.tasks.values()].at(-1).record.timing, 1800, JSON.stringify(every))

  for (const [when, message] of [
    [{ kind: 'at', at: '2000-01-01T00:00:00Z' }, /future/],
    [{ kind: 'weekly', time: '09:00', weekdays: [] }, /at least one day/],
    [{ kind: 'daily', time: '24:00:00' }, /time of day/],
    [{ kind: 'daily', time: '09:00:61' }, /time of day/],
    [{ kind: 'daily', time: '9am' }, /time of day/],
    [{ kind: 'every', minutes: 0 }, /1 minute to 7 days/],
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when })
    assert.match(refused.error.message, message)
  }
  assert.match((await call('schedule-create', { target: 'm1', title: '', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /name/)

  const removed = await call('schedule-delete', { sessionId: 'w2', id: created.record.id })
  assert.deepEqual(removed.value.tasks.map(task => task.title), ['Done', 'Late', 'Old part', 'Week', 'Ping'])
  assert.match((await call('schedule-delete', { sessionId: 'outside', id: 'schedule-3' })).error.message, /No such task/)
})

test('a group chat task lives on the group Session and lists under the group', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].sessionId, 'g1')
  assert.deepEqual(made.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.match((await call('schedule-create', { target: 'nobody', title: 'x', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /No such Bot or group chat/)
})

test('a due reminder reaches a group as its prompts', () => {
  const one = ['[SCHEDULE REMINDER]', 'framing', 'schedule_id_json: "s1"', 'occurrence_at: 2030-01-01T00:00:00Z', 'reminder_prompt_json: "Where are we?"'].join('\n')
  assert.equal(reminderText(one), '[Scheduled task] Where are we?')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'framing', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', reminder_prompt: 'One' }, { schedule_id: 'b', reminder_prompt: 'Two' }])}`].join('\n')
  assert.equal(reminderText(batch), '[Scheduled task] One\n[Scheduled task] Two')
  assert.equal(reminderText('plain text'), 'plain text')
})

// Fei2411/DS-Bot#814: DSH 0.2.2 keeps tasks Host-wide with a delivery target.
test('on DSH 0.2.2 tasks target the Bot’s current part, list by target, delete by id and move in place', async (t) => {
  const schedule = hostSchedule()
  const { ctx, home, call, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const [created] = [...schedule.tasks.values()]
  assert.deepEqual(created.target, { kind: 'session', sessionId: 'w2' })
  assert.equal(created.record.kind, 'daily')
  assert.deepEqual(created.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.deepEqual([...schedule.tasks.values()].at(-1).timing, 1800)

  schedule.tasks.set('schedule-paused', { record: { id: 'schedule-paused', kind: 'rrule', title: 'Held', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'paused' })
  schedule.tasks.set('schedule-ended', { record: { id: 'schedule-ended', kind: 'at', title: 'Done', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'ended' })
  schedule.tasks.set('schedule-new', { record: { id: 'schedule-new', kind: 'at', title: 'Elsewhere', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'new_once' }, status: 'active' })
  const listed = (await call('schedules', {})).value
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId, task.sessionId, task.state]), [
    ['Briefing', 'w1', 'w2', 'scheduled'], ['Ping', 'm1', 'm1', 'scheduled'], ['Held', 'w1', 'w2', 'paused'], ['Done', 'w1', 'w2', 'finished'],
  ])

  await rt.moveSchedules('w2', 's9')
  assert.deepEqual(schedule.edits.map(edit => [edit.id, edit.patch?.target?.sessionId]), [['schedule-1', 's9'], ['schedule-paused', 's9']])
  assert.deepEqual(schedule.tasks.get('schedule-ended').target, { kind: 'session', sessionId: 'w2' })

  assert.match((await call('schedule-delete', { sessionId: 'w2', id: 'schedule-1' })).error.message, /No such task/)
  assert.match((await call('schedule-delete', { sessionId: 'm1', id: 'schedule-new' })).error.message, /No such task/)
  const removed = await call('schedule-delete', { sessionId: 'm1', id: 'schedule-2' })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(schedule.tasks.has('schedule-2'), false)
  assert.deepEqual(schedule.edits.at(-1), { id: 'schedule-2', action: 'delete' })
})

// DSH 0.2.2's task ids are Host-wide, so schedule_edit could reach another Bot's task.
test('on DSH 0.2.2 a Bot reads and changes only the tasks of its own chat', async (t) => {
  const schedule = hostSchedule()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  schedule.tasks.set('own', { record: { id: 'own', kind: 'at', title: 'Mine', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w1' }, status: 'active' })
  schedule.tasks.set('chief', { record: { id: 'chief', kind: 'at', title: 'Chief', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'm1' }, status: 'active' })
  schedule.tasks.set('elsewhere', { record: { id: 'elsewhere', kind: 'at', title: 'New', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'new_once' }, status: 'active' })
  const [gate] = ctx.listeners.get('tools/pre-execute')
  const check = (name, id, sessionId) => gate({ name, arguments: { id, action: 'delete' }, agent: { id: sessionId } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(await check('schedule_edit', 'own', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_view', 'own', 'w2'), { kind: 'allow' })
  for (const id of ['chief', 'elsewhere']) {
    for (const name of ['schedule_edit', 'schedule_view']) assert.equal((await check(name, id, 'w2')).kind, 'deny')
  }
  assert.deepEqual(await check('schedule_edit', 'chief', 'm1'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_edit', 'missing', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_list', 'chief', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_edit', 'chief', 'outside'), { kind: 'allow' })

  // schedule_list asks the tool for the Host range that holds the caller's page and
  // keeps the caller's own tasks. Other modules wrap tools/execute too.
  schedule.tasks.set('own2', { record: { id: 'own2', kind: 'at', title: 'Mine too', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'active' })
  const list = ctx.listeners.get('tools/execute').find(listener => listener.name === 'listOwnSchedules')
  const asked = []
  // The tool's own page: the catalog order, cut at offset and limit.
  const run = (sessionId, args) => {
    const exec = { name: 'schedule_list', arguments: args, agent: { id: sessionId } }
    return list(exec, async () => {
      asked.push(exec.arguments)
      const { limit = 100, offset = 0 } = exec.arguments
      const all = (await schedule.catalog()).map(entry => ({ id: entry.id, title: entry.title, target: entry.target }))
      const items = all.slice(offset, offset + limit)
      return { isError: false, value: { items, shown: items.length, total: all.length, limit, offset } }
    }).then(result => ({ result, args: exec.arguments }))
  }
  const second = await run('w2', { active: true, limit: 1, offset: 1 })
  assert.deepEqual(asked.at(-1), { active: true, limit: 1, offset: 3 })
  assert.deepEqual(second.args, { active: true, limit: 1, offset: 1 })
  assert.deepEqual(second.result.value, { items: [{ id: 'own2', title: 'Mine too', target: { kind: 'session', sessionId: 'w2' } }], shown: 1, total: 2, limit: 1, offset: 1 })
  const both = await run('w2', {})
  assert.deepEqual(asked.at(-1), { limit: 4, offset: 0 })
  assert.deepEqual(both.result.value.items.map(task => task.id), ['own', 'own2'])
  assert.deepEqual((await run('w2', { offset: 5 })).result.value, { items: [], shown: 0, total: 2, limit: 100, offset: 5 })
  // A page out of DSH's range goes to DSH as asked, and what comes back is still narrowed.
  const wide = await run('w2', { limit: 501 })
  assert.deepEqual(asked.at(-1), { limit: 501 })
  assert.deepEqual(wide.result.value.items.map(task => task.id), ['own', 'own2'])
  assert.equal(wide.result.value.total, 2)
  assert.deepEqual((await run('m1', {})).result.value.items.map(task => task.id), ['chief'])
  assert.equal((await run('outside', {})).result.value.items.length, 4)
})

test('a failed task move can resume without losing identical remaining tasks', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await schedule.create('w2', { title: 'Ping', prompt: 'Check', every_seconds: 3600 })
  await schedule.create('w2', { title: 'Ping', prompt: 'Check', every_seconds: 3600 })

  const create = schedule.create
  let attempts = 0
  schedule.create = async (...args) => {
    if (++attempts === 2) throw new Error('down')
    return create(...args)
  }
  await assert.rejects(rt.moveSchedules('w2', 's9'), /down/)
  const on = id => [...schedule.tasks.values()].filter(task => task.sessionId === id)
  assert.equal(on('s9').length, 1)
  assert.equal(on('w2').length, 1)

  schedule.create = create
  await rt.moveSchedules('w2', 's9')
  assert.equal(on('s9').length, 2)
  assert.equal(on('w2').length, 0)
})
