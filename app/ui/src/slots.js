// Minimal slot lookup for the desktop window's own interface (docs/plans/2026-11-21-own-frontend.md).
// Slot names and owner props match DSH (`tool.call.toolview`, `conversation.chat.node`) so the
// upcoming UI plugin runtime can plug directly into these seats without rewriting chat rendering.
import { Component, Fragment, createElement as h, useCallback, useSyncExternalStore } from 'react'
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
    register({ name, key, id, priority = 0, meta, pluginId, runtime, onRetry }, component) {
      if (typeof name !== 'string' || name === '' || !isReactComponent(component)) {
        throw new TypeError('Slot registration requires a slot name and component')
      }
      const entry = { key, id: id ?? key, priority, order: ++seq, meta, pluginId, runtime, onRetry, component }
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
    resolveEntry(name, key) {
      const entries = bySlot.get(name)
      if (!entries || entries.length === 0) return undefined
      return key === undefined
        ? entries.find(entry => entry.key === undefined)
        : entries.find(entry => entry.key === key)
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

// One plugin view throwing must only affect its own block and offer Retry that actually
// resets cached lazy modules / re-activates the owning plugin and remounts fresh.
export class SlotErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, resetKey: props.resetKey, retryCount: 0 }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey, retryCount: 0 }
  }

  componentDidCatch(error) {
    console.error('ds-bot: slot view failed', this.props.slotName, error)
    noteClientError?.(`slot:${this.props.slotName ?? 'unknown'}`, error)
  }

  retry() {
    this.props.onRetry?.()
    if (this.props.pluginId && typeof this.props.runtime?.retry === 'function') {
      this.props.runtime.retry(this.props.pluginId, { force: true })
    }
    this.setState(prev => ({ failed: false, retryCount: (prev.retryCount ?? 0) + 1 }))
  }

  render() {
    if (!this.state.failed) {
      return this.state.retryCount > 0
        ? h(Fragment, { key: this.state.retryCount }, this.props.children)
        : this.props.children
    }
    return h('div', { className: 'dsb-slot-error', role: 'alert' },
      h('span', null, t('This view could not be shown.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.retry() }, t('Retry')))
  }
}

export function SlotOutlet({ registry = slots, name, slotKey, resetKey, props, fallback }) {
  const subscribe = useCallback(listener => registry.subscribe(name, listener), [registry, name])
  const getSnapshot = useCallback(() => (
    typeof registry.resolveEntry === 'function' ? registry.resolveEntry(name, slotKey) : registry.resolve(name, slotKey)
  ), [registry, name, slotKey])
  const resolved = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const Registered = typeof resolved === 'object' && resolved !== null && 'component' in resolved ? resolved.component : resolved
  const pluginId = typeof resolved === 'object' && resolved !== null ? resolved.pluginId : undefined
  const runtime = typeof resolved === 'object' && resolved !== null ? resolved.runtime : undefined
  const onRetry = typeof resolved === 'object' && resolved !== null ? resolved.onRetry : undefined
  if (Registered !== undefined) {
    return h(SlotErrorBoundary, {
      slotName: `${name}:${slotKey ?? ''}`,
      resetKey: resetKey ?? slotKey,
      pluginId,
      runtime,
      onRetry: () => {
        Registered?.reset?.()
        onRetry?.()
      },
    }, h(Registered, props))
  }
  return typeof fallback === 'function' ? fallback() : (fallback ?? null)
}

export function ShellOverlayHost({ registry = slots, views }) {
  const entries = useSlotEntries(registry, SHELL_OVERLAY_SLOT)
  if (entries.length === 0) return null
  return h(Fragment, null, entries.map((entry, idx) => h(SlotErrorBoundary, {
    key: entry.id ?? entry.key ?? idx,
    slotName: `${SHELL_OVERLAY_SLOT}:${entry.id ?? idx}`,
    resetKey: entry.id ?? entry.key ?? idx,
    pluginId: entry.pluginId ?? entry.meta?.pluginId ?? null,
    runtime: entry.runtime ?? entry.meta?.runtime ?? null,
    onRetry: (typeof entry.component?.reset === 'function' || typeof entry.onRetry === 'function')
      ? () => {
        entry.component?.reset?.()
        entry.onRetry?.()
      }
      : undefined,
  }, h(entry.component, views))))
}
