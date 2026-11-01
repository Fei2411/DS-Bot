// Group goals: one outcome the whole group works toward, checked stage by stage.
// The state lives on the room (room.goal, archived into room.pastGoals), the admin
// runs it with the group_goal tool, the user steers it from the goal endpoints,
// and the relay wakes the admin when nothing runs and the goal is not done.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GOAL_IDLE_NUDGES, SOURCE_KIND } from './constants.js'
import { headOf } from './text.js'
import { output } from './tools.js'

const TITLE_MAX = 80
const BRIEF_MAX = 2000
const TEXT_MAX = 2000
const RULE_MAX = 300
const RULES_MAX = 20
const STAGES_MAX = 20
const STAGE_TITLE_MAX = 80
const STAGE_ACCEPTANCE_MAX = 1000
const TASKS_MAX = 12
const TASK_MAX = 500
const NOTE_MAX = 300
const REASON_MAX = 300
const FEEDBACK_MAX = 1000
const EVENT_TEXT_MAX = 300
const EVENTS_MAX = 50
const PAST_MAX = 5

const tooLong = (what, max) => `${what} is too long: at most ${max}.`
const tooMany = (what, max) => `At most ${max} ${what}.`
const required = (field, action) => `${field} is required for ${action}.`
const noGoal = room => `"${room.name}" has no goal. Start one with group_goal draft or start.`
const wrongState = (room, goal, action, allowed) => `The goal of "${room.name}" is ${goal.status}; ${action} needs it to be ${allowed}.`
const pausedRun = room => `The goal of "${room.name}" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.`
const allPassed = room => `Every stage of "${room.name}" has passed. Call group_goal complete with the evidence and a summary.`

export const TASK_LABEL = { pending: 'not started', working: 'working', reported: 'reported', done: 'done' }

const goalId = () => `goal-${randomUUID().replace(/-/g, '').slice(0, 8)}`

// The goal's own stamp on every change: a new revision the client polls, the
// change in its event list, and the idle bookkeeping reset.
export function touchGoal(goal, event, now = Date.now(), { keepNudges = false } = {}) {
  goal.revision += 1
  goal.updatedAt = now
  if (!keepNudges) {
    goal.nudges = 0
    delete goal.idle
  }
  if (event !== undefined) goal.events = [...(goal.events ?? []), { at: now, ...event }].slice(-EVENTS_MAX)
}

export function archiveGoal(room) {
  const goal = room.goal
  if (goal === undefined) return
  room.pastGoals = [...(room.pastGoals ?? []), goal].slice(-PAST_MAX)
  delete room.goal
}

function newGoal({ brief = '', title, by = 'user', event = 'draft' } = {}, now) {
  const text = String(brief).trim()
  const goal = {
    id: goalId(),
    revision: 0,
    status: 'drafting',
    title: (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX),
    ...(text !== '' ? { brief: text.slice(0, BRIEF_MAX) } : {}),
    objective: '',
    acceptance: '',
    constraints: [],
    stages: [],
    current: -1,
    nudges: 0,
    by,
    createdAt: now,
    updatedAt: now,
    events: [],
    // Stage and task ids are never reused inside a goal, not even by a revise
    // that drops the stages they were on.
    counter: { stage: 0, task: 0 },
  }
  if (event !== undefined) touchGoal(goal, { kind: event, by }, now)
  return goal
}

