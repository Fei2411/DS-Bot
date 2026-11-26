// Plugin registry catalog fetching, schema validation, offline caching,
// and MCP argument/security validation for DS Bot's plugin system.
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { replaceFile } from '../files.js'
import { BUNDLED_PLUGIN_CATALOG, defaultRegistryUrl } from './registry-url.js'
import { PLUGIN_CATEGORIES } from './sdk.js'
import { normalizeExecutionWithImplied } from './tiers.js'
import { validateKillListDocument } from './kill-list.js'

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
    if (command.includes('\0') || /[\r\n]/.test(command) || packageSpec.includes('\0') || /[\r\n]/.test(packageSpec)) {
      throw new Error('Command must not contain control characters.')
    }
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

const EXECUTABLE_NEGATIVE_TTL_MS = 30_000
const EXECUTABLE_NEGATIVE_CACHE_MAX = 200
const negativeExecutableCache = new Map()
let cachedRunnerKey = null
let cachedRunner = null

function envLookup(env, name) {
  if (!env || typeof env !== 'object') return undefined
  if (Object.hasOwn(env, name)) return env[name]
  const target = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target) return env[key]
  }
  return undefined
}

function isExecutableFile(filePath, platform) {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return false
    if (platform === 'win32') return true
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function hasExecutable(bin, { env = process.env, platform = process.platform, now = Date.now, isFile } = {}) {
  if (!bin || typeof bin !== 'string') return false
  const isWin = platform === 'win32'
  const pathApi = isWin ? win32 : posix
  const pathEnv = String(isWin ? (envLookup(env, 'PATH') ?? '') : (env?.PATH ?? ''))
  const pathExtRaw = isWin ? String(envLookup(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD') : ''
  const useCache = isFile === undefined
  const cacheKey = `${platform}\0${pathEnv}\0${pathExtRaw}\0${bin}`
  if (useCache) {
    const negativeUntil = negativeExecutableCache.get(cacheKey)
    if (negativeUntil !== undefined) {
      if (now() < negativeUntil) return false
      negativeExecutableCache.delete(cacheKey)
    }
  }

  const checkFile = isFile ?? (filePath => isExecutableFile(filePath, platform))
  const pathExts = isWin
    ? pathExtRaw.split(';').map(e => e.trim()).filter(Boolean)
    : []
  const effectiveExts = isWin && pathExts.length === 0 ? ['.COM', '.EXE', '.BAT', '.CMD'] : pathExts
  const binExt = isWin ? win32.extname(bin).toLowerCase() : ''
  const hasKnownWinExt = isWin && binExt !== '' && effectiveExts.some(ext => ext.toLowerCase() === binExt)
  const exts = isWin ? (hasKnownWinExt ? [''] : effectiveExts) : ['']

  if (pathApi.isAbsolute(bin) || bin.includes('/') || (isWin && bin.includes('\\'))) {
    for (const ext of exts) {
      if (checkFile(`${bin}${ext}`)) return true
    }
  } else {
    const sep = isWin ? ';' : ':'
    for (const rawDir of pathEnv.split(sep)) {
      const dir = isWin ? rawDir.trim().replace(/^"|"$/g, '') : rawDir
      if (!dir) continue
      for (const ext of exts) {
        if (checkFile(pathApi.join(dir, `${bin}${ext}`))) return true
      }
    }
  }

  if (useCache) {
    negativeExecutableCache.delete(cacheKey)
    negativeExecutableCache.set(cacheKey, now() + EXECUTABLE_NEGATIVE_TTL_MS)
    while (negativeExecutableCache.size > EXECUTABLE_NEGATIVE_CACHE_MAX) {
      negativeExecutableCache.delete(negativeExecutableCache.keys().next().value)
    }
  }
  return false
}

export function parsePackageManagerEnv(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const command = typeof parsed.command === 'string' ? parsed.command.trim() : ''
    if (!command) return null
    const args = Array.isArray(parsed.args) ? parsed.args.map(v => String(v)) : []
    const env = {}
    if (parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) {
      for (const [k, v] of Object.entries(parsed.env)) {
        if (typeof v === 'string') env[k] = v
      }
    }
    return { command, args, env }
  } catch {
    return null
  }
}

/**
 * Resolve how to launch an npm-packaged MCP preset (e.g. `@playwright/mcp@latest`),
 * preferring `npx`, then desktop-bundled pnpm (`DS_BOT_PACKAGE_MANAGER`), then `DS_BOT_PNPM` / `pnpm` on PATH.
 */
export function resolveMcpPresetCommand(mcp, {
  probe = hasExecutable,
  pnpmPath = process.env.DS_BOT_PNPM,
  packageManager = parsePackageManagerEnv(process.env.DS_BOT_PACKAGE_MANAGER),
} = {}) {
  if (mcp.command) return { command: mcp.command, args: [...(mcp.args ?? [])] }
  const pkg = mcp.packageSpec
  if (!pkg) throw new Error('MCP plugin has neither command nor packageSpec.')
  const extra = [...(mcp.args ?? [])]
  const cacheKey = `${pnpmPath ?? ''}|${packageManager ? JSON.stringify(packageManager) : ''}`
  if (probe === hasExecutable && cachedRunner !== null && cachedRunnerKey === cacheKey) {
    return cachedRunner(pkg, extra)
  }
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  let runner
  if (probe(npxBin)) {
    runner = (spec, args) => ({ command: npxBin, args: ['-y', spec, ...args] })
  } else if (packageManager?.command && probe(packageManager.command)) {
    const pmArgs = [...(packageManager.args ?? [])]
    const pmEnv = { ...(packageManager.env ?? {}) }
    const hasPmEnv = Object.keys(pmEnv).length > 0
    runner = (spec, args) => ({
      command: packageManager.command,
      args: [...pmArgs, 'dlx', spec, ...args],
      ...(hasPmEnv ? { env: { ...pmEnv } } : {}),
    })
  } else if (pnpmPath && probe(pnpmPath)) {
    runner = (spec, args) => ({ command: pnpmPath, args: ['dlx', spec, ...args] })
  } else if (probe(pnpmBin)) {
    runner = (spec, args) => ({ command: pnpmBin, args: ['dlx', spec, ...args] })
  } else {
    throw new Error('Neither npx nor pnpm is available on PATH to run this MCP plugin.')
  }
  if (probe === hasExecutable) {
    cachedRunnerKey = cacheKey
    cachedRunner = runner
  }
  return runner(pkg, extra)
}

/**
 * Analyze an npm package spec for pinning. Exact semver (`name@1.2.3`, including
 * scoped names) is pinned: the version is executable truth and can feed the consent
 * fingerprint and kill-list version matching. Dist-tags (`@latest`, `@beta`), ranges
 * (`@^1`, `@~1.2`), bare names, and wildcard/tag forms are floating: what runs is
 * whatever the registry serves at spawn time, which no local consent can pre-bind.
 *
 * @returns {{ pinned: string | null, floating: boolean }}
 */
export function analyzePackageSpecPin(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return { pinned: null, floating: false }
  const at = text.startsWith('@') ? text.indexOf('@', 1) : text.indexOf('@')
  if (at === -1) {
    // A bare package name resolves through the default dist-tag: floating.
    return { pinned: null, floating: true }
  }
  const range = text.slice(at + 1).trim()
  // Exact pinned semver: one release version, optionally with prerelease/build.
  // npm accepts a `v` prefix on exact versions (`pkg@v1.2.3`); it normalizes away
  // for semver comparisons and kill-list version matching.
  const exact = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(range)
  if (exact) {
    return { pinned: exact[1], floating: false }
  }
  return { pinned: null, floating: true }
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
    // Execution tier normalization is fail-closed: entries declaring an invalid tier
    // or an impossible tier/capability combination are dropped like any other malformed
    // entry, so a registry cannot smuggle executable powers past the boundary. DSH
    // bundles and stdio MCP servers always execute trusted host/subprocess code, which
    // no confined tier may claim; streamable HTTP entries declare no implied execution.
    const impliedExecution = kind === 'dsh' || install.mcp?.transport !== 'streamable-http'
      ? ['entry', 'process', 'worker']
      : []
    const normalizedExecution = normalizeExecutionWithImplied({ execution: raw.execution, capabilities: raw.capabilities }, impliedExecution)
    if (!normalizedExecution) continue
    plugins.push({
      id,
      name: name.slice(0, 120),
      description: String(raw.description ?? '').trim().slice(0, 600),
      author: String(raw.author ?? '').trim().slice(0, 80) || undefined,
      version: raw.version ? String(raw.version).trim().slice(0, 40) : undefined,
      category,
      slot,
      kind,
      execution: normalizedExecution.execution,
      capabilities: normalizedExecution.capabilities,
      featured: raw.featured === true,
      verified: sourceId === 'official' && raw.verified === true,
      tags: cleanStringList(raw.tags, 12),
      toolPrefixes: cleanStringList(raw.toolPrefixes, 24),
      install,
      replaces: cleanStringList(raw.replaces, 8),
      homepage: cleanSafeHttpUrl(raw.homepage),
      repository: cleanSafeHttpUrl(raw.repository),
      locales: cleanLocales(raw.locales),
      sourceId,
      sourceName,
      sourceUrl,
    })
  }
  // Optional embedded kill list. It is validated structurally here and applied by the
  // plugin runtime's kill-list store, which enforces per-source anti-rollback; an
  // invalid kill list never invalidates the registry document it rides in.
  let killList = null
  if (doc.killList != null) {
    try {
      killList = validateKillListDocument(doc.killList)
    } catch { /* a malformed kill list is inert */ }
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    plugins,
    killList,
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

// Perform an HTTPS GET whose TCP socket connects strictly to a DNS-validated public IP
// (eliminating the DNS rebinding TOCTOU window between validation and connection).
function httpsGetPinned(urlText, { dnsLookup = lookup, signal, maxBytes = MAX_REGISTRY_BYTES } = {}) {
  const parsed = new URL(urlText)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }

    const pinnedLookup = (hostname, options, cb) => {
      const bare = String(hostname ?? '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
      const ipVer = isIP(bare)
      if (ipVer) {
        if (isPrivateIpAddress(bare)) {
          cb(new Error('Plugin registry URLs cannot target private IP addresses.'))
          return
        }
        if (options?.all) cb(null, [{ address: bare, family: ipVer }])
        else cb(null, bare, ipVer)
        return
      }
      Promise.resolve(dnsLookup(bare, { all: true })).then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          cb(new Error(`Could not resolve registry host "${bare}".`))
          return
        }
        for (const rec of records) {
          if (isPrivateIpAddress(rec.address)) {
            cb(new Error(`Registry host "${bare}" resolved to a private IP address.`))
            return
          }
        }
        const validated = records.map(rec => ({
          address: rec.address,
          family: rec.family ?? (isIP(rec.address) || 4),
        }))
        if (options?.all) cb(null, validated)
        else cb(null, validated[0].address, validated[0].family)
      }, err => cb(err))
    }

    const req = httpsRequest({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      servername: parsed.hostname,
      lookup: pinnedLookup,
      headers: {
        Host: parsed.host,
        Accept: 'application/json',
        'User-Agent': 'DS-Bot-Plugin-Catalog/1',
      },
      signal,
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        const location = typeof res.headers.location === 'string' ? res.headers.location : null
        res.resume()
        finish(null, { status, location, text: '' })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        finish(new Error(`Registry responded with HTTP ${status}.`))
        return
      }
      const lengthHeader = Number(res.headers['content-length'])
      if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
        res.destroy()
        finish(new Error('Plugin registry response exceeds 1 MB limit.'))
        return
      }
      const chunks = []
      let total = 0
      res.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += bytes.byteLength
        if (total > maxBytes) {
          res.destroy()
          finish(new Error('Plugin registry response exceeds 1 MB limit.'))
          return
        }
        chunks.push(bytes)
      })
      res.on('end', () => {
        finish(null, { status, location: null, text: Buffer.concat(chunks, total).toString('utf8') })
      })
      res.on('error', err => finish(err))
    })

    req.on('error', err => finish(err))
    req.end()
  })
}

