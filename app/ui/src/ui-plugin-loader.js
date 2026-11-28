// Loads and hot-reloads external desktop UI & theme plugins exposed by `dsbot-engine`
// at `/api/ui-plugins/manifest` (local `<DSH_HOME>/ui-plugins/` folders and enabled
// profile bundles declaring `dsBot.ui`).
import { useCallback, useSyncExternalStore } from 'react'
import { pluginRuntime as defaultRuntime } from './plugin-runtime.js'

const MANIFEST_URL = '/api/ui-plugins/manifest'

const state = {
  uiPluginsDir: null,
  loaded: false,
  error: '',
}
let metaSnapshot = Object.freeze({ ...state })
const listeners = new Set()
const mounted = new Map()
const pluginEpochs = new Map()
let inFlight = null
let syncSeq = 0

function emitMeta() {
  metaSnapshot = Object.freeze({ ...state })
  for (const listener of Array.from(listeners)) {
    try { listener() } catch { /* listener failure */ }
  }
}

function defaultModuleImporter(specifier) {
  return import(/* @vite-ignore */ specifier)
}

function descriptorSignature(desc, epoch) {
  return JSON.stringify({
    epoch,
    id: desc.id,
    name: desc.name,
    source: desc.source,
    kind: desc.kind,
    url: desc.url ?? null,
    theme: desc.theme ?? null,
    pages: desc.pages ?? [],
    inject: desc.inject ?? [],
    error: desc.error ?? null,
  })
}

function registerDescriptor(runtime, desc, epoch, importer) {
  const base = {
    id: desc.id,
    name: desc.name || desc.id,
    source: desc.source || 'local',
    kind: desc.kind || (desc.url ? 'esm' : 'theme'),
    external: true,
    ...(desc.packageName ? { packageName: desc.packageName } : {}),
    ...(desc.dir ? { dir: desc.dir } : {}),
    pages: Array.isArray(desc.pages) ? desc.pages : [],
    inject: Array.isArray(desc.inject) ? desc.inject : [],
  }

  if (typeof desc.error === 'string' && desc.error.trim() !== '') {
    return runtime.use({ ...base, initialError: desc.error.trim() })
  }

  if (desc.url) {
    const versionedUrl = epoch > 0
      ? `${desc.url}${desc.url.includes('?') ? '&' : '?'}v=${epoch}`
      : desc.url
    if (desc.theme) {
      return runtime.use({
        ...base,
        load: async ({ bust }) => {
          const mod = await importer(bust(versionedUrl))
          const fn = typeof mod === 'function'
            ? mod
            : (typeof mod?.apply === 'function' ? mod.apply : (typeof mod?.default === 'function' ? mod.default : null))
          if (typeof fn !== 'function') {
            throw new TypeError(`UI plugin "${desc.id}" module did not export an apply function`)
          }
          return (ctx) => {
            ctx.theme(desc.theme.id, desc.theme)
            return fn(ctx)
          }
        },
      })
    }
    return runtime.use({ ...base, url: versionedUrl })
  }

  if (desc.theme) {
    return runtime.use({ ...base, kind: 'theme' }, (ctx) => {
      ctx.theme(desc.theme.id, desc.theme)
    })
  }

  return runtime.use({ ...base, initialError: 'UI plugin manifest has neither entry nor theme.' })
}