// What every task's bot must be: a current member, named exactly. `memberOf`
// resolves a name to the member or undefined; `memberNames` is for the refusal.
function cleanStages(room, list, action, memberOf, memberNames) {
  if (!Array.isArray(list) || list.length === 0) return { error: required('stages', action) }
  if (list.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  const stages = []
  for (const [index, item] of list.entries()) {
    const n = index + 1
    const title = String(item?.title ?? '').trim()
    if (title === '') return { error: required(`stage ${n} title`, action) }
    if (title.length > STAGE_TITLE_MAX) return { error: tooLong(`stage ${n} title`, STAGE_TITLE_MAX) }
    const acceptance = String(item?.acceptance ?? '').trim()
    if (acceptance === '') return { error: required(`stage ${n} acceptance`, action) }
    if (acceptance.length > STAGE_ACCEPTANCE_MAX) return { error: tooLong(`stage ${n} acceptance`, STAGE_ACCEPTANCE_MAX) }
    const items = Array.isArray(item?.tasks) ? item.tasks : []
    if (items.length === 0) return { error: required(`stage ${n} tasks`, action) }
    if (items.length > TASKS_MAX) return { error: tooMany(`tasks in stage ${n}`, TASKS_MAX) }
    const tasks = []
    for (const entry of items) {
      const name = String(entry?.bot ?? '').trim()
      const task = String(entry?.task ?? '').trim()
      if (task === '') return { error: required(`a task of stage ${n}`, action) }
      if (task.length > TASK_MAX) return { error: tooLong(`a task in stage ${n}`, TASK_MAX) }
      const bot = memberOf(name)
      if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
      tasks.push({ botId: bot.id, task })
    }
    stages.push({ title, acceptance, tasks })
  }
  return { stages }
}

function cleanConstraints(list, action) {
  if (list === undefined) return {}
  if (!Array.isArray(list)) return { error: required('constraints', action) }
  if (list.length > RULES_MAX) return { error: tooMany('constraints', RULES_MAX) }
  const constraints = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (text.length > RULE_MAX) return { error: tooLong('a constraint', RULE_MAX) }
    constraints.push(text)
  }
  return { constraints }
}

function cleanFields(input, fields) {
  for (const [field, max] of fields) {
    const value = input[field]
    if (value === undefined) continue
    if (String(value).trim().length > max) return { error: tooLong(field, max) }
  }
  return {}
}

// A cleaned stage becomes a stored one: fresh ids, tasks pending unless the same
// member had the same task in the stage this one replaces (a revise keeps it).
function buildStage(goal, stage, position, previous, status) {
  return {
    id: `s${++goal.counter.stage}`,
    title: stage.title,
    acceptance: stage.acceptance,
    status,
    tasks: stage.tasks.map((task) => {
      const kept = previous?.tasks.find(old => old.botId === task.botId && old.task === task.task)
      return { id: `t${++goal.counter.task}`, ...task, status: kept?.status ?? 'pending' }
    }),
    reworks: 0,
  }
}

