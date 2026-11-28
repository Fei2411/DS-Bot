// Persists and normalizes DS Bot desktop network proxy settings, parses OS/PAC/env
// proxy rules, and builds Electron session proxy configurations.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname } from 'node:path'

export const PROXY_MODES = Object.freeze(['system', 'custom', 'direct'])
export const DEFAULT_PROXY_PREFS = Object.freeze({ mode: 'system', url: '', bypass: '' })

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks:': 1080, 'socks4:': 1080, 'socks4a:': 1080, 'socks5:': 1080, 'socks5h:': 1080 }
const MAX_URL_LENGTH = 2048
const MAX_BYPASS_LENGTH = 4096
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/u

export function stripBrackets(host) {
  const value = String(host ?? '').trim().toLowerCase().replace(/\.$/u, '')
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

export function formatHost(host) {
  const bare = stripBrackets(host)
  return bare.includes(':') ? `[${bare}]` : bare
}

export function isLoopbackHost(hostname) {
  const bare = stripBrackets(hostname)
  if (!bare) return false
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || bare === '0.0.0.0' || bare === '::') return true
  if (bare.startsWith('127.')) return isIP(bare) === 4
  if (bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    if (mapped === '0.0.0.0' || mapped === '0:0') return true
    if (mapped.startsWith('127.') && isIP(mapped) === 4) return true
    if (/^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/iu.test(mapped)) return true
  }
  return false
}

export function redactProxyUrl(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, '$1<hidden>@')
}

/**
 * Parse and normalize a proxy URL. Accepts `http://`, `https://`, `socks5://`, `socks5h://`,
 * `socks4://`, `socks4a://`, `socks://`, or bare `host:port` (normalized to `http://host:port`).
 * @returns {{ normalized: string, protocol: string, type: 'http'|'https'|'socks4'|'socks5', host: string, port: number, username: string, password: string }}
 */
export function parseProxyUrl(raw) {
  if (typeof raw !== 'string') throw new Error('Proxy address must be a string')
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error('Proxy address is required')
  if (trimmed.length > MAX_URL_LENGTH || WHITESPACE_OR_CONTROL.test(trimmed)) {
    throw new Error('Proxy address contains invalid characters')
  }
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('Invalid proxy address')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
  }
  const host = stripBrackets(parsed.hostname)
  if (!host) throw new Error('Proxy host is required')
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Proxy address must not include a path, query, or fragment')
  }
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol]
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid proxy port')
  }
  let type = 'http'
  if (parsed.protocol === 'https:') type = 'https'
  else if (parsed.protocol === 'socks4:' || parsed.protocol === 'socks4a:') type = 'socks4'
  else if (parsed.protocol === 'socks:' || parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') type = 'socks5'
  const username = parsed.username ? decodeURIComponent(parsed.username) : ''
  const password = parsed.password ? decodeURIComponent(parsed.password) : ''
  const authPrefix = parsed.username || parsed.password
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : ''
  const normalized = `${parsed.protocol}//${authPrefix}${formatHost(host)}:${String(port)}`
  return { normalized, protocol: parsed.protocol, type, host, port, username, password }
}

/** Validate and normalize user-provided proxy preferences. */
export function validateProxyPrefs(input) {
  if (input === null || typeof input !== 'object') throw new Error('Proxy settings must be an object')
  const mode = input.mode
  if (!PROXY_MODES.includes(mode)) throw new Error('Invalid proxy mode')
  const rawBypass = input.bypass === undefined || input.bypass === null ? '' : String(input.bypass)
  if (rawBypass.length > MAX_BYPASS_LENGTH || CONTROL_CHARS.test(rawBypass)) {
    throw new Error('Invalid proxy bypass list')
  }
  const bypass = rawBypass.trim()
  const rawUrl = input.url === undefined || input.url === null ? '' : String(input.url).trim()
  let url = ''
  if (mode === 'custom') {
    url = parseProxyUrl(rawUrl).normalized
  } else if (rawUrl !== '') {
    try {
      url = parseProxyUrl(rawUrl).normalized
    } catch {
      url = ''
    }
  }
  return { mode, url, bypass }
}

