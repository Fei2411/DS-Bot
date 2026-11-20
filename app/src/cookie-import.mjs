// Import cookies (and optional localStorage origins) into a Bot's browser partition.
// A file, pasted payload, or harvested browser profile is parsed first and held in memory
// under a pending id (cookie/storage values never leave the main process); the page sees a
// value-free preview, and applying writes into the partition's session and verifies what
// the store actually kept.
import { randomUUID } from 'node:crypto'
import { describeCookie, summarizeBySite } from './cookie-parse.mjs'

const PENDING_TTL_MS = 10 * 60_000
const PENDING_MAX = 16
const DEFAULT_SESSION_TTL_SECONDS = 30 * 86_400
const APPLY_CONCURRENCY = 16
const SEED_PATH = '/__ds_bot_storage_seed__'

const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }

const normalizeSite = (domain) => String(domain ?? '').replace(/^\.+/, '').toLowerCase()

/** A normalized cookie → Electron's CookiesSetDetails. */
export function toSetDetails(cookie, opts = {}) {
  const host = normalizeSite(cookie.domain)
  const details = {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    // Electron defaults to 'lax'; 'unspecified' keeps a cookie with no SameSite attribute honest.
    sameSite: cookie.sameSite ? SAME_SITE[cookie.sameSite] : 'unspecified',
  }
  // A leading dot makes it a domain cookie (also sent to subdomains); host-only cookies
  // carry no domain field and stay on the URL's host.
  if (String(cookie.domain ?? '').startsWith('.')) details.domain = cookie.domain
  if (typeof cookie.expires === 'number') {
    details.expirationDate = cookie.expires
  } else if (opts.persistSession === true) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now() / 1000
    const ttl = typeof opts.sessionTtlSeconds === 'number' && opts.sessionTtlSeconds > 0
      ? opts.sessionTtlSeconds
      : DEFAULT_SESSION_TTL_SECONDS
    details.expirationDate = Math.floor(now + ttl)
  }
  return details
}

const keyOf = (c) => `${c.name}\u0000${normalizeSite(c.domain)}\u0000${c.path ?? '/'}`

/** Keep only cookies whose site is in `sites` (or all when `sites` is omitted). */
export function filterCookiesBySites(cookies, sites) {
  if (!Array.isArray(sites)) return cookies
  const wanted = new Set(sites.map(normalizeSite).filter(Boolean))
  return cookies.filter((cookie) => wanted.has(normalizeSite(cookie.domain)))
}

/** Keep only localStorage origins whose hostname is in `sites` (or all when `sites` is omitted). */
export function filterOriginsBySites(origins, sites) {
  if (!Array.isArray(origins)) return []
  if (!Array.isArray(sites)) return origins
  const wanted = new Set(sites.map(normalizeSite).filter(Boolean))
  return origins.filter((item) => {
    try { return wanted.has(new URL(item.origin).hostname.toLowerCase()) } catch { return false }
  })
}

async function mapPool(items, concurrency, fn) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

const COOKIE_ERROR_HINTS = [
  [/EXCLUDE_OVERWRITE_SECURE/i, 'cannot overwrite an existing secure cookie'],
  [/EXCLUDE_SAMESITE_NONE_INSECURE/i, 'SameSite=None requires HTTPS'],
  [/EXCLUDE_INVALID_PREFIX/i, 'cookie name prefix requires HTTPS and matching host/path'],
  [/EXCLUDE_INVALID_DOMAIN|EXCLUDE_DOMAIN_MISMATCH|EXCLUDE_SHADOWING_DOMAIN/i, 'cookie domain does not match'],
  [/EXCLUDE_NONCOOKIEABLE_SCHEME|EXCLUDE_SECURE_ONLY/i, 'cookie requires HTTPS'],
  [/EXCLUDE_(?:NAME_VALUE_PAIR|ATTRIBUTE_VALUE)_EXCEEDS_MAX_SIZE/i, 'cookie exceeds the browser size limit'],
  [/EXCLUDE_DISALLOWED_CHARACTER/i, 'cookie contains an invalid character'],
  [/EXCLUDE_INVALID_PARTITIONED/i, 'partitioned cookie requires HTTPS'],
]