export function draftGoal(room, { brief = '', title, by = 'user' } = {}, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'draft', 'new or drafting') }
  }
  const text = String(brief ?? '').trim()
  if (text === '') return { error: required('brief', 'draft') }
  if (text.length > BRIEF_MAX) return { error: tooLong('brief', BRIEF_MAX) }
  const cut = cleanFields({ title }, [['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  if (goal?.status === 'complete' || goal?.status === 'stopped') archiveGoal(room)
  const drafting = room.goal?.status === 'drafting' ? room.goal : undefined
  if (drafting !== undefined) {
    drafting.brief = text
    drafting.title = (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX)
    touchGoal(drafting, { kind: 'draft', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
    return { goal: drafting, reply: { event: 'draft', title: drafting.title, count: drafting.stages.length } }
  }
  const next = newGoal({ brief: text, title, by }, now)
  room.goal = next
  return { goal: next, reply: { event: 'draft', title: next.title, count: 0 } }
}

export function startGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'start', 'new or drafting') }
  }
  const objective = String(input.objective ?? '').trim()
  if (objective === '') return { error: required('objective', 'start') }
  const acceptance = String(input.acceptance ?? '').trim()
  if (acceptance === '') return { error: required('acceptance', 'start') }
  const cut = cleanFields(input, [['objective', TEXT_MAX], ['acceptance', TEXT_MAX], ['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  const rules = cleanConstraints(input.constraints, 'start')
  if (rules.error !== undefined) return rules
  const cleaned = cleanStages(room, input.stages, 'start', memberOf, memberNames)
  if (cleaned.error !== undefined) return cleaned
  if (goal?.status === 'complete' || goal?.status === 'stopped') archiveGoal(room)
  const draft = room.goal?.status === 'drafting' ? room.goal : undefined
  const next = draft ?? newGoal({ by, event: undefined }, now)
  if (draft === undefined) room.goal = next
  next.status = 'active'
  next.objective = objective
  next.acceptance = acceptance
  next.constraints = rules.constraints ?? []
  next.title = String(input.title ?? '').trim() || next.title || objective.split('\n')[0].slice(0, TITLE_MAX)
  delete next.brief
  next.stages = cleaned.stages.map((stage, index) => buildStage(next, stage, index, undefined, index === 0 ? 'active' : 'pending'))
  next.current = 0
  next.startedAt = now
  delete next.endedAt
  delete next.summary
  delete next.evidence
  delete next.reason
  delete next.pausedBy
  touchGoal(next, { kind: 'start', by }, now)
  return { goal: next, reply: { event: 'start', title: next.title, stage: 1, count: next.stages.length, next: next.stages[0].title } }
}

export function reviseGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active' && goal.status !== 'paused') return { error: wrongState(room, goal, 'revise', 'active or paused') }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'revise') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  const cut = cleanFields(input, [['title', TITLE_MAX], ['objective', TEXT_MAX], ['acceptance', TEXT_MAX]])
  if (cut.error !== undefined) return cut
  if (input.objective !== undefined && String(input.objective).trim() === '') return { error: required('objective', 'revise') }
  if (input.acceptance !== undefined && String(input.acceptance).trim() === '') return { error: required('acceptance', 'revise') }
  const rules = cleanConstraints(input.constraints, 'revise')
  if (rules.error !== undefined) return rules
  // Everything validates before anything changes: a refused revise leaves the goal as it was.
  let cleaned
  let keep = []
  if (input.stages !== undefined) {
    cleaned = cleanStages(room, input.stages, 'revise', memberOf, memberNames)
    if (cleaned.error !== undefined) return cleaned
    keep = goal.stages.slice(0, Math.max(0, goal.current))
    if (keep.length + cleaned.stages.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  }
  if (input.title !== undefined && String(input.title).trim() !== '') goal.title = String(input.title).trim()
  if (input.objective !== undefined) goal.objective = String(input.objective).trim()
  if (input.acceptance !== undefined) goal.acceptance = String(input.acceptance).trim()
  if (rules.constraints !== undefined) goal.constraints = rules.constraints
  if (cleaned !== undefined) {
    const previous = goal.stages[goal.current]
    const replacement = cleaned.stages.map((stage, index) => {
      const position = keep.length + index
      return buildStage(goal, stage, position, position === goal.current ? previous : undefined, position === goal.current ? 'active' : 'pending')
    })
    goal.stages = [...keep, ...replacement]
  }
  touchGoal(goal, { kind: 'revise', by, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'revise', title: goal.title, count: goal.stages.length, text: reason } }
}

export function taskGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'task', 'active') }
  const number = input.stage === undefined ? goal.current + 1 : Number(input.stage)
  const stage = Number.isInteger(number) ? goal.stages[number - 1] : undefined
  if (stage === undefined) return { error: `The goal of "${room.name}" has no stage ${number}.` }
  const name = String(input.bot ?? '').trim()
  if (name === '') return { error: required('bot', 'task') }
  const bot = memberOf(name)
  if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  const task = stage.tasks.find(item => item.botId === bot.id)
  if (task === undefined) return { error: `${name} has no task in stage ${number} of "${room.name}".` }
  const status = input.status === undefined ? undefined : String(input.status)
  const note = input.note === undefined ? undefined : String(input.note).trim()
  if (status === undefined && note === undefined) return { error: required('status or note', 'task') }
  if (note !== undefined && note.length > NOTE_MAX) return { error: tooLong('note', NOTE_MAX) }
  if (status !== undefined) task.status = status
  if (note !== undefined) {
    if (note === '') delete task.note
    else task.note = note
  }
  touchGoal(goal, { kind: 'task', by, stage: stage.id, text: headOf(note ?? status, EVENT_TEXT_MAX) }, now, { keepNudges: true })
  return { goal }
}

export function passGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'pass', 'active') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'pass') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  stage.status = 'passed'
  stage.evidence = evidence
  stage.passedAt = now
  for (const task of stage.tasks) task.status = 'done'
  goal.current += 1
  const next = goal.stages[goal.current]
  if (next !== undefined) next.status = 'active'
  touchGoal(goal, { kind: 'pass', by, stage: stage.id, text: headOf(evidence, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'pass', title: goal.title, stage: goal.current, count: goal.stages.length, ...(next !== undefined ? { next: next.title } : {}), text: evidence } }
}

