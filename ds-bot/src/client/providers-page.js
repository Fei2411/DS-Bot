// The Models page of a window that has no DSH settings of its own: the model providers
// DSH serves, with their API keys and models, and the providers it can add. DSH keeps
// all of it; a key only ever travels from these inputs to the host.
import { createElement as h, useEffect, useState } from 'react'
import { CheckIcon, ChevronRightIcon, PlusIcon, TrashIcon } from './icons.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { Segmented, SPRING_SHAPE } from './motion.js'
import { hostText, t } from './i18n.js'

const PROTOCOL_NAMES = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini',
}
// Anthropic's SDK appends /v1/messages itself, Gemini takes /v1beta, and OpenAI takes /v1.
const ENDPOINT_HINTS = {
  'anthropic-messages': 'https://gateway.example',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
}
const SHOWN_MODELS = 8

// A failure in the interface language; the dialog's error line shows it.
const translated = promise => Promise.resolve(promise).catch((failure) => { throw new Error(hostText(failure?.message ?? String(failure))) })

// A discovery result as a draft: what the endpoint returned is selected; entries the
// endpoint no longer returns stay visible, unselected, so keeping them is explicit.
export function draftFrom(provider, discovered) {
  const existing = Array.isArray(provider.declaredModels) && provider.declaredModels.length > 0
    ? provider.declaredModels
    : (provider.models ?? [])
  const byId = new Map(existing.filter(model => typeof model?.id === 'string' && model.id !== '').map(model => [model.id, model]))
  const seen = new Set()
  const rows = []
  for (const model of Array.isArray(discovered) ? discovered : []) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, model, existing: byId.has(id), returned: true, selected: true })
  }
  for (const model of existing) {
    if (typeof model?.id !== 'string' || model.id === '' || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push({ id: model.id, model, existing: true, returned: false, selected: true })
  }
  return { rows, existingIds: new Set(rows.filter(row => row.existing).map(row => row.id)) }
}

export function draftSummary(draft) {
  const selected = draft.rows.filter(row => row.selected)
  return {
    selected,
    added: selected.filter(row => !row.existing).length,
    removed: draft.rows.filter(row => row.existing && !row.selected).length,
  }
}

// Models this save would remove that a Bot still names. The save itself never moves a
// Bot; the warning is the only place that says its current model may stop working.
export function usedRemoved(provider, draft, roster) {
  const used = new Map()
  for (const row of draft.rows) {
    if (!row.existing || row.selected) continue
    const ref = row.model.ref ?? `${provider.id}/${row.id}`
    const bots = (roster?.bots ?? []).filter(bot => bot.model === ref || bot.appliedModel === ref)
    if (bots.length > 0) used.set(ref, bots.map(bot => bot.name))
  }
  return used
}

export function ProvidersPage({ actions, run, roster, Section, advanced = null }) {
  const [view, setView] = useState(null)
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  // Resolves true when the host took it; the page then shows the host's new view.
  const apply = promise => run(translated(promise).then((next) => { if (next?.providers) setView(next) }))
  useEffect(() => { void apply(actions.providers()) }, [])
  if (view === null) return null
  if (!view.available) return h('p', { className: 'bt-set-hint' }, t('This DSH cannot set up model providers.'))
  const addBtn = adding ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, h(PlusIcon), t('Add a provider'))
  return [
    h(Section, { key: 'list', title: t('Model providers · {count}', { count: view.providers.length }), action: addBtn },
      view.providers.map(provider => h(ProviderRow, {
        key: provider.id, provider, apply, actions, roster, revision: view.revision,
        open: open === provider.id, onToggle: () => setOpen(open === provider.id ? null : provider.id),
      })),
      adding ? h(AddProvider, { key: 'add', view, apply, actions, onDone: () => setAdding(false) }) : null),
    // DSH's own Models page: each model's context, output, inputs, thinking levels and order.
    advanced ? h('div', { key: 'advanced', className: 'bt-set-card' },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-advanced', onClick: advanced },
        h('span', { className: 'bt-set-copy' }, h('span', null, t('Advanced settings'))), h(ChevronRightIcon))) : null,
  ]
}

function keyState(key) {
  if (key === null) return null
  if (!key.configured) return ['missing', t('Needs an API key')]
  return key.writable ? ['set', t('Key set')] : ['outside', t('Key set outside DS Bot')]
}

