// Fetch provider `auto` for dsh's web seam (`ctx.web`).
//
// Tier 1 sends a bounded HTTP(S) request with realistic browser headers, HTTP + HTML meta
// charset decoding, safe cross-origin redirects, and DNS-pinned SSRF protection (blocking
// public -> loopback/private/link-local hops and DNS rebinding). When Tier 1 hits an
// anti-bot/WAF block (403/406/429/503/52x), a JS-rendered empty SPA shell, or a direct
// transport failure (e.g. an OS system proxy not in env), Tier 2 falls back to an isolated,
// ephemeral browser fetch: the Electron main-process bridge in the desktop app
// (`DS_BOT_APP=1`), or a sandboxed local headless Chromium via `playwright-core` elsewhere.
// Never touches user or Bot cookies/profiles, and never attempts to solve or bypass CAPTCHAs.
// Independent of the Bot team code in index.js.
import { randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'web-fetch-auto'
export const inject = ['web']

export const AUTO_FETCH_PROVIDER_ID = 'auto'
export const WEB_FETCH_MAX_URL_LENGTH = 2048

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_PLAYWRIGHT_MAX_CONCURRENT = 3

export function defaultUserAgent(platform = process.platform) {
  if (platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  }
  if (platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
}

export const DEFAULT_USER_AGENT = defaultUserAgent()

export const DEFAULTS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  httpTimeoutMs: 12_000,
  maxRedirects: 10,
  browserFallback: true,
  browserTimeoutMs: 15_000,
  userAgent: DEFAULT_USER_AGENT,
})

const BLOCKED_STATUSES = new Set([403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NON_FALLBACK_ERROR_CODES = new Set([
  'WEB_ABORTED',
  'WEB_INVALID_URL',
  'WEB_BLOCKED_URL',
  'WEB_REDIRECT_BLOCKED',
  'WEB_FETCH_TOO_LARGE',
  'WEB_UNSUPPORTED_CONTENT_TYPE',
])

const CHALLENGE_MARKERS = [
  /just a moment\.{0,3}/i,
  /checking your browser/i,
  /attention required!\s*\|\s*cloudflare/i,
  /enable javascript and cookies/i,
  /please turn javascript on/i,
  /pardon our interruption/i,
  /ddos-guard/i,
  /\b_cf_chl_opt\b/i,
  /\bcf-chl-/i,
  /\bchallenge-form\b/i,
  /\bawsWaf\b/i,
  /access denied/i,
]

const SPA_MARKERS = [
  /<script[^>]+id=["']__NEXT_DATA__["']/i,
  /\b__NUXT__\b/i,
  /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']/i,
  /\bdata-reactroot\b/i,
  /<noscript[^>]*>[\s\S]{0,400}(?:javascript|js)/i,
]

// ---------------------------------------------------------------------------
// URL validation & SSRF IP / host classification

export function validateFetchUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WebError('invalid URL: URL must be a non-empty string', 'WEB_INVALID_URL')
  }
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  let url
  try {
    url = new URL(input)
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

function isPrivateIPv4Parts(a, b, c, d) {
  if (![a, b, c, d].every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return true
  return isPrivateIPv4Parts(parts[0], parts[1], parts[2], parts[3])
}

// Parse an IPv6 address (compressed, expanded, or with embedded dotted IPv4) into eight 16-bit groups.
export function parseIPv6Groups(raw) {
  let addr = raw.trim().toLowerCase()
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  const zone = addr.indexOf('%')
  if (zone !== -1) addr = addr.slice(0, zone)
  if (isIP(addr) !== 6) return undefined

  let v4Groups = []
  const lastColon = addr.lastIndexOf(':')
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr.slice(lastColon + 1).split('.').map(Number)
    if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
    v4Groups = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    addr = addr.slice(0, lastColon)
    if (addr.endsWith(':')) addr += ':'
  }

  const sides = addr.split('::')
  if (sides.length > 2) return undefined
  const parseSide = (part) => {
    if (part === '') return []
    const items = part.split(':')
    const nums = []
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return undefined
      nums.push(Number.parseInt(item, 16))
    }
    return nums
  }
  const left = parseSide(sides[0])
  const right = sides.length === 2 ? parseSide(sides[1]) : []
  if (left === undefined || right === undefined) return undefined
  const totalProvided = left.length + right.length + v4Groups.length
  if (sides.length === 1) {
    if (totalProvided !== 8) return undefined
    return [...left, ...v4Groups]
  }
  if (totalProvided > 8) return undefined
  const zeros = new Array(8 - totalProvided).fill(0)
  return [...left, ...zeros, ...right, ...v4Groups]
}

function groupsToIPv4Private(hi, lo) {
  return isPrivateIPv4Parts((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
}

export function isPrivateIP(ip) {
  if (typeof ip !== 'string' || ip.trim().length === 0) return true
  let clean = ip.trim().toLowerCase()
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1)
  const zone = clean.indexOf('%')
  if (zone !== -1) clean = clean.slice(0, zone)
  const kind = isIP(clean)
  if (kind === 4) return isPrivateIPv4(clean)
  if (kind !== 6) return true

  const g = parseIPv6Groups(clean)
  if (!g) return true
  const allZeroPrefix = (count) => g.slice(0, count).every(v => v === 0)
  // ::/128 unspecified, ::1/128 loopback
  if (allZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true
  // ::/96 deprecated IPv4-compatible (e.g. ::7f00:1)
  if (allZeroPrefix(6)) return groupsToIPv4Private(g[6], g[7])
  // ::ffff:0:0/96 IPv4-mapped (e.g. ::ffff:127.0.0.1)
  if (allZeroPrefix(5) && g[5] === 0xffff) return groupsToIPv4Private(g[6], g[7])
  // ::ffff:0:0:0/96 IPv4-translated (e.g. ::ffff:0:7f00:1)
  if (allZeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return groupsToIPv4Private(g[6], g[7])
  // 64:ff9b::/96 well-known NAT64 prefix
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return groupsToIPv4Private(g[6], g[7])
  }
  // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true
  // 100::/64 discard-only
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true
  // 2001::/32 Teredo, 2001:2::/48 benchmarking, 2001:db8::/32 documentation
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8 || (g[1] === 0x0002 && g[2] === 0))) return true
  // 2002::/16 6to4 (embedded IPv4 in g[1], g[2])
  if (g[0] === 0x2002) return groupsToIPv4Private(g[1], g[2])
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 deprecated site-local, ff00::/8 multicast
  if ((g[0] & 0xfe00) === 0xfc00) return true
  if ((g[0] & 0xffc0) === 0xfe80) return true
  if ((g[0] & 0xffc0) === 0xfec0) return true
  if ((g[0] & 0xff00) === 0xff00) return true
  return false
}

export function isFakeIpTunAddress(ip) {
  if (typeof ip !== 'string' || ip.trim().length === 0) return false
  let clean = ip.trim().toLowerCase()
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1)
  const zone = clean.indexOf('%')
  if (zone !== -1) clean = clean.slice(0, zone)
  const kind = isIP(clean)
  if (kind === 4) {
    const parts = clean.split('.').map(Number)
    return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)
  }
  if (kind === 6) {
    const g = parseIPv6Groups(clean)
    return Boolean(g && g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0)
  }
  return false
}

