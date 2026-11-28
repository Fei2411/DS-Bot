// Fetch provider `auto` for dsh's web seam (`ctx.web`).
//
// Tier 1 sends a bounded HTTP(S) request with realistic browser headers, safe cross-origin
// redirects (blocking public -> private/loopback SSRF hops), and HTTP + HTML meta charset
// decoding. When Tier 1 hits an anti-bot/WAF block (403/406/429/503/52x), a JS-rendered
// empty SPA shell, or a direct transport failure (e.g. an OS system proxy the Host process
// did not inherit), Tier 2 falls back to an isolated, ephemeral browser fetch: the Electron
// main-process bridge in the desktop app (`DS_BOT_APP=1`), or a local headless Chromium via
// `playwright-core` elsewhere. Never touches user or Bot cookies/profiles, and never attempts
// to solve or bypass CAPTCHAs. Independent of the Bot team code in index.js.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'web-fetch-auto'
export const inject = ['web']

export const AUTO_FETCH_PROVIDER_ID = 'auto'
export const WEB_FETCH_MAX_URL_LENGTH = 2048

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

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
  maxRedirects: 10,
  browserFallback: true,
  browserTimeoutMs: 20_000,
  userAgent: DEFAULT_USER_AGENT,
})

const BLOCKED_STATUSES = new Set([403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

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
// URL validation & SSRF host classification

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

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function parseMappedIPv4(lower) {
  if (!lower.startsWith('::ffff:')) return undefined
  const tail = lower.slice(7)
  if (isIP(tail) === 4) return tail
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!hex) return undefined
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

export function isPrivateHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return true
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const zone = host.indexOf('%')
  if (zone !== -1) host = host.slice(0, zone)
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const ipKind = isIP(host)
  if (ipKind === 4) return isPrivateIPv4(host)
  if (ipKind === 6) {
    if (host === '::' || host === '::1') return true
    const mapped = parseMappedIPv4(host)
    if (mapped !== undefined) return isPrivateIPv4(mapped)
    const first = Number.parseInt(host.split(':')[0] || '0', 16)
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
    if ((first & 0xfe00) === 0xfc00) return true
    if ((first & 0xffc0) === 0xfe80) return true
    if ((first & 0xff00) === 0xff00) return true
    return false
  }
  return false
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

export function preferBrowserResult(httpResult, browserResult) {
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
  // Tier 1 was a 2xx HTML challenge or SPA shell; adopt Tier 2 when it yielded meaningfully
  // more visible text or cleared the challenge.
  const httpText = extractVisibleText(httpResult.body?.content ?? '')
  const browserText = browserResult.body?.kind === 'html'
    ? extractVisibleText(browserResult.body.content)
    : (browserResult.body?.content ?? '').trim()
  if (browserResult.statusCode >= 200 && browserResult.statusCode < 400) {
    if (browserText.length > httpText.length + 60) return browserResult
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
    maxRedirects: config.maxRedirects ?? DEFAULTS.maxRedirects,
    browserFallback: config.browserFallback ?? DEFAULTS.browserFallback,
    browserTimeoutMs: config.browserTimeoutMs ?? DEFAULTS.browserTimeoutMs,
    userAgent: typeof config.userAgent === 'string' && config.userAgent.trim() !== '' ? config.userAgent : DEFAULTS.userAgent,
  }
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs('timeoutMs', resolved.timeoutMs)
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

function translateTransportError(error, deadline, outerSignal) {
  if (error instanceof WebError) return error
  if (deadline.isTimedOut()) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  if (outerSignal?.aborted || deadline.signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
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

async function fetchHttp(initialUrl, options, fetchImpl, outerSignal) {
  const initialPrivate = isPrivateHost(initialUrl.hostname)
  const deadline = createDeadline(outerSignal, options.timeoutMs, 'webFetchAutoTimeout')
  try {
    let currentUrl = initialUrl
    let redirectsFollowed = 0
    for (;;) {
      let response
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: buildRequestHeaders(options.userAgent),
          signal: deadline.signal,
        })
      } catch (error) {
        throw translateTransportError(error, deadline, outerSignal)
      }

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
          if (!initialPrivate && isPrivateHost(validatedTarget.hostname)) {
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
    }
  } finally {
    deadline.dispose()
  }
}

// ---------------------------------------------------------------------------
// Tier 2A: Electron Desktop App IPC renderer

export function createElectronBrowserFetch({ send = process.send?.bind(process), on = process.on.bind(process), off = process.off.bind(process) } = {}) {
  if (typeof send !== 'function') return undefined
  return function electronBrowserFetch({ url, timeoutMs, maxBodyChars, initialPrivate }, signal) {
    if (signal?.aborted) return Promise.reject(new WebError('web fetch aborted', 'WEB_ABORTED'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off('message', receive)
        signal?.removeEventListener('abort', onAbort)
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
      const receive = (message) => {
        if (message?.type !== 'ds-bot:web-fetch-response' || message.id !== id) return
        if (message.result) {
          finish(resolve, message.result)
        } else {
          const code = typeof message.code === 'string' ? message.code : 'WEB_PROVIDER_ERROR'
          finish(reject, new WebError(message.error || 'browser web fetch failed', code))
        }
      }
      on('message', receive)
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
// Tier 2B: Headless Chromium via playwright-core (non-desktop fallback)

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

export function createPlaywrightBrowserFetch({ loadPlaywright = () => import('playwright-core') } = {}) {
  return async function playwrightBrowserFetch({ url, timeoutMs, maxBodyChars, initialPrivate }, signal) {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    let pw
    try {
      pw = await loadPlaywright()
    } catch {
      return undefined
    }
    const chromium = pw?.chromium
    if (!chromium) return undefined
    let executablePath
    try {
      const bundled = chromium.executablePath?.()
      if (typeof bundled === 'string' && existsSync(bundled)) executablePath = bundled
    } catch {}
    if (!executablePath) {
      executablePath = systemBrowserCandidates().find(existsSync)
    }
    if (!executablePath) return undefined

    let browser
    const deadline = createDeadline(signal, timeoutMs, 'webFetchBrowserTimeout')
    const onAbort = () => { void browser?.close?.().catch(() => {}) }
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath,
        args: ['--disable-blink-features=AutomationControlled'],
      })
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      })
      const page = await context.newPage()
      await page.route('**/*', (route) => {
        const reqUrl = route.request().url()
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) return route.continue()
        let parsed
        try {
          parsed = new URL(reqUrl)
        } catch {
          return route.abort()
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return route.abort()
        if (!initialPrivate && isPrivateHost(parsed.hostname)) return route.abort()
        return route.continue()
      })
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, timeoutMs - 3000) })
      // Wait briefly for SPA hydration / client-side data fetches without hanging on long polls.
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {})
      if (deadline.signal.aborted) throw translateTransportError(deadline.signal.reason, deadline, signal)
      const statusCode = response?.status?.() ?? 200
      const contentType = response?.headers?.()?.['content-type'] ?? ''
      const finalUrl = page.url() || url
      if (!initialPrivate) {
        const parsedFinal = validateFetchUrl(finalUrl)
        if (isPrivateHost(parsedFinal.hostname)) {
          throw new WebError(`redirect from public host to private address (${parsedFinal.hostname}) is blocked`, 'WEB_REDIRECT_BLOCKED')
        }
      }
      const kind = classifyContentType(contentType) === 'text' ? 'text' : 'html'
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
      throw translateTransportError(error, deadline, signal)
    } finally {
      deadline.signal.removeEventListener('abort', onAbort)
      deadline.dispose()
      await browser?.close?.().catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Provider factory

export function createAutoFetchProvider(deps = {}, config = {}) {
  const options = resolveConfig(config)
  const fetchImpl = deps.fetch ?? (async (url, init) => {
    const { fetch } = await import('undici')
    return fetch(url, init)
  })
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
      const initialPrivate = isPrivateHost(initialUrl.hostname)

      let httpResult
      let httpError
      try {
        httpResult = await fetchHttp(initialUrl, options, fetchImpl, signal)
      } catch (error) {
        if (signal?.aborted || error?.code === 'WEB_ABORTED') throw error
        // Never bypass explicit URL, redirect, size, or binary-content rejections.
        if (
          error instanceof WebError
          && error.code !== 'WEB_PROVIDER_ERROR'
          && error.code !== 'WEB_FETCH_TIMEOUT'
        ) {
          throw error
        }
        httpError = error
      }

      if (!options.browserFallback || typeof browserFetch !== 'function') {
        if (httpError) throw httpError
        return httpResult
      }

      const fallback = httpError
        ? { needed: true, reason: httpError.code ?? 'transport-error' }
        : shouldFallbackToBrowser(httpResult)
      if (!fallback.needed) return httpResult

      try {
        const browserResult = await browserFetch({
          url: httpResult?.url ?? initialUrl.toString(),
          timeoutMs: options.browserTimeoutMs,
          maxBodyChars: options.maxBodyChars,
          initialPrivate,
        }, signal)
        if (browserResult) {
          return preferBrowserResult(httpResult, browserResult)
        }
      } catch (error) {
        if (signal?.aborted || error?.code === 'WEB_ABORTED') throw error
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
