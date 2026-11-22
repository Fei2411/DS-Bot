// Scheduled tasks. DSH's schedule service stores each task with the Session it belongs
// to and, when it is due, sends its prompt to that Session as a new message. This
// module lists the team's tasks for Settings, creates and removes them there, and moves
// a Bot's tasks along when its chat goes on in a fresh part, so the Bot keeps seeing
// them. A group chat's task lives on the group's own Session, so the reminder reaches
// the group like a message from the user (see reminderText). DSH 0.2.0 mounts the service only with its Automation tasks bundle on, so
// the service is optional and every endpoint reports whether it is there.

import { threadCurrentOfPart, threadOfPart } from './threads.js'

const MAX_TITLE = 120
// A time input reports HH:mm, or HH:mm:ss when the browser's picker shows seconds.
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
const withSeconds = time => (time.length === 5 ? `${time}:00` : time)

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: DSH frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    // A framing this module cannot read goes to the group as it came.
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

// The create request that gives a stored record its timing again, for a move.
function requestOf(record) {
  const base = { title: record.title, prompt: record.prompt }
  if (record.kind === 'after' || record.kind === 'at') return { ...base, at: record.scheduledAt }
  if (record.kind === 'every') return { ...base, every_seconds: record.everySeconds }
  if (record.kind === 'daily') return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
  if (record.kind === 'weekly') return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
  if (record.kind === 'cron') return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
  return null
}

// DSH 0.2.2 keeps tasks Host-wide, each with a delivery target, and changes them through
// edit(); DSH 0.2.1 keeps them by Session. Both are served.
const hostWide = service => typeof service.edit === 'function'
// The existing Session a task delivers to; a task that opens new Sessions has none.
const sessionOf = entry => entry.target === undefined ? entry.sessionId : entry.target.kind === 'session' ? entry.target.sessionId : undefined
const TIMING_KINDS = { at: 'at', every_seconds: 'every', daily: 'daily', weekly: 'weekly' }
const OWN_TASK_TOOLS = ['schedule_edit', 'schedule_view']
// DSH 0.2.2's list page: 100 by default, at most 500.
const LIST_PAGE = 100
const LIST_READ_LIMIT = 500
const OTHER_TASK_REFUSAL = 'This task belongs to another chat. A Bot reads and changes only the tasks of its own chat.'
const sameOwner = (a, b) => a !== undefined && b !== undefined && a.botId === b.botId && a.roomId === b.roomId
const timingOf = (selector) => {
  const [key] = Object.keys(selector)
  return { kind: TIMING_KINDS[key], [key]: selector[key] }
}

