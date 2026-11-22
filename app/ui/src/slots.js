// Minimal slot lookup for the desktop window's own interface (docs/plans/2026-11-21-own-frontend.md).
// Slot names and owner props match DSH (`tool.call.toolview`, `conversation.chat.node`) so the
// upcoming UI plugin runtime can plug directly into these seats without rewriting chat rendering.
import { Component, createElement as h, useCallback, useSyncExternalStore } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { t } from '../../../ds-bot/src/client/i18n.js'

export const TOOL_VIEW_SLOT = 'tool.call.toolview'
export const CHAT_NODE_SLOT = 'conversation.chat.node'
export const RIGHT_PANE_TAB_SLOT = 'sidebar.right.pane.tab'
export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_GENERAL_ITEM_SLOT = 'settings.general.item'
export const SHELL_OVERLAY_SLOT = 'shell.overlay'

const EMPTY_LIST = Object.freeze([])

const isReactComponent = value => typeof value === 'function'
  || (typeof value === 'object' && value !== null && '$$typeof' in value)

export function createSlotRegistry() {
  const bySlot = new Map()
  const snapshots = new Map()
  const listeners = new Map()
  let seq = 0

  const notify = (name) => {
    const entries = bySlot.get(name)
    snapshots.set(name, entries && entries.length > 0 ? Object.freeze(entries.slice()) : EMPTY_LIST)
    const group = listeners.get(name)
    if (!group) return
    for (const listener of Array.from(group)) listener()
  }

  const listOf = (name) => {
    let entries = bySlot.get(name)
    if (!entries) {
      entries = []
      bySlot.set(name, entries)
    }
    return entries
  }

  return {
    register({ name, key, id, priority = 0, meta }, component) {
      if (typeof name !== 'string' || name === '' || !isReactComponent(component)) {
        throw new TypeError('Slot registration requires a slot name and component')
      }
      const entry = { key, id: id ?? key, priority, order: ++seq, meta, component }
      const entries = listOf(name)
      entries.push(entry)
      entries.sort((a, b) => (a.priority - b.priority) || (a.order - b.order))
      notify(name)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const current = bySlot.get(name)
        if (!current) return
        const at = current.indexOf(entry)
        if (at >= 0) current.splice(at, 1)
        notify(name)
      }
    },
    list(name) {
      return snapshots.get(name) ?? EMPTY_LIST
    },
    resolve(name, key) {
      const entries = bySlot.get(name)
      if (!entries || entries.length === 0) return undefined
      const match = key === undefined
        ? entries.find(entry => entry.key === undefined)
        : entries.find(entry => entry.key === key)
      return match?.component
    },
    subscribe(name, listener) {
      let group = listeners.get(name)
      if (!group) {
        group = new Set()
        listeners.set(name, group)
      }
      group.add(listener)
      return () => { group.delete(listener) }
    },
  }
}

// Default window-wide registry; the UI plugin runtime registers into this.
export const slots = createSlotRegistry()
export const defaultSlots = slots

export function useSlotEntries(registry = slots, name) {
  const subscribe = useCallback(listener => registry.subscribe(name, listener), [registry, name])
  const getSnapshot = useCallback(() => registry.list(name), [registry, name])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// One plugin view throwing must only affect its own block and offer Retry.
export class SlotErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, resetKey: props.resetKey }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey }
  }

  componentDidCatch(error) {
    console.error('ds-bot: slot view failed', this.props.slotName, error)
    noteClientError?.(`slot:${this.props.slotName ?? 'unknown'}`, error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return h('div', { className: 'dsb-slot-error', role: 'alert' },
      h('span', null, t('This view could not be shown.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.setState({ failed: false }) }, t('Retry')))
  }
}

export function SlotOutlet({ registry = slots, name, slotKey, resetKey, props, fallback }) {
  const subscribe = useCallback(listener => registry.subscribe(name, listener), [registry, name])
  const getSnapshot = useCallback(() => registry.resolve(name, slotKey), [registry, name, slotKey])
  const Registered = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (Registered !== undefined) {
    return h(SlotErrorBoundary, { slotName: `${name}:${slotKey ?? ''}`, resetKey: resetKey ?? slotKey },
      h(Registered, props))
  }
  return typeof fallback === 'function' ? fallback() : (fallback ?? null)
}
