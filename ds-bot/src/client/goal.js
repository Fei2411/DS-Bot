import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { BotAvatar, BotMark, colorOf } from './mark.js'
import { inkText } from './inks.js'
import { CheckIcon, ChevronDownIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { SPRING_SHAPE, spring, useMorph } from './motion.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Group goal: the header island is the goal's status screen. One surface wraps
// the pill (title and progress on the top row) with a pod hanging under it —
// a status bar while closed, the full plan while open, a draft form while the
// user writes the brief. `goalView` derives everything shown as plain data.

const REPORTED = new Set(['reported', 'done'])
const RUNNING = new Set(['active', 'paused'])
const FACES_MAX = 4

// The admin runs a goal, so a goal needs one among the members.
export const hasGoalAdmin = (room, roster) => room !== undefined
  && room.members?.includes(room.admin) === true && roster.byId?.[room.admin] !== undefined

// A draft is allowed while no goal is in flight; a finished one is archived away.
export const canSetGoal = (room, roster) => hasGoalAdmin(room, roster)
  && room.goal?.status !== 'active' && room.goal?.status !== 'paused'

const stageRef = (n, count) => t('Stage {n}/{count}', { n, count })

// What the island and panel draw, as plain data: goal + live room work in, the
// bar's label, the stage segments, the faces and the panel's stage rows out.
export function goalView(goal, { roster = {}, roomWork = [] } = {}) {
  if (goal === null || goal === undefined) return null
  const stages = goal.stages ?? []
  const count = stages.length
  const at = goal.current
  const current = RUNNING.has(goal.status) ? stages[at] : undefined
  const checking = current !== undefined && (current.tasks ?? []).every(task => REPORTED.has(task.status))
  const barLabel =
    goal.status === 'drafting' ? t('Aligning the goal with you')
      : goal.status === 'stopped' ? t('Stopped')
        : goal.status === 'complete' ? `${t('Goal reached')} · ${count}/${count}`
          : goal.status === 'paused' ? (current ? `${t('Paused')} · ${stageRef(at + 1, count)}` : t('Paused'))
            : goal.idle === true ? (current ? `${t('Waiting for you')} · ${stageRef(at + 1, count)}` : t('Waiting for you'))
              : current ? t('Stage {n}/{count} · {title}', { n: at + 1, count, title: current.title })
                : t('Final check')
  const segments = stages.map((stage, i) => (stage.status === 'passed' ? 'done'
    : i === at && goal.status === 'paused' ? 'paused'
      : i === at && goal.status === 'active' ? (checking ? 'checking' : 'current')
        : 'todo'))
  // A member at work in this room shows as working even before its task does.
  const working = new Set((roomWork ?? []).map(entry => entry.botId))
  const seen = new Set()
  const faces = (current?.tasks ?? [])
    .filter((task) => {
      if (seen.has(task.botId) || roster.byId?.[task.botId] === undefined) return false
      seen.add(task.botId)
      return true
    })
    .map(task => ({ bot: roster.byId[task.botId], working: working.has(task.botId) || task.status === 'working' }))
  const stageViews = stages.map((stage, i) => ({
    n: i + 1,
    title: stage.title,
    acceptance: stage.acceptance,
    status: stage.status,
    chip: stage.status === 'passed' ? 'passed'
      : i === at && RUNNING.has(goal.status) ? (checking && goal.status === 'active' ? 'checking' : 'current')
        : 'upcoming',
    tasks: (stage.tasks ?? []).map(task => ({ bot: roster.byId?.[task.botId], task: task.task, status: task.status, note: task.note })),
    evidence: stage.evidence,
    reworks: stage.reworks ?? 0,
    feedback: stage.feedback,
  }))
  return {
    status: goal.status, idle: goal.idle === true, title: goal.title ?? '',
    done: stages.filter(stage => stage.status === 'passed').length, count,
    segments, barLabel, faces, stages: stageViews,
  }
}

// The transcript's one event line per goal change.
export function goalEventText(reply) {
  switch (reply?.event) {
    case 'draft': return t('Setting a goal')
    case 'start': return t('Goal set: {title} · {count} stages', { title: reply.title, count: reply.count })
    case 'pass': return reply.next === undefined
      ? t('All {count} stages passed', { count: reply.count })
      : t('Stage {n} passed · now stage {m}: {next}', { n: reply.stage, m: (reply.stage ?? 0) + 1, next: reply.next })
    case 'rework': return t('Stage {n} sent back for rework', { n: reply.stage })
    case 'revise': return t('Goal updated')
    case 'pause': return t('Goal paused')
    case 'resume': return t('Goal resumed')
    case 'complete': return t('Goal reached: {title}', { title: reply.title })
    case 'stop': return t('Goal stopped')
    default: return reply?.title ?? ''
  }
}

// Escape and outside clicks close the open panel; mounted only while it is open
// so the shared Escape stack sees it as the newest layer.
function GoalOutside({ island, close }) {
  useEscape(close)
  useEffect(() => {
    const onDown = (event) => { if (island.current && !island.current.contains(event.target)) close() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [close])
  return null
}

// The pod's closed face: state dot or check, the bar label, one segment per
// stage, the faces of the members the current stage is for, and the chevron.
function GoalBar({ view, open, room, actions }) {
  return h('button', { type: 'button', className: 'bt-goal-bar', 'aria-expanded': open, onClick: () => actions.toggleGoal(room.id) },
    view.status === 'complete'
      ? h('span', { className: 'bt-goal-check', 'aria-hidden': true }, h(CheckIcon))
      : h('span', { className: 'bt-goal-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-goal-label' }, view.barLabel),
    view.segments.length > 0 ? h('span', { className: 'bt-goal-segs', 'aria-hidden': true },
      view.segments.map((seg, i) => h('i', { key: i, 'data-seg': seg }))) : null,
    view.faces.length > 0 ? h('span', { className: 'bt-goal-faces', 'aria-hidden': true },
      view.faces.slice(0, FACES_MAX).map(face => h('span', { key: face.bot.id, className: 'bt-goal-face' },
        h(BotMark, { bot: face.bot, size: 18, state: face.working ? 'working' : 'idle' }))),
      view.faces.length > FACES_MAX ? h('span', { className: 'bt-goal-more' }, `+${view.faces.length - FACES_MAX}`) : null) : null,
    h('span', { className: 'bt-goal-chev', 'aria-hidden': true }, h(ChevronDownIcon)))
}

const STAGE_CHIP = { passed: 'Passed', current: 'Current', checking: 'Checking', upcoming: 'Upcoming' }
const TASK_CHIP = { pending: 'Not started', working: 'Working', reported: 'Reported', done: 'Done' }

function TaskRow({ task, working }) {
  const live = working.has(task.bot?.id) || task.status === 'working'
  return h('div', { className: 'bt-goal-task' },
    task.bot ? h(BotAvatar, { bot: task.bot, size: 20, state: live ? 'working' : 'idle' }) : null,
    h('span', { className: 'bt-goal-task-body' },
      h('span', { className: 'bt-goal-task-line' },
        h('span', { className: 'bt-goal-task-name', style: task.bot ? { color: inkText(colorOf(task.bot)) } : undefined }, task.bot?.name ?? t('a Bot'))),
      h('span', { className: 'bt-goal-task-text' }, task.task),
      task.note ? h('span', { className: 'bt-goal-task-note' }, task.note) : null),
    h('span', { className: 'bt-goal-chip', 'data-chip': task.status }, t(TASK_CHIP[task.status] ?? 'Not started')))
}

function GoalStage({ stage, open, working, onToggle }) {
  return h('div', { className: 'bt-goal-stage' },
    h('button', { type: 'button', className: 'bt-goal-sh', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-goal-sg', 'data-sg': stage.chip === 'checking' ? 'current' : stage.chip, 'aria-hidden': true }),
      h('span', { className: 'bt-goal-st' }, t('Stage {n} · {title}', { n: stage.n, title: stage.title })),
      h('span', { className: 'bt-goal-chip', 'data-chip': stage.chip }, t(STAGE_CHIP[stage.chip])),
      stage.reworks > 0 ? h('span', { className: 'bt-goal-chip', 'data-chip': 'rework' }, t('Sent back ×{n}', { n: stage.reworks })) : null),
    open ? h('div', { className: 'bt-goal-sbody' },
      stage.acceptance ? h('div', { className: 'bt-goal-line' }, h('span', { className: 'bt-goal-sub' }, t('Done when')), stage.acceptance) : null,
      stage.evidence !== undefined && stage.status === 'passed'
        ? h('div', { className: 'bt-goal-evi' }, stage.evidence) : null,
      stage.feedback ? h('div', { className: 'bt-goal-line' }, h('span', { className: 'bt-goal-sub' }, t('Sent back ×{n}', { n: stage.reworks })), stage.feedback) : null,
      stage.tasks.map((task, i) => h(TaskRow, { key: i, task, working }))) : null)
}

const STOP_ARM_MS = 3000

// The open pod: the whole plan — objective, checks, rules, stages with their
// tasks — plus the controls the bar hides.
function GoalPanel({ goal, view, room, roster, actions, working }) {
  const [expanded, setExpanded] = useState(goal.current)
  const [armed, setArmed] = useState(false)
  // The open stage follows the goal's current one as stages pass.
  useEffect(() => setExpanded(goal.current), [goal.current])
  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), STOP_ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])
  const control = action => void Promise.resolve(actions.goalControl(room.id, goal.id, action))
    .catch(error => actions.reportError(error, 'goal'))
  const admin = roster.byId?.[room.admin]?.name ?? t('a Bot')
  const live = view.status === 'active' || view.status === 'paused'
  const statusChip = view.status === 'drafting' ? t('Drafting')
    : view.status === 'paused' ? t('Paused')
      : view.status === 'complete' ? t('Goal reached')
        : view.status === 'stopped' ? t('Stopped')
          : view.idle ? t('Waiting for you') : t('Active')
  const sec = (key, label, ...body) => h('div', { key, className: 'bt-goal-sec' },
    h('div', { className: 'bt-goal-sub' }, label), ...body.map((line, i) => h('div', { key: i, className: 'bt-goal-text' }, line)))
  return h('div', { className: 'bt-goal-panel', role: 'region', 'aria-label': view.title },
    h('div', { className: 'bt-goal-head' },
      h('div', { className: 'bt-goal-title' }, view.title),
      h('span', { className: 'bt-goal-chip', 'data-chip': view.status }, statusChip),
      h('div', { className: 'bt-goal-acts' },
        view.status === 'active' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('pause') }, t('Pause')) : null,
        view.status === 'paused' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('resume') }, t('Resume')) : null,
        live ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm bt-goal-danger', 'data-armed': armed || undefined,
          onClick: () => (armed ? control('stop') : setArmed(true)),
        }, armed ? t('Stop the goal?') : t('Stop')) : null,
        view.status === 'complete' || view.status === 'stopped'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('clear') }, t('Clear')) : null,
        view.status === 'drafting'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('clear') }, t('Cancel')) : null)),
    h('div', { className: 'bt-goal-body' },
      view.status === 'drafting' ? h('div', { key: 'draft', className: 'bt-goal-sec' },
        h('div', { className: 'bt-goal-text' }, t('{admin} is aligning the goal with you in the chat.', { admin })),
        goal.brief ? h('div', { className: 'bt-goal-text' }, goal.brief) : null) : null,
      goal.objective ? sec('objective', t('Objective'), goal.objective) : null,
      goal.acceptance ? sec('acceptance', t('Done when'), goal.acceptance) : null,
      goal.constraints?.length > 0 ? sec('rules', t('Rules'), h('ul', { className: 'bt-goal-rules' },
        goal.constraints.map((rule, i) => h('li', { key: i }, rule)))) : null,
      view.stages.length > 0 ? h('div', { key: 'stages', className: 'bt-goal-stages' },
        view.stages.map((stage, i) => h(GoalStage, {
          key: stage.n, stage, open: expanded === i, working,
          onToggle: () => setExpanded(expanded === i ? -1 : i),
        }))) : null,
      view.status === 'paused' ? h('div', { key: 'paused', className: 'bt-goal-sec' },
        h('div', { className: 'bt-goal-text' }, t('Paused. Write in the group to correct the direction; the admin updates the goal.')),
        working.size > 0 ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          onClick: () => void Promise.resolve(actions.stopRoomWork(room.id)).catch(error => actions.reportError(error, 'stop')),
        }, t('Stop current work too')) : null) : null,
      view.idle === true && view.status === 'active' ? h('div', { key: 'idle', className: 'bt-goal-text' }, t('{admin} is waiting for you.', { admin })) : null,
      view.status === 'complete' ? h(Fragment, { key: 'done' },
        goal.summary ? sec('summary', t('Summary'), goal.summary) : null,
        goal.evidence ? sec('evidence', t('Evidence'), goal.evidence) : null) : null,
      view.status === 'stopped' && goal.reason ? h('div', { key: 'reason', className: 'bt-goal-text' }, goal.reason) : null))
}

