// Cordis-style browser UI plugin runtime (docs/plans/2026-11-21-own-frontend.md).
// Plugins provide and inject services, register into compatible slots and themes,
// clean up automatically when dependencies leave or when unloaded, and fail in isolation.
import { useCallback, useSyncExternalStore } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { registerTheme } from '../../../ds-bot/src/client/themes.js'
import { slots as defaultSlots } from './slots.js'

const EMPTY_PLUGINS = Object.freeze([])

function runDisposers(disposers, pluginId) {
  for (let i = disposers.length - 1; i >= 0; i -= 1) {
    try {
      disposers[i]?.()
    } catch (error) {
      console.error(`ds-bot: plugin "${pluginId}" cleanup failed`, error)
      noteClientError?.(`plugin-dispose:${pluginId}`, error)
    }
  }
}

function normalizePlugin(first, second) {
  const manifest = typeof first === 'object' && first !== null ? first : null
  const apply = typeof second === 'function' ? second : manifest?.apply
  const id = typeof manifest?.id === 'string' ? manifest.id.trim() : ''
  if (id === '' || typeof apply !== 'function') {
    throw new TypeError('UI plugin requires a non-empty string id and an apply(ctx) function')
  }
  const inject = Array.isArray(manifest.inject)
    ? [...new Set(manifest.inject.filter(name => typeof name === 'string' && name.trim() !== ''))]
    : []
  const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : id
  return { id, name, inject, apply }
}

/**
 * Create an isolated UI plugin runtime bound to a SlotRegistry.
 * @param {{ slots?: ReturnType<import('./slots.js').createSlotRegistry>, registerTheme?: typeof registerTheme }} [options]
 */
export function createPluginRuntime({ slots = defaultSlots, registerTheme: registerThemeFn = registerTheme } = {}) {
  const services = new Map()
  const plugins = new Map()
  const listeners = new Set()
  let snapshot = EMPTY_PLUGINS
  let reconciling = false
  let needsReconcile = false

  const emit = () => {
    snapshot = plugins.size === 0
      ? EMPTY_PLUGINS
      : Object.freeze(Array.from(plugins.values()).map(entry => Object.freeze({
        id: entry.id,
        name: entry.name,
        inject: entry.inject,
        status: entry.status,
        error: entry.error,
      })))
    for (const listener of Array.from(listeners)) {
      try { listener() } catch { /* listener failure */ }
    }
  }

  const readyFor = entry => entry.inject.every(dep => services.has(dep))

  const deactivate = (entry, nextStatus = 'waiting', errorMessage = null) => {
    entry.generation += 1
    const disposers = entry.disposers
    entry.disposers = []
    entry.status = nextStatus
    entry.error = errorMessage
    if (disposers.length > 0) runDisposers(disposers, entry.id)
  }

  const fail = (entry, error) => {
    const message = error?.message ?? String(error)
    console.error(`ds-bot: UI plugin "${entry.id}" failed`, error)
    noteClientError?.(`plugin:${entry.id}`, error)
    deactivate(entry, 'error', message)
  }

  const activate = (entry) => {
    if (entry.disposed || entry.status === 'active' || entry.status === 'error') return
    if (!readyFor(entry)) return
    const gen = ++entry.generation
    const disposers = []
    entry.disposers = disposers
    entry.status = 'active'
    entry.error = null

    const track = (disposer) => {
      if (typeof disposer !== 'function') return () => {}
      if (entry.disposed || entry.generation !== gen) {
        try { disposer() } catch { /* stale disposer */ }
        return () => {}
      }
      let ran = false
      const safe = () => {
        if (ran) return
        ran = true
        const idx = disposers.indexOf(safe)
        if (idx >= 0) disposers.splice(idx, 1)
        disposer()
      }
      disposers.push(safe)
      return safe
    }

    const ctx = Object.freeze({
      id: entry.id,
      get: name => services.get(name),
      has: name => services.has(name),
      provide: (name, value) => track(provide(name, value)),
      slot: (spec, component) => track(slots.register(spec, component)),
      theme: (id, themeDef) => track(registerThemeFn(id, themeDef)),
      effect: (fn) => {
        if (typeof fn !== 'function') throw new TypeError('ctx.effect requires a function')
        if (entry.disposed || entry.generation !== gen) return () => {}
        const cleanup = fn()
        return typeof cleanup === 'function' ? track(cleanup) : () => {}
      },
    })

    try {
      const outcome = entry.apply(ctx)
      if (typeof outcome === 'function') track(outcome)
      else if (outcome !== null && outcome !== undefined && typeof outcome.then === 'function') {
        Promise.resolve(outcome).then((resolved) => {
          if (typeof resolved === 'function') {
            if (entry.disposed || entry.generation !== gen) {
              try { resolved() } catch { /* late disposer */ }
            } else {
              track(resolved)
            }
          }
        }, (error) => {
          if (entry.disposed || entry.generation !== gen) return
          fail(entry, error)
          scheduleReconcile()
        })
      }
    } catch (error) {
      fail(entry, error)
    }
  }

  const scheduleReconcile = () => {
    if (reconciling) {
      needsReconcile = true
      return
    }
    reconciling = true
    try {
      do {
        needsReconcile = false
        let progressed = true
        let passes = 0
        while (progressed && passes < 32) {
          progressed = false
          passes += 1
          for (const entry of Array.from(plugins.values())) {
            if (entry.disposed) continue
            if (entry.status === 'active' && !readyFor(entry)) {
              deactivate(entry, 'waiting', null)
              progressed = true
            } else if (entry.status === 'waiting' && readyFor(entry)) {
              activate(entry)
              progressed = true
            }
          }
        }
      } while (needsReconcile)
    } finally {
      reconciling = false
    }
    emit()
  }

  function provide(name, value) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('Service name must be a non-empty string')
    }
    const hadPrevious = services.has(name)
    const previous = services.get(name)
    services.set(name, value)
    scheduleReconcile()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (services.get(name) !== value) return
      if (hadPrevious) services.set(name, previous)
      else services.delete(name)
      scheduleReconcile()
    }
  }

  function use(first, second) {
    const { id, name, inject, apply } = normalizePlugin(first, second)
    const existing = plugins.get(id)
    if (existing !== undefined) {
      existing.disposed = true
      deactivate(existing, 'waiting', null)
      plugins.delete(id)
    }
    const entry = {
      id,
      name,
      inject: Object.freeze(inject),
      apply,
      status: 'waiting',
      error: null,
      disposers: [],
      generation: 0,
      disposed: false,
    }
    plugins.set(id, entry)
    scheduleReconcile()
    return () => {
      if (entry.disposed) return
      entry.disposed = true
      deactivate(entry, 'waiting', null)
      if (plugins.get(id) === entry) plugins.delete(id)
      scheduleReconcile()
    }
  }

  function retry(id) {
    const entry = plugins.get(id)
    if (entry === undefined || entry.disposed) return false
    if (entry.status !== 'error') return false
    entry.status = 'waiting'
    entry.error = null
    scheduleReconcile()
    return entry.status === 'active'
  }

  function disposeAll() {
    for (const entry of Array.from(plugins.values()).reverse()) {
      entry.disposed = true
      deactivate(entry, 'waiting', null)
    }
    plugins.clear()
    services.clear()
    emit()
  }

  return {
    slots,
    provide,
    get: name => services.get(name),
    has: name => services.has(name),
    use,
    retry,
    dispose: disposeAll,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const pluginRuntime = createPluginRuntime({ slots: defaultSlots })

export function usePlugins(runtime = pluginRuntime) {
  const subscribe = useCallback(listener => runtime.subscribe(listener), [runtime])
  const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