/** Read proxy preferences from disk; missing or corrupt files fall back to system mode. */
export function readProxyPrefs(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return validateProxyPrefs(parsed)
  } catch {
    return { ...DEFAULT_PROXY_PREFS }
  }
}

/** Atomically persist proxy preferences next to locations.json with owner-only permissions. */
export function writeProxyPrefs(file, input) {
  const clean = validateProxyPrefs(input)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* ignore cleanup failure */ }
    throw error
  }
  return clean
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function matchesIpv4Cidr(ip, rule) {
  const slash = rule.indexOf('/')
  if (slash === -1) return false
  const base = ipv4ToInt(rule.slice(0, slash))
  const prefix = Number(rule.slice(slash + 1))
  const target = ipv4ToInt(ip)
  if (base === null || target === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (base & mask) === (target & mask)
}

function splitRuleHostPort(entry) {
  const trimmed = entry.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end !== -1) {
      const host = trimmed.slice(1, end).toLowerCase()
      const rest = trimmed.slice(end + 1)
      if (rest.startsWith(':')) {
        const port = Number(rest.slice(1))
        return { host, port: Number.isInteger(port) ? port : undefined }
      }
      return { host, port: undefined }
    }
  }
  // Bare IPv6 literal (contains more than one colon) has no port suffix.
  const firstColon = trimmed.indexOf(':')
  if (firstColon !== -1 && trimmed.indexOf(':', firstColon + 1) === -1) {
    const port = Number(trimmed.slice(firstColon + 1))
    if (Number.isInteger(port) && port > 0) {
      return { host: trimmed.slice(0, firstColon).toLowerCase(), port }
    }
  }
  return { host: trimmed.toLowerCase(), port: undefined }
}

/** Whether `hostname:port` should bypass the proxy under `bypassList`. */
export function matchesBypass(hostname, port, bypassList, { bypassLoopback = true } = {}) {
  const host = stripBrackets(hostname)
  if (!host) return true
  if (bypassLoopback && isLoopbackHost(host)) return true
  if (typeof bypassList !== 'string' || bypassList.trim() === '') return false
  const entries = bypassList.split(/[,;\s]+/u).map(item => item.trim()).filter(Boolean)
  for (const rawEntry of entries) {
    if (rawEntry === '*') return true
    if (rawEntry.toLowerCase() === '<local>') {
      if (!host.includes('.') && !host.includes(':')) return true
      continue
    }
    if (rawEntry.includes('/')) {
      if (isIP(host) === 4 && matchesIpv4Cidr(host, rawEntry)) return true
      continue
    }
    const { host: ruleHostRaw, port: rulePort } = splitRuleHostPort(rawEntry)
    if (rulePort !== undefined && Number(port) !== rulePort) continue
    let ruleHost = ruleHostRaw.replace(/\.$/u, '')
    if (!ruleHost) continue
    if (ruleHost.startsWith('*.')) ruleHost = ruleHost.slice(2)
    else if (ruleHost.startsWith('.')) ruleHost = ruleHost.slice(1)
    if (!ruleHost) continue
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true
  }
  return false
}

function parseAuthority(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  let host
  let portStr
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close === -1 || trimmed[close + 1] !== ':') return null
    host = trimmed.slice(1, close).toLowerCase()
    portStr = trimmed.slice(close + 2)
  } else {
    const colon = trimmed.lastIndexOf(':')
    if (colon <= 0) return null
    host = trimmed.slice(0, colon).toLowerCase()
    portStr = trimmed.slice(colon + 1)
  }
  const port = Number(portStr)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/**
 * Parse a Chromium PAC / `session.resolveProxy()` string such as
 * `"PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:1080; DIRECT"`.
 */