/** Turn raw Chromium/Electron cookie rejection strings into plain human-readable reasons. */
export function friendlyCookieError(error) {
  let msg = String(error?.message ?? error ?? '').trim()
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim()
  if (!msg) return 'rejected by the browser'
  for (const [pattern, label] of COOKIE_ERROR_HINTS) {
    if (pattern.test(msg)) return label
  }
  if (/^(?:Setting cookie failed|Failed to (?:set|create) cookie)\b/i.test(msg)
    || /\b(?:EXCLUDE_|DO_NOT_WARN|CookieInclusionStatus)\b/.test(msg)) {
    return 'rejected by the browser'
  }
  return msg
}

async function setCookieWithRetry(storage, cookie, opts) {
  const details = toSetDetails(cookie, opts)
  try {
    await storage.cookies.set(details)
  } catch (error) {
    // Chromium rejects overwriting an existing Secure cookie from an http:// URL
    // (EXCLUDE_OVERWRITE_SECURE) and rejects SameSite=None without Secure.
    const needsHttps = details.url.startsWith('http://')
    const needsRelaxedSameSite = details.sameSite === 'no_restriction' && !details.secure
    if (!needsHttps && !needsRelaxedSameSite) throw error
    const retry = {
      ...details,
      ...(needsHttps ? { url: details.url.replace(/^http:\/\//, 'https://') } : {}),
      ...(needsRelaxedSameSite ? { sameSite: 'unspecified' } : {}),
    }
    await storage.cookies.set(retry)
  }
}

/**
 * Write cookies into an Electron session: one `cookies.set` each so a rejected cookie cannot
 * take the batch down; then a read-back, because a settled promise does not mean the cookie
 * was stored; then flush, so a crash soon after cannot lose the import.
 * → { stored, dropped, failed, flushed } with value-free per-item detail.
 */
export async function applyCookies(storage, cookies, opts = {}) {
  const selected = filterCookiesBySites(cookies ?? [], opts.sites)
  // Group entries sharing (name, domain, path) so partitioned/non-secure duplicates run
  // sequentially before unpartitioned/secure ones rather than racing in parallel.
  const groups = new Map()
  selected.forEach((cookie, index) => {
    const key = keyOf(cookie)
    let list = groups.get(key)
    if (!list) { list = []; groups.set(key, list) }
    list.push({ cookie, index })
  })
  for (const list of groups.values()) {
    if (list.length > 1) {
      list.sort((a, b) => {
        const aPart = a.cookie.partitionKey ? 0 : 1
        const bPart = b.cookie.partitionKey ? 0 : 1
        if (aPart !== bPart) return aPart - bPart
        return (a.cookie.secure ? 1 : 0) - (b.cookie.secure ? 1 : 0)
      })
    }
  }
  const failed = []
  const failedIndices = new Set()
  await mapPool([...groups.values()], APPLY_CONCURRENCY, async (list) => {
    for (const { cookie, index } of list) {
      try {
        await setCookieWithRetry(storage, cookie, opts)
      } catch (error) {
        failedIndices.add(index)
        failed.push({ ...describeCookie(cookie), reason: friendlyCookieError(error) })
      }
    }
  })
  const kept = new Map()
  for (const stored of await storage.cookies.get({})) kept.set(keyOf(stored), stored)
  const dropped = []
  let storedCount = 0
  selected.forEach((cookie, index) => {
    if (failedIndices.has(index)) return
    if (kept.has(keyOf(cookie))) storedCount += 1
    else dropped.push({ ...describeCookie(cookie), reason: 'the browser did not store it' })
  })
  let flushed = false
  try { await storage.cookies.flushStore(); flushed = true } catch { /* the store flushes itself within 30 s */ }
  return { stored: storedCount, dropped, failed, flushed }
}

/**
 * Seed localStorage origins using a caller-supplied seeder (hidden Electron window in main,
 * or a stub in tests). Never returns or logs values.
 * → { originsStored, entriesStored, failedOrigins }
 */
export async function applyOrigins(origins, { sites, seedOrigin } = {}) {
  const selected = filterOriginsBySites(origins ?? [], sites).filter((o) => Array.isArray(o?.localStorage) && o.localStorage.length > 0)
  if (selected.length === 0 || typeof seedOrigin !== 'function') {
    return { originsStored: 0, entriesStored: 0, failedOrigins: [] }
  }
  let originsStored = 0
  let entriesStored = 0
  const failedOrigins = []
  for (const item of selected) {
    try {
      const wrote = await seedOrigin(item.origin, item.localStorage)
      if (wrote > 0) { originsStored += 1; entriesStored += wrote }
    } catch (error) {
      failedOrigins.push({ origin: item.origin, reason: error?.message ?? String(error) })
    }
  }
  return { originsStored, entriesStored, failedOrigins }
}

/**
 * Create a zero-network localStorage seeder for an Electron partition: opens one hidden
 * window, fulfills a synthetic same-origin blank document via CDP Fetch so no external
 * request leaves the machine, writes localStorage entries, and destroys the window.
 */
export async function seedOriginsInPartition(BrowserWindow, partition, origins, { sites, timeoutMs = 5_000 } = {}) {
  const selected = filterOriginsBySites(origins ?? [], sites).filter((o) => Array.isArray(o?.localStorage) && o.localStorage.length > 0)
  if (selected.length === 0 || typeof BrowserWindow !== 'function') {
    return { originsStored: 0, entriesStored: 0, failedOrigins: [] }
  }
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      partition,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      plugins: false,
      disableDialogs: true,
    },
  })
  const contents = win.webContents
  const dbg = contents?.debugger
  const blankBody = Buffer.from('<!doctype html><meta charset="utf-8"><title>seed</title>').toString('base64')
  let attached = false
  let activeTarget = null
  const failAll = (reason) => ({
    originsStored: 0,
    entriesStored: 0,
    failedOrigins: selected.map((item) => ({ origin: item.origin, reason })),
  })
  try {
    // Fail closed: never call loadURL unless CDP Fetch interception is active and verified,
    // otherwise Electron would send real network requests carrying the imported cookies.
    if (!dbg || typeof dbg.attach !== 'function' || typeof dbg.sendCommand !== 'function' || typeof dbg.on !== 'function') {
      return failAll('zero-network interception unavailable')
    }
    try {
      dbg.attach('1.3')
      attached = true
      dbg.on('detach', () => { attached = false })
      dbg.on('message', (_event, method, params) => {
        if (method !== 'Fetch.requestPaused') return
        const url = params?.request?.url ?? ''
        let isSeed = false
        try {
          isSeed = activeTarget !== null
            && params?.request?.method === 'GET'
            && new URL(url).href === activeTarget
        } catch { /* malformed */ }
        if (isSeed) {
          void dbg.sendCommand('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: blankBody,
          }).catch(() => {})
        } else {
          void dbg.sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }).catch(() => {})
        }
      })
      await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    } catch {
      return failAll('zero-network interception unavailable')
    }

    const waitUntilStopped = async () => {
      try { contents.stop?.() } catch { /* ignore */ }
      if (typeof contents.isLoading === 'function' && contents.isLoading() && typeof contents.once === 'function') {
        await new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            clearTimeout(stopTimer)
            contents.removeListener?.('did-stop-loading', finish)
            resolve()
          }
          const stopTimer = setTimeout(finish, 200)
          contents.once('did-stop-loading', finish)
        })
      }
    }

    return await applyOrigins(selected, {
      seedOrigin: async (origin, entries) => {
        if (!attached) throw new Error('storage seed aborted: debugger detached')
        let parsed
        try { parsed = new URL(origin) } catch { throw new Error('invalid origin') }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid origin protocol')
        const expectedOrigin = parsed.origin
        const target = new URL(SEED_PATH, expectedOrigin).href
        let cancelled = false
        let timer
        activeTarget = target
        const work = (async () => {
          await contents.loadURL(target)
          if (cancelled || !attached) return 0
          const payload = JSON.stringify(entries)
          const expected = JSON.stringify(expectedOrigin)
          const res = await contents.executeJavaScript(`(() => {
            if (window.location.origin !== ${expected}) return { mismatch: true, wrote: 0 };
            const items = ${payload};
            let wrote = 0;
            for (const item of items) {
              try { window.localStorage.setItem(item.name, item.value); wrote += 1; } catch {}
            }
            return { mismatch: false, wrote };
          })()`)
          if (cancelled) return 0
          if (res && typeof res === 'object') {
            if (res.mismatch) throw new Error('storage seed aborted: origin mismatch')
            return Number(res.wrote) || 0
          }
          return Number(res) || 0
        })()
        // Suppress late rejections after timeout cancellation.
        work.catch(() => {})
        try {
          return await Promise.race([
            work,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                cancelled = true
                activeTarget = null
                try { contents.stop?.() } catch { /* ignore */ }
                reject(new Error('storage seed timed out'))
              }, timeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
          activeTarget = null
          if (cancelled) await waitUntilStopped()
        }
      },
    })
  } finally {
    if (attached) { try { dbg.detach() } catch { /* already detached */ } }
    if (!win.isDestroyed()) win.destroy()
  }
}

