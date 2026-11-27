// Cordis-style browser UI plugin runtime (docs/plans/2026-11-21-own-frontend.md).
// Plugins provide and inject services, load lazily per open page, register into compatible
// slots and themes, clean up automatically when dependencies leave or when unloaded,
// fail in isolation, and recover cleanly on retry (with cache-busted module reload).
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { registerTheme } from '../../../ds-bot/src/client/themes.js'
import { slots as defaultSlots } from './slots.js'

const EMPTY_PLUGINS = Object.freeze([])
const useIsomorphicLayoutEffect = typeof window !== 'undefined' && typeof document !== 'undefined' ? useLayoutEffect : useEffect

export function bustImportUrl(url, attempt = 0) {
  const raw = String(url ?? '')
  if (!raw || attempt <= 0) return raw
  const hashIdx = raw.indexOf('#')
  const hash = hashIdx >= 0 ? raw.slice(hashIdx) : ''
  const withoutHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  const queryIdx = withoutHash.indexOf('?')
  if (queryIdx < 0) return `${withoutHash}?retry=${attempt}${hash}`
  const base = withoutHash.slice(0, queryIdx)
  const params = new URLSearchParams(withoutHash.slice(queryIdx + 1))
  params.set('retry', String(attempt))
  return `${base}?${params.toString()}${hash}`
}

function defaultImporter(specifier) {
  return import(/* @vite-ignore */ specifier)
}

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
  const apply = typeof second === 'function' ? second : (typeof manifest?.apply === 'function' ? manifest.apply : null)
  const load = typeof manifest?.load === 'function' ? manifest.load : null
  const url = typeof manifest?.url === 'string' && manifest.url.trim() !== '' ? manifest.url.trim() : null
  const id = typeof manifest?.id === 'string' ? manifest.id.trim() : ''
  if (id === '' || (apply === null && load === null && url === null)) {
    throw new TypeError('UI plugin requires a non-empty string id and an apply(ctx), load(), or url entry')
  }
  const inject = Array.isArray(manifest.inject)
    ? [...new Set(manifest.inject.filter(name => typeof name === 'string' && name.trim() !== ''))]
    : []
  const pages = Array.isArray(manifest.pages)
    ? [...new Set(manifest.pages.filter(name => typeof name === 'string' && name.trim() !== ''))]
    : []
  const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : id
  return { id, name, inject, pages, apply, load, url, unloadOnLeave: manifest.unloadOnLeave === true }
}

/**
 * Create an isolated UI plugin runtime bound to a SlotRegistry.
 * @param {{ slots?: ReturnType<import('./slots.js').createSlotRegistry>, registerTheme?: typeof registerTheme, importer?: (url: string) => Promise<any> }} [options]
 */
