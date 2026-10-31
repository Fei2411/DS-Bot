import { createElement as h, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { hostText, t } from './i18n.js'
import { SPRING_SHAPE } from './motion.js'
import { clockLabel } from './text.js'
import { CheckIcon } from './icons.js'

export function DeleteBotDialog({ id, actions, leaving }) {
  const [view, setView] = useState(null)
  const [policy, setPolicy] = useState('delete')
  const [target, setTarget] = useState('')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const ref = useRef(null)
  const close = () => { if (!busy) actions.closeDeleteBot() }
  useEscape(close)
  const load = () => {
    setBusy(true); setError(''); setFiles([])
    return actions.deletePreview(id).then(setView, failure => setError(hostText(failure.message))).finally(() => setBusy(false))
  }
  useEffect(() => {
    const previous = document.activeElement
    void load(); ref.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [id])
  const remove = async () => {
    setBusy(true); setError('')
    try { setDone(await actions.confirmDeleteBot({ id, token: view.token, tasks: policy, target, files })) }
    catch (failure) { await load(); setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const restore = async fileId => {
    setBusy(true)
    try {
      await actions.restoreArtifact(id, fileId)
      const update = progress => ({ ...progress, files: { ...progress.files, [fileId]: { ...progress.files[fileId], status: 'restored' } } })
      if (done) setDone(value => ({ ...value, progress: update(value.progress) }))
      else setView(value => ({ ...value, progress: update(value.progress) }))
    }
    catch (failure) { setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const targetInfo = view?.targets.find(bot => bot.id === target)
  const progress = done?.progress ?? view?.progress
  const taskProgress = Object.values(progress?.tasks ?? {})
  const moved = Object.entries(progress?.files ?? {}).filter(([, file]) => file.status === 'recycled' || file.status === 'restored')
  const transferred = taskProgress.filter(task => task.to && task.status === 'done')
  const deleted = taskProgress.filter(task => !task.to && task.status === 'done')
  const history = taskProgress.filter(task => task.records?.length)
  const name = view?.bot.name ?? t('Bot')
  const section = (title, ...children) => h('section', { className: 'bt-delete-section' }, h('h3', null, title), ...children)
  const hint = text => h('p', { className: 'bt-delete-hint' }, text)
  const nextRun = task => task.scheduledAt ? h('time', { dateTime: new Date(task.scheduledAt).toISOString() }, t('Next run {time}', { time: clockLabel(task.scheduledAt) })) : null
  const fileRecovery = () => Object.entries(progress?.files ?? {}).map(([key, file]) => h('div', { className: 'bt-delete-file', key },
    h('code', null, file.original), file.status === 'recycled'
      ? h('button', { type: 'button', disabled: busy, className: 'bt-soft bt-soft-sm', onClick: () => restore(key) }, t('Restore file'))
      : h('span', { className: 'bt-delete-hint' }, file.status === 'restored' ? t('Restored') : t('Needs attention'))))
  return h('div', { className: 'bt-delete-backdrop', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('section', { className: 'bt-delete-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-delete-title', 'aria-describedby': 'bt-delete-description', tabIndex: -1, ref,
      onKeyDown: event => {
        if (event.key !== 'Tab') return
        const controls = [...ref.current.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')].filter(control => control.getClientRects().length)
        const first = controls[0]; const last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus() }
      } },
    h('header', { className: 'bt-delete-head' },
      done ? h('span', { className: 'bt-delete-success', 'aria-hidden': true }, h(CheckIcon)) : null,
      h('div', null,
        h('h2', { id: 'bt-delete-title' }, done ? t('{name} was deleted', { name }) : t('Delete {name}?', { name })),
        h('p', { id: 'bt-delete-description', className: 'bt-delete-hint' }, done
          ? t('The Bot has been removed from your team. Here is what happened to its resources.')
          : t('Review what happens to its tasks and files before continuing.')))),
    h('div', { className: 'bt-delete-body' },
      !view && !error ? h('p', { role: 'status' }, t('Loading…')) : null,
      view && !done ? h('div', { className: 'bt-delete-content' },
        h('dl', { className: 'bt-delete-facts' },
          h('div', null, h('dt', null, t('Chat and memory')), h('dd', null, t('Will be archived'))),
          h('div', null, h('dt', null, t('Browser data')), h('dd', null, t('Will be deleted'))),
          h('div', null, h('dt', null, t('Shared secrets')), h('dd', null, t('Kept')))),
        view.groups.length ? hint(t('Leaves group chats: {names}', { names: view.groups.map(group => group.name).join(', ') })) : null,
        section(t('Automation tasks'),
          view.tasks.length ? h('ul', { className: 'bt-delete-tasks' }, view.tasks.map(task => h('li', { key: `${task.sessionId}:${task.id}` },
            h('span', null, task.title), h('span', { className: 'bt-delete-hint' }, task.status === 'active' ? t('Active') : t('Finished'))))) : hint(t('No associated automation tasks.')),
          view.tasks.length ? h('label', { className: 'bt-delete-field' }, h('span', null, t('Task handling')),
            h('select', { className: 'bt-select', value: policy, disabled: busy, onChange: event => setPolicy(event.target.value) },
              h('option', { value: 'delete' }, t('Delete with the Bot')), h('option', { value: 'transfer' }, t('Transfer to another Bot')))) : null,
          policy === 'transfer' ? h('div', { className: 'bt-delete-transfer' },
            h('label', { className: 'bt-delete-field' }, h('span', null, t('Receive tasks')),
              h('select', { className: 'bt-select', value: target, disabled: busy, onChange: event => setTarget(event.target.value) },
                h('option', { value: '' }, t('Choose a Bot')), view.targets.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
            targetInfo ? h('div', { className: 'bt-delete-target' }, hint(`${t('Permissions')}: ${targetInfo.permission ?? t('Default')}`), h('code', null, targetInfo.workDir ?? '—')) : null,
            hint(t('Interval tasks restart their timer when transferred. Keys are not transferred.')),
            hint(t('Only active tasks are transferred. Finished task records are kept.')),
            h('ul', { className: 'bt-delete-tasks' }, view.tasks.filter(task => task.status === 'active').map(task => h('li', { key: task.id },
              h('span', null, task.title), nextRun(task))))) : null),
        section(t('Related files'),
          hint(t('Files stay in your working folder unless you select them for recovery storage.')),
          view.files.length ? h('ul', { className: 'bt-delete-files' }, view.files.map(file => h('li', { key: file.id }, h('label', { className: 'bt-delete-file' },
            h('input', { type: 'checkbox', disabled: busy || !file.cleanable, checked: files.includes(file.id), onChange: event => setFiles(value => event.target.checked ? [...value, file.id] : value.filter(key => key !== file.id)) }),
            h('code', null, file.path), !file.cleanable ? h('span', { className: 'bt-delete-hint' }, t('Kept')) : null))))
            : h('p', { className: 'bt-delete-empty' }, t('No files eligible for automatic cleanup. Your files will be kept.')),
          h('details', { className: 'bt-delete-folder' }, h('summary', null, t('Working folder')), h('code', null, view.bot.workDir ?? '—'),
            hint(t('Only verified new, unchanged, unshared files can be moved to recovery storage.')))),
        progress ? section(t('Deletion progress'),
          h('ul', { className: 'bt-delete-tasks' }, taskProgress.map((task, index) => h('li', { key: index }, h('span', null, task.original?.title ?? t('Task')), h('span', null, task.status === 'done' ? t('Finished') : t('Needs attention'))))),
          ...fileRecovery()) : null) : null,
      done ? h('div', { className: 'bt-delete-content' },
        h('dl', { className: 'bt-delete-facts bt-delete-outcome' },
          h('div', null, h('dt', null, t('Chat and memory')), h('dd', null, t('Archived'))),
          h('div', null, h('dt', null, t('Automation tasks')), h('dd', null,
            deleted.length ? h('span', null, t('{count} tasks deleted', { count: deleted.length })) : null,
            transferred.length ? h('span', null, t('{count} tasks transferred', { count: transferred.length })) : null,
            !deleted.length && !transferred.length ? t('No associated automation tasks.') : null)),
          h('div', null, h('dt', null, t('Working files')), h('dd', null, moved.length ? t('{count} files moved to recovery storage', { count: moved.length }) : t('No files were removed.'))),
          h('div', null, h('dt', null, t('Browser data')), h('dd', null, t('Deleted'))),
          h('div', null, h('dt', null, t('Shared secrets')), h('dd', null, t('Kept')))),
        Object.keys(progress?.files ?? {}).length ? section(t('File recovery'), hint(t('Restore a file to its original location without overwriting an existing file.')), ...fileRecovery()) : null) : null,
      error ? h('p', { role: 'alert', className: 'bt-delete-error bt-danger' }, error) : null,
      history.length ? h('details', { className: 'bt-delete-history' },
        h('summary', null, t('View saved scheduling history ({count})', { count: history.reduce((count, task) => count + task.records.length, 0) })),
        hint(t('These are records from before deletion, not tasks that are still running.')),
        history.map((task, index) => h('section', { className: 'bt-delete-history-task', key: index }, h('h3', null, task.original?.title ?? t('Task')),
          h('ul', null, task.records.map((record, index) => h('li', { key: record.messageId ?? index },
            h('time', null, t('Scheduled for {time}', { time: clockLabel(record.scheduledAt) }))))),
          h('details', null, h('summary', null, t('Original task instruction')), h('p', null, task.original?.prompt ?? task.records[0]?.prompt ?? ''))))) : null),
    h('footer', { className: 'bt-delete-actions' },
      !done && view ? h('button', { type: 'button', className: 'bt-soft bt-delete-refresh', disabled: busy, onClick: load }, t('Refresh')) : null,
      h('div', null,
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: close }, done ? t('Done') : t('Cancel')),
        view && !done ? h('button', { type: 'button', className: 'bt-soft bt-delete-confirm', disabled: busy || (policy === 'transfer' && !target), onClick: remove }, busy ? t('Deleting…') : t('Delete Bot')) : null))))
}

export const DELETE_BOT_CSS = `
.bt-delete-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px}
.bt-delete-dialog{position:relative;box-sizing:border-box;width:min(560px,100%);max-height:min(85vh,820px);display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);border:.5px solid var(--bt-line-2);border-radius:16px;overflow:hidden;font-family:var(--bt-font);animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-delete-head{display:flex;align-items:flex-start;gap:12px;padding:24px 24px 20px;flex:none}
.bt-delete-dialog h2{font-size:18px;line-height:26px;font-weight:600;margin:0 0 6px}.bt-delete-dialog h3{font-size:13px;line-height:18px;font-weight:600;margin:0 0 12px}
.bt-delete-dialog p{font-size:13px;line-height:20px;margin:0;overflow-wrap:anywhere}.bt-delete-dialog .bt-delete-hint{font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-delete-body{overflow:auto;min-height:0;padding:0 24px 24px;overscroll-behavior:contain}.bt-delete-content{display:flex;flex-direction:column;gap:24px}
.bt-delete-section{display:flex;flex-direction:column;gap:12px}.bt-delete-section h3{margin:0}
.bt-delete-facts{margin:0;padding:14px 16px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:10px;display:grid;gap:12px}
.bt-delete-facts>div{display:grid;grid-template-columns:120px minmax(0,1fr);gap:16px;font-size:13px;line-height:20px}.bt-delete-facts dt{color:var(--bt-ink-2)}.bt-delete-facts dd{margin:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:4px}
.bt-delete-tasks,.bt-delete-files{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}.bt-delete-tasks li{display:flex;justify-content:space-between;align-items:baseline;gap:16px;font-size:13px;line-height:20px;overflow-wrap:anywhere}.bt-delete-tasks li>span:first-child{min-width:0}.bt-delete-tasks time{font-size:12px;color:var(--bt-ink-2);text-align:right}
.bt-delete-field{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--bt-ink-2)}.bt-delete-dialog .bt-select{box-sizing:border-box;width:100%;margin:0;font-size:13px;min-height:38px;color:var(--bt-ink)}
.bt-delete-transfer{display:flex;flex-direction:column;gap:12px}.bt-delete-target{display:flex;flex-direction:column;gap:4px}.bt-delete-dialog code{font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;white-space:normal}
.bt-delete-empty{padding:12px 14px;background:var(--bt-card);border-radius:8px;color:var(--bt-ink-2)}.bt-delete-file{display:flex;align-items:center;gap:10px;font-size:13px}.bt-delete-file code{flex:1;min-width:0}.bt-delete-file input{flex:none}
.bt-delete-folder,.bt-delete-history{font-size:12px;line-height:20px;color:var(--bt-ink-2)}.bt-delete-dialog summary{cursor:pointer;padding:4px 0}.bt-delete-folder>code{display:block;margin:8px 0}.bt-delete-history{margin-top:24px;border-top:1px solid var(--bt-line);padding-top:16px}.bt-delete-history>summary{color:var(--bt-ink);font-weight:500}.bt-delete-history>.bt-delete-hint{margin:8px 0 16px}.bt-delete-history-task+section{margin-top:16px}.bt-delete-history-task h3{margin:0 0 8px}.bt-delete-history-task ul{margin:0 0 8px;padding-left:20px}.bt-delete-history-task p{white-space:pre-wrap;margin-top:8px}
.bt-delete-success{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:50%;color:var(--bt-green);background:color-mix(in srgb,var(--bt-green) 12%,transparent)}
.bt-delete-actions{flex:none;display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--bt-line);padding:16px 24px;background:var(--bt-main)}.bt-delete-actions>div{display:flex;justify-content:flex-end;gap:8px;margin-left:auto}.bt-delete-actions .bt-soft{min-height:36px;padding:8px 16px;white-space:nowrap}.bt-delete-refresh{color:var(--bt-ink-2)}.bt-delete-actions .bt-delete-confirm{background:var(--bt-danger);color:var(--bt-knob)}.bt-delete-error{margin:16px 0!important}
.bt-delete-backdrop[data-leaving]{pointer-events:none;animation:bt-veil-out .16s ease-out forwards}.bt-delete-backdrop[data-leaving] .bt-delete-dialog{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
@media(max-width:520px){.bt-delete-backdrop{padding:12px}.bt-delete-head{padding:20px 16px 16px}.bt-delete-body{padding:0 16px 20px}.bt-delete-actions{padding:14px 16px}.bt-delete-facts>div{grid-template-columns:96px minmax(0,1fr);gap:12px}}
@media(prefers-reduced-motion:reduce){.bt-delete-dialog,.bt-delete-backdrop[data-leaving],.bt-delete-backdrop[data-leaving] .bt-delete-dialog{animation-duration:.01s}}
`
