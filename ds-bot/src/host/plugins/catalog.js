// Plugin registry catalog fetching, schema validation, offline caching,
// and MCP argument/security validation for DS Bot's plugin system.
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { replaceFile } from '../files.js'
import { BUNDLED_PLUGIN_CATALOG, defaultRegistryUrl } from './registry-url.js'
import { PLUGIN_CATEGORIES } from './sdk.js'

const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MAX_REGISTRY_BYTES = 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_ENTRIES_PER_SOURCE = 500
const SECRET_REF_GLOBAL = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const SAFE_AUTH_PREFIX_RE = /^(?:(?:Bearer|Basic|Token|ApiKey|Api-Key)\s+)?$/i
const SENSITIVE_KEY_RE = /(?:^|[_-])(auth|authorization|cookie|token|secret|password|passwd|pass|api[_-]?key|access[_-]?key|private[_-]?key|credential|session)(?:$|[_-])/i
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9:._/@-]{1,120}$/i
const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(raw) {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') || host.startsWith('ff')) return true
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
  }
  return false
}

function isPrivateIpAddress(address) {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
}

/**
 * Validate an external plugin registry URL (HTTPS only, no credentials, no local/private hosts).
 */
export function validateRegistryUrl(rawUrl, { allowHttp = false } = {}) {
  const text = String(rawUrl ?? '').trim()
  if (!text) throw new Error('Enter a registry URL.')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('Enter a valid URL.')
  }
  const allowedProtocols = allowHttp ? ['https:', 'http:'] : ['https:']
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error('Plugin registry URLs must use HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Plugin registry URLs must not contain embedded credentials.')
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const bare = host.replace(/^\[|\]$/g, '')
  if (!allowHttp) {
    if (!bare || bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      throw new Error('Plugin registry URLs cannot target local or private hosts.')
    }
    const ipVersion = isIP(bare)
    if (ipVersion === 4 && isPrivateIpv4(bare)) {
      throw new Error('Plugin registry URLs cannot target private IP addresses.')
    }
    if (ipVersion === 6 && isPrivateIpv6(bare)) {
      throw new Error('Plugin registry URLs cannot target private IPv6 addresses.')
    }
    if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(bare)) {
      throw new Error('Plugin registry URLs cannot use raw numeric host addresses.')
    }
  }
  return parsed.toString()
}

