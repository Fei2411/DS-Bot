// The group task board in the group's details panel: what each member is working on,
// the latest line of progress, and the history of finished and cancelled work. The
// tasks are registered by the Bots themselves with the group_task tool; the panel only
// reads them and lets the user add a note, which the host posts into the group as the
// user's message that calls the task's owner.
//
// The board is split by what the row asks of the user: work that runs, work that waits
// for them, and history. A row carries its state on a leading icon and one line of
// text, not in a small coloured chip, so the state reads without relying on colour.
import { createElement as h, useEffect, useState } from 'react'
import { clockLabel } from './text.js'
import { t } from './i18n.js'

const OPEN = ['active', 'review', 'blocked']
const ATTENTION = ['review', 'blocked']
const HISTORY_PREVIEW = 5
const SENT_LINGER_MS = 2000

const lineIcon = paths => h('svg', {
  width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, paths.map((d, i) => h('path', { key: i, d })))
const CIRCLE = 'M10 3.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5z'
// A quarter of the ring is open, so it reads as turning rather than as a circle.
const SpinnerIcon = () => h('svg', {
  className: 'bt-task-spin', width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
}, h('path', { d: 'M10 3.25a6.75 6.75 0 1 0 6.75 6.75' }))
const AlertCircleIcon = lineIcon([CIRCLE, 'M10 6.6v4', 'M10 13.4h.01'])
const StopIcon = lineIcon(['M6.2 5.4h7.6a.8.8 0 0 1 .8.8v7.6a.8.8 0 0 1-.8.8H6.2a.8.8 0 0 1-.8-.8V6.2a.8.8 0 0 1 .8-.8z'])
const CheckCircleIcon = lineIcon([CIRCLE, 'M6.9 10.2l2.2 2.2 4.1-4.6'])
const SlashCircleIcon = lineIcon([CIRCLE, 'M6.5 13.5l7-7'])
const ICONS = { active: SpinnerIcon, review: AlertCircleIcon, blocked: StopIcon, done: CheckCircleIcon, cancelled: SlashCircleIcon }

// A block DS Bot set from how the member's work ended, not one the Bot reported.
const blockedLine = blocked => blocked.cause === 'stopped' ? t('Stopped by the user')
  : blocked.cause === 'restarted' ? t('Not updated after a restart')
  : t('Its model call failed ({code})', { code: `${blocked.code}${blocked.status ? ` ${blocked.status}` : ''}` })

const subtitleOf = (task, bot) => {
  const who = bot?.name === undefined ? '' : `${bot.name} · `
  if (task.status === 'active') return who + (task.progress ? task.progress : t('In progress'))
  if (task.status === 'review') return who + t('Awaiting review')
  if (task.status === 'blocked') return who + t('Blocked') + (task.blocked === undefined ? '' : ` · ${blockedLine(task.blocked)}`)
  if (task.status === 'done') return who + t('Done') + ` · ${clockLabel(task.updatedAt ?? task.startedAt)}`
  return who + t('Cancelled')
}

function TaskRow({ task, bot, room, actions }) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  useEffect(() => {
    if (!sent) return undefined
    const timer = setTimeout(() => setSent(false), SENT_LINGER_MS)
    return () => clearTimeout(timer)
  }, [sent])
  const open = OPEN.includes(task.status)
  const notes = task.notes ?? []
  const lastNote = notes[notes.length - 1]
  const failed = (error) => { setBusy(false); actions.reportError?.(error, 'task') }
  const send = () => {
    const line = text.trim()
    if (line === '' || busy) return
    setBusy(true)
    Promise.resolve(actions.taskNote(room.id, task.id, line)).then(
      () => { setText(''); setWriting(false); setBusy(false) },
      failed,
    )
  }
  const cancel = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    setBusy(true)
    Promise.resolve(actions.taskCancel(room.id, task.id)).then(() => setBusy(false), failed)
  }
  // Ask the owner to pick the work up again: the host posts it as the user's message
  // that calls the member, so the task keeps its real state until the member moves it.
  const resume = () => {
    if (busy || sent) return
    setBusy(true)
    Promise.resolve(actions.taskNote(room.id, task.id, t('Continue'))).then(
      () => { setSent(true); setBusy(false) },
      failed,
    )
  }
  const Icon = ICONS[task.status] ?? SpinnerIcon
  return h('div', { className: 'bt-task', 'data-status': task.status, 'data-busy': busy || undefined },
    h('div', { className: 'bt-task-row' },
      h('span', { className: 'bt-task-icon' }, h(Icon)),
      h('div', { className: 'bt-task-body' },
        h('div', { className: 'bt-task-title' }, task.goal),
        h('div', { className: 'bt-task-sub' }, subtitleOf(task, bot)),
        !open && task.result ? h('div', { className: 'bt-task-result' }, task.result) : null,
        !open && task.reason ? h('div', { className: 'bt-task-reason' }, task.reason) : null,
        lastNote ? h('div', { className: 'bt-task-note' }, t('Note: {text}', { text: lastNote.text })) : null),
      task.status === 'blocked' && sent === false
        ? h('button', {
          type: 'button', className: 'bt-task-continue', disabled: busy,
          'aria-label': t('Let it continue: {task}', { task: task.goal }), onClick: resume,
        }, t('Continue'))
        : sent ? h('span', { className: 'bt-task-continue', 'data-sent': '', role: 'status' }, t('Sent')) : null),
    open ? h('div', { className: 'bt-task-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'aria-expanded': writing, onClick: () => setWriting(value => !value) }, t('Add a note')),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', 'data-confirm': confirming || undefined, disabled: busy,
        'aria-label': confirming ? t('Click again to cancel') : t('Cancel task'), onClick: cancel,
      }, confirming ? t('Cancel task') : t('Cancel'))) : null,
    writing ? h('div', { className: 'bt-task-write' },
      h('input', {
        className: 'bt-input bt-task-input', value: text, placeholder: t('What should change?'), 'aria-label': t('What should change?'),
        onChange: event => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); send() }
          if (event.key === 'Escape') { event.stopPropagation(); setWriting(false) }
        },
      }),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: text.trim() === '' || busy, onClick: send }, t('Send'))) : null)
}

