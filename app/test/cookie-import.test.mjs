// Writing parsed cookies into a partition session: the details mapping, the per-cookie
// apply with read-back verification and flush, the pending-import store, and the
// value-free preview the page confirms.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { applyCookies, applyOrigins, CookieImports, filterCookiesBySites, friendlyCookieError, previewOf, seedOriginsInPartition, toSetDetails } from '../src/cookie-import.mjs'
import { parseCookieFile } from '../src/cookie-parse.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cookies')
const parse = (name) => parseCookieFile(readFileSync(join(fixtures, name)))

test('toSetDetails maps a normalized cookie to the Electron set call', () => {
  const domain = toSetDetails({ name: 'n', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict', expires: 1893456000 })
  assert.equal(domain.url, 'https://example.com/')
  assert.equal(domain.domain, '.example.com')
  assert.equal(domain.sameSite, 'strict')
  assert.equal(domain.expirationDate, 1893456000)

  const hostOnly = toSetDetails({ name: 'n', value: 'v', domain: 'example.com', path: '/app', secure: false, httpOnly: false })
  assert.equal(hostOnly.url, 'http://example.com/app')
  assert.equal(hostOnly.domain, undefined, 'no leading dot means host-only: no domain field')
  assert.equal(hostOnly.sameSite, 'unspecified', 'no SameSite attribute stays unspecified')
  assert.equal(hostOnly.expirationDate, undefined, 'a session cookie carries no expiry')

  assert.equal(toSetDetails({ name: 'n', value: 'v', domain: 'x.io', path: '/', sameSite: 'None' }).sameSite, 'no_restriction')
  assert.equal(toSetDetails({ name: 'n', value: 'v', domain: 'x.io', path: '/', sameSite: 'Lax' }).sameSite, 'lax')
})

/** A session.cookies stand-in: store what set accepts, refuse and drop what we are told to. */
function fakeSession({ reject = [], drop = [] } = {}) {
  const stored = new Map()
  const key = (c) => `${c.name}${String(c.domain ?? '').replace(/^\.+/, '')}${c.path ?? '/'}`
  return {
    stored,
    flushed: false,
    cookies: {
      set: async (details) => {
        if (reject.includes(details.name)) throw new Error('Invalid cookie fields')
        if (!drop.includes(details.name)) {
          const host = new URL(details.url).host
          stored.set(key({ name: details.name, domain: details.domain ?? host, path: details.path }), {
            name: details.name, domain: details.domain ?? host, path: details.path, value: details.value,
            secure: details.secure, httpOnly: details.httpOnly,
          })
        }
      },
      get: async () => [...stored.values()],
      flushStore: async function () { this.flushed = true },
    },
  }
}

test('applyCookies stores, verifies by read-back and flushes the store', async () => {
  const ses = fakeSession()
  const parsed = parse('cookie-editor.json')
  const report = await applyCookies(ses, parsed.cookies)
  assert.equal(report.stored, 8)
  assert.equal(report.dropped.length, 0)
  assert.equal(report.failed.length, 0)
  assert.equal(report.flushed, true)
  assert.equal(ses.stored.size, 8)
})

test('applyCookies reports rejects and silent drops per cookie', async () => {
  const ses = fakeSession({ reject: ['p_none'], drop: ['p_strict'] })
  const parsed = parse('cookie-editor.json')
  const report = await applyCookies(ses, parsed.cookies)
  assert.equal(report.stored, 6)
  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0].name, 'p_none')
  assert.match(report.failed[0].reason, /Invalid cookie fields/)
  assert.equal(report.dropped.length, 1)
  assert.equal(report.dropped[0].name, 'p_strict')
  // Reports never carry values.
  for (const item of [...report.failed, ...report.dropped]) assert.equal(item.value, undefined)
})

test('a pending import is value-bearing, one-shot and capped', () => {
  const imports = new CookieImports()
  const parsed = parse('cookies.txt')
  const { id, preview } = imports.store(parsed, { kind: 'file', label: 'cookies.txt' })
  assert.equal(preview.cookies, 8)
  assert.equal(preview.source.kind, 'file')
  assert.equal(preview.sites.length, 1) // all eight share 127.0.0.1
  assert.ok(preview.notes.includes('session-cookies'))
  assert.equal(imports.peek(id).cookies.length, 8)
  assert.equal(imports.take(id).cookies.length, 8)
  assert.equal(imports.take(id), null, 'taken once')
  for (let i = 0; i < 20; i += 1) imports.store(parsed, { kind: 'file', label: String(i) })
  assert.equal(imports.peek(id), null, 'older pendings were evicted past the cap')
})