async function assertPublicDns(urlText, { dnsLookup = lookup } = {}) {
  const host = new URL(urlText).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isPrivateIpAddress(host)) throw new Error('Plugin registry URLs cannot target private IP addresses.')
    return
  }
  const records = await dnsLookup(host, { all: true })
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Could not resolve registry host "${host}".`)
  }
  for (const record of records) {
    if (isPrivateIpAddress(record.address)) {
      throw new Error(`Registry host "${host}" resolved to a private IP address.`)
    }
  }
}

/**
 * Split a shell-like argument string into an argv array.
 * - Preserves quoted empty strings (`""` / `''` → `""`)
 * - Preserves Windows paths and UNC paths (`\\server\share\file`) without stripping backslashes
 */
export function splitArgs(input) {
  if (Array.isArray(input)) return input.map(v => String(v))
  const text = String(input ?? '')
  const args = []
  let current = ''
  let hasToken = false
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < text.length && text[i + 1] === '"') {
        current += '"'
        i += 1
      } else current += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === '\\' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === "'")) {
      current += text[i + 1]
      hasToken = true
      i += 1
      continue
    }
    current += ch
    hasToken = true
  }
  if (quote !== null) throw new Error('Unclosed quote in arguments.')
  if (hasToken) args.push(current)
  return args
}

// Allow empty values or `$DSH_SECRET_<NAME>` references (including `Bearer $DSH_SECRET_TOKEN`),
// while rejecting any plaintext secret material in sensitive headers/env/query values.
function isSafeSecretValue(value) {
  const text = String(value ?? '').trim()
  if (text === '') return true
  if (!SECRET_REF_GLOBAL.test(text)) {
    SECRET_REF_GLOBAL.lastIndex = 0
    return false
  }
  SECRET_REF_GLOBAL.lastIndex = 0
  const stripped = text.replace(SECRET_REF_GLOBAL, '').trim()
  return stripped === '' || SAFE_AUTH_PREFIX_RE.test(`${stripped} `)
}

function cleanStringList(list, max = 32) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(v => String(v ?? '').trim()).filter(Boolean))].slice(0, max)
}

function cleanLocales(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [lang, entry] of Object.entries(raw)) {
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(lang)) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const loc = {}
    if (typeof entry.name === 'string' && entry.name.trim()) loc.name = entry.name.trim().slice(0, 120)
    if (typeof entry.description === 'string' && entry.description.trim()) loc.description = entry.description.trim().slice(0, 600)
    if (Object.keys(loc).length > 0) out[lang.toLowerCase()] = loc
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanSafeHttpUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    if (parsed.username || parsed.password) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

export function validateMcpConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('MCP configuration must be an object.')
  }
  const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  if (transport === 'stdio') {
    const packageSpec = typeof raw.packageSpec === 'string' ? raw.packageSpec.trim() : ''
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (!packageSpec && !command) throw new Error('Enter a command or npm package for the stdio MCP plugin.')
    if (/[\r\n\0]/.test(command) || /[\r\n\0]/.test(packageSpec)) throw new Error('Command must not contain control characters.')
    const args = Array.isArray(raw.args)
      ? raw.args.map(v => String(v))
      : typeof raw.args === 'string' ? splitArgs(raw.args) : []
    const env = {}
    if (raw.env !== undefined) {
      if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
        throw new Error('Environment variables must be key/value text pairs.')
      }
      for (const [k, v] of Object.entries(raw.env)) {
        const key = String(k).trim()
        if (!key) continue
        const val = String(v ?? '')
        if (SENSITIVE_KEY_RE.test(key) && !isSafeSecretValue(val)) {
          throw new Error(`Environment variable "${key}" looks sensitive; store it in Secrets and reference it as $DSH_SECRET_<NAME>.`)
        }
        env[key] = val
      }
    }
    return {
      transport: 'stdio',
      ...(packageSpec ? { packageSpec } : {}),
      ...(command ? { command } : {}),
      args,
      env,
    }
  }
  const urlText = String(raw.url ?? '').trim()
  let parsed
  try {
    parsed = new URL(urlText)
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL for the MCP server.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('MCP server URL must use HTTP or HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP server URL must not contain embedded credentials.')
  }
  for (const [param, value] of parsed.searchParams.entries()) {
    if (SENSITIVE_KEY_RE.test(param) && !isSafeSecretValue(value)) {
      throw new Error(`Query parameter "${param}" looks sensitive; pass credentials via a $DSH_SECRET_<NAME> header instead.`)
    }
  }
  const headers = {}
  if (raw.headers !== undefined) {
    if (raw.headers === null || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
      throw new Error('Headers must be key/value text pairs.')
    }
    for (const [k, v] of Object.entries(raw.headers)) {
      const key = String(k).trim()
      if (!key) continue
      const val = String(v ?? '')
      if (SENSITIVE_KEY_RE.test(key) && !isSafeSecretValue(val)) {
        throw new Error(`Header "${key}" looks sensitive; store it in Secrets and reference it as $DSH_SECRET_<NAME>.`)
      }
      headers[key] = val
    }
  }
  return {
    transport: 'streamable-http',
    url: parsed.toString(),
    headers,
  }
}

export function sanitizeMcpConfig(mcp) {
  if (!mcp || typeof mcp !== 'object') return undefined
  if (mcp.transport === 'streamable-http') {
    let safeUrl = mcp.url
    try {
      const parsed = new URL(String(mcp.url ?? ''))
      parsed.username = ''
      parsed.password = ''
      for (const key of parsed.searchParams.keys()) {
        if (SENSITIVE_KEY_RE.test(key)) parsed.searchParams.set(key, '***')
      }
      safeUrl = parsed.toString()
    } catch { /* keep as-is */ }
    const headerKeys = Object.keys(mcp.headers ?? {})
    return {
      transport: 'streamable-http',
      url: safeUrl,
      headerKeys,
    }
  }
  const envKeys = Object.keys(mcp.env ?? {})
  return {
    transport: 'stdio',
    ...(mcp.packageSpec ? { packageSpec: mcp.packageSpec } : {}),
    ...(mcp.command ? { command: mcp.command } : {}),
    args: Array.isArray(mcp.args) ? [...mcp.args] : [],
    envKeys,
  }
}

export function expandSecretValue(text, secretValueOf) {
  if (typeof text !== 'string' || !text.includes('$DSH_SECRET_')) return text
  return text.replace(SECRET_REF_GLOBAL, (_match, name) => {
    const resolved = secretValueOf?.(name)
    if (typeof resolved !== 'string') {
      throw new Error(`Missing secret "${name}" referenced as $DSH_SECRET_${name}. Add it in Settings → Tools → Secrets.`)
    }
    return resolved
  })
}

let cachedRunner = null
function hasExecutable(bin) {
  if (!bin) return false
  // Windows `where` fails on absolute paths; check filesystem directly for explicit paths.
  if (isAbsolute(bin)) return existsSync(bin)
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(cmd, [bin], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve how to launch an npm-packaged MCP preset (e.g. `@playwright/mcp@latest`),
 * preferring `npx` and falling back to bundled/system `pnpm dlx` when npm is absent.
 */
export function resolveMcpPresetCommand(mcp, { probe = hasExecutable, pnpmPath = process.env.DS_BOT_PNPM } = {}) {
  if (mcp.command) return { command: mcp.command, args: [...(mcp.args ?? [])] }
  const pkg = mcp.packageSpec
  if (!pkg) throw new Error('MCP plugin has neither command nor packageSpec.')
  const extra = [...(mcp.args ?? [])]
  if (probe === hasExecutable && cachedRunner !== null) {
    return cachedRunner(pkg, extra)
  }
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  let runner
  if (probe(npxBin)) {
    runner = (spec, args) => ({ command: npxBin, args: ['-y', spec, ...args] })
  } else if (pnpmPath && probe(pnpmPath)) {
    runner = (spec, args) => ({ command: pnpmPath, args: ['dlx', spec, ...args] })
  } else if (probe(pnpmBin)) {
    runner = (spec, args) => ({ command: pnpmBin, args: ['dlx', spec, ...args] })
  } else {
    throw new Error('Neither npx nor pnpm is available on PATH to run this MCP plugin.')
  }
  if (probe === hasExecutable) cachedRunner = runner
  return runner(pkg, extra)
}

/**
 * Parse and validate a DS Bot plugin registry document (schemaVersion: 1).
 */
export function parsePluginRegistry(doc, { sourceId = 'official', sourceName = 'Official', sourceUrl = null } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Registry document must be a JSON object.')
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(`Unsupported plugin registry schemaVersion: ${doc.schemaVersion}.`)
  }
  if (!Array.isArray(doc.plugins)) {
    throw new Error('Registry document must contain a "plugins" array.')
  }
  const plugins = []
  const seen = new Set()
  for (const raw of doc.plugins.slice(0, MAX_ENTRIES_PER_SOURCE)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = String(raw.id ?? '').trim()
    const name = String(raw.name ?? '').trim()
    const kind = raw.kind
    if (!ENTRY_ID_RE.test(id) || !name || !['dsh', 'mcp'].includes(kind)) continue
    if (seen.has(id)) continue
    const slot = raw.slot == null || raw.slot === '' ? null : String(raw.slot).trim().toLowerCase()
    if (slot !== null && !SLOT_RE.test(slot)) continue
    const rawCat = String(raw.category ?? (slot === 'browser' ? 'browser' : 'tools')).trim().toLowerCase()
    const category = PLUGIN_CATEGORIES.includes(rawCat) ? rawCat : 'other'
    const install = {}
    if (kind === 'dsh') {
      const spec = String(raw.install?.spec ?? raw.install?.packageName ?? '').trim()
      const packageName = String(raw.install?.packageName ?? spec).trim()
      if (!spec || !packageName) continue
      install.spec = spec
      install.packageName = packageName
      const aliases = cleanStringList(raw.install?.aliases, 10)
      if (aliases.length > 0) install.aliases = aliases
    } else {
      let mcp
      try {
        mcp = validateMcpConfig(raw.install?.mcp ?? raw.mcp)
      } catch {
        continue
      }
      install.mcp = mcp
    }
    seen.add(id)
    plugins.push({
      id,
      name: name.slice(0, 120),
      description: String(raw.description ?? '').trim().slice(0, 600),
      author: String(raw.author ?? '').trim().slice(0, 80) || undefined,
      version: raw.version ? String(raw.version).trim().slice(0, 40) : undefined,
      category,
      slot,
      kind,
      featured: raw.featured === true,
      verified: sourceId === 'official' && raw.verified === true,
      tags: cleanStringList(raw.tags, 12),
      toolPrefixes: cleanStringList(raw.toolPrefixes, 24),
      install,
      homepage: cleanSafeHttpUrl(raw.homepage),
      repository: cleanSafeHttpUrl(raw.repository),
      locales: cleanLocales(raw.locales),
      sourceId,
      sourceName,
      sourceUrl,
    })
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    plugins,
  }
}

async function readBoundedText(response, maxBytes) {
  const lengthHeader = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('Plugin registry response exceeds 1 MB limit.')
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const bytes = value instanceof Uint8Array ? value : Buffer.from(value)
        total += bytes.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error('Plugin registry response exceeds 1 MB limit.')
        }
        chunks.push(bytes)
      }
    } finally {
      reader.releaseLock?.()
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw new Error('Plugin registry response exceeds 1 MB limit.')
  return buffer.toString('utf8')
}

async function fetchJsonWithGuard(rawUrl, { fetchImpl = globalThis.fetch, dnsLookup = lookup, signal, allowHttp = false } = {}) {
  let currentUrl = validateRegistryUrl(rawUrl, { allowHttp })
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    if (!allowHttp && fetchImpl === globalThis.fetch) {
      await assertPublicDns(currentUrl, { dnsLookup })
    }
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': 'DS-Bot-Plugin-Catalog/1' },
      signal: combined,
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel?.().catch(() => {})
      const location = response.headers?.get?.('location')
      if (!location || hops === MAX_REDIRECTS) throw new Error('Too many redirects while fetching plugin registry.')
      currentUrl = validateRegistryUrl(new URL(location, currentUrl).toString(), { allowHttp })
      continue
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`Registry responded with HTTP ${response.status}.`)
    }
    const text = await readBoundedText(response, MAX_REGISTRY_BYTES)
    return JSON.parse(text)
  }
  throw new Error('Could not fetch plugin registry.')
}

export function createCatalogManager({ cachePath, fetchImpl = globalThis.fetch, dnsLookup = lookup, env = process.env, allowHttp = false, now = Date.now } = {}) {
  let memoryCache = null

  async function readDiskCache() {
    if (!cachePath) return null
    try {
      const text = await readFile(cachePath, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) return parsed
    } catch { /* missing or corrupt cache falls back */ }
    return null
  }

  async function writeDiskCache(payload) {
    if (!cachePath) return
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      await replaceFile(cachePath, JSON.stringify(payload, null, 2))
    } catch { /* cache write is best-effort */ }
  }

  function bundledEntries() {
    return BUNDLED_PLUGIN_CATALOG.map(entry => ({
      ...entry,
      sourceId: 'bundled',
      sourceName: 'Built-in catalog',
      sourceUrl: null,
    }))
  }

  function mergeEntries(sourceLists) {
    const byId = new Map()
    for (const list of sourceLists) {
      for (const entry of list) {
        if (!byId.has(entry.id)) byId.set(entry.id, entry)
      }
    }
    return [...byId.values()]
  }

  async function load({ sources = [], force = false, signal } = {}) {
    const officialUrl = defaultRegistryUrl(env)
    const activeSources = [
      { id: 'official', name: 'DS Bot Official Registry', url: officialUrl, enabled: true, official: true },
      ...sources.filter(s => s && s.enabled !== false && typeof s.url === 'string' && s.url.trim()),
    ]
    const sourceSignature = activeSources.map(s => `${s.id}:${s.url}`).join('|')

    if (!force && memoryCache && memoryCache.signature === sourceSignature && now() - memoryCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
      return memoryCache
    }
    if (!force && !memoryCache) {
      const disk = await readDiskCache()
      if (disk && disk.signature === sourceSignature && now() - (disk.fetchedAt ?? 0) < CATALOG_CACHE_TTL_MS) {
        memoryCache = disk
        return disk
      }
    }

    const errors = []
    let officialList = []
    const customLists = []
    for (const src of activeSources) {
      try {
        const json = await fetchJsonWithGuard(src.url, { fetchImpl, dnsLookup, signal, allowHttp })
        const parsed = parsePluginRegistry(json, { sourceId: src.id, sourceName: src.name || src.id, sourceUrl: src.url })
        if (src.official) officialList = parsed.plugins
        else customLists.push(parsed.plugins)
      } catch (error) {
        errors.push({ sourceId: src.id, url: src.url, message: error?.message ?? String(error) })
      }
    }

    // Precedence: live official registry > bundled curated snapshot > third-party custom sources,
    // so a third-party source cannot hijack official/curated plugin IDs when the official registry is offline.
    const entries = mergeEntries([officialList, bundledEntries(), ...customLists])
    const snapshot = {
      fetchedAt: now(),
      signature: sourceSignature,
      entries,
      errors,
      offline: officialList.length === 0 && customLists.length === 0,
    }
    memoryCache = snapshot
    await writeDiskCache(snapshot)
    return snapshot
  }

  function peek() {
    if (memoryCache) return memoryCache
    return {
      fetchedAt: 0,
      signature: '',
      entries: bundledEntries(),
      errors: [],
      offline: true,
    }
  }

  return { load, peek }
}