// The pod while the user writes the brief: the message goes to the admin, who
// aligns the goal in the chat before starting it.
function GoalCompose({ room, roster, actions }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const admin = roster.byId?.[room.admin]?.name ?? t('a Bot')
  const close = () => { actions.closeGoalCompose(); actions.closeGoal() }
  const submit = () => {
    const brief = text.trim()
    if (brief === '' || sending) return
    setSending(true)
    void Promise.resolve(actions.goalDraft(room.id, brief)).then(
      () => { actions.closeGoalCompose(); actions.closeGoal() },
      (error) => { actions.reportError(error, 'goal'); setSending(false) },
    )
  }
  return h('div', { className: 'bt-goal-compose' },
    h('label', { className: 'bt-goal-clabel', htmlFor: 'bt-goal-brief' }, t('What should this group achieve?')),
    h('textarea', {
      id: 'bt-goal-brief', className: 'bt-input bt-input-area bt-goal-input', rows: 2, value: text,
      onChange: (event) => {
        setText(event.target.value)
        const box = event.currentTarget
        box.style.height = 'auto'
        box.style.height = `${box.scrollHeight}px`
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
        if (event.key === 'Escape') { event.stopPropagation(); close() }
      },
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus: true,
    }),
    h('div', { className: 'bt-goal-chint' }, t('{admin} asks what is still open, then writes the goal with its checks and stages.', { admin })),
    h('div', { className: 'bt-goal-cbtns' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: text.trim() === '' || sending, onClick: submit }, t('Start'))))
}