export function reworkGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'rework', 'active') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'rework') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  let only
  if (input.bot !== undefined && String(input.bot).trim() !== '') {
    const name = String(input.bot).trim()
    only = memberOf(name)
    if (only === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  }
  for (const task of stage.tasks) {
    if (only !== undefined && task.botId !== only.id) continue
    task.status = 'pending'
    delete task.note
  }
  stage.reworks += 1
  stage.feedback = reason
  touchGoal(goal, { kind: 'rework', by, stage: stage.id, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'rework', title: goal.title, stage: goal.current + 1, count: goal.stages.length, text: reason } }
}

export function completeGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'complete', 'active') }
  const open = goal.stages.findIndex(stage => stage.status !== 'passed')
  if (open !== -1) return { error: `Stage ${open + 1} "${goal.stages[open].title}" has not passed yet. Pass every stage before complete.` }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'complete') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  const summary = String(input.summary ?? '').trim()
  if (summary === '') return { error: required('summary', 'complete') }
  if (summary.length > TEXT_MAX) return { error: tooLong('summary', TEXT_MAX) }
  goal.status = 'complete'
  goal.summary = summary
  goal.evidence = evidence
  goal.endedAt = now
  touchGoal(goal, { kind: 'complete', by }, now)
  return { goal, reply: { event: 'complete', title: goal.title, count: goal.stages.length, text: summary } }
}

export function pauseGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
  goal.status = 'paused'
  goal.pausedBy = by
  touchGoal(goal, { kind: 'pause', by }, now)
  return { goal, reply: { event: 'pause', title: goal.title, count: goal.stages.length } }
}

export function resumeGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
  goal.status = 'active'
  delete goal.pausedBy
  touchGoal(goal, { kind: 'resume', by }, now)
  return { goal, reply: { event: 'resume', title: goal.title, count: goal.stages.length } }
}

export function stopGoal(room, reason, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (!['drafting', 'active', 'paused'].includes(goal.status)) {
    return { error: wrongState(room, goal, 'stop', 'drafting, active or paused') }
  }
  const text = String(reason ?? '').trim()
  if (text === '') return { error: required('reason', 'stop') }
  if (text.length > REASON_MAX) return { error: tooLong('reason', REASON_MAX) }
  goal.status = 'stopped'
  goal.reason = text
  goal.endedAt = now
  touchGoal(goal, { kind: 'stop', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'stop', title: goal.title, count: goal.stages.length, text } }
}

// Automatic task status, from what happens in the room rather than the tool:
// the admin calling a member moves its task to working, the member's answer
// moves it to reported, and a failure or a user stop puts it back to pending.
// No log line, no round reply — only a new revision.
export function markTasks(room, botId, from, to, note, now = Date.now()) {
  const goal = room.goal
  if (goal?.status !== 'active') return false
  const stage = goal.stages[goal.current]
  if (stage === undefined) return false
  let changed = false
  for (const task of stage.tasks) {
    if (task.botId !== botId || task.status !== from) continue
    task.status = to
    if (note === undefined) delete task.note
    else task.note = note
    changed = true
  }
  if (!changed) return false
  goal.nudges = 0
  delete goal.idle
  goal.revision += 1
  goal.updatedAt = now
  return true
}

const DUTY_ACTIVE = 'You run this goal. Hand each task of the current stage to its member with @Name; members you call in one message start together. When they report back, check the results against the stage\'s "done when" yourself or have a reviewing member check them. Then call group_goal pass with the evidence and hand out the next stage in the same reply, or call group_goal rework with what is missing and call the members again. Keep all work inside the objective and the rules. When the user corrects the direction, call group_goal revise first. Ask the user only for decisions you cannot make.'
const DUTY_PASSED = 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
const DUTY_PAUSED = 'The user paused this goal. Do not hand out stage work or pass stages. Talk with the user, and write their corrections into the goal with group_goal revise. The user resumes it.'
const dutyOf = goal => (goal.status === 'paused' ? DUTY_PAUSED : goal.stages[goal.current] === undefined ? DUTY_PASSED : DUTY_ACTIVE)

const DUTY_DRAFT = [
  'Align with the user before you write it, following the goal-grill skill:',
  '1. Find the facts yourself (files, code, records) or ask members with @Name. Never ask the user what you can look up.',
  '2. List the decisions only the user can make. Ask them in one message, numbered, each with your recommended answer, so the user can reply "as recommended". Skip this when nothing is open.',
  '3. Then call group_goal start: the objective, how to check it is done (commands, tests, files, evidence), the rules to keep, and the stages in order, each with its own check and its tasks for named members.',
].join('\n')
const NUDGE_LINE = 'Goal check from DS Bot: nothing is running in this group and the goal is not finished. Take the next step now: hand out the current stage\'s tasks that are not done, check a stage whose members have reported, or complete the goal if every stage passed. If you are waiting for the user, reply [PASS].'
const RESUME_LINE = 'The user resumed the goal. Take the next step now.'