export function createPluginRuntime({
  slots = defaultSlots,
  registerTheme: registerThemeFn = registerTheme,
  importer = defaultImporter,
} = {}) {
  const services = new Map()
  const plugins = new Map()
  const listeners = new Set()
  const pageCounts = new Map()
  const activePagesSet = new Set()
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
        pages: entry.pages,
        status: entry.status,
        error: entry.error,
        retryCount: entry.retryCount,
      })))
    for (const listener of Array.from(listeners)) {
      try { listener() } catch { /* listener failure */ }
    }
  }

  const pageReadyFor = entry => entry.pages.length === 0
    || entry.pages.some(page => activePagesSet.has(page))
    || (entry.everOpened && !entry.unloadOnLeave)
  const depsReadyFor = entry => entry.inject.every(dep => services.has(dep))
  const readyFor = entry => pageReadyFor(entry) && depsReadyFor(entry)

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
    entry.loadedApply = null
    deactivate(entry, 'error', message)
  }

  const runtimeRef = { retry: null }

  const runApply = (entry, gen, applyFn) => {
    if (entry.disposed || entry.generation !== gen) return
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
      retryCount: entry.retryCount,
      get: name => services.get(name),
      has: name => services.has(name),
      provide: (name, value) => track(provide(name, value)),
      slot: (spec, component) => track(slots.register({ ...spec, pluginId: entry.id, runtime: runtimeRef.api }, component)),
      theme: (id, themeDef) => track(registerThemeFn(id, themeDef)),
      effect: (fn) => {
        if (typeof fn !== 'function') throw new TypeError('ctx.effect requires a function')
        if (entry.disposed || entry.generation !== gen) return () => {}
        const cleanup = fn()
        return typeof cleanup === 'function' ? track(cleanup) : () => {}
      },
    })

    try {
      const outcome = applyFn(ctx)
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

  const activate = (entry) => {
    if (entry.disposed || entry.status === 'active' || entry.status === 'loading' || entry.status === 'error') return
    if (!readyFor(entry)) return
    entry.everOpened = true
    const gen = ++entry.generation
    const applyFn = entry.apply ?? entry.loadedApply
    if (typeof applyFn === 'function') {
      runApply(entry, gen, applyFn)
      return
    }
    entry.status = 'loading'
    entry.error = null
    const attempt = entry.retryCount
    let loadPromise
    try {
      if (entry.load) {
        loadPromise = Promise.resolve(entry.load({
          attempt,
          bust: target => bustImportUrl(target, attempt),
        }))
      } else {
        loadPromise = Promise.resolve(importer(bustImportUrl(entry.url, attempt)))
      }
    } catch (error) {
      fail(entry, error)
      return
    }
    loadPromise.then((loaded) => {
      if (entry.disposed || entry.generation !== gen) return
      const resolved = typeof loaded === 'function'
        ? loaded
        : (typeof loaded?.apply === 'function'
            ? loaded.apply
            : (typeof loaded?.default === 'function' ? loaded.default : null))
      if (typeof resolved !== 'function') {
        fail(entry, new TypeError(`UI plugin "${entry.id}" module did not export an apply function`))
        scheduleReconcile()
        return
      }
      entry.loadedApply = resolved
      if (!readyFor(entry)) {
        entry.status = pageReadyFor(entry) ? 'waiting' : 'idle'
        scheduleReconcile()
        return
      }
      runApply(entry, gen, resolved)
      scheduleReconcile()
    }, (error) => {
      if (entry.disposed || entry.generation !== gen) return
      fail(entry, error)
      scheduleReconcile()
    })
  }

  const runReconcileLoop = () => {
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
            deactivate(entry, pageReadyFor(entry) ? 'waiting' : 'idle', null)
            progressed = true
          } else if ((entry.status === 'waiting' || entry.status === 'idle') && readyFor(entry)) {
            activate(entry)
            progressed = true
          } else if (entry.status === 'waiting' && !pageReadyFor(entry)) {
            entry.status = 'idle'
            progressed = true
          } else if (entry.status === 'idle' && pageReadyFor(entry) && !depsReadyFor(entry)) {
            entry.status = 'waiting'
            progressed = true
          }
        }
      }
    } while (needsReconcile)
  }

  const scheduleReconcile = () => {
    if (reconciling) {
      needsReconcile = true
      return
    }
    reconciling = true
    try {
      runReconcileLoop()
    } finally {
      reconciling = false
    }
    emit()
  }

  const serviceStacks = new Map()

  function provide(name, value) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('Service name must be a non-empty string')
    }
    const token = { value }
    let stack = serviceStacks.get(name)
    if (!stack) {
      stack = []
      serviceStacks.set(name, stack)
    }
    stack.push(token)
    services.set(name, value)
    scheduleReconcile()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const currentStack = serviceStacks.get(name)
      if (!currentStack) return
      const idx = currentStack.indexOf(token)
      if (idx === -1) return
      const wasTop = idx === currentStack.length - 1
      currentStack.splice(idx, 1)
      if (currentStack.length === 0) {
        serviceStacks.delete(name)
        if (wasTop) {
          services.delete(name)
          scheduleReconcile()
        }
        return
      }
      if (wasTop) {
        services.set(name, currentStack[currentStack.length - 1].value)
        scheduleReconcile()
      }
    }
  }

  function enterPage(page) {
    if (typeof page !== 'string' || page.trim() === '') return () => {}
    const key = page.trim()
    const next = (pageCounts.get(key) ?? 0) + 1
    pageCounts.set(key, next)
    if (next === 1) {
      activePagesSet.add(key)
      scheduleReconcile()
    }
    let left = false
    return () => {
      if (left) return
      left = true
      const count = (pageCounts.get(key) ?? 1) - 1
      if (count <= 0) {
        pageCounts.delete(key)
        activePagesSet.delete(key)
        scheduleReconcile()
      } else {
        pageCounts.set(key, count)
      }
    }
  }

  function setPages(pages) {
    pageCounts.clear()
    activePagesSet.clear()
    for (const raw of pages ?? []) {
      if (typeof raw === 'string' && raw.trim() !== '') {
        const key = raw.trim()
        pageCounts.set(key, 1)
        activePagesSet.add(key)
      }
    }
    scheduleReconcile()
  }

  function use(first, second) {
    const { id, name, inject, pages, apply, load, url, unloadOnLeave } = normalizePlugin(first, second)
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
      pages: Object.freeze(pages),
      apply,
      load,
      url,
      unloadOnLeave,
      loadedApply: null,
      everOpened: pages.length === 0,
      status: pages.length === 0 ? 'waiting' : 'idle',
      error: null,
      retryCount: 0,
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

  function retry(id, { force = false } = {}) {
    const entry = plugins.get(id)
    if (entry === undefined || entry.disposed) return false
    if (entry.retrying) return false
    if (entry.status !== 'error' && !force) return false
    entry.retrying = true
    const wasReconciling = reconciling
    reconciling = true
    try {
      if (entry.status === 'active' || entry.status === 'loading') {
        deactivate(entry, 'retrying', null)
      } else {
        entry.generation += 1
        entry.status = 'retrying'
        entry.error = null
      }
      // Let dependents observe withdrawn services and deactivate cleanly before re-activation.
      runReconcileLoop()
      entry.loadedApply = null
      entry.retryCount += 1
      entry.status = pageReadyFor(entry) ? 'waiting' : 'idle'
      entry.error = null
      needsReconcile = true
    } finally {
      entry.retrying = false
      if (!wasReconciling) reconciling = false
    }
    if (!wasReconciling) scheduleReconcile()
    return entry.status === 'active' || entry.status === 'loading'
  }

  function disposeAll() {
    const wasReconciling = reconciling
    reconciling = true
    try {
      for (const entry of Array.from(plugins.values()).reverse()) {
        entry.disposed = true
        deactivate(entry, 'waiting', null)
      }
      plugins.clear()
      services.clear()
      serviceStacks.clear()
      pageCounts.clear()
      activePagesSet.clear()
      needsReconcile = false
    } finally {
      if (!wasReconciling) reconciling = false
    }
    emit()
  }

  const api = {
    slots,
    provide,
    get: name => services.get(name),
    has: name => services.has(name),
    enterPage,
    setPages,
    activePages: () => Object.freeze(Array.from(activePagesSet)),
    use,
    retry,
    dispose: disposeAll,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  runtimeRef.api = api
  return api
}

export const pluginRuntime = createPluginRuntime({ slots: defaultSlots })

export function usePlugins(runtime = pluginRuntime) {
  const subscribe = useCallback(listener => runtime.subscribe(listener), [runtime])
  const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function usePluginPage(page, active = true, runtime = pluginRuntime) {
  useIsomorphicLayoutEffect(() => {
    if (!active || !page) return undefined
    return runtime.enterPage(page)
  }, [runtime, page, active])
}
