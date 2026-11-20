// Catalog, discovery heuristics, and custom entry validation for pluggable
// browser backends (built-in Playwright, DSH browser plugins, MCP servers).

export const READONLY_ID = 'readonly'
export const BUILTIN_PREFIX = 'builtin:'
export const DSH_PREFIX = 'dsh:'
export const MCP_PREFIX = 'mcp:'
export const PROVIDER_PREFIX = 'provider:'

export const BUILTIN_NAMES = ['refs', 'script', 'task']

export const BUILTIN_CATALOG = [
  {
    id: 'builtin:refs',
    shortName: 'refs',
    kind: 'builtin',
    mode: 'cdp',
    name: 'DS Bot Playwright · ARIA refs',
    description: 'Step-by-step snapshots and numbered refs in each Bot’s isolated browser panel.',
    supportsGrants: true,
    supportsHandoff: true,
    supportsPerBotProfile: true,
  },
  {
    id: 'builtin:script',
    shortName: 'script',
    kind: 'builtin',
    mode: 'cdp',
    name: 'DS Bot Playwright · Script',
    description: 'Batch multiple actions into one JavaScript step in each Bot’s browser.',
    supportsGrants: true,
    supportsHandoff: true,
    supportsPerBotProfile: true,
  },
  {
    id: 'builtin:task',
    shortName: 'task',
    kind: 'builtin',
    mode: 'cdp',
    name: 'DS Bot Playwright · Whole task',
    description: 'Hand a web goal to a browser loop and return the answer and steps.',
    supportsGrants: true,
    supportsHandoff: true,
    supportsPerBotProfile: true,
  },
]

// Curated third-party DSH browser plugins (metadata only; nothing is vendored).
export const DSH_PLUGIN_CATALOG = [
  {
    id: 'dsh:dsh-ego-browser',
    kind: 'dsh-plugin',
    mode: 'external',
    packageName: 'dsh-ego-browser',
    installSpec: 'dsh-ego-browser',
    name: 'Ego Browser (ego lite)',
    description: 'Community DSH plugin for ego lite / Chromium with structured ego_* tools and a live observation panel.',
    toolPrefixes: ['ego_'],
  },
  {
    id: 'dsh:@dshworks/dsh-ego-browser',
    kind: 'dsh-plugin',
    mode: 'external',
    packageName: '@dshworks/dsh-ego-browser',
    installSpec: '@dshworks/dsh-ego-browser',
    name: 'Ego Browser Memory (ego lite)',
    description: 'Community DSH plugin for ego lite with one-script execution and reusable site-skill memory.',
    toolPrefixes: ['ego_'],
  },
]

// Curated MCP browser server presets (mounted via @deepseek-ai/dsh-mcp-client).
export const MCP_CATALOG = [
  {
    id: 'mcp:playwright-mcp',
    kind: 'mcp',
    mode: 'external',
    name: 'Playwright MCP',
    description: 'Official Playwright MCP server (@playwright/mcp) over stdio.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: {},
  },
  {
    id: 'mcp:chrome-devtools-mcp',
    kind: 'mcp',
    mode: 'external',
    name: 'Chrome DevTools MCP',
    description: 'Drive Chrome via Chrome DevTools Protocol MCP server over stdio.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    env: {},
  },
]

// DSH built-in packages that carry "browser" in their name but are not browser automation plugins.
const IGNORED_BUNDLES = new Set([
  'ds-bot',
  '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-web-frontend',
])

const BROWSER_HINT = /(?:^|[-_/])(ego[-_]?browser|browser|playwright|puppeteer|stagehand|cdp[-_]?browser|browser[-_]?use)(?:$|[-_/])/i

export function normalizeBackendId(value) {
  if (value === undefined || value === null) return READONLY_ID
  const text = String(value).trim()
  if (text === '' || text === 'off' || text === 'none' || text === READONLY_ID) return READONLY_ID
  if (BUILTIN_NAMES.includes(text)) return `${BUILTIN_PREFIX}${text}`
  return text
}

/**
 * Heuristic check for whether a DSH bundle listed by pluginManager is a browser plugin.
 */
export function isBrowserBundle(bundle, knownPackages = new Set()) {
  const pkg = typeof bundle?.name === 'string' ? bundle.name.trim() : ''
  if (pkg === '' || IGNORED_BUNDLES.has(pkg)) return false
  if (knownPackages.has(pkg)) return true
  if (pkg.startsWith('@deepseek-ai/dsh-client-ui-')) return false
  if (pkg.startsWith('@deepseek-ai/dsh-browser')) return true
  if (BROWSER_HINT.test(pkg)) return true
  const keywords = Array.isArray(bundle?.keywords) ? bundle.keywords.map(k => String(k).toLowerCase()) : []
  if (keywords.some(k => k === 'browser-automation' || k === 'ego-browser' || k === 'ego-lite' || k === 'ds-bot-browser')) return true
  return false
}

export function inferToolPrefixes(packageName) {
  const pkg = String(packageName ?? '').toLowerCase()
  if (pkg.includes('ego')) return ['ego_']
  // Never infer 'browser_' — DS Bot's own built-in Playwright tools use browser_*.
  if (pkg.includes('playwright')) return ['playwright_']
  if (pkg.includes('puppeteer')) return ['puppeteer_']
  if (pkg.includes('stagehand')) return ['stagehand_']
  return []
}

export function dshInstallCommand(spec, profileName) {
  const profile = typeof profileName === 'string' && profileName.trim() !== '' ? ` --profile ${profileName.trim()}` : ''
  return `dsh plugin${profile} add ${spec}`
}

