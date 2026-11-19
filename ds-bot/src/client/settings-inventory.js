import { createElement as h, Fragment, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { PreferenceSelect } from './settings-preferences.js'
import { t } from './i18n.js'

const PRESET_NAMES = new Set(['standard', 'ptc', 'minimal', 'cordis'])
const PHASE_LABEL = { pending: 'pending', loading: 'loadingPhase', active: 'active', failed: 'failed', unloading: 'unloading' }

export function inventoryPresetName(preset, locale) {
  if (preset.name !== undefined) return preset.name
  if (!PRESET_NAMES.has(preset.id)) return preset.id
  return locale.bind('settings.agentPreset')(`preset${preset.id[0].toUpperCase()}${preset.id.slice(1)}Name`)
}

export function inventoryText(row, locale) {
  const resolve = text => typeof text === 'object' ? locale.resolveText(text) : text
  const fallback = row.moduleName.replace(/^@[^/]+\//, '').replace(/^(?:cordis:|cordis-plugin-|dsh-(?:host-|client-)?)/, '')
  return { title: resolve(row.meta?.title) ?? fallback, description: resolve(row.meta?.description) }
}

export function inventoryView(snapshot, chosen, query, locale) {
  const text = query.trim().toLocaleLowerCase()
  const matches = (row) => {
    const copy = inventoryText(row, locale)
    return [row.moduleName, row.entryId, copy.title, copy.description].some(value => value?.toLocaleLowerCase().includes(text))
  }
  const presets = snapshot.agentPresets ?? []
  const selected = presets.find(preset => preset.id === chosen) ?? presets.find(preset => preset.isDefault) ?? presets[0]
  const entries = snapshot.entries.filter(matches).toSorted((a, b) => Number(b.fiberPhase === 'failed') - Number(a.fiberPhase === 'failed'))
  const rows = selected?.rows.filter(matches) ?? []
  const others = text ? presets.filter(preset => preset !== selected && preset.rows.some(matches)) : []
  return { selected, presets, entries, rows, others, otherCount: others.reduce((sum, preset) => sum + preset.rows.filter(matches).length, 0) }
}

function InventoryCard({ row, providers, preset, expanded, toggle, rowKey, locale, tr }) {
  const { title, description } = inventoryText(row, locale)
  const phase = tr(PHASE_LABEL[row.fiberPhase] ?? 'unobserved')
  const status = row.fiberPhase === 'failed' ? 'failedTag' : providers.length ? 'presetEnabledTag'
    : row.enabled === true ? 'enabledTag' : row.enabled === false ? 'disabledTag' : 'conditionalTag'
  const open = rowKey === expanded
  const id = useId()
  const facts = [[tr('moduleLabel'), row.moduleName], [tr('configuration'), tr(providers.length ? 'presetProvidedDetail' : status)]]
  if (preset) facts.push([tr('fromPreset'), inventoryPresetName(preset, locale)])
  if (providers.length) facts.push([tr('enabledIn'), providers.map(value => inventoryPresetName(value, locale)).join(' · ')])
  if (row.fiberPhase !== null) facts.push([tr('runtime'), phase])
  if (row.condition !== undefined) facts.push([tr('condition'), row.condition])
  return h('div', { className: 'bt-inventory-card', 'data-plugin-module': row.moduleName, 'data-plugin-entry': row.entryId ?? undefined },
    h('button', {
      type: 'button', className: 'bt-set-row', 'aria-expanded': open, 'aria-controls': id,
      onClick: () => toggle(open ? null : rowKey),
    }, h('span', { className: 'bt-set-copy' }, h('strong', null, title),
      description ? h('span', { className: 'bt-set-hint' }, description) : null,
      row.entryId ? h('code', { className: 'bt-set-hint' }, row.entryId.replace(/^include:/, '')) : null),
    h('span', { className: row.fiberPhase === 'failed' ? 'bt-danger' : 'bt-set-hint' },
      ['pending', 'loading', 'unloading'].includes(row.fiberPhase) ? `${phase} · ` : '',
      status === 'enabledTag' ? null : tr(status))),
    row.meta?.error ? h('p', { className: 'bt-set-hint bt-danger', role: 'status' }, tr('metadataError', { error: row.meta.error })) : null,
    open ? h('div', { id, className: 'bt-inventory-facts' },
      row.entryId ? h('code', null, row.entryId) : null,
      h('dl', null, facts.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))))) : null)
}

