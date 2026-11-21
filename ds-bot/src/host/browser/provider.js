// Public contract and registry for pluggable DS Bot browser providers.
// Both built-in Playwright modes and third-party DSH plugins register through
// the same shape, so any browser engine can replace the default cleanly.

const PROVIDER_ID = /^[a-z0-9][a-z0-9._:/-]{0,95}$/i
const MODES = new Set(['cdp', 'external'])
const KINDS = new Set(['builtin', 'provider', 'dsh-plugin', 'mcp'])

/**
 * Validate and normalize a browser provider definition.
 * A provider either supplies `toolDefs` (plus an optional custom `openSession`
 * replacing Playwright) or implements a full `mount(host)` lifecycle.
 */
export function defineBrowserProvider(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Browser provider must be an object')
  const id = String(spec.id ?? '').trim()
  if (!PROVIDER_ID.test(id)) throw new TypeError('Browser provider id must be a non-empty identifier')
  const toolDefs = Array.isArray(spec.tools) ? spec.tools : Array.isArray(spec.toolDefs) ? spec.toolDefs : undefined
  const hasMount = typeof spec.mount === 'function'
  if (!hasMount && !toolDefs) {
    throw new TypeError(`Browser provider "${id}" must define either mount(host) or toolDefs`)
  }
  const kind = KINDS.has(spec.kind) ? spec.kind : 'provider'
  const mode = MODES.has(spec.mode) ? spec.mode : (kind === 'builtin' ? 'cdp' : 'external')
  return {
    id,
    name: String(spec.name ?? spec.label ?? id).trim().slice(0, 80) || id,
    description: String(spec.description ?? '').trim().slice(0, 300),
    kind,
    mode,
    packageName: typeof spec.packageName === 'string' && spec.packageName.trim() !== '' ? spec.packageName.trim() : undefined,
    systemPrompt: typeof spec.systemPrompt === 'string' ? spec.systemPrompt : '',
    supportsGrants: spec.supportsGrants === true,
    supportsHandoff: spec.supportsHandoff === true,
    supportsPerBotProfile: spec.supportsPerBotProfile === true,
    toolPrefixes: Array.isArray(spec.toolPrefixes)
      ? spec.toolPrefixes.map(prefix => String(prefix ?? '').trim()).filter(Boolean)
      : [],
    ...(toolDefs ? { toolDefs, tools: toolDefs } : {}),
    ...(typeof spec.openSession === 'function' ? { openSession: spec.openSession } : {}),
    ...(hasMount ? { mount: spec.mount } : {}),
  }
}

/**
 * In-memory registry of native browser providers (built-in and third-party).
 */
export function createBrowserProviderRegistry() {
  const providers = new Map()
  const listeners = new Set()

  const notify = (event) => {
    for (const listener of listeners) {
      try { listener(event) } catch { /* ignore subscriber failure */ }
    }
  }

  function register(spec) {
    const provider = defineBrowserProvider(spec)
    providers.set(provider.id, provider)
    notify({ action: 'register', id: provider.id, packageName: provider.packageName })
    return () => {
      if (providers.get(provider.id) === provider) {
        providers.delete(provider.id)
        notify({ action: 'unregister', id: provider.id, packageName: provider.packageName })
      }
    }
  }

  function unregister(id) {
    const key = String(id ?? '')
    const existing = providers.get(key)
    if (!existing) return false
    providers.delete(key)
    notify({ action: 'unregister', id: existing.id, packageName: existing.packageName })
    return true
  }

  const get = id => providers.get(String(id ?? ''))
  const list = () => [...providers.values()]
  const byPackage = packageName => list().find(provider => provider.packageName === packageName)
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { register, unregister, get, list, byPackage, subscribe }
}