test('preview groups by site and reports skipped and adjusted entries', () => {
  const parsed = parse('malformed.cookies.txt')
  const preview = previewOf(parsed, { kind: 'file', label: 'malformed.cookies.txt' })
  assert.equal(preview.cookies, 5)
  assert.equal(preview.skipped.length, 7)
  assert.ok(preview.warnings.length > 0)
  assert.ok(preview.warnings.every((w) => w.count >= 1 && w.message))
})

test('toSetDetails promotes session cookies to persistent expiry when persistSession is enabled', () => {
  const sessionCookie = { name: 'sid', value: 'v', domain: 'example.com', path: '/', secure: true, httpOnly: true }
  const plain = toSetDetails(sessionCookie)
  assert.equal(plain.expirationDate, undefined)

  const persisted = toSetDetails(sessionCookie, { persistSession: true, now: 1700000000, sessionTtlSeconds: 86400 })
  assert.equal(persisted.expirationDate, 1700086400)

  const explicit = toSetDetails({ ...sessionCookie, expires: 1893456000 }, { persistSession: true, now: 1700000000 })
  assert.equal(explicit.expirationDate, 1893456000, 'explicit expiry is never overwritten')
})

test('filterCookiesBySites and applyCookies respect selected sites and persistSession', async () => {
  const cookies = [
    { name: 'a', value: '1', domain: '.alpha.example', path: '/', secure: true },
    { name: 'b', value: '2', domain: 'beta.example', path: '/', secure: true },
  ]
  assert.deepEqual(filterCookiesBySites(cookies, ['alpha.example']).map((c) => c.name), ['a'])

  const seenDetails = []
  const ses = fakeSession()
  const origSet = ses.cookies.set
  ses.cookies.set = async (details) => { seenDetails.push(details); return origSet(details) }

  const report = await applyCookies(ses, cookies, { sites: ['alpha.example'], persistSession: true, now: 1700000000 })
  assert.equal(report.stored, 1)
  assert.equal(seenDetails.length, 1)
  assert.equal(seenDetails[0].name, 'a')
  assert.ok(seenDetails[0].expirationDate > 1700000000)
})

test('applyOrigins filters by site, seeds localStorage, and reports failures without leaking values', async () => {
  const origins = [
    { origin: 'https://app.example.com', localStorage: [{ name: 'tok', value: 'secret-val' }] },
    { origin: 'https://fail.example.com', localStorage: [{ name: 'k', value: 'secret-val-2' }] },
    { origin: 'https://skip.example.org', localStorage: [{ name: 'z', value: 'secret-val-3' }] },
  ]
  const seeded = []
  const report = await applyOrigins(origins, {
    sites: ['app.example.com', 'fail.example.com'],
    seedOrigin: async (origin, entries) => {
      if (origin.includes('fail')) throw new Error('blocked')
      seeded.push({ origin, count: entries.length })
      return entries.length
    },
  })
  assert.deepEqual(seeded, [{ origin: 'https://app.example.com', count: 1 }])
  assert.equal(report.originsStored, 1)
  assert.equal(report.entriesStored, 1)
  assert.deepEqual(report.failedOrigins, [{ origin: 'https://fail.example.com', reason: 'blocked' }])
  assert.equal(JSON.stringify(report).includes('secret-val'), false)
})

test('CookieImports stores origins and previewOf exposes value-free storage counts and notes', () => {
  const parsed = parseCookieFile(JSON.stringify({
    cookies: [{ name: 'sid', value: 'super-secret-cookie', domain: '.example.com', path: '/', secure: true }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'auth', value: 'super-secret-ls' }] }],
  }))
  const imports = new CookieImports()
  const { id, preview } = imports.store(parsed, { kind: 'chrome', label: 'Chrome — Default', id: 'chrome:Default' })
  assert.equal(preview.origins, 1)
  assert.equal(preview.localStorageEntries, 1)
  assert.ok(preview.notes.includes('local-storage-included'))
  assert.equal(JSON.stringify(preview).includes('super-secret'), false)
  const taken = imports.take(id)
  assert.equal(taken.origins.length, 1)
  assert.equal(taken.origins[0].localStorage[0].value, 'super-secret-ls')
})

