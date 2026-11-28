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
let inFlight = null
let reloadEpoch = 0

function emitMeta() {
  metaSnapshot = Object.freeze({ ...state })
  for (const listener of Array.from(listeners)) {
    try { listener() } catch { /* listener failure */ }
  }
}

function descriptorSignature(desc, forceReloadEpoch) {
  return JSON.stringify({
    epoch: forceReloadEpoch,
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

function registerDescriptor(runtime, desc, epoch) {
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
          const mod = await import(/* @vite-ignore */ bust(versionedUrl))
          const fn = typeof mod === 'function'
            ? mod
            : (typeof mod?.apply === 'function' ? mod.apply : (typeof mod?.default === 'function' ? mod.default : null))
          return (ctx) => {
            ctx.theme(desc.theme.id, desc.theme)
            if (typeof fn === 'function') return fn(ctx)
            return undefined
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
  forceReload = false,
} = {}) {
  if (typeof fetchImpl !== 'function') return metaSnapshot
  if (forceReload) reloadEpoch += 1
  const currentEpoch = reloadEpoch
  try {
    const res = await fetchImpl(MANIFEST_URL, { cache: 'no-store' })
    if (!res.ok) {
      if (res.status !== 404) {
        state.error = `HTTP ${res.status}`
        emitMeta()
      }
      return metaSnapshot
    }
    const payload = await res.json()
    state.uiPluginsDir = typeof payload?.uiPluginsDir === 'string' && payload.uiPluginsDir.trim() !== ''
      ? payload.uiPluginsDir.trim()
      : null
    state.loaded = true
    state.error = ''

    const incoming = Array.isArray(payload?.plugins) ? payload.plugins : []
    const nextIds = new Set()
    for (const desc of incoming) {
      if (!desc || typeof desc.id !== 'string' || desc.id.trim() === '') continue
      nextIds.add(desc.id)
      const sig = descriptorSignature(desc, forceReload ? currentEpoch : 0)
      const prev = mounted.get(desc.id)
      if (prev && prev.sig === sig) continue
      if (prev) {
        try { prev.dispose() } catch { /* ignore */ }
        mounted.delete(desc.id)
      }
      const dispose = registerDescriptor(runtime, desc, currentEpoch)
      mounted.set(desc.id, { sig, dispose })
    }
    for (const [id, entry] of Array.from(mounted.entries())) {
      if (!nextIds.has(id)) {
        try { entry.dispose() } catch { /* ignore */ }
        mounted.delete(id)
      }
    }
    emitMeta()
  } catch (error) {
    state.error = error?.message ?? String(error)
    emitMeta()
  }
  return metaSnapshot
}

export function loadExternalUiPlugins(runtime = defaultRuntime, options = {}) {
  inFlight ??= syncExternalUiPlugins(runtime, options).finally(() => { inFlight = null })
  return inFlight
}

export function reloadExternalUiPlugins(runtime = defaultRuntime, options = {}) {
  const next = syncExternalUiPlugins(runtime, { ...options, forceReload: true })
  inFlight = next.finally(() => { if (inFlight === next) inFlight = null })
  return next
}

export function resetExternalUiPluginsForTest() {
  for (const entry of mounted.values()) {
    try { entry.dispose() } catch { /* ignore */ }
  }
  mounted.clear()
  state.uiPluginsDir = null
  state.loaded = false
  state.error = ''
  reloadEpoch = 0
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