export function install(rt) {
  const { ctx } = rt

  const memberOf = room => (ref) => {
    const bot = rt.findBot(ref)
    return bot !== undefined && room.members.includes(bot.id) ? bot : undefined
  }
  const memberNames = room => room.members.map(id => rt.botOf(id)?.name).filter(Boolean)
  const nameOf = id => rt.botOf(id)?.name ?? 'a member'

  // The admin's ledger: the whole goal, for the prompt block and the tool's answer.
  function ledgerLines(goal) {
    const lines = [`Goal: ${goal.title}`, `Objective: ${goal.objective}`, `Done when: ${goal.acceptance}`]
    if (goal.constraints.length > 0) lines.push('Rules:', ...goal.constraints.map(rule => `- ${rule}`))
    lines.push('Stages:')
    goal.stages.forEach((stage, index) => {
      const n = index + 1
      if (stage.status === 'passed') lines.push(`[passed] ${n}. ${stage.title}`)
      else if (index === goal.current) {
        lines.push(`[current] ${n}. ${stage.title} — done when: ${stage.acceptance}`)
        for (const task of stage.tasks) lines.push(`  - ${nameOf(task.botId)}: ${task.task} [${TASK_LABEL[task.status]}]${task.note ? ` — ${task.note}` : ''}`)
        if (stage.reworks > 0) lines.push(`  Sent back ${stage.reworks} ${stage.reworks === 1 ? 'time' : 'times'}. Latest feedback: ${stage.feedback ?? ''}`)
      } else lines.push(`[next] ${n}. ${stage.title}: ${[...new Set(stage.tasks.map(task => nameOf(task.botId)))].join(', ')}`)
    })
    const corrections = (goal.events ?? []).filter(event => event.kind === 'revise' && event.text).slice(-3).map(event => event.text)
    if (corrections.length > 0) lines.push(`Latest corrections from the user: ${corrections.join(' / ')}`)
    return lines
  }

  // A member's share of the goal: the current stage and its own task in it.
  function memberLines(room, goal, member) {
    const count = goal.stages.length
    const stage = goal.stages[goal.current]
    const lines = [
      `The group works toward: ${goal.title} — ${headOf(goal.objective, 600)}`,
      ...(goal.constraints.length > 0 ? [`Rules: ${goal.constraints.join('; ')}`] : []),
    ]
    if (stage === undefined) lines.push('Every stage passed; the admin is checking the whole goal.')
    else {
      lines.push(`Current stage ${goal.current + 1} "${stage.title}", done when: ${stage.acceptance}`)
      const tasks = stage.tasks.filter(task => task.botId === member.id)
      if (tasks.length === 0) lines.push('You have no task in this stage.')
      else for (const task of tasks) lines.push(`Your task in it: ${task.task} (${TASK_LABEL[task.status]}).`)
    }
    lines.push('Work only toward this. When you finish your task, end your reply with the evidence: the files you changed, the commands you ran and what they printed.')
    if (goal.status === 'paused') lines.push('The goal is paused: finish only what you are doing now and start no new stage work.')
    return { lines, stage: `${stage === undefined ? count : goal.current + 1}/${count}` }
  }

  // The <group_goal> block in every round's prompt; nudge and resume add a line
  // after it for the admin. No block at all with no goal or a finished one.
  function goalBlock(room, member, { nudge = false, resume = false } = {}) {
    const goal = room.goal
    if (goal === undefined || goal.status === 'complete' || goal.status === 'stopped') return ''
    const isAdmin = rt.isAdminOf(room, member.id)
    let block
    if (goal.status === 'drafting') {
      block = isAdmin
        ? ['<group_goal status="drafting">', `The user wants this group to reach a goal: ${goal.brief ?? ''}`, DUTY_DRAFT, '</group_goal>'].join('\n')
        : ['<group_goal status="drafting">', `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`, '</group_goal>'].join('\n')
    } else if (isAdmin) {
      block = [`<group_goal status="${goal.status}">`, ...ledgerLines(goal), dutyOf(goal), '</group_goal>'].join('\n')
    } else {
      const view = memberLines(room, goal, member)
      block = [`<group_goal status="${goal.status}" stage="${view.stage}">`, ...view.lines, '</group_goal>'].join('\n')
    }
    if (isAdmin && nudge) block += `\n${NUDGE_LINE}`
    if (isAdmin && resume) block += `\n${RESUME_LINE}`
    return block
  }

  // The tool's answer: the ledger as the caller sees it, without the block's tags.
  function goalLedger(room, member) {
    const goal = room.goal
    if (goal === undefined) return noGoal(room)
    if (goal.status === 'complete') return `Goal "${goal.title}" is complete.`
    if (goal.status === 'stopped') return `Goal "${goal.title}" was stopped${goal.reason ? `: ${goal.reason}` : ''}.`
    if (goal.status === 'drafting') {
      return rt.isAdminOf(room, member.id)
        ? `The user wants this group to reach a goal: ${goal.brief ?? ''}`
        : `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`
    }
    if (rt.isAdminOf(room, member.id)) return ledgerLines(goal).join('\n')
    return memberLines(room, goal, member).lines.join('\n')
  }

  // Every non-task change is a group event: a notice in the log the members read,
  // and a goal reply in every running round of the room for the client.
  const announce = (room, reply) => {
    rt.logRoom?.(room, { who: 'DS Bot', kind: 'notice', reason: 'goal', ...reply })
    for (const round of rt.roomProgress.values()) {
      if (round.roomId === room.id) round.replies.push({ kind: 'goal', ...reply, time: Date.now() })
    }
  }

  // A goal message into the room's own Session, which relays it as a new round:
  // the user's draft request, a resume after the user continues, or an idle nudge.
  async function queueGoalRelay(room, goal, text, senderName = 'You') {
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'goal', goal, goalId: room.goal?.id, exchangeId: randomUUID(), senderName, roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }

  // goal-draft { roomId, text }: the user's one-line ask opens a drafting goal.
  async function goalDraft(roomId, text) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const input = String(text ?? '').trim()
    if (input === '' || input.length > BRIEF_MAX) return { error: 'Write what this group should achieve, in at most 2000 characters.', code: 'bot/invalid' }
    const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
    if (admin === undefined) return { error: 'This group has no admin. Set one in the group settings first.' }
    if (room.goal !== undefined && (room.goal.status === 'active' || room.goal.status === 'paused')) {
      return { error: 'This group already has a goal. Stop it first.' }
    }
    const result = draftGoal(room, { brief: input, by: 'user' })
    if (result.error !== undefined) return { error: result.error }
    announce(room, result.reply)
    await rt.save()
    await queueGoalRelay(room, 'draft', `[Goal request]\n${input}`)
    return {}
  }

  // goal-control { roomId, goalId, action, stopWork? }: the user's pause, resume,
  // stop and clear from the goal panel.
  async function goalControl(roomId, body = {}) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const goal = room.goal
    if (goal === undefined || goal.id !== String(body.goalId ?? '')) return { error: 'The goal has changed. Look again.', code: 'bot/stale' }
    const action = String(body.action ?? '')
    if (action === 'pause') {
      if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
      const result = pauseGoal(room, 'user')
      announce(room, result.reply)
      await rt.save()
      if (body.stopWork === true) await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'resume') {
      if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
      const result = resumeGoal(room, 'user')
      announce(room, result.reply)
      await rt.save()
      await queueGoalRelay(room, 'resume', '[Goal resumed]')
      return {}
    }
    if (action === 'stop') {
      if (!['drafting', 'active', 'paused'].includes(goal.status)) return { error: wrongState(room, goal, 'stop', 'drafting, active or paused') }
      const result = stopGoal(room, 'Stopped by the user', 'user')
      announce(room, result.reply)
      await rt.save()
      await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'clear') {
      if (goal.status === 'active' || goal.status === 'paused') {
        return { error: `The goal of "${room.name}" is ${goal.status}; clear needs it to be drafting, complete or stopped.` }
      }
      if (goal.status === 'drafting') delete room.goal
      else archiveGoal(room)
      await rt.save()
      return {}
    }
    return { error: 'Nothing to do', code: 'bot/invalid' }
  }

  // The idle driver: once a round ends with the goal active and nothing running,
  // wake the admin for a goal check. Progress — a user message or a member's work
  // (the admin's own tools do not count) — only resets the check count; the round
  // still gets its check. An admin that passes waits for the user, and two checks
  // without progress mark the goal idle until something happens.
  async function goalDrive(room, round) {
    const goal = room.goal
    const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin)
    if (goal === undefined || goal.status !== 'active' || goal.idle === true || admin === undefined || !room.members.includes(admin.id)) return
    // A round nobody spoke in — e.g. a stop notice or a stale check — never nudges.
    if (round.stoppedOnly === true || round.slots.length === 0) return
    if (round.userMessage === true || round.slots.some(slot => slot.worked === true && slot.id !== admin.id)) goal.nudges = 0
    if (round.goalNudge === true && round.slots.some(slot => slot.id === admin.id && slot.status === 'passed')) {
      goal.idle = true
      goal.revision += 1
      goal.updatedAt = Date.now()
      await rt.save()
      return
    }
    if ((rt.workingInRoom?.(room) ?? []).length > 0) return
    if (rt.roomBatchPending?.(room.id) === true) return
    if ((rt.roomInbox.get(room.id)?.length ?? 0) > 0) return
    if (goal.nudges >= GOAL_IDLE_NUDGES) {
      goal.idle = true
      goal.revision += 1
      goal.updatedAt = Date.now()
      await rt.save()
      return
    }
    goal.nudges += 1
    goal.revision += 1
    goal.updatedAt = Date.now()
    await rt.save()
    await queueGoalRelay(room, 'nudge', '[Goal check]', 'DS Bot')
  }

  // The user pressed stop in the group: the goal waits for them instead of
  // waking the admin through the stop-notice round.
  const goalUserStopped = (roomId) => {
    const goal = rt.roomOf(roomId)?.goal
    if (goal?.status !== 'active') return
    goal.idle = true
    goal.revision += 1
    goal.updatedAt = Date.now()
    void rt.save().catch(() => {})
  }

  // A user post in the room — its own message or a goal draft — brings the goal
  // out of its idle wait and resets the count of fruitless wakes.
  const goalUserMessage = (roomId) => {
    const goal = rt.roomOf(roomId)?.goal
    if (goal === undefined || (goal.idle === undefined && goal.nudges === 0)) return
    delete goal.idle
    goal.nudges = 0
    goal.revision += 1
    goal.updatedAt = Date.now()
    void rt.save().catch(() => {})
  }

  const mark = (roomId, botId, from, to, note) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined && markTasks(room, botId, from, to, note)) void rt.save().catch(() => {})
  }

  ctx.tools.register(defineTool({
    name: 'group_goal',
    description: 'Set and run a group chat\'s goal: one outcome for the whole group, how to check it is done, and stages whose tasks go to members. Only the group\'s admin or a Main Bot changes it; any member can show it. Inside that group\'s own conversation the group is implied; elsewhere name it. Actions: show; draft (you are aligning the goal with the user before writing it); start (write it and begin stage 1); revise (change it when the user corrects the direction; reason required); task (set one member\'s task status or note); pass (the current stage meets its check; evidence required); rework (the current stage falls short; reason required); complete (every stage passed and the overall check is met; evidence and summary required); pause; resume; stop (reason required).',
    parameters: {
      group: { type: 'string', description: 'Exact group chat name from list_bots; leave out inside that group' },
      action: { type: 'string', required: true, enum: ['show', 'draft', 'start', 'revise', 'task', 'pass', 'rework', 'complete', 'pause', 'resume', 'stop'], description: 'What to do' },
      title: { type: 'string', description: 'Short title, up to 80 characters' },
      brief: { type: 'string', description: 'draft: what the user wants, in their words' },
      objective: { type: 'string', description: 'start, revise: the one outcome the group must reach' },
      acceptance: { type: 'string', description: 'start, revise: how to check the whole goal is done: commands or tests to run, files or results to look at, and the evidence to show' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'start, revise: rules every member keeps, including the user\'s corrections. Replaces the list' },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          // Not schema-required so a missing field gets the refusal text the
          // caller can fix, not a bare argument error.
          properties: {
            title: { type: 'string' },
            acceptance: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bot: { type: 'string' },
                  task: { type: 'string' },
                },
              },
            },
          },
        },
        description: 'start: every stage, in order. revise: replaces the current stage and every stage after it; passed stages stay. Each stage has a title, its own check (how to tell this stage is done) and its tasks, each for one member by exact name',
      },
      bot: { type: 'string', description: 'task: the member whose task changes. rework: only this member\'s task goes back' },
      stage: { type: 'integer', description: 'task: stage number, 1 for the first; the current stage when left out' },
      status: { type: 'string', enum: ['pending', 'working', 'reported', 'done'], description: 'task: the task\'s new status' },
      note: { type: 'string', description: 'task: where the task stands, in a few words' },
      evidence: { type: 'string', description: 'pass, complete: what shows it is done: test output, changed files, check results' },
      reason: { type: 'string', description: 'revise, rework, stop: why' },
      summary: { type: 'string', description: 'complete: what the group delivered, for the user' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_goal.'
      const action = String(args.action ?? '')
      let room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) {
        if (String(args.group ?? '').trim() === '') return required('group', action)
        const picked = rt.pickRoom(args.group, self)
        if (picked.error !== undefined) return picked.error
        room = picked.room
      }
      const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
      const change = action !== 'show'
      if (change && !rt.isMain(self) && !rt.isAdminOf(room, self)) {
        return admin !== undefined
          ? `Only ${admin.name}, the admin of "${room.name}", or a Main Bot changes its goal. Tell the admin in the group.`
          : `Only a Main Bot changes the goal of "${room.name}".`
      }
      if ((action === 'draft' || action === 'start') && admin === undefined) {
        return `"${room.name}" has no admin, and a goal needs one to run it. Set an admin with update_group first.`
      }
      const of = memberOf(room)
      const names = memberNames(room)
      let result
      let next = ''
      let post
      switch (action) {
        case 'show':
          return goalLedger(room, member)
        case 'draft':
          result = draftGoal(room, { brief: args.brief, title: args.title, by: self })
          next = 'Aligning. Ask the user only what is still open, then call group_goal start.'
          break
        case 'start':
          result = startGoal(room, args, self, of, names)
          next = 'Started. Hand out the tasks of stage 1 now, with @Name in your reply.'
          break
        case 'revise':
          result = reviseGoal(room, args, self, of, names)
          next = 'Changed. Tell the group what changed, and go on with the current stage.'
          break
        case 'task':
          result = taskGoal(room, args, self, of, names)
          break
        case 'pass':
          result = passGoal(room, args, self)
          next = result.goal === undefined ? ''
            : result.goal.stages[result.goal.current] !== undefined
              ? `Stage ${result.goal.current} passed. Stage ${result.goal.current + 1} "${result.goal.stages[result.goal.current].title}" is current: hand out its tasks with @Name in this reply.`
              : 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
          break
        case 'rework':
          result = reworkGoal(room, args, self, of, names)
          next = 'Sent back. Call the members again with @Name and say what is missing.'
          break
        case 'complete':
          result = completeGoal(room, args, self)
          next = 'Complete. Tell the user what was delivered.'
          break
        case 'pause':
          result = pauseGoal(room, self)
          next = 'Paused. Hand out no stage work until the goal is resumed.'
          break
        case 'resume':
          result = resumeGoal(room, self)
          next = 'Resumed. Take the next step now.'
          break
        case 'stop':
          result = stopGoal(room, args.reason, self)
          next = 'Stopped.'
          // The caller keeps running; the other members' work stops.
          post = async () => {
            for (const id of room.members.filter(other => other !== self)) await rt.stopMemberWork?.(room.id, id)
          }
          break
        default:
          return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      if (result.reply !== undefined) announce(room, result.reply)
      await rt.save()
      if (post !== undefined) await post()
      const ledger = goalLedger(room, member)
      return next === '' ? ledger : `${ledger}\n${next}`
    },
  }))

  Object.assign(rt, {
    goalBlock, goalLedger, goalDraft, goalControl, goalDrive, goalUserMessage, goalUserStopped,
    goalTaskWorking: (roomId, botId) => mark(roomId, botId, 'pending', 'working'),
    goalTaskReported: (roomId, botId) => mark(roomId, botId, 'working', 'reported'),
    goalTaskReset: (roomId, botId, note) => mark(roomId, botId, 'working', 'pending', note),
  })
}