test('seedOriginsInPartition fails closed without calling loadURL when debugger or Fetch.enable is unavailable', async () => {
  const origins = [{ origin: 'https://a.example', localStorage: [{ name: 'jwt', value: 'secret-a' }] }]
  let loadCalls = 0
  let destroyed = 0

  class NoDebuggerWindow {
    constructor() {
      this._destroyed = false
      this.webContents = {
        debugger: null,
        loadURL: async () => { loadCalls += 1 },
        executeJavaScript: async () => 1,
      }
    }
    isDestroyed() { return this._destroyed }
    destroy() { this._destroyed = true; destroyed += 1 }
  }

  const r1 = await seedOriginsInPartition(NoDebuggerWindow, 'persist:bot-test', origins)
  assert.equal(loadCalls, 0, 'must never call loadURL when debugger is absent')
  assert.equal(destroyed, 1)
  assert.equal(r1.originsStored, 0)
  assert.equal(r1.failedOrigins.length, 1)

  let detached = 0
  class BrokenFetchWindow {
    constructor() {
      this._destroyed = false
      const dbg = new EventEmitter()
      dbg.attach = () => {}
      dbg.detach = () => { detached += 1 }
      dbg.sendCommand = async (cmd) => {
        if (cmd === 'Fetch.enable') throw new Error('Fetch.enable failed')
      }
      this.webContents = {
        debugger: dbg,
        loadURL: async () => { loadCalls += 1 },
        executeJavaScript: async () => 1,
      }
    }
    isDestroyed() { return this._destroyed }
    destroy() { this._destroyed = true }
  }

  const r2 = await seedOriginsInPartition(BrokenFetchWindow, 'persist:bot-test', origins)
  assert.equal(loadCalls, 0, 'must never call loadURL when Fetch.enable fails')
  assert.equal(detached, 1)
  assert.equal(r2.originsStored, 0)
  assert.equal(r2.failedOrigins.length, 1)
})

test('seedOriginsInPartition stops timed-out origin, blocks cross-origin localStorage leaks, and enforces origin check in script', async () => {
  const origins = [
    { origin: 'https://a.example', localStorage: [{ name: 'jwt', value: 'secret-for-a' }] },
    { origin: 'https://b.example', localStorage: [{ name: 'tok', value: 'secret-for-b' }] },
  ]
  const storageByOrigin = {
    'https://a.example': new Map(),
    'https://b.example': new Map(),
  }
  let currentOrigin = null
  let stopCalls = 0
  let resolveSlowA = null
  const executedScripts = []
  const fetchDecisions = []

  class FakeSeedWindow {
    constructor() {
      this._destroyed = false
      const dbg = new EventEmitter()
      dbg.attach = () => {}
      dbg.detach = () => {}
      dbg.sendCommand = async (cmd, params) => {
        if (cmd === 'Fetch.fulfillRequest' || cmd === 'Fetch.failRequest') {
          fetchDecisions.push({ cmd, requestId: params.requestId })
        }
      }
      this.webContents = {
        debugger: dbg,
        stop: () => { stopCalls += 1 },
        loadURL: async (url) => {
          const parsed = new URL(url)
          if (parsed.origin === 'https://a.example') {
            // Simulate a paused request for a third-party URL being rejected, then hang past timeout.
            dbg.emit('message', {}, 'Fetch.requestPaused', { requestId: 'req-other', request: { method: 'GET', url: 'https://evil.example/__ds_bot_storage_seed__' } })
            await new Promise((resolve) => { resolveSlowA = resolve })
            return
          }
          dbg.emit('message', {}, 'Fetch.requestPaused', { requestId: 'req-b', request: { method: 'GET', url } })
          currentOrigin = parsed.origin
        },
        executeJavaScript: async (code) => {
          executedScripts.push({ origin: currentOrigin, code })
          const store = storageByOrigin[currentOrigin]
          return runInNewContext(code, {
            window: {
              location: { origin: currentOrigin },
              localStorage: {
                setItem: (k, v) => store.set(k, v),
              },
            },
          })
        },
      }
    }
    isDestroyed() { return this._destroyed }
    destroy() { this._destroyed = true }
  }

  const report = await seedOriginsInPartition(FakeSeedWindow, 'persist:bot-test', origins, { timeoutMs: 35 })
  // Now resolve origin A's hanging loadURL AFTER origin B has already completed.
  resolveSlowA?.()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(stopCalls >= 1, true, 'contents.stop() must be called when origin A times out')
  assert.equal(report.originsStored, 1)
  assert.equal(report.entriesStored, 1)
  assert.equal(report.failedOrigins.length, 1)
  assert.equal(report.failedOrigins[0].origin, 'https://a.example')
  assert.equal(storageByOrigin['https://b.example'].get('tok'), 'secret-for-b')
  assert.equal(storageByOrigin['https://b.example'].has('jwt'), false, 'origin A credentials must never leak into origin B')
  assert.equal(executedScripts.length, 1, 'origin A must never run executeJavaScript after timeout')

  // Verify the injected script itself also refuses to write if window.location.origin mismatches.
  const wrongStore = new Map()
  const mismatchResult = runInNewContext(executedScripts[0].code, {
    window: {
      location: { origin: 'https://other.example' },
      localStorage: { setItem: (k, v) => wrongStore.set(k, v) },
    },
  })
  assert.equal(mismatchResult.mismatch, true)
  assert.equal(wrongStore.size, 0)

  // Verify Fetch interceptor rejected non-active origin and fulfilled active origin.
  assert.deepEqual(fetchDecisions, [
    { cmd: 'Fetch.failRequest', requestId: 'req-other' },
    { cmd: 'Fetch.fulfillRequest', requestId: 'req-b' },
  ])
})