// The surface that wraps the pill: pod with the bar (or the draft form) while
// closed, the panel while open. The pod hangs off the header over the transcript.
export function GoalIsland({ room, goal, view, open, composing, roomWork, roster, actions, pill }) {
  const island = useRef(null)
  useMorph(island, open)
  const working = new Set((roomWork ?? []).map(entry => entry.botId))
  // While the draft form is up, Escape and outside clicks cancel it like Cancel.
  const close = composing ? () => { actions.closeGoalCompose(); actions.closeGoal() } : () => actions.closeGoal()
  return h('div', {
    ref: island, className: 'bt-island',
    'data-goal': view?.status ?? (composing ? 'compose' : undefined),
    'data-idle': view?.idle || undefined, 'data-open': open || undefined,
  },
  open || composing ? h(GoalOutside, { island, close }) : null,
  pill,
  h('div', { className: 'bt-goal-pod' },
    composing ? h(GoalCompose, { room, roster, actions })
      : view === null ? null
        : h(Fragment, null,
          h(GoalBar, { view, open, room, actions }),
          open ? h(GoalPanel, { goal, view, room, roster, actions, working }) : null)))
}

export const GOAL_CSS = `
/* One surface: the pill's own background, border and shadow. The pill row is
   40px, the pod bar 30px; the surface reshapes on SPRING_SHAPE. */
.bt-island{position:relative;z-index:6;align-self:flex-start;display:flex;flex-direction:column;pointer-events:auto;width:min(380px,calc(100% - 120px));background:var(--bt-main);border:.5px solid var(--bt-line-2);border-radius:20px;box-shadow:var(--bt-float);color:var(--bt-ink);font-family:inherit;font-size:14px;line-height:20px;box-sizing:border-box;transition:${spring(SPRING_SHAPE, 'width', 'border-radius')}}
.bt-island[data-open]{width:min(560px,calc(100% - 48px));border-radius:18px}
.bt-island[data-morph]{overflow:hidden}
.bt-island .bt-pill{width:100%;max-width:none;background:none;border:0;box-shadow:none;border-radius:20px 20px 0 0}
.bt-island[data-open] .bt-pill{border-radius:18px 18px 0 0}
.bt-island .bt-pill:hover{background:var(--bt-hover)}
.bt-island .bt-pill:active{transform:none}
/* The swap area holds the goal title and the group name in one cell, so hover
   only swaps the text and never resizes the pill. */
.bt-pill-swap{flex:1 1 auto;min-width:0;display:grid;justify-items:start;text-align:left}
.bt-pill-swap>*{grid-area:1/1;min-width:0;transition:opacity .18s ease,filter .18s ease}
.bt-pill-goal{display:flex;align-items:center;gap:6px;min-width:0}
.bt-pill-swap>.bt-pill-name{opacity:0;filter:blur(4px)}
.bt-pill:hover .bt-pill-swap>.bt-pill-goal,.bt-pill:focus-visible .bt-pill-swap>.bt-pill-goal,.bt-pill[aria-expanded=true] .bt-pill-swap>.bt-pill-goal{opacity:0;filter:blur(4px)}
.bt-pill:hover .bt-pill-swap>.bt-pill-name,.bt-pill:focus-visible .bt-pill-swap>.bt-pill-name,.bt-pill[aria-expanded=true] .bt-pill-swap>.bt-pill-name{opacity:1;filter:none}
.bt-pill-ico{flex:none;display:inline-flex;width:14px;height:14px;color:var(--bt-accent)}
.bt-pill-ico svg{width:14px;height:14px}
.bt-pill-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bt-pill-count{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-goal-pod{display:flex;flex-direction:column;min-width:0}
.bt-goal-pod::before{content:"";flex:none;height:.5px;margin:0 12px;background:var(--bt-line)}
.bt-goal-bar{display:flex;align-items:center;gap:8px;height:30px;padding:0 14px;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left;transition:background-color .12s ease}
.bt-goal-bar:hover{background:var(--bt-hover)}
.bt-island:not([data-open]) .bt-goal-bar{border-radius:0 0 20px 20px}
.bt-goal-dot{flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--bt-green)}
.bt-island[data-goal=drafting] .bt-goal-dot{background:var(--bt-accent)}
.bt-island[data-goal=paused] .bt-goal-dot,.bt-island[data-idle] .bt-goal-dot{background:var(--bt-star)}
.bt-island[data-goal=stopped] .bt-goal-dot{background:var(--bt-ink-3)}
.bt-goal-check{flex:none;display:inline-flex;width:14px;height:14px;color:var(--bt-green)}
.bt-goal-check svg{width:14px;height:14px}
.bt-goal-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The track shrinks so 20 stages still fit the bar: each segment is 14px and
   gives up to 3px, the current one 20px. */
.bt-goal-segs{display:inline-flex;align-items:center;gap:3px;flex:0 1 auto;min-width:0}
.bt-goal-segs i{display:block;flex:0 1 auto;width:14px;min-width:3px;height:4px;border-radius:999px;background:var(--bt-line-2);transition:${spring(SPRING_SHAPE, 'width')},background-color .12s ease}
.bt-goal-segs i[data-seg=done]{background:var(--bt-green)}
.bt-goal-segs i[data-seg=current]{width:20px;background:var(--bt-accent)}
.bt-goal-segs i[data-seg=checking]{width:20px;background:color-mix(in srgb,var(--bt-accent) 60%,transparent)}
.bt-goal-segs i[data-seg=paused]{width:20px;background:var(--bt-star)}
.bt-goal-faces{display:inline-flex;align-items:center;flex:none;margin-left:auto}
.bt-goal-face{display:inline-flex;flex:none;border-radius:50%;background:var(--bt-main);box-shadow:0 0 0 2px var(--bt-main)}
.bt-goal-face+.bt-goal-face{margin-left:-6px}
.bt-goal-more{font-size:11px;line-height:16px;color:var(--bt-ink-3);margin-left:3px}
.bt-goal-chev{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-goal-chev svg{width:14px;height:14px;transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-goal-bar[aria-expanded=true] .bt-goal-chev svg{transform:rotate(180deg)}
.bt-goal-panel{display:flex;flex-direction:column;max-height:min(62vh,520px);overflow-y:auto;overflow-x:hidden;border-radius:0 0 18px 18px;animation:bt-veil-in .22s ease-out backwards}
.bt-goal-head{display:flex;align-items:flex-start;gap:8px;padding:12px 14px 0}
.bt-goal-title{flex:0 1 auto;min-width:0;font-size:15px;line-height:20px;font-weight:600;overflow-wrap:anywhere}
.bt-goal-acts{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.bt-goal-acts .bt-icon-btn{margin:-4px -6px -4px 0}
.bt-goal-body{display:flex;flex-direction:column;gap:10px;padding:10px 14px 14px;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-goal-sec{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-goal-sub{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-goal-text{overflow-wrap:anywhere}
.bt-goal-rules{margin:0;padding-left:18px}
.bt-goal-line{display:flex;gap:6px;min-width:0;overflow-wrap:anywhere}
.bt-goal-line .bt-goal-sub{flex:none}
.bt-goal-evi{font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-goal-stages{display:flex;flex-direction:column;gap:6px}
.bt-goal-stage{border:1px solid var(--bt-line);border-radius:10px;overflow:hidden}
.bt-goal-sh{display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;cursor:pointer;text-align:left;transition:background-color .12s ease}
.bt-goal-sh:hover{background:var(--bt-hover)}
.bt-goal-sh[aria-expanded=true]{border-bottom:.5px solid var(--bt-line)}
.bt-goal-sg{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-3)}
.bt-goal-sg::before{content:"○";font-size:12px;line-height:1}
.bt-goal-sg[data-sg=passed]::before{content:"✓";color:var(--bt-green)}
.bt-goal-sg[data-sg=current]::before{content:"●";color:var(--bt-accent);font-size:9px}
.bt-goal-st{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-goal-chip{flex:none;max-width:120px;font-size:11px;line-height:15px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-goal-chip[data-chip=current],.bt-goal-chip[data-chip=checking]{background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent)}
.bt-goal-chip[data-chip=passed],.bt-goal-chip[data-chip=done]{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:var(--bt-green)}
.bt-goal-chip[data-chip=rework]{background:color-mix(in srgb,var(--bt-star) 14%,transparent);color:var(--bt-ink-2)}
.bt-goal-sbody{display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px}
.bt-goal-task{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-goal-task .bt-mark{margin-top:1px}
.bt-goal-task-body{flex:0 1 auto;min-width:0;display:flex;flex-direction:column}
.bt-goal-task-line{display:flex;min-width:0}
.bt-goal-task-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-goal-task-text{overflow-wrap:anywhere}
.bt-goal-task-note{font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-goal-task>.bt-goal-chip{margin-left:auto}
.bt-goal-danger{color:var(--bt-danger)}
.bt-goal-danger[data-armed]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
.bt-goal-compose{display:flex;flex-direction:column;gap:8px;padding:12px 14px}
.bt-goal-clabel{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-goal-input{min-height:52px;max-height:124px;resize:none;font-size:13px}
.bt-goal-chint{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-goal-cbtns{display:flex;justify-content:flex-end;gap:6px}
.bt-event .bt-event-ico{display:inline-flex;width:14px;height:14px;color:var(--bt-accent)}
@media (prefers-reduced-motion:reduce){.bt-island,.bt-pill-swap>*,.bt-goal-segs i,.bt-goal-chev svg{transition:none!important}.bt-goal-panel{animation:none}}
`