/** What the page shows before and after an import — names, domains, paths and flags, never values. */
export function previewOf(result, source) {
  const origins = (result.origins ?? []).filter((o) => Array.isArray(o?.localStorage) && o.localStorage.length > 0)
  const localStorageEntries = origins.reduce((sum, o) => sum + o.localStorage.length, 0)
  return {
    source,
    format: result.format ?? null,
    flavor: result.flavor ?? null,
    entries: result.entries ?? 0,
    cookies: (result.cookies ?? []).length,
    origins: origins.length,
    localStorageEntries,
    sites: summarizeBySite(result),
    warnings: groupBy(result.warnings ?? []),
    skipped: (result.skipped ?? []).map((item) => ({ where: item.where, name: item.name, domain: item.domain, code: item.code, reason: item.reason })),
    notes: notesOf(result, origins),
  }
}

function notesOf(result, origins = []) {
  const notes = []
  if ((result.cookies ?? []).some((c) => c.expires === undefined)) notes.push('session-cookies')
  if (origins.length > 0) notes.push('local-storage-included')
  else if ((result.info?.localStorageOrigins ?? []).length > 0) notes.push('local-storage-left')
  return notes
}

function groupBy(items) {
  const counts = new Map()
  for (const item of items) {
    const k = `${item.code}${item.message}`
    const entry = counts.get(k)
    if (entry) entry.count += 1
    else counts.set(k, { code: item.code, message: item.message, count: 1 })
  }
  return [...counts.values()]
}

/** Parsed imports waiting for the user's confirm: value-bearing, expiring, capped, one-shot. */
export class CookieImports {
  #pending = new Map()

  store(result, source) {
    this.sweep()
    while (this.#pending.size >= PENDING_MAX) this.#pending.delete(this.#pending.keys().next().value)
    const id = randomUUID()
    this.#pending.set(id, {
      cookies: result.cookies ?? [],
      origins: result.origins ?? [],
      expiresAt: Date.now() + PENDING_TTL_MS,
    })
    return { id, preview: previewOf(result, source) }
  }

  /** The pending import, or null when it is gone or expired. Taking it leaves it for apply/drop. */
  peek(id) {
    const entry = this.#pending.get(id)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) { this.#pending.delete(id); return null }
    return entry
  }

  /** Apply consumes the pending import. */
  take(id) {
    const entry = this.peek(id)
    if (entry) this.#pending.delete(id)
    return entry
  }

  drop(id) { this.#pending.delete(id) }

  sweep() {
    const now = Date.now()
    for (const [id, entry] of this.#pending) if (entry.expiresAt < now) this.#pending.delete(id)
  }
}