// One section: its heading with a count, then its rows or the line that says it is empty.
const section = (title, count, empty, rows) => h('div', { className: 'bt-task-section' },
  h('div', { className: 'bt-tasks-head' },
    h('div', { className: 'bt-section-title' }, title),
    count > 0 ? h('span', { className: 'bt-tasks-count' }, count) : null),
  count === 0 ? h('div', { className: 'bt-muted bt-tasks-empty' }, empty) : rows)

export function TaskBoard({ room, roster, actions }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const all = Object.values(room.tasks ?? {}).sort((a, b) => a.startedAt - b.startedAt)
  const running = all.filter(task => task.status === 'active')
  const waiting = all.filter(task => ATTENTION.includes(task.status))
  const past = all.filter(task => !OPEN.includes(task.status)).reverse()
  const shown = historyOpen ? past : past.slice(0, HISTORY_PREVIEW)
  const row = task => h(TaskRow, { key: task.id, task, bot: roster.byId?.[task.botId], room, actions })
  return h('div', { className: 'bt-tasks' },
    h('div', { className: 'bt-section-title bt-tasks-title' }, t('Tasks')),
    section(t('In progress'), running.length, t('No task is running in this group.'),
      h('div', { className: 'bt-task-list' }, running.map(row))),
    section(t('Needs you'), waiting.length, t('Nothing waits for you.'),
      h('div', { className: 'bt-task-list' }, waiting.map(row))),
    past.length === 0 ? null : section(t('History'), past.length, '',
      h('div', { className: 'bt-task-list bt-task-history' }, shown.map(row),
        past.length > HISTORY_PREVIEW
          ? h('button', { type: 'button', className: 'bt-more', 'aria-expanded': historyOpen, onClick: () => setHistoryOpen(value => !value) },
            historyOpen ? t('Show less') : t('Show all ({count})', { count: past.length }))
          : null)))
}

export const TASK_CSS = `
.bt-tasks{margin-top:16px}
.bt-tasks-title{margin:0 0 8px}
.bt-task-section+.bt-task-section{margin-top:20px}
.bt-tasks-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.bt-tasks-head>.bt-section-title{margin:0}
.bt-tasks-count{padding:0 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:12px;line-height:18px;font-weight:500;font-variant-numeric:tabular-nums}
.bt-tasks-empty{padding:0 8px;font-size:12px;line-height:17px}
.bt-task-list{display:flex;flex-direction:column;gap:2px;margin:0 -12px}
.bt-task{padding:12px;border-radius:12px;transition:background-color .12s ease}
.bt-task:hover{background:var(--bt-hover)}
.bt-task[data-busy]{opacity:.6}
.bt-task-row{display:flex;align-items:flex-start;gap:10px;min-height:32px}
.bt-task-icon{flex:none;display:flex;margin-top:2px;color:var(--bt-ink-2)}
.bt-task[data-status=active] .bt-task-icon{color:var(--bt-accent)}
.bt-task[data-status=review] .bt-task-icon{color:var(--bt-warn)}
.bt-task[data-status=blocked] .bt-task-icon{color:var(--bt-danger)}
.bt-task[data-status=done] .bt-task-icon{color:var(--bt-green-ink)}
.bt-task[data-status=cancelled] .bt-task-icon{color:var(--bt-ink-3)}
.bt-task-spin{animation:bt-task-turn 1.6s linear infinite}
@keyframes bt-task-turn{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bt-task-spin{animation:none}}
.bt-task-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-task-title{font-size:14px;line-height:20px;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task-sub{font-size:12px;line-height:17px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task[data-status=blocked] .bt-task-sub{-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;white-space:normal}
.bt-task-result{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2);white-space:pre-wrap}
.bt-task-reason{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-task-note{margin-top:4px;padding-left:6px;border-left:2px solid var(--bt-line-2);font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-task-continue{flex:none;align-self:center;height:28px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .12s ease}
.bt-task-continue:hover:not(:disabled){background:var(--bt-active)}
.bt-task-continue:disabled{opacity:.35;cursor:default}
.bt-task-continue[data-sent]{display:inline-flex;align-items:center;opacity:.6;cursor:default}
.bt-task-continue:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-task-actions{display:flex;gap:6px;margin-top:8px;padding-left:28px}
.bt-task-actions>.bt-soft-sm{margin:0}
.bt-task-actions>.bt-soft-sm[data-confirm]{color:var(--bt-danger)}
.bt-task-write{display:flex;align-items:center;gap:6px;margin-top:8px;padding-left:28px}
.bt-task-input{flex:1;min-width:0;height:28px;font-size:13px}
.bt-task-write>.bt-send{flex:none;margin:0}
.bt-task-history .bt-task{opacity:.85}
@media(max-width:640px){
  .bt-task-continue{padding:0 8px;max-width:88px}
  .bt-task-title{-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;white-space:normal}
}
@media(max-width:480px){
  .bt-task-row{flex-wrap:wrap}
  .bt-task-continue{order:3;margin-left:auto;margin-top:8px;align-self:flex-end}
}
`