async function fetchJsonWithGuard(rawUrl, { fetchImpl = globalThis.fetch, dnsLookup = lookup, signal, allowHttp = false } = {}) {
  let currentUrl = validateRegistryUrl(rawUrl, { allowHttp })
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    // Real HTTPS traffic uses pinned-DNS `https.request` so the validated IP is the exact IP connected to.
    if (!allowHttp && fetchImpl === globalThis.fetch) {
      const res = await httpsGetPinned(currentUrl, { dnsLookup, signal: combined, maxBytes: MAX_REGISTRY_BYTES })
      if (res.status >= 300 && res.status < 400) {
        if (!res.location || hops === MAX_REDIRECTS) throw new Error('Too many redirects while fetching plugin registry.')
        currentUrl = validateRegistryUrl(new URL(res.location, currentUrl).toString(), { allowHttp })
        continue
      }
      return JSON.parse(res.text)
    }

    if (!allowHttp && dnsLookup !== lookup) {
      await assertPublicDns(currentUrl, { dnsLookup })
    }
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
  const inFlightLoads = new Map()
  const inFlightForcedLoads = new Map()

  const waitWithSignal = (promise, signal) => {
    if (signal === undefined) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => { signal.removeEventListener('abort', onAbort); resolve(value) },
        error => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
  }

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
    const existing = force
      ? inFlightForcedLoads.get(sourceSignature)
      : (inFlightForcedLoads.get(sourceSignature) ?? inFlightLoads.get(sourceSignature))
    if (existing !== undefined) {
      return await waitWithSignal(existing, signal)
    }
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }

    const bucket = force ? inFlightForcedLoads : inFlightLoads
    const task = (async () => {
      if (!force && !memoryCache) {
        const disk = await readDiskCache()
        if (disk && disk.signature === sourceSignature && now() - (disk.fetchedAt ?? 0) < CATALOG_CACHE_TTL_MS) {
          if (!memoryCache) memoryCache = disk
          return disk
        }
      }

      const errors = []
      let officialList = []
      const customLists = []
      const killLists = []
      for (const src of activeSources) {
        try {
          const json = await fetchJsonWithGuard(src.url, { fetchImpl, dnsLookup, allowHttp })
          const parsed = parsePluginRegistry(json, { sourceId: src.id, sourceName: src.name || src.id, sourceUrl: src.url })
          if (src.official) officialList = parsed.plugins
          else customLists.push(parsed.plugins)
          if (parsed.killList) killLists.push({ sourceId: src.id, killList: parsed.killList })
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
        killLists,
      }
      memoryCache = snapshot
      await writeDiskCache(snapshot)
      return snapshot
    })().finally(() => {
      if (bucket.get(sourceSignature) === task) bucket.delete(sourceSignature)
    })

    bucket.set(sourceSignature, task)
    return await waitWithSignal(task, signal)
  }

  async function hydrate() {
    if (memoryCache) return memoryCache
    const disk = await readDiskCache()
    if (disk) {
      memoryCache = disk
      return disk
    }
    return peek()
  }

  function peek() {
    if (memoryCache) return memoryCache
    return {
      fetchedAt: 0,
      signature: '',
      entries: bundledEntries(),
      errors: [],
      offline: true,
      killLists: [],
    }
  }

  return { load, peek, hydrate }
}
