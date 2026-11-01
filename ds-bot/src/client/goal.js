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

// What the island and panel draw, as plain data: goal + live room work in, the
// capsule number, the bar's label, the stage segments, the faces and the
// panel's stage rows out.
export function goalView(goal, { roster = {}, roomWork = [] } = {}) {
  if (goal === null || goal === undefined) return null
  const stages = goal.stages ?? []
  const count = stages.length
  const at = goal.current
  const current = RUNNING.has(goal.status) ? stages[at] : undefined
  const checking = current !== undefined && (current.tasks ?? []).every(task => REPORTED.has(task.status))
  // The capsule counts the stage the goal is at, not the stages done.
  const number = goal.status === 'drafting' ? undefined
    : goal.status === 'stopped' ? stages.filter(stage => stage.status === 'passed').length
      : current !== undefined ? at + 1
        : count
  const barLabel =
    goal.status === 'drafting' ? t('Aligning the goal with you')
      : goal.status === 'stopped' ? t('Stopped')
        : goal.status === 'complete' ? t('Goal reached')
          : goal.status === 'paused' ? (current ? t('Paused · {title}', { title: current.title }) : t('Paused'))
            : goal.idle === true ? (current ? t('Waiting for you · {title}', { title: current.title }) : t('Waiting for you'))
              : current === undefined ? t('Final check')
                : checking ? t('Checking · {title}', { title: current.title })
                  : current.title
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
    kind: stage.status === 'passed' ? 'passed'
      : i === at && RUNNING.has(goal.status) ? 'current'
        : 'upcoming',
    tasks: (stage.tasks ?? []).map(task => ({ bot: roster.byId?.[task.botId], task: task.task, status: task.status })),
    evidence: stage.evidence,
    reworks: stage.reworks ?? 0,
    feedback: stage.feedback,
  }))
  return {
    status: goal.status, idle: goal.idle === true, title: goal.title ?? '',
    number, count, segments, barLabel, faces, stages: stageViews,
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

// One task in the selected stage: avatar carries the state (pulse while it
// works, a small check once reported or done, dimmed before it starts).
function TaskRow({ task, working }) {
  const live = working.has(task.bot?.id) || task.status === 'working'
  const returned = REPORTED.has(task.status)
  return h('div', { className: 'bt-goal-task', 'data-task': task.status === 'pending' ? 'pending' : undefined },
    h('span', { className: 'bt-goal-tav' },
      task.bot ? h(BotAvatar, { bot: task.bot, size: 20, state: live ? 'working' : 'idle' }) : null,
      returned ? h('span', { className: 'bt-goal-tdone', 'aria-hidden': true }, h(CheckIcon)) : null),
    h('span', { className: 'bt-goal-ttext' },
      h('span', { className: 'bt-goal-tname', style: task.bot ? { color: inkText(colorOf(task.bot)) } : undefined }, task.bot?.name ?? t('a Bot')),
      ' ', task.task))
}

const STOP_ARM_MS = 3000

// The open pod focuses one stage: a stepper across the top, the selected
// stage's checks and tasks under it, and a bottom row with the rest.
function GoalPanel({ goal, view, room, roster, actions, working }) {
  const at = RUNNING.has(view.status) && goal.current < view.stages.length ? goal.current : -1
  const [selected, setSelected] = useState(at)
  const [checks, setChecks] = useState(false)
  const [armed, setArmed] = useState(false)
  // The selected stage follows the goal's current one as stages pass.
  useEffect(() => setSelected(RUNNING.has(view.status) && goal.current < view.stages.length ? goal.current : -1), [view.status, goal.current])
  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), STOP_ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])
  // Nodes under 14px drop their number so the stepper still fits.
  const stepper = useRef(null)
  useEffect(() => {
    const box = stepper.current
    if (box === null || typeof ResizeObserver !== 'function') return undefined
    const measure = () => box.querySelectorAll('.bt-goal-step').forEach(node => node.classList.toggle('bt-goal-mini', node.clientWidth < 14))
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    measure()
    return () => observer.disconnect()
  }, [view.stages.length])
  const control = action => void Promise.resolve(actions.goalControl(room.id, goal.id, action))
    .catch(error => actions.reportError(error, 'goal'))
  const stage = selected >= 0 ? view.stages[selected] : undefined
  const sec = (key, label, ...body) => h('div', { key, className: 'bt-goal-sec' },
    h('div', { className: 'bt-goal-sub' }, label), ...body.map((line, i) => h('div', { key: i, className: 'bt-goal-text' }, line)))
  const hasChecks = goal.objective !== undefined || goal.acceptance !== undefined || goal.constraints?.length > 0
  const admin = roster.byId?.[room.admin]?.name ?? t('a Bot')
  const stopWork = () => void Promise.resolve(actions.stopRoomWork(room.id)).catch(error => actions.reportError(error, 'stop'))
  return h('div', { className: 'bt-goal-panel', role: 'region', 'aria-label': view.title },
    h('div', { className: 'bt-goal-body' },
    view.status === 'drafting' ? null : h('div', { ref: stepper, className: 'bt-goal-steps', role: 'group', 'aria-label': t('Stages') },
      view.stages.map((stageView, i) => h('button', {
        key: stageView.n, type: 'button',
        className: 'bt-goal-step', 'data-step': stageView.kind === 'current' && (view.status === 'paused' || view.idle === true) ? 'waiting' : stageView.kind,
        'data-sel': i === selected || undefined,
        title: t('Stage {n}: {title}', { n: stageView.n, title: stageView.title }),
        'aria-label': t('Stage {n}: {title}', { n: stageView.n, title: stageView.title }),
        'aria-current': i === at ? 'step' : undefined,
        onClick: () => setSelected(i),
      }, h('span', { className: 'bt-goal-node' }, stageView.status === 'passed' ? h(CheckIcon) : stageView.n)))),
    h('div', { key: `s${selected}`, className: 'bt-goal-bstage' },
      view.status === 'drafting' ? (goal.brief ? h('div', { className: 'bt-goal-btext' }, goal.brief) : null)
        : stage === undefined
          ? h(Fragment, null,
            goal.summary ? h('div', { className: 'bt-goal-btext' }, goal.summary) : null,
            goal.evidence ? h('div', { className: 'bt-goal-evi' }, goal.evidence) : null,
            view.status === 'stopped' && goal.reason ? h('div', { className: 'bt-goal-evi' }, goal.reason) : null)
          : h(Fragment, null,
            h('div', { className: 'bt-goal-bline' },
              h('span', { className: 'bt-goal-btitle' }, stage.title),
              selected !== at && at >= 0 ? h('button', { type: 'button', className: 'bt-goal-back', onClick: () => setSelected(at) }, t('Back to current stage')) : null),
            stage.acceptance ? h('div', { className: 'bt-goal-line' }, t('Done when: {text}', { text: stage.acceptance })) : null,
            selected === at && stage.reworks > 0 && stage.feedback
              ? h('div', { className: 'bt-goal-rw' }, stage.reworks > 1
                ? t('Sent back {n} times by {admin}. Last time: {feedback}', { n: stage.reworks, admin, feedback: stage.feedback })
                : t('Sent back by {admin}: {feedback}', { admin, feedback: stage.feedback })) : null,
            stage.evidence !== undefined && stage.status === 'passed' ? h('div', { className: 'bt-goal-evi' }, t('Evidence: {text}', { text: stage.evidence })) : null,
            stage.tasks.length > 0 ? h('div', { className: 'bt-goal-tasks' }, stage.tasks.map((task, i) => h(TaskRow, { key: i, task, working }))) : null)),
    checks && hasChecks ? h('div', { className: 'bt-goal-ckbody' },
      goal.objective ? sec('objective', t('Objective'), goal.objective) : null,
      goal.acceptance ? sec('acceptance', t('Done when'), goal.acceptance) : null,
      goal.constraints?.length > 0 ? sec('rules', t('Rules'), h('ul', { className: 'bt-goal-rules' },
        goal.constraints.map((rule, i) => h('li', { key: i }, rule)))) : null) : null),
    h('div', { className: 'bt-goal-foot' },
      hasChecks ? h('button', {
        type: 'button', className: 'bt-goal-checks', 'aria-expanded': checks, onClick: () => setChecks(!checks),
      }, h('span', { className: 'bt-goal-mchev', 'aria-hidden': true }, h(ChevronDownIcon)), t('Goal and checks')) : h('span'),
      h('span', { className: 'bt-goal-facts' },
        view.status === 'paused' && working.size > 0 ? h('button', { type: 'button', className: 'bt-goal-back', onClick: stopWork }, t('Stop current work too')) : null,
        view.status === 'active' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('pause') }, t('Pause')) : null,
        view.status === 'paused' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('resume') }, t('Resume')) : null,
        view.status === 'active' || view.status === 'paused' ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm bt-goal-danger', 'data-armed': armed || undefined,
          onClick: () => (armed ? control('stop') : setArmed(true)),
        }, armed ? t('Stop the goal?') : t('Stop')) : null,
        view.status === 'complete' || view.status === 'stopped'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('clear') }, t('Clear')) : null,
        view.status === 'drafting'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => control('clear') }, t('Cancel')) : null)))
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
/* The bar's extras hand off to the open panel and give their room to the label. */
.bt-island[data-open] .bt-goal-segs,.bt-island[data-open] .bt-goal-faces{display:none}
.bt-island[data-open] .bt-goal-chev{margin-left:auto}
.bt-goal-panel{display:flex;flex-direction:column;max-height:min(62vh,520px);overflow:hidden;border-radius:0 0 18px 18px;animation:bt-veil-in .22s ease-out backwards}
.bt-goal-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}
/* The stepper: one shrinking node per stage on a hairline. */
.bt-goal-steps{display:flex;align-items:center;gap:6px;padding:10px 14px 0}
.bt-goal-step{position:relative;flex:0 1 20px;min-width:8px;height:20px;display:flex;align-items:center;justify-content:center;border:0;background:none;cursor:pointer;padding:0}
.bt-goal-step::before{content:"";position:absolute;left:-3px;right:-3px;top:50%;height:1px;background:var(--bt-line-2)}
.bt-goal-step:first-child::before{left:50%}
.bt-goal-step:last-child::before{right:50%}
.bt-goal-node{position:relative;z-index:1;box-sizing:border-box;width:min(20px,100%);aspect-ratio:1;border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--bt-main);border:1.5px solid var(--bt-line-2);color:var(--bt-ink-3);font-size:10px;line-height:1;font-variant-numeric:tabular-nums}
.bt-goal-node>svg{width:12px;height:12px}
.bt-goal-step[data-step=passed]>.bt-goal-node{background:var(--bt-green);border-color:var(--bt-green);color:var(--bt-main)}
.bt-goal-step[data-step=current]>.bt-goal-node{border-color:var(--bt-accent);color:var(--bt-accent);font-weight:600}
.bt-goal-step[data-step=waiting]>.bt-goal-node{border-color:var(--bt-star);color:var(--bt-star);font-weight:600}
.bt-goal-step[data-sel]:not([aria-current])>.bt-goal-node{box-shadow:0 0 0 1.5px var(--bt-ink)}
.bt-goal-step.bt-goal-mini .bt-goal-node{font-size:0}
/* The selected stage below the stepper. */
.bt-goal-bstage{display:flex;flex-direction:column;padding:4px 14px 14px;font-size:13px;line-height:18px;animation:bt-veil-in .22s ease-out backwards}
.bt-goal-bline{display:flex;align-items:baseline;gap:8px}
.bt-goal-btitle{flex:1 1 auto;font-weight:600}
.bt-goal-back{flex:none;border:0;background:none;padding:0;font:inherit;font-size:12px;line-height:16px;color:var(--bt-accent);cursor:pointer}
.bt-goal-btext{overflow-wrap:anywhere}
.bt-goal-line{margin-top:2px;min-width:0;font-size:12px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-goal-sec{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-goal-sub{flex:none;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-goal-rw{margin-top:8px;border-radius:8px;padding:6px 10px;background:color-mix(in srgb,var(--bt-star) 10%,transparent);font-size:12px;line-height:18px;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-goal-text{overflow-wrap:anywhere}
.bt-goal-rules{margin:0;padding-left:18px}
.bt-goal-evi{margin-top:8px;font-size:12px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-goal-tasks{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.bt-goal-task{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-goal-task[data-task=pending]{opacity:.55}
.bt-goal-tav{position:relative;flex:none;display:inline-flex;margin-top:1px}
.bt-goal-tdone{position:absolute;right:-2px;bottom:-2px;width:12px;height:12px;border-radius:50%;background:var(--bt-green);color:var(--bt-main);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px var(--bt-main)}
.bt-goal-tdone svg{width:9px;height:9px}
.bt-goal-ttext{flex:0 1 auto;min-width:0;overflow-wrap:anywhere}
.bt-goal-tname{font-weight:500}
.bt-goal-ckbody{display:flex;flex-direction:column;gap:10px;padding:0 14px 10px;font-size:13px;line-height:18px;text-align:left}
/* The bottom row: disclosure on the left, controls on the right. */
.bt-goal-foot{display:flex;align-items:center;gap:8px;height:40px;flex:none;padding:0 8px 0 14px;border-top:.5px solid var(--bt-line)}
.bt-goal-checks{display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:4px 6px;margin-left:-6px;border-radius:6px;font:inherit;font-size:12px;line-height:16px;color:var(--bt-ink-2);cursor:pointer}
.bt-goal-checks:hover{background:var(--bt-hover)}
.bt-goal-mchev{display:inline-flex;width:14px;height:14px;color:var(--bt-ink-3)}
.bt-goal-mchev svg{width:14px;height:14px;transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-goal-checks[aria-expanded=true] .bt-goal-mchev svg{transform:rotate(180deg)}
.bt-goal-facts{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
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