test('applyCookies retries http:// overwrite and insecure SameSite=None, keeps secure duplicate last, and sanitizes Chromium errors', async () => {
  const stored = new Map()
  const attempts = []
  const ses = {
    cookies: {
      set: async (details) => {
        attempts.push({ name: details.name, url: details.url, secure: details.secure, sameSite: details.sameSite })
        const existing = stored.get(details.name)
        if (existing?.secure && details.url.startsWith('http://')) {
          throw new Error('Setting cookie failed: EXCLUDE_OVERWRITE_SECURE, DO_NOT_WARN')
        }
        if (details.sameSite === 'no_restriction' && !details.secure) {
          throw new Error('Setting cookie failed: EXCLUDE_SAMESITE_NONE_INSECURE')
        }
        if (details.name === '__Host-bad') {
          throw new Error('Setting cookie failed: EXCLUDE_INVALID_PREFIX, DO_NOT_WARN')
        }
        stored.set(details.name, {
          name: details.name,
          domain: details.domain ?? new URL(details.url).host,
          path: details.path,
          value: details.value,
          secure: details.secure,
          httpOnly: details.httpOnly,
        })
      },
      get: async () => [...stored.values()],
      flushStore: async () => {},
    },
  }

  // Seed an existing Secure MUIDB (simulating prior import or HTTPS visit to bing.com).
  stored.set('MUIDB', { name: 'MUIDB', domain: 'www.bing.com', path: '/', value: 'old', secure: true, httpOnly: true })

  // Re-import: insecure MUIDB + secure MUIDB + insecure SameSite=None + genuinely invalid __Host-bad.
  const report = await applyCookies(ses, [
    { name: 'MUIDB', value: 'sec', domain: 'www.bing.com', path: '/', secure: true, httpOnly: true },
    { name: 'MUIDB', value: 'insec', domain: 'www.bing.com', path: '/', secure: false, httpOnly: true },
    { name: 'legacy_none', value: 'v', domain: 'www.bing.com', path: '/', secure: false, sameSite: 'None' },
    { name: '__Host-bad', value: 'v', domain: '.bing.com', path: '/', secure: true },
  ])

  assert.equal(report.stored, 3)
  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0].name, '__Host-bad')
  assert.equal(report.failed[0].reason, 'cookie name prefix requires HTTPS and matching host/path')
  // Secure MUIDB ran after the insecure duplicate so the stored cookie stayed Secure.
  assert.equal(stored.get('MUIDB').value, 'sec')
  assert.equal(stored.get('MUIDB').secure, true)
  // Insecure MUIDB retried over https:// after EXCLUDE_OVERWRITE_SECURE.
  assert.ok(attempts.some((a) => a.name === 'MUIDB' && a.url === 'http://www.bing.com/'))
  assert.ok(attempts.some((a) => a.name === 'MUIDB' && a.url === 'https://www.bing.com/' && a.secure === false))

  assert.equal(friendlyCookieError(new Error('Setting cookie failed')), 'rejected by the browser')
  assert.equal(friendlyCookieError(new Error('Setting cookie failed: EXCLUDE_OVERWRITE_SECURE, DO_NOT_WARN')), 'cannot overwrite an existing secure cookie')
  assert.equal(friendlyCookieError(new Error("Error invoking remote method 'x': Error: Setting cookie failed: EXCLUDE_FAILURE_TO_STORE")), 'rejected by the browser')
  assert.equal(friendlyCookieError(new Error('Invalid cookie fields')), 'Invalid cookie fields')
})