export function ProviderRow({ provider, apply, actions, roster, revision, open, onToggle }) {
  const [confirm, setConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [draft, setDraft] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    if (open) return
    setConfirm(false)
    setDraft(null)
    setRefreshError('')
    setConfirmRemove(false)
  }, [open])
  const state = keyState(provider.key)
  const shown = provider.models.slice(0, SHOWN_MODELS)
  const hint = provider.error ?? (provider.models.length === 0 ? t('No models') : t('{count} models', { count: provider.models.length }))
  const canRefresh = provider.refreshable === true
  const refresh = () => {
    if (!canRefresh || refreshing) return
    setRefreshing(true)
    setRefreshError('')
    setDraft(null)
    setConfirmRemove(false)
    void translated(Promise.resolve(actions.providerModels({ provider: provider.id })))
      .then(list => setDraft(draftFrom(provider, list)))
      .catch(error => setRefreshError(error?.message ?? String(error)))
      .finally(() => setRefreshing(false))
  }
  const toggle = (id) => {
    setConfirmRemove(false)
    setDraft(current => current === null ? current : ({
      ...current,
      rows: current.rows.map(row => (row.id === id ? { ...row, selected: !row.selected } : row)),
    }))
  }
  const save = () => {
    if (draft === null) return
    const { selected } = draftSummary(draft)
    if (selected.length === 0) return
    if (usedRemoved(provider, draft, roster).size > 0 && !confirmRemove) {
      setConfirmRemove(true)
      return
    }
    const models = selected.map(row => (row.returned ? row.model : { id: row.id }))
    void apply(actions.saveProviderModels({ provider: provider.id, models, revision })).then((ok) => {
      if (!ok) return
      setDraft(null)
      setConfirmRemove(false)
      void actions.refreshModels?.()
    })
  }
  const modelsBlock = (provider.models.length > 0 || canRefresh)
    ? h('div', { className: 'bt-secret-edit-block' },
        h('div', { className: 'bt-provider-models-head' },
          h('span', { className: 'bt-secret-edit-label' }, t('Models')),
          canRefresh
            ? h('button', {
                type: 'button', className: 'bt-soft bt-soft-sm', disabled: refreshing,
                'aria-busy': refreshing ? true : undefined, onClick: refresh,
              }, refreshing ? t('Refreshing…') : t('Refresh models'))
            : null),
        draft !== null
          ? h(ModelDraft, { provider, draft, roster, onToggle: toggle, onSave: save, onCancel: () => { setDraft(null); setConfirmRemove(false) }, confirmRemove })
          : [
              provider.models.length > 0
                ? h('div', { className: 'bt-provider-models' },
                    shown.map(model => h('span', { key: model.ref, className: 'bt-tag', title: model.ref }, model.name)),
                    provider.models.length > shown.length ? h('span', { className: 'bt-set-hint' }, t('and {count} more', { count: provider.models.length - shown.length })) : null)
                : h('div', { className: 'bt-set-hint' }, t('No models')),
              refreshError ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, refreshError) : null,
            ])
    : null
  return h('div', { className: 'bt-secret-item bt-provider', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, provider.name, provider.name !== provider.id ? h('span', { className: 'bt-provider-id' }, provider.id) : null),
        h('span', { className: 'bt-set-hint', 'data-error': provider.error ? '' : undefined }, hint)),
      state ? h('span', { className: 'bt-set-control' }, h('span', { className: 'bt-provider-state', 'data-state': state[0] }, state[1])) : null),
    open ? h('div', { className: 'bt-secret-edit' },
      provider.key?.writable ? h(KeyEditor, { provider, apply, actions }) : null,
      provider.key && !provider.key.writable ? h('div', { className: 'bt-set-hint' }, t('This key comes from outside DS Bot, such as an environment variable, and cannot be changed here.')) : null,
      modelsBlock,
      provider.removable ? h('div', { className: 'bt-secret-row-actions' },
        confirm
          ? [
              h('span', { key: 'q', className: 'bt-set-hint' }, t('Remove {name}? Bots on its models need another model.', { name: provider.name })),
              h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Keep')),
              h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => apply(actions.removeProvider(provider.id)) }, t('Remove')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => setConfirm(true) }, h(TrashIcon), t('Remove provider'))) : null) : null)
}