export function normalizeHost(hostname) {
  if (typeof hostname !== 'string') return ''
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const zone = host.indexOf('%')
  if (zone !== -1) host = host.slice(0, zone)
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function normalizeIp(ip) {
  if (typeof ip !== 'string') return ''
  let clean = ip.trim().toLowerCase()
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1)
  const zone = clean.indexOf('%')
  if (zone !== -1) clean = clean.slice(0, zone)
  if (isIP(clean) === 6) {
    const groups = parseIPv6Groups(clean)
    if (groups) return groups.map(v => v.toString(16)).join(':')
  }
  return clean
}

export function isPrivateHost(hostname) {
  const host = normalizeHost(hostname)
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host) !== 0) return isPrivateIP(host)
  return false
}

// Per-fetch SSRF origin policy shared across Tier 1 HTTP, Tier 2A Electron, and Tier 2B Playwright.
// Only syntactically private initial hosts (literal private IPs, localhost, *.local, *.internal)
// unlock arbitrary private redirects. A non-literal hostname whose DNS resolves to private IPs
// (e.g. an intranet domain like wiki.corp) may only connect to its own initial private IP set
// and never redirect to other private hosts/IPs. Fake-IP TUN ranges (198.18.0.0/15, 2001:2::/48)
// permit non-literal public redirects only within public/virtual-TUN ranges while still blocking
// all literal private hosts and all real loopback/LAN/link-local/metadata addresses.
export function createOriginPolicy(initialUrl) {
  const initialHost = normalizeHost(initialUrl.hostname)
  const initialPrivateLiteral = isPrivateHost(initialHost)
  let initialDnsPrivateIps = null
  let fakeIpTunMode = false

  return {
    initialHost,
    initialPrivateLiteral,
    classifyInitialRecords(records) {
      if (initialPrivateLiteral || !Array.isArray(records) || records.length === 0) {
        return { allowed: true }
      }
      const isRealPrivate = (address) => isPrivateIP(address) && !isFakeIpTunAddress(address)
      const hasRealPrivate = records.some(r => isRealPrivate(r.address))
      if (!hasRealPrivate) {
        if (records.some(r => isFakeIpTunAddress(r.address))) fakeIpTunMode = true
        return { allowed: true }
      }
      if (records.every(r => isRealPrivate(r.address))) {
        initialDnsPrivateIps = new Set(records.map(r => normalizeIp(r.address)))
        return { allowed: true }
      }
      return { allowed: false, reason: 'mixed' }
    },
    isTargetHostAllowed(hostname) {
      if (initialPrivateLiteral) return true
      return !isPrivateHost(hostname)
    },
    areResolvedRecordsAllowed(hostname, records) {
      if (initialPrivateLiteral) return true
      if (!Array.isArray(records) || records.length === 0) return true
      if (records.every(r => !isPrivateIP(r.address) || (fakeIpTunMode && isFakeIpTunAddress(r.address)))) return true
      if (initialDnsPrivateIps && normalizeHost(hostname) === initialHost) {
        return records.every(r => initialDnsPrivateIps.has(normalizeIp(r.address)))
      }
      return false
    },
    isConnectedIpAllowed(hostname, ip) {
      if (initialPrivateLiteral) return true
      if (typeof ip !== 'string' || ip.trim().length === 0) return true
      if (!isPrivateIP(ip)) return true
      if (fakeIpTunMode && isFakeIpTunAddress(ip)) return true
      if (initialDnsPrivateIps && normalizeHost(hostname) === initialHost) {
        return initialDnsPrivateIps.has(normalizeIp(ip))
      }
      return false
    },
  }
}