export async function syncExternalUiPlugins(runtime = defaultRuntime, {
  fetchImpl = globalThis.fetch,
  importer = defaultModuleImporter,
  forceReload = false,
  onlyId = null,
} = {}) {
  if (typeof fetchImpl !== 'function') return metaSnapshot
  const mySeq = ++syncSeq
  const targetId = typeof onlyId === 'string' && onlyId.trim() !== '' ? onlyId.trim() : null
  try {
    const res = await fetchImpl(MANIFEST_URL, { cache: 'no-store' })
    if (mySeq !== syncSeq) return metaSnapshot
    if (!res.ok) {
      if (res.status !== 404) {
        state.error = `HTTP ${res.status}`
        emitMeta()
      }
      return metaSnapshot
    }
    const payload = await res.json()
    if (mySeq !== syncSeq) return metaSnapshot

    state.uiPluginsDir = typeof payload?.uiPluginsDir === 'string' && payload.uiPluginsDir.trim() !== ''
      ? payload.uiPluginsDir.trim()
      : null
    state.loaded = true
    state.error = ''

    const incoming = Array.isArray(payload?.plugins) ? payload.plugins : []
    if (targetId !== null) {
      // Targeted retry: only touch the specified plugin so healthy external plugins stay mounted.
      const match = incoming.find(desc => desc && desc.id === targetId)
      const prev = mounted.get(targetId)
      if (!match) {
        if (prev) {
          try { prev.dispose() } catch { /* ignore */ }
          mounted.delete(targetId)
        }
        pluginEpochs.delete(targetId)
        emitMeta()
        return metaSnapshot
      }
      const nextEpoch = (pluginEpochs.get(targetId) ?? 0) + 1
      pluginEpochs.set(targetId, nextEpoch)
      if (prev) {
        try { prev.dispose() } catch { /* ignore */ }
        mounted.delete(targetId)
      }
      const dispose = registerDescriptor(runtime, match, nextEpoch, importer)
      mounted.set(targetId, { sig: descriptorSignature(match, nextEpoch), dispose })
      emitMeta()
      return metaSnapshot
    }

    const nextIds = new Set()
    for (const desc of incoming) {
      if (!desc || typeof desc.id !== 'string' || desc.id.trim() === '') continue
      nextIds.add(desc.id)
      const prevEpoch = pluginEpochs.get(desc.id) ?? 0
      const epoch = forceReload ? prevEpoch + 1 : prevEpoch
      if (forceReload) pluginEpochs.set(desc.id, epoch)
      const sig = descriptorSignature(desc, epoch)
      const prev = mounted.get(desc.id)
      if (prev && prev.sig === sig) continue
      if (prev) {
        try { prev.dispose() } catch { /* ignore */ }
        mounted.delete(desc.id)
      }
      const dispose = registerDescriptor(runtime, desc, epoch, importer)
      mounted.set(desc.id, { sig, dispose })
    }
    for (const [id, entry] of Array.from(mounted.entries())) {
      if (!nextIds.has(id)) {
        try { entry.dispose() } catch { /* ignore */ }
        mounted.delete(id)
        pluginEpochs.delete(id)
      }
    }
    emitMeta()
  } catch (error) {
    if (mySeq !== syncSeq) return metaSnapshot
    state.error = error?.message ?? String(error)
    emitMeta()
  }
  return metaSnapshot
}

export function loadExternalUiPlugins(runtime = defaultRuntime, options = {}) {
  if (inFlight !== null) return inFlight
  const task = syncExternalUiPlugins(runtime, options)
  const wrapped = task.finally(() => {
    if (inFlight === wrapped) inFlight = null
  })
  inFlight = wrapped
  return wrapped
}

export function reloadExternalUiPlugins(runtime = defaultRuntime, options = {}) {
  const onlyId = typeof options?.onlyId === 'string' && options.onlyId.trim() !== '' ? options.onlyId.trim() : null
  const task = syncExternalUiPlugins(runtime, { ...options, forceReload: onlyId === null, onlyId })
  const wrapped = task.finally(() => {
    if (inFlight === wrapped) inFlight = null
  })
  inFlight = wrapped
  return wrapped
}

export function resetExternalUiPluginsForTest() {
  for (const entry of mounted.values()) {
    try { entry.dispose() } catch { /* ignore */ }
  }
  mounted.clear()
  pluginEpochs.clear()
  state.uiPluginsDir = null
  state.loaded = false
  state.error = ''
  syncSeq = 0
  inFlight = null
  emitMeta()
}

export function getUiPluginsMeta() {
  return metaSnapshot
}

export function useUiPluginsMeta() {
  const subscribe = useCallback((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return useSyncExternalStore(subscribe, getUiPluginsMeta, getUiPluginsMeta)
}
