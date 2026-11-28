import { Component, Fragment, createElement as h, useCallback, useSyncExternalStore } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { reloadWindowSafely } from './retryable-lazy.js'

export const TOOL_VIEW_SLOT = 'tool.call.toolview'
export const CHAT_NODE_SLOT = 'conversation.chat.node'
export const RIGHT_PANE_TAB_SLOT = 'sidebar.right.pane.tab'
export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_GENERAL_ITEM_SLOT = 'settings.general.item'
export const SHELL_OVERLAY_SLOT = 'shell.overlay'
export const SIDEBAR_PANEL_LIST_SLOT = 'sidebar.panellist'
export const SIDEBAR_ENTRY_SLOT = 'sidebar.entry'
export const SIDEBAR_FOOTER_ACTION_SLOT = 'sidebar.footer.action'
export const MAIN_PANEL_SLOT = 'main'

const EMPTY_LIST = Object.freeze([])
const ROOT_LIST = Object.freeze({ kind: 'list', scope: 'root' })
const SESSION_KEYED = Object.freeze({ kind: 'keyed', scope: 'session' })
const HOST_SPECS = [
  [TOOL_VIEW_SLOT, SESSION_KEYED],
  [CHAT_NODE_SLOT, SESSION_KEYED],
  [RIGHT_PANE_TAB_SLOT, SESSION_KEYED],
  [SETTINGS_SECTION_SLOT, ROOT_LIST],
  ['settings.section.icon', Object.freeze({ ...ROOT_LIST, inline: true })],
  [SETTINGS_GENERAL_ITEM_SLOT, ROOT_LIST],
  ['settings.action', ROOT_LIST],
  [SHELL_OVERLAY_SLOT, ROOT_LIST],
  [SIDEBAR_PANEL_LIST_SLOT, ROOT_LIST],
  [SIDEBAR_ENTRY_SLOT, ROOT_LIST],
  [SIDEBAR_FOOTER_ACTION_SLOT, ROOT_LIST],
  [MAIN_PANEL_SLOT, Object.freeze({ kind: 'keyed', scope: 'root' })],
]

const isReactComponent = value => typeof value === 'function'
  || (typeof value === 'object' && value !== null && '$$typeof' in value)

function installInjection(callback) {
  const effect = callback()
  if (typeof effect === 'function') return effect
  const disposers = []
  const dispose = () => {
    let failure
    while (disposers.length) {
      try { disposers.pop()() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }
  try {
    if (effect?.[Symbol.iterator]) {
      for (const cleanup of effect) if (typeof cleanup === 'function') disposers.push(cleanup)
    }
  } catch (error) {
    try { dispose() } catch { /* Preserve the setup failure. */ }
    throw error
  }
  return dispose
}

export function createSlotRegistry() {
  const specs = new Map(HOST_SPECS)
  const injections = new Map()
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
    spec(name) {
      return specs.get(name)
    },
    declare(name, spec) {
      if (specs.has(name)) throw new Error(`Slot "${name}" is already declared`)
      specs.set(name, spec)
      const update = () => { for (const sync of [...(injections.get(name) ?? [])]) sync() }
      let active = true
      const undeclare = () => {
        if (!active) return
        active = false
        specs.delete(name)
        update()
      }
      try { update() } catch (error) {
        undeclare()
        throw error
      }
      return undeclare
    },
    inject(name, callback) {
      let group = injections.get(name)
      if (!group) injections.set(name, group = new Set())
      let cleanup
      const stop = () => {
        group.delete(sync)
        if (group.size === 0 && injections.get(name) === group) injections.delete(name)
        const dispose = cleanup
        cleanup = undefined
        dispose?.()
      }
      const sync = () => {
        if (!group.has(sync)) return
        if (specs.has(name)) {
          if (cleanup) return
          try {
            const dispose = installInjection(callback)
            if (group.has(sync) && specs.has(name)) cleanup = dispose
            else dispose()
          } catch (error) {
            stop()
            throw error
          }
        } else {
          const dispose = cleanup
          cleanup = undefined
          dispose?.()
        }
      }
      group.add(sync)
      sync()
      return stop
    },
    register({ name, key, id, priority, order, label, inject, meta, pluginId, runtime, onRetry }, component) {
      if (typeof name !== 'string' || name === '' || !isReactComponent(component)) {
        throw new TypeError('Slot registration requires a slot name and component')
      }
      const options = Object.fromEntries(Object.entries({ key, id, priority, order, label }).filter(([, value]) => value !== undefined))
      const entry = { key, id: id ?? key, priority: priority ?? 0, order: ++seq, options, inject, meta, pluginId, runtime, onRetry, component }
      const entries = listOf(name)
      entries.push(entry)
      entries.sort((a, b) => (a.priority - b.priority)
        || ((specs.get(name)?.kind === 'list') ? ((a.options.order ?? 0) - (b.options.order ?? 0)) : 0)
        || (a.order - b.order))
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
    entries(name) {
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
    this.state = { failed: false, resetKey: props.resetKey, retryCount: 0, reloadNotice: null }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey, retryCount: 0, reloadNotice: null }
  }

  componentDidCatch(error) {
    console.error('ds-bot: slot view failed', this.props.slotName, error)
    noteClientError?.(`slot:${this.props.slotName ?? 'unknown'}`, error)
    this.props.onError?.(error)
  }

  retry() {
    this.props.onRetry?.()
    if (this.props.pluginId && typeof this.props.runtime?.retry === 'function') {
      this.props.runtime.retry(this.props.pluginId, { force: true })
    }
    this.setState(prev => ({ failed: false, retryCount: (prev.retryCount ?? 0) + 1, reloadNotice: null }))
  }

  reload() {
    if (typeof this.props.onReload === 'function') {
      this.props.onReload()
      return
    }
    reloadWindowSafely({
      onBlocked: (reason) => { this.setState({ reloadNotice: reason }) },
    })
  }

  render() {
    if (!this.state.failed) {
      return this.state.retryCount > 0
        ? h(Fragment, { key: this.state.retryCount }, this.props.children)
        : this.props.children
    }
    // First failure gets a cache-busted in-place Retry; if that still fails (e.g. a
    // statically imported sub-chunk is poisoned in Chromium's module map), offer Reload window.
    const needsReload = (this.state.retryCount ?? 0) >= 1
    return h('div', { className: 'dsb-slot-error', role: 'alert' },
      h('span', null, this.state.reloadNotice ?? t('This view could not be shown.')),
      needsReload
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.reload() }, t('Reload window'))
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.retry() }, t('Retry')))
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

function SlotComponent({ entry, owner }) {
  return h(entry.component, { ...entry.inject?.(), ...owner })
}

export function SlotEntryView({ name, entry, owner, frame: Frame, frameProps }) {
  const view = h(SlotComponent, { entry, owner })
  return h(SlotErrorBoundary, {
    slotName: `${name}:${entry.id ?? ''}`,
    resetKey: entry.order,
    pluginId: entry.pluginId,
    runtime: entry.runtime,
    onRetry: () => {
      entry.component.reset?.()
      entry.onRetry?.()
    },
  }, Frame ? h(Frame, { ...frameProps, entry }, view) : view)
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