export function InventoryContent({ snapshot, query, setQuery, chosen, setChosen, locale }) {
  const tr = locale.bind('settings.pluginInventory')
  const { selected, presets, entries, rows, others, otherCount } = inventoryView(snapshot, chosen, query, locale)
  const [expanded, setExpanded] = useState(null)
  const [presetOpen, setPresetOpen] = useState(true)
  const [globalOpen, setGlobalOpen] = useState(false)
  const searching = query.trim() !== ''
  const nameOf = (preset) => {
    const name = inventoryPresetName(preset, locale)
    return preset.broken !== undefined ? tr('presetOptionBroken', { name }) : preset.isDefault ? tr('presetOptionDefault', { name }) : name
  }
  const cards = (items, preset) => h('div', { className: 'bt-set-card' }, items.map((row, index) => h(InventoryCard, {
    key: index, row, rowKey: `${preset?.id ?? 'global'}:${index}`, expanded, toggle: setExpanded, locale, tr, preset,
    providers: preset || row.enabled === true || row.fiberPhase === 'failed' ? [] : presets.filter(value => value.rows.some(item => item.moduleName === row.moduleName && item.enabled === true)),
  })))
  const group = (key, title, description, open, toggle, body, control) => h('section', { key, className: 'bt-inventory-group', 'data-plugin-scope': key },
    h('div', { className: 'bt-inventory-heading' },
      h('button', { type: 'button', className: 'bt-soft-sm', 'aria-expanded': open, onClick: toggle }, title), control),
    h('p', { className: 'bt-set-hint' }, description), open ? body : null)
  return h(Fragment, null,
    h('input', { type: 'search', className: 'bt-input', value: query, 'aria-label': tr('search'), placeholder: tr('search'), onChange: event => setQuery(event.target.value) }),
    !snapshot.entries.length && !presets.length ? h('p', { className: 'bt-set-hint' }, tr('empty')) : null,
    searching && !entries.length && !rows.length && !otherCount ? h('p', { className: 'bt-set-hint' }, tr('emptySearch')) : null,
    selected ? group('preset', tr('presetTitle'), tr('presetSubtitle'), searching || presetOpen,
      () => setPresetOpen(!presetOpen), h(Fragment, null,
        selected.broken !== undefined ? h('p', { role: 'alert', className: 'bt-danger' }, selected.broken) : null,
        rows.length ? cards(rows, selected) : null,
        otherCount ? h('p', { className: 'bt-set-hint' }, tr('matchesInOtherPresets', { count: String(otherCount) }),
          others.map(preset => h('button', { key: preset.id, type: 'button', className: 'bt-mini', onClick: () => setChosen(preset.id) }, inventoryPresetName(preset, locale)))) : null),
      h(PreferenceSelect, { label: tr('switcherLabel'), value: selected.id, options: presets.map(preset => ({ id: preset.id, label: nameOf(preset) })), pick: setChosen })) : null,
    snapshot.entries.length ? group('global', tr('globalTitle'), tr('globalSubtitle'), searching || globalOpen,
      () => setGlobalOpen(!globalOpen), entries.length ? cards(entries) : null) : null)
}

export function SettingsInventory({ preferences }) {
  const { inventory, locale } = preferences
  const tr = locale.bind('settings.pluginInventory')
  const client = useSyncExternalStore(listener => inventory.client.subscribe(listener), () => inventory.client.getSnapshot())
  const [state, setState] = useState({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(null)
  useEffect(() => {
    let active = true
    Promise.resolve().then(inventory.load).then(snapshot => { if (active) setState({ status: 'ready', snapshot }) },
      () => { if (active) setState({ status: 'error' }) })
    return () => { active = false }
  }, [inventory, attempt])
  return h('div', { className: 'bt-inventory', 'aria-busy': state.status === 'loading' },
    client.syncing ? h('p', { role: 'status' }, tr('clientSyncing')) : null,
    client.failures.length ? h('div', { role: 'alert' }, tr('clientSyncFailed'),
      h('ul', null, client.failures.map(failure => h('li', { key: failure.id }, `${failure.id}: ${failure.message}`))),
      h('button', { type: 'button', className: 'bt-soft-sm', disabled: client.syncing, onClick: inventory.retryClient }, tr('clientSyncRetry'))) : null,
    state.status === 'loading' ? h('p', { role: 'status' }, tr('loading')) : null,
    state.status === 'error' ? h('div', { role: 'alert' }, tr('error'), ' ',
      h('button', { type: 'button', className: 'bt-soft-sm', onClick: () => { setState({ status: 'loading' }); setAttempt(value => value + 1) } }, tr('retry'))) : null,
    state.status === 'ready' ? h(InventoryContent, { snapshot: state.snapshot, query, setQuery, chosen, setChosen, locale }) : null)
}

export function PluginsSettings({ tabs, renderSlot, preferences }) {
  const [chosen, setChosen] = useState(null)
  const [visited, setVisited] = useState([])
  const active = tabs.find(tab => tab.id === chosen) ?? tabs[0]
  const id = useId()
  useEffect(() => { if (active) setVisited(previous => previous.includes(active.id) ? previous : [...previous, active.id]) }, [active?.id])
  return h('div', { className: 'bt-inventory' },
    tabs.length === 0 ? h('p', { className: 'bt-set-hint' }, t('No results')) : null,
    tabs.length > 1 ? h('div', { className: 'bt-inventory-tabs', role: 'tablist', 'aria-label': t('Plugins') }, tabs.map((tab, index) => h('button', {
      key: tab.id, type: 'button', role: 'tab', className: 'bt-soft-sm', id: `${id}-tab-${tab.id}`,
      'aria-selected': tab === active, 'aria-controls': `${id}-panel-${tab.id}`, tabIndex: tab === active ? 0 : -1,
      onClick: () => setChosen(tab.id), onKeyDown: (event) => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined
        if (next === undefined) return
        event.preventDefault()
        setChosen(tabs[next].id)
        event.currentTarget.parentElement.children[next].focus()
      },
    }, tab.label))) : null,
    tabs.filter(tab => tab === active || visited.includes(tab.id)).map(tab => h('div', {
      key: tab.id, hidden: tab !== active, role: tabs.length > 1 ? 'tabpanel' : undefined,
      id: `${id}-panel-${tab.id}`, 'aria-labelledby': tabs.length > 1 ? `${id}-tab-${tab.id}` : undefined,
    }, tab.id === 'all' && preferences?.inventory ? h(SettingsInventory, { preferences }) : renderSlot('settings.plugins.tab', {}, { only: tab.id }))))
}
