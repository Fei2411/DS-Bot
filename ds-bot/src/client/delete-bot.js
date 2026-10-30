import { createElement as h, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { hostText, t } from './i18n.js'
import { SPRING_SHAPE } from './motion.js'

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
  return h('div', { className: 'bt-delete-backdrop', 'data-leaving': leaving || undefined }, h('section', { className: 'bt-delete-dialog bt-set-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-delete-title', tabIndex: -1, ref,
    onKeyDown: event => {
      if (event.key !== 'Tab') return
      const controls = ref.current.querySelectorAll('button:not(:disabled),select,input')
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    } },
  h('h2', { id: 'bt-delete-title' }, done ? t('Bot deleted') : t('Delete {name}?', { name: view?.bot.name ?? t('Bot') })),
  !view && !error ? h('p', null, t('Loading…')) : null,
  view && !done ? h('div', null,
    h('p', null, t('Chats and memory are archived. Browser data is deleted. Shared secrets are kept.')),
    h('p', null, `${t('Working folder')}: ${view.bot.workDir ?? '—'}`),
    h('p', null, `${t('Group chats')}: ${view.groups.map(group => group.name).join(', ') || '—'}`),
    h('h3', null, t('Automation tasks')),
    h('ul', null, view.tasks.map(task => h('li', { key: task.id }, `${task.title}${task.status === 'active' ? '' : ` · ${t('Finished')}`}`))),
    view.tasks.length ? h('label', null, t('Automation tasks'), h('select', { className: 'bt-select', value: policy, disabled: busy, onChange: event => setPolicy(event.target.value) },
      h('option', { value: 'delete' }, t('Delete with the Bot')), h('option', { value: 'transfer' }, t('Transfer to another Bot')))) : null,
    policy === 'transfer' ? h('div', null,
      h('select', { className: 'bt-select', value: target, disabled: busy, 'aria-label': t('Receive tasks'), onChange: event => setTarget(event.target.value) },
        h('option', { value: '' }, t('Choose a Bot')), view.targets.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
      targetInfo ? h('p', null, `${t('Working folder')}: ${targetInfo.workDir ?? '—'} · ${t('Permissions')}: ${targetInfo.permission ?? t('Default')}`) : null,
      h('p', null, t('Interval tasks restart their timer when transferred. Keys are not transferred.')),
      h('p', null, t('The selected Bot receives the task instructions and monitor baseline.')),
      h('p', null, t('Only active tasks are transferred. Finished task records are kept.')),
      h('ul', null, view.tasks.filter(task => task.status === 'active').map(task => h('li', { key: task.id }, `${task.title}: ${task.kind === 'every' ? new Date(Date.now() + task.everySeconds * 1000).toLocaleString() : new Date(task.scheduledAt).toLocaleString()}`)))) : null,
    h('h3', null, t('Related files')),
    h('p', null, t('Files are kept unless selected. Only verified new, unchanged, unshared files can be recycled.')),
    h('ul', null, view.files.map(file => h('li', { key: file.id }, h('label', null,
      h('input', { type: 'checkbox', disabled: busy || !file.cleanable, checked: files.includes(file.id), onChange: event => setFiles(value => event.target.checked ? [...value, file.id] : value.filter(key => key !== file.id)) }),
      h('code', null, file.path), !file.cleanable ? ` — ${t('Kept')}` : '')))),
    view.progress ? h('div', null, h('h3', null, t('Deletion progress')),
      h('ul', null, Object.values(view.progress.tasks).map((task, index) => h('li', { key: index }, `${task.original?.title ?? t('Task')}: ${task.status === 'done' ? t('Finished') : t('Needs attention')}`))),
      Object.entries(view.progress.files).map(([key, file]) => h('p', { key }, h('code', null, file.original), file.status === 'recycled'
        ? h('button', { type: 'button', disabled: busy, className: 'bt-soft', onClick: () => restore(key) }, t('Restore file')) : t('Kept')))) : null) : null,
  done ? h('div', null, h('p', null, t('Selected files were moved to the recovery folder.')),
    Object.entries(done.progress.files).map(([key, file]) => h('p', { key }, h('code', null, file.original),
      file.status === 'recycled' ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => restore(key) }, t('Restore file')) : t('Restored')))) : null,
  error ? h('p', { role: 'alert', className: 'bt-danger' }, error) : null,
  (done?.progress ?? view?.progress) ? h('div', null, Object.entries((done?.progress ?? view.progress).tasks).map(([key, task]) => task.records?.length
    ? h('details', { key }, h('summary', null, `${task.original?.title ?? t('Task')} · ${t('Saved task records')}`),
      h('ul', null, task.records.map(record => h('li', { key: record.messageId }, `${record.scheduledAt} · ${record.prompt ?? ''}`)))) : null)) : null,
  h('div', { className: 'bt-delete-actions' },
    h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: close }, done ? t('Close') : t('Cancel')),
    !done ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: load }, t('Refresh')) : null,
    view && !done ? h('button', { type: 'button', className: 'bt-soft bt-danger', disabled: busy || (policy === 'transfer' && !target), onClick: remove }, t('Delete Bot')) : null)))
}

export const DELETE_BOT_CSS = `
.bt-delete-backdrop{position:fixed;inset:0;background:color-mix(in srgb,var(--bt-ink) 35%,transparent);z-index:1000;display:grid;place-items:center;padding:24px}
.bt-delete-dialog{width:min(640px,100%);max-height:85vh;overflow:auto;padding:24px;background:var(--bt-main);border:1px solid var(--bt-line-2)}
.bt-delete-dialog h2{font-size:18px;margin:0 0 16px}.bt-delete-dialog h3{font-size:14px;margin:20px 0 8px}
.bt-delete-dialog p,.bt-delete-dialog li{font-size:13px;line-height:1.6;overflow-wrap:anywhere}.bt-delete-dialog select{margin:8px}
.bt-delete-dialog code{white-space:normal}.bt-delete-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.bt-delete-dialog{animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-delete-backdrop[data-leaving]{pointer-events:none;animation:bt-veil-out .16s ease-out forwards}
.bt-delete-backdrop[data-leaving] .bt-delete-dialog{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
@media(prefers-reduced-motion:reduce){.bt-delete-dialog,.bt-delete-backdrop[data-leaving],.bt-delete-backdrop[data-leaving] .bt-delete-dialog{animation-duration:.01s}}
.bt-automation-results{display:flex;flex-direction:column;gap:12px}.bt-monitor-result .bt-set-row{gap:12px}.bt-monitor-result time{font-size:12px;color:var(--bt-ink-3)}
`