export function parsePacProxyList(pacResult) {
  if (typeof pacResult !== 'string' || pacResult.trim() === '') return [{ type: 'direct' }]
  const candidates = []
  for (const segment of pacResult.split(';')) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/u)
    const directive = parts[0].toUpperCase()
    if (directive === 'DIRECT') {
      candidates.push({ type: 'direct' })
      continue
    }
    const authority = parseAuthority(parts[1])
    if (!authority) continue
    if (directive === 'PROXY' || directive === 'HTTP') {
      candidates.push({ type: 'http', ...authority, username: '', password: '' })
    } else if (directive === 'HTTPS') {
      candidates.push({ type: 'https', ...authority, username: '', password: '' })
    } else if (directive === 'SOCKS5' || directive === 'SOCKS') {
      candidates.push({ type: 'socks5', ...authority, username: '', password: '' })
    } else if (directive === 'SOCKS4') {
      candidates.push({ type: 'socks4', ...authority, username: '', password: '' })
    }
  }
  return candidates.length > 0 ? candidates : [{ type: 'direct' }]
}

/**
 * Convert DS Bot proxy preferences into Chromium `session.setProxy()` config plus
 * optional proxy credentials for `app.on('login')`.
 */
export function toChromiumProxyConfig(prefs) {
  const clean = validateProxyPrefs(prefs)
  if (clean.mode === 'system') return { config: { mode: 'system' }, auth: null }
  if (clean.mode === 'direct') return { config: { mode: 'direct' }, auth: null }
  const parsed = parseProxyUrl(clean.url)
  const hostPort = `${formatHost(parsed.host)}:${String(parsed.port)}`
  let proxyRules
  if (parsed.type === 'http') proxyRules = `http=${hostPort};https=${hostPort}`
  else if (parsed.type === 'https') proxyRules = `https://${hostPort}`
  else if (parsed.type === 'socks4') proxyRules = `socks4://${hostPort}`
  else proxyRules = `socks5://${hostPort}`
  const bypassTokens = ['<local>', 'localhost', '127.0.0.1', '[::1]']
  for (const token of clean.bypass.split(/[,;\s]+/u).map(s => s.trim()).filter(Boolean)) {
    if (!bypassTokens.includes(token)) bypassTokens.push(token)
  }
  const auth = (parsed.username || parsed.password)
    ? { host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password }
    : null
  return {
    config: { mode: 'fixed_servers', proxyRules, proxyBypassRules: bypassTokens.join(',') },
    auth,
  }
}

function parseDotEnvFile(filePath) {
  const out = {}
  if (!filePath) return out
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return out
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function pickEnvVar(env, dotenv, lower, upper) {
  for (const source of [env, dotenv]) {
    if (!source) continue
    for (const name of [lower, upper]) {
      const value = source[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return ''
}

function safeParseEnvProxy(raw) {
  if (!raw) return null
  try {
    return parseProxyUrl(raw)
  } catch {
    return null
  }
}

/**
 * Read explicit proxy environment variables (`http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`)
 * from process env with optional fallback to `$DSH_HOME/.env`.
 */
export function readEnvProxyConfig(env = process.env, envFilePath = undefined) {
  const dotenv = parseDotEnvFile(envFilePath)
  const rawHttp = pickEnvVar(env, dotenv, 'http_proxy', 'HTTP_PROXY')
  const rawHttps = pickEnvVar(env, dotenv, 'https_proxy', 'HTTPS_PROXY')
  const rawAll = pickEnvVar(env, dotenv, 'all_proxy', 'ALL_PROXY')
  const noProxy = pickEnvVar(env, dotenv, 'no_proxy', 'NO_PROXY')
  const all = safeParseEnvProxy(rawAll)
  const http = rawHttp ? safeParseEnvProxy(rawHttp) : all
  const https = rawHttps ? safeParseEnvProxy(rawHttps) : (all ?? http)
  return { http, https, noProxy }
}
