import { Fragment, createElement as h } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import {
  MAIN_PANEL_SLOT,
  SIDEBAR_ENTRY_SLOT,
  SIDEBAR_FOOTER_ACTION_SLOT,
  SIDEBAR_PANEL_LIST_SLOT,
  SlotEntryView,
  slots,
  useSlotEntries,
} from './slots.js'
import './sidebar-slots.css'

function distinctRows(entries) {
  const seen = new Set()
  return entries.filter(entry => {
    const id = entry.id ?? entry.order
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function useSidebarPanel(registry, id) {
  const entries = useSlotEntries(registry, MAIN_PANEL_SLOT)
  return id == null ? undefined : entries.find(entry => entry.key === id)
}

function PanelRow({ entry, wide, active, onSelectPanel, children }) {
  const labelSource = entry.options.label ?? entry.meta?.label
  const label = (typeof labelSource === 'function' ? labelSource() : labelSource) || entry.id
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, title: wide ? undefined : label,
    'aria-current': active ? 'page' : undefined,
    onClick: () => onSelectPanel(entry.id),
  },
  h('span', { 'aria-hidden': true }, children),
  wide ? h('span', { className: 'bt-row-title' }, label) : null)
}

export function SidebarSlotRows({ registry = slots, wide, activePanel, onSelectPanel }) {
  const rows = useSlotEntries(registry, SIDEBAR_PANEL_LIST_SLOT)
  const panels = useSlotEntries(registry, MAIN_PANEL_SLOT)
  const entries = useSlotEntries(registry, SIDEBAR_ENTRY_SLOT)
  const panelKeys = new Set(panels.map(entry => entry.key))
  if (rows.length === 0 && entries.length === 0) return null
  return h(Fragment, null,
    distinctRows(rows).map(entry => {
      const active = entry.id === activePanel
      return h(SlotEntryView, {
        key: entry.id ?? entry.order, name: SIDEBAR_PANEL_LIST_SLOT, entry, owner: { size: wide ? 16 : 18, active },
        frame: panelKeys.has(entry.id) ? PanelRow : undefined,
        frameProps: { wide, active, onSelectPanel },
      })
    }),
    distinctRows(entries).map(entry => h(SlotEntryView, {
      key: entry.id ?? entry.order, name: SIDEBAR_ENTRY_SLOT, entry, owner: { wide },
    })))
}

export function SidebarFooterActions({ registry = slots, wide, className }) {
  const entries = useSlotEntries(registry, SIDEBAR_FOOTER_ACTION_SLOT)
  if (entries.length === 0) return null
  return h(className ? 'div' : Fragment, className ? { className } : null, distinctRows(entries).map(entry => h(SlotEntryView, {
    key: entry.id ?? entry.order, name: SIDEBAR_FOOTER_ACTION_SLOT, entry, owner: { wide },
  })))
}

export function SidebarMainPanel({ entry, onClose }) {
  return h('section', { className: 'dsb-sidebar-plugin-panel' },
    h('div', { className: 'dsb-sidebar-plugin-panel-head' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Close'))),
    h(SlotEntryView, { key: entry.key, name: MAIN_PANEL_SLOT, entry }))
}