async function resolveHostAddresses(hostname, lookupImpl) {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const ipKind = isIP(host)
  if (ipKind !== 0) return [{ address: host, family: ipKind }]
  const records = await lookupImpl(host, { all: true, verbatim: true })
  return Array.isArray(records) ? records.filter(r => typeof r?.address === 'string') : []
}

async function hasOutboundProxy(url) {
  try {
    const mod = await import('@deepseek-ai/dsh-http-proxy')
    if (typeof mod?.proxyRouteFor === 'function') {
      return mod.proxyRouteFor(url).proxied === true
    }
  } catch {}
  return Boolean(
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy,
  )
}

// ---------------------------------------------------------------------------
// Content-Type & charset decoding

export function classifyContentType(contentType) {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

export function parseCharset(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

export function sniffHtmlCharset(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const direct = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(head)
  if (direct?.[1]) return direct[1].toLowerCase()
  const equiv = /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i.exec(head)
    ?? /<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)[^"']*["'][^>]*http-equiv\s*=\s*["']?content-type["']?/i.exec(head)
  return equiv?.[1]?.toLowerCase()
}

function isUtf8Label(label) {
  try {
    return new TextDecoder(label).encoding === 'utf-8'
  } catch {
    return false
  }
}

export function decoderForCharset(charset) {
  const declared = charset ?? 'utf-8'
  try {
    return new TextDecoder(declared)
  } catch (error) {
    if (declared.split(/[\s,]+/).some(isUtf8Label)) return new TextDecoder('utf-8', { fatal: true })
    throw new WebError(`unsupported charset "${declared}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}

// ---------------------------------------------------------------------------
// Visible text & fallback heuristics

export function extractVisibleText(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hasChallengeMarker(text) {
  return CHALLENGE_MARKERS.some(pattern => pattern.test(text))
}

export function shouldFallbackToBrowser(result) {
  if (!result) return { needed: false, reason: '' }
  if (BLOCKED_STATUSES.has(result.statusCode)) {
    return { needed: true, reason: `HTTP ${result.statusCode}` }
  }
  const content = result.body?.content ?? ''
  if (result.statusCode === 202 && hasChallengeMarker(content)) {
    return { needed: true, reason: 'HTTP 202 challenge' }
  }
  if (result.body?.kind !== 'html' || result.statusCode < 200 || result.statusCode >= 300) {
    return { needed: false, reason: '' }
  }
  const visible = extractVisibleText(content)
  if (visible.length < 1500 && hasChallengeMarker(`${visible}\n${content.slice(0, 8192)}`)) {
    return { needed: true, reason: 'bot-challenge' }
  }
  if (visible.length < 160 && /<script\b/i.test(content) && SPA_MARKERS.some(pattern => pattern.test(content))) {
    return { needed: true, reason: 'spa-shell' }
  }
  return { needed: false, reason: '' }
}

export function preferBrowserResult(httpResult, browserResult, fallbackReason = '') {
  if (!browserResult) return httpResult
  if (!httpResult) return browserResult
  const httpBlocked = BLOCKED_STATUSES.has(httpResult.statusCode)
    || (httpResult.statusCode === 202 && hasChallengeMarker(httpResult.body?.content ?? ''))
  if (httpBlocked) {
    if (browserResult.statusCode >= 200 && browserResult.statusCode < 400) return browserResult
    const httpLen = extractVisibleText(httpResult.body?.content ?? '').length
    const browserLen = browserResult.body?.kind === 'html'
      ? extractVisibleText(browserResult.body.content).length
      : (browserResult.body?.content?.length ?? 0)
    return browserLen > httpLen + 80 ? browserResult : httpResult
  }
  // Tier 1 was a 2xx HTML challenge or SPA shell; adopt Tier 2 when it yielded more visible
  // text or cleared the challenge.
  const httpText = extractVisibleText(httpResult.body?.content ?? '')
  const browserText = browserResult.body?.kind === 'html'
    ? extractVisibleText(browserResult.body.content)
    : (browserResult.body?.content ?? '').trim()
  if (browserResult.statusCode >= 200 && browserResult.statusCode < 400) {
    const minGain = fallbackReason === 'spa-shell' ? 1 : 60
    if (browserText.length >= httpText.length + minGain && browserText.length > 0) return browserResult
    if (hasChallengeMarker(httpText) && !hasChallengeMarker(browserText) && browserText.length > 0) return browserResult
  }
  return httpResult
}

// ---------------------------------------------------------------------------
// Config resolution

function assertPositiveFinite(field, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-auto: ${field} must be a positive finite number`)
  }
}

function assertTimeoutMs(field, value) {
  assertPositiveFinite(field, value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-auto: ${field} must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

function assertNonNegativeInteger(field, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-auto: ${field} must be a non-negative integer`)
  }
}

export function resolveConfig(config = {}) {
  const resolved = {
    maxResponseBytes: config.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
    maxBodyChars: config.maxBodyChars ?? DEFAULTS.maxBodyChars,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    httpTimeoutMs: config.httpTimeoutMs ?? DEFAULTS.httpTimeoutMs,
    maxRedirects: config.maxRedirects ?? DEFAULTS.maxRedirects,
    browserFallback: config.browserFallback ?? DEFAULTS.browserFallback,
    browserTimeoutMs: config.browserTimeoutMs ?? DEFAULTS.browserTimeoutMs,
    userAgent: typeof config.userAgent === 'string' && config.userAgent.trim() !== '' ? config.userAgent : DEFAULTS.userAgent,
  }
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs('timeoutMs', resolved.timeoutMs)
  assertTimeoutMs('httpTimeoutMs', resolved.httpTimeoutMs)
  assertTimeoutMs('browserTimeoutMs', resolved.browserTimeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  if (typeof resolved.browserFallback !== 'boolean') {
    throw new Error('web-fetch-auto: browserFallback must be a boolean')
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Timeout & signal helpers

function createDeadline(outerSignal, timeoutMs, reasonTag) {
  const controller = new AbortController()
  const timeoutError = Object.assign(new Error('web fetch timed out'), { [reasonTag]: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutError)
  }, timeoutMs)
  const onOuterAbort = () => controller.abort(outerSignal.reason)
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer)
      controller.abort(outerSignal.reason)
    } else {
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    }
  }
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      outerSignal?.removeEventListener('abort', onOuterAbort)
    },
  }
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {})
    return Promise.reject(signal.reason ?? new Error('aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function translateTransportError(error, deadline, outerSignal) {
  if (error instanceof WebError) return error
  if (outerSignal?.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  if (deadline.isTimedOut()) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  if (deadline.signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${error?.message ?? String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

// ---------------------------------------------------------------------------
// Tier 1: Direct HTTP(S) transport

async function readCappedStream(response, maxResponseBytes, deadline, outerSignal) {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxResponseBytes) {
      await response.body?.cancel?.()
      throw new WebError(`response exceeds the maximum of ${maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
    }
  }
  if (!response.body) return { bytes: new Uint8Array(0), truncatedByBytes: false }
  const chunks = []
  let total = 0
  let truncatedByBytes = false
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxResponseBytes - total
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        truncatedByBytes = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    throw translateTransportError(error, deadline, outerSignal)
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncatedByBytes }
}

function buildRequestHeaders(userAgent) {
  return {
    'user-agent': userAgent,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  }
}

async function fetchWithPinnedIp(url, init, pinnedRecords) {
  const { Agent, fetch } = await import('undici')
  if (!pinnedRecords || pinnedRecords.length === 0) {
    return { response: await fetch(url, init), close: null }
  }
  const dispatcher = new Agent({
    connections: 1,
    connect: {
      lookup(_hostname, options, callback) {
        if (typeof options === 'function') {
          callback = options
          options = {}
        }
        if (options?.all) {
          callback(null, pinnedRecords.map(r => ({ address: r.address, family: r.family })))
        } else {
          const first = pinnedRecords[0]
          callback(null, first.address, first.family)
        }
      },
    },
  })
  try {
    const response = await fetch(url, { ...init, dispatcher })
    return { response, close: () => void dispatcher.close().catch(() => {}) }
  } catch (error) {
    void dispatcher.close().catch(() => {})
    throw error
  }
}

async function fetchHttp(initialUrl, options, { fetchImpl, isCustomFetch, lookupImpl, proxyCheck }, tier1TimeoutMs, outerSignal) {
  const deadline = createDeadline(outerSignal, tier1TimeoutMs, 'webFetchAutoTimeout')
  const policy = createOriginPolicy(initialUrl)
  try {
    let currentUrl = initialUrl
    let redirectsFollowed = 0
    for (;;) {
      let pinnedRecords = null
      let proxied
      try {
        proxied = await raceWithSignal(proxyCheck(currentUrl), deadline.signal)
      } catch (error) {
        throw translateTransportError(error, deadline, outerSignal)
      }
      if (!proxied && !policy.initialPrivateLiteral) {
        if (!policy.isTargetHostAllowed(currentUrl.hostname)) {
          throw new WebError(
            redirectsFollowed > 0
              ? `redirect from public host to private address (${currentUrl.hostname}) is blocked`
              : `private address (${currentUrl.hostname}) is blocked`,
            redirectsFollowed > 0 ? 'WEB_REDIRECT_BLOCKED' : 'WEB_BLOCKED_URL',
          )
        }
        let records
        try {
          records = await raceWithSignal(resolveHostAddresses(currentUrl.hostname, lookupImpl), deadline.signal)
        } catch (error) {
          throw translateTransportError(error, deadline, outerSignal)
        }
        if (redirectsFollowed === 0) {
          const classification = policy.classifyInitialRecords(records)
          if (!classification.allowed) {
            throw new WebError(
              `mixed public/private DNS resolution (${currentUrl.hostname}) is blocked`,
              'WEB_BLOCKED_URL',
            )
          }
        } else if (!policy.areResolvedRecordsAllowed(currentUrl.hostname, records)) {
          throw new WebError(
            `redirect from public host to private address (${currentUrl.hostname}) is blocked`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        pinnedRecords = records
      }

      const init = {
        method: 'GET',
        redirect: 'manual',
        headers: buildRequestHeaders(options.userAgent),
        signal: deadline.signal,
      }
      let response
      let closeDispatcher = null
      try {
        if (!isCustomFetch && pinnedRecords && pinnedRecords.length > 0) {
          const pinned = await fetchWithPinnedIp(currentUrl, init, pinnedRecords)
          response = pinned.response
          closeDispatcher = pinned.close
        } else {
          response = await fetchImpl(currentUrl, init)
        }
      } catch (error) {
        throw translateTransportError(error, deadline, outerSignal)
      }

      try {
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectsFollowed >= options.maxRedirects) {
            await response.body?.cancel?.()
            throw new WebError(`exceeded the maximum of ${options.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            await response.body?.cancel?.()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          let validatedTarget
          try {
            const resolved = new URL(location, currentUrl)
            validatedTarget = validateFetchUrl(resolved.toString())
            if (!policy.isTargetHostAllowed(validatedTarget.hostname)) {
              throw new WebError(
                `redirect from public host to private address (${validatedTarget.hostname}) is blocked`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error) {
            await response.body?.cancel?.()
            if (error instanceof WebError) throw error
            throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
          }
          await response.body?.cancel?.()
          currentUrl = validatedTarget
          redirectsFollowed += 1
          continue
        }

        const contentType = response.headers.get('content-type')
        let kind = classifyContentType(contentType)
        if (kind === undefined) {
          // WAF/CDN 403/429/503 responses sometimes omit Content-Type; allow them to surface as
          // text/html so the browser fallback can decide whether to retry.
          if (BLOCKED_STATUSES.has(response.status) && !contentType) {
            kind = 'html'
          } else {
            await response.body?.cancel?.()
            throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
          }
        }

        const headerCharset = parseCharset(contentType)
        let decoder
        if (headerCharset !== undefined) {
          try {
            decoder = decoderForCharset(headerCharset)
          } catch (error) {
            await response.body?.cancel?.()
            throw error
          }
        }

        const { bytes, truncatedByBytes } = await readCappedStream(response, options.maxResponseBytes, deadline, outerSignal)
        if (decoder === undefined) {
          const metaCharset = kind === 'html' ? sniffHtmlCharset(bytes) : undefined
          try {
            decoder = decoderForCharset(metaCharset)
          } catch {
            decoder = new TextDecoder('utf-8')
          }
        }

        let decoded
        try {
          decoded = decoder.decode(bytes, { stream: decoder.fatal && truncatedByBytes })
        } catch (error) {
          throw new WebError(
            'response body is not valid UTF-8 for the malformed charset declaration',
            'WEB_UNSUPPORTED_CONTENT_TYPE',
            { cause: error },
          )
        }

        const truncatedByChars = decoded.length > options.maxBodyChars
        const content = truncatedByChars ? decoded.slice(0, options.maxBodyChars) : decoded
        return {
          url: currentUrl.toString(),
          statusCode: response.status,
          body: kind === 'html' ? { kind: 'html', content } : { kind: 'text', content },
          truncated: truncatedByBytes || truncatedByChars,
        }
      } finally {
        closeDispatcher?.()
      }
    }
  } finally {
    deadline.dispose()
  }
}

// ---------------------------------------------------------------------------
// Tier 2A: Electron Desktop App IPC renderer (single multiplexed listener)

export function createElectronBrowserFetch({ send = process.send?.bind(process), on = process.on.bind(process), off = process.off.bind(process) } = {}) {
  if (typeof send !== 'function') return undefined
  const pending = new Map()
  let listening = false

  const onMessage = (message) => {
    if (message?.type !== 'ds-bot:web-fetch-response' || typeof message.id !== 'string') return
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.result) {
      entry.finish(entry.resolve, message.result)
    } else {
      const code = typeof message.code === 'string' ? message.code : 'WEB_PROVIDER_ERROR'
      entry.finish(entry.reject, new WebError(message.error || 'browser web fetch failed', code))
    }
  }

  const detachIfIdle = () => {
    if (listening && pending.size === 0) {
      listening = false
      off('message', onMessage)
    }
  }

  return function electronBrowserFetch({ url, timeoutMs, maxBodyChars, initialPrivate }, signal) {
    if (signal?.aborted) return Promise.reject(new WebError('web fetch aborted', 'WEB_ABORTED'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        detachIfIdle()
        fn(value)
      }
      const onAbort = () => {
        try { send({ type: 'ds-bot:web-fetch-abort', id }) } catch {}
        finish(reject, new WebError('web fetch aborted', 'WEB_ABORTED'))
      }
      const timer = setTimeout(() => {
        try { send({ type: 'ds-bot:web-fetch-abort', id }) } catch {}
        finish(reject, new WebError('browser web fetch timed out', 'WEB_FETCH_TIMEOUT'))
      }, timeoutMs + 2_000)

      if (!listening) {
        listening = true
        on('message', onMessage)
      }
      pending.set(id, { resolve, reject, finish })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        send({ type: 'ds-bot:web-fetch', id, url, timeoutMs, maxBodyChars, initialPrivate }, (error) => {
          if (error) finish(reject, new WebError(`browser web fetch IPC failed: ${error.message}`, 'WEB_PROVIDER_ERROR', { cause: error }))
        })
      } catch (error) {
        finish(reject, new WebError(`browser web fetch IPC failed: ${error?.message ?? error}`, 'WEB_PROVIDER_ERROR', { cause: error }))
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Tier 2B: Sandboxed headless Chromium via playwright-core (non-desktop fallback)

function systemBrowserCandidates(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean)
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]
    return roots.flatMap(root => rels.map(rel => `${root}\\${rel}`))
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ]
}

function createSemaphore(limit) {
  let running = 0
  const waiters = []
  return {
    async acquire(signal) {
      if (signal?.aborted) throw (signal.reason ?? new Error('aborted'))
      if (running < limit) {
        running += 1
        return
      }
      await new Promise((resolve, reject) => {
        const entry = {
          resolve: () => {
            signal?.removeEventListener('abort', entry.onAbort)
            resolve()
          },
          onAbort: () => {
            const idx = waiters.indexOf(entry)
            if (idx !== -1) waiters.splice(idx, 1)
            reject(signal.reason ?? new Error('aborted'))
          },
        }
        signal?.addEventListener('abort', entry.onAbort, { once: true })
        waiters.push(entry)
      })
    },
    release() {
      if (waiters.length > 0) {
        const next = waiters.shift()
        next.resolve()
        return
      }
      running = Math.max(0, running - 1)
    },
  }
}

export function createPlaywrightBrowserFetch({
  loadPlaywright = () => import('playwright-core'),
  lookup = dnsLookup,
  maxConcurrent = DEFAULT_PLAYWRIGHT_MAX_CONCURRENT,
  findExecutable,
} = {}) {
  const semaphore = createSemaphore(maxConcurrent)

  async function resolveRuntime() {
    let pw
    try {
      pw = await loadPlaywright()
    } catch {
      return undefined
    }
    const chromium = pw?.chromium
    if (!chromium) return undefined

    let executablePath = typeof findExecutable === 'function' ? findExecutable(chromium) : undefined
    if (!executablePath) {
      try {
        const bundled = chromium.executablePath?.()
        if (typeof bundled === 'string' && existsSync(bundled)) executablePath = bundled
      } catch {}
    }
    if (!executablePath) {
      executablePath = systemBrowserCandidates().find(existsSync)
    }
    if (!executablePath) return undefined
    return { chromium, executablePath }
  }

  async function playwrightBrowserFetch({ url, timeoutMs, maxBodyChars }, signal) {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const runtime = await resolveRuntime()
    if (!runtime) return undefined
    const { chromium, executablePath } = runtime

    const parsedInitial = validateFetchUrl(url)
    const policy = createOriginPolicy(parsedInitial)
    const deadline = createDeadline(signal, timeoutMs, 'webFetchBrowserTimeout')
    try {
      await semaphore.acquire(deadline.signal)
    } catch (error) {
      deadline.dispose()
      throw translateTransportError(error, deadline, signal)
    }

    let browser
    let cdp
    let blockedRedirectHost
    let unsupportedContentType
    const onAbort = () => { void browser?.close?.().catch(() => {}) }
    deadline.signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (!policy.initialPrivateLiteral && isIP(policy.initialHost) === 0) {
        try {
          const initialRecords = await raceWithSignal(resolveHostAddresses(policy.initialHost, lookup), deadline.signal)
          const classification = policy.classifyInitialRecords(initialRecords)
          if (!classification.allowed) {
            throw new WebError(`mixed public/private DNS resolution (${policy.initialHost}) is blocked`, 'WEB_BLOCKED_URL')
          }
        } catch (error) {
          if (error instanceof WebError || deadline.signal.aborted || signal?.aborted) throw error
          // Allow browser/OS proxy DNS to resolve when local DNS fails (e.g. ENOTFOUND).
        }
      }
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)

      try {
        browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
          executablePath,
          timeout: Math.max(1_000, timeoutMs),
          args: ['--disable-blink-features=AutomationControlled'],
        })
      } catch (error) {
        if (deadline.signal.aborted) throw translateTransportError(error, deadline, signal)
        // Host cannot run sandboxed Chromium; degrade cleanly to Tier 1 rather than running unsandboxed.
        return undefined
      }
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)

      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        acceptDownloads: false,
      })
      const page = await context.newPage()

      const validateRequestUrl = async (reqUrl, isDocument) => {
        if (reqUrl === 'about:blank') return true
        if (!isDocument && (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:'))) return true
        let parsed
        try {
          parsed = new URL(reqUrl)
        } catch {
          return false
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
        if (parsed.username.length > 0 || parsed.password.length > 0) return false
        if (!policy.initialPrivateLiteral) {
          if (!policy.isTargetHostAllowed(parsed.hostname)) {
            if (isDocument) blockedRedirectHost = parsed.hostname
            return false
          }
          try {
            const records = await raceWithSignal(resolveHostAddresses(parsed.hostname, lookup), deadline.signal)
            if (!policy.areResolvedRecordsAllowed(parsed.hostname, records)) {
              if (isDocument) blockedRedirectHost = parsed.hostname
              return false
            }
          } catch {
            if (deadline.signal.aborted) return false
            // Allow browser proxy DNS to resolve; serverAddr is still checked on response.
          }
        }
        return true
      }

      // CDP Fetch intercepts every hop including server-side 3xx redirects, which page.route misses.
      if (typeof context.newCDPSession === 'function') {
        cdp = await context.newCDPSession(page)
        cdp.on('Fetch.requestPaused', async (event) => {
          const isDocument = event.resourceType === 'Document'
          const allowed = await validateRequestUrl(String(event.request?.url ?? ''), isDocument)
          if (!allowed) {
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
            return
          }
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {})
        })
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
      } else {
        await page.route('**/*', async (route) => {
          const req = route.request()
          const allowed = await validateRequestUrl(req.url(), req.isNavigationRequest())
          return allowed ? route.continue() : route.abort()
        })
      }

      let latestStatus
      let latestContentType = ''
      page.on('response', async (res) => {
        const req = res.request()
        if (!req.isNavigationRequest() || res.frame() !== page.mainFrame()) return
        if (!policy.initialPrivateLiteral && typeof res.serverAddr === 'function') {
          const addr = await res.serverAddr().catch(() => null)
          let reqHost = ''
          try { reqHost = new URL(req.url()).hostname } catch {}
          if (addr?.ipAddress && !policy.isConnectedIpAllowed(reqHost, addr.ipAddress)) {
            blockedRedirectHost = addr.ipAddress
            void cdp?.send('Page.stopLoading').catch(() => {})
            void browser?.close?.().catch(() => {})
            return
          }
        }
        const status = res.status()
        if (REDIRECT_STATUSES.has(status)) return
        latestStatus = status
        const headers = res.headers?.() ?? {}
        const ct = headers['content-type'] ?? ''
        latestContentType = ct
        if (ct && classifyContentType(ct) === undefined && !BLOCKED_STATUSES.has(status)) {
          unsupportedContentType = ct
        }
      })

      const navTimeout = Math.max(1_000, timeoutMs - 3_000)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout })
      await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {})
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)
      if (blockedRedirectHost) {
        throw new WebError(`redirect from public host to private address (${blockedRedirectHost}) is blocked`, 'WEB_REDIRECT_BLOCKED')
      }
      if (unsupportedContentType) {
        throw new WebError(`unsupported content type "${unsupportedContentType}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
      }

      const statusCode = latestStatus ?? response?.status?.() ?? 200
      const contentType = latestContentType || response?.headers?.()?.['content-type'] || ''
      const finalUrl = page.url() || url
      const parsedFinal = validateFetchUrl(finalUrl)
      if (!policy.initialPrivateLiteral) {
        if (!policy.isTargetHostAllowed(parsedFinal.hostname)) {
          throw new WebError(`redirect from public host to private address (${parsedFinal.hostname}) is blocked`, 'WEB_REDIRECT_BLOCKED')
        }
        try {
          const finalRecords = await raceWithSignal(resolveHostAddresses(parsedFinal.hostname, lookup), deadline.signal)
          if (!policy.areResolvedRecordsAllowed(parsedFinal.hostname, finalRecords)) {
            throw new WebError(`redirect from public host to private address (${parsedFinal.hostname}) is blocked`, 'WEB_REDIRECT_BLOCKED')
          }
        } catch (error) {
          if (error instanceof WebError || deadline.signal.aborted || signal?.aborted) throw error
        }
      }
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)

      const classified = classifyContentType(contentType)
      if (contentType && classified === undefined) {
        throw new WebError(`unsupported content type "${contentType}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
      }
      const kind = classified === 'text' ? 'text' : 'html'
      const raw = kind === 'text'
        ? await page.evaluate(() => document.body?.innerText ?? '')
        : await page.evaluate(() => {
          if (!document.documentElement) return ''
          const clone = document.documentElement.cloneNode(true)
          for (const el of clone.querySelectorAll('script, style, noscript, template, svg, iframe, object, embed')) el.remove()
          return clone.outerHTML || ''
        })
      const truncated = raw.length > maxBodyChars
      const content = truncated ? raw.slice(0, maxBodyChars) : raw
      return {
        url: finalUrl,
        statusCode,
        body: { kind, content },
        truncated,
      }
    } catch (error) {
      if (blockedRedirectHost) {
        throw new WebError(`redirect from public host to private address (${blockedRedirectHost}) is blocked`, 'WEB_REDIRECT_BLOCKED', { cause: error })
      }
      if (unsupportedContentType) {
        throw new WebError(`unsupported content type "${unsupportedContentType}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
      }
      throw translateTransportError(error, deadline, signal)
    } finally {
      deadline.signal.removeEventListener('abort', onAbort)
      deadline.dispose()
      await cdp?.detach?.().catch(() => {})
      await browser?.close?.().catch(() => {})
      semaphore.release()
    }
  }

  playwrightBrowserFetch.isAvailable = async () => Boolean(await resolveRuntime())
  return playwrightBrowserFetch
}

// ---------------------------------------------------------------------------
// Provider factory

export function createAutoFetchProvider(deps = {}, config = {}) {
  const options = resolveConfig(config)
  const isCustomFetch = typeof deps.fetch === 'function'
  const fetchImpl = deps.fetch ?? (async (url, init) => {
    const { fetch } = await import('undici')
    return fetch(url, init)
  })
  const lookupImpl = deps.lookup ?? dnsLookup
  const proxyCheck = deps.hasProxy ?? (isCustomFetch ? async () => false : hasOutboundProxy)
  const browserFetch = deps.browserFetch

  return {
    id: AUTO_FETCH_PROVIDER_ID,
    description: {
      en: 'Free, reaches intranet and local addresses, follows safe redirects, and falls back to an isolated browser for WAF-protected or JavaScript-rendered pages.',
      zh: '免费，支持内网与本机地址，自动跟随安全跳转，并在遇到反爬拦截或需要 JavaScript 渲染的网页时自动回退到隔离浏览器读取。',
    },
    available: () => true,
    async fetch(request, signal) {
      if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
      const initialUrl = validateFetchUrl(request?.url)
      const startedAt = Date.now()
      const initialPrivate = isPrivateHost(initialUrl.hostname)

      let canFallback = options.browserFallback && typeof browserFetch === 'function'
      if (canFallback && typeof browserFetch.isAvailable === 'function') {
        try {
          canFallback = Boolean(await browserFetch.isAvailable())
        } catch {
          canFallback = false
        }
        if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
      }

      // When a usable browser fallback is available, cap Tier 1 (including its DNS lookups) so a
      // stalled direct connection or DNS query still leaves room inside dsh-tool-web's 30s budget
      // for Tier 2 (e.g. OS system proxy) to run.
      const tier1TimeoutMs = canFallback ? Math.min(options.timeoutMs, options.httpTimeoutMs) : options.timeoutMs

      let httpResult
      let httpError
      try {
        httpResult = await fetchHttp(
          initialUrl,
          options,
          { fetchImpl, isCustomFetch, lookupImpl, proxyCheck },
          tier1TimeoutMs,
          signal,
        )
      } catch (error) {
        if (signal?.aborted || (error instanceof WebError && NON_FALLBACK_ERROR_CODES.has(error.code))) {
          throw error
        }
        httpError = error
      }

      if (!canFallback) {
        if (httpError) throw httpError
        return httpResult
      }

      const fallback = httpError
        ? { needed: true, reason: httpError.code ?? 'transport-error' }
        : shouldFallbackToBrowser(httpResult)
      if (!fallback.needed) return httpResult

      const remainingBudget = Math.max(1_000, options.timeoutMs - (Date.now() - startedAt))
      const browserTimeoutMs = Math.min(options.browserTimeoutMs, remainingBudget)
      // When Tier 1 was blocked (403/challenge/transport error), open the original URL rather than
      // a WAF redirect-to-block URL; for an empty SPA shell, keep the redirected canonical URL.
      const targetUrl = fallback.reason === 'spa-shell' && httpResult?.url ? httpResult.url : initialUrl.toString()

      try {
        const browserResult = await browserFetch({
          url: targetUrl,
          timeoutMs: browserTimeoutMs,
          maxBodyChars: options.maxBodyChars,
          initialPrivate,
        }, signal)
        if (browserResult) {
          return preferBrowserResult(httpResult, browserResult, fallback.reason)
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof WebError && NON_FALLBACK_ERROR_CODES.has(error.code))) {
          throw error
        }
        // Preserve Tier 1's HTTP response (or original transport error) when browser fallback fails.
      }

      if (httpError) throw httpError
      return httpResult
    },
  }
}

// ---------------------------------------------------------------------------
// Host wiring

export function apply(ctx, config = {}) {
  const browserFetch = process.env.DS_BOT_APP === '1' && typeof process.send === 'function'
    ? createElectronBrowserFetch()
    : createPlaywrightBrowserFetch()
  ctx.web.registerFetchProvider(createAutoFetchProvider({ browserFetch }, config))
}
