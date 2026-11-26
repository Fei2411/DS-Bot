// Public SDK helpers for authoring DS Bot plugins and replaceable browser providers.
// Third-party DSH plugins can import these helpers from `ds-bot/plugin-sdk` or
// `ds-bot/browser-provider` and register via `ctx.dsBotPlugins` / `ctx.dsBotBrowser`.
import { normalizeExecution } from './tiers.js'

export { EXECUTION_TIERS, EXECUTION_CAPABILITIES, normalizeExecution, validateExecutionCapabilities } from './tiers.js'

const ID_RE = /^[a-z0-9][a-z0-9:._-]{0,79}$/i
const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/

export const PLUGIN_CATEGORIES = Object.freeze(['browser', 'tools', 'productivity', 'dev', 'data', 'other'])

function cleanPrefixes(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))]
}

/**
 * Define a native DS Bot plugin descriptor.
 *
 * @param {{
 *   id: string,
 *   name: string,
 *   description?: string,
 *   version?: string,
 *   author?: string,
 *   homepage?: string,
 *   category?: string,
 *   slot?: string | null,
 *   toolPrefixes?: string[],
 *   supportsPerBot?: boolean,
 *   supportsGrants?: boolean,
 *   packageName?: string,
 *   execution?: string,
 *   capabilities?: string[],
 *   replaces?: string[],
 *   locales?: Record<string, { name?: string, description?: string }>,
 *   mount: (host: any) => Promise<any> | any,
 * }} spec
 */
export function defineBotPlugin(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Plugin definition must be an object.')
  const id = String(spec.id ?? '').trim()
  if (!ID_RE.test(id)) throw new TypeError('Plugin id must use letters, digits, dots, underscores, or hyphens (1–80 chars).')
  const name = String(spec.name ?? '').trim()
  if (!name) throw new TypeError('Plugin name is required.')
  if (typeof spec.mount !== 'function') throw new TypeError('Plugin definition must provide a mount(host) function.')
  // A native `mount()` always executes inside the host process, so a native plugin
  // IS a trusted worker; declaring a confined tier would be a lie the consent
  // fingerprint would then bind. The execution tier is validated here anyway so
  // the canonical vocabulary is the only spelling that exists.
  const normalizedExecution = normalizeExecution({ execution: spec.execution, capabilities: spec.capabilities })
  if (normalizedExecution.execution !== 'trusted-worker') {
    throw new TypeError(
      `Native plugin "${id}" declares execution tier "${normalizedExecution.execution}" but a mount() function always ` +
      'runs as a trusted worker. Confined tiers (data / declarative / sandboxed-ui) belong to registry-delivered plugin shapes.',
    )
  }
  const slot = spec.slot == null || spec.slot === '' ? null : String(spec.slot).trim().toLowerCase()
  if (slot !== null && !SLOT_RE.test(slot)) throw new TypeError(`Invalid plugin slot "${spec.slot}".`)
  const rawCategory = String(spec.category ?? (slot === 'browser' ? 'browser' : 'tools')).trim().toLowerCase()
  const category = PLUGIN_CATEGORIES.includes(rawCategory) ? rawCategory : 'other'
  return Object.freeze({
    id,
    name,
    description: String(spec.description ?? '').trim(),
    version: spec.version ? String(spec.version).trim() : undefined,
    author: spec.author ? String(spec.author).trim() : undefined,
    homepage: spec.homepage ? String(spec.homepage).trim() : undefined,
    category,
    slot,
    execution: normalizedExecution.execution,
    capabilities: normalizedExecution.capabilities,
    toolPrefixes: cleanPrefixes(spec.toolPrefixes),
    supportsPerBot: slot === null ? spec.supportsPerBot !== false : false,
    supportsGrants: spec.supportsGrants === true,
    packageName: spec.packageName ? String(spec.packageName).trim() : undefined,
    replaces: cleanPrefixes(spec.replaces),
    locales: spec.locales && typeof spec.locales === 'object' ? spec.locales : undefined,
    mount: spec.mount,
  })
}

/**
 * Define a hot-swappable browser provider plugin for the `browser` slot.
 * Providers may either pass `{ toolDefs, openSession? }` to reuse DS Bot's per-Bot
 * browser session lifecycle, screenshot attachments, write-action grants and handoff cards,
 * or implement a custom `mount(host)` function.
 *
 * @param {{
 *   id: string,
 *   name: string,
 *   description?: string,
 *   version?: string,
 *   author?: string,
 *   homepage?: string,
 *   packageName?: string,
 *   toolPrefixes?: string[],
 *   supportsGrants?: boolean,
 *   locales?: Record<string, { name?: string, description?: string }>,
 *   toolDefs?: any[],
 *   openSession?: Function,
 *   mount?: (host: any) => Promise<any> | any,
 * }} spec
 */
export function defineBrowserProvider(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Browser provider definition must be an object.')
  const hasTools = Array.isArray(spec.toolDefs) && spec.toolDefs.length > 0
  const hasMount = typeof spec.mount === 'function'
  if (!hasTools && !hasMount) throw new TypeError('Browser provider must provide either toolDefs or a mount(host) function.')
  const mount = hasMount
    ? spec.mount
    : (host) => host.mountBrowserTools({ toolDefs: spec.toolDefs, openSession: spec.openSession })
  return defineBotPlugin({
    ...spec,
    category: 'browser',
    slot: 'browser',
    supportsGrants: spec.supportsGrants ?? hasTools,
    toolPrefixes: spec.toolPrefixes ?? (hasTools ? spec.toolDefs.map(t => t.name) : ['browser_']),
    mount,
  })
}