function ModelDraft({ provider, draft, roster, onToggle, onSave, onCancel, confirmRemove }) {
  const { selected, added, removed } = draftSummary(draft)
  const used = usedRemoved(provider, draft, roster)
  const names = [...new Set([...used.values()].flat())]
  const returned = draft.rows.filter(row => row.returned)
  const unreturned = draft.rows.filter(row => !row.returned)
  const modelButton = row => h('button', {
    key: row.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': row.selected,
    title: row.model.name && row.model.name !== row.id ? row.model.name : undefined,
    onClick: () => onToggle(row.id),
  }, h('code', null, row.id), row.selected ? h(CheckIcon) : null)
  return h('div', { className: 'bt-provider-draft' },
    h('div', { className: 'bt-provider-models-head' },
      h('span', { className: 'bt-set-hint' }, t('{added} added · {removed} removed · {count} selected', { added, removed, count: selected.length }))),
    returned.length > 0
      ? h('div', { className: 'bt-provider-draft-group' },
          h('div', { className: 'bt-secret-edit-label' }, t('Models from the endpoint')),
          h('div', { className: 'bt-secret-bots bt-provider-found' }, returned.map(modelButton)))
      : h('div', { className: 'bt-set-hint' }, t('The endpoint lists no models.')),
    unreturned.length > 0
      ? h('div', { className: 'bt-provider-draft-group' },
          h('div', { className: 'bt-secret-edit-label' }, t("Upstream didn't return")),
          h('div', { className: 'bt-set-hint' }, t('Keep the ids you still want by hand.')),
          h('div', { className: 'bt-secret-bots bt-provider-found' }, unreturned.map(modelButton)))
      : null,
    selected.length === 0 ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'status' }, t('Select at least one model')) : null,
    used.size > 0
      ? h('div', { className: 'bt-set-hint bt-provider-used', role: 'status' },
          t('Used by {names}. Saving removes these models from the provider; those Bots keep their current model and may fail until they choose another.', { names: names.join(t(', ')) }))
      : null,
    h('div', { className: 'bt-secret-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', {
        type: 'button', className: 'bt-send bt-soft-sm', disabled: selected.length === 0, onClick: onSave,
      }, confirmRemove && used.size > 0 ? t('Save anyway') : t('Save'))))
}

function KeyEditor({ provider, apply, actions }) {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const ready = value.trim() !== ''
  const save = () => {
    if (!ready) return
    void apply(actions.setProviderKey(provider.id, value)).then((ok) => { if (ok) { setValue(''); setSaved(true) } })
  }
  const edit = (next) => { setValue(next); setSaved(false) }
  const label = t('{provider} API key', { provider: provider.name })
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, provider.key.configured ? t('Replace the API key') : t('API key')),
    h('div', { className: 'bt-secret-inline' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value, onChange: edit, onEnter: save, label })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save')),
      provider.key.configured ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => apply(actions.setProviderKey(provider.id, null)) }, t('Remove key')) : null),
    saved ? h('div', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Saved.')) : null)
}

function AddProvider({ view, apply, actions, onDone }) {
  const [mode, setMode] = useState(view.addable.length > 0 ? 'known' : 'custom')
  return h('div', { className: 'bt-set-row bt-set-paste bt-provider-add' },
    h(Segmented, { label: t('Kind of provider'), value: mode },
      [['known', t('Known provider')], ['custom', t('Custom API')]].map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'known' && view.addable.length === 0, onClick: () => setMode(id),
      }, label))),
    // Both forms stay mounted, so switching keeps what is typed in the other.
    h('div', { hidden: mode !== 'known' }, h(KnownForm, { view, apply, actions, onDone })),
    h('div', { hidden: mode !== 'custom' }, h(CustomForm, { view, apply, actions, onDone })))
}

function KnownForm({ view, apply, actions, onDone }) {
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const options = [...view.addable].sort((a, b) => a.name.localeCompare(b.name))
  const add = () => {
    if (provider === '') return
    void apply(actions.addProvider({ provider, key })).then((ok) => { if (ok) onDone() })
  }
  return h('div', { className: 'bt-provider-form' },
    h('select', { className: 'bt-select', 'aria-label': t('Provider'), value: provider, onChange: event => setProvider(event.target.value) },
      h('option', { value: '', disabled: true }, t('Choose a provider')),
      options.map(option => h('option', { key: option.id, value: option.id }, option.name))),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: key, onChange: setKey, onEnter: add, label: t('API key') })),
    h(FormActions, { onCancel: onDone, onAdd: add, ready: provider !== '' }))
}