// The settings form's timing as a create request selector.
function selectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { daily: { time: withSeconds(when.time), time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { weekly: { time: withSeconds(when.time), time_zone: zone, weekdays } }
    }
    case 'every': {
      const minutes = Number(when.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw invalid('Repeat every 1 minute to 7 days')
      return { every_seconds: minutes * 60 }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

export function install(rt) {
  const { ctx } = rt
  let service = null

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
    void rt.retireParts?.()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  // The Bot (and group chat) a task's Session speaks for, the group chat for a group's
  // own Session, or nothing for a Session outside the team.
  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    const room = rt.roomOf(sessionId)
    if (room !== undefined) return { roomId: room.id }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  // The part that now carries the thread a task's Session belongs to: a Bot's chat and an
  // older chat still open beside it each go on in their own thread. A group member's own
  // part has none here.
  const currentSessionOf = (owner, sessionId) => {
    if (owner === undefined || (owner.botId !== undefined && owner.roomId !== undefined)) return undefined
    if (owner.botId !== undefined) {
      const bot = rt.botOf(owner.botId)
      if (bot === undefined) return undefined
      // A background task's Session holds no schedules: the hand-off moves them to the
      // foreground chat, and a task may not make one. One found there was left by a move
      // that failed, so it goes back to the foreground chat.
      if (threadOfPart(bot, sessionId)?.thread === 'task') return rt.chatOf(owner.botId)
      return threadCurrentOfPart(bot, sessionId)
    }
    const room = rt.roomOf(owner.roomId)
    return room === undefined ? undefined : rt.sessionOfRoom(room)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined ? rt.roomOf(owner.roomId) !== undefined : rt.botOf(owner.botId) !== undefined)

  // A Host-wide task delivering to this team Session, or nothing.
  const teamTask = async (id, sessionId) => {
    if (ownerOf(sessionId) === undefined) return undefined
    const entry = (await service.catalog()).find(task => task.id === id)
    return entry === undefined || sessionOf(entry) !== sessionId ? undefined : entry
  }

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    const now = Date.now()
    const tasks = []
    for (const entry of await service.catalog()) {
      const sessionId = sessionOf(entry)
      const owner = sessionId === undefined ? undefined : ownerOf(sessionId)
      if (!known(owner)) continue
      // The state DSH derives for its own view: a task past its next firing reads
      // overdue; a paused one stays paused; any other is finished. catalog() carries
      // the status but not this state, so it is derived the same way here.
      const state = entry.status === 'active' ? (now >= Date.parse(entry.scheduledAt) ? 'overdue' : 'scheduled')
        : entry.status === 'paused' ? 'paused' : 'finished'
      tasks.push({ ...entry, sessionId, ...owner, state })
    }
    // DSH 0.2.1 keeps tasks by Session and has no pause.
    return { available: true, canPause: hostWide(service), tasks }
  }

  const endpoints = {
    schedules: () => schedulesView(),
    async 'schedule-create'(body) {
      if (service === null) throw invalid('Automation tasks are off in DSH')
      const bot = rt.botOf(body.target)
      const room = rt.roomOf(body.target)
      if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
      const title = String(body.title ?? '').trim()
      const prompt = String(body.prompt ?? '').trim()
      if (title === '') throw invalid('Give the task a name')
      if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
      if (prompt === '') throw invalid('Say what the Bot should do')
      const sessionId = bot ? rt.chatOf(bot.id) : rt.sessionOfRoom(room)
      const selector = selectorOf(body.when)
      if (hostWide(service)) await service.create({ title, prompt, timing: timingOf(selector), target: { kind: 'session', sessionId } })
      else await service.create(sessionId, { title, prompt, ...selector })
      return schedulesView()
    },
    async 'schedule-delete'(body) {
      if (service === null) throw invalid('Automation tasks are off in DSH')
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      if (hostWide(service)) {
        // Ids are Host-wide here, so the task must still deliver to the team Session named.
        if (await teamTask(body.id, body.sessionId) === undefined) throw invalid('No such task')
        await service.edit({ id: body.id, action: 'delete' })
      } else {
        await service.delete({ sessionId: body.sessionId, id: body.id })
      }
      return schedulesView()
    },
    // Pause keeps the task and its timing; resume picks the next time it comes round.
    // The edit names the version it read, so a delivery that ended a one-time task or a
    // Bot's own change in between is not overwritten; a conflict reads the task again.
    async 'schedule-pause'(body) {
      if (service === null) throw invalid('Automation tasks are off in DSH')
      if (!hostWide(service)) throw invalid('No such task')
      const active = body.active === true
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const entry = await teamTask(body.id, body.sessionId)
        if (entry === undefined || entry.status === 'ended') throw invalid('No such task')
        if (entry.status === (active ? 'active' : 'paused')) return schedulesView()
        // A one-time task whose time has come is about to be delivered: paused now, it
        // would never run and could never resume.
        if (!active && (entry.kind === 'at' || entry.kind === 'after') && Date.parse(entry.scheduledAt) <= Date.now()) throw invalid('This task is due now and can’t be paused.')
        const patch = { active }
        // A task left on an earlier part (a move that failed) resumes on the chat's
        // current part: DSH refuses to resume onto an archived Session.
        const current = active ? currentSessionOf(ownerOf(body.sessionId), body.sessionId) : undefined
        if (current !== undefined && current !== body.sessionId) patch.target = { kind: 'session', sessionId: current }
        let result
        try {
          result = await service.edit({ id: body.id, action: 'update', patch, expectedUpdatedAt: entry.updatedAt ?? null })
        } catch (error) {
          // A one-time task whose time has passed has nothing left to resume to.
          if (error?.code === 'not_future' || error?.details?.code === 'not_future' || /no future occurrence/i.test(error?.message ?? '')) throw invalid('Pick a time in the future')
          if (/is archived/i.test(error?.message ?? '')) throw invalid('This task’s chat has ended. Delete the task and make it again.')
          throw error
        }
        if (result?.code === 'schedule_conflict') continue
        if (result?.code === 'schedule_not_found') throw invalid('No such task')
        return schedulesView()
      }
      throw invalid('The task just changed. Try again.')
    },
  }

  // A fresh part takes over the earlier part's active tasks: each is created again on
  // the fresh Session before the old one goes, so a failure leaves it where it was.
  async function moveSchedules(fromId, toId) {
    if (service === null) return
    // A Host-wide task changes its target in place and keeps its next firing; a
    // paused one moves too, so it resumes in the Bot's current part.
    if (hostWide(service)) {
      for (const entry of await service.catalog()) {
        if (entry.status === 'ended' || sessionOf(entry) !== fromId) continue
        await service.edit({ id: entry.id, action: 'update', patch: { target: { kind: 'session', sessionId: toId } } })
      }
      return
    }
    const records = await service.list({ sessionId: fromId })
    for (const record of records) {
      const request = requestOf(record)
      if (request === null || (request.at !== undefined && Date.parse(request.at) <= Date.now())) continue
      // A failed read or copy must prevent stopActivity from deleting an unmoved
      // task. Equal requests can be separate tasks; copy each source record.
      await service.create(toId, request)
      try {
        await service.delete({ sessionId: fromId, id: record.id })
      } catch (error) {
        // The copy is safe; archiving the earlier part will remove its old task.
        rt.warn('ds-bot: earlier copy of task %s not removed: %s', record.title, error?.message ?? error)
      }
    }
  }

  // DSH 0.2.2's task ids are Host-wide, so a Bot's schedule tools reach only the tasks
  // that deliver to its own chat, or to the same group place, in any of its parts.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !OWN_TASK_TOOLS.includes(exec.name) || service === null || !hostWide(service)) return decision
    await rt.load()
    const caller = exec.agent?.id
    if (!rt.isBotSession(caller)) return decision
    const entry = (await service.catalog()).find(task => task.id === exec.arguments?.id)
    // An unknown id gets DSH's own not-found result.
    if (entry === undefined) return decision
    const target = sessionOf(entry)
    if (target !== undefined && sameOwner(ownerOf(caller), ownerOf(target))) return decision
    return { kind: 'deny', reason: OTHER_TASK_REFUSAL }
  })
  // schedule_list pages over every Host task and cannot filter by Session, and only the
  // tool formats its items. So the tool is asked for the Host range that holds the
  // caller's page (catalog() keeps list()'s order), and the other chats' tasks in that
  // range are dropped. A page whose tasks span more than one Host page comes back
  // short; total still counts all of the caller's tasks, so the next offset goes on.
  ctx.on('tools/execute', async function listOwnSchedules(exec, next) {
    if (exec.name !== 'schedule_list' || service === null || !hostWide(service)) return next()
    await rt.load()
    const own = rt.isBotSession(exec.agent?.id) ? ownerOf(exec.agent.id) : undefined
    if (own === undefined) return next()
    const asked = exec.arguments ?? {}
    const limit = asked.limit ?? LIST_PAGE
    const offset = asked.offset ?? 0
    const mine = entry => {
      const target = sessionOf(entry)
      return target !== undefined && sameOwner(own, ownerOf(target))
    }
    // An invalid page gets DSH's own input error; a page it accepts anyway is still narrowed.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_READ_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
      const result = await next()
      if (result.isError || !Array.isArray(result.value?.items)) return result
      const items = result.value.items.filter(mine)
      const total = (await service.catalog()).filter(entry => mine(entry) && (asked.active === undefined || (entry.status === 'active') === asked.active)).length
      return { ...result, value: { ...result.value, items, shown: items.length, total } }
    }
    const pool = (await service.catalog()).filter(entry => asked.active === undefined || (entry.status === 'active') === asked.active)
    const positions = pool.flatMap((entry, at) => (mine(entry) ? [at] : []))
    const page = positions.slice(offset, offset + limit)
    const from = page[0] ?? pool.length
    exec.arguments = { ...asked, offset: from, limit: page.length === 0 ? 1 : Math.min(LIST_READ_LIMIT, page.at(-1) - from + 1) }
    let result
    try {
      result = await next()
    } finally {
      exec.arguments = asked
    }
    if (result.isError || !Array.isArray(result.value?.items)) return result
    const items = result.value.items.filter(mine).slice(0, limit)
    return { ...result, value: { ...result.value, items, shown: items.length, total: positions.length, limit, offset } }
  })

  // DSH injects its schedule service after the plugin starts; until then a task cannot move.
  const schedulesPending = () => typeof ctx.inject === 'function' && service === null
  Object.assign(rt, { scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}), moveSchedules, schedulesPending })
}
