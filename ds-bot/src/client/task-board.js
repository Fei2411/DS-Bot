// The group task board in the group's details panel: what each member is working on,
// the latest line of progress, and the history of finished and cancelled work. The
// tasks are registered by the Bots themselves with the group_task tool; the panel only
// reads them and lets the user add a note, which the host posts into the group as the
// user's message that calls the task's owner.
import { createElement as h, useEffect, useState } from 'react'
import { BotMark } from './mark.js'
import { clockLabel } from './text.js'
import { t } from './i18n.js'

const OPEN = ['active', 'review', 'blocked']
const STATUS_KEY = { active: 'In progress', review: 'Awaiting review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' }

function TaskRow({ task, bot, room, actions }) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
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
  return h('div', { className: 'bt-task', 'data-status': task.status, 'data-busy': busy || undefined },
    h('div', { className: 'bt-task-head' },
      bot ? h(BotMark, { bot, size: 22, state: open ? 'work' : 'idle' }) : null,
      h('span', { className: 'bt-task-name' }, bot?.name ?? t('a Bot')),
      h('span', { className: 'bt-task-status' }, t(STATUS_KEY[task.status] ?? task.status)),
      h('span', { className: 'bt-task-time' }, clockLabel(task.startedAt))),
    h('div', { className: 'bt-task-goal' }, task.goal),
    open && task.progress ? h('div', { className: 'bt-task-progress' }, task.progress) : null,
    !open && task.result ? h('div', { className: 'bt-task-result' }, task.result) : null,
    !open && task.reason ? h('div', { className: 'bt-task-reason' }, task.reason) : null,
    lastNote ? h('div', { className: 'bt-task-note' }, t('Note: {text}', { text: lastNote.text })) : null,
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

export function TaskBoard({ room, roster, actions }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const all = Object.values(room.tasks ?? {}).sort((a, b) => a.startedAt - b.startedAt)
  const open = all.filter(task => OPEN.includes(task.status))
  const past = all.filter(task => !OPEN.includes(task.status)).reverse()
  const row = task => h(TaskRow, { key: task.id, task, bot: roster.byId?.[task.botId], room, actions })
  return h('div', { className: 'bt-tasks' },
    h('div', { className: 'bt-tasks-head' },
      h('div', { className: 'bt-section-title' }, t('Tasks')),
      open.length > 0 ? h('span', { className: 'bt-tasks-count' }, open.length) : null),
    h('div', { className: 'bt-task-list' },
      open.length === 0 ? h('div', { className: 'bt-muted bt-tasks-empty' }, t('No task is running in this group.')) : open.map(row)),
    past.length > 0 ? h('button', { type: 'button', className: 'bt-more', 'aria-expanded': historyOpen, onClick: () => setHistoryOpen(value => !value) },
      historyOpen ? t('Hide history') : t('History ({count})', { count: past.length })) : null,
    historyOpen ? h('div', { className: 'bt-task-list bt-task-history' }, past.map(row)) : null)
}

export const TASK_CSS = `
.bt-tasks{margin-top:16px}
.bt-tasks-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.bt-tasks-head>.bt-section-title{margin:0}
.bt-tasks-count{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-tasks-empty{padding:4px 8px}
.bt-task-list{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-task{padding:8px;border-radius:12px;transition:background-color .12s ease}
.bt-task:hover{background:var(--bt-hover)}
.bt-task[data-busy]{opacity:.6}
.bt-task-head{display:flex;align-items:center;gap:6px;min-width:0}
.bt-task-head>.bt-mark{flex:none}
.bt-task-name{min-width:0;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task-status{flex:none;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-task[data-status=active] .bt-task-status{color:var(--bt-green)}
.bt-task[data-status=review] .bt-task-status{color:var(--bt-accent)}
.bt-task[data-status=blocked] .bt-task-status{color:var(--bt-danger)}
.bt-task-time{flex:none;margin-left:auto;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-task-goal{margin-top:2px;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-task-progress{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-task-result{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2);white-space:pre-wrap}
.bt-task-reason{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-task-note{margin-top:4px;padding-left:6px;border-left:2px solid var(--bt-line-2);font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-task-actions{display:flex;gap:6px;margin-top:6px}
.bt-task-actions>.bt-soft-sm{margin:0}
.bt-task-actions>.bt-soft-sm[data-confirm]{color:var(--bt-danger)}
.bt-task-write{display:flex;align-items:center;gap:6px;margin-top:6px}
.bt-task-input{flex:1;min-width:0;height:28px;font-size:13px}
.bt-task-write>.bt-send{flex:none;margin:0}
.bt-task-history .bt-task{opacity:.85}
`