// Stable, safe MCP serverName used by @deepseek-ai/dsh-mcp-client (produces mcp__<serverName>__* tools).
export function mcpServerNameFor(id) {
  const stem = String(id ?? '').replace(/^mcp:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'custom'
  return `browser-${stem}`
}

const strings = (value, label) => {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : String(value).split(/\s+/).filter(Boolean)
  if (list.some(item => typeof item !== 'string' || item.includes('\0') || /[\r\n]/.test(item))) {
    throw new Error(`${label} must contain single-line text values.`)
  }
  return list.map(item => item.trim()).filter(Boolean)
}

const prefixes = (value) => {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(/[,\s]+/)
  const clean = [...new Set(raw.map(item => String(item ?? '').trim()).filter(Boolean))]
  for (const prefix of clean) {
    if (!/^[a-z0-9_-]{2,40}$/i.test(prefix)) {
      throw new Error(`Invalid tool prefix "${prefix}". Use letters, digits, underscores, or hyphens.`)
    }
  }
  return clean
}

const stringMap = (value, label) => {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be a map of text values.`)
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).trim()
    if (key === '') continue
    if (key.includes('\0') || /[\r\n]/.test(key) || v.includes('\0') || /[\r\n]/.test(v)) {
      throw new Error(`${label} must not contain newlines.`)
    }
    out[key] = v
  }
  return out
}

const SAFE_COMMAND = /^(?:\/|~\/|[A-Za-z]:[\\/]|[\w.-]+$)/

export function customBrowserId(kind, name, taken = new Set()) {
  const prefix = kind === 'dsh-plugin' ? DSH_PREFIX : MCP_PREFIX
  const base = String(name ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'custom'
  let id = `${prefix}custom-${base}`
  let n = 2
  while (taken.has(id)) {
    id = `${prefix}custom-${base.slice(0, 22)}-${n}`
    n += 1
  }
  return id
}

/**
 * Validate a user-added custom browser backend (either a DSH plugin or an MCP server).
 */
export function validateCustomBrowser(body, takenIds = new Set(), editableIds = new Set()) {
  if (!body || typeof body !== 'object') throw new Error('Invalid browser backend payload.')
  const kind = body.kind === 'dsh-plugin' ? 'dsh-plugin' : body.kind === 'mcp' ? 'mcp' : ''
  if (kind === '') throw new Error('Choose a DSH plugin or an MCP server.')
  const name = String(body.name ?? '').trim().slice(0, 60)
  if (name === '') throw new Error('Name is required.')
  const description = String(body.description ?? '').trim().slice(0, 240)

  if (kind === 'dsh-plugin') {
    const installSpec = String(body.installSpec ?? body.packageName ?? '').trim()
    if (installSpec === '' || /\s/.test(installSpec) || installSpec.includes('\0')) {
      throw new Error('Enter a valid DSH plugin package name or install spec (for example dsh-ego-browser or github:owner/repo).')
    }
    const packageName = String(body.packageName ?? '').trim() || derivePackageName(installSpec)
    if (packageName === '' || /\s/.test(packageName) || packageName.includes('\0')) {
      throw new Error('Enter a valid package name for the DSH plugin.')
    }
    const id = typeof body.id === 'string' && editableIds.has(body.id) && body.id.startsWith(DSH_PREFIX)
      ? body.id
      : `${DSH_PREFIX}${packageName}`
    if (!editableIds.has(id) && DSH_PLUGIN_CATALOG.some(entry => entry.id === id)) {
      throw new Error(`${packageName} is already listed in the DSH browser plugin catalog.`)
    }
    const toolPrefixes = prefixes(body.toolPrefixes)
    return {
      id,
      kind: 'dsh-plugin',
      mode: 'external',
      name,
      description,
      packageName,
      installSpec,
      toolPrefixes: toolPrefixes.length > 0 ? toolPrefixes : inferToolPrefixes(packageName),
      custom: true,
    }
  }

  const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const id = typeof body.id === 'string' && editableIds.has(body.id) && body.id.startsWith(MCP_PREFIX)
    ? body.id
    : customBrowserId('mcp', name, takenIds)
  if (transport === 'stdio') {
    const command = String(body.command ?? '').trim()
    if (command === '' || /\s/.test(command) || command.includes('\0') || !SAFE_COMMAND.test(command)) {
      throw new Error('Command must be a program name, an absolute path, or a ~/path.')
    }
    const args = strings(body.args, 'Arguments')
    const env = stringMap(body.env, 'Environment variables')
    return { id, kind: 'mcp', mode: 'external', name, description, transport, command, args, env, custom: true }
  }
  const url = String(body.url ?? '').trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }
  const headers = stringMap(body.headers, 'Headers')
  return { id, kind: 'mcp', mode: 'external', name, description, transport, url, headers, custom: true }
}

export function derivePackageName(spec) {
  const text = String(spec ?? '').trim()
  // github:owner/repo#ref -> repo
  const git = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)[\w.-]+\/([\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(text)
  if (git) return git[1]
  // @scope/name@version -> @scope/name
  if (text.startsWith('@')) {
    const slash = text.indexOf('/')
    if (slash === -1) return text
    const at = text.indexOf('@', slash + 1)
    return at === -1 ? text : text.slice(0, at)
  }
  // name@version -> name
  const at = text.indexOf('@')
  return at === -1 ? text : text.slice(0, at)
}
