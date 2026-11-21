import { createElement as h, Fragment, useEffect, useState } from 'react'
import { FolderMenu } from './folder-menu.js'
import { PlusIcon } from './icons.js'
import { t } from './i18n.js'

const blank = () => ({ name: '', kind: 'mcp', description: '', transport: 'stdio', command: '', argsText: '', envText: '{}', url: '', headersText: '{}', content: '', source: 'text', items: [] })
const parseMap = (text, label) => {
  let value
  try { value = JSON.parse(text || '{}') } catch { throw new Error(t('{label} must be valid JSON.', { label })) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('{label} must be a JSON object.', { label }))
  return value
}
const statusText = (status, item) => !status ? undefined : status.state === 'ready' ? t('Ready')
  : status.state === 'needs-approval' ? t('Needs approval')
    : status.state === 'error' ? t(item.source === 'directory' ? 'Could not load skill: {error}' : 'Could not connect: {error}', { error: status.error ?? '' })
      : t('Connecting…')

function Field({ label, value, onChange, multiline = false, disabled = false, placeholder }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t(label))),
    h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'bt-input bt-input-area' : 'bt-input',
      value,
      disabled,
      maxLength: label === 'Name' ? 32 : undefined,
      placeholder,
      spellCheck: false,
      onChange: event => onChange(event.target.value),
    }))
}

function CapabilityForm({ draft, setDraft, items, actions, busy, setBusy, onClose }) {
  const [error, setError] = useState('')
  const directorySkill = draft.kind === 'skill' && draft.source === 'directory'
  const selectedSkill = directorySkill ? draft.selectedSkill : undefined
  const name = selectedSkill?.name ?? draft.name
  const description = selectedSkill?.description ?? draft.description
  const canSave = !busy && (!directorySkill || !!draft.originalName || !!selectedSkill)
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const run = async task => {
    setBusy(true)
    setError('')
    try { await task } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }
  const pickDirectory = async directory => {
    set('selectedSkill', undefined)
    await run(actions.previewSkillDirectory(directory).then(preview => {
      if (draft.originalName && preview.name !== draft.originalName) {
        throw new Error(t('Choose a folder whose SKILL.md is named {name}.', { name: draft.originalName }))
      }
      if (!draft.originalName && items.some(item => item.name === preview.name)) {
        throw new Error(t('A capability named {name} already exists.', { name: preview.name }))
      }
      set('selectedSkill', preview)
    }))
  }
  const changeSource = source => {
    setError('')
    set('source', source)
  }
  const submit = event => {
    event.preventDefault()
    if (!canSave) return
    setError('')
    let payload
    try {
      payload = { name: name.trim(), kind: draft.kind, description }
      if (draft.kind === 'mcp' && draft.transport === 'stdio') {
        payload.transport = 'stdio'
        payload.command = draft.command
        payload.args = draft.argsText.split('\n').filter(line => line !== '')
        payload.env = parseMap(draft.envText, t('Environment'))
      } else if (draft.kind === 'mcp') {
        payload.transport = 'streamable-http'
        payload.url = draft.url
        payload.headers = parseMap(draft.headersText, t('Headers'))
      } else if (directorySkill) {
        payload.source = 'directory'
        payload.originalName = draft.originalName
        if (selectedSkill) payload.directory = selectedSkill.directory
      } else if (draft.kind === 'skill') payload.content = draft.content
      else payload.items = draft.items
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return
    }
    void run(actions.saveCapability(payload).then(onClose))
  }
  const available = items.filter(item => item.name !== draft.name && ['mcp', 'skill'].includes(item.kind))
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h(Field, { label: 'Name', value: name, disabled: busy || directorySkill || draft.originalName !== undefined, onChange: value => set('name', value), placeholder: 'my-tool' }),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Type'))),
      h('select', { className: 'bt-select bt-task-bot', value: draft.kind, disabled: busy || draft.originalName !== undefined, onChange: event => set('kind', event.target.value) },
        ['mcp', 'skill', 'pack'].map(kind => h('option', { key: kind, value: kind }, t(kind === 'mcp' ? 'MCP server' : kind === 'skill' ? 'Skill' : 'Pack'))))),
    draft.kind === 'skill' ? h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Skill source'))),
      h('select', { className: 'bt-select bt-task-bot', value: draft.source, disabled: busy || draft.originalName !== undefined, onChange: event => changeSource(event.target.value) },
        h('option', { value: 'text' }, t('Skill text')),
        h('option', { value: 'directory' }, t('Skill folder')))) : null,
    directorySkill ? h('div', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, t('Original folder')),
        h('span', { className: 'bt-set-hint' }, t('DS Bot copies the folder and its files.'))),
      h(FolderMenu, {
        value: selectedSkill?.directory ?? draft.directory,
        chooseLabel: t('Choose a skill folder'),
        actions,
        run,
        onPick: pickDirectory,
        disabled: busy,
      })) : null,
    h(Field, { label: 'Description', value: description, disabled: busy || directorySkill, onChange: value => set('description', value) }),
    draft.kind === 'mcp' ? h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Connection'))),
      h('select', { className: 'bt-select bt-task-bot', value: draft.transport, onChange: event => set('transport', event.target.value) },
        h('option', { value: 'stdio' }, t('Local command')),
        h('option', { value: 'streamable-http' }, t('HTTP server')))) : null,
    draft.kind === 'mcp' && draft.transport === 'stdio' ? h(Fragment, null,
      h(Field, { label: 'Command', value: draft.command, onChange: value => set('command', value) }),
      h(Field, { label: 'Arguments (one per line)', value: draft.argsText, onChange: value => set('argsText', value), multiline: true }),
      h(Field, { label: 'Environment (JSON)', value: draft.envText, onChange: value => set('envText', value), multiline: true, placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}') })) : null,
    draft.kind === 'mcp' && draft.transport === 'streamable-http' ? h(Fragment, null,
      h(Field, { label: 'URL', value: draft.url, onChange: value => set('url', value) }),
      h(Field, { label: 'Headers (JSON)', value: draft.headersText, onChange: value => set('headersText', value), multiline: true, placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}') })) : null,
    draft.kind === 'skill' && !directorySkill ? h(Field, { label: 'Skill instructions', value: draft.content, disabled: busy, onChange: value => set('content', value), multiline: true }) : null,
    draft.kind === 'pack' ? h(Fragment, null,
      available.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('Save an MCP server or skill first.')))
        : available.map(item => h('label', { key: item.name, className: 'bt-set-row bt-bs-row' },
          h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, item.name)),
          h('input', { type: 'checkbox', checked: draft.items.includes(item.name), onChange: event => set('items', event.target.checked ? [...draft.items, item.name] : draft.items.filter(name => name !== item.name)) })))) : null,
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint', role: 'alert' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: !canSave }, draft.originalName ? t('Save changes') : t('Add capability'))))
}

