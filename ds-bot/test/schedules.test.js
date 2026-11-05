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

// DSH 0.2.2's schedule service: typed timing and target on create, a Host-wide list
// with no Session filter, catalog entries that name their Session in `target`, and
// delete or retarget through edit().
function typedScheduleService() {
  const tasks = new Map()
  let next = 1
  const entry = task => ({ ...task.record, target: task.target, status: task.status ?? 'active' })
  return {
    tasks,
    async create(request) {
      const { timing, target } = request
      const keys = Object.keys(timing)
      if (keys.length !== 2 || !keys.includes('kind')) throw new Error('timing must contain exactly kind and its matching selector.')
      if (target?.kind !== 'session') throw new Error('expected a session target')
      const id = `schedule-${next++}`
      const selector = keys.find(key => key !== 'kind')
      const record = { id, kind: timing.kind, title: request.title, prompt: request.prompt, timing: timing[selector], scheduledAt: '2030-01-01T01:00:00.000Z', everySeconds: timing.every_seconds }
      tasks.set(id, { target, record })
      return entry(tasks.get(id))
    },
    async list() { const items = [...tasks.values()].map(entry); return { items, shown: items.length, total: items.length, limit: 50, offset: 0 } },
    async catalog() { return [...tasks.values()].map(entry) },
    async edit(request) {
      const task = tasks.get(request.id)
      if (task === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.action === 'delete') { tasks.delete(request.id); return { id: request.id, deleted: true } }
      if (request.patch.target !== undefined) task.target = request.patch.target
      return entry(task)
    },
  }
}

test('DSH 0.2.2 schedule service: typed create, listing by target, delete through edit', async (t) => {
  const schedule = typedScheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const [task] = [...schedule.tasks.values()]
  assert.deepEqual(task.target, { kind: 'session', sessionId: 'w2' })
  assert.equal(task.record.kind, 'daily')
  assert.deepEqual(made.value.tasks.map(entry => [entry.title, entry.botId, entry.sessionId]), [['Briefing', 'w1', 'w2']])
  const removed = await call('schedule-delete', { sessionId: 'w2', id: task.record.id })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(schedule.tasks.size, 0)
})

test('DSH 0.2.2 schedule service: a part move retargets only the earlier part’s tasks', async (t) => {
  const schedule = typedScheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const session = sessionId => ({ kind: 'session', sessionId })
  await schedule.create({ title: 'Ping', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 }, target: session('w2') })
  await schedule.create({ title: 'Other', prompt: 'Not ours', timing: { kind: 'every', every_seconds: 3600 }, target: session('m1') })
  await schedule.create({ title: 'Outside', prompt: 'Not the team', timing: { kind: 'every', every_seconds: 3600 }, target: session('outside') })
  await rt.moveSchedules('w2', 's9')
  const on = id => [...schedule.tasks.values()].filter(task => task.target.sessionId === id).map(task => task.record.title)
  assert.deepEqual(on('s9'), ['Ping'])
  assert.deepEqual(on('w2'), [])
  assert.deepEqual(on('m1'), ['Other'])
  assert.deepEqual(on('outside'), ['Outside'])
  assert.equal(schedule.tasks.size, 3, 'a move retargets in place; it creates no copy')
})
