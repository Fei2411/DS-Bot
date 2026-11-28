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

export function parseIpv6Bytes(address) {
  const bare = stripBrackets(address)
  if (!bare || isIP(bare) !== 6) return null
  const [leftRaw, rightRaw] = bare.split('::')
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : []
  const right = rightRaw !== undefined ? rightRaw.split(':').filter(Boolean) : []
  const expandPart = (list) => {
    const out = []
    for (const part of list) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number)
        if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        const word = Number.parseInt(part, 16)
        if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null
        out.push(word)
      }
    }
    return out
  }
  const head = expandPart(left)
  const tail = expandPart(right)
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (rightRaw === undefined && missing !== 0)) return null
  const words = [...head, ...Array(missing).fill(0), ...tail]
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = (words[i] >> 8) & 0xff
    bytes[i * 2 + 1] = words[i] & 0xff
  }
  return bytes
}

export function canonicalizeHost(hostname) {
  const bare = stripBrackets(hostname)
  if (!bare) return ''
  try {
    const parsed = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}`)
    return stripBrackets(parsed.hostname)
  } catch {
    return bare
  }
}

export function isLoopbackHost(hostname) {
  const bare = canonicalizeHost(hostname)
  if (!bare) return false
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === '0.0.0.0') return true
  if (isIP(bare) === 4) return bare.startsWith('127.') || bare === '0.0.0.0'
  const v6 = parseIpv6Bytes(bare)
  if (!v6) return false
  // :: (unspecified) and ::1 (loopback)
  let zeroPrefix = true
  for (let i = 0; i < 15; i += 1) {
    if (v6[i] !== 0) { zeroPrefix = false; break }
  }
  if (zeroPrefix && (v6[15] === 0 || v6[15] === 1)) return true
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and SIIT IPv4-translated (::ffff:0:0:0/96)
  let first8Zero = true
  for (let i = 0; i < 8; i += 1) {
    if (v6[i] !== 0) { first8Zero = false; break }
  }
  const isV4Mapped = first8Zero && v6[8] === 0 && v6[9] === 0 && v6[10] === 0xff && v6[11] === 0xff
  const isV4Compat = first8Zero && v6[8] === 0 && v6[9] === 0 && v6[10] === 0 && v6[11] === 0
  const isV4Translated = first8Zero && v6[8] === 0xff && v6[9] === 0xff && v6[10] === 0 && v6[11] === 0
  if (isV4Mapped || isV4Compat || isV4Translated) {
    const a = v6[12]
    const b = v6[13]
    const c = v6[14]
    const d = v6[15]
    if (a === 127) return true
    if (a === 0 && b === 0 && c === 0 && d === 0) return true
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

export function parseAuthority(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed || WHITESPACE_OR_CONTROL.test(trimmed)) return null
  // Require an explicit `:port` suffix before WHATWG URL parsing strips default port 80.
  const portMatch = trimmed.startsWith('[')
    ? trimmed.match(/\]:(\d+)$/u)
    : (trimmed.indexOf(':') === trimmed.lastIndexOf(':') ? trimmed.match(/:(\d+)$/u) : null)
  if (!portMatch) return null
  const explicitPort = Number(portMatch[1])
  if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) return null
  let parsed
  try {
    parsed = new URL(`http://${trimmed}`)
  } catch {
    return null
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) return null
  const host = stripBrackets(parsed.hostname)
  const port = parsed.port ? Number(parsed.port) : explicitPort
  if (!host || port !== explicitPort) return null
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