function CapabilityRow({ item, onEdit, onDelete, onApprove, confirming, disabled }) {
  const detail = item.kind === 'pack' ? `${t('Pack')}: ${(item.items ?? []).join(', ') || t('No items')}`
    : item.kind === 'mcp' ? item.transport === 'stdio' ? t('Local command') : t('HTTP server')
      : t('Skill')
  const badge = item.kind === 'mcp' ? 'MCP' : item.kind === 'skill' ? t(item.source === 'directory' ? 'Skill folder' : 'Skill') : t('Pack')
  const secondary = item.kind === 'pack'
    ? [item.description, (item.items ?? []).join(', ') || t('No items')].filter(Boolean).join(' · ')
    : item.description || detail
  return h('div', { className: 'bt-connector' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-title' },
          h('span', { className: 'bt-connector-name' }, item.name),
          h('span', { className: 'bt-tag' }, badge)),
        h('span', { className: 'bt-connector-status' }, secondary)),
      h('span', { className: 'bt-connector-actions' },
        item.kind === 'mcp' && item.transport === 'stdio' && !item.approved
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onApprove, disabled }, t('Allow')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onEdit, disabled }, t('Edit')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDelete, disabled }, confirming ? t('Click again to delete.') : t('Delete')))))
}

export function CapabilitiesPage({ roster, actions, run }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState('')
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const startNew = () => setDraft(blank())
  const edit = item => setDraft({
    ...blank(),
    ...item,
    originalName: item.name,
    argsText: (item.args ?? []).join('\n'),
    envText: JSON.stringify(item.env ?? {}, null, 2),
    headersText: JSON.stringify(item.headers ?? {}, null, 2),
    items: [...(item.items ?? [])],
  })
  const remove = item => {
    if (confirming !== item.name) { setConfirming(item.name); return }
    setConfirming('')
    void run(actions.deleteCapability(item.name))
  }
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-la-sec-head' },
      h('h3', null, t('Shared capabilities')),
      draft ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: startNew }, h(PlusIcon), t('Add capability'))),
    draft ? h(CapabilityForm, { draft, setDraft, items, actions, busy, setBusy, onClose: () => setDraft(null) }) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      items.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No capabilities saved')))
        : items.map(item => h(CapabilityRow, {
          key: item.name,
          item,
          disabled: busy,
          confirming: confirming === item.name,
          onEdit: () => edit(item),
          onDelete: () => remove(item),
          onApprove: () => void run(actions.approveCapability(item.name)),
        }))))
}

export function BotCapabilitiesCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => Number(b.kind === 'pack') - Number(a.kind === 'pack') || a.name.localeCompare(b.name))
  const attached = new Set(bot.capabilities ?? [])
  const statuses = roster.capabilityStatuses?.[bot.id] ?? {}
  if (items.length === 0) return null
  return h(Card, { title: t('Capabilities') },
    items.map(item => h(SwitchRow, {
      key: item.name,
      label: item.name,
      hint: attached.has(item.name) ? statusText(statuses[item.name], item) : undefined,
      on: attached.has(item.name),
      onChange: enabled => void run(actions.setBotCapability(bot.id, item.name, enabled)),
    })))
}