// Exported so the Add form's readiness and missing-field hint can be driven without a
// whole settings page: the hint is what tells the user why Add stays disabled.
export function CustomForm({ view, apply, actions, onDone }) {
  const [draft, setDraft] = useState({ provider: '', name: '', baseURL: '', api: view.protocols[0], key: '', typed: '' })
  const [found, setFound] = useState(null)
  const [picked, setPicked] = useState([])
  const [asking, setAsking] = useState(false)
  const set = (field, value) => setDraft(current => ({ ...current, [field]: value }))
  const typed = draft.typed.split(/[\s,]+/).map(id => id.trim()).filter(Boolean)
  const models = [...(found ?? []).filter(model => picked.includes(model.id)), ...typed.filter(id => !picked.includes(id)).map(id => ({ id }))]
  const missing = []
  if (draft.provider.trim() === '') missing.push(t('Provider ID'))
  if (draft.baseURL.trim() === '') missing.push(t('Endpoint'))
  if (models.length === 0) missing.push(t('At least one model'))
  const ready = missing.length === 0
  const missingHint = ready ? null : h('div', { className: 'bt-set-hint bt-provider-missing', role: 'status' },
    t('Still needed: {fields}', {
      fields: missing.join(t(', ')),
    }))
  const fetchModels = () => {
    setAsking(true)
    void apply(Promise.resolve(actions.providerModels({ baseURL: draft.baseURL, api: draft.api, key: draft.key })).then((list) => { setFound(list); setPicked([]) }))
      .finally(() => setAsking(false))
  }
  const toggle = id => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const add = () => {
    if (!ready) return
    void apply(actions.addProvider({ custom: true, provider: draft.provider.trim(), name: draft.name, baseURL: draft.baseURL, api: draft.api, key: draft.key, models }))
      .then((ok) => { if (ok) onDone() })
  }
  const input = (field, label, placeholder) => h('input', {
    className: 'bt-input', 'aria-label': label, placeholder, value: draft[field], spellCheck: false, autoComplete: 'off', onChange: event => set(field, event.target.value),
  })
  return h('div', { className: 'bt-provider-form' },
    h('div', { className: 'bt-provider-pair' },
      input('provider', t('Provider ID'), t('Provider ID, e.g. my-gateway')),
      input('name', t('Name'), t('Name (optional)'))),
    h('div', { className: 'bt-provider-pair' },
      input('baseURL', t('Endpoint'), ENDPOINT_HINTS[draft.api] ?? 'https://gateway.example/v1'),
      h('select', { className: 'bt-select', 'aria-label': t('Protocol'), value: draft.api, onChange: event => set('api', event.target.value) },
        view.protocols.map(api => h('option', { key: api, value: api }, PROTOCOL_NAMES[api] ?? api)))),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: draft.key, onChange: value => set('key', value), label: t('API key') })),
    h('div', { className: 'bt-secret-edit-block' },
      h('div', { className: 'bt-provider-models-head' },
        h('span', { className: 'bt-secret-edit-label' }, t('Models')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: asking || draft.baseURL.trim() === '', onClick: fetchModels }, asking ? t('Asking…') : t('Fetch models'))),
      found !== null && found.length === 0 ? h('div', { className: 'bt-set-hint' }, t('The endpoint lists no models. Enter their ids below.')) : null,
      found !== null && found.length > 0 ? h('div', { className: 'bt-secret-bots bt-provider-found' }, found.map(model => h('button', {
        key: model.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': picked.includes(model.id), title: model.name && model.name !== model.id ? model.name : undefined, onClick: () => toggle(model.id),
      }, h('code', null, model.id), picked.includes(model.id) ? h(CheckIcon) : null))) : null,
      input('typed', t('Model ids'), t('Model ids, separated by commas'))),
    missingHint,
    h(FormActions, { onCancel: onDone, onAdd: add, ready }))
}

function FormActions({ onCancel, onAdd, ready }) {
  return h('div', { className: 'bt-secret-row-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
    h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: !ready, onClick: onAdd }, t('Add')))
}

export const PROVIDERS_CSS = `
.bt-provider-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--bt-ink-3)}
.bt-provider .bt-set-hint[data-error]{color:var(--bt-danger)}
.bt-provider-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap}
.bt-provider-state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3)}
.bt-provider-state[data-state=set]::before{background:var(--bt-green)}
.bt-provider-state[data-state=missing]{color:var(--bt-danger)}
.bt-provider-state[data-state=missing]::before{background:var(--bt-danger)}
.bt-provider .bt-secret-field{align-items:center;gap:8px}
.bt-provider .bt-secret-field>svg,.bt-provider-form .bt-secret-field>svg{flex:none;color:var(--bt-ink-3)}
.bt-provider-models{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bt-provider-models .bt-tag{max-width:220px}
.bt-provider-add{gap:12px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-provider-add .bt-seg{align-self:flex-start}
.bt-provider-add .bt-seg button{flex:none;padding:0 14px;white-space:nowrap}
.bt-provider-add .bt-seg button:disabled{opacity:.45;cursor:default}
.bt-provider-form{display:flex;flex-direction:column;gap:10px}
.bt-provider-form .bt-secret-field{min-height:36px;align-items:center;gap:8px}
.bt-provider-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bt-provider-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-provider-missing{color:var(--bt-danger)}
.bt-provider-draft{display:flex;flex-direction:column;gap:8px}
.bt-provider-draft-group{display:flex;flex-direction:column;gap:6px}
.bt-provider-draft>.bt-set-hint,.bt-provider-draft-group>.bt-set-hint{margin:0}
.bt-provider-used{color:var(--bt-danger)}
.bt-provider-draft .bt-secret-row-actions{margin-top:2px}
/* Room for the pills' focus rings inside the scroll box; the margin keeps them in line with the fields. */
.bt-provider-found{max-height:180px;overflow-y:auto;scrollbar-width:thin;padding:3px;margin:-3px}
.bt-provider-found code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bt-provider-found .bt-secret-bot{padding:0 10px}
@media (prefers-reduced-motion:reduce){.bt-provider-add{animation:none}}
`
