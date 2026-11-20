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

/**
 * Write cookies into an Electron session: one `cookies.set` each so a rejected cookie cannot
 * take the batch down; then a read-back, because a settled promise does not mean the cookie
 * was stored; then flush, so a crash soon after cannot lose the import.
 * → { stored, dropped, failed, flushed } with value-free per-item detail.
 */
export async function applyCookies(storage, cookies, opts = {}) {
  const selected = filterCookiesBySites(cookies ?? [], opts.sites)
  const failed = []
  const failedKeys = new Set()
  await mapPool(selected, APPLY_CONCURRENCY, async (cookie) => {
    try {
      await storage.cookies.set(toSetDetails(cookie, opts))
    } catch (error) {
      failedKeys.add(keyOf(cookie))
      failed.push({ ...describeCookie(cookie), reason: error?.message ?? String(error) })
    }
  })
  const kept = new Map()
  for (const stored of await storage.cookies.get({})) kept.set(keyOf(stored), stored)
  const dropped = []
  let storedCount = 0
  for (const cookie of selected) {
    const key = keyOf(cookie)
    if (failedKeys.has(key)) continue
    if (kept.has(key)) storedCount += 1
    else dropped.push({ ...describeCookie(cookie), reason: 'the browser did not store it' })
  }
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
export async function seedOriginsInPartition(BrowserWindow, partition, origins, { sites } = {}) {
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
  try {
    if (dbg && typeof dbg.attach === 'function') {
      dbg.attach('1.3')
      attached = true
      dbg.on('message', (_event, method, params) => {
        if (method !== 'Fetch.requestPaused') return
        const url = params?.request?.url ?? ''
        let isSeed = false
        try { isSeed = params?.request?.method === 'GET' && new URL(url).pathname === SEED_PATH } catch { /* malformed */ }
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
    }
    return await applyOrigins(selected, {
      seedOrigin: async (origin, entries) => {
        const target = new URL(SEED_PATH, origin).href
        let timer
        try {
          return await Promise.race([
            (async () => {
              await contents.loadURL(target)
              const payload = JSON.stringify(entries)
              const count = await contents.executeJavaScript(`(() => {
                const items = ${payload};
                let wrote = 0;
                for (const item of items) {
                  try { window.localStorage.setItem(item.name, item.value); wrote += 1; } catch {}
                }
                return wrote;
              })()`)
              return Number(count) || 0
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('storage seed timed out')), 5_000) }),
          ])
        } finally {
          clearTimeout(timer)
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
